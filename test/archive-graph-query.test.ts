import { describe, expect, it, vi } from "vitest";
import { mockKV, mockSdk } from "./helpers/mocks.js";
import { KV } from "../src/state/schema.js";
import { registerGraphFunction } from "../src/functions/graph.js";
import { changeArchiveState } from "../src/functions/archive.js";
import { GraphRetrieval } from "../src/functions/graph-retrieval.js";
import type { ArchiveTarget, GraphQueryResult } from "../src/types.js";

vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
async function fixture() {
  const kv = mockKV(), sdk = mockSdk({ looseTrigger: true });
  registerGraphFunction(sdk as never, kv as never, { name: "noop" } as never);
  const stamp = "2026-09-13T00:00:00Z";
  for (const id of ["a", "b", "c"]) await kv.set(KV.graphNodes, id, { id, project: "p", type: "concept", name: "Concept " + id,
    properties: {}, sourceSessionIds: ["s"], sourceObservationIds: ["o"], createdAt: stamp });
  for (const [id, sourceNodeId, targetNodeId] of [["ab", "a", "b"], ["bc", "b", "c"]]) await kv.set(KV.graphEdges, id, {
    id, sourceNodeId, targetNodeId, project: "p", type: "related_to", weight: 1, createdAt: stamp,
    sourceSessionIds: ["s"], sourceObservationIds: ["o"], isLatest: true });
  expect(await sdk.trigger("mem::graph-snapshot-rebuild", { force: true })).toMatchObject({ success: true });
  const originalNodes = structuredClone(await kv.list(KV.graphNodes)), originalEdges = structuredClone(await kv.list(KV.graphEdges));
  const change = async (target: ArchiveTarget, action: "archive" | "restore" = "archive") => {
    const preview = await changeArchiveState(kv as never, { target, project: "p", action });
    return changeArchiveState(kv as never, { target, project: "p", action, dryRun: false,
      expectedDigest: preview.expectedDigest, expectedRevision: preview.expectedRevision, reason: "Reviewed graph fixture" });
  };
  const query = (input: object = {}) => sdk.trigger("mem::graph-query", input) as Promise<GraphQueryResult>;
  return { kv, sdk, query, change, originalNodes, originalEdges };
}

describe("archive-aware graph query and traversal", () => {
  it("filters before paging, counts and traversal while retaining original graph provenance", async () => {
    const f = await fixture();
    await f.change({ kind: "graph_node", id: "b" });
    for (const input of [{}, { project: "p" }, { project: "*", query: "Concept" }]) {
      const first = await f.query({ ...input, limit: 1, edgeLimit: 1 });
      expect(first).toMatchObject({ totalNodes: 2, totalEdges: 0, edgeInventory: [], edgeInventoryExact: true, truncated: true });
      expect(first.nodes.map(row => row.id)).toEqual(["a"]);
      expect((await f.query({ ...input, limit: 1, offset: 1 })).nodes.map(row => row.id)).toEqual(["c"]);
    }
    expect(await f.query()).toMatchObject({ totalNodes: 2, totalEdges: 0 });
    const walk = await f.query({ project: "p", startNodeId: "a", maxDepth: 3, edgeLimit: 10 });
    expect(walk.nodes.map(row => row.id)).toEqual(["a"]);
    expect(walk.edgeInventory).toEqual([]);
    expect((await f.query({ project: "p", startNodeId: "b" })).nodes).toEqual([]);
    expect(await f.kv.list(KV.graphNodes)).toEqual(f.originalNodes);
    expect(await f.kv.list(KV.graphEdges)).toEqual(f.originalEdges);
    expect(await f.sdk.trigger("mem::graph-stats", {})).toMatchObject({ totalNodes: 3, totalEdges: 2, includesArchived: true });
    await f.change({ kind: "graph_node", id: "b" }, "restore");
    expect(await f.query({ project: "p", edgeLimit: 10 })).toMatchObject({ totalNodes: 3, totalEdges: 2, edgeInventoryExact: true });
  });
  it("excludes archived edges from indexed and temporal paths and changes the inventory revision on restore", async () => {
    const f = await fixture();
    const before = await f.query({ project: "p", edgeLimit: 1 });
    await f.change({ kind: "graph_edge", id: "ab" });
    const hidden = await f.query({ project: "p", edgeLimit: 1 });
    expect(hidden.edgeInventory?.map(row => row.id)).toEqual(["bc"]);
    expect(hidden).toMatchObject({ totalEdges: 1, edgeTruncated: false, edgeInventoryExact: true });
    expect(hidden.edgeInventoryRevision).not.toEqual(before.edgeInventoryRevision);
    expect((await f.query({ startNodeId: "a" })).nodes.map(row => row.id)).toEqual(["a"]);
    const temporal = new GraphRetrieval(f.kv as never);
    expect(await temporal.temporalQuery("Concept a")).toMatchObject({ currentState: [], history: [] });
    await f.change({ kind: "graph_edge", id: "ab" }, "restore");
    expect((await temporal.temporalQuery("Concept a")).currentState).toHaveLength(1);
    await f.change({ kind: "graph_node", id: "b" });
    expect((await temporal.temporalQuery("Concept a", "2026-09-14T00:00:00Z")).history).toEqual([]);
    expect((await temporal.temporalQuery("Concept b")).entity).toBeNull();
  });
  it("filters a bounded fallback snapshot and never enumerates original graph collections", async () => {
    const f = await fixture();
    await f.change({ kind: "graph_node", id: "b" });
    await f.kv.delete(KV.graphQueryManifest, "current");
    const list = f.kv.list;
    f.kv.list = async scope => {
      if ([KV.graphNodes, KV.graphEdges].includes(scope)) throw Error("Canonical enumeration forbidden");
      return list(scope);
    };
    for (const input of [{}, { project: "*" }, { query: "Concept" }, { startNodeId: "a" }]) {
      const result = await f.query(input);
      expect(result.fromSnapshot).toBe(true);
      expect(result.totalsExact).toBe(false);
      expect(result.warning).toContain("Zero matches");
      expect(result.nodes.map(row => row.id)).not.toContain("b");
      expect(result.edges).toEqual([]);
    }
  });
  it("marks edge pagination inexact when archive state changes during hydration", async () => {
    const f = await fixture(), get = f.kv.get;
    let changed = false;
    f.kv.get = async (scope, id) => {
      const value = await get(scope, id);
      if (!changed && scope === KV.graphEdges) {
        changed = true;
        await f.change({ kind: "graph_edge", id: "bc" });
      }
      return value;
    };
    const result = await f.query({ project: "p", edgeLimit: 1 });
    expect(result.edgeInventoryExact).toBe(false);
    expect(result.warning).toContain("retry this edge page");
  });
  it("does not use an unfiltered snapshot when reading archive state fails", async () => {
    const f = await fixture(), list = f.kv.list;
    f.kv.list = async scope => { if (scope === KV.archiveStates) throw Error("Archive unavailable"); return list(scope); };
    await expect(f.query()).rejects.toThrow("Archive unavailable");
  });
  it("reads lifecycle metadata once per query and once more only for exact edge stability", async () => {
    const f = await fixture(), list = f.kv.list;
    const scopes: string[] = [];
    f.kv.list = async scope => { scopes.push(scope); return list(scope); };
    await f.query({ project: "p" });
    expect(scopes).toEqual([KV.archiveStates]);
    scopes.length = 0;
    await f.query({ project: "p", edgeLimit: 1 });
    expect(scopes).toEqual([KV.archiveStates, KV.archiveStates]);
  });
});
