import type { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { fingerprintId, KV } from "../state/schema.js";
import type {
  CompressedObservation,
  RawObservation,
  Session,
} from "../types.js";
import { logger } from "../logger.js";
import { safeAudit } from "./audit.js";
import { buildSyntheticCompression } from "./compress-synthetic.js";
import { indexRecords } from "./search.js";
import { sessionLifecycleLockKey } from "./session-lifecycle.js";

const SESSION_STUB_RECOVERY_TAG = "codex-task-recovery";
const MAX_STUB_RECOVERY_SESSIONS = 100;
const MAX_STUB_RECOVERY_OBSERVATIONS = 1000;

export interface SessionStubRecoveryObservation {
  sourceItemId: string;
  timestamp: string;
  kind: "prompt_submit" | "assistant_response";
  text: string;
}

export interface SessionStubRecoveryCandidate {
  sessionId: string;
  project: string;
  cwd: string;
  startedAt: string;
  observations: SessionStubRecoveryObservation[];
}

type SessionStubRecoveryStatus =
  | "would_recover"
  | "recovered"
  | "already_recovered"
  | "missing"
  | "conflict"
  | "invalid";

interface SessionStubRecoveryItemResult {
  sessionId: string;
  status: SessionStubRecoveryStatus;
  observations: number;
  observationsWritten: number;
  reason?: string;
}

export interface SessionStubRecoveryResult {
  dryRun: boolean;
  requested: number;
  wouldRecover: number;
  recovered: number;
  alreadyRecovered: number;
  missing: number;
  conflicts: number;
  invalid: number;
  observationsPlanned: number;
  observationsWritten: number;
  items: SessionStubRecoveryItemResult[];
}

function validNonEmpty(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function validTimestamp(value: unknown): value is string {
  return validNonEmpty(value, 64) && Number.isFinite(Date.parse(value));
}

export function isExactSessionEndStub(value: unknown): value is {
  endedAt: string;
  status: "completed";
} {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  return (
    keys.length === 2 &&
    keys[0] === "endedAt" &&
    keys[1] === "status" &&
    validTimestamp(row["endedAt"]) &&
    row["status"] === "completed"
  );
}

function validateRecoveryCandidate(
  candidate: SessionStubRecoveryCandidate,
): string | null {
  if (!validNonEmpty(candidate?.sessionId, 256)) return "invalid sessionId";
  if (!validNonEmpty(candidate.project, 512) || candidate.project === "*") {
    return "invalid project";
  }
  if (!validNonEmpty(candidate.cwd, 2048)) return "invalid cwd";
  if (!validTimestamp(candidate.startedAt)) return "invalid startedAt";
  if (!Array.isArray(candidate.observations) || candidate.observations.length === 0) {
    return "observations are required";
  }

  const sourceIds = new Set<string>();
  for (const observation of candidate.observations) {
    if (!validNonEmpty(observation?.sourceItemId, 512)) return "invalid sourceItemId";
    if (sourceIds.has(observation.sourceItemId)) return "duplicate sourceItemId";
    sourceIds.add(observation.sourceItemId);
    if (!validTimestamp(observation.timestamp)) return "invalid observation timestamp";
    if (
      observation.kind !== "prompt_submit" &&
      observation.kind !== "assistant_response"
    ) {
      return "invalid observation kind";
    }
    if (!validNonEmpty(observation.text, 2_000_000)) return "invalid observation text";
  }
  return null;
}

function recoveryOriginDetail(
  observation: SessionStubRecoveryObservation,
): string {
  return `${SESSION_STUB_RECOVERY_TAG}:${observation.kind}:${observation.sourceItemId}`;
}

function buildRecoveryObservation(
  sessionId: string,
  observation: SessionStubRecoveryObservation,
): CompressedObservation {
  const id = fingerprintId(
    "obs",
    `${SESSION_STUB_RECOVERY_TAG}:${sessionId}:${observation.sourceItemId}`,
  );
  const raw: RawObservation = {
    id,
    sessionId,
    timestamp: observation.timestamp,
    hookType: observation.kind === "prompt_submit" ? "prompt_submit" : "post_tool_use",
    ...(observation.kind === "prompt_submit"
      ? { userPrompt: observation.text }
      : {
          toolName: "assistant_response",
          toolInput: { sourceItemId: observation.sourceItemId },
          toolOutput: observation.text,
        }),
    raw: {
      recoveredFrom: "codex-task",
      sourceItemId: observation.sourceItemId,
      text: observation.text,
    },
    origin: {
      channel: "import",
      detail: recoveryOriginDetail(observation),
      capturedAt: observation.timestamp,
    },
  };
  return buildSyntheticCompression(raw);
}

function sameRecoveryObservation(
  existing: CompressedObservation,
  expected: CompressedObservation,
): boolean {
  return (
    existing.id === expected.id &&
    existing.sessionId === expected.sessionId &&
    existing.timestamp === expected.timestamp &&
    existing.type === expected.type &&
    existing.title === expected.title &&
    existing.narrative === expected.narrative &&
    existing.origin?.channel === "import" &&
    existing.origin.detail === expected.origin?.detail &&
    existing.origin.capturedAt === expected.origin?.capturedAt
  );
}

function recoveredSessionMatches(
  existing: Session,
  candidate: SessionStubRecoveryCandidate,
  expected: CompressedObservation[],
  observations: CompressedObservation[],
): boolean {
  if (
    existing.id !== candidate.sessionId ||
    existing.project !== candidate.project ||
    existing.cwd !== candidate.cwd ||
    existing.startedAt !== candidate.startedAt ||
    existing.status !== "completed" ||
    existing.observationCount !== expected.length ||
    !existing.tags?.includes(SESSION_STUB_RECOVERY_TAG) ||
    observations.length !== expected.length
  ) {
    return false;
  }
  const byId = new Map(observations.map((observation) => [observation.id, observation]));
  return expected.every((observation) => {
    const current = byId.get(observation.id);
    return Boolean(current && sameRecoveryObservation(current, observation));
  });
}

async function recoverCandidate(
  kv: StateKV,
  candidate: SessionStubRecoveryCandidate,
  dryRun: boolean,
  indexed: CompressedObservation[],
): Promise<SessionStubRecoveryItemResult> {
  return withKeyedLock(sessionLifecycleLockKey(candidate.sessionId), async () => {
    const existing = await kv.get<Session>(KV.sessions, candidate.sessionId);
    if (!existing) {
      return {
        sessionId: candidate.sessionId,
        status: "missing",
        observations: candidate.observations.length,
        observationsWritten: 0,
        reason: "session row not found",
      };
    }

    const expected = candidate.observations.map((observation) =>
      buildRecoveryObservation(candidate.sessionId, observation),
    );
    const currentObservations = await kv.list<CompressedObservation>(
      KV.observations(candidate.sessionId),
    );
    if (recoveredSessionMatches(existing, candidate, expected, currentObservations)) {
      return {
        sessionId: candidate.sessionId,
        status: "already_recovered",
        observations: expected.length,
        observationsWritten: 0,
      };
    }
    if (!isExactSessionEndStub(existing)) {
      return {
        sessionId: candidate.sessionId,
        status: "conflict",
        observations: expected.length,
        observationsWritten: 0,
        reason: "session row is not the exact recoverable stub",
      };
    }
    if (Date.parse(candidate.startedAt) > Date.parse(existing.endedAt)) {
      return {
        sessionId: candidate.sessionId,
        status: "conflict",
        observations: expected.length,
        observationsWritten: 0,
        reason: "startedAt is later than the preserved endedAt",
      };
    }

    const expectedById = new Map(expected.map((observation) => [observation.id, observation]));
    for (const observation of currentObservations) {
      const expectedObservation = expectedById.get(observation.id);
      if (!expectedObservation || !sameRecoveryObservation(observation, expectedObservation)) {
        return {
          sessionId: candidate.sessionId,
          status: "conflict",
          observations: expected.length,
          observationsWritten: 0,
          reason: "existing observations do not match the recovery source",
        };
      }
    }

    const currentIds = new Set(currentObservations.map((observation) => observation.id));
    const missingObservations = expected.filter(
      (observation) => !currentIds.has(observation.id),
    );
    if (dryRun) {
      return {
        sessionId: candidate.sessionId,
        status: "would_recover",
        observations: expected.length,
        observationsWritten: 0,
      };
    }

    for (const observation of missingObservations) {
      await kv.set(KV.observations(candidate.sessionId), observation.id, observation);
      indexed.push(observation);
    }
    const firstPrompt = candidate.observations.find(
      (observation) => observation.kind === "prompt_submit",
    )?.text.replace(/\s+/g, " ").trim().slice(0, 200);
    const session: Session = {
      id: candidate.sessionId,
      project: candidate.project,
      cwd: candidate.cwd,
      startedAt: candidate.startedAt,
      endedAt: existing.endedAt,
      status: existing.status,
      observationCount: expected.length,
      tags: [SESSION_STUB_RECOVERY_TAG],
      ...(firstPrompt ? { firstPrompt } : {}),
    };
    await kv.set(KV.sessions, candidate.sessionId, session);
    return {
      sessionId: candidate.sessionId,
      status: "recovered",
      observations: expected.length,
      observationsWritten: missingObservations.length,
    };
  });
}

function invalidBatchResult(
  candidates: SessionStubRecoveryCandidate[],
  dryRun: boolean,
  totalObservations: number,
): SessionStubRecoveryResult {
  return {
    dryRun,
    requested: Array.isArray(candidates) ? candidates.length : 0,
    wouldRecover: 0,
    recovered: 0,
    alreadyRecovered: 0,
    missing: 0,
    conflicts: 0,
    invalid: Array.isArray(candidates) ? candidates.length : 1,
    observationsPlanned: totalObservations,
    observationsWritten: 0,
    items: [],
  };
}

export async function recoverCodexSessionStubs(
  kv: StateKV,
  candidates: SessionStubRecoveryCandidate[],
  dryRun = true,
): Promise<SessionStubRecoveryResult> {
  const totalObservations = Array.isArray(candidates)
    ? candidates.reduce(
        (count, candidate) =>
          count + (Array.isArray(candidate?.observations) ? candidate.observations.length : 0),
        0,
      )
    : 0;
  if (
    !Array.isArray(candidates) ||
    candidates.length === 0 ||
    candidates.length > MAX_STUB_RECOVERY_SESSIONS ||
    totalObservations > MAX_STUB_RECOVERY_OBSERVATIONS
  ) {
    return invalidBatchResult(candidates, dryRun, totalObservations);
  }

  const items: SessionStubRecoveryItemResult[] = [];
  const indexed: CompressedObservation[] = [];
  const seenSessionIds = new Set<string>();
  for (const candidate of candidates) {
    const duplicate = seenSessionIds.has(candidate?.sessionId);
    if (candidate?.sessionId) seenSessionIds.add(candidate.sessionId);
    const validationError = duplicate
      ? "duplicate sessionId"
      : validateRecoveryCandidate(candidate);
    if (validationError) {
      items.push({
        sessionId: typeof candidate?.sessionId === "string" ? candidate.sessionId : "",
        status: "invalid",
        observations: Array.isArray(candidate?.observations) ? candidate.observations.length : 0,
        observationsWritten: 0,
        reason: validationError,
      });
      continue;
    }
    items.push(await recoverCandidate(kv, candidate, dryRun, indexed));
  }

  if (!dryRun && indexed.length > 0) {
    try {
      await indexRecords(indexed, []);
    } catch (err) {
      logger.warn("Recovered observation indexing deferred until rebuild", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const count = (status: SessionStubRecoveryStatus) =>
    items.filter((item) => item.status === status).length;
  const observationsWritten = items.reduce(
    (total, item) => total + item.observationsWritten,
    0,
  );
  if (!dryRun && count("recovered") > 0) {
    await safeAudit(
      kv,
      "import",
      "mem::migrate",
      items.filter((item) => item.status === "recovered").map((item) => item.sessionId),
      {
        step: "repair-codex-session-stubs",
        sessions: count("recovered"),
        observations: observationsWritten,
      },
    );
  }

  return {
    dryRun,
    requested: candidates.length,
    wouldRecover: count("would_recover"),
    recovered: count("recovered"),
    alreadyRecovered: count("already_recovered"),
    missing: count("missing"),
    conflicts: count("conflict"),
    invalid: count("invalid"),
    observationsPlanned: totalObservations,
    observationsWritten,
    items,
  };
}
