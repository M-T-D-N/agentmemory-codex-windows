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

export function localQwenChildEnvironment(
  executable: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...source };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
  const inheritedPath = pathKey ? env[pathKey] : undefined;
  for (const key of Object.keys(env)) {
    if (["path", "agentmemory_secret"].includes(key.toLowerCase())) delete env[key];
  }
  env.PATH = [win32.dirname(executable), inheritedPath].filter(Boolean).join(";");
  return env;
}

export function createLocalQwenLifecycle(options: {
  platform?: string;
  script?: string;
  powershell?: string;
  exists?: (path: string) => boolean;
  invoke?: (executable: string, args: string[]) => Promise<string>;
} = {}): LocalQwenLifecycle | undefined {
  const script = options.script ?? getEnvVar("AGENTMEMORY_LOCAL_QWEN_LIFECYCLE_SCRIPT");
  const exists = options.exists ?? existsSync;
  if ((options.platform ?? process.platform) !== "win32" || !script) return;
  const powershell = options.powershell ?? [
    ...(process.env.PATH ?? "").split(";").map((entry) => entry.trim().replace(/^"|"$/g, ""))
      .filter((entry) => win32.isAbsolute(entry)).map((entry) => win32.join(entry, "pwsh.exe")),
    win32.resolve(win32.dirname(process.execPath), "..", "..", "native", "powershell", "pwsh.exe"),
    win32.join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe"),
  ].find(exists);
  if (!win32.isAbsolute(script) || win32.basename(script).toLowerCase() !== "invoke-localai.ps1"
    || !powershell || !win32.isAbsolute(powershell) || !exists(script) || !exists(powershell)) {
    logger.warn("Local Qwen lifecycle unavailable: invalid host launcher");
    return;
  }
  const invoke = options.invoke ?? (async (executable: string, args: string[]) => {
    const env = localQwenChildEnvironment(executable);
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
