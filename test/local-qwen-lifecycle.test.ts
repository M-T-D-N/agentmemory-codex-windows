import { describe, expect, it, vi } from "vitest";
import { createLocalQwenLifecycle } from "../src/providers/local-qwen-lifecycle.js";

const config = {
  platform: "win32", script: "D:\\Workspace\\projects\\local-ai\\scripts\\Invoke-LocalAI.ps1",
  powershell: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", exists: () => true,
};
const token = "1234567890abcdef1234567890abcdef";

describe("host Qwen lifecycle", () => {
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
