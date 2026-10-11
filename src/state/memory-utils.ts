import type { CompressedObservation, Lesson, Memory, Session } from "../types.js";

export type MemoryProjectResolution =
  | { status: "inferable"; project: string }
  | { status: "no-session-provenance" }
  | { status: "ambiguous" };

export function resolveMemoryProject(
  memory: Pick<Memory, "sessionIds" | "sourceObservationIds">,
  sessions: ReadonlyMap<string, Session>,
): MemoryProjectResolution {
  const sessionIds = [...new Set(memory.sessionIds ?? [])];
  if (sessionIds.length === 0) {
    return (memory.sourceObservationIds?.length ?? 0) === 0
      ? { status: "no-session-provenance" }
      : { status: "ambiguous" };
  }

  let project: string | undefined;
  for (const sessionId of sessionIds) {
    const session = sessions.get(sessionId);
    if (!session || typeof session.project !== "string" || !session.project.trim()) {
      return { status: "ambiguous" };
    }
    if (project !== undefined && session.project !== project) {
      return { status: "ambiguous" };
    }
    project = session.project;
  }

  return project === undefined
    ? { status: "ambiguous" }
    : { status: "inferable", project };
}

// Wraps a Memory record in the CompressedObservation shape that
// SearchIndex / VectorIndex / enrichment paths consume. Memories share
// the same searchable fields as observations (title + content +
// concepts + files); type is normalized to "decision" so memories stay
// distinguishable in result metadata without colliding with observation
// enums (file_read, command_run, …). The synthetic sessionId
// ("memory" or memory.sessionIds[0]) is what enrich-side fallbacks key
// off of when looking up the source record in KV.memories.
export function memoryToObservation(memory: Memory): CompressedObservation {
  return {
    id: memory.id,
    sessionId: memory.sessionIds?.[0] ?? "memory",
    timestamp: memory.createdAt,
    type: "decision",
    title: memory.title,
    facts: [memory.content],
    narrative: memory.content,
    concepts: memory.concepts,
    files: memory.files,
    importance: memory.strength,
    sourceObservationIds: memory.sourceObservationIds ?? [],
    // Carry the owning agent through so agent-scoped search filters see
    // memories, not just raw observations. Dropping it made every memory
    // invisible to any agentId-scoped query.
    ...(memory.agentId ? { agentId: memory.agentId } : {}),
    ...(memory.project ? { project: memory.project } : {}),
  };
}

// Same adapter for lessons, kept beside memoryToObservation so a new
// CompressedObservation field has one obvious place to be threaded
// through both record kinds.
export function lessonToObservation(l: Lesson): CompressedObservation {
  return {
    id: l.id,
    sessionId: "lesson",
    timestamp: l.createdAt,
    type: "decision",
    title: l.content.slice(0, 120),
    facts: [l.content],
    narrative: l.context || "",
    concepts: l.tags,
    files: [],
    importance: l.confidence,
  };
}


export function currentMemoryHeads(memories: readonly Memory[]): Memory[] {
  const byId = new Map(memories.map(memory => [memory.id, memory]));
  const superseded = new Set<string>();
  for (const successor of memories) {
    for (const id of new Set([...(successor.supersedes ?? []), ...(successor.parentId ? [successor.parentId] : [])])) {
      const parent = byId.get(id);
      if (parent && parent.project === successor.project && parent.agentId === successor.agentId
        && (successor.version ?? 1) > (parent.version ?? 1)) superseded.add(id);
    }
  }
  return memories.filter(memory => memory.isLatest !== false && !superseded.has(memory.id));
}
