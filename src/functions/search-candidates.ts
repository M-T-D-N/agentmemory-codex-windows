import type { CompressedObservation, Memory, Session } from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { memoryToObservation } from "../state/memory-utils.js";
import { readArchiveVisibility } from "./archive.js";
import { isExcludedCodexAmbientSession, sanitizeCodexAmbientObservation, observationSourceKind } from "./observation-visibility.js";

export interface SearchCandidate { obsId: string; sessionId: string; sourceSessionIds?: string[] }
export interface ResolvedSearchCandidate {
  observation: CompressedObservation;
  session?: Session;
  project?: string;
}
export interface SearchCandidateSelection {
  project?: string;
  readSession?(id: string): Promise<Session | null>;
  resolve?(candidate: SearchCandidate, indexedSession?: (obsId: string) => string | undefined): Promise<ResolvedSearchCandidate | null>;
  select<T extends SearchCandidate>(candidates: T[], limit: number, indexedSession?: (obsId: string) => string | undefined): Promise<T[]>;
}

export function createSearchCandidateSelection(kv: StateKV, scope: { project?: string; cwd?: string; agentId?: string; sourceKind?: "user" | "assistant" }): SearchCandidateSelection & { resolve: NonNullable<SearchCandidateSelection["resolve"]> } {
  let metadata: Promise<{ sessions: Map<string, Session>; memories: Map<string, Memory>; archived: Awaited<ReturnType<typeof readArchiveVisibility>> }> | undefined;
  const cache = new Map<string, Promise<ResolvedSearchCandidate | null>>();
  const readMetadata = () => metadata ??= Promise.all([kv.list<Session>(KV.sessions), kv.list<Memory>(KV.memories), readArchiveVisibility(kv)])
    .then(([sessions, memories, archived]) => ({ sessions: new Map(sessions.map(row => [row.id, row])), memories: new Map(memories.map(row => [row.id, row])), archived }));
  const resolve = (candidate: SearchCandidate, indexedSession?: (obsId: string) => string | undefined) => {
    const key = JSON.stringify([candidate.obsId, candidate.sessionId, candidate.sourceSessionIds]);
    let result = cache.get(key);
    if (!result) {
      result = (async () => {
        const { sessions, memories, archived } = await readMetadata();
        const memory = memories.get(candidate.obsId);
        if (memory) {
          if (scope.sourceKind) return null;
          if (archived({ kind: "memory", id: memory.id })) return null;
          const sessionId = memory.sessionIds?.[0] ?? "memory";
          const session = sessions.get(sessionId);
          const observation = sanitizeCodexAmbientObservation(memoryToObservation(memory));
          if (memory.isLatest === false || !observation || isExcludedCodexAmbientSession(session) ||
              (scope.project && (memory.project ?? session?.project) !== scope.project) ||
              (scope.cwd && session?.cwd !== scope.cwd) || (scope.agentId && memory.agentId !== scope.agentId)) return null;
          return { observation, session, project: memory.project ?? session?.project };
        }
        const sessionIds = candidate.sessionId ? [candidate.sessionId] : candidate.sourceSessionIds ?? [];
        const indexed = !candidate.sessionId ? indexedSession?.(candidate.obsId) : undefined;
        const hint = indexed && sessionIds.includes(indexed) ? indexed : undefined;
        const orderedSessionIds = hint ? [hint, ...sessionIds.filter(id => id !== hint)] : sessionIds;
        for (const sessionId of orderedSessionIds) {
          if (archived({ kind: "observation", id: candidate.obsId, sessionId })) continue;
          const session = sessions.get(sessionId);
          if (isExcludedCodexAmbientSession(session) || (scope.project && session?.project !== scope.project) ||
              (scope.cwd && session?.cwd !== scope.cwd)) continue;
          const observation = sanitizeCodexAmbientObservation(await kv.get<CompressedObservation>(KV.observations(sessionId), candidate.obsId));
          if (observation?.id === candidate.obsId && observation.sessionId === sessionId && (!scope.agentId || observation.agentId === scope.agentId)
              && (!scope.sourceKind || observationSourceKind(observation) === scope.sourceKind)) return { observation, session, project: session?.project };
          if (sessionId === hint && observation?.id === candidate.obsId && observation.sessionId === sessionId) return null;
        }
        return null;
      })().then(resolved => {
        if (resolved) cache.set(JSON.stringify([candidate.obsId, resolved.observation.sessionId, undefined]), Promise.resolve(resolved));
        return resolved;
      });
      cache.set(key, result);
    }
    return result;
  };
  return { project: scope.project, resolve,
    async readSession(id) { return (await readMetadata()).sessions.get(id) ?? null; },
    async select(candidates, limit, indexedSession) {
    const selected: typeof candidates = [];
    for (let offset = 0; offset < candidates.length && selected.length < limit; offset += 8) {
      const batch = candidates.slice(offset, offset + 8);
      const matches = await Promise.all(batch.map(candidate => resolve(candidate, indexedSession)));
      for (let index = 0; index < batch.length && selected.length < limit; index++) {
        if (matches[index] !== null) selected.push({ ...batch[index], sessionId: matches[index]!.observation.sessionId });
      }
    }
    return selected;
  } };
}
