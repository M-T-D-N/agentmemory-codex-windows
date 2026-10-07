import type { AuditEntry } from "../types.js";
import { KV, generateId } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { logger } from "../logger.js";

// Audit coverage policy (issue #125).
//
// Every structural deletion of a memory, observation, session, or
// semantic row MUST call recordAudit. Two shapes are allowed, keyed to
// whether the caller is scoped or bulk:
//
//   Scoped deletions — a user-visible, per-call action removing a
//   bounded set of items. Emit ONE audit row per call with targetIds
//   populated. Examples: mem::governance-delete, mem::forget.
//
//   Bulk deletions — automatic sweeps (retention, TTL eviction,
//   auto-forget) that can remove hundreds of rows per invocation.
//   Emit ONE batched audit row per invocation with targetIds listing
//   every removed id and details.evicted holding the count. Per-item
//   audit rows would flood the audit log during routine sweeps.
//
//   Either shape is required; silent deletes are not acceptable.
//
// operation field:
//   - "delete"          — permanent removal (governance, retention sweep, evict).
//   - "forget"          — forget/removal flows. Scoped when emitted by
//                         mem::forget (user-initiated); bulk-batched when
//                         emitted by mem::auto-forget (automatic sweep).
//   - everything else   — see AuditEntry["operation"] union in src/types.ts.
//
// When adding a new deletion path, add an explicit recordAudit call
// BEFORE kv.delete(...) and match one of the two shapes above.

export async function recordAudit(
  kv: StateKV,
  operation: AuditEntry["operation"],
  functionId: string,
  targetIds: string[],
  details: Record<string, unknown> = {},
  qualityScore?: number,
  userId?: string,
): Promise<AuditEntry> {
  const entry: AuditEntry = {
    id: generateId("aud"),
    timestamp: new Date().toISOString(),
    operation,
    userId,
    functionId,
    targetIds,
    details,
    qualityScore,
  };
  await kv.set(KV.audit, entry.id, entry);
  return entry;
}

export async function safeAudit(
  kv: StateKV,
  operation: AuditEntry["operation"],
  functionId: string,
  targetIds: string[],
  details: Record<string, unknown> = {},
  qualityScore?: number,
  userId?: string,
): Promise<void> {
  try {
    await recordAudit(kv, operation, functionId, targetIds, details, qualityScore, userId);
  } catch (err) {
    try {
      logger.warn("audit write failed", {
        functionId,
        operation,
        targetIds,
        error: err instanceof Error ? err.message : String(err),
      });
    } catch {}
  }
}

export async function queryAudit(
  kv: StateKV,
  filter?: {
    operation?: AuditEntry["operation"];
    dateFrom?: string;
    dateTo?: string;
    limit?: number;
  },
): Promise<AuditEntry[]> {
  const from = filter?.dateFrom ? Date.parse(filter.dateFrom) : undefined;
  const to = filter?.dateTo ? Date.parse(filter.dateTo) : undefined;
  if (from !== undefined && Number.isNaN(from)) throw new Error(`Invalid dateFrom: ${filter?.dateFrom}`);
  if (to !== undefined && Number.isNaN(to)) throw new Error(`Invalid dateTo: ${filter?.dateTo}`);
  const accepts = (entry: AuditEntry) => (!filter?.operation || entry.operation === filter.operation) &&
    (from === undefined || Date.parse(entry.timestamp) >= from) &&
    (to === undefined || Date.parse(entry.timestamp) <= to);
  const newestFirst = (a: AuditEntry, b: AuditEntry) => Date.parse(b.timestamp) - Date.parse(a.timestamp);
  const limit = filter?.limit || 100;
  if (!kv.usesManagedState) {
    return (await kv.list<AuditEntry>(KV.audit)).filter(accepts).sort(newestFirst).slice(0, limit);
  }
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid audit limit");
  let entries: AuditEntry[] = [];
  let offset = 0;
  let capturedTotal: number | undefined;
  do {
    const page = await kv.listPage<AuditEntry>(KV.audit, offset);
    capturedTotal ??= page.total;
    entries.push(...page.entries.slice(0, Math.max(0, capturedTotal - offset)).map(row => row.value).filter(accepts));
    entries.sort(newestFirst);
    entries = entries.slice(0, limit);
    if (page.next_offset === null || page.next_offset >= capturedTotal) break;
    offset = page.next_offset;
  } while (true);
  return entries;
}
