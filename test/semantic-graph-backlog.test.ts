import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", () => ({
  getGraphBatchSize: () => 2,
  isGraphExtractionEnabled: () => true,
}));
vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  registerSemanticGraphBacklogFunction,
  selectSemanticGraphBatch,
  startSemanticGraphBacklogScheduler,
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
  it("starts a never-processed session at the first bounded batch", () => {
    const batch = selectSemanticGraphBatch(
      session("a", "A"),
      observations("a", 4),
      2,
    );
    expect(batch?.observations.map((item) => item.id)).toEqual(["a_obs_1", "a_obs_2"]);
    expect(batch).toMatchObject({ cursorMode: "forward", semanticHasMore: true });
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
        : observations(scope.includes("obs:b") ? "b" : "a-never", 2),
      update: async (...args: unknown[]) => { updates.push(args); },
    };
    registerSemanticGraphBacklogFunction(sdk as never, kv as never);

    const result = await handlers.get("mem::graph-backlog-step")!({}) as { project: string };

    expect(result.project).toBe("B");
    expect(graphExtract).toHaveBeenCalledWith(expect.objectContaining({ project: "B", sessionId: "b" }));
    expect(updates).toHaveLength(1);
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
    expect(trigger).toHaveBeenCalledWith({ function_id: "mem::graph-backlog-step", payload: {} });
    scheduler.stop();
  });
});
