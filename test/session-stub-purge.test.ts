import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { purgeEmptySessionEndStubs } from "../src/functions/session-stub-purge.js";
import { registerMigrateFunction } from "../src/functions/migrate.js";
import { KV } from "../src/state/schema.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

const STUB = {
  endedAt: "2026-08-21T00:00:00.000Z",
  status: "completed",
};

describe("purge-empty-session-end-stubs migration", () => {
  let kv: ReturnType<typeof mockKV>;

  beforeEach(async () => {
    kv = mockKV();
    await kv.set(KV.graphSnapshot, "current", {
      version: 1,
      topNodes: [],
      topEdges: [],
      topDegrees: {},
      stats: {
        totalNodes: 0,
        totalEdges: 0,
        nodesByType: {},
        edgesByType: {},
      },
      updatedAt: "2026-08-21T00:00:00.000Z",
      dirty: false,
    });
    await kv.set(KV.sessions, "stub-a", STUB);
    await kv.set(KV.sessions, "stub-b", {
      ...STUB,
      endedAt: "2026-08-21T00:01:00.000Z",
    });
  });

  it("dry-runs, purges exact empty stubs, and is idempotent", async () => {
    const dryRun = await purgeEmptySessionEndStubs(
      kv as never,
      ["stub-b", "stub-a"],
      true,
    );
    expect(dryRun).toMatchObject({
      dryRun: true,
      requested: 2,
      wouldPurge: 2,
      purged: 0,
      conflicts: 0,
      referenced: 0,
    });
    expect(await kv.get(KV.sessions, "stub-a")).toEqual(STUB);

    const applied = await purgeEmptySessionEndStubs(
      kv as never,
      ["stub-a", "stub-b"],
      false,
    );
    expect(applied).toMatchObject({
      dryRun: false,
      requested: 2,
      purged: 2,
      alreadyAbsent: 0,
    });
    expect(await kv.get(KV.sessions, "stub-a")).toBeNull();
    expect(await kv.get(KV.sessions, "stub-b")).toBeNull();
    expect(await kv.list(KV.audit)).toHaveLength(1);

    const repeated = await purgeEmptySessionEndStubs(
      kv as never,
      ["stub-a", "stub-b"],
      false,
    );
    expect(repeated).toMatchObject({
      purged: 0,
      alreadyAbsent: 2,
      conflicts: 0,
      referenced: 0,
    });
    expect(await kv.list(KV.audit)).toHaveLength(1);
  });

  it("blocks the whole batch when a row is not the exact two-field stub", async () => {
    await kv.set(KV.sessions, "stub-b", {
      ...STUB,
      id: "stub-b",
      project: "project-a",
    });

    const result = await purgeEmptySessionEndStubs(
      kv as never,
      ["stub-a", "stub-b"],
      false,
    );

    expect(result).toMatchObject({ wouldPurge: 1, purged: 0, conflicts: 1 });
    expect(await kv.get(KV.sessions, "stub-a")).toEqual(STUB);
    expect(await kv.get(KV.sessions, "stub-b")).not.toBeNull();
    expect(await kv.list(KV.audit)).toEqual([]);
  });

  it.each([
    [KV.observations("stub-a"), "obs-1", { id: "obs-1", sessionId: "stub-a" }],
    [KV.summaries, "stub-a", { sessionId: "stub-a" }],
    [KV.memories, "mem-1", { id: "mem-1", sessionIds: ["stub-a"] }],
    [KV.semantic, "sem-1", { id: "sem-1", sourceSessionIds: ["stub-a"] }],
    [KV.procedural, "proc-1", { id: "proc-1", sourceSessionIds: ["stub-a"] }],
    [KV.lessons, "lesson-1", { id: "lesson-1", sourceSessionIds: ["stub-a"] }],
    [KV.commits, "commit-1", { sha: "commit-1", sessionIds: ["stub-a"] }],
    [KV.crystals, "crystal-1", { id: "crystal-1", sessionId: "stub-a" }],
  ])("refuses a stub referenced by %s", async (scope, key, value) => {
    await kv.set(scope, key, value);

    const result = await purgeEmptySessionEndStubs(
      kv as never,
      ["stub-a"],
      false,
    );

    expect(result).toMatchObject({ purged: 0, referenced: 1 });
    expect(await kv.get(KV.sessions, "stub-a")).toEqual(STUB);
    expect(await kv.list(KV.audit)).toEqual([]);
  });

  it("rejects duplicate IDs without mutating state", async () => {
    const result = await purgeEmptySessionEndStubs(
      kv as never,
      ["stub-a", "stub-a"],
      false,
    );

    expect(result).toMatchObject({ purged: 0, invalid: 1 });
    expect(await kv.get(KV.sessions, "stub-a")).toEqual(STUB);
  });

  it.each([
    ["missing", null],
    ["dirty", {
      version: 1,
      topNodes: [],
      topEdges: [],
      topDegrees: {},
      stats: {
        totalNodes: 0,
        totalEdges: 0,
        nodesByType: {},
        edgesByType: {},
      },
      updatedAt: "2026-08-21T00:00:00.000Z",
      dirty: true,
    }],
  ])("fails closed when the graph snapshot is %s", async (_label, snapshot) => {
    if (snapshot) await kv.set(KV.graphSnapshot, "current", snapshot);
    else await kv.delete(KV.graphSnapshot, "current");

    await expect(
      purgeEmptySessionEndStubs(kv as never, ["stub-a"], false),
    ).rejects.toThrow(/graph session-reference preflight/);
    expect(await kv.get(KV.sessions, "stub-a")).toEqual(STUB);
    expect(await kv.list(KV.audit)).toEqual([]);
  });

  it("keeps dry-run as the mem::migrate default", async () => {
    const sdk = mockSdk();
    registerMigrateFunction(sdk as never, kv as never);

    const result = await sdk.trigger("mem::migrate", {
      step: "purge-empty-session-end-stubs",
      sessionIds: ["stub-a"],
    }) as Record<string, unknown>;

    expect(result).toMatchObject({
      success: true,
      step: "purge-empty-session-end-stubs",
      dryRun: true,
      wouldPurge: 1,
      purged: 0,
    });
    expect(await kv.get(KV.sessions, "stub-a")).toEqual(STUB);
  });
});
