import { AsyncLocalStorage } from "node:async_hooks";
import type { ISdk } from "iii-sdk";

const context = new AsyncLocalStorage<{ exclusive: boolean; active: boolean }>();
let writers = 0;
let exclusive: Promise<void> | undefined;

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
  finally { current.active = false; writers--; }
}

export async function withObservationRecovery<T>(work: () => Promise<T>): Promise<T> {
  if (context.getStore()?.active || exclusive || writers > 0) {
    throw new Error("Observation writers are active; recovery made no changes. Retry after they finish.");
  }
  let release!: () => void;
  exclusive = new Promise<void>((resolve) => { release = resolve; });
  const current = { exclusive: true, active: true };
  try { return await context.run(current, work); }
  finally { current.active = false; exclusive = undefined; release(); }
}

export function registerObservationWriter<T, R>(
  sdk: ISdk, id: string, handler: (data: T) => Promise<R>,
): void {
  sdk.registerFunction(id, (data: T) => withObservationWrite(() => handler(data)));
}
