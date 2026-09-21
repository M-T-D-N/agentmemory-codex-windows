import { describe, expect, it } from "vitest";
import { StateKV } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";
import { mockKV } from "./helpers/mocks.js";
import { archiveTargetAddress, changeArchiveState, readArchiveVisibility, validateArchiveState } from "../src/functions/archive.js";
import { createSearchCandidateSelection } from "../src/functions/search-candidates.js";
import { withObservationWrite } from "../src/state/observation-write.js";
import type { ArchiveRequest } from "../src/functions/archive.js";
import { registerSmartSearchFunction } from "../src/functions/smart-search.js";
import { GraphRetrieval } from "../src/functions/graph-retrieval.js";

async function fixture() {
  const backing = mockKV();
  let uncertain = false;
  const sdk = { async trigger({ function_id, payload }: any): Promise<any> {
    if (function_id === "state::list_groups") return { groups: [...backing.store.keys()] };
    if (function_id === "state::get") return structuredClone(await backing.get(payload.scope, payload.key));
    if (function_id === "state::list") return structuredClone(await backing.list(payload.scope));
    if (function_id === "state::set") {
      const value = await backing.set(payload.scope, payload.key, structuredClone(payload.value));
      if (uncertain && payload.scope === KV.archiveStates) { uncertain = false; throw Error("timeout after archive commit"); }
      return structuredClone(value);
    }
    if (function_id === "state::delete") return backing.delete(payload.scope, payload.key);
    throw Error("Unexpected state function: " + function_id);
  } };
  const session = { id: "s", project: "p", cwd: "/p", status: "completed", startedAt: "2026-09-13T00:00:00Z", observationCount: 1 };
  const observation = { id: "o", sessionId: "s", title: "decision", narrative: "preserved content", facts: [], concepts: [], files: [], importance: 1,
    timestamp: session.startedAt, type: "decision", imageRef: "image-ref", sourceObservationIds: ["prior"] };
  const memory = { id: "m", project: "p", title: "decision", content: "preserved memory", concepts: [], files: [], sessionIds: ["s"],
    version: 4, isLatest: true, supersedes: ["m-old"], sourceObservationIds: ["o"], imageRef: "image-ref", createdAt: session.startedAt, updatedAt: session.startedAt, strength: 1 };
  await backing.set(KV.sessions, "s", session);
  await backing.set(KV.observations("s"), "o", observation);
  await backing.set(KV.memories, "m", memory);
  await backing.set(KV.imageRefs, "image-ref", { id: "image-ref", count: 2 });
  return { kv: new StateKV(sdk as never), sdk, backing, session, observation, memory, failAfterCommit() { uncertain = true; } };
}
const request: ArchiveRequest = { project: "p", target: { kind: "memory", id: "m" }, action: "archive" };
async function apply(kv: StateKV, input: ArchiveRequest = request) {
  const preview = await changeArchiveState(kv, input);
  const accepted = { ...input, dryRun: false, expectedRevision: preview.expectedRevision, expectedDigest: preview.expectedDigest, reason: "reviewed lifecycle candidate" };
  return { result: await changeArchiveState(kv, accepted), accepted };
}

describe("canonical reversible archive lifecycle", () => {
  it("hides archived graph nodes without removing their relationships or source records", async () => {
    const f = await fixture();
    const node = { id: "node", project: "p", name: "Known", type: "concept", sourceObservationIds: ["o"], sourceSessionIds: ["s"], properties: {}, createdAt: f.session.startedAt };
    await f.backing.set(KV.graphNodes, node.id, node);
    await f.backing.set(KV.graphNodes, "neighbor", { ...node, id: "neighbor", name: "Neighbor", sourceObservationIds: [] });
    const edge = { id: "link", project: "p", sourceNodeId: node.id, targetNodeId: "neighbor", type: "related_to", weight: 1,
      sourceObservationIds: ["o"], sourceSessionIds: ["s"], createdAt: node.createdAt };
    await f.backing.set(KV.graphEdges, edge.id, edge);
    const retrieval = new GraphRetrieval(f.kv);
    expect((await retrieval.searchByEntities(["Known"]))).toHaveLength(1);
    await apply(f.kv, { ...request, target: { kind: "graph_node", id: node.id } });
    expect(await retrieval.searchByEntities(["Known"])).toEqual([]);
    expect(await f.kv.get(KV.graphNodes, node.id)).toEqual(node);
    expect(await f.kv.get(KV.graphEdges, edge.id)).toEqual(edge);
    expect(await f.kv.get(KV.observations("s"), "o")).toEqual(f.observation);
    await apply(f.kv, { ...request, target: { kind: "graph_node", id: node.id }, action: "restore" });
    expect((await retrieval.searchByEntities(["Known"]))).toHaveLength(1);
  });

  it("previews without writing, preserves all canonical content and restores the same searchable ID", async () => {
    const f = await fixture();
    expect(await changeArchiveState(f.kv, request)).toMatchObject({ dryRun: true, changed: 1, state: "active", expectedRevision: 0 });
    expect(await f.kv.list(KV.archiveStates)).toEqual([]);
    expect(await f.kv.list(KV.audit)).toEqual([]);
    const handlers = new Map<string, Function>();
    registerSmartSearchFunction({ registerFunction(id: string, fn: Function) { handlers.set(id, fn); } } as never, f.kv, async () => []);
    const expand = () => handlers.get("mem::smart-search")!({ expandIds: ["m"], project: "p", trackAccess: false });
    expect((await expand()).results).toHaveLength(1);
    const first = await apply(f.kv);
    expect(first.result).toMatchObject({ changed: 1, archive: { state: "archived", revision: 1 } });
    expect((await expand()).results).toHaveLength(0);
    const candidates = [{ obsId: "m", sessionId: "s" }, { obsId: "o", sessionId: "s" }];
    expect(await createSearchCandidateSelection(f.kv, { project: "p" }).select(candidates, 10)).toEqual([candidates[1]]);
    expect(await changeArchiveState(f.kv, first.accepted)).toMatchObject({ changed: 0 });
    expect(await f.kv.get(KV.memories, "m")).toEqual(f.memory);
    expect(await f.kv.get(KV.observations("s"), "o")).toEqual(f.observation);
    expect(await f.kv.get(KV.imageRefs, "image-ref")).toEqual({ id: "image-ref", count: 2 });
    const restored = await apply(f.kv, { ...request, action: "restore" });
    expect(restored.result).toMatchObject({ changed: 1, archive: { state: "restored", revision: 2 } });
    expect((await expand()).results).toHaveLength(1);
    expect(await createSearchCandidateSelection(f.kv, { project: "p" }).select(candidates, 10)).toEqual(candidates);
    expect((await f.kv.list(KV.audit)).length).toBe(2);
  });

  it("keeps session observations hidden across another source write until explicit restoration", async () => {
    const f = await fixture();
    await apply(f.kv, { ...request, target: { kind: "session", id: "s" } });
    await f.kv.set(KV.observations("s"), "o", { ...f.observation, narrative: "updated from original source" });
    const visibility = await readArchiveVisibility(f.kv);
    expect(visibility({ kind: "observation", id: "o", sessionId: "s" })).toBe(true);
    expect(visibility({ kind: "memory", id: "m" })).toBe(false);
    expect(await createSearchCandidateSelection(f.kv, { project: "p" }).select([{ obsId: "o", sessionId: "s" }], 1)).toEqual([]);
  });

  it("refuses wrong projects, ambiguous semantic sources, malformed targets and deletion resurrection", async () => {
    const f = await fixture();
    await expect(changeArchiveState(f.kv, { ...request, project: "other" })).rejects.toThrow("ownership");
    await f.backing.set(KV.semantic, "sem", { id: "sem", fact: "fact", sourceSessionIds: ["s", "missing"] });
    await expect(changeArchiveState(f.kv, { ...request, target: { kind: "semantic", id: "sem" } })).rejects.toThrow("provenance");
    for (const target of [{ kind: "memory", id: "*" }, { kind: "observation", id: "o" }, { kind: "memory", id: "m", sessionId: "s" }]) {
      expect(() => archiveTargetAddress(target)).toThrow();
    }
    await apply(f.kv);
    await f.kv.delete(KV.memories, "m");
    await expect(changeArchiveState(f.kv, { ...request, action: "restore" })).rejects.toThrow("missing or intentionally deleted");
    expect(await f.kv.get(KV.memories, "m")).toBeNull();
  });

  it("rejects stale target previews and concurrent writers without applying the archive", async () => {
    const f = await fixture();
    const preview = await changeArchiveState(f.kv, request);
    await f.kv.set(KV.memories, "m", { ...f.memory, content: "new decision" });
    await expect(changeArchiveState(f.kv, { ...request, dryRun: false, expectedRevision: preview.expectedRevision,
      expectedDigest: preview.expectedDigest, reason: "old preview" })).rejects.toThrow("stale");
    await expect(withObservationWrite(() => changeArchiveState(f.kv, request))).rejects.toThrow("writers are active");
    expect(await f.kv.list(KV.archiveStates)).toEqual([]);
  });

  it("recovers a committed-but-unacknowledged request by reading canonical state after restart", async () => {
    const f = await fixture();
    const preview = await changeArchiveState(f.kv, request);
    const accepted = { ...request, dryRun: false, expectedRevision: preview.expectedRevision, expectedDigest: preview.expectedDigest, reason: "reviewed" };
    f.failAfterCommit();
    await expect(changeArchiveState(f.kv, accepted)).rejects.toThrow("timeout after archive commit");
    const restarted = new StateKV(f.sdk as never);
    expect(await changeArchiveState(restarted, accepted)).toMatchObject({ changed: 0, archive: { state: "archived", revision: 1 } });
    expect((await restarted.list(KV.audit)).length).toBe(1);
    const state = (await restarted.list(KV.archiveStates))[0];
    expect(() => validateArchiveState({ ...state as object, content: "unexpected copied payload" })).toThrow();
  });
});
