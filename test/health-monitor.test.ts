import { afterEach, describe, expect, it, vi } from "vitest";
import { registerHealthMonitor } from "../src/health/monitor.js";
import { evaluateHealth } from "../src/health/thresholds.js";
import type { HealthSnapshot } from "../src/types.js";

vi.mock("node:os", () => ({ availableParallelism: () => 4 }));
afterEach(() => vi.restoreAllMocks());

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
