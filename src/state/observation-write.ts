import { runtimeDiagnosticPhase } from "../telemetry/runtime-diagnostics.js";
import { AsyncLocalStorage } from "node:async_hooks";
import type { IIIClient } from "iii-sdk";

const context = new AsyncLocalStorage<{ exclusive: boolean; active: boolean }>();
let writers = 0;
let exclusive: Promise<void> | undefined;
let writersDrained: (() => void) | undefined;

export function inObservationRecovery(): boolean {
  const current = context.getStore();
  return current?.active === true && current.exclusive;
}

export async function withObservationWrite<T>(work: () => Promise<T>): Promise<T> {
  if (context.getStore()?.active) return work();
  while (exclusive) await exclusive;
  writers++;
  const current = { exclusive: false, active: true };
  try { return await context.run(current, work); }
  finally { current.active = false; writers--; if (writers === 0) writersDrained?.(); }
}

export async function withObservationRecovery<T>(
  work: () => Promise<T>,
  waitMs = process.env.AGENTMEMORY_FORCE_PROXY === "true" && process.env.AGENTMEMORY_AUTO_COMPRESS === "false" ? 5000 : 0,
): Promise<T> {
  const rejectBusy = () => {
    runtimeDiagnosticPhase("recovery.rejected", { writers, exclusive: exclusive ? 1 : 0, reentrant: context.getStore()?.active ? 1 : 0, mutationStarted: 0 });
    return new Error("Observation writers are active; recovery made no changes. Retry after they finish.");
  };
  if (context.getStore()?.active || exclusive || (writers > 0 && waitMs <= 0)) throw rejectBusy();
  let release!: () => void;
  exclusive = new Promise<void>((resolve) => { release = resolve; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const current = { exclusive: true, active: true };
  try {
    if (writers > 0) {
      runtimeDiagnosticPhase("recovery.waiting", { writers, waitMs, mutationStarted: 0 });
      await new Promise<void>((resolve, reject) => {
        writersDrained = resolve;
        timer = setTimeout(() => reject(rejectBusy()), waitMs);
      });
    }
    runtimeDiagnosticPhase("recovery.acquired", { writers, mutationStarted: 0 });
    return await context.run(current, work);
  } finally {
    if (timer) clearTimeout(timer);
    writersDrained = undefined;
    current.active = false; exclusive = undefined; release();
  }
}
export function registerObservationWriter<T, R>(
  sdk: IIIClient, id: string, handler: (data: T) => Promise<R>,
): void {
  sdk.registerFunction(id, (data: T) => withObservationWrite(() => handler(data)));
}
