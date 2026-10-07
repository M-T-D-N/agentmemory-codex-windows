import { describe, expect, it, vi } from "vitest";
import { mockKV, mockSdk } from "./helpers/mocks.js";
import { registerMeshFunction } from "../src/functions/mesh.js";
import { registerTemporalGraphFunctions } from "../src/functions/temporal-graph.js";
import * as mutex from "../src/state/keyed-mutex.js";
import { registerGraphFunction } from "../src/functions/graph.js";
import { KV } from "../src/state/schema.js";

describe("other graph writers", () => {
  it.each(["mesh", "temporal"])("%s waits before its canonical read-modify-write", async kind => {
    const kv = { ...mockKV(), assertRecoveryImportAllowed() {} }; const sdk = mockSdk();
    registerMeshFunction(sdk as never, kv as never);
    registerTemporalGraphFunctions(sdk as never, kv as never, { name: "fixture", summarize: async () => "", compress: async () =>
      '<temporal_graph><entities><entity type="concept" name="decision"></entity></entities><relationships></relationships></temporal_graph>' });
    const locks = vi.spyOn(mutex, "withKeyedLock");
    const get = vi.spyOn(kv, "get"); const list = vi.spyOn(kv, "list");
    let release!: () => void;
    const held = mutex.withKeyedLock("mem:graph-write", () => new Promise<void>(resolve => { release = resolve; }));
    await Promise.resolve();
    const pending = kind === "mesh" ? sdk.trigger("mem::mesh-receive", { graphNodes: [{ id: "n", name: "decision", type: "concept",
      properties: {}, sourceObservationIds: [], createdAt: "2026-09-13T00:00:00Z" }] }) :
      sdk.trigger("mem::temporal-graph-extract", { observations: [{ id: "o", title: "decision", narrative: "decision", timestamp: "2026-09-13T00:00:00Z" }] });
    try {
      await vi.waitFor(() => expect(locks.mock.calls.filter(call => call[0] === "mem:graph-write")).toHaveLength(2));
      expect([...get.mock.calls, ...list.mock.calls].filter(call => call[0].startsWith("mem:graph:"))).toEqual([]);
    } finally { release(); await held; locks.mockRestore(); }
    expect(await pending).toMatchObject({ success: true });
    expect(await kv.list(KV.graphNodes)).toHaveLength(1);
  });
});

it.each(["mem::graph-extract", "mem::graph-snapshot-rebuild"])(
  "%s defers automatic work without queuing canonical reads or writes", async id => {
    const kv = mockKV(), sdk = mockSdk();
    registerGraphFunction(sdk as never, kv as never);
    const get = vi.spyOn(kv, "get"), list = vi.spyOn(kv, "list");
    let release!: () => void;
    const held = mutex.withKeyedLock("mem:graph-write", () => new Promise<void>(resolve => { release = resolve; }));
    await Promise.resolve();
    try {
      const result = await sdk.trigger(id, id === "mem::graph-extract"
        ? { deferIfBusy: true, observations: [] } : { onlyIfIndexUnavailable: true });
      expect(result).toEqual({ success: true, skipped: "graph_writer_busy" });
      expect(get).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled();
    } finally { release(); await held; }
    await Promise.resolve();
    expect(get).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled();
  },
);

it("retains writer ownership when a waiting caller abandons its response", async () => {
  let release!: () => void;
  const work = mutex.tryWithKeyedLock("caller-abandoned-fixture", () => new Promise<void>(resolve => { release = resolve; }));
  await Promise.resolve();
  try {
    await expect(Promise.race([work, Promise.reject(Error("caller timeout"))])).rejects.toThrow("caller timeout");
    const duplicate = vi.fn(async () => undefined);
    expect(await mutex.tryWithKeyedLock("caller-abandoned-fixture", duplicate)).toEqual({ acquired: false });
    expect(duplicate).not.toHaveBeenCalled();
  } finally { release(); await work; }
  expect(await mutex.tryWithKeyedLock("caller-abandoned-fixture", async () => "resumed")).toEqual({ acquired: true, value: "resumed" });
});
