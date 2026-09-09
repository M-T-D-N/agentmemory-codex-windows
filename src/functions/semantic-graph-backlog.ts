import type { ISdk } from "iii-sdk";
import {
  statSync,
  unwatchFile,
  watch,
  watchFile,
  type FSWatcher,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
  CompressedObservation,
  MemoryProvider,
  ProviderRuntimeInfo,
  Session,
} from "../types.js";
import {
  getEnvVar,
  getGraphBatchSize,
  isGraphExtractionEnabled,
} from "../config.js";
import { logger } from "../logger.js";
import { KV } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import {
  isExcludedCodexAmbientSession,
  sanitizeCodexAmbientObservation,
} from "./observation-visibility.js";
import {
  estimateGraphExtractionInputTokens,
  toGraphExtractionObservation,
} from "../prompts/graph-extraction.js";

const DEFAULT_INTERVAL_MS = 15 * 60_000;
const DEFAULT_READY_GRACE_MS = 15_000;
const CATCHUP_INPUT_BUDGET_RATIO = 2 / 3;
const SEMANTIC_TRUNCATION_MARKER = "\n[truncated for semantic graph input budget]";
const DEFAULT_EVENT_DRAIN_BATCHES = 4;
const DEFAULT_EVENT_DRAIN_COOLDOWN_MS = 30_000;
const DEFAULT_READY_SIGNAL_POLL_MS = 5_000;
const DEFAULT_GRAPH_PROVIDER_TIMEOUT_MS = 60_000;
const GRAPH_INVOCATION_HEADROOM_MS = 30_000;
const READY_SIGNAL_FILE = "qwen-ready.json";

function graphProviderTimeoutMs(): number {
  const parsed = Number.parseInt(
    getEnvVar("AGENTMEMORY_LOCAL_QWEN_TIMEOUT_MS") ?? "",
    10,
  );
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_GRAPH_PROVIDER_TIMEOUT_MS;
}

function graphExtractInvocationTimeoutMs(): number {
  return graphProviderTimeoutMs() + GRAPH_INVOCATION_HEADROOM_MS;
}

function graphBacklogInvocationTimeoutMs(): number {
  return graphExtractInvocationTimeoutMs() + GRAPH_INVOCATION_HEADROOM_MS;
}

export function isReadySignalWatchFilename(
  filename: string | Buffer | null,
  targetName: string,
): boolean {
  if (filename === null) return true;
  const observed = filename.toString().toLowerCase();
  const target = targetName.toLowerCase();
  return observed === target
    || observed.startsWith(`${target}.tmp-`)
    || observed.startsWith(`${target}.bak-`);
}

function readySignalStamp(path: string): string | null {
  try {
    const stats = statSync(path, { throwIfNoEntry: false });
    return stats ? `${stats.mtimeMs}:${stats.size}` : null;
  } catch {
    return null;
  }
}

export function subscribeReadySignalFile(
  path: string,
  onReady: () => void,
  options: {
    pollIntervalMs?: number;
    watchDirectory?: boolean;
  } = {},
): () => void {
  let lastStamp = readySignalStamp(path);
  const notifyIfChanged = (): void => {
    const nextStamp = readySignalStamp(path);
    if (nextStamp === null || nextStamp === lastStamp) return;
    lastStamp = nextStamp;
    onReady();
  };
  let watcher: FSWatcher | undefined;
  if (options.watchDirectory !== false) {
    try {
      const targetName = basename(path).toLowerCase();
      watcher = watch(dirname(path), { persistent: false }, (_event, filename) => {
        if (isReadySignalWatchFilename(filename, targetName)) notifyIfChanged();
      });
      watcher.on("error", (error) => {
        logger.warn("Semantic graph ready-signal watch failed", {
          path,
          error: error.message,
        });
      });
    } catch (error) {
      logger.warn("Semantic graph ready-signal watch unavailable", {
        path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const pollListener = (): void => notifyIfChanged();
  watchFile(path, {
    persistent: false,
    interval: Math.max(250, options.pollIntervalMs ?? DEFAULT_READY_SIGNAL_POLL_MS),
  }, pollListener);
  return () => {
    watcher?.close();
    unwatchFile(path, pollListener);
  };
}

export interface SemanticGraphBatch {
  observations: CompressedObservation[];
  cursorMode: "forward" | "bootstrap_backfill";
  semanticHasMore: boolean;
  semanticBootstrapDone: boolean;
  estimatedInputTokens: number;
  inputTokenBudget?: number;
}

function fitSingleObservationToBudget(
  observation: CompressedObservation,
  inputTokenBudget: number,
): { observation: CompressedObservation; estimatedInputTokens: number } {
  const fullEstimate = estimateGraphExtractionInputTokens([
    toGraphExtractionObservation(observation),
  ]);
  if (fullEstimate <= inputTokenBudget) {
    return { observation, estimatedInputTokens: fullEstimate };
  }

  let compact: CompressedObservation = {
    ...observation,
    title: observation.title.slice(0, 256),
    narrative: SEMANTIC_TRUNCATION_MARKER,
    concepts: observation.concepts.slice(0, 16).map((value) => value.slice(0, 128)),
    files: observation.files.slice(0, 16).map((value) => value.slice(0, 256)),
  };
  let best = compact;
  let bestEstimate = estimateGraphExtractionInputTokens([
    toGraphExtractionObservation(best),
  ]);
  if (bestEstimate > inputTokenBudget) {
    compact = {
      ...observation,
      title: "oversized observation",
      narrative: SEMANTIC_TRUNCATION_MARKER,
      concepts: [],
      files: [],
    };
    best = compact;
    bestEstimate = estimateGraphExtractionInputTokens([
      toGraphExtractionObservation(best),
    ]);
  }
  let low = 0;
  let high = observation.narrative.length;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate: CompressedObservation = {
      ...compact,
      narrative: observation.narrative.slice(0, middle) + SEMANTIC_TRUNCATION_MARKER,
    };
    const candidateEstimate = estimateGraphExtractionInputTokens([
      toGraphExtractionObservation(candidate),
    ]);
    if (candidateEstimate <= inputTokenBudget) {
      best = candidate;
      bestEstimate = candidateEstimate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return { observation: best, estimatedInputTokens: bestEstimate };
}

function boundedBatch(
  observations: CompressedObservation[],
  start: number,
  limit: number,
  batchSize: number,
  inputTokenBudget?: number,
): {
  end: number;
  observations: CompressedObservation[];
  estimatedInputTokens: number;
} {
  const hardEnd = Math.min(limit, start + Math.max(1, batchSize));
  let end = Math.min(limit, start + 1);
  let batchObservations = observations.slice(start, end);
  let estimatedInputTokens = estimateGraphExtractionInputTokens(
    batchObservations.map(toGraphExtractionObservation),
  );
  if (!inputTokenBudget) return {
    end: hardEnd,
    observations: observations.slice(start, hardEnd),
    estimatedInputTokens: estimateGraphExtractionInputTokens(
      observations.slice(start, hardEnd).map(toGraphExtractionObservation),
    ),
  };
  if (estimatedInputTokens > inputTokenBudget) {
    const fitted = fitSingleObservationToBudget(
      batchObservations[0]!,
      inputTokenBudget,
    );
    return {
      end,
      observations: [fitted.observation],
      estimatedInputTokens: fitted.estimatedInputTokens,
    };
  }

  for (let candidateEnd = end + 1; candidateEnd <= hardEnd; candidateEnd += 1) {
    const candidateTokens = estimateGraphExtractionInputTokens(
      observations.slice(start, candidateEnd).map(toGraphExtractionObservation),
    );
    if (candidateTokens > inputTokenBudget) break;
    end = candidateEnd;
    batchObservations = observations.slice(start, end);
    estimatedInputTokens = candidateTokens;
  }
  return { end, observations: batchObservations, estimatedInputTokens };
}

export function semanticGraphCatchupLimits(provider?: MemoryProvider): {
  batchSize: number;
  inputTokenBudget?: number;
} {
  const configuredBatchSize = Math.max(1, getGraphBatchSize());
  if (provider?.name !== "local-qwen") {
    return { batchSize: configuredBatchSize };
  }

  const runtime = provider.getRuntimeInfo?.();
  if (!runtime) {
    // Scheduler-driven work probes first. Direct/manual calls stay single-item
    // until the exact loaded-model context budget is known.
    return { batchSize: 1 };
  }
  return {
    batchSize: configuredBatchSize,
    inputTokenBudget: Math.max(
      1_024,
      Math.floor(runtime.maxInputTokens * CATCHUP_INPUT_BUDGET_RATIO),
    ),
  };
}

export function orderedSessionObservations(
  sessionId: string,
  observations: CompressedObservation[],
): CompressedObservation[] {
  return observations
    .filter((observation) => observation.sessionId === sessionId)
    .map((observation) => sanitizeCodexAmbientObservation(observation))
    .filter(
      (observation): observation is CompressedObservation =>
        Boolean(observation?.title),
    )
    .sort(
      (a, b) =>
        a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id),
    );
}

function cursorStart(
  observations: CompressedObservation[],
  cursor: string | undefined,
  rawObservations: CompressedObservation[] = observations,
): number {
  if (!cursor) return 0;
  const index = observations.findIndex((observation) => observation.id === cursor);
  if (index >= 0) return index + 1;
  const rawCursor = rawObservations.find((observation) => observation.id === cursor);
  if (!rawCursor) return -1;
  const next = observations.findIndex((observation) =>
    observation.timestamp.localeCompare(rawCursor.timestamp) > 0
    || (
      observation.timestamp === rawCursor.timestamp
      && observation.id.localeCompare(rawCursor.id) > 0
    ),
  );
  return next < 0 ? observations.length : next;
}

export function selectSemanticGraphBatch(
  session: Session,
  rawObservations: CompressedObservation[],
  batchSize = Math.max(1, getGraphBatchSize()),
  inputTokenBudget?: number,
): SemanticGraphBatch | null {
  const rawOrdered = rawObservations.filter((observation) => observation.sessionId === session.id && observation.title);
  const observations = orderedSessionObservations(session.id, rawObservations);
  if (observations.length === 0) return null;

  const bootstrapTarget = Math.min(
    observations.length,
    Math.max(0, Math.floor(session.semanticGraphBootstrapSkipped ?? 0)),
  );
  if (bootstrapTarget > 0) {
    const start = cursorStart(
      observations.slice(0, bootstrapTarget),
      session.semanticGraphBackfillThroughObservationId,
      rawOrdered,
    );
    if (start < 0) return null;
    if (start < bootstrapTarget) {
      const {
        end,
        observations: batchObservations,
        estimatedInputTokens,
      } = boundedBatch(
        observations,
        start,
        bootstrapTarget,
        batchSize,
        inputTokenBudget,
      );
      const forwardStart = cursorStart(
        observations,
        session.semanticGraphThroughObservationId,
        rawOrdered,
      );
      return {
        observations: batchObservations,
        cursorMode: "bootstrap_backfill",
        semanticHasMore:
          end < bootstrapTarget || (forwardStart >= 0 && forwardStart < observations.length),
        semanticBootstrapDone: end >= bootstrapTarget,
        estimatedInputTokens,
        ...(inputTokenBudget ? { inputTokenBudget } : {}),
      };
    }
  }

  const start = cursorStart(
    observations,
    session.semanticGraphThroughObservationId,
    rawOrdered,
  );
  if (start < 0 || start >= observations.length) return null;
  const {
    end,
    observations: batchObservations,
    estimatedInputTokens,
  } = boundedBatch(
    observations,
    start,
    observations.length,
    batchSize,
    inputTokenBudget,
  );
  return {
    observations: batchObservations,
    cursorMode: "forward",
    semanticHasMore: end < observations.length,
    semanticBootstrapDone: false,
    estimatedInputTokens,
    ...(inputTokenBudget ? { inputTokenBudget } : {}),
  };
}

export function semanticGraphCursorsAtEnd(
  session: Session,
  rawObservations: CompressedObservation[],
): boolean {
  const observations = orderedSessionObservations(session.id, rawObservations);
  if (observations.length === 0) return true;
  if (
    cursorStart(observations, session.semanticGraphThroughObservationId)
    !== observations.length
  ) {
    return false;
  }
  const bootstrapTarget = Math.min(
    observations.length,
    Math.max(0, Math.floor(session.semanticGraphBootstrapSkipped ?? 0)),
  );
  return bootstrapTarget === 0
    || cursorStart(
      observations.slice(0, bootstrapTarget),
      session.semanticGraphBackfillThroughObservationId,
    ) === bootstrapTarget;
}

async function normalizeCompletedSession(
  kv: StateKV,
  sessionId: string,
): Promise<boolean> {
  return withKeyedLock(`obs:${sessionId}`, async () => {
    const session = await kv.get<Session>(KV.sessions, sessionId);
    if (!session || session.status !== "completed") return false;
    const observations = await kv.list<CompressedObservation>(
      KV.observations(sessionId),
    );
    if (!semanticGraphCursorsAtEnd(session, observations)) return false;
    const updates: Array<{ type: "set"; path: string; value: unknown }> = [
      { type: "set", path: "semanticGraphStatus", value: "complete" },
      { type: "set", path: "semanticGraphLastError", value: "" },
    ];
    if (Number(session.semanticGraphBootstrapSkipped ?? 0) > 0) {
      updates.push({
        type: "set",
        path: "semanticGraphBootstrapSkipped",
        value: 0,
      });
    }
    await kv.update(KV.sessions, sessionId, updates);
    return true;
  });
}

function attemptTime(session: Session): number {
  const value = Date.parse(session.semanticGraphLastAttemptAt ?? "");
  return Number.isFinite(value) ? value : 0;
}

function isBlockedAtCurrentOutputBudget(session: Session): boolean {
  const match = /^local_qwen_output_truncated:(\d+)$/.exec(
    session.semanticGraphLastError ?? "",
  );
  if (!match) return false;
  const failedAt = Number(match[1]);
  const configured = Number.parseInt(
    getEnvVar("AGENTMEMORY_LOCAL_QWEN_MAX_OUTPUT_TOKENS") ?? "2048",
    10,
  );
  return Number.isFinite(configured) && configured <= failedAt;
}

export function registerSemanticGraphBacklogFunction(
  sdk: ISdk,
  kv: StateKV,
  provider?: MemoryProvider,
): void {
  sdk.registerFunction("mem::graph-backlog-step", async (request: { checkOnly?: boolean } = {}) => {
    if (!isGraphExtractionEnabled()) {
      return { success: false, skipped: "graph_extraction_disabled" };
    }
    const allSessions = (await kv.list<Session>(KV.sessions))
      .filter((session) =>
        Boolean(session.id && session.project)
        && !isExcludedCodexAmbientSession(session),
      );
    const sessions = allSessions.filter((session) =>
      !isBlockedAtCurrentOutputBudget(session)
      && (
        session.semanticGraphStatus !== "complete"
        || Number(session.semanticGraphBootstrapSkipped ?? 0) > 0
      ),
    );
    const projectLastAttempts = new Map<string, number>();
    for (const session of allSessions) {
      projectLastAttempts.set(
        session.project,
        Math.max(projectLastAttempts.get(session.project) ?? 0, attemptTime(session)),
      );
    }
    const byProject = new Map<string, Session[]>();
    for (const session of sessions) {
      const group = byProject.get(session.project) ?? [];
      group.push(session);
      byProject.set(session.project, group);
    }

    const { batchSize, inputTokenBudget } = semanticGraphCatchupLimits(provider);
    const candidates: Array<{
      session: Session;
      batch: SemanticGraphBatch;
      projectLastAttempt: number;
    }> = [];
    let normalizedSessions = 0;
    for (const projectSessions of byProject.values()) {
      const projectLastAttempt = projectLastAttempts.get(
        projectSessions[0]!.project,
      ) ?? 0;
      projectSessions.sort((a, b) =>
        attemptTime(a) - attemptTime(b)
        || String(a.startedAt ?? "").localeCompare(String(b.startedAt ?? ""))
        || a.id.localeCompare(b.id),
      );
      for (const session of projectSessions) {
        const observations = await kv.list<CompressedObservation>(
          KV.observations(session.id),
        );
        // Retry malformed local output with one original observation. Success
        // clears the existing error and restores the configured batch size.
        const retrySingle = provider?.name === "local-qwen"
          && /(?:local_qwen_empty_response|missing the required XML roots|entity |relationship |duplicate entity key:|unknown entity key|source_observation_ids|outside the input batch|exceeds the bounded|local_qwen_timeout)/.test(session.semanticGraphLastError ?? "");
        const batch = selectSemanticGraphBatch(
          session,
          observations,
          retrySingle ? 1 : batchSize,
          inputTokenBudget,
        );
        if (!batch) {
          if (!request.checkOnly && await normalizeCompletedSession(kv, session.id)) {
            normalizedSessions += 1;
          }
          continue;
        }
        if (request.checkOnly === true) return { success: true, eligible: true };
        candidates.push({ session, batch, projectLastAttempt });
        break;
      }
    }
    candidates.sort((a, b) =>
      a.projectLastAttempt - b.projectLastAttempt
      || attemptTime(a.session) - attemptTime(b.session)
      || String(a.batch.observations[0]?.timestamp ?? "")
        .localeCompare(String(b.batch.observations[0]?.timestamp ?? ""))
      || a.session.project.localeCompare(b.session.project),
    );
    const candidate = candidates[0];
    if (!candidate) {
      return {
        success: true,
        skipped: "backlog_empty",
        normalizedSessions,
      };
    }

    const sessionId = candidate.session.id;
    const lifecycleKey = `mem:session-lifecycle:${sessionId}`;
    const sourceStillExists = await withKeyedLock(lifecycleKey, async () => {
      const currentSession = await kv.get<Session>(KV.sessions, sessionId);
      const currentObservations = await Promise.all(
        candidate.batch.observations.map((observation) =>
          kv.get<CompressedObservation>(
            KV.observations(sessionId),
            observation.id,
          ),
        ),
      );
      if (
        !currentSession ||
        currentSession.project !== candidate.session.project ||
        currentObservations.some((observation) => !observation)
      ) {
        return false;
      }
      await kv.update(KV.sessions, sessionId, [
        { type: "set", path: "semanticGraphStatus", value: "pending" },
      ]);
      return true;
    });
    if (!sourceStillExists) {
      return {
        success: true,
        skipped: "source_deleted",
        project: candidate.session.project,
        sessionId,
      };
    }
    const result = await sdk.trigger({
      function_id: "mem::graph-extract",
      timeoutMs: graphExtractInvocationTimeoutMs(),
      payload: {
        project: candidate.session.project,
        sessionId: candidate.session.id,
        observations: candidate.batch.observations,
        cursorMode: candidate.batch.cursorMode,
        semanticHasMore: candidate.batch.semanticHasMore,
        semanticBootstrapDone: candidate.batch.semanticBootstrapDone,
      },
    }) as {
      success?: boolean;
      error?: string;
      semanticError?: string;
    };
    if (result?.success === false) {
      const error = (result.error ?? result.semanticError ?? "semantic graph extraction failed")
        .slice(0, 1000);
      await withKeyedLock(lifecycleKey, async () => {
        const currentSession = await kv.get<Session>(KV.sessions, sessionId);
        const currentObservations = await Promise.all(
          candidate.batch.observations.map((observation) =>
            kv.get<CompressedObservation>(
              KV.observations(sessionId),
              observation.id,
            ),
          ),
        );
        if (
          !currentSession ||
          currentSession.project !== candidate.session.project ||
          currentObservations.some((observation) => !observation)
        ) {
          return;
        }
        await kv.update(KV.sessions, sessionId, [
          { type: "set", path: "semanticGraphStatus", value: "deferred" },
          {
            type: "set",
            path: "semanticGraphLastAttemptAt",
            value: new Date().toISOString(),
          },
          { type: "set", path: "semanticGraphLastError", value: error },
        ]);
      });
    }
    return {
      success: true,
      project: candidate.session.project,
      sessionId: candidate.session.id,
      cursorMode: candidate.batch.cursorMode,
      observations: candidate.batch.observations.length,
      estimatedInputTokens: candidate.batch.estimatedInputTokens,
      ...(candidate.batch.inputTokenBudget
        ? { inputTokenBudget: candidate.batch.inputTokenBudget }
        : {}),
      normalizedSessions,
      result,
    };
  });
}

export function startSemanticGraphBacklogScheduler(
  sdk: ISdk,
  provider: MemoryProvider,
  initialRuntime: ProviderRuntimeInfo | null,
  options: {
    lifecycle?: {
      start: () => Promise<{ ready: boolean; reason?: string }>;
      release: () => Promise<boolean>;
    };
    idleReleaseMs?: number;
    intervalMs?: number;
    readyGraceMs?: number;
    eventDrainBatches?: number;
    eventDrainCooldownMs?: number;
    readySignalPath?: string;
    subscribeReadySignal?: (
      path: string,
      onReady: () => void,
    ) => (() => void) | undefined;
  } = {},
): { stop: () => Promise<void>; tick: () => Promise<void>; wake: () => void } {
  const intervalMs = Math.max(1_000, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  const readyGraceMs = Math.max(0, options.readyGraceMs ?? DEFAULT_READY_GRACE_MS);
  const eventDrainBatches = Math.max(
    1,
    options.eventDrainBatches ?? DEFAULT_EVENT_DRAIN_BATCHES,
  );
  const eventDrainCooldownMs = Math.max(
    1_000,
    options.eventDrainCooldownMs ?? DEFAULT_EVENT_DRAIN_COOLDOWN_MS,
  );
  let fingerprint = initialRuntime?.fingerprint ?? null;
  let readySince = initialRuntime ? Date.now() : 0;
  const lifecycle = options.lifecycle;
  const idleReleaseMs = Math.max(1_000, options.idleReleaseMs ?? 5 * 60_000);
  let nextStartAttempt = 0;
  let idleSince: number | null = null;
  let runningDone = Promise.resolve();
  let finishRun: (() => void) | undefined;
  let running = false;
  let stopped = false;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;

  const scheduleDrain = (delayMs: number): void => {
    if (stopped || drainTimer) return;
    drainTimer = setTimeout(() => {
      drainTimer = undefined;
      void run(true);
    }, Math.max(0, delayMs));
    drainTimer.unref();
  };

  const run = async (drain: boolean): Promise<void> => {
    if (stopped) return;
    if (running) {
      if (drain) scheduleDrain(1_000);
      return;
    }
    if (!provider.probe) return;
    running = true;
    runningDone = new Promise<void>((resolve) => { finishRun = resolve; });
    try {
      let runtime: ProviderRuntimeInfo;
      try {
        runtime = await provider.probe();
      } catch (error) {
        if (!lifecycle || stopped || Date.now() < nextStartAttempt) throw error;
        const pending = await sdk.trigger({
          function_id: "mem::graph-backlog-step",
          timeoutMs: graphBacklogInvocationTimeoutMs(),
          payload: { checkOnly: true },
        }) as { eligible?: boolean };
        if (pending?.eligible !== true || stopped) return;
        nextStartAttempt = Date.now() + intervalMs;
        const start = await lifecycle.start();
        if (stopped) return;
        if (!start.ready) {
          logger.info("Semantic graph automatic start deferred", { reason: start.reason });
          return;
        }
        fingerprint = null;
        readySince = 0;
        runtime = await provider.probe();
        logger.info("Semantic graph automatic start ready");
      }
      if (stopped) return;
      if (runtime.fingerprint !== fingerprint) {
        fingerprint = runtime.fingerprint;
        readySince = Date.now();
        if (drain) scheduleDrain(readyGraceMs);
        return;
      }
      if (!readySince) readySince = Date.now();
      const graceRemaining = readyGraceMs - (Date.now() - readySince);
      if (graceRemaining > 0) {
        if (drain) scheduleDrain(graceRemaining);
        return;
      }

      const limit = drain ? eventDrainBatches : 1;
      let completed = 0;
      for (; completed < limit && !stopped; completed++) {
        const step = await sdk.trigger({
          function_id: "mem::graph-backlog-step",
          timeoutMs: graphBacklogInvocationTimeoutMs(),
          payload: {},
        }) as {
          skipped?: string;
          result?: { success?: boolean; semanticCompleted?: boolean };
        };
        if (step?.skipped === "backlog_empty") {
          if (lifecycle && !stopped) {
            idleSince ??= Date.now();
            const remaining = idleReleaseMs - (Date.now() - idleSince);
            if (remaining <= 0) {
              if (!await lifecycle.release()) scheduleDrain(eventDrainCooldownMs);
              else idleSince = null;
            } else scheduleDrain(remaining);
          }
          return;
        }
        idleSince = null;
        if (step?.result?.success === false) {
          if (drain) scheduleDrain(eventDrainCooldownMs);
          return;
        }
      }
      if (drain && completed === limit) scheduleDrain(eventDrainCooldownMs);
    } catch (error) {
      fingerprint = null;
      readySince = 0;
      logger.info("Semantic graph backlog deferred", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      running = false;
      finishRun?.();
    }
  };

  const tick = async (): Promise<void> => {
    await run(false);
  };

  const coordinationDir = getEnvVar("AGENTMEMORY_LOCAL_QWEN_COORDINATION_DIR")?.trim();
  const readySignalPath = options.readySignalPath ?? (
    coordinationDir ? join(coordinationDir, READY_SIGNAL_FILE) : undefined
  );
  const unsubscribe = readySignalPath
    ? (options.subscribeReadySignal ?? subscribeReadySignalFile)(
        readySignalPath,
        () => {
          readySince = Date.now();
          if (drainTimer) clearTimeout(drainTimer);
          drainTimer = undefined;
          scheduleDrain(0);
        },
      )
    : undefined;

  const timer = setInterval(() => scheduleDrain(0), intervalMs);
  timer.unref();
  if (initialRuntime || lifecycle) scheduleDrain(readyGraceMs);
  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      if (drainTimer) clearTimeout(drainTimer);
      drainTimer = undefined;
      unsubscribe?.();
      await runningDone;
      await lifecycle?.release();
    },
    tick,
    wake: () => {
      if (idleSince !== null && drainTimer) {
        clearTimeout(drainTimer);
        drainTimer = undefined;
      }
      scheduleDrain(0);
    },
  };
}
