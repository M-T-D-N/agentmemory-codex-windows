import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    store,
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    update: async (scope: string, key: string, updates: Array<{ path: string; value: unknown }>) => {
      const m = store.get(scope);
      if (!m) return;
      const v = (m.get(key) as Record<string, unknown>) ?? {};
      for (const u of updates) v[u.path] = u.value;
      m.set(key, v);
    },
    delete: async (scope: string, key: string) => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const m = store.get(scope);
      return m ? (Array.from(m.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const fns = new Map<string, Function>();
  return {
    fns,
    registerFunction: (
      idOrOpts: string | { id: string },
      fn: Function,
    ) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      fns.set(id, fn);
    },
    trigger: async (
      idOrInput: string | { function_id: string; payload: unknown; action?: unknown },
      data?: unknown,
    ) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = fns.get(id);
      if (fn) return fn(payload);
      return null;
    },
  };
}

describe("observe implicit session create (#638)", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("creates the session on first observe when project+cwd present and session record missing", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::observe", {
      sessionId: "ses_opencode_abc",
      project: "/home/user/myrepo",
      cwd: "/home/user/myrepo",
      hookType: "prompt_submit",
      timestamp: new Date().toISOString(),
      data: { prompt: "ship the helm chart" },
    })) as { observationId: string };

    expect(result.observationId).toBeTruthy();

    const sessionScope = kv.store.get("mem:sessions");
    expect(sessionScope).toBeTruthy();
    const session = sessionScope!.get("ses_opencode_abc") as Record<string, unknown>;
    expect(session).toBeTruthy();
    expect(session.id).toBe("ses_opencode_abc");
    expect(session.project).toBe("/home/user/myrepo");
    expect(session.cwd).toBe("/home/user/myrepo");
    expect(session.status).toBe("active");
    expect(session.observationCount).toBe(1);
    expect(session.firstPrompt).toBe("ship the helm chart");
  });

  it("does not implicit-create when project+cwd missing (test-payload back-compat)", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    await sdk.trigger("mem::observe", {
      sessionId: "ses_no_project",
      hookType: "post_tool_use",
      timestamp: new Date().toISOString(),
      data: { tool_name: "Read", tool_input: { file_path: "x.ts" } },
    });

    const sessionScope = kv.store.get("mem:sessions");
    // Either no scope at all, or no entry for this session
    expect(sessionScope?.get("ses_no_project")).toBeUndefined();
  });

  it("rejects observations whose project conflicts with the existing session", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    await kv.set("mem:sessions", "ses_existing", {
      id: "ses_existing",
      project: "/orig/project",
      cwd: "/orig/cwd",
      startedAt: "2026-01-01T00:00:00Z",
      status: "active",
      observationCount: 7,
      firstPrompt: "original first prompt",
    });

    const result = await sdk.trigger("mem::observe", {
      sessionId: "ses_existing",
      project: "/different/project",
      cwd: "/different/cwd",
      hookType: "post_tool_use",
      timestamp: new Date().toISOString(),
      data: { tool_name: "Read" },
    });

    const session = kv.store.get("mem:sessions")!.get("ses_existing") as Record<string, unknown>;
    expect(result).toEqual({
      success: false,
      error: "Session project mismatch: /orig/project != /different/project",
    });
    expect(session.project).toBe("/orig/project");
    expect(session.firstPrompt).toBe("original first prompt");
    expect(session.observationCount).toBe(7);
    expect(kv.store.get("mem:obs:ses_existing")).toBeUndefined();
  });

  it("reopens graph backlog when a completed session receives a new tail", async () => {
    vi.stubEnv("GRAPH_EXTRACTION_ENABLED", "true");
    vi.resetModules();
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    await kv.set("mem:sessions", "ses_completed_tail", {
      id: "ses_completed_tail",
      project: "/project/a",
      cwd: "/project/a",
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: "2026-01-01T01:00:00Z",
      status: "completed",
      observationCount: 1,
      semanticGraphStatus: "complete",
      semanticGraphThroughObservationId: "obs_existing",
    });

    const result = await sdk.trigger("mem::observe", {
      sessionId: "ses_completed_tail",
      project: "/project/a",
      cwd: "/project/a",
      hookType: "prompt_submit",
      timestamp: "2026-01-01T02:00:00Z",
      data: { prompt: "tail captured before an abrupt shutdown" },
    });

    expect(result).toHaveProperty("observationId");
    const session = kv.store.get("mem:sessions")!.get("ses_completed_tail") as Record<string, unknown>;
    expect(session).toMatchObject({
      status: "completed",
      observationCount: 2,
      semanticGraphStatus: "pending",
      semanticGraphThroughObservationId: "obs_existing",
    });
  });

  it("reactivates an excluded ambient session on its first normal prompt", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    await kv.set("mem:sessions", "ses_internal", {
      id: "ses_internal",
      project: "/project/a",
      cwd: "/project/a",
      startedAt: "2026-01-01T00:00:00Z",
      status: "active",
      observationCount: 0,
      captureExcluded: true,
      captureExclusionReason: "codex_internal",
    });

    const result = await sdk.trigger("mem::observe", {
      sessionId: "ses_internal",
      project: "/project/a",
      cwd: "/project/a",
      hookType: "prompt_submit",
      timestamp: new Date().toISOString(),
      data: { prompt: "normal user recovery payload" },
    });

    expect(result).toHaveProperty("observationId");
    expect(kv.store.get("mem:obs:ses_internal")?.size).toBe(1);
    const session = kv.store.get("mem:sessions")!.get("ses_internal") as Record<string, unknown>;
    expect(session).toMatchObject({
      observationCount: 1,
      captureExcluded: false,
      captureExclusionReason: "",
      firstPrompt: "normal user recovery payload",
    });
    expect([...((kv.store.get("mem:audit") ?? new Map()).values())]).toEqual([
      expect.objectContaining({
        operation: "observe",
        functionId: "mem::observe",
        targetIds: ["ses_internal"],
        details: expect.objectContaining({ action: "session_capture_reactivated" }),
      }),
    ]);
  });

  it("keeps an excluded ambient session closed for assistant output", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    await kv.set("mem:sessions", "ses_internal_output", {
      id: "ses_internal_output",
      project: "/project/a",
      cwd: "/project/a",
      startedAt: "2026-01-01T00:00:00Z",
      status: "active",
      observationCount: 0,
      captureExcluded: true,
      captureExclusionReason: "codex_internal",
    });

    const result = await sdk.trigger("mem::observe", {
      sessionId: "ses_internal_output",
      project: "/project/a",
      cwd: "/project/a",
      hookType: "post_tool_use",
      timestamp: new Date().toISOString(),
      data: { tool_name: "assistant_response", tool_output: "internal title" },
    });

    expect(result).toEqual({
      success: true,
      skipped: true,
      captureExcluded: true,
      sessionId: "ses_internal_output",
    });
    expect(kv.store.get("mem:obs:ses_internal_output")).toBeUndefined();
  });

  it("reactivates even when the normal recovery prompt is inside the dedup window", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const { DedupMap } = await import("../src/functions/dedup.js");
    const sdk = mockSdk();
    const kv = mockKV();
    const dedup = new DedupMap();
    registerObserveFunction(sdk as never, kv as never, dedup);

    await kv.set("mem:sessions", "ses_repeated_recovery", {
      id: "ses_repeated_recovery",
      project: "/project/a",
      cwd: "/project/a",
      startedAt: "2026-01-01T00:00:00Z",
      status: "active",
      observationCount: 0,
    });
    const payload = {
      sessionId: "ses_repeated_recovery",
      project: "/project/a",
      cwd: "/project/a",
      hookType: "prompt_submit",
      timestamp: new Date().toISOString(),
      data: { prompt: "repeated normal prompt" },
    };
    await sdk.trigger("mem::observe", payload);
    await kv.update("mem:sessions", "ses_repeated_recovery", [
      { path: "captureExcluded", value: true },
      { path: "captureExclusionReason", value: "codex_internal" },
    ]);

    const result = await sdk.trigger("mem::observe", payload);
    dedup.stop();

    expect(result).toHaveProperty("observationId");
    const session = kv.store.get("mem:sessions")!.get("ses_repeated_recovery") as Record<string, unknown>;
    expect(session).toMatchObject({ observationCount: 2, captureExcluded: false });
    expect(kv.store.get("mem:obs:ses_repeated_recovery")?.size).toBe(2);
  });

  it("does not create a session for a structured Codex host prompt", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const result = await sdk.trigger("mem::observe", {
      sessionId: "ses_subagent_notification",
      project: "/project/a",
      cwd: "/project/a",
      hookType: "prompt_submit",
      timestamp: new Date().toISOString(),
      data: {
        prompt:
          '<subagent_notification>{"status":"completed"}</subagent_notification>',
      },
    });

    expect(result).toEqual({
      success: true,
      skipped: true,
      captureExcluded: true,
      sessionId: "ses_subagent_notification",
    });
    expect(kv.store.get("mem:sessions")).toBeUndefined();
    expect(kv.store.get("mem:obs:ses_subagent_notification")).toBeUndefined();
  });

  it("keeps distinct prompts from the same session inside the dedup window", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const { DedupMap } = await import("../src/functions/dedup.js");
    const sdk = mockSdk();
    const kv = mockKV();
    const dedup = new DedupMap();
    registerObserveFunction(sdk as never, kv as never, dedup);

    const common = "x".repeat(800);
    const base = {
      sessionId: "ses_two_prompts",
      project: "/project/a",
      cwd: "/project/a",
      hookType: "prompt_submit",
      timestamp: new Date().toISOString(),
    };
    const first = await sdk.trigger("mem::observe", {
      ...base,
      data: { prompt: `${common}-first` },
    });
    const second = await sdk.trigger("mem::observe", {
      ...base,
      data: { prompt: `${common}-second` },
    });
    dedup.stop();

    expect(first).toHaveProperty("observationId");
    expect(second).toHaveProperty("observationId");
    expect((first as { observationId: string }).observationId).not.toBe(
      (second as { observationId: string }).observationId,
    );
    expect(kv.store.get("mem:obs:ses_two_prompts")?.size).toBe(2);
  });
});
