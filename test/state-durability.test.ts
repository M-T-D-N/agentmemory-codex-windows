import { describe, expect, it, vi } from "vitest";
import { StateKV } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";
import { applyGraphWritePlan, prepareGraphWritePlan, resumeGraphWritePlan } from "../src/state/graph-write-plan.js";

function fixture() {
  let rows = new Map<string, unknown>();
  const disk: Map<string, unknown>[] = [];
  let failFlush = 0;
  const address = (scope: string, key: string) => JSON.stringify([scope, key]);
  const trigger = vi.fn(async ({ function_id: id, payload: p }: any) => {
    if (id === "state::list_groups") return { groups: [] };
    if (id === "state::get") return rows.get(address(p.scope, p.key));
    if (id === "state::set") { rows.set(address(p.scope, p.key), structuredClone(p.value)); return p.value; }
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
    failAt(n: number) { failFlush = n; },
    crash() { rows = structuredClone(disk.at(-1) ?? new Map()); failFlush = 0; },
    get(scope: string, key: string) { return rows.get(address(scope, key)); },
  };
}

describe("StateModule durability boundaries", () => {
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
