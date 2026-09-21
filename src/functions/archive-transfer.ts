import type { ArchiveState, ArchiveTarget, ExportData, Session } from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { archiveTargetAddress, archiveTargetDigest, readOwnedArchiveTarget, validateArchiveState } from "./archive.js";
import { codexSessionForTransfer } from "../replay/codex-capture-state.js";

const addressKey = (scope: string, id: string) => JSON.stringify([scope, id]);
export async function legacyMeshArchiveError(kv: Pick<StateKV, "list">, payload?: object): Promise<string | undefined> {
  if (payload && Object.hasOwn(payload, "archiveStates")) {
    return "Legacy mesh cannot import archive lifecycle state; use the archive-aware export/import functions";
  }
  if ((await kv.list(KV.archiveStates)).length) {
    return "Legacy mesh cannot preserve this store's archive/restore history; use the archive-aware export/import functions";
  }
}

function archiveRows(data: ExportData) {
  const rows = new Map<string, Record<string, unknown>>();
  const duplicates = new Set<string>();
  const add = (scope: string, records: unknown[] | undefined) => {
    if (records === undefined) return;
    if (!Array.isArray(records)) throw Error("Invalid archive target collection");
    for (const value of records) {
      const row = value as Record<string, unknown>;
      if (!row || typeof row.id !== "string") continue;
      const key = addressKey(scope, row.id);
      if (rows.has(key)) duplicates.add(key);
      rows.set(key, row);
    }
  };
  add(KV.sessions, data.sessions); add(KV.memories, data.memories);
  add(KV.semantic, data.semanticMemories); add(KV.procedural, data.proceduralMemories);
  add(KV.lessons, data.lessons); add(KV.graphNodes, data.graphNodes); add(KV.graphEdges, data.graphEdges);
  for (const [sessionId, observations] of Object.entries(data.observations)) add(KV.observations(sessionId), observations);
  return { rows, duplicates };
}

function comparable(row: Record<string, unknown>, target: ArchiveTarget, incoming: Record<string, unknown>) {
  if (target.kind === "session") {
    const { observationCount: _count, semanticGraphStatus: _status, ...content } = codexSessionForTransfer(row as unknown as Session);
    return content;
  }
  if (target.kind === "memory" && !Array.isArray(row.sessionIds)) row = { ...row, sessionIds: [] };
  if (incoming.origin === undefined && (row.origin as { channel?: string } | undefined)?.channel === "import") {
    const { origin: _origin, ...rest } = row;
    return rest;
  }
  return row;
}

function sameOriginal(current: Record<string, unknown>, incoming: Record<string, unknown>, target: ArchiveTarget) {
  return archiveTargetDigest(comparable(current, target, incoming)) === archiveTargetDigest(comparable(incoming, target, incoming));
}

function completedState(state: ArchiveState) {
  const { importPendingDigest: _pending, ...completed } = state;
  return completed;
}

export async function collectArchiveExport(kv: StateKV, data: ExportData): Promise<ArchiveState[]> {
  const states = (await kv.list<ArchiveState>(KV.archiveStates)).map(validateArchiveState);
  if (states.some(state => state.importPendingDigest)) throw Error("Archive import recovery must finish before export");
  if (!states.length) return [];
  const { rows, duplicates } = archiveRows(data);
  const selected = new Set(data.sessions.map(session => session.id));
  const result: ArchiveState[] = [];
  for (const state of states) {
    if (state.target.kind === "session" && !selected.has(state.target.id) ||
        state.target.kind === "observation" && !selected.has(state.target.sessionId!)) continue;
    const address = archiveTargetAddress(state.target), key = addressKey(address.scope, state.target.id);
    if (!rows.has(key) || duplicates.has(key)) throw Error("Archive export requires its unique original target");
    await readOwnedArchiveTarget(kv, state.target, address.scope, state.project);
    result.push(state);
  }
  return result;
}

export async function prepareArchiveImport(kv: StateKV, data: ExportData, strategy: string) {
  if (data.archiveStates !== undefined && (!Array.isArray(data.archiveStates) || data.archiveStates.length > 500_000)) throw Error("Invalid archive transfer collection");
  const incoming = (data.archiveStates ?? []).map(validateArchiveState);
  const existing = (await kv.list<ArchiveState>(KV.archiveStates)).map(validateArchiveState);
  const protectedKeys = new Set<string>();
  const pending: ArchiveState[] = [];
  const completed: ArchiveState[] = [];
  const protects = (scope: string, id: string) => protectedKeys.has(addressKey(scope, id));
  if (!incoming.length && !existing.length) return { pending, completed, protects };
  if (strategy === "replace" && existing.length) throw Error("Replace import would erase lifecycle originals; use merge or an empty destination");
  const { rows, duplicates } = archiveRows(data);
  const current = new Map(existing.map(state => [state.id, state]));
  if (current.size !== existing.length || new Set(incoming.map(state => state.id)).size !== incoming.length) throw Error("Duplicate archive transfer identity");
  const sourceReader: Pick<StateKV, "get"> = { get: async <T>(scope: string, id: string) => {
    const retained = strategy === "skip" ? await kv.get<T>(scope, id) : undefined;
    return retained ?? (rows.get(addressKey(scope, id)) as T | undefined) ?? await kv.get<T>(scope, id);
  } };
  for (const state of incoming) {
    if (state.importPendingDigest) throw Error("An unfinished archive import cannot be transferred");
    const address = archiveTargetAddress(state.target), key = addressKey(address.scope, state.target.id);
    const row = rows.get(key);
    if (!row || duplicates.has(key)) throw Error("Archive transfer requires its unique original target");
    await readOwnedArchiveTarget(sourceReader, state.target, address.scope, state.project);
    const prior = current.get(state.id);
    if (prior && prior.project !== state.project) throw Error("Archive import cannot reassign target ownership");
    const digest = archiveTargetDigest(row);
    if (prior?.importPendingDigest && (prior.importPendingDigest !== digest || archiveTargetDigest(completedState(prior)) !== archiveTargetDigest(state))) throw Error("Archive import recovery requires the same original payload");
    if (!prior || prior.importPendingDigest) {
      const retained = strategy === "skip" ? await kv.get<Record<string, unknown>>(address.scope, state.target.id) : undefined;
      if (retained && !sameOriginal(retained, row, state.target)) throw Error("Skip import cannot apply archive metadata to a different original");
      pending.push({ ...state, importPendingDigest: digest });
      completed.push(state);
    }
  }
  for (const state of existing) {
    const address = archiveTargetAddress(state.target), key = addressKey(address.scope, state.target.id);
    if (state.importPendingDigest) {
      if (!incoming.some(row => row.id === state.id)) throw Error("Resume the unfinished archive import before another import");
      continue;
    }
    const canonical = await kv.get<Record<string, unknown>>(address.scope, state.target.id, { includeDeleted: true });
    const row = rows.get(key);
    if (canonical) await readOwnedArchiveTarget(sourceReader, state.target, address.scope, state.project);
    if (!row) continue;
    if (!canonical) throw Error("Import cannot recreate a missing archived or restored target");
    if (state.state !== "archived") continue;
    if (duplicates.has(key) || !sameOriginal(canonical, row, state.target)) {
      throw Error("Import would overwrite an archived original; restore or reconcile it first");
    }
    protectedKeys.add(key);
  }
  return { pending, completed, protects };
}

export async function finishArchiveImport(kv: StateKV, data: ExportData, states: ArchiveState[]) {
  if (!states.length) return;
  const { rows } = archiveRows(data);
  for (const state of states) {
    const address = archiveTargetAddress(state.target);
    const original = rows.get(addressKey(address.scope, state.target.id))!;
    const current = await readOwnedArchiveTarget(kv, state.target, address.scope, state.project);
    const pending = await kv.get<ArchiveState>(KV.archiveStates, state.id);
    if (!pending || pending.importPendingDigest !== archiveTargetDigest(original) ||
        archiveTargetDigest(completedState(validateArchiveState(pending))) !== archiveTargetDigest(state) ||
        !sameOriginal(current, original, state.target)) throw Error("Archive import original is not fully stored");
  }
  for (const state of states) await kv.set(KV.archiveStates, state.id, state);
}
