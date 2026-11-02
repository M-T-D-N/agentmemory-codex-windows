import { execFileSync, type ChildProcess } from "node:child_process";
import { join } from "node:path";

export type ChildIdentity = { pid: number; parent: number; created: string; executable: string; command: string };
export function readChildIdentity(pid: number): ChildIdentity | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw Error("Invalid child PID");
  const script = "$ErrorActionPreference='Stop'; $r=Get-CimInstance Win32_Process -Filter 'ProcessId = "+pid+"'; if($r){[pscustomobject]@{pid=[int]$r.ProcessId;parent=[int]$r.ParentProcessId;created=$r.CreationDate.ToUniversalTime().ToString('o');executable=$r.ExecutablePath;command=$r.CommandLine}|ConvertTo-Json -Compress}";
  const text = execFileSync(join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 15000 }).trim();
  if (!text) return null;
  const value = JSON.parse(text) as ChildIdentity;
  if (value.pid !== pid || !Number.isSafeInteger(value.parent) || !value.created || !value.executable || !value.command) throw Error("Incomplete child identity");
  return value;
}
export async function stopOwnedChild(child: ChildProcess, owner: ChildIdentity,
  read: (pid: number) => ChildIdentity | null, record: (event: object) => void,
  graceMs = 5000): Promise<void> {
  const ended = () => child.exitCode !== null || child.signalCode !== null;
  if (ended()) { record({ phase: "already-exited", identity: owner }); return; }
  let resolveExit!: () => void;
  const exited = new Promise<void>(resolve => { resolveExit = resolve; });
  child.once("exit", resolveExit);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const signal = (kind: "SIGTERM" | "SIGKILL") => {
    if (ended()) { record({ phase: "already-exited", identity: owner }); return; }
    let current: ChildIdentity | null;
    try { current = read(owner.pid); }
    catch (error) { record({ phase: "query-failed", identity: owner }); throw Error("Child identity query failed", { cause: error }); }
    const fields = ["pid", "parent", "created", "executable", "command"] as const;
    if (!current || fields.some(key => current![key] !== owner[key])) {
      record({ phase: current ? "identity-mismatch" : "identity-absent", identity: owner });
      throw Error("Child ownership cannot be verified; refusing signal");
    }
    if (!child.kill(kind)) throw Error("Verified child signal failed");
    record({ phase: kind, identity: owner });
  };
  const wait = async () => {
    try { return await Promise.race([exited.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), graceMs); })]); }
    finally { if (timer) clearTimeout(timer); timer = undefined; }
  };
  try {
    signal("SIGTERM");
    if (!ended() && !await wait()) {
      signal("SIGKILL");
      if (!ended() && !await wait()) throw Error("Verified child did not exit");
    }
    record({ phase: "exited", identity: owner });
  } finally {
    if (timer) clearTimeout(timer);
    child.removeListener("exit", resolveExit);
  }
}
