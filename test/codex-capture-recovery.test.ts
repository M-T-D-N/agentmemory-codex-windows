import { listenForFetch } from "./helpers/http-port.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockKV, mockSdk } from "./helpers/mocks.js";
import { registerObserveFunction } from "../src/functions/observe.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { DedupMap } from "../src/functions/dedup.js";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe("Codex capture recovery and response attribution", () => {
  let kv: ReturnType<typeof mockKV>;
  let sdk: ReturnType<typeof mockSdk>;
  const identity = { sessionId: "capture-session", project: "project-a", cwd: "/a" };
  const prompt = (turn = "normal-1", text = "Keep the verified project boundary") =>
    sdk.trigger("mem::observe", { ...identity, hookType: "prompt_submit",
      timestamp: "2026-09-07T00:00:00Z", data: { prompt: text, codex_turn_id: turn } }) as Promise<any>;
  const stop = (turn = "normal-1") =>
    sdk.trigger("mem::observe", { ...identity, hookType: "post_tool_use",
      timestamp: "2026-09-07T00:00:01Z", data: {
        codex_turn_id: turn, tool_name: "assistant_response",
        tool_input: { turn_id: turn }, tool_output: "Verified final answer",
      } }) as Promise<any>;
  const exclude = (reason = "codex_internal_prompt", turnId = "internal-1") =>
    sdk.trigger("api::session::exclude", { body: { ...identity, reason, turnId } }) as Promise<any>;
  const session = () => kv.get<any>("mem:sessions", identity.sessionId);

  beforeEach(async () => {
    kv = mockKV();
    sdk = mockSdk({ looseTrigger: true });
    registerApiTriggers(sdk as never, kv as never, async () => ({ context: "", blocks: 0, tokens: 0 }));
    registerObserveFunction(sdk as never, kv as never, new DedupMap());
    await kv.set("mem:sessions", identity.sessionId, {
      id: identity.sessionId, project: identity.project, cwd: identity.cwd,
      startedAt: "2026-09-07T00:00:00Z", status: "active", observationCount: 0,
    });
  });

  it("preserves normal history across internal requests and rejects their delayed responses", async () => {
    expect((await prompt()).observationId).toBeTruthy();
    expect((await exclude()).body).toMatchObject({ preservedActiveSession: true });
    expect((await session()).captureExcluded).not.toBe(true);
    expect(await stop("internal-1")).toMatchObject({ skipped: true });
    expect((await prompt("normal-2", "Next normal request")).observationId).toBeTruthy();
    expect(await stop("internal-1")).toMatchObject({ skipped: true });
    expect((await stop("normal-2")).observationId).toBeTruthy();
    expect((await session()).observationCount).toBe(3);
  });

  it("recovers only automatic exclusion on an exact normal Codex request", async () => {
    await exclude();
    expect((await session()).captureExcluded).toBe(true);
    expect(await stop("internal-1")).toMatchObject({ skipped: true });
    expect((await prompt()).observationId).toBeTruthy();
    expect(await session()).toMatchObject({
      captureExcluded: false, captureExclusionReason: null, codexCaptureTurnId: "normal-1",
    });
    expect((await stop()).observationId).toBeTruthy();
    expect(await kv.list("mem:audit")).toContainEqual(expect.objectContaining({
      operation: "session_capture_reactivated",
    }));
  });

  it("preserves manual exclusion and rejects missing or mismatched response attribution", async () => {
    expect(await stop()).toMatchObject({ skipped: true });
    await prompt();
    expect(await stop("")).toMatchObject({ skipped: true });
    expect(await stop("unknown")).toMatchObject({ skipped: true });
    await exclude("manual");
    expect(await prompt("normal-2")).toMatchObject({ skipped: true });
    expect((await session()).captureExclusionReason).toBe("manual");
    expect(await stop()).toMatchObject({ skipped: true });
  });

  it("keeps a manual exclusion applied after an automatic exclusion", async () => {
    await exclude();
    await exclude("manual");
    expect(await prompt()).toMatchObject({ skipped: true });
    expect((await session()).captureExclusionReason).toBe("manual");
  });

  it("reactivates a deduplicated normal prompt and permits only its current response", async () => {
    await prompt();
    await kv.update("mem:sessions", identity.sessionId, [
      { type: "set", path: "captureExcluded", value: true },
      { type: "set", path: "captureExclusionReason", value: "codex_internal_prompt" },
      { type: "set", path: "firstPrompt", value: "<environment_context>ambient</environment_context>" },
    ]);
    expect(await prompt("normal-2")).toMatchObject({ deduplicated: true });
    expect(await session()).toMatchObject({ observationCount: 1, captureExcluded: false,
      firstPrompt: "Keep the verified project boundary", codexCaptureTurnId: "normal-2" });
    expect(await stop()).toMatchObject({ skipped: true });
    expect((await stop("normal-2")).observationId).toBeTruthy();
  });

  it.each([["project", "project-b"], ["cwd", "/b"]])("rejects a duplicate with wrong %s before changing capture", async (field, value) => {
    await prompt();
    await exclude("manual");
    const result = await sdk.trigger("mem::observe", {
      ...identity, [field]: value, hookType: "prompt_submit",
      timestamp: "2026-09-07T00:00:00Z",
      data: { prompt: "Keep the verified project boundary", codex_turn_id: "normal-2" },
    });
    expect(result).toMatchObject({ success: false });
    expect((await session()).captureExclusionReason).toBe("manual");
  });

  it("serializes automatic exclusion with normal observation writes", async () => {
    const results = await Promise.all([exclude(), prompt()]);
    expect(results[1].observationId).toBeTruthy();
    expect((await session()).captureExcluded).not.toBe(true);
    expect((await stop()).observationId).toBeTruthy();
  });

  it("invalidates an internal request sharing the current turn without hiding normal history", async () => {
    await prompt();
    await exclude("codex_internal_prompt", "normal-1");
    expect((await session()).captureExcluded).not.toBe(true);
    expect(await stop()).toMatchObject({ skipped: true });
  });

  it("runs the real hook through HTTP for normal, internal and recovered turns", async () => {
    const temp = mkdtempSync(join(tmpdir(), "am-hook-recovery-"));
    const registry = join(temp, "project-repositories.json");
    const cwd = join(temp, "project-a");
    mkdirSync(cwd);
    writeFileSync(registry, JSON.stringify({ projects: [{ id: "project-a", path: "project-a" }] }));
    await kv.update("mem:sessions", identity.sessionId, [{ type: "set", path: "cwd", value: cwd }]);
    const calls: string[] = [];
    const server = createServer(async (req, res) => {
      try {
        let input = "";
        for await (const chunk of req) input += chunk;
        const body = input ? JSON.parse(input) : {};
        const path = new URL(req.url!, "http://127.0.0.1").pathname;
        calls.push(path);
        let result: any = { sessions: [], nodes: [], edges: [], results: [] };
        if (path === "/agentmemory/observe") result = await sdk.trigger("mem::observe", body);
        if (path === "/agentmemory/session/exclude") {
          const response = await sdk.trigger("api::session::exclude", { body }) as any;
          res.statusCode = response.status_code;
          result = response.body;
        }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result));
      } catch (error) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(error) }));
      }
    });
    await listenForFetch(server);
    const address = server.address() as { port: number };
    async function run(event: Record<string, unknown>, expectedCode = 0) {
      const child = spawn(process.execPath, [resolve("packaging/windows-codex/hooks/codex-turn.mjs")], {
        env: { ...process.env, AGENTMEMORY_URL: "http://127.0.0.1:" + address.port,
          AGENTMEMORY_SECRET: "", AGENTMEMORY_WORKSPACE_ROOT: temp,
          AGENTMEMORY_PROJECT_REGISTRY: registry },
        stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      });
      let stderr = "";
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.stdout.resume();
      child.stdin.end(JSON.stringify({ session_id: identity.sessionId, cwd, ...event }));
      const timeout = setTimeout(() => child.kill(), 5000);
      try {
        const [code] = await once(child, "close");
        expect(code, stderr).toBe(expectedCode);
      } finally { clearTimeout(timeout); }
    }
    try {
      await run({ hook_event_name: "UserPromptSubmit", turn_id: "hook-normal-1", prompt: "Normal user request" });
      await run({ hook_event_name: "Stop", turn_id: "hook-normal-1", last_assistant_message: "Normal final answer" });
      await run({ hook_event_name: "UserPromptSubmit", turn_id: "hook-internal",
        prompt: "<environment_context>internal host state</environment_context>" });
      await run({ hook_event_name: "Stop", turn_id: "hook-internal", last_assistant_message: "Internal answer" });
      await run({ hook_event_name: "UserPromptSubmit", turn_id: "hook-normal-2", prompt: "Next normal request" });
      await run({ hook_event_name: "Stop", turn_id: "hook-internal", last_assistant_message: "Late internal answer" });
      await run({ hook_event_name: "Stop", turn_id: "hook-normal-2", last_assistant_message: "Next normal answer" });
      await run({ hook_event_name: "Stop", last_assistant_message: "Unattributed answer" }, 1);
      const observations = await kv.list<any>("mem:obs:" + identity.sessionId);
      expect(observations.map(o => o.narrative)).toEqual([
        "Normal user request", "Normal final answer", "Next normal request", "Next normal answer",
      ]);
      expect(calls).toContain("/agentmemory/session/exclude");
      expect((await session()).captureExcluded).not.toBe(true);
    } finally {
      await new Promise<void>(resolveClose => server.close(() => resolveClose()));
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("does not grant response capture when a normal observation fails to persist", async () => {
    const original = kv.set;
    kv.set = vi.fn(async (...args: Parameters<typeof original>) => {
      if (args[0] === "mem:obs:capture-session") throw new Error("write failed");
      return original(...args);
    }) as typeof kv.set;
    await expect(prompt()).rejects.toThrow("write failed");
    expect(await stop()).toMatchObject({ skipped: true });
  });
});
