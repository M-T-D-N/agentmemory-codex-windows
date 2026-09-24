import { afterEach, describe, expect, it, vi } from "vitest";
import { registerHealthMonitor } from "../src/health/monitor.js";
import { evaluateHealth } from "../src/health/thresholds.js";
import type { HealthSnapshot } from "../src/types.js";

vi.mock("node:os", () => ({ availableParallelism: () => 4 }));
vi.mock("node:v8", () => ({ getHeapStatistics: () => ({ heap_size_limit: 4096 }) }));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it("recovers through one registered writer, reports failure, and retries only after backoff", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  const samples: HealthSnapshot[] = [];
  let ready = false;
  let finish!: (result: unknown) => void;
  const graphSnapshot = { dirty: false, stats: { totalNodes: 1, totalEdges: 0 }, updatedAt: "2026-09-25T00:00:00Z" };
  const kv = { usesManagedState: true,
    get: async (scope: string) => scope === "mem:graph:snapshot" ? graphSnapshot
      : scope === "mem:graph:query-manifest" ? {
          version: 1, shardCount: 64, totalNodes: 1, totalEdges: 0,
          updatedAt: graphSnapshot.updatedAt, dirty: !ready,
        } : null,
    set: async (_scope: string, key: string, value: unknown) => {
      if (key === "latest") samples.push(value as HealthSnapshot);
      return value;
    },
  };
  const repairs = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const sdk = { trigger: async (input: { function_id: string; payload: unknown }) => {
    if (input.function_id === "mem::graph-snapshot-rebuild") {
      expect(input.payload).toEqual({ onlyIfIndexUnavailable: true });
      return repairs();
    }
    return { workers: [] };
  } };
  const drain = () => new Promise<void>(resolve => setImmediate(resolve));
  const monitor = registerHealthMonitor(sdk as never, kv as never, { maintainGraphQueryIndex: true });
  try {
    await drain();
    expect(repairs).toHaveBeenCalledTimes(1);
    expect(samples.at(-1)?.graphQueryIndex?.status).toBe("recovering");
    await vi.advanceTimersByTimeAsync(90_000); await drain();
    expect(repairs).toHaveBeenCalledTimes(1);
    finish({ success: false, error: "bounded page unavailable" }); await drain();
    await vi.advanceTimersByTimeAsync(30_000); await drain();
    expect(samples.at(-1)?.graphQueryIndex).toMatchObject({ status: "error", lastError: "bounded page unavailable", nextRetryAt: expect.any(String) });
    expect(samples.at(-1)?.alerts).toContain("graph_query_index_error");
    await vi.advanceTimersByTimeAsync(240_000); await drain();
    expect(repairs).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000); await drain();
    expect(repairs).toHaveBeenCalledTimes(2);
    ready = true; finish({ success: true }); await drain();
    await vi.advanceTimersByTimeAsync(30_000); await drain();
    expect(samples.at(-1)?.graphQueryIndex).toEqual({ status: "ready" });
    expect(samples.at(-1)?.alerts.some(alert => alert.startsWith("graph_query_index_"))).toBe(false);
  } finally { monitor.stop(); }
});

describe("CPU capacity in managed health checks", () => {
  it.each([true, false])("reports the actual sample and preserves the portable contract (managed=%s)", async managed => {
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(1000);
    vi.spyOn(process, "cpuUsage").mockReturnValueOnce({ user: 0, system: 0 }).mockReturnValue({ user: 1_300_000, system: 0 });
    vi.spyOn(process, "memoryUsage").mockReturnValue({ heapUsed: 10, heapTotal: 100, rss: 100, external: 0, arrayBuffers: 0 });
    let resolve!: (snapshot: HealthSnapshot) => void;
    const collected = new Promise<HealthSnapshot>(done => { resolve = done; });
    const kv = { usesManagedState: managed, get: async () => ({}), set: async (_scope: string, key: string, value: unknown) => {
      if (key === "latest") resolve(value as HealthSnapshot);
      return value;
    } };
    const sdk = { trigger: async () => ({ workers: [] }) };
    const monitor = registerHealthMonitor(sdk as never, kv as never);
    try {
      const snapshot = await collected;
      expect(snapshot.cpu.percent).toBe(managed ? 32.5 : 130);
      expect(snapshot.memory.heapSizeLimit).toBe(managed ? 4096 : undefined);
      expect(snapshot.cpu.corePercent).toBe(managed ? 130 : undefined);
      expect(snapshot.cpu.availableParallelism).toBe(managed ? 4 : undefined);
      expect(snapshot.alerts.some(alert => alert.startsWith("cpu_critical_"))).toBe(!managed);
      if (managed) {
        expect(evaluateHealth({ ...snapshot, eventLoopLagMs: 600 }).status).toBe("critical");
        expect(evaluateHealth({ ...snapshot, connectionState: "disconnected" }).status).toBe("critical");
        expect(evaluateHealth({ ...snapshot, cpu: { ...snapshot.cpu, percent: 95 } }).status).toBe("critical");
      }
    } finally { monitor.stop(); }
  });
});
