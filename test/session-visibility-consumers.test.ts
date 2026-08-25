import { describe, expect, it } from "vitest";
import { registerBranchAwareFunction } from "../src/functions/branch-aware.js";
import { registerFileIndexFunction } from "../src/functions/file-index.js";
import { registerPatternsFunction } from "../src/functions/patterns.js";
import { KV } from "../src/state/schema.js";
import type { CompressedObservation, Session } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

function session(id: string, captureExcluded = false): Session {
  return {
    id,
    project: "/repo",
    cwd: "/repo",
    startedAt: "2026-08-20T00:00:00Z",
    status: "completed",
    observationCount: 1,
    ...(captureExcluded ? { captureExcluded: true } : {}),
  };
}

function observation(
  id: string,
  sessionId: string,
  overrides: Partial<CompressedObservation> = {},
): CompressedObservation {
  return {
    id,
    sessionId,
    timestamp: "2026-08-20T00:00:01Z",
    type: "discovery",
    title: id,
    facts: [],
    narrative: `${id}-marker`,
    concepts: [],
    files: ["src/app.ts"],
    importance: 8,
    ...overrides,
  };
}

describe("internal Codex session visibility across consumers", () => {
  it("hides excluded sessions from branch session listings", async () => {
    const kv = mockKV();
    const sdk = mockSdk();
    registerBranchAwareFunction(sdk as never, kv as never);
    sdk.registerFunction("mem::detect-worktree", async () => ({
      success: true,
      isWorktree: false,
      mainRepoRoot: "/repo",
      branch: "main",
    }));
    await kv.set(KV.sessions, "visible", session("visible"));
    await kv.set(KV.sessions, "internal", session("internal", true));

    const result = (await sdk.trigger({
      function_id: "mem::branch-sessions",
      payload: { cwd: "/repo" },
    })) as { sessions: Session[] };

    expect(result.sessions.map((item) => item.id)).toEqual(["visible"]);
  });

  it("does not inject file history from excluded sessions", async () => {
    const kv = mockKV();
    const sdk = mockSdk();
    registerFileIndexFunction(sdk as never, kv as never);
    await kv.set(KV.sessions, "visible", session("visible"));
    await kv.set(KV.sessions, "internal", session("internal", true));
    await kv.set(
      KV.observations("visible"),
      "visible-observation",
      observation("visible-observation", "visible"),
    );
    await kv.set(
      KV.observations("internal"),
      "internal-observation",
      observation("internal-observation", "internal", { importance: 10 }),
    );

    const result = (await sdk.trigger({
      function_id: "mem::file-context",
      payload: { sessionId: "current", project: "/repo", files: ["src/app.ts"] },
    })) as { context: string };

    expect(result.context).toContain("visible-observation-marker");
    expect(result.context).not.toContain("internal-observation-marker");
  });

  it("does not derive recurring-error patterns from excluded sessions", async () => {
    const kv = mockKV();
    const sdk = mockSdk();
    registerPatternsFunction(sdk as never, kv as never);
    await kv.set(KV.sessions, "internal", session("internal", true));
    await kv.set(
      KV.observations("internal"),
      "error-1",
      observation("error-1", "internal", { type: "error", title: "private error" }),
    );
    await kv.set(
      KV.observations("internal"),
      "error-2",
      observation("error-2", "internal", { type: "error", title: "private error" }),
    );

    const result = (await sdk.trigger({
      function_id: "mem::patterns",
      payload: { project: "/repo" },
    })) as { patterns: unknown[] };

    expect(result.patterns).toEqual([]);
  });
});
