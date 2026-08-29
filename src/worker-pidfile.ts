import {
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function workerPidfilePath(): string {
  return join(homedir(), ".agentmemory", "worker.pid");
}

export function readWorkerPidfile(): number | null {
  try {
    const pid = Number.parseInt(
      readFileSync(workerPidfilePath(), "utf-8").trim(),
      10,
    );
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function writeWorkerPidfile(pid = process.pid): void {
  try {
    const path = workerPidfilePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${pid}\n`, { encoding: "utf-8" });
  } catch {
    // Best effort: stop still has the engine pidfile and port scan fallback.
  }
}

export function clearWorkerPidfile(): void {
  try {
    unlinkSync(workerPidfilePath());
  } catch {
    // Missing and already-removed pidfiles are both acceptable.
  }
}
