import { recordAccessBatch } from "../src/functions/access-tracker.js";
import { registerHealthMonitor } from "../src/health/monitor.js";
import { AsyncResource } from "node:async_hooks";
import { afterEach, expect, it, vi } from "vitest";
import { WorkerMutationLifecycle, WorkerStoppingError, bindWorkerMutationLifecycle, workerMutationTimeout } from "../src/worker-lifecycle.js";
import { createWorkerRuntimeShutdown } from "../src/worker-runtime-shutdown.js";
import { managedShutdownBridge } from "../src/shutdown-bridge.js";
import { registerCaptureFunctions } from "../src/functions/capture.js";
import { registerObserveFunction } from "../src/functions/observe.js";
import { StateKV } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";
import { memoryEngine } from "./helpers/memory-engine.js";

const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
afterEach(() => { vi.useRealTimers(); const bridge = managedShutdownBridge(); bridge.stoppers = []; bridge.requested = false; bridge.listeners.clear(); bridge.request = undefined; });

it("drains actual general capture across SDK metadata ingress after its first await, without native lifecycle", async () => {
  const held = gate(), started = gate(); let block = true;
  const raw = memoryEngine(async id => { if (id === "state::get" && block) { block = false; started.resolve(); await held.promise; } });
  const lifecycle = new WorkerMutationLifecycle(); const sdk = lifecycle.wrap(raw);
  const kv = new StateKV(sdk as never, { requireDurability: true });
  registerObserveFunction(sdk as never, kv);
  const capture = registerCaptureFunctions(sdk as never, kv, { lifecycle });
  const input = { eventId: "fixture-event-capture-001", payload: { sessionId: "fixture-capture", project: "fixture", cwd: "C:/synthetic", hookType: "prompt_submit", timestamp: "2026-10-20T00:00:00Z", data: { prompt: "Synthetic accepted capture" } } };
  const accepted = sdk.trigger({ function_id: "mem::capture", payload: input });
  await started.promise;
  const order: string[] = []; let stopped = false; const exits: number[] = [];
  const shutdown = createWorkerRuntimeShutdown({ managed: true, lifecycle, stopTimers() {}, stopProducers: [() => capture.stop()],
    persistIndexes: async () => { order.push("indexes"); }, flushWrites: async () => { order.push("flush"); await kv.closeWrites(); },
    closeTransports: async () => { order.push("sdk-close"); }, clearPidfile() {}, exit: code => { exits.push(code); } });
  const stopping = shutdown.request().then(() => { stopped = true; });
  await expect(sdk.trigger({ function_id: "mem::capture", payload: input })).rejects.toBeInstanceOf(WorkerStoppingError);
  await expect(capture.sweep()).rejects.toBeInstanceOf(WorkerStoppingError);
  expect(order).toEqual([]); expect(stopped).toBe(false);
  held.resolve();
  expect(await accepted).toMatchObject({ status: "accepted", state: "completed" });
  await stopping;
  expect(order).toEqual(["indexes", "flush", "sdk-close"]); expect(exits).toEqual([0]);
  const observations = [...raw.rows].filter(([address]) => JSON.parse(address)[0] === KV.observations("fixture-capture"));
  expect(observations).toHaveLength(1); expect(lifecycle.status()).toEqual({ closing: true, pending: 0, continuations: 0 });
});

it("holds a real capture sweep at its first list await and prevents new periodic admission", async () => {
  vi.useFakeTimers(); const held = gate(), started = gate(); let lists = 0, ticks = 0;
  const raw = memoryEngine(async (id, p) => { if (id === "state::list" && p.scope === KV.captureInbox) { lists++; started.resolve(); await held.promise; } });
  const lifecycle = new WorkerMutationLifecycle(); const sdk = lifecycle.wrap(raw); const kv = new StateKV(sdk as never);
  const capture = registerCaptureFunctions(sdk as never, kv, { lifecycle });
  capture.start(); lifecycle.interval(() => { ticks++; }, 1);
  const accepted = capture.sweep(); await started.promise;
  let drained = false; const stopped = capture.stop().then(() => { drained = true; });
  capture.start(); await vi.advanceTimersByTimeAsync(3_600_001);
  await expect(capture.sweep()).rejects.toBeInstanceOf(WorkerStoppingError);
  await expect(sdk.trigger({ function_id: "mem::capture-retry", payload: { all: true } })).rejects.toBeInstanceOf(WorkerStoppingError);
  expect(ticks).toBe(0); expect(lists).toBe(1); expect(drained).toBe(false);
  held.resolve(); await accepted; await stopped; expect(drained).toBe(true);
});

it("retains a void continuation until fresh ingress executes; rejects replayed and cross-function tickets", async () => {
  const ingress = new AsyncResource("new-sdk-socket-context"); const fns = new Map<string, Function>();
  let delivery: any; let calls = 0;
  const raw = { registerFunction(id: string, handler: Function) { fns.set(id, handler); },
    trigger: async (request: any) => { delivery = request; return null; } };
  const lifecycle = new WorkerMutationLifecycle(); const sdk = lifecycle.wrap(raw);
  sdk.registerFunction("mem::child", async (_: unknown, metadata: any) => { expect(metadata).toEqual({ trace: "retained" }); calls++; });
  sdk.registerFunction("mem::other", async () => { calls++; });
  await lifecycle.run(() => sdk.trigger({ function_id: "mem::child", metadata: { trace: "retained" }, action: { type: "void" } }));
  let drained = false; const stopped = lifecycle.stop().then(() => { drained = true; });
  await Promise.resolve(); expect(drained).toBe(false);
  await expect(ingress.runInAsyncScope(fns.get("mem::other")!, undefined, {}, delivery.metadata)).rejects.toBeInstanceOf(WorkerStoppingError);
  await ingress.runInAsyncScope(fns.get("mem::child")!, undefined, {}, delivery.metadata);
  await stopped; expect(calls).toBe(1);
  await expect(ingress.runInAsyncScope(fns.get("mem::child")!, undefined, {}, delivery.metadata)).rejects.toBeInstanceOf(WorkerStoppingError);
  expect(calls).toBe(1);
});

it("rejects late delivery after SDK timeout and cannot reuse an inherited ended invocation for a timer", async () => {
  vi.useFakeTimers(); let late: any; const fns = new Map<string, Function>(); let writes = 0;
  const raw = { registerFunction(id: string, handler: Function) { fns.set(id, handler); }, trigger: async (request: any) => { late = request; throw Error("fixture SDK timeout"); } };
  const lifecycle = new WorkerMutationLifecycle(); const sdk = lifecycle.wrap(raw);
  sdk.registerFunction("mem::late", async () => { writes++; });
  await expect(sdk.trigger({ function_id: "mem::late" })).rejects.toThrow("fixture SDK timeout");
  let timerResult: Promise<unknown> | undefined;
  await lifecycle.run(async () => { setTimeout(() => { timerResult = lifecycle.run(async () => { writes++; }); void timerResult.catch(() => {}); }, 1); });
  await lifecycle.stop(); await vi.advanceTimersByTimeAsync(1);
  await expect(timerResult).rejects.toBeInstanceOf(WorkerStoppingError);
  await expect(fns.get("mem::late")!({}, late.metadata)).rejects.toBeInstanceOf(WorkerStoppingError); expect(writes).toBe(0);
});

it("attempts canonical flush before rejected or pending wrapper transport stop, without false clean", async () => {
  const bridge = managedShutdownBridge(); const held = gate(); const order: string[] = []; const exits: number[] = [];
  bridge.stoppers.push(async () => { order.push("mcp"); await held.promise; throw Error("synthetic MCP stop failure"); });
  const shutdown = createWorkerRuntimeShutdown({ managed: true, lifecycle: new WorkerMutationLifecycle(), stopTimers() {}, stopProducers: [],
    persistIndexes: async () => { order.push("indexes"); }, flushWrites: async () => { order.push("flush"); }, closeTransports: async () => { order.push("sdk"); },
    clearPidfile: () => { order.push("clear"); }, exit: code => { exits.push(code); }, markFailedExit() {}, warn() {} });
  const stopping = shutdown.request(); await vi.waitFor(() => expect(order).toEqual(["indexes", "flush", "mcp"]));
  expect(shutdown.status()).toMatchObject({ state: "stopping", stage: "transports" }); expect(exits).toEqual([]);
  held.resolve(); await stopping;
  expect(shutdown.status()).toMatchObject({ state: "failed", stage: "transports", failures: [{ stage: "transports", reason: "transports_failed" }] });
  expect(order).toEqual(["indexes", "flush", "mcp"]); expect(exits).toEqual([]);
});

it("drains a timed-out health mutation probe instead of abandoning its first await", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const held = gate(), started = gate(); const order: string[] = [];
  const lifecycle = new WorkerMutationLifecycle();
  const kv = { usesManagedState: false, get: async () => null,
    set: async (_: string, key: string) => {
      if (key === "_probe") { started.resolve(); await held.promise; order.push("probe-write"); }
      else order.push("health-write");
    } };
  const health = registerHealthMonitor({ trigger: async () => ({ workers: [] }) } as never, kv as never, { lifecycle });
  await started.promise;
  const shutdown = createWorkerRuntimeShutdown({ managed: true, lifecycle, stopTimers() {}, stopProducers: [() => health.stop()],
    persistIndexes: async () => { order.push("indexes"); }, flushWrites: async () => { order.push("flush"); },
    closeTransports: async () => { order.push("sdk"); }, clearPidfile() {}, exit() {} });
  const stopping = shutdown.request(); await Promise.resolve(); expect(order).toEqual([]);
  await vi.advanceTimersByTimeAsync(5001); expect(order).toEqual(["health-write"]);
  expect(shutdown.status()).toMatchObject({ state: "stopping", stage: "producers" });
  held.resolve(); await stopping; expect(order).toEqual(["health-write", "probe-write", "indexes", "flush", "sdk"]);
});

it("preserves an admitted general handler failure while still attempting the canonical barrier", async () => {
  const held = gate(), started = gate(); const order: string[] = [], exits: number[] = [];
  const raw = memoryEngine(); const lifecycle = new WorkerMutationLifecycle(); const sdk = lifecycle.wrap(raw);
  sdk.registerFunction("mem::pending-failure", async () => { started.resolve(); await held.promise; throw Error("synthetic producer failure"); });
  const pending = raw.trigger({ function_id: "mem::pending-failure", payload: {} }); void pending.catch(() => {});
  await started.promise;
  const shutdown = createWorkerRuntimeShutdown({ managed: true, lifecycle, stopTimers() {}, stopProducers: [],
    persistIndexes: async () => { order.push("indexes"); }, flushWrites: async () => { order.push("flush"); },
    closeTransports: async () => { order.push("sdk"); }, clearPidfile() {}, exit: code => { exits.push(code); }, markFailedExit() {}, warn() {} });
  const stopping = shutdown.request(); held.resolve(); await expect(pending).rejects.toThrow("synthetic producer failure"); await stopping;
  expect(order).toEqual(["indexes", "flush"]); expect(exits).toEqual([]); expect(shutdown.status()).toMatchObject({ state: "failed", failures: [{ stage: "producers", reason: "producers_failed" }] });
});

it("drains a detached actual access recorder after its caller returns and cancels owner timers", async () => {
  vi.useFakeTimers(); const held = gate(), started = gate(); let ticks = 0;
  const raw = memoryEngine(async (id, p) => { if (id === "state::get" && p.scope === KV.accessLog) { started.resolve(); await held.promise; } });
  const lifecycle = new WorkerMutationLifecycle(); const kv = new StateKV(raw as never);
  bindWorkerMutationLifecycle(kv, lifecycle);
  workerMutationTimeout(kv, async () => { ticks++; }, 100);
  // The request completes while its intentionally detached actual helper runs.
  await lifecycle.run(async () => { void recordAccessBatch(kv, ["fixture-memory"]); });
  await started.promise;
  let stopped = false; const stopping = lifecycle.stop().then(() => { stopped = true; });
  await vi.advanceTimersByTimeAsync(101); expect(ticks).toBe(0); expect(stopped).toBe(false);
  await expect(recordAccessBatch(kv, ["rejected-new"])).rejects.toBeInstanceOf(WorkerStoppingError);
  held.resolve(); await stopping;
  expect(stopped).toBe(true); expect([...raw.rows].some(([key]) => JSON.parse(key)[0] === KV.accessLog)).toBe(true);
});
