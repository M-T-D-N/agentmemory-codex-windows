import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mockKV as createMockKV } from "./helpers/mocks.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerExportImportFunction } from "../src/functions/export-import.js";
import { inObservationRecovery, withObservationWrite } from "../src/state/observation-write.js";
import { selectSemanticGraphBatch } from "../src/functions/semantic-graph-backlog.js";
import { VERSION } from "../src/version.js";
import { getSearchIndex } from "../src/functions/search.js";
import type {
  Session,
  CompressedObservation,
  Memory,
  SessionSummary,
  ExportData,
} from "../src/types.js";

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

const testSession: Session = {
  id: "ses_1",
  project: "my-project",
  cwd: "/tmp",
  startedAt: "2026-02-01T00:00:00Z",
  status: "completed",
  observationCount: 1,
};

const testObs: CompressedObservation = {
  id: "obs_1",
  sessionId: "ses_1",
  timestamp: "2026-02-01T10:00:00Z",
  type: "file_edit",
  title: "Edit auth",
  facts: ["Added check"],
  narrative: "Auth changes",
  concepts: ["auth"],
  files: ["src/auth.ts"],
  importance: 7,
};

const testMemory: Memory = {
  id: "mem_1",
  createdAt: "2026-02-01T00:00:00Z",
  updatedAt: "2026-02-01T00:00:00Z",
  type: "pattern",
  title: "Auth pattern",
  content: "Always validate tokens",
  concepts: ["auth"],
  files: [],
  sessionIds: ["ses_1"],
  strength: 5,
  version: 1,
  isLatest: true,
};

const testSummary: SessionSummary = {
  sessionId: "ses_1",
  project: "my-project",
  createdAt: "2026-02-01T00:00:00Z",
  title: "Auth work",
  narrative: "Worked on auth",
  keyDecisions: ["Use JWT"],
  filesModified: ["src/auth.ts"],
  concepts: ["auth"],
  observationCount: 1,
};

describe("Export/Import Functions", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(async () => {
    vi.stubEnv("GRAPH_EXTRACTION_ENABLED", "false");
    sdk = mockSdk();
    kv = mockKV();
    // getSearchIndex() returns a module-level singleton shared across
    // tests. Clear it so index assertions here don't see rows added by
    // a prior test's import.
    getSearchIndex().clear();
    registerExportImportFunction(sdk as never, kv as never);

    await kv.set("mem:sessions", "ses_1", testSession);
    await kv.set("mem:obs:ses_1", "obs_1", testObs);
    await kv.set("mem:memories", "mem_1", testMemory);
    await kv.set("mem:summaries", "ses_1", testSummary);
  });

  afterEach(() => vi.unstubAllEnvs());

  it("export produces valid ExportData structure", async () => {
    const result = (await sdk.trigger("mem::export", {})) as ExportData;

    expect(result.version).toBe(VERSION);
    expect(result.exportedAt).toBeDefined();
    expect(result.sessions.length).toBe(1);
    expect(result.sessions[0].id).toBe("ses_1");
    expect(result.observations["ses_1"].length).toBe(1);
    expect(result.memories.length).toBe(1);
    expect(result.summaries.length).toBe(1);
  });

  it("import with merge strategy adds data", async () => {
    const exportData: ExportData = {
      version: "0.3.0",
      exportedAt: new Date().toISOString(),
      sessions: [{ ...testSession, id: "ses_2", observationCount: 0 }],
      observations: {},
      memories: [{ ...testMemory, id: "mem_2", title: "New pattern" }],
      summaries: [],
    };

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "merge",
    })) as { success: boolean; sessions: number; memories: number };

    expect(result.success).toBe(true);
    expect(result.sessions).toBe(1);
    expect(result.memories).toBe(1);

    const allSessions = await kv.list("mem:sessions");
    expect(allSessions.length).toBe(2);
  });

  it("import adds imported records to the search index", async () => {
    // Regression: mem::import wrote rows to KV but never indexed them.
    // On an existing install the boot rebuild gate (bm25.size === 0) is
    // false, so imported data stayed invisible to mem::search forever.
    const importedObs: CompressedObservation = {
      id: "obs_imported",
      sessionId: "ses_imported",
      timestamp: "2026-03-01T10:00:00Z",
      type: "file_edit",
      title: "Kubernetes deployment rollout",
      facts: ["Scaled replicas"],
      narrative: "Adjusted the kubernetes deployment rollout strategy",
      concepts: ["k8s"],
      files: ["deploy.yaml"],
      importance: 6,
    };
    const importedMem: Memory = {
      ...testMemory,
      id: "mem_imported",
      title: "Postgres connection pooling",
      content: "Use pgbouncer for postgres connection pooling",
    };
    const exportData: ExportData = {
      version: "0.9.28",
      exportedAt: new Date().toISOString(),
      sessions: [
        { ...testSession, id: "ses_imported", observationCount: 1 },
      ],
      observations: { ses_imported: [importedObs] },
      memories: [importedMem],
      summaries: [],
    };

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "merge",
    })) as { success: boolean; observations: number; memories: number };

    expect(result.success).toBe(true);
    expect(result.observations).toBe(1);
    expect(result.memories).toBe(1);

    const idx = getSearchIndex();
    expect(idx.has("obs_imported")).toBe(true);
    expect(idx.has("mem_imported")).toBe(true);

    const obsHit = idx.search("kubernetes rollout");
    expect(obsHit.some((r) => r.obsId === "obs_imported")).toBe(true);

    const memHit = idx.search("postgres pooling");
    expect(memHit.some((r) => r.obsId === "mem_imported")).toBe(true);
  });

  it("import with skip strategy does not overwrite existing", async () => {
    const exportData: ExportData = {
      version: "0.3.0",
      exportedAt: new Date().toISOString(),
      sessions: [testSession],
      observations: { ses_1: [testObs] },
      memories: [testMemory],
      summaries: [testSummary],
    };

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "skip",
    })) as { success: boolean; skipped: number; sessions: number };

    expect(result.success).toBe(true);
    expect(result.skipped).toBeGreaterThan(0);
    expect(result.sessions).toBe(0);
  });

  const countPayload = (observations: CompressedObservation[] = []) => ({
    strategy: "skip",
    exportData: {
      version: VERSION, exportedAt: "2026-09-12T00:00:00Z",
      sessions: [], observations: { ses_1: observations }, memories: [], summaries: [],
    },
  });

  it("skip import counts stored rows while preserving live session metadata and duplicate observations", async () => {
    const live = { ...testSession, status: "active", semanticGraphThroughObservationId: "obs_1", codexCaptureTurnId: "live-turn" };
    await kv.set("mem:sessions", "ses_1", live);
    const payload = countPayload([{ ...testObs, title: "stale title" }, { ...testObs, id: "obs_2" }]);
    payload.exportData.sessions = [{ ...testSession, observationCount: 999 }] as never;
    expect(await sdk.trigger("mem::import", payload)).toMatchObject({ success: true, observations: 1, reconciledSessions: 1 });
    expect(await kv.get("mem:sessions", "ses_1")).toEqual({ ...live, observationCount: 2 });
    expect(await kv.get("mem:obs:ses_1", "obs_1")).toEqual(testObs);
    expect(await sdk.trigger("mem::import", payload)).toMatchObject({ success: true, observations: 0, reconciledSessions: 0 });
    expect(await kv.list("mem:obs:ses_1")).toHaveLength(2);
  });

  it("reopens an imported tail and wakes the existing scheduler after exclusive recovery ends", async () => {
    vi.stubEnv("GRAPH_EXTRACTION_ENABLED", "true");
    const complete = { ...testSession, semanticGraphStatus: "complete", semanticGraphThroughObservationId: "obs_1", codexCaptureTurnId: "preserved" };
    await kv.set("mem:sessions", "ses_1", complete);
    let wokeInsideRecovery: boolean | undefined;
    const wake = vi.fn(() => { wokeInsideRecovery = inObservationRecovery(); });
    registerExportImportFunction(sdk as never, kv as never, wake);
    const appended = { ...testObs, id: "obs_2", timestamp: "2026-02-01T11:00:00Z" };
    expect(await sdk.trigger("mem::import", countPayload([appended]))).toMatchObject({ success: true, observations: 1 });
    const session = await kv.get<Session>("mem:sessions", "ses_1");
    expect(session).toEqual({ ...complete, observationCount: 2, semanticGraphStatus: "pending" });
    const batch = selectSemanticGraphBatch(session!, await kv.list("mem:obs:ses_1"));
    expect(batch?.observations.map(o => o.id)).toEqual(["obs_2"]);
    expect(wake).toHaveBeenCalledOnce();
    expect(wokeInsideRecovery).toBe(false);
    await sdk.trigger("mem::import", countPayload([appended]));
    await sdk.trigger("mem::import", countPayload());
    expect(wake).toHaveBeenCalledOnce();
  });

  it.each(["merge", "replace"])("%s preserves the graph cursor and completion of a complete backup", async (strategy) => {
    vi.stubEnv("GRAPH_EXTRACTION_ENABLED", "true");
    const wake = vi.fn();
    registerExportImportFunction(sdk as never, kv as never, wake);
    const complete = { ...testSession, semanticGraphStatus: "complete", semanticGraphThroughObservationId: "obs_1" };
    const payload = countPayload([testObs]);
    payload.strategy = strategy;
    payload.exportData.sessions = [complete] as never;
    await sdk.trigger("mem::import", payload);
    expect(await kv.get("mem:sessions", "ses_1")).toEqual(complete);
    expect(wake).not.toHaveBeenCalled();
  });

  it("does not enable automatic extraction when the host disabled graph extraction", async () => {
    const complete = { ...testSession, semanticGraphStatus: "complete", semanticGraphThroughObservationId: "obs_1" };
    await kv.set("mem:sessions", "ses_1", complete);
    const wake = vi.fn();
    registerExportImportFunction(sdk as never, kv as never, wake);
    await sdk.trigger("mem::import", countPayload([{ ...testObs, id: "obs_2" }]));
    expect(await kv.get("mem:sessions", "ses_1")).toEqual({ ...complete, observationCount: 2 });
    expect(wake).not.toHaveBeenCalled();
  });

  it("does not turn a successful import into a failure if its scheduler notification throws", async () => {
    vi.stubEnv("GRAPH_EXTRACTION_ENABLED", "true");
    registerExportImportFunction(sdk as never, kv as never, () => { throw new Error("wake failed"); });
    expect(await sdk.trigger("mem::import", countPayload([{ ...testObs, id: "obs_2" }]))).toMatchObject({ success: true, observations: 1 });
    expect(await kv.get("mem:sessions", "ses_1")).toMatchObject({ semanticGraphStatus: "pending", observationCount: 2 });
  });

  it("reconciles an existing count through an empty bucket without reimporting records", async () => {
    await kv.set("mem:sessions", "ses_1", { ...testSession, observationCount: 999 });
    expect(await sdk.trigger("mem::import", countPayload())).toMatchObject({ success: true, observations: 0, sessions: 0, reconciledSessions: 1 });
    expect(await kv.get("mem:sessions", "ses_1")).toEqual(testSession);
  });

  it.each(["merge", "replace"])("%s import derives new session counts from stored observations", async (strategy) => {
    const payload = countPayload([{ ...testObs, id: "obs_2" }]);
    payload.strategy = strategy;
    payload.exportData.sessions = [{ ...testSession, observationCount: 99 }] as never;
    await sdk.trigger("mem::import", payload);
    expect(await kv.get("mem:sessions", "ses_1")).toMatchObject({ observationCount: strategy === "merge" ? 2 : 1 });
  });

  it("rejects import without mutations while an observation writer is active", async () => {
    const before = await sdk.trigger("mem::export", {});
    await withObservationWrite(async () => {
      await expect(sdk.trigger("mem::import", countPayload([{ ...testObs, id: "obs_2" }]))).rejects.toThrow("writers are active");
    });
    const after = await sdk.trigger("mem::export", {}) as ExportData;
    expect(after.observations).toEqual((before as ExportData).observations);
    expect(after.sessions).toEqual((before as ExportData).sessions);
  });

  it("waits for every started chunk write before releasing exclusive access after failure", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const originalSet = kv.set.bind(kv);
    vi.spyOn(kv, "set").mockImplementation(async (scope, key, value) => {
      if (key === "obs_fail") throw new Error("write failed");
      if (key === "obs_slow") { entered.resolve(); await release.promise; }
      return originalSet(scope, key, value);
    });
    let importSettled = false;
    const operation = sdk.trigger("mem::import", countPayload([
      { ...testObs, id: "obs_fail" }, { ...testObs, id: "obs_slow" },
    ])).catch((error) => { importSettled = true; return error; });
    await entered.promise;
    let writerEntered = false;
    const writer = withObservationWrite(async () => { writerEntered = true; });
    await new Promise((resolve) => setImmediate(resolve));
    try {
      expect(importSettled).toBe(false);
      expect(writerEntered).toBe(false);
    } finally { release.resolve(); }
    expect(await operation).toBeInstanceOf(Error);
    await writer;
    expect(writerEntered).toBe(true);
    expect(await kv.get("mem:obs:ses_1", "obs_slow")).not.toBeNull();
  });

  it("fails closed when skip cannot read the existing observation", async () => {
    const originalGet = kv.get.bind(kv);
    vi.spyOn(kv, "get").mockImplementation(async (scope, key) => {
      if (scope === "mem:obs:ses_1") throw new Error("read failed");
      return originalGet(scope, key);
    });
    await expect(sdk.trigger("mem::import", countPayload([{ ...testObs, title: "overwrite" }]))).rejects.toThrow("read failed");
    expect(await originalGet("mem:obs:ses_1", "obs_1")).toEqual(testObs);
  });

  it("import with replace strategy clears existing data first", async () => {
    const newSession: Session = {
      id: "ses_new",
      project: "new-project",
      cwd: "/tmp/new",
      startedAt: "2026-03-01T00:00:00Z",
      status: "active",
      observationCount: 0,
    };
    const exportData: ExportData = {
      version: "0.3.0",
      exportedAt: new Date().toISOString(),
      sessions: [newSession],
      observations: {},
      memories: [],
      summaries: [],
    };

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "replace",
    })) as { success: boolean; sessions: number };

    expect(result.success).toBe(true);
    expect(result.sessions).toBe(1);

    const oldSession = await kv.get("mem:sessions", "ses_1");
    expect(oldSession).toBeNull();
  });

  it("export then import round-trip preserves data", async () => {
    const exported = (await sdk.trigger("mem::export", {})) as ExportData;

    const freshKv = mockKV();
    const freshSdk = mockSdk();
    registerExportImportFunction(freshSdk as never, freshKv as never);

    const importResult = (await freshSdk.trigger("mem::import", {
      exportData: exported,
      strategy: "merge",
    })) as {
      success: boolean;
      sessions: number;
      observations: number;
      memories: number;
    };

    expect(importResult.success).toBe(true);
    expect(importResult.sessions).toBe(1);
    expect(importResult.observations).toBe(1);
    expect(importResult.memories).toBe(1);

    const reExported = (await freshSdk.trigger(
      "mem::export",
      {},
    )) as ExportData;
    expect(reExported.sessions.length).toBe(exported.sessions.length);
    expect(reExported.memories.length).toBe(exported.memories.length);
  });

  it("import rejects unsupported version", async () => {
    const exportData = {
      version: "1.0.0",
      exportedAt: new Date().toISOString(),
      sessions: [],
      observations: {},
      memories: [],
      summaries: [],
    } as unknown as ExportData;

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "merge",
    })) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("Unsupported export version");
  });
});
