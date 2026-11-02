import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeSourceLifecycle, finishShutdown, NativeSourceShutdownError, isNativeSourceShutdown, ShutdownPhaseError, createWorkerShutdown } from "../src/shutdown.js";
import { CodexReadBudget } from "../src/replay/codex-read-budget.js";

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
afterEach(() => vi.useRealTimers());
describe("native cooperative shutdown", () => {
  it("only recognizes its own cancellation or the exact SDK wire error, not arbitrary failure text", () => {
    expect(isNativeSourceShutdown(new NativeSourceShutdownError())).toBe(true);
    expect(isNativeSourceShutdown(Object.assign(new Error("FUNCTION_ERROR: Native source shutdown requested"), { name: "InvocationError", code: "FUNCTION_ERROR" }))).toBe(true);
    expect(isNativeSourceShutdown(Error("disk failed: Native source shutdown requested"))).toBe(false);
    expect(isNativeSourceShutdown(Object.assign(new Error("FUNCTION_ERROR: Native source shutdown requested; disk failed"), { name: "InvocationError", code: "FUNCTION_ERROR" }))).toBe(false);
  });

  it("interrupts a thirty-second read budget and rejects new work without advancing the deadline", async () => {
    vi.useFakeTimers();
    const lifecycle = new NativeSourceLifecycle(), reading = deferred();
    const budget = new CodexReadBudget({ maxMilliseconds: 30_000 }, lifecycle.signal);
    const running = lifecycle.run(async () => { await reading.promise; budget.check(); });
    const rejected = expect(running).rejects.toBeInstanceOf(NativeSourceShutdownError);
    await Promise.resolve();
    const stopped = lifecycle.stop();
    await expect(lifecycle.run(async () => "wrong")).rejects.toThrow("shutdown requested");
    reading.resolve(); await rejected; await stopped;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for the exact physical read to settle instead of abandoning its promise", async () => {
    const lifecycle = new NativeSourceLifecycle(), io = deferred();
    const budget = new CodexReadBudget({}, lifecycle.signal);
    const file = budget.physical({ stat: async () => ({ dev: 1, ino: 2, size: 1, mtimeMs: 0 }), read: async (buffer) => { await io.promise; return { buffer, bytesRead: 1 }; } });
    const running = lifecycle.run(() => file.read(Buffer.alloc(1), 0, 1, 0));
    const rejected = expect(running).rejects.toThrow("shutdown requested");
    await Promise.resolve();
    let done = false; const stopped = lifecycle.stop().then(() => { done = true; });
    await Promise.resolve(); expect(done).toBe(false);
    io.resolve(); await rejected; await stopped; expect(done).toBe(true);
  });

  it("lets an admitted canonical commit finish, then flushes before SDK or engine cleanup", async () => {
    const lifecycle = new NativeSourceLifecycle(), committed = deferred(), flushed = deferred(), graphReleased = deferred();
    const events: string[] = [];
    const running = lifecycle.run(async () => { events.push("commit-start"); await committed.promise; events.push("commit-done"); });
    await Promise.resolve();
    const closing = finishShutdown([lifecycle.stop(), graphReleased.promise], async () => { events.push("index-save"); }, async () => { events.push("flush-start"); await flushed.promise; events.push("flush-done"); }, async () => { events.push("sdk-close"); events.push("worker-exit-allows-engine-cleanup"); });
    committed.resolve(); await running; await Promise.resolve(); expect(events).not.toContain("flush-start");
    graphReleased.resolve(); await vi.waitFor(() => expect(events).toContain("flush-start"));
    expect(events).not.toContain("sdk-close"); flushed.resolve(); await closing;
    expect(events).toEqual(["commit-start", "commit-done", "index-save", "flush-start", "flush-done", "sdk-close", "worker-exit-allows-engine-cleanup"]);
  });

  it("settles all producers and attempts indexes and durability while preserving every failure", async () => {
    const other = deferred(), close = vi.fn(), events: string[] = [];
    const errors = [Error("producer-one"), Error("producer-two"), Error("index"), Error("flush")];
    const closing = finishShutdown([Promise.reject(errors[0]), other.promise.then(() => { throw errors[1]; })],
      async () => { events.push("indexes"); throw errors[2]; }, async () => { events.push("flush"); throw errors[3]; }, close);
    const caught = closing.catch(error => error as ShutdownPhaseError);
    await Promise.resolve(); expect(events).toEqual([]); other.resolve();
    const error = await caught as ShutdownPhaseError;
    expect(error).toBeInstanceOf(ShutdownPhaseError);
    expect(error.failures.map(failure => failure.stage)).toEqual(["producers", "producers", "indexes", "durability"]);
    expect(error.errors).toEqual(errors); expect(events).toEqual(["indexes", "flush"]); expect(close).not.toHaveBeenCalled();
  });

  it("flushes the successful producer's writes even when another producer failed, without a clean exit", async () => {
    const close = vi.fn(), flush = vi.fn(async () => {}), save = vi.fn(async () => {});
    const error = await finishShutdown([Promise.resolve(), Promise.reject(Error("producer"))], save, flush, close).catch(error => error);
    expect(error.failures).toMatchObject([{ stage: "producers", cause: Error("producer") }]);
    expect(save).toHaveBeenCalledOnce(); expect(flush).toHaveBeenCalledOnce(); expect(close).not.toHaveBeenCalled();
  });

  it("publishes safe pending and failed stages through the actual managed callback, preserving the runtime", async () => {
    vi.useFakeTimers();
    const producer = deferred(), statuses: unknown[] = [], warning = vi.fn(), exit = vi.fn(), clear = vi.fn(), failed = vi.fn(), close = vi.fn();
    const controller = createWorkerShutdown({ managed: true, stopTimers: vi.fn(), stopProducers: [() => producer.promise],
      persistIndexes: async () => {}, flushWrites: async () => { throw Error("private-token-and-source-body"); }, closeTransports: close,
      clearPidfile: clear, exit, markFailedExit: failed, report: value => statuses.push(value), warn: warning });
    const stopping = controller.request(); expect(controller.request()).toBe(stopping);
    await vi.advanceTimersByTimeAsync(8000); expect(controller.status()).toMatchObject({ state: "stopping", stage: "producers" });
    expect(warning).toHaveBeenCalledOnce(); expect(exit).not.toHaveBeenCalled(); producer.resolve(); await stopping;
    expect(controller.status()).toMatchObject({ state: "failed", stage: "durability", failures: [{ stage: "durability", reason: "durability_failed" }] });
    expect(JSON.stringify(statuses) + JSON.stringify(warning.mock.calls)).not.toContain("private-token");
    expect(close).not.toHaveBeenCalled(); expect(clear).not.toHaveBeenCalled(); expect(exit).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledOnce();
    await controller.request(); expect(failed).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the production callback's clean ordering and does not close SDK before producers release", async () => {
    const producer = deferred(), events: string[] = [];
    const controller = createWorkerShutdown({ managed: true, stopTimers: () => { events.push("timers-stop"); },
      stopProducers: [() => producer.promise.then(() => { events.push("producer-done"); })],
      persistIndexes: async () => { events.push("index"); }, flushWrites: async () => { events.push("flush"); },
      closeTransports: async () => { events.push("sdk-close"); }, clearPidfile: () => { events.push("pid-clear"); }, exit: code => { events.push("exit-" + code); } });
    const stopping = controller.request(); expect(events).toEqual(["timers-stop"]); producer.resolve(); await stopping;
    expect(events).toEqual(["timers-stop", "producer-done", "index", "flush", "sdk-close", "pid-clear", "exit-0"]);
    expect(controller.status()).toMatchObject({ state: "stopped", stage: "complete", failures: [] });
  });

  it("continues the actual callback through throwing initial reports and timer warnings, without bypassing durability", async () => {
    vi.useFakeTimers(); const producer = deferred(), exit = vi.fn(), clear = vi.fn(), events: string[] = [];
    const controller = createWorkerShutdown({ managed: true, stopTimers: () => { events.push("stop-timers"); },
      stopProducers: [() => producer.promise], persistIndexes: async () => { events.push("indexes"); },
      flushWrites: async () => { events.push("durability"); }, closeTransports: async () => { events.push("sdk-close"); },
      clearPidfile: clear, exit, report: () => { throw Error("synthetic report failure"); }, warn: () => { throw Error("synthetic output failure"); } });
    let stopping!: Promise<void>;
    expect(() => { stopping = controller.request(); }).not.toThrow(); expect(events).toEqual(["stop-timers"]);
    await vi.advanceTimersByTimeAsync(8000); expect(exit).not.toHaveBeenCalled(); expect(clear).not.toHaveBeenCalled();
    expect(controller.status()).toMatchObject({ state: "stopping", stage: "producers" });
    producer.resolve(); await stopping;
    expect(events).toEqual(["stop-timers", "indexes", "durability", "sdk-close"]);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0); expect(clear).toHaveBeenCalledOnce();
    expect(controller.status()).toMatchObject({ state: "stopped", stage: "complete" });
  });

  it("retains an actual durability failure when all report/warn callbacks throw, without an unhandled rejection", async () => {
    const exit = vi.fn(), clear = vi.fn(), failed = vi.fn(), close = vi.fn();
    const controller = createWorkerShutdown({ managed: true, stopTimers: () => {}, stopProducers: [],
      persistIndexes: async () => {}, flushWrites: async () => { throw Error("synthetic durability failure"); }, closeTransports: close,
      clearPidfile: clear, exit, markFailedExit: failed,
      report: () => { throw Error("synthetic report failure"); }, warn: () => { throw Error("synthetic warn failure"); } });
    await expect(controller.request()).resolves.toBeUndefined();
    expect(controller.status()).toMatchObject({ state: "failed", stage: "durability", failures: [{ stage: "durability", reason: "durability_failed" }] });
    expect(close).not.toHaveBeenCalled(); expect(clear).not.toHaveBeenCalled(); expect(exit).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledOnce();
  });

  it("ends read cancellation at the commit boundary while forbidding later physical reads", async () => {
    const lifecycle = new NativeSourceLifecycle(), budget = new CodexReadBudget({}, lifecycle.signal);
    const file = budget.physical({ stat: async () => ({ dev: 1, ino: 2, size: 1, mtimeMs: 0 }), read: async buffer => ({ buffer, bytesRead: 1 }) });
    budget.finishReading(); await lifecycle.stop(); expect(() => budget.check()).not.toThrow();
    await expect(file.read(Buffer.alloc(1), 0, 1, 0)).rejects.toThrow("read phase is closed");
    await expect(file.stat()).rejects.toThrow("read phase is closed");
  });
});
