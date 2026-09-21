import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockKV as createMockKV } from "./helpers/mocks.js";

const gitOutput = vi.hoisted(() => ({ state: "" }));

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(
    (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, { stdout: "abc1234\n", stderr: "" });
    },
  ),
}));

vi.mock("node:util", async () => {
  const actual = (await vi.importActual("node:util")) as Record<
    string,
    unknown
  >;
  return {
    ...actual,
    promisify: () => async (_command: string, args: string[]) => ({ stdout: args[0] === "show" ? gitOutput.state :
      args[0] === "cat-file" ? String(Buffer.byteLength(gitOutput.state)) : "abc1234\n", stderr: "" }),
  };
});

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi
    .fn()
    .mockReturnValue('{"version":"0.4.0","sessions":[],"memories":[]}'),
}));

import { registerSnapshotFunction } from "../src/functions/snapshot.js";
import { withObservationWrite } from "../src/state/observation-write.js";
import type { Session, Memory, SnapshotMeta, CompressedObservation, ExportData, GraphNode } from "../src/types.js";
import { persistGraphDelta } from "../src/functions/graph.js";
import { writeFileSync } from "node:fs";
import { KV } from "../src/state/schema.js";
import { CODEX_LIFECYCLE_EXPORT_VERSION } from "../src/version.js";
import { codexExclusionId } from "../src/functions/codex-capture-exclusion.js";
import { graphObservationComplete, graphObservationDigest, readGraphCompletionContext } from "../src/functions/graph-observation-result.js";

function mockKV() {
  return {
    ...createMockKV(),
    assertRecoveryImportAllowed: () => {},
    hasObservationRecovery: () => false,
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (idOrOpts: string | { id: string }, handler: Function) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (idOrInput: string | { function_id: string; payload: unknown }, data?: unknown) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

describe("Snapshot Functions", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;
  const snapshotDir = "/tmp/agentmemory-snapshots";

  beforeEach(async () => {
    sdk = mockSdk();
    kv = mockKV();
    vi.clearAllMocks();
    gitOutput.state = JSON.stringify({ version: "0.4.0", sessions: [], memories: [] });
    registerSnapshotFunction(sdk as never, kv as never, snapshotDir);

    const session: Session = {
      id: "ses_1",
      project: "test",
      cwd: "/tmp",
      startedAt: "2026-02-01T00:00:00Z",
      status: "completed",
      observationCount: 1,
    };
    await kv.set("mem:sessions", "ses_1", session);

    const mem: Memory = {
      id: "mem_1",
      createdAt: "2026-02-01T00:00:00Z",
      updatedAt: "2026-02-01T00:00:00Z",
      type: "pattern",
      title: "Test pattern",
      content: "Always test",
      concepts: [],
      files: [],
      sessionIds: ["ses_1"],
      strength: 5,
      version: 1,
      isLatest: true,
    };
    await kv.set("mem:memories", "mem_1", mem);
  });

  it("snapshot-create serializes state and returns meta", async () => {
    const result = (await sdk.trigger("mem::snapshot-create", {
      message: "Test snapshot",
    })) as { success: boolean; snapshot: SnapshotMeta };

    expect(result.success).toBe(true);
    expect(result.snapshot).toBeDefined();
    expect(result.snapshot.commitHash).toBe("abc1234");
    expect(result.snapshot.message).toBe("Test snapshot");
    expect(result.snapshot.stats.sessions).toBe(1);
    expect(result.snapshot.stats.memories).toBe(1);
  });

  it("snapshot-list returns snapshots from git log", async () => {
    const result = (await sdk.trigger("mem::snapshot-list", {})) as {
      snapshots: Array<{
        commitHash: string;
        createdAt: string;
        message: string;
      }>;
    };

    expect(result.snapshots).toBeDefined();
    expect(Array.isArray(result.snapshots)).toBe(true);
  });

  it("snapshot-restore requires commitHash", async () => {
    const result = (await sdk.trigger("mem::snapshot-restore", {})) as {
      success: boolean;
      error: string;
    };

    expect(result.success).toBe(false);
    expect(result.error).toContain("commitHash");
  });

  it("snapshot-restore loads state from commit", async () => {
    const result = (await sdk.trigger("mem::snapshot-restore", {
      commitHash: "abc1234",
    })) as { success: boolean; commitHash: string };

    expect(result.success).toBe(true);
    expect(result.commitHash).toBe("abc1234");
  });

  it("refuses restoration while another canonical writer is active", async () => {
    const before = await kv.list("mem:sessions");
    const result = await withObservationWrite(() => sdk.trigger("mem::snapshot-restore", { commitHash: "abc1234" }));
    expect(result).toMatchObject({ success: false, error: expect.stringContaining("writers are active") });
    expect(await kv.list("mem:sessions")).toEqual(before);
    expect(await kv.list("mem:audit")).toEqual([]);
  });

  it("snapshot-create records an audit entry", async () => {
    await sdk.trigger("mem::snapshot-create", { message: "Audit test" });

    const audits = await kv.list("mem:audit");
    expect(audits.length).toBe(1);
  });

  it("restores graph results with the graph and resets the native host cursor", async () => {
    const session = (await kv.get<Session>(KV.sessions, "ses_1"))!;
    const native = { ...session, semanticGraphCompletionVersion: 1, semanticGraphStatus: "complete", codexNativeCapture: {
      version: 1, status: "caught_up", initializedAt: "2026-09-13T00:00:00Z", cursor: { hostOnly: true },
      source: { sessionId: session.id, cwd: session.cwd, createdAt: session.startedAt, source: "cli", relativePath: "sessions/example.jsonl" },
    } };
    const observation: CompressedObservation = { id: "o", sessionId: session.id, project: session.project,
      type: "discovery", title: "A verified decision", narrative: "Use canonical storage", facts: [], concepts: [], files: [],
      timestamp: "2026-09-13T00:00:00Z", importance: 5 };
    await kv.set(KV.sessions, session.id, native);
    await kv.set(KV.observations(session.id), observation.id, observation);
    const node: GraphNode = { id: "n", type: "decision", name: "Canonical storage", project: session.project,
      properties: {}, sourceObservationIds: [observation.id], sourceSessionIds: [session.id], createdAt: observation.timestamp };
    await kv.set(KV.graphNodes, "n", node);
    await kv.set(KV.graphEdges, "e", { id: "e", type: "related_to", sourceNodeId: "n", targetNodeId: "n", weight: 1,
      sourceObservationIds: [observation.id], sourceSessionIds: [session.id], createdAt: observation.timestamp, project: session.project });
    await kv.set(KV.graphObservationResults(session.id), observation.id, { version: 1, id: observation.id, sessionId: session.id, project: session.project,
      inputDigest: graphObservationDigest(observation), graphEpoch: "", completedAt: "2026-09-13T01:00:00Z", analyzer: "fixture", outcome: "extracted" });
    const wake = vi.fn(); registerSnapshotFunction(sdk as never, kv as never, snapshotDir, wake);
    expect(await sdk.trigger("mem::snapshot-create", {})).toMatchObject({ success: true });
    gitOutput.state = vi.mocked(writeFileSync).mock.calls[0][1] as string;
    const saved = JSON.parse(gitOutput.state) as ExportData;
    expect(saved.version).toBe(CODEX_LIFECYCLE_EXPORT_VERSION);
    expect(saved.graphEdges).toHaveLength(1);
    expect(saved.graphObservationResults![session.id]).toHaveLength(1);
    expect(saved.sessions[0].codexNativeCapture).not.toHaveProperty("cursor");
    expect(await kv.get(KV.sessions, session.id)).toEqual(native);
    await kv.delete(KV.graphNodes, "n"); await kv.delete(KV.graphEdges, "e");
    expect(await sdk.trigger("mem::snapshot-restore", { commitHash: "abc1234" })).toMatchObject({ success: true });
    expect(await kv.get(KV.graphNodes, "n")).not.toBeNull();
    expect(await kv.get(KV.graphEdges, "e")).not.toBeNull();
    const restored = (await kv.get<Session>(KV.sessions, session.id))!;
    expect(restored.codexNativeCapture).toMatchObject({ status: "reconcile_required", indexPending: true });
    expect(graphObservationComplete(restored, observation, await readGraphCompletionContext(kv as never, restored))).toBe(true);
    expect(await kv.get(KV.graphSnapshot, "current")).toMatchObject({ stats: { totalNodes: 1, totalEdges: 1 }, dirty: false });
    expect(await persistGraphDelta(kv as never, [{ ...node, id: "new-extraction-id" }], [], [observation.id], { project: session.project })).toMatchObject({ newNodeCount: 0 });
    expect(await kv.list(KV.graphNodes)).toHaveLength(1);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("does not write a partial snapshot when a source collection cannot be read", async () => {
    const list = kv.list;
    kv.list = async scope => { if (scope === KV.observations("ses_1")) throw Error("source unavailable"); return list(scope); };
    expect(await sdk.trigger("mem::snapshot-create", {})).toMatchObject({ success: false, error: "source unavailable" });
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("refuses an old snapshot that would resurrect an explicitly forgotten session", async () => {
    const session = (await kv.get<Session>(KV.sessions, "ses_1"))!;
    const exclusion = { version: 1, id: codexExclusionId(session.id), sessionId: session.id, project: session.project,
      forgottenAt: "2026-09-13T00:00:00Z", match: { kind: "session" } };
    await kv.set(KV.codexCaptureExclusions, exclusion.id, exclusion);
    gitOutput.state = JSON.stringify({ version: "0.4.0", sessions: [session], memories: [] });
    const set = vi.spyOn(kv, "set");
    expect(await sdk.trigger("mem::snapshot-restore", { commitHash: "abc1234" })).toMatchObject({ success: false, error: expect.stringContaining("restore forgotten Codex capture") });
    expect(set).not.toHaveBeenCalled();
  });
});

describe("snapshot-create reentrancy guard", () => {
  // Regression (P2): mem::snapshot-create is triggered by the periodic timer,
  // REST (api::snapshot-create), and MCP. Two runs writing state.json and
  // committing in the same git repo at once race on the index lock. An
  // overlapping call must be a no-op success while the first run finishes.
  it("skips an overlapping call and releases the guard on completion", async () => {
    let releaseFirst!: () => void;
    const firstListGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let listCalls = 0;
    const store = new Map<string, Map<string, unknown>>();
    const gatedKv = {
      get: async () => null,
      set: async <T>(scope: string, key: string, data: T): Promise<T> => {
        if (!store.has(scope)) store.set(scope, new Map());
        store.get(scope)!.set(key, data);
        return data;
      },
      delete: async () => {},
      list: async <T>(scope: string): Promise<T[]> => {
        listCalls++;
        // Park the first snapshot inside its initial list() so a second
        // snapshot-create observes the in-flight guard.
        if (listCalls === 1) await firstListGate;
        return (Array.from(store.get(scope)?.values() ?? []) as T[]) ?? [];
      },
    };
    const localSdk = mockSdk();
    registerSnapshotFunction(localSdk as never, gatedKv as never, "/tmp/reentrant");

    // Start the first snapshot; it parks inside kv.list with the guard held.
    const p1 = localSdk.trigger("mem::snapshot-create", { message: "first" });
    await Promise.resolve();
    await Promise.resolve();

    // Overlapping call: must be rejected as already-in-progress, NOT run git.
    const r2 = (await localSdk.trigger("mem::snapshot-create", {
      message: "second",
    })) as { success: boolean; message?: string; snapshot?: unknown };
    expect(r2).toEqual({
      success: true,
      message: "Snapshot already in progress",
    });
    expect(r2.snapshot).toBeUndefined();

    // Release the first run; it completes normally.
    releaseFirst();
    const r1 = (await p1) as { success: boolean; snapshot?: unknown };
    expect(r1.success).toBe(true);
    expect(r1.snapshot).toBeDefined();

    // Guard is released: a fresh call runs the full body again.
    const r3 = (await localSdk.trigger("mem::snapshot-create", {
      message: "third",
    })) as { success: boolean; snapshot?: unknown };
    expect(r3.success).toBe(true);
    expect(r3.snapshot).toBeDefined();
  });
});
