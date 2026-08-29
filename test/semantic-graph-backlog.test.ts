import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../src/config.js", () => ({
  getEnvVar: (name: string) => name === "AGENTMEMORY_LOCAL_QWEN_TIMEOUT_MS"
    ? "180000"
    : undefined,
  getGraphBatchSize: () => 2,
  isGraphExtractionEnabled: () => true,
}));
vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  isReadySignalWatchFilename,
  registerSemanticGraphBacklogFunction,
  selectSemanticGraphBatch,
  startSemanticGraphBacklogScheduler,
  subscribeReadySignalFile,
} from "../src/functions/semantic-graph-backlog.js";
import type { CompressedObservation, Session } from "../src/types.js";

function observations(sessionId: string, count: number): CompressedObservation[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${sessionId}_obs_${index + 1}`,
    sessionId,
    timestamp: `2026-08-24T00:00:${String(index).padStart(2, "0")}.000Z`,
    type: "discovery",
    title: `observation-${index + 1}`,
    narrative: `observation ${index + 1}`,
    concepts: [],
    files: [],
    importance: 5,
  }));
}

function session(id: string, project: string, extra: Partial<Session> = {}): Session {
  return {
    id,
    project,
    cwd: project,
    startedAt: "2026-08-24T00:00:00.000Z",
    status: "completed",
    observationCount: 4,
    ...extra,
  };
}

afterEach(() => vi.useRealTimers());

describe("semantic graph backlog", () => {
  it("recognizes Windows atomic-replace filenames for the ready signal", () => {
    expect(isReadySignalWatchFilename("qwen-ready.json", "qwen-ready.json")).toBe(true);
    expect(
      isReadySignalWatchFilename("QWEN-READY.JSON.tmp-12-token", "qwen-ready.json"),
    ).toBe(true);
    expect(
      isReadySignalWatchFilename("qwen-ready.json.bak-token", "qwen-ready.json"),
    ).toBe(true);
    expect(isReadySignalWatchFilename(null, "qwen-ready.json")).toBe(true);
    expect(
      isReadySignalWatchFilename("qwen-use.lock", "qwen-ready.json"),
    ).toBe(false);
  });

  it("detects a real ready-file change when directory events are unavailable", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentmemory-ready-"));
    const path = join(directory, "qwen-ready.json");
    const onReady = vi.fn();
    writeFileSync(path, JSON.stringify({ published_at_utc: "before" }), "utf8");
    const unsubscribe = subscribeReadySignalFile(path, onReady, {
      pollIntervalMs: 25,
      watchDirectory: false,
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      writeFileSync(path, JSON.stringify({ published_at_utc: "after" }), "utf8");
      await expect.poll(() => onReady.mock.calls.length, {
        interval: 25,
        timeout: 1_000,
      }).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(onReady).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("starts a never-processed session at the first bounded batch", () => {
    const batch = selectSemanticGraphBatch(
      session("a", "A"),
      observations("a", 4),
      2,
    );
    expect(batch?.observations.map((item) => item.id)).toEqual(["a_obs_1", "a_obs_2"]);
    expect(batch).toMatchObject({ cursorMode: "forward", semanticHasMore: true });
  });

  it("excludes internal observations and strips ambient UI blocks before selection", () => {
    const items = observations("a", 3);
    items[0]!.narrative = "<environment_context>internal only</environment_context>";
    items[1]!.narrative = '<panel source="ambient-ui-state">transient</panel>Useful decision';
    const batch = selectSemanticGraphBatch(session("a", "A"), items, 2);

    expect(batch?.observations.map((item) => item.id)).toEqual(["a_obs_2", "a_obs_3"]);
    expect(batch?.observations[0]?.narrative).toBe("Useful decision");
  });

  it("continues after a legacy cursor that now points to an excluded observation", () => {
    const items = observations("a", 3);
    items[1]!.narrative = "<environment_context>internal only</environment_context>";
    const batch = selectSemanticGraphBatch(
      session("a", "A", { semanticGraphThroughObservationId: "a_obs_2" }),
      items,
      2,
    );

    expect(batch?.observations.map((item) => item.id)).toEqual(["a_obs_3"]);
  });

  it("uses a separate cursor to recover the r30 skipped prefix without rewinding the forward cursor", () => {
    const batch = selectSemanticGraphBatch(
      session("a", "A", {
        semanticGraphThroughObservationId: "a_obs_4",
        semanticGraphBootstrapSkipped: 2,
      }),
      observations("a", 4),
      2,
    );
    expect(batch?.observations.map((item) => item.id)).toEqual(["a_obs_1", "a_obs_2"]);
    expect(batch).toMatchObject({
      cursorMode: "bootstrap_backfill",
      semanticBootstrapDone: true,
      semanticHasMore: false,
    });
  });

  it("selects one session from the least-recently-attempted project", async () => {
    const sessions = [
      session("a-never", "A", { semanticGraphStatus: "deferred" }),
      session("a-recent", "A", { semanticGraphStatus: "complete", semanticGraphLastAttemptAt: "2026-08-24T00:10:00Z" }),
      session("b", "B", { semanticGraphStatus: "deferred", semanticGraphLastAttemptAt: "2026-08-24T00:01:00Z" }),
    ];
    const updates: unknown[] = [];
    const handlers = new Map<string, (payload: unknown) => Promise<unknown>>();
    const graphExtract = vi.fn(async () => ({ success: true }));
    handlers.set("mem::graph-extract", graphExtract);
    const trigger = vi.fn(async ({ function_id, payload }: { function_id: string; payload: unknown }) => {
      const handler = handlers.get(function_id);
      if (!handler) throw new Error(`missing ${function_id}`);
      return handler(payload);
    });
    const sdk = {
      registerFunction: (id: string, handler: (payload: unknown) => Promise<unknown>) => handlers.set(id, handler),
      trigger,
    };
    const kv = {
      list: async (scope: string) => scope === "mem:sessions"
        ? sessions
        : observations(scope.includes("obs:b") ? "b" : "a-never", 2),
      get: async (_scope: string, key: string) =>
        sessions.find((item) => item.id === key) ?? { id: key },
      update: async (...args: unknown[]) => { updates.push(args); },
    };
    registerSemanticGraphBacklogFunction(sdk as never, kv as never);

    const result = await handlers.get("mem::graph-backlog-step")!({}) as { project: string };

    expect(result.project).toBe("B");
    expect(graphExtract).toHaveBeenCalledWith(expect.objectContaining({ project: "B", sessionId: "b" }));
    expect(trigger).toHaveBeenCalledWith(expect.objectContaining({
      function_id: "mem::graph-extract",
      timeoutMs: 210_000,
    }));
    expect(updates).toHaveLength(1);
  });

  it("does not recreate a source deleted after backlog selection", async () => {
    const sessions = [session("a", "A", { semanticGraphStatus: "deferred" })];
    const graphExtract = vi.fn(async () => ({ success: true }));
    const handlers = new Map<string, (payload: unknown) => Promise<unknown>>([
      ["mem::graph-extract", graphExtract],
    ]);
    const sdk = {
      registerFunction: (
        id: string,
        handler: (payload: unknown) => Promise<unknown>,
      ) => handlers.set(id, handler),
      trigger: vi.fn(async ({ function_id, payload }: {
        function_id: string;
        payload: unknown;
      }) => handlers.get(function_id)!(payload)),
    };
    const kv = {
      list: async (scope: string) => scope === "mem:sessions"
        ? sessions
        : observations("a", 1),
      get: vi.fn(async () => null),
      update: vi.fn(async () => undefined),
    };
    registerSemanticGraphBacklogFunction(sdk as never, kv as never);

    const result = await handlers.get("mem::graph-backlog-step")!({}) as {
      success: boolean;
      skipped: string;
      sessionId: string;
    };

    expect(result).toMatchObject({
      success: true,
      skipped: "source_deleted",
      sessionId: "a",
    });
    expect(kv.update).not.toHaveBeenCalled();
    expect(graphExtract).not.toHaveBeenCalled();
  });

  it("does not record a failed extraction after its source is deleted", async () => {
    const sessions = [session("a", "A", { semanticGraphStatus: "deferred" })];
    const handlers = new Map<string, (payload: unknown) => Promise<unknown>>();
    const graphExtract = vi.fn(async () => {
      sessions.length = 0;
      return { success: false, error: "late provider failure" };
    });
    handlers.set("mem::graph-extract", graphExtract);
    const sdk = {
      registerFunction: (
        id: string,
        handler: (payload: unknown) => Promise<unknown>,
      ) => handlers.set(id, handler),
      trigger: async ({ function_id, payload }: {
        function_id: string;
        payload: unknown;
      }) => handlers.get(function_id)!(payload),
    };
    const updates: unknown[] = [];
    const kv = {
      list: async (scope: string) => scope === "mem:sessions"
        ? sessions
        : observations("a", 1),
      get: async (_scope: string, key: string) =>
        sessions.find((item) => item.id === key) ?? (
          key === "a_obs_1" && sessions.length > 0 ? { id: key } : null
        ),
      update: async (...args: unknown[]) => { updates.push(args); },
    };
    registerSemanticGraphBacklogFunction(sdk as never, kv as never);

    await handlers.get("mem::graph-backlog-step")!({});

    expect(graphExtract).toHaveBeenCalledOnce();
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual([
      "mem:sessions",
      "a",
      [{ type: "set", path: "semanticGraphStatus", value: "pending" }],
    ]);
  });

  it.each([
    "relationship references an unknown entity key",
    "relationship n6->n5 cites an observation outside the input batch: obs_other",
  ])("shrinks a repeated parser or provenance failure to one observation without advancing the cursor: %s", async (lastError) => {
    const sessions = [session("a", "A", {
      semanticGraphStatus: "deferred",
      semanticGraphLastError: lastError,
    })];
    const handlers = new Map<string, (payload: unknown) => Promise<unknown>>();
    const graphExtract = vi.fn(async () => ({ success: true }));
    handlers.set("mem::graph-extract", graphExtract);
    const sdk = {
      registerFunction: (id: string, handler: (payload: unknown) => Promise<unknown>) => handlers.set(id, handler),
      trigger: async ({ function_id, payload }: { function_id: string; payload: unknown }) => {
        const handler = handlers.get(function_id);
        if (!handler) throw new Error(`missing ${function_id}`);
        return handler(payload);
      },
    };
    const kv = {
      list: async (scope: string) => scope === "mem:sessions"
        ? sessions
        : observations("a", 4),
      get: async (_scope: string, key: string) =>
        sessions.find((item) => item.id === key) ?? { id: key },
      update: vi.fn(async () => undefined),
    };
    registerSemanticGraphBacklogFunction(sdk as never, kv as never);

    await handlers.get("mem::graph-backlog-step")!({});

    expect(graphExtract).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "a",
      observations: [expect.objectContaining({ id: "a_obs_1" })],
      semanticHasMore: true,
    }));
  });

  it("keeps the configured batch size for a transient fetch failure", async () => {
    const sessions = [session("a", "A", {
      semanticGraphStatus: "deferred",
      semanticGraphLastError: "fetch failed",
    })];
    const handlers = new Map<string, (payload: unknown) => Promise<unknown>>();
    const graphExtract = vi.fn(async () => ({ success: true }));
    handlers.set("mem::graph-extract", graphExtract);
    const sdk = {
      registerFunction: (id: string, handler: (payload: unknown) => Promise<unknown>) => handlers.set(id, handler),
      trigger: async ({ function_id, payload }: { function_id: string; payload: unknown }) => {
        const handler = handlers.get(function_id);
        if (!handler) throw new Error(`missing ${function_id}`);
        return handler(payload);
      },
    };
    const kv = {
      list: async (scope: string) => scope === "mem:sessions"
        ? sessions
        : observations("a", 4),
      get: async (_scope: string, key: string) =>
        sessions.find((item) => item.id === key) ?? { id: key },
      update: vi.fn(async () => undefined),
    };
    registerSemanticGraphBacklogFunction(sdk as never, kv as never);

    await handlers.get("mem::graph-backlog-step")!({});

    expect(graphExtract).toHaveBeenCalledWith(expect.objectContaining({
      observations: [
        expect.objectContaining({ id: "a_obs_1" }),
        expect.objectContaining({ id: "a_obs_2" }),
      ],
    }));
  });

  it("records a pre-validation extraction failure so fairness can move on", async () => {
    const sessions = [session("a", "A", { semanticGraphStatus: "pending" })];
    const updates: unknown[] = [];
    const handlers = new Map<string, (payload: unknown) => Promise<unknown>>();
    handlers.set("mem::graph-extract", vi.fn(async () => ({
      success: false,
      error: "unknown source observation: obs_bad",
    })));
    const sdk = {
      registerFunction: (id: string, handler: (payload: unknown) => Promise<unknown>) => handlers.set(id, handler),
      trigger: async ({ function_id, payload }: { function_id: string; payload: unknown }) => {
        const handler = handlers.get(function_id);
        if (!handler) throw new Error(`missing ${function_id}`);
        return handler(payload);
      },
    };
    const kv = {
      list: async (scope: string) => scope === "mem:sessions" ? sessions : observations("a", 1),
      get: async (_scope: string, key: string) =>
        sessions.find((item) => item.id === key) ?? { id: key },
      update: async (...args: unknown[]) => { updates.push(args); },
    };
    registerSemanticGraphBacklogFunction(sdk as never, kv as never);

    await handlers.get("mem::graph-backlog-step")!({});

    expect(updates).toHaveLength(2);
    expect(updates[1]).toEqual([
      "mem:sessions",
      "a",
      expect.arrayContaining([
        { type: "set", path: "semanticGraphStatus", value: "deferred" },
        { type: "set", path: "semanticGraphLastError", value: "unknown source observation: obs_bad" },
      ]),
    ]);
  });

  it("requires two stable probes after a model fingerprint change before backlog work", async () => {
    vi.useFakeTimers();
    const trigger = vi.fn(async () => ({ success: true }));
    const provider = {
      name: "local-qwen",
      probe: vi.fn(async () => ({
        provider: "local-qwen",
        model: "qwen",
        contextTokens: 131072,
        maxInputTokens: 100000,
        maxOutputTokens: 2048,
        fingerprint: "qwen|131072|build",
      })),
      compress: vi.fn(),
      summarize: vi.fn(),
    };
    const scheduler = startSemanticGraphBacklogScheduler(
      { trigger } as never,
      provider as never,
      null,
      { intervalMs: 100_000, readyGraceMs: 0 },
    );
    await scheduler.tick();
    expect(trigger).not.toHaveBeenCalled();
    await scheduler.tick();
    expect(trigger).toHaveBeenCalledWith({
      function_id: "mem::graph-backlog-step",
      timeoutMs: 240_000,
      payload: {},
    });
    scheduler.stop();
  });

  it("drains bounded batches after a ready signal and stops at an empty backlog", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T00:00:00Z"));
    let onReady: (() => void) | undefined;
    const unsubscribe = vi.fn();
    const trigger = vi
      .fn()
      .mockResolvedValueOnce({ success: true, result: { success: true, semanticCompleted: true } })
      .mockResolvedValueOnce({ success: true, result: { success: true, semanticCompleted: true } })
      .mockResolvedValueOnce({ success: true, skipped: "backlog_empty" });
    const provider = {
      name: "local-qwen",
      probe: vi.fn(async () => ({
        provider: "local-qwen",
        model: "qwen",
        contextTokens: 131072,
        maxInputTokens: 100000,
        maxOutputTokens: 2048,
        fingerprint: "qwen|131072|build",
      })),
      compress: vi.fn(),
      summarize: vi.fn(),
    };
    const scheduler = startSemanticGraphBacklogScheduler(
      { trigger } as never,
      provider as never,
      null,
      {
        intervalMs: 100_000,
        readyGraceMs: 10,
        eventDrainBatches: 4,
        readySignalPath: "C:\\coordination\\qwen-ready.json",
        subscribeReadySignal: (_path, callback) => {
          onReady = callback;
          return unsubscribe;
        },
      },
    );

    onReady?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(trigger).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);

    expect(trigger).toHaveBeenCalledTimes(3);
    expect(trigger).toHaveBeenCalledWith(expect.objectContaining({
      function_id: "mem::graph-backlog-step",
      timeoutMs: 240_000,
    }));
    expect(provider.probe).toHaveBeenCalledTimes(2);
    scheduler.stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("restarts the readiness grace when the launcher reuses the same fingerprint", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T00:00:00Z"));
    let onReady: (() => void) | undefined;
    const runtime = {
      provider: "local-qwen",
      model: "qwen",
      contextTokens: 131072,
      maxInputTokens: 100000,
      maxOutputTokens: 4096,
      fingerprint: "qwen|131072|build",
    };
    const trigger = vi.fn(async () => ({ success: true, skipped: "backlog_empty" }));
    const provider = {
      name: "local-qwen",
      probe: vi.fn(async () => runtime),
      compress: vi.fn(),
      summarize: vi.fn(),
    };
    const scheduler = startSemanticGraphBacklogScheduler(
      { trigger } as never,
      provider as never,
      runtime,
      {
        intervalMs: 100_000,
        readyGraceMs: 10_000,
        readySignalPath: "C:\\coordination\\qwen-ready.json",
        subscribeReadySignal: (_path, callback) => {
          onReady = callback;
          return () => {};
        },
      },
    );

    await vi.advanceTimersByTimeAsync(1_000);
    onReady?.();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(trigger).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(trigger).toHaveBeenCalledOnce();
    scheduler.stop();
  });

  it("continues an event drain after a successful partial batch", async () => {
    vi.useFakeTimers();
    const trigger = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        result: { success: true, semanticCompleted: false },
      })
      .mockResolvedValueOnce({ success: true, skipped: "backlog_empty" });
    const provider = {
      name: "local-qwen",
      probe: vi.fn(async () => ({
        provider: "local-qwen",
        model: "qwen",
        contextTokens: 131072,
        maxInputTokens: 100000,
        maxOutputTokens: 2048,
        fingerprint: "qwen|131072|build",
      })),
      compress: vi.fn(),
      summarize: vi.fn(),
    };
    const scheduler = startSemanticGraphBacklogScheduler(
      { trigger } as never,
      provider as never,
      null,
      { intervalMs: 100_000, readyGraceMs: 0, eventDrainBatches: 4 },
    );

    scheduler.wake();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(trigger).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it("retries a failed event drain after the cooldown", async () => {
    vi.useFakeTimers();
    const trigger = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        result: { success: false, semanticCompleted: false },
      })
      .mockResolvedValueOnce({ success: true, skipped: "backlog_empty" });
    const provider = {
      name: "local-qwen",
      probe: vi.fn(async () => ({
        provider: "local-qwen",
        model: "qwen",
        contextTokens: 131072,
        maxInputTokens: 100000,
        maxOutputTokens: 2048,
        fingerprint: "qwen|131072|build",
      })),
      compress: vi.fn(),
      summarize: vi.fn(),
    };
    const scheduler = startSemanticGraphBacklogScheduler(
      { trigger } as never,
      provider as never,
      null,
      {
        intervalMs: 100_000,
        readyGraceMs: 0,
        eventDrainBatches: 4,
        eventDrainCooldownMs: 1_000,
      },
    );

    scheduler.wake();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(trigger).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(trigger).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(trigger).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });
});
