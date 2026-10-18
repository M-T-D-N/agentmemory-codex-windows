import { execFile } from "node:child_process";
import { win32 } from "node:path";
import { fileURLToPath } from "node:url";

export async function invokeQwenCoordination(request: Record<string, unknown>): Promise<Record<string, any>> {
  if (process.platform !== "win32") throw Error("local_qwen_coordination_unsupported_host");
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!["AGENTMEMORY_SECRET", "PSMODULEPATH"].includes(key.toUpperCase())) env[key.toUpperCase()] = value;
  }
  const systemRoot = env.SYSTEMROOT ?? "C:\\Windows";
  if (!win32.isAbsolute(systemRoot)) throw Error("local_qwen_coordination_invalid_host");
  const executable = win32.join(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
  env.PSMODULEPATH = win32.join(systemRoot, "System32/WindowsPowerShell/v1.0/Modules");
  const script = fileURLToPath(new URL("./local-qwen-coordination.ps1", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = execFile(executable, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
      { env, windowsHide: true, timeout: 10000, maxBuffer: 16384, encoding: "utf8" }, (error, stdout) => {
        if (error) { reject(Object.assign(Error("local_qwen_coordination_process_failed"), { code: "EIO", operationOutcomeUnknown: true })); return; }
        let result: Record<string, any>;
        try { result = JSON.parse(stdout.replace(/^\uFEFF/, "").trim()); }
        catch { reject(Object.assign(Error("local_qwen_coordination_invalid_result"), { operationOutcomeUnknown: true })); return; }
        if (result?.ok !== true) {
          const reason = typeof result?.reason === "string" && /^[a-z_]{1,64}$/.test(result.reason) ? result.reason : "unknown";
          const deferred = ["lease_busy", "foreground_requested", "coordination_busy"].includes(reason);
          reject(Object.assign(Error((deferred ? "local_qwen_deferred:" : "local_qwen_coordination_failed:") + reason),
            { code: ["EBUSY", "EPERM", "EEXIST", "EIO"].includes(result.errorCode) ? result.errorCode : undefined, notPublished: deferred })); return;
        }
        resolve(result);
      });
    child.stdin?.on("error", () => {}); // The process outcome above owns pipe/exit failures.
    child.stdin?.end(JSON.stringify(request));
  });
}
