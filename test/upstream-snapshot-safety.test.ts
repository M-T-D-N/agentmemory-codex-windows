import { describe, it, expect, vi } from "vitest";
import { mockKV } from "./helpers/mocks.js";
import { persistGraphDelta } from "../src/functions/graph.js";
import { paginateFromSnapshot } from "../src/functions/graph-query-index.js";
import { KV } from "../src/state/schema.js";
import type { GraphNode, GraphSnapshot } from "../src/types.js";

vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

function snapshot(totalNodes = 40000): GraphSnapshot {
  return { version: 1, topNodes: [], topEdges: [], topDegrees: {},
    stats: { totalNodes, totalEdges: 0, nodesByType: { concept: totalNodes }, edgesByType: {} },
    updatedAt: "2026-01-01T00:00:00Z", dirty: false };
}
function node(id: string): GraphNode {
  return { id, type: "concept", name: id, properties: {}, sourceObservationIds: [], sourceSessionIds: [],
    createdAt: "2026-09-30T00:00:00Z", updatedAt: "2026-09-30T00:00:00Z" };
}

describe("upstream snapshot write safety (#1384)", () => {
  it("aborts persistent read failure before any graph or index write", async () => {
    const kv = mockKV(); const original = snapshot();
    await kv.set(KV.graphSnapshot, "current", original);
    const realGet = kv.get.bind(kv);
    const get = vi.spyOn(kv, "get").mockImplementation(async (scope, key) => {
      if (scope === KV.graphSnapshot) throw Error("state::get timeout");
      return realGet(scope, key);
    });
    const writes = vi.spyOn(kv, "set");
    await expect(persistGraphDelta(kv as never, [node("new")], [], [])).rejects.toThrow("state::get timeout");
    expect(get).toHaveBeenCalledTimes(2);
    expect(writes).not.toHaveBeenCalled();
    expect(kv.store.get(KV.graphSnapshot)?.get("current")).toEqual(original);
    expect(kv.store.get(KV.graphNodes)).toBeUndefined();
  });

  it("retries one transient read failure and preserves existing totals", async () => {
    const kv = mockKV(); await kv.set(KV.graphSnapshot, "current", snapshot());
    const realGet = kv.get.bind(kv); let failed = false;
    vi.spyOn(kv, "get").mockImplementation(async (scope, key) => {
      if (scope === KV.graphSnapshot && !failed) { failed = true; throw Error("temporary"); }
      return realGet(scope, key);
    });
    expect(await persistGraphDelta(kv as never, [node("new")], [], [])).toMatchObject({ newNodeCount: 1 });
    expect(await kv.get(KV.graphSnapshot, "current")).toMatchObject({ stats: { totalNodes: 40001 } });
  });

  it.each([2, 0, undefined])("preserves an existing unknown schema %s without writes", async (version) => {
    const kv = mockKV(); const original = { ...snapshot(), version };
    await kv.set(KV.graphSnapshot, "current", original); const writes = vi.spyOn(kv, "set");
    await expect(persistGraphDelta(kv as never, [node("new")], [], [])).rejects.toThrow("unknown schema version");
    expect(writes).not.toHaveBeenCalled();
    expect(await kv.get(KV.graphSnapshot, "current")).toEqual(original);
  });

  it("accepts a genuinely absent snapshot on first write", async () => {
    const kv = mockKV();
    await persistGraphDelta(kv as never, [node("first")], [], []);
    expect(await kv.get(KV.graphSnapshot, "current")).toMatchObject({ version: 1, stats: { totalNodes: 1 } });
  });
});

describe("snapshot pagination total floor (#1385)", () => {
  it.each([undefined, "concept"])("does not report fewer nodes than the retained %s inventory", (filter) => {
    const snap = snapshot(1); snap.topNodes = [node("a"), node("b"), node("c")];
    const before = structuredClone(snap);
    const page = paginateFromSnapshot(snap, filter, 2, 0);
    expect(page).toMatchObject({ totalNodes: 3, truncated: true, fromSnapshot: true });
    expect(page.nodes).toHaveLength(2);
    expect(paginateFromSnapshot(snap, filter, 2, 2)).toMatchObject({ totalNodes: 3, truncated: false });
    expect(snap).toEqual(before);
  });

  it("preserves a valid larger total and does not invent a type count", () => {
    const snap = snapshot(); snap.topNodes = [node("a")];
    expect(paginateFromSnapshot(snap, undefined, 5, 0)).toMatchObject({ totalNodes: 40000, truncated: true });
    expect(paginateFromSnapshot(snap, "file", 5, 0)).toMatchObject({ totalNodes: 0, nodes: [], truncated: false });
  });
});
