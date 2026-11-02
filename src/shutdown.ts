import { managedShutdownBridge, stopManagedWrapperTransports } from "./shutdown-bridge.js";
export class NativeSourceShutdownError extends Error {
  constructor() { super("Native source shutdown requested"); this.name = "NativeSourceShutdownError"; }
}

export function throwIfNativeSourceStopping(signal?: AbortSignal): void {
  if (signal?.aborted) throw new NativeSourceShutdownError();
}

export function isNativeSourceShutdown(error: unknown): boolean {
  if (error instanceof NativeSourceShutdownError) return true;
  if (!(error instanceof Error) || error.name !== "InvocationError" || !("code" in error) ||
      typeof error.code !== "string" || !/^[A-Za-z0-9_]{1,64}$/.test(error.code)) return false;
  return error.message === `${error.code}: Native source shutdown requested`;
}

export async function waitForShutdownTasks(tasks: Array<Promise<unknown> | undefined>): Promise<void> {
  const outcomes = await Promise.allSettled(tasks);
  const failed = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected" && !isNativeSourceShutdown(outcome.reason));
  if (failed.length) throw new AggregateError(failed.map(outcome => outcome.reason), "Shutdown producers failed");
}

type FailureStage = "producers" | "indexes" | "durability" | "transports";
type ShutdownFailure = { stage: FailureStage; cause: unknown };
export class ShutdownPhaseError extends AggregateError {
  constructor(readonly failures: ShutdownFailure[]) {
    super(failures.map(failure => failure.cause), "Shutdown phases failed: " + [...new Set(failures.map(failure => failure.stage))].join(","));
    this.name = "ShutdownPhaseError";
  }
}

export async function finishShutdown(
  producers: Array<Promise<unknown> | undefined>,
  persistIndexes: () => Promise<void>,
  flushWrites: () => Promise<void>,
  closeTransports: () => Promise<void>,
  onStage?: (stage: FailureStage, failures: ShutdownFailure[]) => void,
): Promise<void> {
  const failures: ShutdownFailure[] = [];
  onStage?.("producers", failures);
  try { await waitForShutdownTasks(producers); }
  catch (error) {
    for (const cause of error instanceof AggregateError ? error.errors : [error]) failures.push({ stage: "producers", cause });
  }
  onStage?.("indexes", failures);
  try { await persistIndexes(); } catch (cause) { failures.push({ stage: "indexes", cause }); }
  onStage?.("durability", failures);
  try { await flushWrites(); } catch (cause) { failures.push({ stage: "durability", cause }); }
  if (failures.length) throw new ShutdownPhaseError(failures);
  onStage?.("transports", failures);
  try { await closeTransports(); } catch (cause) { throw new ShutdownPhaseError([{ stage: "transports", cause }]); }
}

export class NativeSourceLifecycle {
  private readonly controller = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  get signal(): AbortSignal { return this.controller.signal; }

  run<T>(work: () => Promise<T>): Promise<T> {
    if (this.signal.aborted) return Promise.reject(new NativeSourceShutdownError());
    const pending = Promise.resolve().then(() => { throwIfNativeSourceStopping(this.signal); return work(); });
    this.pending.add(pending);
    void pending.then(() => this.pending.delete(pending), () => this.pending.delete(pending));
    return pending;
  }

  async stop(): Promise<void> {
    this.controller.abort();
    await waitForShutdownTasks([...this.pending]);
  }
}

export const SHUTDOWN_FLUSH_TIMEOUT_MS = 4000;
export const SHUTDOWN_HARD_EXIT_MS = 8000;

export interface WorkerShutdownStatus {
  state: "running" | "stopping" | "failed" | "stopped";
  stage: "idle" | FailureStage | "complete";
  workerPid: number;
  runId: string | null;
  startedAt: string | null;
  updatedAt: string;
  failures: Array<{ stage: FailureStage; reason: string }>;
}

export function createWorkerShutdown(options: {
  managed: boolean;
  stopTimers: () => void;
  stopProducers: Array<() => Promise<unknown> | undefined>;
  persistIndexes: () => Promise<void>;
  flushWrites: () => Promise<void>;
  closeTransports: () => Promise<void>;
  clearPidfile: () => void;
  exit?: (code: number) => void;
  markFailedExit?: () => void;
  report?: (status: WorkerShutdownStatus) => void;
  warn?: (message: string) => void;
}) {
  const exit = options.exit ?? (code => { process.exit(code); });
  const markFailedExit = options.markFailedExit ?? (() => { process.exitCode = 1; });
  const warn = (message: string) => {
    try { (options.warn ?? console.warn)(message); } catch { /* Diagnostic output cannot interrupt shutdown. */ }
  };
  let current: WorkerShutdownStatus = { state: "running", stage: "idle", workerPid: process.pid,
    runId: process.env.AGENTMEMORY_DIAGNOSTICS_RUN_ID ?? null, startedAt: null, updatedAt: new Date().toISOString(), failures: [] };
  let pending: Promise<void> | undefined;
  const status = () => structuredClone(current);
  const publish = () => {
    current.updatedAt = new Date().toISOString();
    try { options.report?.(status()); }
    catch { warn("[agentmemory] Shutdown status reporting unavailable"); }
  };
  const request = (): Promise<void> => {
    if (pending) return pending;
    current.state = "stopping"; current.stage = "producers"; current.startedAt = new Date().toISOString(); publish();
    const producers: Array<Promise<unknown> | undefined> = [];
    try { options.stopTimers(); } catch (error) { producers.push(Promise.reject(error)); }
    for (const stop of options.stopProducers) {
      try { producers.push(stop()); } catch (error) { producers.push(Promise.reject(error)); }
    }
    const warning = setTimeout(() => {
      warn("[agentmemory] Shutdown pending: " + JSON.stringify(status()));
      if (!options.managed) { options.clearPidfile(); exit(1); }
    }, SHUTDOWN_HARD_EXIT_MS);
    warning.unref();
    pending = (async () => {
      try {
        await finishShutdown(producers, options.persistIndexes, options.flushWrites, async () => {
          if (options.managed) await stopManagedWrapperTransports(managedShutdownBridge());
          await options.closeTransports();
        }, (stage, failures) => {
          current.stage = stage;
          current.failures = failures.map(failure => ({ stage: failure.stage, reason: failure.stage + "_failed" }));
          publish();
        });
        options.clearPidfile(); current.state = "stopped"; current.stage = "complete"; publish(); exit(0);
      } catch (error) {
        const failures: ShutdownFailure[] = error instanceof ShutdownPhaseError ? error.failures : [{ stage: "transports", cause: error }];
        current.state = "failed"; current.stage = failures.at(-1)!.stage;
        current.failures = failures.map(failure => ({ stage: failure.stage, reason: failure.stage + "_failed" }));
        markFailedExit(); publish();
        warn("[agentmemory] Shutdown incomplete: " + JSON.stringify(status()));
        if (!options.managed) { options.clearPidfile(); exit(1); }
      } finally { clearTimeout(warning); }
    })();
    return pending;
  };
  if (options.managed) {
    const bridge = managedShutdownBridge(); bridge.request = request;
    if (bridge.requested) queueMicrotask(() => { void request(); });
  }
  return { request, status };
}

export async function settleWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), ms); });
  try { return await Promise.race([work.then(() => true), expiry]); }
  finally { clearTimeout(timer); }
}
