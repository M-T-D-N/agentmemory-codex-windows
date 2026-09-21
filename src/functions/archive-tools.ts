import type { ISdk } from "iii-sdk";
import type { ArchiveState, ArchiveTarget } from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { checkPayloadFrameSize } from "../state/frame-guard.js";
import { withObservationRecovery } from "../state/observation-write.js";
import { archiveTargetAddress, changeArchiveState, readOwnedArchiveTarget, validateArchiveState, type ArchiveRequest } from "./archive.js";
import { listArchiveCandidates, type ArchiveCandidateQuery } from "./archive-candidates.js";

type ArchiveToolInput = ArchiveRequest | ArchiveCandidateQuery | { action: "inspect"; project: string; target: ArchiveTarget } |
  { action: "list"; project: string; state: "archived" | "restored" | "all"; limit: number; offset: number };

export function parseArchiveToolInput(value: unknown): ArchiveToolInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Archive request must be an object");
  const input = value as Record<string, unknown>;
  if (typeof input.project !== "string" || !input.project || input.project !== input.project.trim() ||
      input.project === "*" || input.project.length > 512 || input.project.includes("\0")) throw Error("Archive requires an exact project");
  const project = input.project, action = input.action ?? "inspect";
  const fields = action === "candidates" ? ["action", "project", "policy", "threshold", "limit", "offset"] :
    action === "list" ? ["action", "project", "state", "limit", "offset"] :
    action === "inspect" ? ["action", "project", "target"] :
    ["action", "project", "target", "dryRun", "expectedRevision", "expectedDigest", "reason"];
  if (Object.keys(input).some(key => !fields.includes(key))) throw Error("Unexpected archive request field");
  if (action === "candidates") {
    const policy = input.policy ?? "all", threshold = input.threshold ?? 0.15, limit = input.limit ?? 20, offset = input.offset ?? 0;
    if (!["all", "retention", "ttl"].includes(policy as string) || typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0 || threshold > 1 ||
        !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100 || !Number.isSafeInteger(offset) || (offset as number) < 0) throw Error("Invalid archive candidate policy or pagination");
    return { action, project, policy: policy as ArchiveCandidateQuery["policy"], threshold, limit: limit as number, offset: offset as number };
  }
  if (action === "list") {
    const state = input.state ?? "archived", limit = input.limit ?? 20, offset = input.offset ?? 0;
    if (!["archived", "restored", "all"].includes(state as string) || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100 ||
        !Number.isSafeInteger(offset) || (offset as number) < 0) throw Error("Invalid archive list filter or pagination");
    return { action, project, state: state as "archived" | "restored" | "all", limit: limit as number, offset: offset as number };
  }
  const target = archiveTargetAddress(input.target).target;
  if (action === "inspect") return { action, project, target };
  if (action !== "archive" && action !== "restore") throw Error("Invalid archive action");
  if (input.dryRun !== undefined && typeof input.dryRun !== "boolean") throw Error("dryRun must be a boolean");
  if (input.expectedRevision !== undefined && (!Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 0) ||
      input.expectedDigest !== undefined && (typeof input.expectedDigest !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedDigest)) ||
      input.reason !== undefined && (typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 1000)) throw Error("Invalid archive preview evidence");
  return { action, project, target, dryRun: input.dryRun !== false,
    ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision as number } : {}),
    ...(input.expectedDigest !== undefined ? { expectedDigest: input.expectedDigest as string } : {}),
    ...(input.reason !== undefined ? { reason: input.reason as string } : {}) };
}

export function registerArchiveFunctions(sdk: ISdk, kv: StateKV) {
  sdk.registerFunction("mem::archive", async (data: unknown) => {
    // iii-engine adds transport metadata after REST/MCP business input validation.
    const payload = data && typeof data === "object" && !Array.isArray(data)
      ? Object.fromEntries(Object.entries(data).filter(([key]) => key !== "_caller_worker_id")) : data;
    const input = parseArchiveToolInput(payload);
    if (input.action === "archive" || input.action === "restore") return changeArchiveState(kv, input);
    return withObservationRecovery(async () => {
      if (input.action === "candidates") return listArchiveCandidates(kv, input);
      if (input.action === "list") {
        const rows = (await kv.list<ArchiveState>(KV.archiveStates)).map(validateArchiveState)
          .filter(state => state.project === input.project && (input.state === "all" ||
            (input.state === "archived" ? state.state === "archived" || Boolean(state.importPendingDigest) : state.state === "restored" && !state.importPendingDigest)))
          .sort((a, b) => b.changedAt.localeCompare(a.changedAt) || a.id.localeCompare(b.id));
        const archives = rows.slice(input.offset, input.offset + input.limit);
        return { success: true, archives, total: rows.length, limit: input.limit, offset: input.offset,
          nextOffset: input.offset + archives.length < rows.length ? input.offset + archives.length : null };
      }
      const address = archiveTargetAddress(input.target);
      const record = await readOwnedArchiveTarget(kv, address.target, address.scope, input.project);
      const raw = await kv.get<ArchiveState>(KV.archiveStates, address.key);
      const archive = raw ? validateArchiveState(raw) : null;
      if (archive && archive.project !== input.project) throw Error("Archive ownership changed; reconcile before continuing");
      const result = { success: true, target: address.target, project: input.project, state: archive?.state ?? "active",
        importPending: Boolean(archive?.importPendingDigest), archive, record };
      return checkPayloadFrameSize(result, "archive record exceeds the supported transport frame; use the canonical export path") ?? result;
    });
  });
}
