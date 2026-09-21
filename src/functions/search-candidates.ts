import type { CompressedObservation, Memory, Session } from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { memoryToObservation } from "../state/memory-utils.js";
import { readArchiveVisibility } from "./archive.js";
import { isExcludedCodexAmbientSession, sanitizeCodexAmbientObservation } from "./observation-visibility.js";

export interface SearchCandidate { obsId: string; sessionId: string; sourceSessionIds?: string[] }
export interface SearchCandidateSelection {
  project?: string;
  select<T extends SearchCandidate>(candidates: T[], limit: number): Promise<T[]>;
}

export function createSearchCandidateSelection(kv: StateKV, scope: { project?: string; cwd?: string; agentId?: string }): SearchCandidateSelection {
  let metadata: Promise<{ sessions: Map<string, Session>; memories: Map<string, Memory>; archived: Awaited<ReturnType<typeof readArchiveVisibility>> }> | undefined;
  const cache = new Map<string, Promise<string | null>>();
  const readMetadata = () => metadata ??= Promise.all([kv.list<Session>(KV.sessions), kv.list<Memory>(KV.memories), readArchiveVisibility(kv)])
    .then(([sessions, memories, archived]) => ({ sessions: new Map(sessions.map(row => [row.id, row])), memories: new Map(memories.map(row => [row.id, row])), archived }));
  const accepts = (candidate: SearchCandidate) => {
    const key = JSON.stringify([candidate.obsId, candidate.sessionId, candidate.sourceSessionIds]);
    let result = cache.get(key);
    if (!result) {
      result = (async () => {
        const { sessions, memories, archived } = await readMetadata();
        const memory = memories.get(candidate.obsId);
        if (memory) {
          if (archived({ kind: "memory", id: memory.id })) return null;
          const sessionId = memory.sessionIds?.[0] ?? "memory";
          const session = sessions.get(sessionId);
          if (memory.isLatest === false || !sanitizeCodexAmbientObservation(memoryToObservation(memory)) || isExcludedCodexAmbientSession(session) ||
              (scope.project && (memory.project ?? session?.project) !== scope.project) ||
              (scope.cwd && session?.cwd !== scope.cwd) || (scope.agentId && memory.agentId !== scope.agentId)) return null;
          return sessionId;
        }
        const sessionIds = candidate.sessionId ? [candidate.sessionId] : candidate.sourceSessionIds ?? [];
        for (const sessionId of sessionIds) {
          if (archived({ kind: "observation", id: candidate.obsId, sessionId })) continue;
          const session = sessions.get(sessionId);
          if (isExcludedCodexAmbientSession(session) || (scope.project && session?.project !== scope.project) ||
              (scope.cwd && session?.cwd !== scope.cwd)) continue;
          const observation = sanitizeCodexAmbientObservation(await kv.get<CompressedObservation>(KV.observations(sessionId), candidate.obsId));
          if (observation?.id === candidate.obsId && observation.sessionId === sessionId && (!scope.agentId || observation.agentId === scope.agentId)) return sessionId;
        }
        return null;
      })();
      cache.set(key, result);
    }
    return result;
  };
  return { project: scope.project, async select(candidates, limit) {
    const selected: typeof candidates = [];
    for (let offset = 0; offset < candidates.length && selected.length < limit; offset += 8) {
      const batch = candidates.slice(offset, offset + 8);
      const matches = await Promise.all(batch.map(accepts));
      for (let index = 0; index < batch.length && selected.length < limit; index++) {
        if (matches[index] !== null) selected.push({ ...batch[index], sessionId: matches[index]! });
      }
    }
    return selected;
  } };
}
