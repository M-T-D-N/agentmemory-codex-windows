import { createWorkerShutdown } from "./shutdown.js";
import type { WorkerMutationLifecycle } from "./worker-lifecycle.js";

type ShutdownOptions = Parameters<typeof createWorkerShutdown>[0];
// Production composition shared by main and isolated process tests. External
// transport/storage boundaries remain supplied by the real runtime or fixture.
export function createWorkerRuntimeShutdown(options: Omit<ShutdownOptions, "stopTimers" | "stopProducers"> & {
  lifecycle: WorkerMutationLifecycle;
  stopTimers: () => void;
  stopProducers: ShutdownOptions["stopProducers"];
}) {
  const { lifecycle, stopTimers, stopProducers, ...shutdown } = options;
  return createWorkerShutdown({ ...shutdown,
    stopTimers: () => { lifecycle.closeAdmission(); stopTimers(); },
    stopProducers: [() => lifecycle.stop(), ...stopProducers],
  });
}
