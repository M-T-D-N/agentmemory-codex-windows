export const MANAGED_SHUTDOWN_BRIDGE = Symbol.for("agentmemory.managed-shutdown.v1");

export interface ManagedShutdownBridge {
  version: 1;
  requested: boolean;
  stoppers: Array<() => Promise<unknown>>;
  listeners: Set<() => void>;
  request?: () => Promise<void>;
}

export function managedShutdownBridge(): ManagedShutdownBridge {
  const host = globalThis as typeof globalThis & { [MANAGED_SHUTDOWN_BRIDGE]?: ManagedShutdownBridge };
  return host[MANAGED_SHUTDOWN_BRIDGE] ??= { version: 1, requested: false, stoppers: [], listeners: new Set() };
}

export async function stopManagedWrapperTransports(bridge: ManagedShutdownBridge): Promise<void> {
  const outcomes = await Promise.allSettled(bridge.stoppers.map(stop => Promise.resolve().then(stop)));
  const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
  if (failures.length) throw new AggregateError(failures.map(outcome => outcome.reason), "Managed wrapper transport stop failed");
}
