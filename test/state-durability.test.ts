import { finishShutdown } from "../src/shutdown.js";
import { SearchIndex } from "../src/state/search-index.js";
import { IndexPersistence } from "../src/state/index-persistence.js";
import { describe, expect, it, vi } from "vitest";
import { changeArchiveState, archiveTargetAddress } from "../src/functions/archive.js";
import { StateKV } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";
import { applyGraphWritePlan, prepareGraphWritePlan, resumeGraphWritePlan } from "../src/state/graph-write-plan.js";

function fixture() {
  let rows = new Map<string, unknown>();
  const disk: Map<string, unknown>[] = [];
  let failFlush = 0;
  let loseArchiveAck = false;
  const address = (scope: string, key: string) => JSON.stringify([scope, key]);
  const trigger = vi.fn(async ({ function_id: id, payload: p }: any) => {
    if (id === "state::list_groups") return { groups: [] };
    if (id === "state::get") return rows.get(address(p.scope, p.key));
    if (id === "state::set") { rows.set(address(p.scope, p.key), structuredClone(p.value)); if (p.scope === KV.archiveStates && loseArchiveAck) { loseArchiveAck = false; throw Error("archive SET ACK lost"); } return p.value; }
    if (id === "state::delete") { rows.delete(address(p.scope, p.key)); return null; }
    if (id === "state::flush") {
      if (failFlush && disk.length + 1 === failFlush) throw Error("disk unavailable");
      disk.push(structuredClone(rows));
      return { durability: "file-flush-v1", flushedScopes: rows.size };
    }
    throw Error("Unexpected RPC: " + id);
  });
  return {
    kv: () => new StateKV({ trigger } as never, { requireDurability: true }),
    trigger, disk, address,
    loseArchiveAck() { loseArchiveAck = true; },
    failAt(n: number) { failFlush = n; },
    crash() { rows = structuredClone(disk.at(-1) ?? new Map()); failFlush = 0; },
    get(scope: string, key: string) { return rows.get(address(scope, key)); },
  };
}

describe("StateModule durability boundaries", () => {
  it("persists the final derived index before closing canonical writes and SDK transports", async () => {
    const f = fixture(), kv = f.kv(); let transportsClosed = false;
    const persistence = new IndexPersistence(kv, new SearchIndex(), null); persistence.stop();
    await finishShutdown([], () => persistence.save({ requireSuccess: true }),
      () => kv.closeWrites(), async () => { transportsClosed = true; });
    expect(transportsClosed).toBe(true);
    expect(f.disk.at(-1)?.get(f.address(KV.bm25Index, "data:manifest"))).toMatchObject({ v: 1 });
    await expect(kv.set(KV.bm25Index, "late", {})).rejects.toThrow("closed for shutdown");
  });

  it("holds shutdown through the accepted mutation and final flush while refusing new mutations", async () => {
    const f = fixture(), kv = f.kv(); await kv.initializeObservationRecovery();
    let setDone!: () => void, flushDone!: () => void;
    const heldSet = new Promise<void>(resolve => { setDone = resolve; }), heldFlush = new Promise<void>(resolve => { flushDone = resolve; });
    const original = f.trigger.getMockImplementation()!;
    let flushes = 0;
    f.trigger.mockImplementation(async request => {
      if (request.function_id === "state::set") await heldSet;
      if (request.function_id === "state::flush" && ++flushes === 2) await heldFlush;
      return original(request);
    });
    const accepted = kv.set(KV.config, "accepted", { value: 1 });
    await vi.waitFor(() => expect(f.trigger.mock.calls.some(([r]) => r.function_id === "state::set")).toBe(true));
    let complete = false; const stopping = kv.closeWrites().then(() => { complete = true; });
    await expect(kv.set(KV.config, "late", { value: 2 })).rejects.toThrow("closed for shutdown");
    expect(complete).toBe(false); setDone(); await accepted;
    await vi.waitFor(() => expect(flushes).toBe(2)); expect(complete).toBe(false);
    flushDone(); await stopping; expect(f.get(KV.config, "accepted")).toEqual({ value: 1 });
    expect(f.get(KV.config, "late")).toBeUndefined(); expect(f.disk).toHaveLength(2);
  });

  it("does not report clean shutdown when its final durability barrier fails", async () => {
    const f = fixture(), kv = f.kv(); await kv.set(KV.config, "accepted", 1); f.failAt(2);
    await expect(kv.closeWrites()).rejects.toThrow("disk unavailable"); expect(kv.requiresWriteRecovery()).toBe(true);
  });

  it("still attempts a final flush after an earlier uncertain mutation, while retaining its recovery fence", async () => {
    const f = fixture(), kv = f.kv(); f.failAt(1);
    await expect(kv.set(KV.config, "accepted", 1)).rejects.toThrow("disk unavailable");
    expect(kv.requiresWriteRecovery()).toBe(true); f.failAt(0);
    await expect(kv.closeWrites()).rejects.toThrow("shutdown durability is unconfirmed");
    expect(f.disk).toHaveLength(1); expect(kv.requiresWriteRecovery()).toBe(true);
  });

  it("holds already queued writes after the first durability failure", async () => {
    const f = fixture(), kv = f.kv();
    await kv.initializeObservationRecovery();
    f.failAt(1);
    const outcomes = await Promise.allSettled(Array.from({ length: 16 }, (_, id) =>
      kv.set(KV.config, "queued-" + id, { value: id })));
    expect(outcomes.every(result => result.status === "rejected")).toBe(true);
    expect(f.trigger.mock.calls.filter(([request]) => request.function_id === "state::set")).toHaveLength(1);
    expect(kv.requiresWriteRecovery()).toBe(true);
    expect(f.disk).toHaveLength(0);
  });

  it.each([1, 2, 3, 4, 5, 6, 7])("recovers paged intents after flush %i fails without exposing partial assignments", async boundary => {
    const f = fixture(), kv = f.kv();
    const { plan } = await prepareGraphWritePlan(kv, async store => {
      await store.set(KV.graphQueryDocuments, "00", "x".repeat(1_100_000));
      await store.set(KV.graphNodeDegree, "n", 1);
    });
    f.failAt(boundary);
    await expect(applyGraphWritePlan(kv, plan)).rejects.toThrow("disk unavailable");
    expect(kv.requiresWriteRecovery()).toBe(true);
    f.crash();
    const restarted = f.kv();
    await resumeGraphWritePlan(restarted);
    if (await restarted.get(KV.graphNodeDegree, "n") === null) await applyGraphWritePlan(restarted, plan);
    expect(await restarted.get(KV.graphNodeDegree, "n")).toBe(1);
    expect(await restarted.get(KV.graphQueryDocuments, "00")).toBe(plan.writes[0].value);
    expect(await restarted.get(KV.graphWritePlan, "current")).toBeNull();
    expect(await restarted.get(KV.graphWritePlan, "page:0")).toBeNull();
  });

  it("does not acknowledge an ordinary write when disk confirmation fails", async () => {
    const f = fixture(), kv = f.kv(); f.failAt(1);
    await expect(kv.set(KV.config, "key", { value: 1 })).rejects.toThrow("disk unavailable");
    expect(kv.requiresWriteRecovery()).toBe(true);
    expect(f.disk).toHaveLength(0);
    await expect(kv.set(KV.config, "other", 2)).rejects.toThrow();
  });

  it("persists intent, all graph assignments, then intent removal in three flushes", async () => {
    const f = fixture(), kv = f.kv();
    const { plan } = await prepareGraphWritePlan(kv, async store => {
      await store.set(KV.graphNodes, "node", { id: "node", project: "test" });
      await store.set(KV.graphNodeDegree, "node", 1);
    });
    await applyGraphWritePlan(kv, plan);
    expect(f.disk).toHaveLength(3);
    const intent = f.address(KV.graphWritePlan, "current"), node = f.address(KV.graphNodes, "node");
    expect(f.disk[0].has(intent)).toBe(true);
    expect(f.disk[0].has(node)).toBe(false);
    expect(f.disk[1].has(intent)).toBe(true);
    expect(f.disk[1].get(node)).toEqual({ id: "node", project: "test" });
    expect(f.disk[1].get(f.address(KV.graphNodeDegree, "node"))).toBe(1);
    expect(f.disk[2].has(intent)).toBe(false);
    expect(f.disk[2].get(node)).toEqual(f.disk[1].get(node));
  });

  it("keeps a recoverable disk intent if committing graph assignments fails", async () => {
    const f = fixture(), kv = f.kv();
    const { plan } = await prepareGraphWritePlan(kv, async store => {
      await store.set(KV.graphNodes, "node", { id: "node", project: "test" });
    });
    f.failAt(2);
    await expect(applyGraphWritePlan(kv, plan)).rejects.toThrow("disk unavailable");
    expect(f.get(KV.graphWritePlan, "current")).toEqual(plan);
    expect(f.trigger.mock.calls.some(([r]) => r.function_id === "state::delete")).toBe(false);
    expect(kv.requiresWriteRecovery()).toBe(true);
    f.crash();
    const restarted = f.kv();
    expect(await resumeGraphWritePlan(restarted)).toEqual({ recovered: true, writes: 1 });
    expect(await restarted.get(KV.graphNodes, "node")).toEqual({ id: "node", project: "test" });
    expect(await resumeGraphWritePlan(restarted)).toEqual({ recovered: false, writes: 0 });
  });

  it.each([undefined, {}, { durability: "file-flush-v1", flushedScopes: -1 }, { durability: "in-memory", flushedScopes: 0 }])("rejects unsupported confirmation %j", async response => {
    const kv = new StateKV({ trigger: vi.fn().mockResolvedValue(response) } as never, { requireDurability: true });
    await expect(kv.flush()).rejects.toThrow("did not confirm");
    expect(kv.requiresWriteRecovery()).toBe(true);
  });
});


describe("archive SET acknowledgement durability", () => {
  it.each(["archive", "restore"] as const)("holds an uncertain %s retry until a fresh worker confirms disk", async action => {
    const f = fixture(), kv = f.kv();
    await kv.set(KV.memories, "mem_target", { id: "mem_target", project: "p", title: "target", content: "same original", concepts: [], files: [], sessionIds: [] });
    const target = { kind: "memory" as const, id: "mem_target" };
    const apply = async (worker: StateKV, action: "archive" | "restore") => {
      const preview = await changeArchiveState(worker, { target, project: "p", action });
      return { target, project: "p", action, dryRun: false, expectedRevision: preview.expectedRevision!, expectedDigest: preview.expectedDigest!, reason: "ACK test" };
    };
    if (action === "restore") await changeArchiveState(kv, await apply(kv, "archive"));
    const request = await apply(kv, action), flushes = f.disk.length;
    f.loseArchiveAck();
    await expect(changeArchiveState(kv, request)).rejects.toThrow("ACK lost");
    expect(kv.requiresWriteRecovery()).toBe(true);
    await expect(changeArchiveState(kv, request)).rejects.toThrow(/uncertain/);
    const restarted = f.kv();
    expect(await changeArchiveState(restarted, request)).toMatchObject({ success: true, changed: 0 });
    expect(f.disk.length).toBeGreaterThan(flushes);
    f.crash();
    expect(await f.kv().get(KV.archiveStates, archiveTargetAddress(target).key)).toMatchObject({ state: action === "archive" ? "archived" : "restored" });
  });
});
