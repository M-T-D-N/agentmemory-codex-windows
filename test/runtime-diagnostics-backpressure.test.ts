import { afterEach, describe, expect, it, vi } from "vitest";
import { attachRuntimeDiagnostics } from "../src/telemetry/runtime-diagnostics.js";

const controlled = vi.hoisted(() => ({ worker: null as any }));
vi.mock("node:worker_threads", async () => {
  const { runInNewContext } = await import("node:vm");
  return { Worker: class {
    queue: any[] = [];
    snapshot: any;
    flush!: () => void;
    receive!: (event: any) => void;
    ioFailure = false;
    notices = 0;
    listeners = new Map<string, (...args: any[]) => void>();
    constructor(source: string, options: any) {
      controlled.worker = this;
      runInNewContext(source, {
        require: (name: string) => name === "node:worker_threads" ? {
          workerData: options.workerData,
          parentPort: {
            on: (_name: string, receive: (event: any) => void) => { this.receive = receive; },
            postMessage: (message: any) => { this.notices++; this.emit("message", message); },
          },
        } : {
          writeFileSync: (_path: string, text: string) => {
            if (this.ioFailure) throw Error("PRIVATE_PATH_AND_ERROR");
            this.snapshot = JSON.parse(text);
          },
          renameSync: () => {},
        },
        setInterval: (flush: () => void) => { this.flush = flush; },
        Date, Map, Int32Array, Atomics,
      });
    }
    on(name: string, callback: (...args: any[]) => void) { this.listeners.set(name, callback); }
    emit(name: string, value: any) { this.listeners.get(name)?.(value); }
    unref() {}
    postMessage(event: any) { this.queue.push(event); }
    drain() { while (this.queue.length) this.receive(this.queue.shift()); this.flush(); }
    async terminate() { this.emit("exit", 0); return 0; }
  } };
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
});
function fixture() {
  const handlers = new Map<string, (...args: any[]) => Promise<unknown>>();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const sdk = {
    registerFunction(id: string, handler: (...args: any[]) => Promise<unknown>) { handlers.set(id, handler); },
    trigger(request: { function_id: string }) { return request.function_id === "state::get" ? pending : Promise.resolve("ok"); },
  };
  const diagnostics = attachRuntimeDiagnostics(sdk as never, { file: "D:/in-memory-only.json", runId: "20260912T010000000Z" })!;
  cleanups.push(async () => { release(); await diagnostics.stop(); });
  return { sdk, handlers, release, worker: controlled.worker };
}

describe("diagnostic overload recovery", () => {
  it("never strands admitted work and resumes tracing after active and queue saturation", async () => {
    const f = fixture();
    const pending = Array.from({ length: 128 }, () => f.sdk.trigger({ function_id: "state::get" }));
    f.worker.drain();
    expect(f.worker.snapshot.active).toHaveLength(128);
    const burst = Array.from({ length: 512 }, () => f.sdk.trigger({ function_id: "state::list" }));
    await Promise.all(burst);
    f.release(); await Promise.all(pending);
    for (let wave = 0; wave < 2; wave++) {
      await Promise.all(Array.from({ length: 128 }, () => f.sdk.trigger({ function_id: "state::list" })));
      expect(f.worker.queue.length).toBeLessThanOrEqual(512);
    }
    f.worker.drain();
    expect(f.worker.snapshot.active).toEqual([]);
    expect(f.worker.snapshot.droppedActive).toBeGreaterThan(0);
    expect(f.worker.snapshot.droppedEvents).toBeGreaterThan(0);
    expect(f.worker.snapshot.recent.length).toBeLessThanOrEqual(64);
    expect(await f.sdk.trigger({ function_id: "state::set" })).toBe("ok");
    f.worker.drain();
    expect(f.worker.snapshot.active).toEqual([]);
    expect(f.worker.snapshot.recent.at(-1).name).toBe("state::set");
  });

  it("retains the six fixed MCP handler names and excludes unknown names", async () => {
    const f = fixture();
    const names = ["mcp::tools::list", "mcp::tools::call", "mcp::resources::list", "mcp::resources::read", "mcp::prompts::list", "mcp::prompts::get"];
    for (const name of [...names, "mcp::PRIVATE_UNKNOWN"]) {
      f.sdk.registerFunction(name, async () => "ok");
      expect(await f.handlers.get(name)!()).toBe("ok");
    }
    f.worker.drain();
    expect(f.worker.snapshot.recent.map((entry: any) => entry.name)).toEqual([...names, "other"]);
    expect(JSON.stringify(f.worker.snapshot)).not.toContain("PRIVATE_");
  });

  it("warns once without sensitive errors and lets IO recover without failing requests", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = fixture();
    f.worker.ioFailure = true;
    f.worker.flush(); f.worker.flush();
    expect(f.worker.notices).toBe(1);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls.flat().join(" ")).not.toContain("PRIVATE_");
    expect(await f.sdk.trigger({ function_id: "state::set" })).toBe("ok");
    f.worker.ioFailure = false;
    f.worker.drain();
    expect(f.worker.snapshot.recent.at(-1).name).toBe("state::set");
    f.worker.emit("error", Error("PRIVATE_WORKER_FAILURE"));
    expect(await f.sdk.trigger({ function_id: "state::list" })).toBe("ok");
    expect(warning).toHaveBeenCalledTimes(1);
  });
});
