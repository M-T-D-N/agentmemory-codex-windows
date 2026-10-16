import { describe, expect, it, vi } from "vitest";
import { logger } from "../src/logger.js";
import { createLocalQwenLifecycle, localQwenChildEnvironment, localQwenBackgroundDeferral } from "../src/providers/local-qwen-lifecycle.js";

const config = {
  platform: "win32", script: "D:\\Workspace\\projects\\local-ai\\scripts\\Invoke-LocalAI.ps1",
  powershell: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", exists: () => true,
};
const token = "1234567890abcdef1234567890abcdef";

describe("host Qwen lifecycle", () => {
  it.each(["Path", "PATH", "path"])("preserves system tools with Windows %s casing and removes the service credential", (key) => {
    const source = { [key]: "C:\\Windows\\System32", agentmemory_secret: "private", TEMP: "C:\\Temp" };
    const env = localQwenChildEnvironment(config.powershell, source);
    expect(env.PATH).toBe("C:\\Program Files\\PowerShell\\7;C:\\Windows\\System32");
    expect(Object.keys(env).filter((k) => k.toLowerCase() === "path")).toEqual(["PATH"]);
    expect(env.agentmemory_secret).toBeUndefined();
    expect(env.TEMP).toBe("C:\\Temp");
    expect(source[key]).toBe("C:\\Windows\\System32");
  });
  it("resolves portable PowerShell from absolute PATH entries without a Program Files install", async () => {
    const previous = process.env.PATH;
    process.env.PATH = 'relative;"D:\\Portable PowerShell"';
    try {
      const invoke = vi.fn(async () => JSON.stringify({ status: "deferred", reason: "test" }));
      const host = createLocalQwenLifecycle({
        platform: "win32", script: config.script,
        exists: (p) => [config.script, "D:\\Portable PowerShell\\pwsh.exe"].includes(p), invoke,
      })!;
      expect(host).toBeDefined();
      await host.start();
      expect(invoke.mock.calls[0]?.[0]).toBe("D:\\Portable PowerShell\\pwsh.exe");
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    }
  });
  it("only enables a present, explicit Windows host script", () => {
    expect(createLocalQwenLifecycle({ ...config, platform: "linux" })).toBeUndefined();
    expect(createLocalQwenLifecycle({ ...config, script: "relative.ps1" })).toBeUndefined();
    expect(createLocalQwenLifecycle({ ...config, exists: () => false })).toBeUndefined();
  });
  it("preserves manual hold and never substitutes foreground start", async () => {
    const invoke = vi.fn(async () => JSON.stringify({ status: "deferred", reason: "background_held" }));
    const host = createLocalQwenLifecycle({ ...config, invoke })!;
    expect(await host.start()).toEqual({ ready: false, reason: "background_held" });
    expect(await host.release()).toBe(true);
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]).toEqual([config.powershell, [
      "-NoProfile", "-NonInteractive", "-File", config.script,
      "-Operation", "start-qwen", "-Background",
    ]]);
  });
  it("does not stop a borrowed instance", async () => {
    const invoke = vi.fn(async () => JSON.stringify({ status: "ready_owned", started_by_request: false }));
    const host = createLocalQwenLifecycle({ ...config, invoke })!;
    await host.start();
    expect(await host.release()).toBe(true);
    expect(invoke).toHaveBeenCalledOnce();
  });
  it("retains exact ownership when a consumer defers release", async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ status: "ready_owned", started_by_request: true, service: { owner_token: token } }))
      .mockRejectedValueOnce(new Error("process_marker_active"))
      .mockResolvedValueOnce(JSON.stringify({ status: "stopped" }));
    const host = createLocalQwenLifecycle({ ...config, invoke })!;
    await host.start();
    expect(await host.release()).toBe(false);
    expect(await host.release()).toBe(true);
    expect(await host.release()).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(invoke.mock.calls[1]![1]).toEqual(invoke.mock.calls[2]![1]);
    expect(invoke.mock.calls[2]![1]).toContain(token);
  });
  it("rejects a startup result with missing ownership", async () => {
    const host = createLocalQwenLifecycle({ ...config, invoke: async () => JSON.stringify({
      status: "ready_owned", started_by_request: true,
    }) })!;
    await expect(host.start()).rejects.toThrow("local_qwen_missing_start_identity");
  });
});


describe("read-only host background admission", () => {
  it("reads only the host config and follows its strict boolean contract", () => {
    for (const value of [false, undefined, "true", 1]) expect(localQwenBackgroundDeferral({script:config.script,
      read: path => { expect(path).toBe("D:\\Workspace\\projects\\local-ai\\config.json"); return JSON.stringify({qwen:{background_start_enabled:value}}); }
    })).toBe("background_held");
    expect(localQwenBackgroundDeferral({script:config.script,read:()=>'{"qwen":{"background_start_enabled":true}}'})).toBeUndefined();
    expect(localQwenBackgroundDeferral({script:config.script,read:()=>{throw Error("read failed");}})).toBe("background_policy_unknown");
    expect(localQwenBackgroundDeferral({script:"relative.ps1"})).toBe("background_policy_unknown");
  });
});

describe("host Qwen response privacy", () => {
  it.each(["owned", "borrowed", "deferred", "malformed-status", "malformed-identity", "malformed-json", "invoke-failure", "deferred-secret", "release-retry"])(
    "never exposes host response fields for %s", async (scenario) => {
      const secret = "synthetic-host-secret-do-not-log";
      const modelPath = "D:\\Synthetic Private Models\\fixture.gguf";
      const service = { owner_token: token, secret, model_path: modelPath, nested: { credential: secret } };
      const response: Record<string, unknown> = { status: "ready_owned", started_by_request: true, service };
      if (scenario === "borrowed") response.started_by_request = false;
      if (scenario === "deferred") Object.assign(response, { status: "deferred", reason: "background_held" });
      if (scenario === "malformed-status") response.status = "invalid";
      if (scenario === "malformed-identity") response.service = { ...service, owner_token: "invalid" };
      if (scenario === "deferred-secret") Object.assign(response, { status: "deferred", reason: secret });
      const invoke = vi.fn();
      if (scenario === "invoke-failure") invoke.mockRejectedValueOnce(new Error(secret));
      else invoke.mockResolvedValueOnce(scenario === "malformed-json" ? "owner_token:" + token : JSON.stringify(response));
      if (scenario === "release-retry") invoke.mockRejectedValueOnce(new Error(secret));
      invoke.mockResolvedValue(JSON.stringify({ status: "stopped", service }));
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const info = vi.spyOn(logger, "info");
      const warn = vi.spyOn(logger, "warn");
      const error = vi.spyOn(logger, "error");
      try {
        const host = createLocalQwenLifecycle({ ...config, invoke })!;
        if (scenario.startsWith("malformed") || scenario === "invoke-failure") {
          const failure = await host.start().then(() => null, (error: Error) => error);
          expect(failure).toBeInstanceOf(Error);
          logger.warn("Synthetic caller startup failure", { error: failure?.message });
        } else {
          const start = await host.start();
          if (!start.ready) logger.info("Synthetic caller startup deferred", { reason: start.reason });
        }
        if (scenario === "release-retry") expect(await host.release()).toBe(false);
        expect(await host.release()).toBe(true);
        if (scenario === "owned" || scenario === "release-retry") {
          const releases = invoke.mock.calls.slice(1);
          expect(releases.length).toBe(scenario === "release-retry" ? 2 : 1);
          for (const call of releases) expect(call[1]).toEqual([
            "-NoProfile", "-NonInteractive", "-File", config.script,
            "-Operation", "stop-qwen", "-ExpectedOwnerToken", token,
          ]);
        } else expect(invoke).toHaveBeenCalledOnce();
        const captured = JSON.stringify({ stderr: stderr.mock.calls, info: info.mock.calls, warn: warn.mock.calls, error: error.mock.calls });
        for (const forbidden of [token, secret, modelPath, "owner_token", "model_path", "credential"]) expect(captured).not.toContain(forbidden);
      } finally { stderr.mockRestore(); info.mockRestore(); warn.mockRestore(); error.mockRestore(); }
    },
  );
});
