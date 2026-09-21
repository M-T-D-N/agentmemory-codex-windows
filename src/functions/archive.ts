import { createHash } from "node:crypto";
import type { ArchiveState, ArchiveTarget, Session } from "../types.js";
import type { StateKV } from "../state/kv.js";
import { isDeletedObservation } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { withObservationRecovery } from "../state/observation-write.js";
import { recordAudit } from "./audit.js";

const exact = (value: unknown): value is string => typeof value === "string" && Boolean(value) && value.trim() === value && value !== "*" && value.length <= 512 && !value.includes("\0");
const scopes = { memory: KV.memories, semantic: KV.semantic, procedural: KV.procedural, lesson: KV.lessons,
  session: KV.sessions, graph_node: KV.graphNodes, graph_edge: KV.graphEdges };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])).join(",") + "}";
  return JSON.stringify(value);
}
export const archiveTargetDigest = (record: unknown) => hash(canonical(JSON.parse(JSON.stringify(record))));

export function archiveTargetAddress(value: unknown): { target: ArchiveTarget; scope: string; key: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("An exact archive target is required");
  const target = value as ArchiveTarget;
  if (!exact(target.id) || ![...Object.keys(scopes), "observation"].includes(target.kind) ||
      Object.keys(target).some(key => !["kind", "id", "sessionId"].includes(key)) ||
      (target.kind === "observation" ? !exact(target.sessionId) : target.sessionId !== undefined)) throw Error("Invalid archive target");
  const normalized: ArchiveTarget = { kind: target.kind, id: target.id, ...(target.kind === "observation" ? { sessionId: target.sessionId } : {}) };
  return { target: normalized, scope: target.kind === "observation" ? KV.observations(target.sessionId!) : scopes[target.kind],
    key: hash(JSON.stringify([normalized.kind, normalized.id, normalized.sessionId ?? null])) };
}

export function validateArchiveState(value: unknown): ArchiveState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid archive state");
  const state = value as ArchiveState;
  const address = archiveTargetAddress(state.target);
  if (state.version !== 1 || state.id !== address.key || !exact(state.project) || !["archived", "restored"].includes(state.state) ||
      !Number.isSafeInteger(state.revision) || state.revision < 1 || !exact(state.auditId) ||
      typeof state.changedAt !== "string" || !Number.isFinite(Date.parse(state.changedAt)) ||
      typeof state.reason !== "string" || !state.reason.trim() || state.reason.length > 1000 ||
      typeof state.targetDigest !== "string" || !/^[a-f0-9]{64}$/.test(state.targetDigest) ||
      (state.importPendingDigest !== undefined && (typeof state.importPendingDigest !== "string" || !/^[a-f0-9]{64}$/.test(state.importPendingDigest))) ||
      Object.keys(state).some(key => !["version", "id", "target", "project", "state", "revision", "changedAt", "reason", "auditId", "targetDigest", "importPendingDigest"].includes(key))) throw Error("Invalid archive state");
  return { version: 1, id: state.id, target: address.target, project: state.project, state: state.state, revision: state.revision,
    changedAt: state.changedAt, reason: state.reason, auditId: state.auditId, targetDigest: state.targetDigest,
    ...(state.importPendingDigest ? { importPendingDigest: state.importPendingDigest } : {}) };
}

export async function readOwnedArchiveTarget(kv: Pick<StateKV, "get">, target: ArchiveTarget, scope: string, project: string) {
  const row = await kv.get<Record<string, unknown>>(scope, target.id, { includeDeleted: true });
  if (!row || row.id !== target.id || isDeletedObservation(row) || row.deleted === true) throw Error("Archive target is missing or intentionally deleted");
  await assertArchiveTargetOwnership(kv, target, row, project);
  return row;
}

export async function assertArchiveTargetOwnership(kv: Pick<StateKV, "get">, target: ArchiveTarget, value: object, project: string) {
  const row = value as Record<string, unknown>;
  if (row.id !== target.id) throw Error("Archive target identity does not match its original");
  if (target.kind === "observation") {
    const session = await kv.get<Session>(KV.sessions, target.sessionId!);
    if (row.sessionId !== target.sessionId || session?.project !== project) throw Error("Exact archive target ownership could not be verified");
  } else if (row.project !== undefined) {
    if (row.project !== project) throw Error("Exact archive target ownership could not be verified");
  } else {
    const ids = row.sessionIds ?? row.sourceSessionIds;
    if (!Array.isArray(ids) || !ids.length || ids.some(id => !exact(id))) throw Error("Archive target has no exact project provenance");
    for (const id of new Set(ids as string[])) {
      if ((await kv.get<Session>(KV.sessions, id))?.project !== project) throw Error("Archive target has missing or cross-project provenance");
    }
  }
}

export interface ArchiveRequest {
  target: ArchiveTarget;
  project: string;
  action: "archive" | "restore";
  dryRun?: boolean;
  expectedRevision?: number;
  expectedDigest?: string;
  reason?: string;
}

export type ArchiveVisibility = ((target: ArchiveTarget) => boolean) & {
  hasArchivedObservations(sessionId: string): boolean;
  hasArchivedGraph: boolean;
  graphRevision: string;
};

export async function readArchiveVisibility(kv: Pick<StateKV, "list">): Promise<ArchiveVisibility> {
  const states = new Map<string, ArchiveState>();
  const observationSessions = new Set<string>();
  for (const raw of await kv.list<ArchiveState>(KV.archiveStates)) {
    const state = validateArchiveState(raw);
    if (states.has(state.id)) throw Error("Duplicate canonical archive state");
    states.set(state.id, state);
    if (state.target.kind === "observation" && (state.state === "archived" || state.importPendingDigest)) observationSessions.add(state.target.sessionId!);
  }
  const direct = (target: ArchiveTarget) => {
    const state = states.get(archiveTargetAddress(target).key);
    return state?.state === "archived" || Boolean(state?.importPendingDigest);
  };
  const graphStates = [...states.values()].filter(state => state.target.kind === "graph_node" || state.target.kind === "graph_edge")
    .sort((a, b) => a.id.localeCompare(b.id));
  return Object.assign((target: ArchiveTarget): boolean => direct(target) ||
    (target.kind === "observation" && direct({ kind: "session", id: target.sessionId! })),
    { hasArchivedObservations: (sessionId: string) => observationSessions.has(sessionId),
      hasArchivedGraph: graphStates.some(state => state.state === "archived" || Boolean(state.importPendingDigest)),
      graphRevision: archiveTargetDigest(graphStates) });
}

export async function readArchiveCleanupProtection(kv: Pick<StateKV, "get" | "list">) {
  const targets = new Set<string>(), sessions = new Set<string>();
  const states = (await kv.list<ArchiveState>(KV.archiveStates)).map(validateArchiveState);
  for (let offset = 0; offset < states.length; offset += 8) {
    const batch = states.slice(offset, offset + 8);
    const originals = await Promise.all(batch.map(state => {
      const address = archiveTargetAddress(state.target);
      return readOwnedArchiveTarget(kv, address.target, address.scope, state.project);
    }));
    batch.forEach((state, index) => {
      targets.add(state.id);
      if (state.target.kind === "session") sessions.add(state.target.id);
      if (state.target.kind === "observation") sessions.add(state.target.sessionId!);
      const row = originals[index];
      for (const field of ["sessionIds", "sourceSessionIds"] as const) {
        if (row[field] === undefined) continue;
        if (!Array.isArray(row[field]) || row[field].some(id => !exact(id))) throw Error("Archive source sessions cannot be protected safely");
        for (const id of row[field] as string[]) sessions.add(id);
      }
    });
  }
  return (target: ArchiveTarget): boolean => targets.has(archiveTargetAddress(target).key) ||
    (target.kind === "session" && sessions.has(target.id)) ||
    (target.kind === "observation" && sessions.has(target.sessionId!));
}

export async function changeArchiveState(kv: StateKV, request: ArchiveRequest) {
  if (!request || !exact(request.project) || !["archive", "restore"].includes(request.action) ||
      (request.dryRun !== undefined && typeof request.dryRun !== "boolean")) throw Error("Archive requires an exact project and action");
  const address = archiveTargetAddress(request.target);
  const dryRun = request.dryRun !== false;
  if (!dryRun && (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision! < 0 ||
      typeof request.expectedDigest !== "string" || !/^[a-f0-9]{64}$/.test(request.expectedDigest) ||
      typeof request.reason !== "string" || !request.reason.trim() || request.reason.length > 1000)) throw Error("Archive apply requires the preview revision, target digest and reason");
  return withObservationRecovery(async () => {
    const row = await readOwnedArchiveTarget(kv, address.target, address.scope, request.project);
    const raw = await kv.get<ArchiveState>(KV.archiveStates, address.key);
    const previous = raw ? validateArchiveState(raw) : null;
    if (previous?.importPendingDigest) throw Error("Archive import recovery must finish before changing visibility");
    if (previous && previous.project !== request.project) throw Error("Archive ownership changed; reconcile before continuing");
    if (request.action === "restore" && !previous) throw Error("Target has never been archived");
    const desired = request.action === "archive" ? "archived" : "restored";
    const revision = previous?.revision ?? 0;
    const digest = archiveTargetDigest(row);
    const same = previous?.state === desired;
    if (dryRun) return { success: true, dryRun: true, target: address.target, project: request.project,
      state: previous?.state ?? "active", action: request.action, expectedRevision: revision, expectedDigest: digest, changed: same ? 0 : 1 };
    const retry = same && request.expectedRevision === revision - 1 && previous?.targetDigest === request.expectedDigest;
    if (request.expectedDigest !== digest || (request.expectedRevision !== revision && !retry)) throw Error("Archive preview is stale; inspect the current target again");
    if (same) return { success: true, dryRun: false, changed: 0, archive: previous! };
    const audit = await recordAudit(kv, request.action === "archive" ? "archive" : "archive_restore", "mem::archive", [address.target.id], {
      project: request.project, target: address.target, phase: "intent", previousRevision: revision, targetDigest: digest, reason: request.reason!.trim(),
    });
    const state: ArchiveState = { version: 1, id: address.key, target: address.target, project: request.project, state: desired,
      revision: revision + 1, targetDigest: digest, changedAt: audit.timestamp, reason: request.reason!.trim(), auditId: audit.id };
    await kv.set(KV.archiveStates, state.id, state);
    return { success: true, dryRun: false, changed: 1, archive: state };
  });
}
