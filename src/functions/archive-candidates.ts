import type { ArchiveTarget, Memory, SemanticMemory, Session } from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { readArchiveVisibility } from "./archive.js";
import { emptyAccessLog, normalizeAccessLog } from "./access-tracker.js";
import { computeRetentionEntry, DEFAULT_DECAY } from "./retention.js";

export interface ArchiveCandidateQuery {
  action: "candidates";
  project: string;
  policy: "all" | "retention" | "ttl";
  threshold: number;
  limit: number;
  offset: number;
}

export async function listArchiveCandidates(kv: StateKV, query: ArchiveCandidateQuery) {
  const now = Date.now();
  const [memories, semantic, rawLogs, hidden] = await Promise.all([
    kv.list<Memory>(KV.memories), query.policy === "ttl" ? [] : kv.list<SemanticMemory>(KV.semantic),
    query.policy === "ttl" ? [] : kv.list<unknown>(KV.accessLog), readArchiveVisibility(kv),
  ]);
  const logs = new Map(rawLogs.map(normalizeAccessLog).map(log => [log.memoryId, log]));
  const sessions = new Map<string, Session | null>();
  const owns = async (row: Memory | SemanticMemory) => {
    const direct = (row as Memory).project;
    if (direct !== undefined) return direct === query.project;
    const ids = (row as Memory).sessionIds ?? (row as SemanticMemory).sourceSessionIds;
    if (!Array.isArray(ids) || !ids.length) return false;
    for (const id of new Set(ids)) {
      if (typeof id !== "string" || !id || id.trim() !== id || id === "*" || id.includes("\0") || id.length > 512) return false;
      if (!sessions.has(id)) sessions.set(id, await kv.get<Session>(KV.sessions, id));
      if (sessions.get(id)?.project !== query.project) return false;
    }
    return true;
  };
  const candidates: Array<{ target: ArchiveTarget; reasons: string[]; retentionScore?: number; forgetAfter?: string }> = [];
  let invalidPolicyRecords = 0;
  for (const [kind, rows] of [["memory", memories], ["semantic", semantic]] as const) {
    for (const row of rows) {
      if (!await owns(row)) continue;
      const target: ArchiveTarget = { kind, id: row.id };
      if (hidden(target) || (row as unknown as { deleted?: boolean }).deleted) continue;
      const reasons: string[] = [];
      let retentionScore: number | undefined, forgetAfter: string | undefined, invalid = false;
      if (query.policy !== "ttl" && (kind === "semantic" || (row as Memory).isLatest)) {
        const created = Date.parse(row.createdAt);
        const entry = computeRetentionEntry(row, kind === "memory" ? "episodic" : "semantic",
          logs.get(row.id) ?? emptyAccessLog(row.id), DEFAULT_DECAY, now);
        if (!Number.isFinite(created) || created > now || !Number.isFinite(entry.score)) invalid = true;
        else if (entry.score < query.threshold) {
          reasons.push("retention-score-below-threshold");
          retentionScore = entry.score;
        }
      }
      if (query.policy !== "retention" && kind === "memory" && (row as Memory).forgetAfter) {
        const expiry = Date.parse((row as Memory).forgetAfter!);
        if (!Number.isFinite(expiry)) invalid = true;
        else if (now > expiry) {
          reasons.push("ttl-expired");
          forgetAfter = (row as Memory).forgetAfter;
        }
      }
      if (invalid) invalidPolicyRecords++;
      if (reasons.length) candidates.push({ target, reasons,
        ...(retentionScore !== undefined ? { retentionScore } : {}), ...(forgetAfter ? { forgetAfter } : {}) });
    }
  }
  candidates.sort((a, b) => a.target.kind.localeCompare(b.target.kind) || a.target.id.localeCompare(b.target.id));
  const page = candidates.slice(query.offset, query.offset + query.limit);
  return { success: true, dryRun: true, project: query.project, policy: query.policy,
    evaluatedAt: new Date(now).toISOString(), threshold: query.threshold, decay: DEFAULT_DECAY,
    candidates: page, total: candidates.length, invalidPolicyRecords, limit: query.limit, offset: query.offset,
    nextOffset: query.offset + page.length < candidates.length ? query.offset + page.length : null,
    reviewRequired: true, automaticArchiveEnabled: false,
    coverage: "Current exact-owned memory and semantic records only; unresolved ownership is excluded. Scores use current access history. This is not a historical snapshot or a bulk-apply preview. Inspect each target and obtain an archive preview before applying." };
}
