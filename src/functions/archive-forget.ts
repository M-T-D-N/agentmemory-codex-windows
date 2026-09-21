import type { ArchiveState, ArchiveTarget } from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { archiveTargetAddress, assertArchiveTargetOwnership, readOwnedArchiveTarget, validateArchiveState } from "./archive.js";
import { recordAudit } from "./audit.js";

export async function prepareArchiveForget(kv: StateKV, request: {
  project?: string; sessionId?: string; observationIds?: string[]; memoryId?: string;
}) {
  const states = (await kv.list<ArchiveState>(KV.archiveStates)).map(validateArchiveState);
  const wholeSession = Boolean(request.sessionId) && request.observationIds === undefined && !request.memoryId;
  const observations = new Set(request.observationIds ?? []);
  const selected: ArchiveState[] = [];
  for (const state of states) {
    const target = state.target;
    const direct = target.kind === "memory" && target.id === request.memoryId ||
      target.kind === "session" && wholeSession && target.id === request.sessionId ||
      target.kind === "observation" && target.sessionId === request.sessionId && (wholeSession || observations.has(target.id));
    let relatedGraph = false;
    if (!direct && request.sessionId && target.kind !== "session" && target.kind !== "observation") {
      const address = archiveTargetAddress(target);
      const row = await kv.get<Record<string, unknown>>(address.scope, target.id, { includeDeleted: true });
      const sources = row?.sessionIds ?? row?.sourceSessionIds;
      const hasSession = Array.isArray(sources) && sources.includes(request.sessionId);
      if (hasSession && wholeSession && row?.project === undefined && !["graph_node", "graph_edge"].includes(target.kind)) {
        throw Error(`Forget would remove required archive ownership provenance for ${target.kind}:${target.id}; review this dependent target first`);
      }
      relatedGraph = ["graph_node", "graph_edge"].includes(target.kind) && hasSession &&
        (wholeSession || !Array.isArray(row?.sourceObservationIds) || row.sourceObservationIds.some(id => observations.has(String(id))));
    }
    if (!direct && !relatedGraph) continue;
    selected.push(state);
  }
  return prepareArchiveRemoval(kv, selected, request.project, "mem::forget");
}

export async function prepareArchiveTargetForget(kv: StateKV, targets: ArchiveTarget[], project: string | undefined, actor: string) {
  const selected: ArchiveState[] = [];
  const addresses = new Map(targets.map(target => { const address = archiveTargetAddress(target); return [address.key, address]; }));
  const entries = [...addresses.values()];
  for (let offset = 0; offset < entries.length; offset += 8) {
    const batch = entries.slice(offset, offset + 8);
    const states = await Promise.all(batch.map(address => kv.get<ArchiveState>(KV.archiveStates, address.key)));
    states.forEach((state, index) => {
      if (!state) return;
      const validated = validateArchiveState(state);
      if (validated.id !== batch[index].key) throw Error("Archive metadata does not match the requested target");
      selected.push(validated);
    });
  }
  return prepareArchiveRemoval(kv, selected, project, actor);
}

async function prepareArchiveRemoval(kv: StateKV, selected: ArchiveState[], project: string | undefined, actor: string) {
  for (const state of selected) {
    if (!project || project === "*" || project !== state.project) throw Error("Forgetting archive targets requires their exact project");
    if (state.importPendingDigest) throw Error("Archive import recovery must finish before forgetting this target");
    const address = archiveTargetAddress(state.target);
    const row = await kv.get<Record<string, unknown>>(address.scope, state.target.id, { includeDeleted: true });
    if (row?.deleted === true && state.target.kind === "lesson") {
      await assertArchiveTargetOwnership(kv, state.target, row, project);
    } else if (row) await readOwnedArchiveTarget(kv, state.target, address.scope, state.project);
  }
  return Object.assign(async (target?: ArchiveTarget) => {
    const key = target ? archiveTargetAddress(target).key : undefined;
    let removed = 0;
    for (const state of selected) {
      if (key && state.id !== key) continue;
      const address = archiveTargetAddress(state.target);
      const row = await kv.get<Record<string, unknown>>(address.scope, state.target.id, { includeDeleted: true });
      if (row && !(state.target.kind === "lesson" && row.deleted === true)) continue;
      if (row) await assertArchiveTargetOwnership(kv, state.target, row, state.project);
      const current = await kv.get<ArchiveState>(KV.archiveStates, state.id);
      if (!current) continue;
      const validated = validateArchiveState(current);
      if (validated.project !== state.project || validated.revision !== state.revision || validated.importPendingDigest) throw Error("Archive state changed during forget; inspect before retrying");
      await recordAudit(kv, "forget", actor, [state.target.id], {
        project: state.project, target: state.target, archiveRevision: state.revision,
        phase: "remove_archive_metadata_after_original_delete",
      });
      await kv.delete(KV.archiveStates, state.id);
      removed++;
    }
    return removed;
  }, { targets: selected.map(state => ({ target: state.target, project: state.project, revision: state.revision })) });
}
