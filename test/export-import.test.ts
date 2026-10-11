import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mockKV as createMockKV } from "./helpers/mocks.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerExportImportFunction } from "../src/functions/export-import.js";
import { inObservationRecovery, withObservationWrite } from "../src/state/observation-write.js";
import { selectSemanticGraphBatch } from "../src/functions/semantic-graph-backlog.js";
import { VERSION, CODEX_LIFECYCLE_EXPORT_VERSION } from "../src/version.js";
import { codexTextDigest } from "../src/replay/codex-match.js";
import { codexExclusionId } from "../src/functions/codex-capture-exclusion.js";
import { getSearchIndex, rebuildIndex } from "../src/functions/search.js";
import { indexObservationSession, lookupObservationSession } from "../src/state/obs-index.js";
import { addSessionToProjectIndex } from "../src/state/session-index.js";
import { KV } from "../src/state/schema.js";
import { graphObservationComplete, graphObservationDigest, readGraphCompletionContext } from "../src/functions/graph-observation-result.js";
import type {
  Session,
  CompressedObservation,
  Memory,
  SessionSummary,
  ExportData,
  GraphNode,
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

  it.each(["sessions", "memories", "summaries", "profiles", "graphNodes", "graphEdges", "semanticMemories", "proceduralMemories", "actions", "actionEdges", "routines", "signals", "checkpoints", "sentinels", "sketches", "crystals", "facets", "lessons", "insights", "accessLogs"])("rejects a malformed %s row before any replace writes", async field => {
    const exported = structuredClone(await sdk.trigger("mem::export", {})) as ExportData;
    (exported as unknown as Record<string, unknown>)[field] = [null];
    const before = structuredClone(kv.store);
    const set = vi.spyOn(kv, "set"), del = vi.spyOn(kv, "delete"), update = vi.spyOn(kv, "update");
    await expect(sdk.trigger("mem::import", { exportData: exported, strategy: "replace" })).rejects.toThrow();
    expect(set).not.toHaveBeenCalled(); expect(del).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
    expect(kv.store).toEqual(before);
  });
  it.each(["duplicate", "bucket-owner", "summary-owner", "session-owner", "memory-owner"])("rejects inconsistent %s identities before writes", async variant => {
    const exported = structuredClone(await sdk.trigger("mem::export", {})) as ExportData;
    if (variant === "duplicate") exported.observations.ses_1.push({ ...testObs });
    if (variant === "bucket-owner") exported.observations.ses_1[0].sessionId = "other";
    if (variant === "summary-owner") exported.summaries[0].project = "other";
    if (variant === "session-owner") exported.sessions[0].project = "other";
    if (variant === "memory-owner") exported.memories[0].agentId = "other";
    const before = structuredClone(kv.store);
    const set = vi.spyOn(kv, "set"), del = vi.spyOn(kv, "delete"), update = vi.spyOn(kv, "update");
    await expect(sdk.trigger("mem::import", { exportData: exported })).rejects.toThrow();
    expect(set).not.toHaveBeenCalled(); expect(del).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
    expect(kv.store).toEqual(before);
  });

  async function graphExport() {
    await kv.set(KV.sessions, testSession.id, { ...testSession, semanticGraphCompletionVersion: 1, semanticGraphStatus: "complete" });
    await kv.set(KV.graphObservationResults(testSession.id), testObs.id, {
      version: 1, id: testObs.id, sessionId: testSession.id, project: testSession.project,
      inputDigest: graphObservationDigest(testObs), graphEpoch: "", completedAt: "2026-09-13T00:00:00Z", analyzer: "fixture", outcome: "extracted",
    });
    return await sdk.trigger("mem::export", {}) as ExportData;
  }

  it.each([KV.observations(testSession.id), KV.graphNodes, KV.accessLog])("fails export on collection read failure: %s", async scope => {
    const list = kv.list;
    kv.list = async name => { if (name === scope) throw Error("store unavailable"); return list(name); };
    await expect(sdk.trigger("mem::export", {})).rejects.toThrow("store unavailable");
  });

  it("exports only while source writers and graph recovery are quiescent", async () => {
    await withObservationWrite(async () => {
      await expect(sdk.trigger("mem::export", {})).rejects.toThrow("writers are active");
    });
    await kv.set(KV.graphWritePlan, "current", { pending: true });
    await expect(sdk.trigger("mem::export", {})).rejects.toThrow("Graph recovery must finish");
    await expect(sdk.trigger("mem::import", { strategy: "replace", exportData: {} })).rejects.toThrow("Graph recovery must finish");
    expect(await kv.get(KV.sessions, testSession.id)).toEqual(testSession);
  });

  it("round-trips a completed zero-node analysis with its source and graph", async () => {
    const exported = await graphExport();
    expect(exported.version).toBe(CODEX_LIFECYCLE_EXPORT_VERSION);
    expect(exported.graphNodes).toEqual([]);
    expect(exported.graphEdges).toEqual([]);
    expect(exported.sessions[0].semanticGraphStatus).toBe("pending");
    expect(await kv.get(KV.sessions, testSession.id)).toMatchObject({ semanticGraphStatus: "complete" });
    const freshSdk = mockSdk(); const freshKv = mockKV(); registerExportImportFunction(freshSdk as never, freshKv as never);
    expect(await freshSdk.trigger("mem::import", { exportData: exported })).toMatchObject({ success: true });
    const session = (await freshKv.get<Session>(KV.sessions, testSession.id))!;
    const observation = (await freshKv.get<CompressedObservation>(KV.observations(testSession.id), testObs.id))!;
    expect(graphObservationComplete(session, observation, await readGraphCompletionContext(freshKv as never, session))).toBe(true);
  });

  it("preserves stale completion as unverified even when a fresh target has the old epoch", async () => {
    await graphExport();
    await kv.set(KV.graphSnapshot, "current", { resetAt: "2026-09-13T01:00:00Z" });
    const exported = await sdk.trigger("mem::export", {}) as ExportData;
    expect(exported.graphObservationResults![testSession.id][0]).toMatchObject({ graphEpoch: "", importedGraphVerified: false });
    const freshSdk = mockSdk(); const freshKv = mockKV(); registerExportImportFunction(freshSdk as never, freshKv as never);
    await freshSdk.trigger("mem::import", { exportData: exported });
    const session = (await freshKv.get<Session>(KV.sessions, testSession.id))!;
    expect(graphObservationComplete(session, testObs, await readGraphCompletionContext(freshKv as never, session))).toBe(false);
  });

  it("keeps pre-reset graph rows hidden when restored into a fresh target", async () => {
    const old: GraphNode = { id: "old", type: "decision", name: "Earlier decision", project: testSession.project,
      properties: {}, sourceObservationIds: [testObs.id], sourceSessionIds: [testSession.id], createdAt: "2026-09-12T00:00:00Z" };
    const live: GraphNode = { ...old, id: "live", name: "Current decision", createdAt: "2026-09-13T02:00:00Z" };
    await kv.set(KV.graphNodes, old.id, old); await kv.set(KV.graphNodes, live.id, live);
    await kv.set(KV.graphEdges, "old-edge", { id: "old-edge", type: "related_to", sourceNodeId: old.id, targetNodeId: old.id,
      sourceObservationIds: [testObs.id], sourceSessionIds: [testSession.id], weight: 1, createdAt: old.createdAt });
    await kv.set(KV.graphSnapshot, "current", { resetAt: "2026-09-13T01:00:00Z" });
    const exported = await sdk.trigger("mem::export", {}) as ExportData;
    expect(exported.graphNodes!.find(row => row.id === old.id)).toEqual({ ...old, stale: true });
    expect(exported.graphEdges![0].stale).toBe(true);
    expect(await kv.get(KV.graphNodes, old.id)).toEqual(old);
    const freshSdk = mockSdk(); const freshKv = mockKV(); registerExportImportFunction(freshSdk as never, freshKv as never);
    expect(await freshSdk.trigger("mem::import", { exportData: exported })).toMatchObject({ success: true });
    expect(await freshKv.get(KV.graphSnapshot, "current")).toMatchObject({ stats: { totalNodes: 1, totalEdges: 0 } });
    expect(await freshKv.get(KV.graphNodes, old.id)).toMatchObject({ stale: true, sourceObservationIds: [testObs.id], sourceSessionIds: [testSession.id] });
    expect(await freshKv.get(KV.graphNodes, live.id)).toEqual(live);
  });

  it.each(["missing-graph", "changed-input", "changed-target-epoch", "skip"])("does not certify transferred completion for %s", async variant => {
    const exported = await graphExport();
    if (variant === "missing-graph") delete exported.graphEdges;
    if (variant === "changed-input") exported.observations = { [testSession.id]: [{ ...testObs, narrative: "Different evidence" }] };
    const freshSdk = mockSdk(); const freshKv = mockKV(); registerExportImportFunction(freshSdk as never, freshKv as never);
    if (variant === "changed-target-epoch") await freshKv.set(KV.graphSnapshot, "current", { resetAt: "2026-09-13T02:00:00Z" });
    await freshSdk.trigger("mem::import", { exportData: exported, strategy: variant === "skip" ? "skip" : "merge" });
    const session = (await freshKv.get<Session>(KV.sessions, testSession.id))!;
    expect(graphObservationComplete(session, exported.observations[testSession.id][0], await readGraphCompletionContext(freshKv as never, session))).toBe(false);
    expect(await freshKv.get(KV.graphObservationResults(testSession.id), testObs.id)).toMatchObject({ analyzer: "fixture", importedGraphVerified: false });
  });

  it("invalidates existing completion before an interrupted graph-only import", async () => {
    await graphExport();
    const set = kv.set;
    kv.set = async (scope, key, value) => { if (scope === KV.graphNodes) throw Error("graph write interrupted"); return set(scope, key, value); };
    await expect(sdk.trigger("mem::import", { exportData: { version: VERSION, sessions: [], observations: {}, memories: [], summaries: [],
      graphNodes: [{ id: "changed-node", type: "decision", name: "Changed" }] } })).rejects.toThrow("graph write interrupted");
    const session = (await kv.get<Session>(KV.sessions, testSession.id))!;
    expect(graphObservationComplete(session, testObs, await readGraphCompletionContext(kv as never, session))).toBe(false);
  });

  it("rejects mismatched result provenance before changing canonical records", async () => {
    const exported = await graphExport();
    exported.graphObservationResults![testSession.id][0].project = "different-project";
    const set = vi.spyOn(kv, "set");
    await expect(sdk.trigger("mem::import", { strategy: "replace", exportData: exported })).rejects.toThrow("Invalid graph observation completion");
    expect(set).not.toHaveBeenCalled();
    expect(await kv.get(KV.observations(testSession.id), testObs.id)).toEqual(testObs);
  });

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

  it.each(["merge", "replace", "skip"] as const)("imports and round-trips a standard upstream 0.9.30 export with %s", async strategy => {
    const session = { ...testSession, updatedAt: "2026-02-01T11:00:00Z", model: "upstream-fixture", tags: ["auth"], commitShas: ["abc123"], agentId: "upstream-agent" };
    const observation = { ...testObs, subtitle: "Token validation", confidence: 0.9, agentId: session.agentId,
      captureKey: "upstream-capture-key", source: { hookType: "post_tool_use" as const, originalBytes: 256, truncated: false,
        toolName: "Edit", toolInput: { file_path: "src/auth.ts" }, toolOutput: { success: true }, payload: { fixture: true } },
      origin: { channel: "tool" as const, capturedAt: testObs.timestamp } };
    const memory = { ...testMemory, project: session.project, agentId: session.agentId, sourceObservationIds: [observation.id],
      origin: { channel: "agent" as const, capturedAt: testMemory.createdAt } };
    const node: GraphNode = { id: "upstream-node", type: "file", name: "src/auth.ts", properties: { language: "typescript" },
      sourceObservationIds: [observation.id], createdAt: testObs.timestamp, aliases: ["auth module"] };
    const fixture = {
      version: "0.9.30", exportedAt: "2026-02-02T00:00:00Z", sessions: [session], observations: { [session.id]: [observation] },
      memories: [memory], summaries: [testSummary], graphNodes: [node],
      graphEdges: [{ id: "upstream-edge", type: "modifies", sourceNodeId: node.id, targetNodeId: node.id, weight: 1,
        sourceObservationIds: [observation.id], createdAt: testObs.timestamp, tvalid: testObs.timestamp, version: 1, isLatest: true,
        context: { reasoning: "Edited token validation", confidence: 0.9 } }],
      profiles: [{ project: session.project, generatedAt: "2026-02-02T00:00:00Z", topConcepts: [{ concept: "auth", frequency: 1 }],
        topFiles: [{ file: "src/auth.ts", frequency: 1 }], conventions: [], commonErrors: [], recentActivity: ["Auth changes"], sessionCount: 1, totalObservations: 1 }],
      accessLogs: [{ memoryId: memory.id, count: 1, lastAt: testObs.timestamp, recent: [Date.parse(testObs.timestamp)] }],
      pagination: { offset: 0, limit: 1, total: 1, hasMore: false },
    } satisfies ExportData;
    const original = structuredClone(fixture);
    const freshSdk = mockSdk(); const freshKv = mockKV(); registerExportImportFunction(freshSdk as never, freshKv as never);
    expect(await freshSdk.trigger("mem::import", { exportData: fixture, strategy })).toMatchObject({ success: true, sessions: 1, observations: 1, memories: 1, summaries: 1 });
    const exported = await freshSdk.trigger("mem::export", { maxSessions: 1 }) as ExportData;
    for (const field of ["sessions", "observations", "memories", "summaries", "graphNodes", "graphEdges", "profiles", "accessLogs", "pagination"] as const) {
      expect(exported[field]).toEqual(fixture[field]);
    }
    expect(exported.version).toBe(VERSION);
    expect(fixture).toEqual(original);
    expect(getSearchIndex().search("Auth changes")).toEqual(expect.arrayContaining([expect.objectContaining({ obsId: observation.id })]));
  });

  it.each(["native-session", "native-observation", "completion-session", "completion-results", "capture-exclusions", "archive-state"])("rejects downstream %s disguised as upstream 0.9.30 before mutations", async variant => {
    const fixture = { version: "0.9.30", exportedAt: testObs.timestamp, sessions: [testSession],
      observations: { [testSession.id]: [testObs] }, memories: [testMemory], summaries: [testSummary] } as ExportData;
    if (variant === "native-session") fixture.sessions = [{ ...testSession, codexNativeCapture: {} } as Session];
    if (variant === "native-observation") fixture.observations[testSession.id] = [{ ...testObs, codexSource: {} } as CompressedObservation];
    if (variant === "completion-session") fixture.sessions = [{ ...testSession, semanticGraphCompletionVersion: 1 }];
    if (variant === "completion-results") fixture.graphObservationResults = {};
    if (variant === "capture-exclusions") fixture.codexCaptureExclusions = [{ version: 1, id: codexExclusionId("forgotten"),
      sessionId: "forgotten", project: testSession.project, forgottenAt: testObs.timestamp, match: { kind: "session" } }];
    if (variant === "archive-state") fixture.archiveStates = [];
    const set = vi.spyOn(kv, "set"); const remove = vi.spyOn(kv, "delete");
    expect(await sdk.trigger("mem::import", { exportData: fixture, strategy: "replace" })).toMatchObject({ success: false, error: expect.stringContaining("lifecycle export format") });
    expect(set).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
    expect(await kv.get(KV.sessions, testSession.id)).toEqual(testSession);
  });

  it("does not downgrade an existing graph-tracked session using a standard upstream version", async () => {
    await graphExport();
    const set = vi.spyOn(kv, "set"); const remove = vi.spyOn(kv, "delete");
    await expect(sdk.trigger("mem::import", { strategy: "replace", exportData: {
      version: "0.9.30", exportedAt: testObs.timestamp, sessions: [testSession], observations: {}, memories: [], summaries: [],
    } })).rejects.toThrow("cannot downgrade observation-specific graph completion");
    expect(set).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
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

  it("round-trips forgotten source identity without a surviving session and never erases it with replace", async () => {
    const exclusion = { version: 1, id: codexExclusionId("forgotten-session"), sessionId: "forgotten-session", project: "p",
      forgottenAt: "2026-09-13T00:00:00Z", match: { kind: "session" } };
    await kv.set("mem:codex:capture-exclusions", exclusion.id, exclusion);
    const exported = await sdk.trigger("mem::export", {}) as ExportData;
    expect(exported.version).toBe(CODEX_LIFECYCLE_EXPORT_VERSION);
    expect(exported.codexCaptureExclusions).toEqual([exclusion]);
    const freshSdk = mockSdk(); const freshKv = mockKV();
    registerExportImportFunction(freshSdk as never, freshKv as never);
    expect(await freshSdk.trigger("mem::import", { exportData: exported })).toMatchObject({ success: true });
    expect(await freshKv.get("mem:codex:capture-exclusions", exclusion.id)).toEqual(exclusion);
    expect(await freshSdk.trigger("mem::import", { strategy: "replace", exportData: {
      version: VERSION, sessions: [], observations: {}, memories: [], summaries: [],
    } })).toMatchObject({ success: true });
    expect(await freshKv.get("mem:codex:capture-exclusions", exclusion.id)).toEqual(exclusion);
    await expect(freshSdk.trigger("mem::import", { exportData: { version: VERSION,
      sessions: [{ ...testSession, id: "forgotten-session", project: "p" }], observations: {}, memories: [], summaries: [],
    } })).rejects.toThrow("restore forgotten Codex capture");
    expect(await freshKv.get("mem:sessions", "forgotten-session")).toBeNull();
  });

  it("does not export a successful backup when the source exclusions could not be read", async () => {
    const list = kv.list;
    kv.list = async scope => { if (scope === "mem:codex:capture-exclusions") throw Error("exclusion read failed"); return list(scope); };
    await expect(sdk.trigger("mem::export", {})).rejects.toThrow("exclusion read failed");
  });

  it("refuses a contradictory export from an interrupted or concurrent forget", async () => {
    await kv.set("mem:codex:capture-exclusions", codexExclusionId(testSession.id), {
      version: 1, id: codexExclusionId(testSession.id), sessionId: testSession.id, project: testSession.project,
      forgottenAt: "2026-09-13T00:00:00Z", match: { kind: "session" },
    });
    await expect(sdk.trigger("mem::export", {})).rejects.toThrow("restore forgotten Codex capture");
  });

  it("exports native source provenance in the lifecycle format and never trusts a restored host cursor", async () => {
    const native = { ...testSession, codexNativeCapture: { version: 1, status: "caught_up", initializedAt: "2026-09-13T00:00:00Z",
      source: { sessionId: testSession.id, cwd: testSession.cwd, createdAt: testSession.startedAt, source: "cli", relativePath: "sessions/rollout-a.jsonl" },
      cursor: { foreignHostState: true }, indexPending: false } };
    await kv.set("mem:sessions", testSession.id, native);
    const retained = { ...testObs, codexSource: { version: 1 as const, key: codexTextDigest("prior-key"), nativeMessageId: "prior-message",
      kind: "user" as const, timestamp: testObs.timestamp, ordinal: 3, byteOffset: 500, textDigest: codexTextDigest(testObs.narrative),
      retainedSourcePath: "archived_sessions/rollout-prior.jsonl" } };
    await kv.set(KV.observations(testSession.id), testObs.id, retained);
    const alias = { ...retained, id: retained.id + "-copy", codexSource: { ...retained.codexSource, duplicateOfObservationId: retained.id } };
    await kv.set(KV.observations(testSession.id), alias.id, alias);
    const exported = await sdk.trigger("mem::export", {}) as ExportData;
    expect(exported.observations[testSession.id]).toEqual([retained, alias]);
    expect(exported.version).toBe(CODEX_LIFECYCLE_EXPORT_VERSION);
    expect(exported.sessions[0]!.codexNativeCapture).toMatchObject({ status: "reconcile_required", indexPending: true });
    expect(exported.sessions[0]!.codexNativeCapture).not.toHaveProperty("cursor");
    expect(await kv.get("mem:sessions", testSession.id)).toEqual(native);
    const freshSdk = mockSdk(); const freshKv = mockKV(); registerExportImportFunction(freshSdk as never, freshKv as never);
    const untrusted = { ...exported, sessions: [native] };
    expect(await freshSdk.trigger("mem::import", { exportData: untrusted })).toMatchObject({ success: true });
    expect(await freshKv.get(KV.observations(testSession.id), testObs.id)).toMatchObject(retained);
    expect(await freshKv.get(KV.observations(testSession.id), alias.id)).toMatchObject(alias);
    const restored = await freshKv.get<Session>("mem:sessions", testSession.id);
    expect(restored!.codexNativeCapture).not.toHaveProperty("cursor");
    expect(restored!.codexNativeCapture).toMatchObject({ status: "reconcile_required", indexPending: true });
    expect(await freshSdk.trigger("mem::import", { exportData: { ...untrusted, version: VERSION } })).toMatchObject({ success: false });
  });

  it("preserves unresolved legacy rows across export/import while requiring fresh source reconciliation", async () => {
    const legacy = { ...testObs, title: "prompt_submit", type: "conversation" as const, agentId: "codex-global",
      origin: { channel: "import" as const, capturedAt: testObs.timestamp } };
    await kv.set(KV.observations(testSession.id), legacy.id, legacy);
    const native = { ...testSession, codexNativeCapture: { version: 1, status: "caught_up", initializedAt: "2026-09-13T00:00:00Z",
      source: { sessionId: testSession.id, cwd: testSession.cwd, createdAt: testSession.startedAt, source: "cli", relativePath: "sessions/rollout-a.jsonl" },
      cursor: { foreignHostState: true }, unresolvedCaptures: [{ observationId: testObs.id, fingerprint: "a".repeat(64) }] } };
    await kv.set("mem:sessions", testSession.id, native);
    const exported = await sdk.trigger("mem::export", {}) as ExportData;
    expect(exported.observations[testSession.id]).toEqual([legacy]);
    expect(exported.sessions[0]!.codexNativeCapture).toMatchObject({ status: "reconcile_required" });
    expect(exported.sessions[0]!.codexNativeCapture).not.toHaveProperty("unresolvedCaptures");
    const freshSdk = mockSdk(); const freshKv = mockKV(); registerExportImportFunction(freshSdk as never, freshKv as never);
    expect(await freshSdk.trigger("mem::import", { exportData: { ...exported, sessions: [native] } })).toMatchObject({ success: true });
    expect(await freshKv.get(KV.observations(testSession.id), testObs.id)).toEqual(legacy);
    expect(await freshKv.get<Session>(KV.sessions, testSession.id)).toHaveProperty("codexNativeCapture.status", "reconcile_required");
    expect((await freshKv.get<Session>(KV.sessions, testSession.id))!.codexNativeCapture).not.toHaveProperty("unresolvedCaptures");
  });
  it("invalidates a native cursor after observations-only import and rejects invalid source paths before writing", async () => {
    const native = { ...testSession, codexNativeCapture: { version: 1, status: "caught_up", initializedAt: "2026-09-13T00:00:00Z",
      source: { sessionId: testSession.id, cwd: testSession.cwd, createdAt: testSession.startedAt, source: "cli", relativePath: "sessions/rollout-a.jsonl" },
      cursor: { foreignHostState: true } } };
    await kv.set("mem:sessions", testSession.id, native);
    expect(await sdk.trigger("mem::import", { exportData: { version: VERSION, sessions: [], memories: [], summaries: [],
      observations: { [testSession.id]: [{ ...testObs, id: "manual-new" }] } } })).toMatchObject({ success: true });
    const restored = await kv.get<Session>("mem:sessions", testSession.id);
    expect(restored!.codexNativeCapture).not.toHaveProperty("cursor");
    expect(restored!.codexNativeCapture!.status).toBe("reconcile_required");
    const invalid = { ...native, codexNativeCapture: { ...native.codexNativeCapture, source: { ...native.codexNativeCapture.source, relativePath: "../escape.jsonl" } } };
    await expect(sdk.trigger("mem::import", { strategy: "replace", exportData: { version: CODEX_LIFECYCLE_EXPORT_VERSION,
      sessions: [invalid], observations: {}, memories: [], summaries: [] } })).rejects.toThrow("Invalid native capture");
    expect(await kv.get("mem:sessions", testSession.id)).toEqual(restored);
    expect(await kv.get("mem:obs:ses_1", "manual-new")).not.toBeNull();
  });

  it("round-trips a resumed task after whole-session forget without restoring earlier content or summary", async () => {
    const cutoff = "2026-09-13T00:00:00Z";
    const exclusion = { version: 1, id: codexExclusionId(testSession.id), sessionId: testSession.id, project: testSession.project,
      forgottenAt: cutoff, match: { kind: "session" } };
    await kv.set("mem:codex:capture-exclusions", exclusion.id, exclusion);
    await kv.delete("mem:obs:ses_1", testObs.id); await kv.delete("mem:summaries", testSession.id);
    await kv.set("mem:sessions", testSession.id, { ...testSession, codexNativeCapture: {
      version: 1, status: "pending", initializedAt: "2026-09-13T00:00:02Z", capturedAfter: cutoff,
      source: { sessionId: testSession.id, cwd: testSession.cwd, createdAt: testSession.startedAt, source: "cli", relativePath: "sessions/rollout-a.jsonl" },
    } });
    await kv.set("mem:obs:ses_1", "after-forget", { ...testObs, id: "after-forget", timestamp: "2026-09-13T00:00:01Z", narrative: "new work after forget" });
    const exported = await sdk.trigger("mem::export", {}) as ExportData;
    const freshSdk = mockSdk(); const freshKv = mockKV(); registerExportImportFunction(freshSdk as never, freshKv as never);
    expect(await freshSdk.trigger("mem::import", { exportData: exported })).toMatchObject({ success: true });
    expect(await freshKv.get("mem:obs:ses_1", "after-forget")).toMatchObject({ narrative: "new work after forget" });
    expect(await freshKv.get("mem:obs:ses_1", testObs.id)).toBeNull();
    await expect(freshSdk.trigger("mem::import", { exportData: { ...exported, observations: { ses_1: [testObs] } } })).rejects.toThrow("restore forgotten Codex capture");
    await expect(freshSdk.trigger("mem::import", { exportData: { ...exported, summaries: [testSummary] } })).rejects.toThrow("restore forgotten Codex capture");
    await expect(freshSdk.trigger("mem::import", { exportData: { ...exported,
      sessions: [{ ...exported.sessions[0], firstPrompt: "old forgotten prompt" }] } })).rejects.toThrow("restore forgotten Codex capture");
    expect(await freshKv.get("mem:obs:ses_1", "after-forget")).not.toBeNull();
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

const bloatedIds = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${prefix}_${String(i).padStart(3, "0")}`);

describe("import preserves complete graph provenance", () => {
  it("keeps every sourceObservationId on imported graph nodes and edges", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerExportImportFunction(sdk as never, kv as never);
    const exportData = {
      version: "0.9.28",
      exportedAt: new Date().toISOString(),
      sessions: [],
      observations: {},
      memories: [],
      summaries: [],
      graphNodes: [
        {
          id: "gn_bloat",
          type: "file",
          name: "src/hot.ts",
          properties: {},
          sourceObservationIds: bloatedIds("obs", 400),
          createdAt: "2026-03-01T00:00:00Z",
        },
        {
          id: "gn_small",
          type: "file",
          name: "src/cold.ts",
          properties: {},
          sourceObservationIds: ["obs_x"],
          createdAt: "2026-03-01T00:00:00Z",
        },
      ],
      graphEdges: [
        {
          id: "ge_bloat",
          type: "related_to",
          sourceNodeId: "gn_bloat",
          targetNodeId: "gn_small",
          weight: 0.5,
          sourceObservationIds: bloatedIds("eobs", 100),
          createdAt: "2026-03-01T00:00:00Z",
        },
      ],
    } as unknown as ExportData;
    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "merge",
    })) as { success: boolean };
    expect(result.success).toBe(true);
    const n = await kv.get<{ sourceObservationIds: string[] }>("mem:graph:nodes", "gn_bloat");
    const s = await kv.get<{ sourceObservationIds: string[] }>("mem:graph:nodes", "gn_small");
    const e = await kv.get<{ sourceObservationIds: string[] }>("mem:graph:edges", "ge_bloat");
    expect(n!.sourceObservationIds).toEqual(bloatedIds("obs", 400));
    expect(s!.sourceObservationIds).toEqual(["obs_x"]);
    expect(e!.sourceObservationIds).toEqual(bloatedIds("eobs", 100));
  });
});


describe("retained import sources and index shape", () => {
  it.each(["merge", "skip", "replace"] as const)("rejects a memory-only foreign canonical source before writes (%s)", async strategy => {
    const sdk = mockSdk(), kv = mockKV(); registerExportImportFunction(sdk as never, kv as never);
    const foreign = { ...testSession, id: "foreign", project: "B", agentId: "B" };
    await kv.set(KV.sessions, foreign.id, foreign);
    await kv.set(KV.observations(foreign.id), "foreign_obs", { ...testObs, id: "foreign_obs", sessionId: foreign.id, project: "B", agentId: "B" });
    const data = { version: "0.9.30", exportedAt: testMemory.createdAt, sessions: [], observations: {}, summaries: [], memories: [{ ...testMemory, id: "mem_new", project: "A", agentId: "A", sessionIds: [], sourceObservationIds: ["foreign_obs"] }] };
    const set = vi.spyOn(kv, "set"), remove = vi.spyOn(kv, "delete");
    await expect(sdk.trigger("mem::import", { exportData: data, strategy })).rejects.toThrow(/source observation/);
    expect(set).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
  });
  it("accepts a same-owner retained source and indexes the memory-only import", async () => {
    const sdk = mockSdk(), kv = mockKV(); registerExportImportFunction(sdk as never, kv as never);
    await kv.set(KV.sessions, testSession.id, { ...testSession, agentId: "A" });
    await kv.set(KV.observations(testSession.id), testObs.id, testObs);
    const memory = { ...testMemory, id: "mem_same_owner", project: testSession.project, agentId: "A", sessionIds: [], sourceObservationIds: [testObs.id] };
    const data = { version: "0.9.30", exportedAt: testMemory.createdAt, sessions: [], observations: {}, summaries: [], memories: [memory] };
    expect(await sdk.trigger("mem::import", { exportData: data })).toMatchObject({ success: true });
    expect(getSearchIndex().has(memory.id)).toBe(true);
  });
  it("rejects a retained source from a different agent in the same project", async () => {
    const sdk = mockSdk(), kv = mockKV(); registerExportImportFunction(sdk as never, kv as never);
    await kv.set(KV.sessions, testSession.id, { ...testSession, agentId: "B" });
    await kv.set(KV.observations(testSession.id), testObs.id, testObs);
    const data = { version: "0.9.30", exportedAt: testMemory.createdAt, sessions: [], observations: {}, summaries: [], memories: [{ ...testMemory, id: "mem_foreign_agent", project: testSession.project, agentId: "A", sessionIds: [], sourceObservationIds: [testObs.id] }] };
    const set = vi.spyOn(kv, "set");
    await expect(sdk.trigger("mem::import", { exportData: data })).rejects.toThrow(/source observation agent/);
    expect(set).not.toHaveBeenCalled();
  });
  it.each(["concepts", "files", "both"])("rejects missing memory %s arrays before mutation", async field => {
    const sdk = mockSdk(), kv = mockKV(); registerExportImportFunction(sdk as never, kv as never);
    const memory: any = { ...testMemory, id: "mem_missing" };
    if (field !== "files") delete memory.concepts;
    if (field !== "concepts") delete memory.files;
    const data = { version: "0.9.30", exportedAt: testMemory.createdAt, sessions: [], observations: {}, summaries: [], memories: [memory] };
    const set = vi.spyOn(kv, "set"), remove = vi.spyOn(kv, "delete");
    await expect(sdk.trigger("mem::import", { exportData: data, strategy: "replace" })).rejects.toThrow(/concepts and files arrays/);
    expect(set).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
  });
});

describe("Import failure boundaries", () => {
  let kv: ReturnType<typeof mockKV>;
  let sdk: ReturnType<typeof mockSdk>;
  const empty = () => ({ version: VERSION, exportedAt: new Date().toISOString(), sessions: [], observations: {}, memories: [], summaries: [] });
  beforeEach(() => {
    vi.stubEnv("GRAPH_EXTRACTION_ENABLED", "false");
    kv = mockKV(); sdk = mockSdk(); getSearchIndex().clear();
    registerExportImportFunction(sdk as never, kv as never);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  const collections = [
    ["memories", KV.memories, 1], ["summaries", KV.summaries, 0],
    ["graphNodes", KV.graphNodes, 1], ["graphEdges", KV.graphEdges, 1],
    ["semanticMemories", KV.semantic, 1], ["proceduralMemories", KV.procedural, 1],
    ["profiles", KV.profiles, 0], ["actions", KV.actions, 1], ["actionEdges", KV.actionEdges, 0],
    ["routines", KV.routines, 1], ["signals", KV.signals, 1], ["checkpoints", KV.checkpoints, 1],
    ["sentinels", KV.sentinels, 1], ["sketches", KV.sketches, 1], ["crystals", KV.crystals, 1],
    ["facets", KV.facets, 1], ["lessons", KV.lessons, 1], ["insights", KV.insights, 1],
    ["accessLogs", KV.accessLog, 0],
  ] as const;
  const rowFor = (name: string) => name === "memories" ? { ...testMemory, sessionIds: [] } :
    name === "summaries" ? { ...testSummary } : name === "profiles" ? { project: "my-project", title: "old" } :
    name === "accessLogs" ? { memoryId: testMemory.id, accessCount: 1, lastAccessAt: testMemory.createdAt, timestamps: [] } :
    { id: "row", project: "my-project", type: "concept", name: "old", title: "old", createdAt: testMemory.createdAt,
      sourceNodeId: "node-a", targetNodeId: "node-b", sourceSessionIds: [], sourceObservationIds: [] };
  const keyFor = (name: string, row: ReturnType<typeof rowFor>) => name === "summaries" ? testSummary.sessionId :
    name === "profiles" ? "my-project" : name === "accessLogs" ? testMemory.id : (row as { id: string }).id;
  it.each(collections)("skip propagates %s (%s) existence-read failure after %s preflight reads", async (name, scope, preflightReads) => {
    const original = rowFor(name), key = keyFor(name, original);
    await kv.set(scope, key, original);
    const read = kv.get.bind(kv); let reads = 0;
    vi.spyOn(kv, "get").mockImplementation(async (requested, id) => {
      if (requested === scope && id === key && ++reads === preflightReads + 1) throw Error("existence read failed");
      return read(requested, id);
    });
    const set = vi.spyOn(kv, "set");
    const payload = { ...empty(), [name]: [{ ...original, title: "overwrite", content: "overwrite" }] };
    if (name === "accessLogs") payload.memories = [testMemory] as never;
    await expect(sdk.trigger("mem::import", { exportData: payload, strategy: "skip" })).rejects.toThrow("existence read failed");
    expect(reads).toBe(preflightReads + 1);
    expect(set.mock.calls.filter(([s, id]) => s === scope && id === key)).toHaveLength(0);
    expect(await read(scope, key)).toEqual(original);
  });
  it.each(collections)("skip preserves present %s and writes an absent row", async (name, scope) => {
    const original = rowFor(name), key = keyFor(name, original);
    const payload = { ...empty(), [name]: [original] };
    if (name === "accessLogs") payload.memories = [testMemory] as never;
    expect(await sdk.trigger("mem::import", { exportData: payload, strategy: "skip" })).toMatchObject({ success: true });
    const saved = await kv.get(scope, key);
    expect(saved).not.toBeNull();
    const set = vi.spyOn(kv, "set");
    payload[name] = [{ ...original, title: "overwrite", content: "overwrite" }] as never;
    expect(await sdk.trigger("mem::import", { exportData: payload, strategy: "skip" })).toMatchObject({ success: true });
    expect(set.mock.calls.filter(([s, id]) => s === scope && id === key)).toHaveLength(0);
    expect(await kv.get(scope, key)).toEqual(saved);
  });
  it("replace removes canonical observations and both address indexes", async () => {
    await kv.set(KV.sessions, testSession.id, testSession);
    await kv.set(KV.observations(testSession.id), testObs.id, { ...testObs, sessionId: "stale-row-address" });
    await indexObservationSession(kv as never, testObs.id, testSession.id);
    await addSessionToProjectIndex(kv as never, testSession.project, testSession);
    expect(await sdk.trigger("mem::import", { exportData: empty(), strategy: "replace" })).toMatchObject({ success: true });
    expect(await kv.get(KV.sessions, testSession.id)).toBeNull();
    expect(await kv.list(KV.observations(testSession.id))).toEqual([]);
    expect(await lookupObservationSession(kv as never, testObs.id)).toBeNull();
    expect(await kv.get(KV.projectSessionsIndex, testSession.project)).toEqual([]);
  });
  it("skip distinguishes a successful absent row from a failed preflight read", async () => {
    const payload = { ...empty(), memories: [{ ...testMemory, sessionIds: [] }] };
    expect(await sdk.trigger("mem::import", { exportData: payload, strategy: "skip" })).toMatchObject({ success: true, memories: 1 });
    const before = await kv.get(KV.memories, testMemory.id);
    const read = kv.get.bind(kv); const set = vi.spyOn(kv, "set"); set.mockClear();
    vi.spyOn(kv, "get").mockImplementation(async (scope, id) => { if (scope === KV.memories) throw Error("preflight read failed"); return read(scope, id); });
    await expect(sdk.trigger("mem::import", { exportData: payload, strategy: "skip" })).rejects.toThrow("preflight read failed");
    expect(set).not.toHaveBeenCalled(); expect(await read(KV.memories, testMemory.id)).toEqual(before);
  });
  it.each([KV.observations(testSession.id), KV.memories, KV.summaries, ...collections.filter(([name]) => !["memories", "summaries"].includes(name)).map(([, scope]) => scope)])(
    "replace acquires %s before any persistent mutation", async (failedScope) => {
      await kv.set(KV.sessions, testSession.id, testSession);
      await kv.set(KV.observations(testSession.id), testObs.id, testObs);
      const list = kv.list.bind(kv);
      vi.spyOn(kv, "list").mockImplementation(async scope => { if (scope === failedScope) throw Error("delete inventory failed"); return list(scope); });
      const set = vi.spyOn(kv, "set"), remove = vi.spyOn(kv, "delete"), update = vi.spyOn(kv, "update");
      await expect(sdk.trigger("mem::import", { exportData: empty(), strategy: "replace" })).rejects.toThrow("delete inventory failed");
      expect(set).not.toHaveBeenCalled();expect(remove).not.toHaveBeenCalled();expect(update).not.toHaveBeenCalled();
      expect(await kv.get(KV.sessions, testSession.id)).toEqual(testSession);
      expect(await kv.get(KV.observations(testSession.id), testObs.id)).toEqual(testObs);
    },
  );
  it("replace failure during deletion remains an explicit partial application", async () => {
    await kv.set(KV.sessions, testSession.id, testSession); await kv.set(KV.observations(testSession.id), testObs.id, testObs);
    const remove = kv.delete.bind(kv);
    vi.spyOn(kv, "delete").mockImplementation(async (scope, id) => { if (scope === KV.observations(testSession.id)) throw Error("delete failed"); return remove(scope, id); });
    await expect(sdk.trigger("mem::import", { exportData: empty(), strategy: "replace" })).rejects.toThrow("delete failed");
    expect(await kv.get(KV.sessions, testSession.id)).toBeNull();
    expect(await kv.get(KV.observations(testSession.id), testObs.id)).toEqual(testObs);
  });
  const malformed = [
    ...["facts", "concepts", "files"].flatMap(field => ["missing", "null", "string", "bad-element"].map(kind => ({ field, kind }))),
    { field: "all", kind: "missing" },
  ];
  it.each(malformed)("rejects compressed $field/$kind before any audit or canonical write", async ({field,kind}) => {
    const bad: Record<string, unknown> = {...testObs};
    for(const target of field === "all" ? ["facts","concepts","files"] : [field]) {
      if(kind === "missing") delete bad[target]; else bad[target] = kind === "null" ? null : kind === "string" ? "bad" : [42];
    }
    const set=vi.spyOn(kv,"set"), remove=vi.spyOn(kv,"delete"), update=vi.spyOn(kv,"update");
    const payload={...empty(),sessions:[testSession],observations:{[testSession.id]:[bad,{...testObs,id:"valid-2"},{...testObs,id:"valid-3"}]}};
    await expect(sdk.trigger("mem::import",{exportData:payload,strategy:"merge"})).rejects.toThrow(/observations.*facts|observations.*concepts|observations.*files|observations require/);
    expect(set).not.toHaveBeenCalled();expect(remove).not.toHaveBeenCalled();expect(update).not.toHaveBeenCalled();
    expect(await kv.list(KV.observations(testSession.id))).toEqual([]); expect(getSearchIndex().size).toBe(0);
  });
  it.each(["merge", "skip", "replace"])("%s round-trips legal raw observations without indexing unfinished content", async strategy => {
    const raw = { id: "raw_1", sessionId: testSession.id, timestamp: testObs.timestamp, hookType: "prompt_submit", raw: { prompt: "unfinished raw capture" }, userPrompt: "unfinished raw capture" };
    await kv.set(KV.sessions, testSession.id, { ...testSession, codexNativeCapture: {
      version: 1, source: { sessionId: testSession.id, source: "cli", cwd: testSession.cwd, createdAt: testSession.startedAt, relativePath: "sessions/2026/02/source.jsonl" },
      initializedAt: testSession.startedAt, status: "pending", indexPending: true,
    } }); await kv.set(KV.observations(testSession.id), raw.id, raw);
    const exported = await sdk.trigger("mem::export", {}) as ExportData;
    const destination=mockKV(), receiver=mockSdk();registerExportImportFunction(receiver as never,destination as never);
    expect(await receiver.trigger("mem::import",{exportData:exported,strategy})).toMatchObject({success:true,observations:1});
    const retained=await destination.get(KV.observations(testSession.id),raw.id);
    expect(retained).toMatchObject(raw);expect(getSearchIndex().search("unfinished raw capture")).toEqual([]);
    expect(await destination.get(KV.sessions,testSession.id)).toMatchObject({codexNativeCapture:{status:"reconcile_required",indexPending:true}});
    expect((await receiver.trigger("mem::export", {}) as ExportData).observations[testSession.id][0]).toMatchObject(raw);
  });
  it("a raw marker cannot hide missing arrays on an otherwise compressed row",async()=>{
    const bad={...testObs,raw:{},hookType:"prompt_submit"} as Record<string,unknown>;delete bad.facts;
    const set=vi.spyOn(kv,"set");
    await expect(sdk.trigger("mem::import",{exportData:{...empty(),sessions:[testSession],observations:{[testSession.id]:[bad]}},strategy:"merge"})).rejects.toThrow("observations require");
    expect(set).not.toHaveBeenCalled();
  });
  it("accepts and immediately indexes normal empty compressed arrays",async()=>{
    const observation={...testObs,facts:[],concepts:[],files:[],title:"importneedle valid"};
    expect(await sdk.trigger("mem::import",{exportData:{...empty(),sessions:[testSession],observations:{[testSession.id]:[observation]}},strategy:"merge"})).toMatchObject({success:true,observations:1});
    expect(getSearchIndex().search("importneedle").map(hit=>hit.obsId)).toContain(testObs.id);
    getSearchIndex().clear();expect(await rebuildIndex(kv as never)).toBe(1);
    expect(getSearchIndex().search("importneedle").map(hit=>hit.obsId)).toContain(testObs.id);
  });
});
