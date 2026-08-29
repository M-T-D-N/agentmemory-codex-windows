import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// #640 + #474: stop must also kill the worker process, not just the
// iii engine. The worker and CLI share one canonical pidfile module so
// path and cleanup behavior cannot drift between the two entrypoints.
describe("stop reaps the worker process (#640, #474)", () => {
  it("the worker writes and clears the shared pidfile", () => {
    const source = readFileSync("src/index.ts", "utf-8");
    expect(source).toMatch(/from "\.\/worker-pidfile\.js"/);
    expect(source).toMatch(/writeWorkerPidfile\(\)/);
    expect(source).toMatch(/clearWorkerPidfile\(\)/);
  });

  it("src/cli.ts reads worker.pid in runStop and signals it on stop", () => {
    const source = readFileSync("src/cli.ts", "utf-8");
    expect(source).toMatch(/from "\.\/worker-pidfile\.js"/);
    expect(source).toMatch(/readWorkerPidfile\(\)/);
    expect(source).toMatch(/clearWorkerPidfile\(\)/);
    // Verify stop wiring: workerCandidates set is built from the pidfile
    // and signaled alongside the engine pids.
    expect(source).toMatch(/workerCandidates/);
    expect(source).toMatch(/Stopping agentmemory worker/);
  });

  it("defines ~/.agentmemory/worker.pid exactly once", () => {
    const source = readFileSync("src/worker-pidfile.ts", "utf-8");
    expect(source).toMatch(/join\(homedir\(\), "\.agentmemory", "worker\.pid"\)/);
    expect(source).toMatch(/export function readWorkerPidfile/);
    expect(source).toMatch(/export function writeWorkerPidfile/);
    expect(source).toMatch(/export function clearWorkerPidfile/);
  });
});
