import type { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { KV } from "../state/schema.js";
import type {
  CommitLink,
  CompressedObservation,
  Crystal,
  Lesson,
  Memory,
  ProceduralMemory,
  SemanticMemory,
  Session,
  SessionSummary,
} from "../types.js";
import { recordAudit } from "./audit.js";
import { GRAPH_WRITE_LOCK, inspectGraphSessionReferences } from "./graph.js";
import { sessionLifecycleLockKey } from "./session-lifecycle.js";
import { isExactSessionEndStub } from "./session-stub-recovery.js";

const MAX_STUB_PURGE_SESSIONS = 100;

export interface SessionStubReferenceCounts {
  observations: number;
  summaries: number;
  memories: number;
  semanticMemories: number;
  proceduralMemories: number;
  lessons: number;
  commits: number;
  crystals: number;
  graphNodes: number;
  graphEdges: number;
}

type SessionStubPurgeStatus =
  | "would_purge"
  | "purged"
  | "already_absent"
  | "conflict"
  | "referenced"
  | "invalid";

export interface SessionStubPurgeItemResult {
  sessionId: string;
  status: SessionStubPurgeStatus;
  references: SessionStubReferenceCounts;
  reason?: string;
}

export interface SessionStubPurgeResult {
  dryRun: boolean;
  requested: number;
  wouldPurge: number;
  purged: number;
  alreadyAbsent: number;
  conflicts: number;
  referenced: number;
  invalid: number;
  items: SessionStubPurgeItemResult[];
}

function emptyReferences(): SessionStubReferenceCounts {
  return {
    observations: 0,
    summaries: 0,
    memories: 0,
    semanticMemories: 0,
    proceduralMemories: 0,
    lessons: 0,
    commits: 0,
    crystals: 0,
    graphNodes: 0,
    graphEdges: 0,
  };
}

function totalReferences(references: SessionStubReferenceCounts): number {
  return Object.values(references).reduce((total, count) => total + count, 0);
}

function validSessionId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256;
}

async function withSessionLocks<T>(
  sessionIds: string[],
  fn: () => Promise<T>,
  index = 0,
): Promise<T> {
  if (index >= sessionIds.length) return fn();
  return withKeyedLock(sessionLifecycleLockKey(sessionIds[index]!), () =>
    withSessionLocks(sessionIds, fn, index + 1)
  );
}

function addReference(
  references: Map<string, SessionStubReferenceCounts>,
  sessionIds: string[] | undefined,
  field: keyof SessionStubReferenceCounts,
): void {
  for (const sessionId of new Set(sessionIds ?? [])) {
    const counts = references.get(sessionId);
    if (counts) counts[field]++;
  }
}

function summarize(
  dryRun: boolean,
  requested: number,
  items: SessionStubPurgeItemResult[],
): SessionStubPurgeResult {
  const count = (status: SessionStubPurgeStatus) =>
    items.filter((item) => item.status === status).length;
  return {
    dryRun,
    requested,
    wouldPurge: count("would_purge"),
    purged: count("purged"),
    alreadyAbsent: count("already_absent"),
    conflicts: count("conflict"),
    referenced: count("referenced"),
    invalid: count("invalid"),
    items,
  };
}

export async function purgeEmptySessionEndStubs(
  kv: StateKV,
  sessionIds: string[],
  dryRun = true,
): Promise<SessionStubPurgeResult> {
  const requested = Array.isArray(sessionIds) ? sessionIds.length : 0;
  if (
    !Array.isArray(sessionIds) ||
    sessionIds.length === 0 ||
    sessionIds.length > MAX_STUB_PURGE_SESSIONS
  ) {
    return summarize(dryRun, requested, [{
      sessionId: "",
      status: "invalid",
      references: emptyReferences(),
      reason: `sessionIds must contain 1-${MAX_STUB_PURGE_SESSIONS} exact IDs`,
    }]);
  }

  const seen = new Set<string>();
  for (const sessionId of sessionIds) {
    if (!validSessionId(sessionId) || seen.has(sessionId)) {
      return summarize(dryRun, requested, [{
        sessionId: typeof sessionId === "string" ? sessionId : "",
        status: "invalid",
        references: emptyReferences(),
        reason: seen.has(sessionId) ? "duplicate sessionId" : "invalid sessionId",
      }]);
    }
    seen.add(sessionId);
  }

  const sortedIds = [...sessionIds].sort();
  return withKeyedLock(GRAPH_WRITE_LOCK, () => withSessionLocks(sortedIds, async () => {
    const references = new Map(
      sortedIds.map((sessionId) => [sessionId, emptyReferences()]),
    );
    // Keep large scope reads serial. iii has a single state-processing path,
    // and a maintenance preflight must not recreate the foreground starvation
    // that this qualification cycle is intended to eliminate.
    const memories = await kv.list<Memory>(KV.memories);
    const semantic = await kv.list<SemanticMemory>(KV.semantic);
    const procedural = await kv.list<ProceduralMemory>(KV.procedural);
    const lessons = await kv.list<Lesson>(KV.lessons);
    const commits = await kv.list<CommitLink>(KV.commits);
    const crystals = await kv.list<Crystal>(KV.crystals);
    const graph = await inspectGraphSessionReferences(kv, sortedIds);

    for (const memory of memories) addReference(references, memory.sessionIds, "memories");
    for (const memory of semantic) {
      addReference(references, memory.sourceSessionIds, "semanticMemories");
    }
    for (const memory of procedural) {
      addReference(references, memory.sourceSessionIds, "proceduralMemories");
    }
    for (const lesson of lessons) {
      addReference(references, lesson.sourceSessionIds, "lessons");
    }
    for (const commit of commits) addReference(references, commit.sessionIds, "commits");
    for (const crystal of crystals) {
      addReference(references, crystal.sessionId ? [crystal.sessionId] : [], "crystals");
    }
    for (const entry of graph) {
      const counts = references.get(entry.sessionId)!;
      counts.graphNodes = entry.nodeIds.length;
      counts.graphEdges = entry.edgeIds.length;
    }

    const rows = new Map<string, Session | null>();
    const items: SessionStubPurgeItemResult[] = [];
    for (const sessionId of sortedIds) {
      const [row, observations, summary] = await Promise.all([
        kv.get<Session>(KV.sessions, sessionId),
        kv.list<CompressedObservation>(KV.observations(sessionId)),
        kv.get<SessionSummary>(KV.summaries, sessionId),
      ]);
      rows.set(sessionId, row);
      const counts = references.get(sessionId)!;
      counts.observations = observations.length;
      counts.summaries = summary ? 1 : 0;

      if (totalReferences(counts) > 0) {
        items.push({
          sessionId,
          status: "referenced",
          references: counts,
          reason: "session has canonical or graph reverse references",
        });
      } else if (!row) {
        items.push({ sessionId, status: "already_absent", references: counts });
      } else if (!isExactSessionEndStub(row)) {
        items.push({
          sessionId,
          status: "conflict",
          references: counts,
          reason: "session row is not the exact empty session-end stub",
        });
      } else {
        items.push({
          sessionId,
          status: "would_purge",
          references: counts,
        });
      }
    }

    const blocked = items.some((item) =>
      item.status === "referenced" || item.status === "conflict" || item.status === "invalid"
    );
    if (dryRun || blocked) return summarize(dryRun, requested, items);

    const targets = items
      .filter((item) => item.status === "would_purge")
      .map((item) => item.sessionId);
    if (targets.length > 0) {
      await recordAudit(kv, "delete", "mem::migrate", targets, {
        step: "purge-empty-session-end-stubs",
        reason: "legacy_empty_session_end_stub",
        sessions: targets.length,
      });
      for (const sessionId of targets) {
        if (!isExactSessionEndStub(rows.get(sessionId))) {
          throw new Error(`session changed after purge preflight: ${sessionId}`);
        }
        await kv.delete(KV.sessions, sessionId);
        items.find((item) => item.sessionId === sessionId)!.status = "purged";
      }
    }
    return summarize(dryRun, requested, items);
  }));
}
