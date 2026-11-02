import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/config.js", async original => ({
  ...await original<typeof import("../src/config.js")>(), isGraphExtractionEnabled: () => true,
}));

import { GRAPH_WRITE_LOCK, persistGraphDelta, registerGraphFunction } from "../src/functions/graph.js";
import { keyedLockBusy } from "../src/state/keyed-mutex.js";
import { KV } from "../src/state/schema.js";
import type { GraphNode, GraphEdge, GraphSnapshot, GraphQueryResult, MemoryProvider } from "../src/types.js";

function clone<T>(value: T): T {
  return value === null || value === undefined
    ? value
    : (JSON.parse(JSON.stringify(value)) as T);
}

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  let gate: {
    scope: string;
    key: string;
    release: () => void;
    promise: Promise<void>;
  } | null = null;
  let listGate: { scope: string; release: () => void; promise: Promise<void> } | null = null;

  return {
    store,
    armListGate: (scope: string) => {
      let release!: () => void;
      const promise = new Promise<void>((res) => {
        release = res;
      });
      listGate = { scope, release, promise };
      return release;
    },
    armGetGate: (scope: string, key: string) => {
      let release!: () => void;
      const promise = new Promise<void>((res) => {
        release = res;
      });
      gate = { scope, key, release, promise };
      return release;
    },
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      const value = clone((store.get(scope)?.get(key) as T) ?? null);
      if (gate && gate.scope === scope && gate.key === key) {
        const g = gate;
        gate = null;
        await g.promise;
      }
      return value;
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      const stored = clone(data);
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, stored);
      return clone(stored);
    },
    delete: async (scope: string, key: string) => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const m = store.get(scope);
      const values = m ? clone(Array.from(m.values()) as T[]) : [];
      if (listGate && listGate.scope === scope) {
        const g = listGate;
        listGate = null;
        await g.promise;
      }
      return values;
    },
  };
}

function node(overrides: Partial<GraphNode> & { id: string; name: string }): GraphNode {
  return {
    type: "file",
    properties: {},
    sourceObservationIds: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

async function flush() {
  await new Promise((r) => setTimeout(r, 0));
}

describe("persistGraphDelta concurrent merges (finding 7)", () => {
  it("does not create duplicate nodes when two concurrent extractions resolve the same (type, name) key", async () => {
    const kv = mockKV();

    const nameIndexKey = "file|src/index.ts";
    const releaseNameIndexRead = kv.armGetGate(KV.graphNameIndex, nameIndexKey);

    const nodeA = node({
      id: "node_a",
      name: "src/index.ts",
      sourceObservationIds: ["obs_a"],
    });
    const promiseA = persistGraphDelta(kv as never, [nodeA], [], ["obs_a"]);

    await flush();

    const nodeB = node({
      id: "node_b",
      name: "src/index.ts",
      sourceObservationIds: ["obs_b"],
    });
    const promiseB = persistGraphDelta(kv as never, [nodeB], [], ["obs_b"]);

    await flush();
    releaseNameIndexRead();

    await Promise.all([promiseA, promiseB]);

    const allNodes = await kv.list<GraphNode>(KV.graphNodes);
    expect(allNodes.length).toBe(1);

    const merged = allNodes[0];
    expect(merged.sourceObservationIds.sort()).toEqual(["obs_a", "obs_b"]);

    const snapshot = (await kv.get<GraphSnapshot>(
      KV.graphSnapshot,
      "current",
    )) as GraphSnapshot;
    expect(snapshot.stats.totalNodes).toBe(1);
  });

  it("does not lose either batch's obsIds when merging into an existing node concurrently", async () => {
    const kv = mockKV();

    const existing: GraphNode = node({
      id: "node_existing",
      name: "src/utils.ts",
      sourceObservationIds: ["obs_seed"],
    });
    await kv.set(KV.graphNodes, "node_existing", existing);
    await kv.set(KV.graphNameIndex, "file|src/utils.ts", "node_existing");
    await kv.set(KV.graphNodeDegree, "node_existing", 0);
    await kv.set(KV.graphSnapshot, "current", {
      version: 1,
      topNodes: [existing],
      topEdges: [],
      topDegrees: {},
      stats: {
        totalNodes: 1,
        totalEdges: 0,
        nodesByType: { file: 1 },
        edgesByType: {},
      },
      updatedAt: new Date().toISOString(),
      dirty: false,
    } satisfies GraphSnapshot);

    const releaseExistingNodeRead = kv.armGetGate(KV.graphNodes, "node_existing");

    const nodeA = node({
      id: "node_a2",
      name: "src/utils.ts",
      sourceObservationIds: ["obs_x"],
    });
    const promiseA = persistGraphDelta(kv as never, [nodeA], [], ["obs_x"]);

    await flush();

    const nodeB = node({
      id: "node_b2",
      name: "src/utils.ts",
      sourceObservationIds: ["obs_y"],
    });
    const promiseB = persistGraphDelta(kv as never, [nodeB], [], ["obs_y"]);

    await flush();
    releaseExistingNodeRead();

    await Promise.all([promiseA, promiseB]);

    const allNodes = await kv.list<GraphNode>(KV.graphNodes);
    expect(allNodes.length).toBe(1);
    expect(allNodes[0].sourceObservationIds.sort()).toEqual([
      "obs_seed",
      "obs_x",
      "obs_y",
    ]);
  });

  it("snapshot rebuild does not overwrite a delta that commits while it enumerates", async () => {
    const kv = mockKV();
    const handlers = new Map<string, (data?: unknown) => Promise<unknown>>();
    const sdk = {
      registerFunction: (id: string, fn: (data?: unknown) => Promise<unknown>) => {
        handlers.set(id, fn);
      },
    };
    registerGraphFunction(sdk as never, kv as never, { name: "noop" } as never);

    const seeded = node({ id: "node_seed", name: "src/seed.ts" });
    await persistGraphDelta(kv as never, [seeded], [], ["obs_seed"]);

    const releaseNodeList = kv.armListGate(KV.graphNodes);
    const rebuild = handlers.get("mem::graph-snapshot-rebuild")!();
    await flush();

    const fresh = node({ id: "node_fresh", name: "src/fresh.ts" });
    const delta = persistGraphDelta(kv as never, [fresh], [], ["obs_fresh"]);
    await flush();
    releaseNodeList();

    const rebuilt = (await rebuild) as { success: boolean };
    await delta;

    expect(rebuilt.success).toBe(true);
    const snapshot = (await kv.get<GraphSnapshot>(
      KV.graphSnapshot,
      "current",
    )) as GraphSnapshot;
    expect(snapshot.stats.totalNodes).toBe(2);
    expect(snapshot.topNodes.map((n) => n.id).sort()).toEqual([
      "node_fresh",
      "node_seed",
    ]);
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function queryFixture(provider = { name: "noop" } as MemoryProvider) {
  const kv = mockKV();
  const handlers = new Map<string, (data?: unknown) => Promise<unknown>>();
  registerGraphFunction({ registerFunction: (id: string, handler: (data?: unknown) => Promise<unknown>) => {
    handlers.set(id, handler);
  } } as never, kv as never, provider);
  const nodes = ["a", "b"].map(id => node({ id, name: `fixture ${id}`, project: "p", properties: { version: "before" } }));
  const edges: GraphEdge[] = [{ id: "ab", type: "uses", sourceNodeId: "a", targetNodeId: "b", project: "p",
    weight: 1, properties: { version: "before" }, sourceObservationIds: [], createdAt: nodes[0].createdAt }];
  await persistGraphDelta(kv as never, nodes, edges, []);
  expect(await handlers.get("mem::graph-snapshot-rebuild")!({ force: true })).toMatchObject({ success: true });
  const query = (input: object = {}) => handlers.get("mem::graph-query")!({ project: "p", ...input }) as Promise<GraphQueryResult>;
  const list = vi.spyOn(kv, "list");
  const noEnumeration = () => expect(list.mock.calls.filter(([scope]) => [KV.graphNodes, KV.graphEdges].includes(scope))).toEqual([]);
  const addNode = () => persistGraphDelta(kv as never, [node({ id: "c", name: "fixture c", project: "p" })], [], []);
  return { kv, handlers, nodes, edges, query, noEnumeration, addNode };
}

function pausePublication(kv: ReturnType<typeof mockKV>) {
  const entered = deferred(), release = deferred(), set = kv.set;
  let armed = true;
  kv.set = async <T>(scope: string, key: string, value: T): Promise<T> => {
    const result = await set(scope, key, value);
    if (armed && scope === KV.graphQueryManifest && (value as { dirty?: boolean }).dirty) {
      armed = false;
      entered.resolve();
      await release.promise;
    }
    return result;
  };
  return { entered, release };
}

describe("graph query publication consistency", () => {
  afterEach(() => vi.useRealTimers());

  it("waits for a transient dirty publication and returns the complete indexed result", async () => {
    const f = await queryFixture(), gate = pausePublication(f.kv);
    const writer = f.addNode();
    await gate.entered.promise;
    let settled = false;
    const query = f.query().then(result => { settled = true; return result; });
    try {
      await flush();
      expect(settled).toBe(false);
      gate.release.resolve();
      await writer;
      const result = await query;
      expect(result).toMatchObject({ fromIndex: true, totalNodes: 3, totalEdges: 1 });
      expect(result.nodes.map(row => row.id).sort()).toEqual(["a", "b", "c"]);
      expect(result.fromSnapshot).toBeUndefined();
      expect(result.warning).toBeUndefined();
      f.noEnumeration();
    } finally { gate.release.resolve(); await writer; await query; }
  });

  it("rereads a snapshot when publication finishes between its snapshot and manifest reads", async () => {
    const f = await queryFixture(), entered = deferred(), release = deferred(), get = f.kv.get;
    let armed = true;
    f.kv.get = async <T>(scope: string, key: string): Promise<T | null> => {
      const value = await get<T>(scope, key);
      if (armed && scope === KV.graphSnapshot) {
        armed = false;
        entered.resolve();
        await release.promise;
      }
      return value;
    };
    const query = f.query();
    try {
      await entered.promise;
      await f.addNode();
      release.resolve();
      const result = await query;
      expect(result).toMatchObject({ fromIndex: true, totalNodes: 3 });
      expect(result.nodes.map(row => row.id).sort()).toEqual(["a", "b", "c"]);
      expect(result.fromSnapshot).toBeUndefined();
      f.noEnumeration();
    } finally { release.resolve(); await query; }
  });

  it.each([{}, { edgeLimit: 10 }])("discards mixed node and edge hydration before returning %j", async input => {
    const f = await queryFixture(), entered = deferred(), release = deferred(), get = f.kv.get;
    let armed = true;
    f.kv.get = async <T>(scope: string, key: string): Promise<T | null> => {
      if (armed && scope === KV.graphNodes && key === "b") {
        armed = false;
        entered.resolve();
        await release.promise;
      }
      return get<T>(scope, key);
    };
    const query = f.query(input);
    try {
      await entered.promise;
      await persistGraphDelta(f.kv as never,
        f.nodes.map(row => ({ ...row, properties: { version: "after" } })),
        f.edges.map(row => ({ ...row, properties: { version: "after" } })), []);
      release.resolve();
      const result = await query;
      expect(result).toMatchObject({ fromIndex: true, totalNodes: 2, totalEdges: 1 });
      expect(result.nodes.map(row => row.properties.version)).toEqual(["after", "after"]);
      expect(result.edges.map(row => row.properties?.version)).toEqual(["after"]);
      if ("edgeLimit" in input) expect(result.edgeInventoryExact).toBe(true);
      expect(result.warning).toBeUndefined();
      f.noEnumeration();
    } finally { release.resolve(); await query; }
  });

  it.each(["dirty", "missing"])("keeps a permanently %s index read-only and inexact", async state => {
    const f = await queryFixture();
    const manifest = await f.kv.get<Record<string, unknown>>(KV.graphQueryManifest, "current");
    if (state === "dirty") await f.kv.set(KV.graphQueryManifest, "current", { ...manifest, dirty: true });
    else await f.kv.delete(KV.graphQueryManifest, "current");
    const writes = vi.spyOn(f.kv, "set"), reads = vi.spyOn(f.kv, "get");
    const result = await f.query({ edgeLimit: 10 });
    expect(result).toMatchObject({ fromSnapshot: true, totalsExact: false, edgeInventoryExact: false });
    expect(result.fromIndex).toBeUndefined();
    expect(result.queryIndexRebuilt).toBeUndefined();
    expect(result.warning).toContain("without enumerating canonical graph state");
    expect(writes).not.toHaveBeenCalled();
    expect(reads.mock.calls.filter(([scope]) => scope === KV.graphQueryManifest).length).toBeLessThanOrEqual(3);
    f.noEnumeration();
  });

  it("rechecks publication after the final edge hydration, beyond the exact inventory check", async () => {
    const f = await queryFixture(), entered = deferred(), release = deferred(), get = f.kv.get;
    let edgeReads = 0;
    f.kv.get = async <T>(scope: string, key: string): Promise<T | null> => {
      if (scope === KV.graphEdges && ++edgeReads === 2) {
        entered.resolve();
        await release.promise;
      }
      return get<T>(scope, key);
    };
    const query = f.query({ edgeLimit: 10 });
    try {
      await entered.promise;
      await persistGraphDelta(f.kv as never, [], [{ ...f.edges[0], properties: { version: "after" } }], []);
      release.resolve();
      const result = await query;
      expect(result).toMatchObject({ fromIndex: true, edgeInventoryExact: true });
      expect(result.edges.map(row => row.properties?.version)).toEqual(["after"]);
      expect(result.edgeInventory?.map(row => row.properties?.version)).toEqual(["after"]);
      expect(result.warning).toBeUndefined();
      f.noEnumeration();
    } finally { release.resolve(); await query; }
  });

  it.each(["shard", "archive"])("preserves asynchronous %s read failures", async target => {
    const f = await queryFixture(), get = f.kv.get, list = f.kv.list;
    let archiveReads = 0;
    f.kv.get = async <T>(scope: string, key: string): Promise<T | null> => {
      if (target === "shard" && scope === KV.graphQueryDocuments) throw Error("Fixture shard unavailable");
      return get<T>(scope, key);
    };
    f.kv.list = async <T>(scope: string): Promise<T[]> => {
      if (target === "archive" && scope === KV.archiveStates && ++archiveReads === 2) throw Error("Fixture archive unavailable");
      return list<T>(scope);
    };
    await expect(f.query({ edgeLimit: 10 })).rejects.toThrow(`Fixture ${target} unavailable`);
  });

  it("bounds a stalled publication without leaving a waiter or scheduled retry", async () => {
    const f = await queryFixture(), gate = pausePublication(f.kv);
    const writer = f.addNode();
    await gate.entered.promise;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const reads = vi.spyOn(f.kv, "get");
    const query = f.query();
    try {
      await vi.advanceTimersByTimeAsync(1000);
      const result = await query;
      expect(result).toMatchObject({ fromSnapshot: true, totalsExact: false });
      expect(result.fromIndex).toBeUndefined();
      expect(keyedLockBusy(GRAPH_WRITE_LOCK)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      const count = reads.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1000);
      expect(reads).toHaveBeenCalledTimes(count);
      f.noEnumeration();
    } finally {
      gate.release.resolve(); await writer; await vi.runAllTimersAsync(); await query;
    }
    expect(keyedLockBusy(GRAPH_WRITE_LOCK)).toBe(false);
    expect(await f.query()).toMatchObject({ fromIndex: true, totalNodes: 3 });
  });

  it("limits repeated publication churn to three full attempts", async () => {
    const f = await queryFixture(), get = f.kv.get;
    let changes = 0, changing = false;
    f.kv.get = async <T>(scope: string, key: string): Promise<T | null> => {
      const value = await get<T>(scope, key);
      if (!changing && scope === KV.graphNodes && key === "a") {
        changing = true;
        try {
          changes++;
          await persistGraphDelta(f.kv as never, [{ ...f.nodes[0], properties: { version: String(changes) } }], [], []);
        } finally { changing = false; }
      }
      return value;
    };
    const result = await f.query();
    expect(changes).toBe(3);
    expect(result).toMatchObject({ fromSnapshot: true, totalsExact: false });
    expect(result.fromIndex).toBeUndefined();
    expect(keyedLockBusy(GRAPH_WRITE_LOCK)).toBe(false);
    f.noEnumeration();
  });

  it("reads a clean index immediately while graph extraction waits for its model", async () => {
    const entered = deferred(), release = deferred();
    const provider = { name: "fixture", summarize: async () => "", compress: vi.fn(async () => {
      entered.resolve(); await release.promise;
      return "<entities></entities><relationships></relationships>";
    }) };
    const f = await queryFixture(provider);
    const extraction = f.handlers.get("mem::graph-extract")!({ observations: [{
      id: "obs_held", sessionId: "s", timestamp: "2026-09-13T00:00:00Z", type: "discovery",
      title: "Fixture", narrative: "Fixture", facts: [], files: [], concepts: [], importance: 5,
    }] });
    await entered.promise;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    let result: GraphQueryResult | undefined;
    const query = f.query().then(value => { result = value; return value; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(result).toMatchObject({ fromIndex: true, totalNodes: 2, totalEdges: 1 });
      expect(keyedLockBusy(GRAPH_WRITE_LOCK)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      f.noEnumeration();
    } finally {
      release.resolve(); await extraction; await vi.runAllTimersAsync(); await query;
    }
    expect(keyedLockBusy(GRAPH_WRITE_LOCK)).toBe(false);
  });
});
