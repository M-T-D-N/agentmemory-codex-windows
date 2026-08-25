import type { ISdk } from "iii-sdk";
import type {
  CompressedObservation,
  MemoryProvider,
  ProviderRuntimeInfo,
  Session,
} from "../types.js";
import { getGraphBatchSize, isGraphExtractionEnabled } from "../config.js";
import { logger } from "../logger.js";
import { KV } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { isExcludedCodexAmbientSession } from "./observation-visibility.js";

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_READY_GRACE_MS = 15_000;

export interface SemanticGraphBatch {
  observations: CompressedObservation[];
  cursorMode: "forward" | "bootstrap_backfill";
  semanticHasMore: boolean;
  semanticBootstrapDone: boolean;
}

function orderedObservations(
  observations: CompressedObservation[],
): CompressedObservation[] {
  return observations
    .filter((observation) => observation.title)
    .sort(
      (a, b) =>
        a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id),
    );
}

function cursorStart(
  observations: CompressedObservation[],
  cursor: string | undefined,
): number {
  if (!cursor) return 0;
  const index = observations.findIndex((observation) => observation.id === cursor);
  return index < 0 ? -1 : index + 1;
}

export function selectSemanticGraphBatch(
  session: Session,
  rawObservations: CompressedObservation[],
  batchSize = Math.max(1, getGraphBatchSize()),
): SemanticGraphBatch | null {
  const observations = orderedObservations(rawObservations);
  if (observations.length === 0) return null;

  const bootstrapTarget = Math.min(
    observations.length,
    Math.max(0, Math.floor(session.semanticGraphBootstrapSkipped ?? 0)),
  );
  if (bootstrapTarget > 0) {
    const start = cursorStart(
      observations.slice(0, bootstrapTarget),
      session.semanticGraphBackfillThroughObservationId,
    );
    if (start < 0) return null;
    if (start < bootstrapTarget) {
      const end = Math.min(bootstrapTarget, start + Math.max(1, batchSize));
      const forwardStart = cursorStart(
        observations,
        session.semanticGraphThroughObservationId,
      );
      return {
        observations: observations.slice(start, end),
        cursorMode: "bootstrap_backfill",
        semanticHasMore:
          end < bootstrapTarget || (forwardStart >= 0 && forwardStart < observations.length),
        semanticBootstrapDone: end >= bootstrapTarget,
      };
    }
  }

  const start = cursorStart(
    observations,
    session.semanticGraphThroughObservationId,
  );
  if (start < 0 || start >= observations.length) return null;
  const end = Math.min(observations.length, start + Math.max(1, batchSize));
  return {
    observations: observations.slice(start, end),
    cursorMode: "forward",
    semanticHasMore: end < observations.length,
    semanticBootstrapDone: false,
  };
}

function attemptTime(session: Session): number {
  const value = Date.parse(session.semanticGraphLastAttemptAt ?? "");
  return Number.isFinite(value) ? value : 0;
}

export function registerSemanticGraphBacklogFunction(
  sdk: ISdk,
  kv: StateKV,
): void {
  sdk.registerFunction("mem::graph-backlog-step", async () => {
    if (!isGraphExtractionEnabled()) {
      return { success: false, skipped: "graph_extraction_disabled" };
    }
    const allSessions = (await kv.list<Session>(KV.sessions))
      .filter((session) =>
        Boolean(session.id && session.project)
        && !isExcludedCodexAmbientSession(session),
      );
    const sessions = allSessions.filter((session) =>
      session.semanticGraphStatus !== "complete"
      || Number(session.semanticGraphBootstrapSkipped ?? 0) > 0,
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

    const candidates: Array<{
      session: Session;
      batch: SemanticGraphBatch;
      projectLastAttempt: number;
    }> = [];
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
        const batch = selectSemanticGraphBatch(session, observations);
        if (!batch) continue;
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
    if (!candidate) return { success: true, skipped: "backlog_empty" };

    await kv.update(KV.sessions, candidate.session.id, [
      { type: "set", path: "semanticGraphStatus", value: "pending" },
    ]);
    const result = await sdk.trigger({
      function_id: "mem::graph-extract",
      payload: {
        project: candidate.session.project,
        sessionId: candidate.session.id,
        observations: candidate.batch.observations,
        cursorMode: candidate.batch.cursorMode,
        semanticHasMore: candidate.batch.semanticHasMore,
        semanticBootstrapDone: candidate.batch.semanticBootstrapDone,
      },
    });
    return {
      success: true,
      project: candidate.session.project,
      sessionId: candidate.session.id,
      cursorMode: candidate.batch.cursorMode,
      observations: candidate.batch.observations.length,
      result,
    };
  });
}

export function startSemanticGraphBacklogScheduler(
  sdk: ISdk,
  provider: MemoryProvider,
  initialRuntime: ProviderRuntimeInfo | null,
  options: { intervalMs?: number; readyGraceMs?: number } = {},
): { stop: () => void; tick: () => Promise<void> } {
  const intervalMs = Math.max(1_000, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  const readyGraceMs = Math.max(0, options.readyGraceMs ?? DEFAULT_READY_GRACE_MS);
  let fingerprint = initialRuntime?.fingerprint ?? null;
  let readySince = initialRuntime ? Date.now() : 0;
  let running = false;

  const tick = async (): Promise<void> => {
    if (running || !provider.probe) return;
    running = true;
    try {
      const runtime = await provider.probe();
      if (runtime.fingerprint !== fingerprint) {
        fingerprint = runtime.fingerprint;
        readySince = Date.now();
        return;
      }
      if (!readySince) readySince = Date.now();
      if (Date.now() - readySince < readyGraceMs) return;
      await sdk.trigger({ function_id: "mem::graph-backlog-step", payload: {} });
    } catch (error) {
      fingerprint = null;
      readySince = 0;
      logger.info("Semantic graph backlog deferred", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer), tick };
}
