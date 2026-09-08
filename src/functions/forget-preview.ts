import type { StateKV } from "../state/kv.js";
import { KV, OBSERVATION_REFERENCE_ROW_SCOPES } from "../state/schema.js";

type Row = Record<string, unknown>;

function hasContent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return Boolean(value.trim());
  if (Array.isArray(value)) return value.some(hasContent);
  if (typeof value === "object") return Object.values(value).some(hasContent);
  return true;
}

export function observationContentFields(row: Row): string[] {
  const metadata = new Set(["id", "sessionId", "timestamp", "type", "importance", "confidence", "modality", "agentId", "origin", "project", "emptyDeletion"]);
  return Object.entries(row).filter(([key, value]) => {
    if (metadata.has(key)) return false;
    if (key === "title" && ["assistant_response", "prompt_submit"].includes(String(value))) return false;
    return hasContent(value);
  }).map(([key]) => key);
}

export async function previewSessionForget(kv: StateKV, data: {
  project?: unknown; sessionId?: unknown; observationIds?: unknown; memoryId?: unknown;
}, includeDeleted = false) {
  if (typeof data.project !== "string" || !data.project.trim() || data.project.trim() === "*" || data.project.length > 512 ||
      typeof data.sessionId !== "string" || !data.sessionId.trim() || data.memoryId !== undefined) {
    throw new Error("forget preview requires one exact project and sessionId; memoryId is not supported");
  }
  const project = data.project.trim();
  const sessionId = data.sessionId.trim();
  const selected = data.observationIds === undefined ? undefined : data.observationIds;
  if (selected !== undefined && (!Array.isArray(selected) || selected.length === 0 || selected.length > 500 ||
      selected.some((id) => typeof id !== "string" || !id.trim()) || new Set(selected).size !== selected.length)) {
    throw new Error("observationIds must be 1-500 unique non-empty strings; omit it only for a session preview");
  }
  const ids = selected as string[] | undefined;
  const session = await kv.get<Row>(KV.sessions, sessionId);
  if (!session) return { success: true, dryRun: true, project, sessionId, exists: false, targets: [], references: [], referenceCount: 0 };
  if (session.project !== project) throw new Error("session project mismatch");
  const observations = await kv.list<Row>(KV.observations(sessionId), { includeDeleted });
  const summary = await kv.get<Row>(KV.summaries, sessionId);
  const targetIds = new Set(ids ?? observations.map((row) => String(row.id)));
  const targets = ids ? ids.map((id) => {
    const row = observations.find((item) => item.id === id && item.sessionId === sessionId);
    const fields = row ? observationContentFields(row) : [];
    return { id, kind: "observation", exists: Boolean(row), empty: Boolean(row) && fields.length === 0, contentFields: fields };
  }) : [{
    id: sessionId, kind: "session", exists: true,
    empty: observations.length === 0 && ![session.firstPrompt, session.summary, session.tags, session.commitShas].some(hasContent) &&
      (!summary || !Object.entries(summary).some(([key, value]) => !["sessionId", "project", "createdAt", "observationCount"].includes(key) && hasContent(value))),
    contentFields: [
      ...(observations.length ? ["observations"] : []),
      ...["firstPrompt", "summary", "tags", "commitShas"].filter((key) => hasContent(session[key])),
      ...(summary && Object.entries(summary).some(([key, value]) => !["sessionId", "project", "createdAt", "observationCount"].includes(key) && hasContent(value)) ? ["storedSummary"] : []),
    ],
  }];
  const references: Array<{ scope: string; id: string; kind: string; matchedIds: string[] }> = [];
  let referenceCount = 0;
  const scan = (scope: string, rows: Row[]) => {
    for (const row of rows) {
      const observationRefs = [row.originalObsId, row.sourceId, row.targetId, ...(Array.isArray(row.sourceObservationIds) ? row.sourceObservationIds : []), ...(Array.isArray(row.sourceIds) ? row.sourceIds : []), ...(Array.isArray((row.reviewRetirement as Row | undefined)?.sourceObservationIds) ? (row.reviewRetirement as Row).sourceObservationIds as unknown[] : [])];
      const matches = observationRefs.filter((id): id is string => typeof id === "string" && targetIds.has(id));
      const sessionRefs = [row.sessionId, ...(Array.isArray(row.sourceSessionIds) ? row.sourceSessionIds : []), ...(Array.isArray(row.sessionIds) ? row.sessionIds : []), ...(Array.isArray(row.sourceIds) ? row.sourceIds : [])];
      const sessionMatch = sessionRefs.includes(sessionId) && (!ids || observationRefs.filter((id) => typeof id === "string").length === 0);
      if (!matches.length && !sessionMatch) continue;
      referenceCount++;
      if (references.length < 100) references.push({ scope, id: String(row.id ?? row.sha ?? row.sessionId ?? "<unkeyed>"), kind: matches.length ? "observation" : "session_or_ambiguous", matchedIds: [...new Set(matches.length ? matches : [sessionId])] });
    }
  };
  for (const scope of OBSERVATION_REFERENCE_ROW_SCOPES) scan(scope, await kv.list<Row>(scope));
  const snapshot = await kv.get<Row>(KV.graphSnapshot, "current");
  if (snapshot) scan(KV.graphSnapshot, [...(Array.isArray(snapshot.topNodes) ? snapshot.topNodes : []), ...(Array.isArray(snapshot.topEdges) ? snapshot.topEdges : [])]);
  const sessions = await kv.list<Row>(KV.sessions);
  const uninspectableSessionCount = sessions.filter((other) => typeof other?.id !== "string" || !other.id.trim()).length;
  const groups = await kv.listGroups();
  const bucketScopes = groups.filter((scope) => scope.startsWith("mem:obs:") || scope.startsWith("mem:enriched:"));
  for (const scope of bucketScopes) {
    const rows = scope === KV.observations(sessionId) ? observations : await kv.list<Row>(scope, { includeDeleted: true });
    if (scope.startsWith("mem:obs:")) {
      const derived = rows.filter((row) => !(scope === KV.observations(sessionId) && targetIds.has(String(row.id))) && Array.isArray(row.sourceObservationIds));
      scan(scope, derived.map((row) => ({ ...row, sessionId: undefined })));
    } else {
      scan(scope, rows);
    }
  }
  return {
    success: true, dryRun: true, project, sessionId, exists: true, targets,
    referenceInventoryComplete: true,
    uninspectableSessionCount, checkedBucketCount: bucketScopes.length,
    sessionStatus: session.status, actualObservationCount: observations.length,
    semanticGraphStatus: session.semanticGraphStatus,
    references, referenceCount, referencesTruncated: referenceCount > references.length,
    checkedScopes: [...OBSERVATION_REFERENCE_ROW_SCOPES, KV.graphSnapshot, "all observation and enriched-chunk buckets enumerated by state::list_groups"],
    permanentDeletion: true,
    limitations: ["Read-only inventory, not a transaction or authorization to delete.", "Concurrent writers can change references after this response; verify the matching lifecycle before applying deletion."],
  };
}
