import { describe, expect, it, vi } from "vitest";
import { mockKV } from "./helpers/mocks.js";
import { applyGraphWritePlan, prepareGraphWritePlan, resumeGraphWritePlan, validateGraphWritePlan } from "../src/state/graph-write-plan.js";
import { KV } from "../src/state/schema.js";
import { persistGraphDelta, registerGraphFunction } from "../src/functions/graph.js";
import { registerArchiveFunctions } from "../src/functions/archive-tools.js";
import { archiveTargetAddress } from "../src/functions/archive.js";
import { registerRememberFunction } from "../src/functions/remember.js";
import type { GraphEdge, GraphNode, GraphSnapshot } from "../src/types.js";
import { StateKV } from "../src/state/kv.js";
import { registerApiTriggers } from "../src/triggers/api.js";

function engine() {
  const backing = mockKV();
  const functions = new Map<string, (data: any) => Promise<unknown>>();
  let failScope = "";
  let paused: { scope: string; entered: () => void; wait: Promise<void> } | undefined;
  const sdk = {
    registerFunction(id: string, handler: (data: any) => Promise<unknown>) { functions.set(id, handler); },
    registerTrigger() {},
    async trigger({ function_id, payload: p }: { function_id: string; payload: any }): Promise<any> {
    if (function_id === "state::list_groups") return { groups: [...backing.store.keys()] };
    if (function_id === "state::get") return structuredClone(await backing.get(p.scope, p.key));
    if (function_id === "state::list") return structuredClone(await backing.list(p.scope));
    if (function_id === "state::set") {
      await backing.set(p.scope, p.key, structuredClone(p.value));
      if (p.scope === paused?.scope) { const current = paused; paused = undefined; current.entered(); await current.wait; }
      if (p.scope === failScope) { failScope = ""; throw Error("lost acknowledgement"); }
      return structuredClone(p.value);
    }
    if (function_id === "state::delete") {
      await backing.delete(p.scope, p.key);
      if (p.scope === failScope) { failScope = ""; throw Error("lost acknowledgement"); }
      return;
    }
    if (functions.has(function_id)) return functions.get(function_id)!(p);
    throw Error(`Unexpected ${function_id}`);
  } };
  return { backing, sdk, fresh: () => new StateKV(sdk as never), fail: (scope: string) => { failScope = scope; },
    pause(scope: string) {
      let entered!: () => void; let release!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const wait = new Promise<void>(resolve => { release = resolve; });
      paused = { scope, entered, wait }; return { started, release };
    } };
}

async function prepare(kv: ReturnType<typeof mockKV>) {
  return prepareGraphWritePlan(kv, async store => {
    await store.set(KV.graphNodes, "n", { id: "n", properties: { description: "verified" } });
    await store.set(KV.graphNameIndex, "project|type|name", "n");
    const degree = (await store.get<number>(KV.graphNodeDegree, "n")) ?? 0;
    await store.set(KV.graphNodeDegree, "n", degree + 1);
    await store.set(KV.graphSnapshot, "current", { stats: { totalNodes: 1, totalEdges: 0 } });
    return "prepared";
  });
}

describe("materialized graph assignments", () => {
  it("reports a write-only failure to the existing liveness supervisor without probing or mutating state", async () => {
    const f = engine(), kv = f.fresh();
    registerApiTriggers(f.sdk as never, kv, async () => ({ context: "", blocks: 0, tokens: 0 }), undefined, undefined, undefined, undefined,
      () => ({ status: "attention", discoveryIssues: 2 }));
    const livez = () => f.sdk.trigger({ function_id: "api::liveness", payload: {} });
    const trigger = vi.spyOn(f.sdk, "trigger");
    expect(await livez()).toMatchObject({ status_code: 200, body: { status: "ok", writeRecoveryRequired: false,
      nativeCapture: { status: "attention", discoveryIssues: 2 } } });
    expect(trigger).toHaveBeenCalledTimes(1);
    f.fail(KV.sessions);
    await expect(kv.set(KV.sessions, "s", { id: "s" })).rejects.toThrow("lost acknowledgement");
    trigger.mockClear();
    expect(await livez()).toMatchObject({ body: { status: "ok", writeRecoveryRequired: true } });
    expect(trigger).toHaveBeenCalledTimes(1);
    const restarted = f.fresh();
    await restarted.initializeObservationRecovery();
    expect(restarted.requiresWriteRecovery()).toBe(false);
    expect(await restarted.get(KV.sessions, "s")).toEqual({ id: "s" });
    trigger.mockRestore();
  });
  it("distinguishes a healthy in-flight graph plan from an abandoned conflicting plan", async () => {
    const f = engine(), kv = f.fresh(), { plan } = await prepare(f.backing);
    const hold = f.pause(KV.graphWritePlan);
    const applying = applyGraphWritePlan(kv, plan);
    await hold.started;
    expect(kv.requiresWriteRecovery()).toBe(false);
    // A competing canonical value makes the remaining plan unsafe to apply.
    await f.backing.set(KV.graphNodes, "n", { id: "n", description: "conflicting original" });
    hold.release();
    await expect(applying).rejects.toThrow("conflicts with canonical state");
    expect(kv.requiresWriteRecovery()).toBe(true);
    expect(await f.backing.get(KV.graphWritePlan, "current")).not.toBeNull();
    await expect(resumeGraphWritePlan(f.fresh())).rejects.toThrow("conflicts with canonical state");
  });
  it("keeps a successful graph plan healthy through application and completion", async () => {
    const f = engine(), kv = f.fresh(), { plan } = await prepare(f.backing);
    const hold = f.pause(KV.graphNodes), applying = applyGraphWritePlan(kv, plan);
    await hold.started;
    expect(kv.requiresWriteRecovery()).toBe(false);
    hold.release(); await applying;
    expect(kv.requiresWriteRecovery()).toBe(false);
    expect(await f.backing.get(KV.graphWritePlan, "current")).toBeNull();
  });
  it("surfaces a failed one-time graph recovery initialization instead of remaining falsely healthy", async () => {
    const f = engine(), kv = f.fresh(), trigger = f.sdk.trigger.bind(f.sdk);
    vi.spyOn(f.sdk, "trigger").mockImplementationOnce(async () => { throw Error("state unavailable"); });
    await expect(kv.get(KV.graphNodes, "n")).rejects.toThrow("state unavailable");
    expect(kv.requiresWriteRecovery()).toBe(true);
    vi.mocked(f.sdk.trigger).mockRestore();
    expect(await trigger({ function_id: "state::get", payload: { scope: KV.graphWritePlan, key: "current" } })).toBeNull();
    expect(f.fresh().requiresWriteRecovery()).toBe(false);
  });
  it("recovers registered forget's graph changes before retrying source deletion and retains independent archived knowledge", async () => {
    const f = engine(), kv = f.fresh();
    registerGraphFunction(f.sdk as never, kv, { name: "noop" } as never);
    registerArchiveFunctions(f.sdk as never, kv); registerRememberFunction(f.sdk as never, kv);
    const call = (function_id: string, payload: object) => f.sdk.trigger({ function_id, payload });
    for (const id of ["s1", "s2"]) {
      await kv.set(KV.sessions, id, { id, project: "p", agentId: "test", observationCount: 1, startedAt: "2026-01-01T00:00:00Z" });
      await kv.set(KV.observations(id), "o-" + id, { id: "o-" + id, sessionId: id, title: "source", narrative: "source evidence", timestamp: "2026-01-01T00:00:00Z" });
    }
    const graph = await call("mem::graph-upsert", { project: "p", sources: [{ sessionId: "s1", observationIds: ["o-s1"] }],
      nodes: [{ key: "a", type: "project", name: "Shared project" }, { key: "b", type: "decision", name: "Only first source" }],
      edges: [{ source: "a", target: "b", type: "uses" }] });
    await call("mem::graph-upsert", { project: "p", sources: [{ sessionId: "s2", observationIds: ["o-s2"] }],
      nodes: [{ key: "a", type: "project", name: "Shared project" }], edges: [] });
    for (const id of [graph.nodeIds.a, graph.nodeIds.b]) {
      const target = { kind: "graph_node", id }, preview = await call("mem::archive", { action: "archive", project: "p", target });
      await call("mem::archive", { action: "archive", project: "p", target, dryRun: false, expectedRevision: preview.expectedRevision,
        expectedDigest: preview.expectedDigest, reason: "Reviewed" });
    }
    const request = { project: "p", sessionId: "s1", observationIds: ["o-s1"] };
    f.fail(KV.graphNodes);
    await expect(call("mem::forget", request)).rejects.toThrow("lost acknowledgement");
    expect(await f.backing.get(KV.observations("s1"), "o-s1")).not.toBeNull();
    expect(await f.backing.get(KV.graphWritePlan, "current")).toMatchObject({ version: 2 });
    const restarted = f.fresh(); await resumeGraphWritePlan(restarted);
    expect(await restarted.get(KV.graphNodes, graph.nodeIds.b)).toBeNull();
    expect(await restarted.get(KV.graphNodes, graph.nodeIds.a)).toMatchObject({ sourceSessionIds: ["s2"], sourceObservationIds: ["o-s2"] });
    expect(await restarted.list(KV.archiveStates)).toMatchObject([{ target: { id: graph.nodeIds.a } }]);
    registerGraphFunction(f.sdk as never, restarted, { name: "noop" } as never);
    registerRememberFunction(f.sdk as never, restarted); registerArchiveFunctions(f.sdk as never, restarted);
    expect(await call("mem::forget", request)).toMatchObject({ success: true, deleted: 1 });
    expect(await restarted.get(KV.observations("s1"), "o-s1")).toBeNull();
    expect(await restarted.get(KV.observations("s2"), "o-s2")).not.toBeNull();
    const target = { kind: "graph_node", id: graph.nodeIds.a }, preview = await call("mem::archive", { action: "restore", project: "p", target });
    await call("mem::archive", { action: "restore", project: "p", target, dryRun: false, expectedRevision: preview.expectedRevision,
      expectedDigest: preview.expectedDigest, reason: "Still supported by the second source" });
    expect(await call("mem::graph-query", { project: "p" })).toMatchObject({ totalNodes: 1, nodes: [{ id: graph.nodeIds.a, sourceSessionIds: ["s2"] }] });
  });
  it("prepares actual deletions without saving deleted bodies and resumes a lost delete acknowledgement", async () => {
    const f = engine(), kv = f.fresh();
    await kv.set(KV.graphNodes, "n", { id: "n", project: "p", description: "removed original body" });
    const archiveKey = archiveTargetAddress({ kind: "graph_node", id: "n" }).key;
    await kv.set(KV.archiveStates, archiveKey, { id: archiveKey, target: { kind: "graph_node", id: "n" } });
    const prepared = await prepareGraphWritePlan(kv, async store => {
      await store.delete(KV.graphNodes, "n");
      expect(await store.get(KV.graphNodes, "n")).toBeNull();
      await store.delete(KV.archiveStates, archiveKey);
      await store.set(KV.graphSnapshot, "current", { stats: { totalNodes: 0, totalEdges: 0 } });
    });
    expect(prepared.plan.version).toBe(2);
    expect(JSON.stringify(prepared.plan)).not.toContain("removed original body");
    f.fail(KV.graphNodes);
    await expect(applyGraphWritePlan(kv, prepared.plan)).rejects.toThrow("lost acknowledgement");
    expect(await f.backing.get(KV.graphNodes, "n")).toBeNull();
    expect(await f.backing.get(KV.archiveStates, archiveKey)).not.toBeNull();
    const restarted = f.fresh();
    await expect(restarted.get(KV.graphSnapshot, "current")).rejects.toThrow("pending");
    expect(await resumeGraphWritePlan(restarted)).toMatchObject({ recovered: true });
    expect(await restarted.get(KV.graphNodes, "n")).toBeNull();
    expect(await restarted.get(KV.archiveStates, archiveKey)).toBeNull();
    expect(await resumeGraphWritePlan(restarted)).toEqual({ recovered: false, writes: 0 });
  });

  it("refuses archive-only cleanup plans and version-1 deletion entries", async () => {
    const f = engine(), kv = f.fresh();
    const key = archiveTargetAddress({ kind: "graph_node", id: "n" }).key;
    await kv.set(KV.archiveStates, key, { id: key });
    await expect(prepareGraphWritePlan(kv, store => store.delete(KV.archiveStates, key))).rejects.toThrow("original graph deletion");
    await kv.set(KV.graphNodes, "n", { id: "n" });
    const { plan } = await prepareGraphWritePlan(kv, store => store.delete(KV.graphNodes, "n"));
    expect(() => validateGraphWritePlan({ ...plan, version: 1 })).toThrow("assignment or deletion");
    expect(await kv.get(KV.graphNodes, "n")).toEqual({ id: "n" });
    expect(await kv.get(KV.graphWritePlan, "current")).toBeNull();
  });

  it.each([KV.graphEdges, KV.archiveStates])("recovers an actual registered project purge after acknowledgement loss at %s", async failedScope => {
    const f = engine(), kv = f.fresh();
    registerGraphFunction(f.sdk as never, kv, { name: "noop" } as never);
    registerArchiveFunctions(f.sdk as never, kv);
    const call = (function_id: string, payload: object) => f.sdk.trigger({ function_id, payload });
    await kv.set(KV.sessions, "s", { id: "s", project: "p", agentId: "test", startedAt: "2026-01-01T00:00:00Z" });
    await kv.set(KV.observations("s"), "o", { id: "o", sessionId: "s", title: "source", narrative: "source evidence", timestamp: "2026-01-01T00:00:00Z" });
    const graph = await call("mem::graph-upsert", { project: "p", sources: [{ sessionId: "s", observationIds: ["o"] }],
      nodes: [{ key: "a", type: "project", name: "Project" }, { key: "b", type: "decision", name: "Decision" }],
      edges: [{ source: "a", target: "b", type: "uses" }] });
    const snapshot = await kv.get<GraphSnapshot>(KV.graphSnapshot, "current");
    const target = { kind: "graph_node", id: graph.nodeIds.a };
    const preview = await call("mem::archive", { action: "archive", project: "p", target });
    await call("mem::archive", { action: "archive", project: "p", target, dryRun: false, expectedRevision: preview.expectedRevision,
      expectedDigest: preview.expectedDigest, reason: "Reviewed" });
    f.fail(failedScope);
    expect(await call("mem::graph-project-purge", { project: "p", nodeIds: snapshot!.topNodes.map(node => node.id),
      edgeIds: snapshot!.topEdges.map(edge => edge.id), reason: "Fixture purge" })).toMatchObject({ success: false });
    expect(await f.backing.get(KV.graphWritePlan, "current")).toMatchObject({ version: 2 });
    const restarted = f.fresh();
    await expect(restarted.get(KV.graphSnapshot, "current")).rejects.toThrow("pending");
    await resumeGraphWritePlan(restarted);
    expect(await restarted.list(KV.graphNodes)).toEqual([]); expect(await restarted.list(KV.graphEdges)).toEqual([]);
    expect(await restarted.list(KV.archiveStates)).toEqual([]);
    expect(await restarted.get(KV.graphSnapshot, "current")).toMatchObject({ stats: { totalNodes: 0, totalEdges: 0 } });
    expect((await restarted.list<any>(KV.audit)).find(row => row.functionId === "mem::graph-project-purge")).toMatchObject({ details: { phase: "completed" } });
    expect(await restarted.get(KV.observations("s"), "o")).not.toBeNull();
  });
  it("lets an unrelated source write wait for a successful active graph application", async () => {
    const f = engine(); const kv = f.fresh();
    const { plan } = await prepareGraphWritePlan(kv, store => store.set(KV.graphNodeDegree, "n", 1));
    const gate = f.pause(KV.graphNodeDegree);
    const application = applyGraphWritePlan(kv, plan);
    await gate.started;
    const sourceWrite = kv.set(KV.sessions, "other", { id: "other" });
    await Promise.resolve(); await Promise.resolve();
    expect(await f.backing.get(KV.sessions, "other")).toBeNull();
    gate.release(); await application; await sourceWrite;
    expect(await kv.get(KV.sessions, "other")).toEqual({ id: "other" });
  });

  it("fences canonical mutations after a lost acknowledgement and recovers through a fresh StateKV", async () => {
    const f = engine(); const kv = f.fresh();
    const { plan } = await prepareGraphWritePlan(kv, store => store.set(KV.graphNodeDegree, "n", 1));
    f.fail(KV.graphNodeDegree);
    await expect(applyGraphWritePlan(kv, plan)).rejects.toThrow("lost acknowledgement");
    await expect(kv.set(KV.sessions, "s", { id: "s" })).rejects.toThrow("uncertain");
    await expect(kv.get(KV.graphNodeDegree, "n")).rejects.toThrow("pending");
    const restarted = f.fresh();
    await expect(restarted.delete(KV.observations("s"), "o")).rejects.toThrow("pending");
    expect(await resumeGraphWritePlan(restarted)).toEqual({ recovered: true, writes: 1 });
    expect(await restarted.get(KV.graphNodeDegree, "n")).toBe(1);
    await restarted.set(KV.sessions, "s", { id: "s" });
    await expect(restarted.delete(KV.graphWritePlan, "current")).rejects.toThrow("official recovery");
  });

  it("keeps a changed or deleted source from being reintroduced by recovery", async () => {
    const f = engine(); const kv = f.fresh();
    await kv.set(KV.sessions, "s", { id: "s", project: "p" });
    await kv.set(KV.observations("s"), "o", { id: "o", sessionId: "s", project: "p", narrative: "decision" });
    const { plan } = await prepareGraphWritePlan(kv, store => store.set(KV.graphNodes, "n", { id: "n", sourceObservationIds: ["o"] }), [{ sessionId: "s", project: "p", observationId: "o" }]);
    await kv.set(KV.observations("s"), "o", { id: "o", sessionId: "s", project: "p", narrative: "changed" });
    await expect(applyGraphWritePlan(kv, plan)).rejects.toThrow("source content changed");
    expect(await kv.get(KV.graphWritePlan, "current")).toBeNull();
    await f.backing.set(KV.graphWritePlan, "current", plan);
    await f.backing.delete(KV.observations("s"), "o");
    await expect(resumeGraphWritePlan(f.fresh())).rejects.toThrow("source is unavailable");
    expect(await f.backing.get(KV.graphNodes, "n")).toBeNull();
    expect(await f.backing.get(KV.graphWritePlan, "current")).toEqual(plan);
  });

  it("recovers the actual graph persistence output at every assignment boundary", async () => {
    const nodes: GraphNode[] = ["a", "b"].map(id => ({ id, type: "concept", name: id, properties: {},
      sourceObservationIds: ["obs"], createdAt: "2026-09-13T00:00:00Z" }));
    const edge: GraphEdge = { id: "e", type: "uses", sourceNodeId: "a", targetNodeId: "b", weight: 1,
      sourceObservationIds: ["obs"], createdAt: "2026-09-13T00:00:00Z" };
    const prepared = await prepareGraphWritePlan(mockKV(), store => persistGraphDelta(store as never, nodes, [edge], ["obs"], { project: "p", sourceSessionIds: ["s"] }));
    expect(prepared.result).toEqual({ newNodeCount: 2, newEdgeCount: 1 });
    for (let boundary = 1; boundary <= prepared.plan.writes.length; boundary++) {
      const kv = mockKV(); let assignments = 0;
      await expect(applyGraphWritePlan({ ...kv, async set<T>(scope: string, key: string, value: T) {
        const result = await kv.set(scope, key, value);
        if (scope !== KV.graphWritePlan && ++assignments === boundary) throw Error("process stopped after assignment");
        return result;
      } }, prepared.plan)).rejects.toThrow();
      await resumeGraphWritePlan(kv);
      for (const write of prepared.plan.writes) expect(await kv.get(write.scope, write.key)).toEqual(write.value);
      expect(await kv.get(KV.graphNodeDegree, "a")).toBe(1);
      expect(await kv.get(KV.graphNodeDegree, "b")).toBe(1);
      expect((await kv.get<GraphSnapshot>(KV.graphSnapshot, "current"))!.stats).toMatchObject({ totalNodes: 2, totalEdges: 1 });
    }
  });

  it("plans without canonical writes and isolates mutable reads and repeated assignments", async () => {
    const kv = mockKV();
    await kv.set(KV.graphNodes, "n", { id: "n", properties: { count: 0 } });
    const { plan } = await prepareGraphWritePlan(kv, async store => {
      const row = (await store.get<{ id: string; properties: { count: number } }>(KV.graphNodes, "n"))!;
      row.properties.count++;
      expect(await kv.get(KV.graphNodes, "n")).toEqual({ id: "n", properties: { count: 0 } });
      await store.set(KV.graphNodes, "n", row);
      row.properties.count++;
      expect(await store.get(KV.graphNodes, "n")).toEqual({ id: "n", properties: { count: 1 } });
      await store.set(KV.graphNodes, "n", { ...row, unused: undefined });
    });
    expect(plan.writes).toHaveLength(1);
    expect(await kv.get(KV.graphNodes, "n")).toEqual({ id: "n", properties: { count: 0 } });
    await applyGraphWritePlan(kv, plan);
    expect(await kv.get(KV.graphNodes, "n")).toEqual({ id: "n", properties: { count: 2 } });
    expect(await kv.get(KV.graphWritePlan, "current")).toBeNull();
  });

  it.each([1, 2, 3, 4, 5, 6])("recovers an acknowledged-or-not interruption at write boundary %i without incrementing again", async boundary => {
    const kv = mockKV();
    const { plan } = await prepare(kv);
    let calls = 0;
    const interrupted = { ...kv,
      async set<T>(scope: string, key: string, value: T): Promise<T> {
        const result = await kv.set(scope, key, value);
        if (++calls === boundary) throw Error("lost acknowledgement");
        return result;
      },
      async delete(scope: string, key: string) {
        if (++calls === boundary) throw Error("interrupted before clearing intent");
        await kv.delete(scope, key);
      },
    };
    await expect(applyGraphWritePlan(interrupted, plan)).rejects.toThrow();
    expect(await resumeGraphWritePlan(kv)).toEqual({ recovered: true, writes: 4 });
    expect(await kv.get(KV.graphNodeDegree, "n")).toBe(1);
    expect(await kv.get(KV.graphNameIndex, "project|type|name")).toBe("n");
    expect(await kv.get(KV.graphSnapshot, "current")).toEqual({ stats: { totalNodes: 1, totalEdges: 0 } });
    expect(await resumeGraphWritePlan(kv)).toEqual({ recovered: false, writes: 0 });
  });

  it("checks all conflicts before replay and preserves pending evidence", async () => {
    const kv = mockKV(); const { plan } = await prepare(kv);
    await kv.set(KV.graphWritePlan, "current", plan);
    await kv.set(KV.graphSnapshot, "current", { stats: { totalNodes: 99 } });
    await expect(resumeGraphWritePlan(kv)).rejects.toThrow("conflicts");
    expect(await kv.get(KV.graphNodes, "n")).toBeNull();
    expect(await kv.get(KV.graphWritePlan, "current")).toEqual(plan);
  });

  it("rejects stale, foreign-scope, tampered and competing plans without replacing intent", async () => {
    const kv = mockKV(); const { plan } = await prepare(kv);
    await kv.set(KV.graphNodeDegree, "n", 10);
    await expect(applyGraphWritePlan(kv, plan)).rejects.toThrow("stale");
    expect(await kv.get(KV.graphWritePlan, "current")).toBeNull();
    await expect(prepareGraphWritePlan(kv, store => store.set(KV.sessions, "s", {}))).rejects.toThrow("target");
    expect(() => validateGraphWritePlan({ ...plan, writes: [{ ...plan.writes[0], value: "changed" }] })).toThrow("checksum");
    const next = await prepare(kv);
    await kv.set(KV.graphWritePlan, "current", next.plan);
    await expect(applyGraphWritePlan(kv, plan)).rejects.toThrow("Another");
    expect(await kv.get(KV.graphWritePlan, "current")).toEqual(next.plan);
  });
});
