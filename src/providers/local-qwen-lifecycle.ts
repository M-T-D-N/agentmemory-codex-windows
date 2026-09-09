import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 } from "node:path";
import { promisify } from "node:util";
import { getEnvVar } from "../config.js";
import { logger } from "../logger.js";

const execute = promisify(execFile);

export interface LocalQwenLifecycle {
  start(): Promise<{ ready: boolean; reason?: string }>;
  release(): Promise<boolean>;
}

export function createLocalQwenLifecycle(options: {
  platform?: string;
  script?: string;
  powershell?: string;
  exists?: (path: string) => boolean;
  invoke?: (executable: string, args: string[]) => Promise<string>;
} = {}): LocalQwenLifecycle | undefined {
  const script = options.script ?? getEnvVar("AGENTMEMORY_LOCAL_QWEN_LIFECYCLE_SCRIPT");
  const powershell = options.powershell ?? win32.join(
    process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe",
  );
  const exists = options.exists ?? existsSync;
  if ((options.platform ?? process.platform) !== "win32" || !script) return;
  if (!win32.isAbsolute(script) || win32.basename(script).toLowerCase() !== "invoke-localai.ps1"
    || !win32.isAbsolute(powershell) || !exists(script) || !exists(powershell)) {
    logger.warn("Local Qwen lifecycle unavailable: invalid host launcher");
    return;
  }
  const invoke = options.invoke ?? (async (executable: string, args: string[]) => {
    const env = { ...process.env };
    delete env.AGENTMEMORY_SECRET;
    // LocalAI owns the readiness deadline and exact service identity.
    // Killing its wrapper on a second timeout could orphan a GPU transition.
    const { stdout } = await execute(executable, args, {
      windowsHide: true, env, maxBuffer: 1024 * 1024,
    });
    return stdout;
  });
  let ownerToken: string | undefined;
  const call = async (args: string[]) => JSON.parse(await invoke(powershell, [
    "-NoProfile", "-NonInteractive", "-File", script, ...args,
  ])) as Record<string, unknown>;
  return {
    async start() {
      const result = await call(["-Operation", "start-qwen", "-Background"]);
      if (result.status === "deferred") {
        return { ready: false, reason: String(result.reason ?? "host_deferred") };
      }
      if (result.status !== "ready_owned") throw new Error("local_qwen_invalid_start_result");
      if (result.started_by_request === true) {
        const service = result.service as Record<string, unknown> | undefined;
        if (typeof service?.owner_token !== "string" || !/^[a-f0-9]{32}$/i.test(service.owner_token)) {
          throw new Error("local_qwen_missing_start_identity");
        }
        ownerToken = service.owner_token;
        logger.info("Semantic graph owns automatic Qwen instance", { service });
      }
      return { ready: true };
    },
    async release() {
      if (!ownerToken) return true;
      try {
        const result = await call(["-Operation", "stop-qwen", "-ExpectedOwnerToken", ownerToken]);
        if (result.status !== "stopped" && result.status !== "not_running") return false;
        ownerToken = undefined;
        logger.info("Semantic graph automatic Qwen instance released");
        return true;
      } catch {
        logger.info("Semantic graph Qwen release deferred by host ownership or active consumer guard");
        return false;
      }
    },
  };
}
