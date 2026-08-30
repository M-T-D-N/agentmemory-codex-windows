import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config.js")>();
  return { ...actual, isGraphExtractionEnabled: () => true };
});

import {
  inspectGraphSessionReferences,
  registerGraphFunction,
} from "../src/functions/graph.js";
import { registerRememberFunction } from "../src/functions/remember.js";
import type {
  CompressedObservation,
  GraphNode,
  GraphEdge,
  GraphQueryResult,
} from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    update: async (
      scope: string,
      key: string,
      operations: Array<{ type: string; path: string; value: unknown }>,
    ): Promise<unknown> => {
      const current = { ...((store.get(scope)?.get(key) as Record<string, unknown>) ?? {}) };
      for (const operation of operations) {
        if (operation.type === "set") current[operation.path] = operation.value;
      }
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, current);
      return current;
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
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

const mockProvider = {
  name: "test",
  compress: vi.fn().mockResolvedValue(`<entities>
<entity type="file" name="src/index.ts"><property key="path">src/index.ts</property></entity>
<entity type="function" name="main"><property key="lang">typescript</property></entity>
</entities>
<relationships>
<relationship type="uses" source="src/index.ts" target="main" weight="0.9"/>
</relationships>`),
  summarize: vi.fn(),
};

// Structured fields stay empty so the deterministic heuristic pass
// contributes nothing and these tests keep exercising the LLM XML
// parse + persist path in isolation.
const testObs: CompressedObservation = {
  id: "obs_1",
  sessionId: "ses_1",
  timestamp: "2026-02-01T10:00:00Z",
  type: "file_edit",
  title: "Edit index file",
  facts: ["Modified main function"],
  narrative: "Updated index.ts with main function",
  concepts: [],
  files: [],
  importance: 7,
};

describe("Graph Functions", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;
  const ORIG_GRAPH_FLAG = process.env["GRAPH_EXTRACTION_ENABLED"];

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    vi.clearAllMocks();
    process.env["GRAPH_EXTRACTION_ENABLED"] = "true";
    registerGraphFunction(sdk as never, kv as never, mockProvider as never);
  });

  afterEach(() => {
    if (ORIG_GRAPH_FLAG === undefined) delete process.env["GRAPH_EXTRACTION_ENABLED"];
    else process.env["GRAPH_EXTRACTION_ENABLED"] = ORIG_GRAPH_FLAG;
  });

  it("graph-extract creates nodes and edges from XML response", async () => {
    const result = (await sdk.trigger("mem::graph-extract", {
      observations: [testObs],
    })) as { success: boolean; nodesAdded: number; edgesAdded: number };

    expect(result.success).toBe(true);
    expect(result.nodesAdded).toBe(2);
    expect(result.edgesAdded).toBe(1);

    const nodes = await kv.list<GraphNode>("mem:graph:nodes");
    expect(nodes.length).toBe(2);
    expect(nodes.find((n) => n.name === "src/index.ts")).toBeDefined();
    expect(nodes.find((n) => n.name === "main")).toBeDefined();

    const edges = await kv.list<GraphEdge>("mem:graph:edges");
    expect(edges.length).toBe(1);
    expect(edges[0].type).toBe("uses");
  });

  it("scopes automatic graph rows and preserves per-record official provenance", async () => {
    const secondObs: CompressedObservation = {
      ...testObs,
      id: "obs_2",
      sessionId: "ses_1",
      timestamp: "2026-02-01T10:01:00Z",
      title: "Choose parser",
      narrative: "Selected the strict parser",
    };
    await kv.set("mem:sessions", "ses_1", {
      id: "ses_1",
      project: "/project-a",
      cwd: "/project-a",
      startedAt: "2026-02-01T10:00:00Z",
      status: "completed",
      observationCount: 2,
    });
    await kv.set("mem:obs:ses_1", "obs_1", testObs);
    await kv.set("mem:obs:ses_1", "obs_2", secondObs);
    mockProvider.compress.mockResolvedValueOnce(`<entities>
<entity key="file" type="file" name="src/index.ts" source_observation_ids="obs_1"/>
<entity key="decision" type="decision" name="Strict parser" source_observation_ids="obs_2"/>
</entities>
<relationships>
<relationship type="uses" source="file" target="decision" source_observation_ids="obs_2" weight="0.9"/>
</relationships>`);

    const result = await sdk.trigger("mem::graph-extract", {
      project: "/project-a",
      sessionId: "ses_1",
      observations: [testObs, secondObs],
    }) as { success: boolean; semanticCompleted: boolean };

    expect(result).toMatchObject({ success: true, semanticCompleted: true });
    const nodes = await kv.list<GraphNode>("mem:graph:nodes");
    expect(nodes.find((node) => node.name === "src/index.ts")).toMatchObject({
      project: "/project-a",
      sourceObservationIds: ["obs_1"],
      sourceSessionIds: ["ses_1"],
    });
    expect(nodes.find((node) => node.name === "Strict parser")).toMatchObject({
      project: "/project-a",
      sourceObservationIds: ["obs_2"],
      sourceSessionIds: ["ses_1"],
      properties: {
        curation_lane: "provider_graph",
        curation_claim: false,
      },
    });
    expect((await kv.list<GraphEdge>("mem:graph:edges"))[0]).toMatchObject({
      project: "/project-a",
      sourceObservationIds: ["obs_2"],
      sourceSessionIds: ["ses_1"],
    });
    await sdk.trigger("mem::graph-snapshot-rebuild", { force: true });
    await expect(
      inspectGraphSessionReferences(kv as never, ["ses_1", "ses_missing"]),
    ).resolves.toEqual([
      {
        sessionId: "ses_1",
        nodeIds: expect.arrayContaining([expect.any(String), expect.any(String)]),
        edgeIds: [expect.any(String)],
      },
      { sessionId: "ses_missing", nodeIds: [], edgeIds: [] },
    ]);
    expect(await kv.get<Record<string, unknown>>("mem:sessions", "ses_1"))
      .toMatchObject({
        semanticGraphThroughObservationId: "obs_2",
        semanticGraphAnalyzer: "test",
        semanticGraphStatus: "complete",
      });
  });

  it("does not resurrect a session forgotten during provider inference", async () => {
    const localSdk = mockSdk();
    const localKv = mockKV();
    let signalProviderStarted: () => void = () => {};
    let releaseProvider: () => void = () => {};
    const providerStarted = new Promise<void>((resolve) => {
      signalProviderStarted = resolve;
    });
    const providerRelease = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const provider = {
      name: "test",
      compress: vi.fn(async () => {
        signalProviderStarted();
        await providerRelease;
        return `<entities>
<entity key="decision" type="decision" name="Keep lifecycle atomic" source_observation_ids="obs_1"/>
</entities>
<relationships></relationships>`;
      }),
      summarize: vi.fn(),
    };
    await localKv.set("mem:sessions", "ses_1", {
      id: "ses_1",
      project: "/project-a",
      cwd: "/project-a",
      startedAt: "2026-02-01T10:00:00Z",
      status: "completed",
      observationCount: 1,
    });
    await localKv.set("mem:obs:ses_1", "obs_1", testObs);
    registerGraphFunction(localSdk as never, localKv as never, provider as never);
    registerRememberFunction(localSdk as never, localKv as never);

    const extraction = localSdk.trigger("mem::graph-extract", {
      project: "/project-a",
      sessionId: "ses_1",
      observations: [testObs],
    }) as Promise<Record<string, unknown>>;
    await providerStarted;

    let forgetSettled = false;
    const forgetting = localSdk.trigger("mem::forget", {
      sessionId: "ses_1",
    }).then((value) => {
      forgetSettled = true;
      return value as Record<string, unknown>;
    });
    await Promise.resolve();
    expect(forgetSettled).toBe(false);
    releaseProvider();
    const [forgotten, result] = await Promise.all([forgetting, extraction]);

    expect(forgotten).toMatchObject({
      success: true,
      deleted: 2,
      graphNodesDeleted: 1,
      graphEdgesDeleted: 0,
    });
    expect(result).toMatchObject({
      success: true,
      nodesAdded: 1,
      edgesAdded: 0,
      semanticCompleted: true,
    });
    expect(await localKv.get("mem:sessions", "ses_1")).toBeNull();
    expect(await localKv.list("mem:obs:ses_1")).toEqual([]);
    expect(await localKv.list("mem:graph:nodes")).toEqual([]);
    expect(await localKv.list("mem:graph:edges")).toEqual([]);
    const audits = await localKv.list<{ functionId?: string }>("mem:audit");
    expect(audits.some((row) => row.functionId === "mem::forget")).toBe(true);
  });

  it("forgets only exact graph provenance, removes orphans, and is idempotent", async () => {
    const localSdk = mockSdk();
    const localKv = mockKV();
    registerGraphFunction(localSdk as never, localKv as never, mockProvider as never);
    registerRememberFunction(localSdk as never, localKv as never);
    const createdAt = "2026-02-01T10:00:00Z";
    await localKv.set("mem:sessions", "ses_a", {
      id: "ses_a",
      project: "/project-a",
      cwd: "/project-a",
      startedAt: createdAt,
      status: "completed",
      observationCount: 1,
      semanticGraphThroughObservationId: "obs_a",
      semanticGraphStatus: "complete",
    });
    await localKv.set("mem:sessions", "ses_b", {
      id: "ses_b",
      project: "/project-a",
      cwd: "/project-a",
      startedAt: createdAt,
      status: "completed",
      observationCount: 1,
    });
    await localKv.set("mem:obs:ses_a", "obs_a", {
      id: "obs_a",
      sessionId: "ses_a",
      timestamp: createdAt,
      raw: {},
    });
    await localKv.set("mem:obs:ses_b", "obs_b", {
      id: "obs_b",
      sessionId: "ses_b",
      timestamp: createdAt,
      raw: {},
    });
    await localKv.set("mem:summaries", "ses_a", { sessionId: "ses_a" });

    const nodes: GraphNode[] = [
      {
        id: "gn_exclusive",
        type: "concept",
        name: "Exclusive",
        project: "/project-a",
        properties: {},
        sourceObservationIds: ["obs_a"],
        sourceSessionIds: ["ses_a"],
        createdAt,
      },
      {
        id: "gn_shared",
        type: "concept",
        name: "Shared",
        project: "/project-a",
        properties: {},
        sourceObservationIds: ["obs_a", "obs_b"],
        sourceSessionIds: ["ses_a", "ses_b"],
        createdAt,
      },
      {
        id: "gn_other",
        type: "concept",
        name: "Other",
        project: "/project-a",
        properties: {},
        sourceObservationIds: ["obs_b"],
        sourceSessionIds: ["ses_b"],
        createdAt,
      },
    ];
    const edges: GraphEdge[] = [
      {
        id: "ge_exclusive",
        type: "related_to",
        sourceNodeId: "gn_exclusive",
        targetNodeId: "gn_shared",
        weight: 1,
        project: "/project-a",
        sourceObservationIds: ["obs_a"],
        sourceSessionIds: ["ses_a"],
        createdAt,
      },
      {
        id: "ge_shared",
        type: "related_to",
        sourceNodeId: "gn_shared",
        targetNodeId: "gn_other",
        weight: 1,
        project: "/project-a",
        sourceObservationIds: ["obs_a", "obs_b"],
        sourceSessionIds: ["ses_a", "ses_b"],
        createdAt,
      },
    ];
    for (const node of nodes) await localKv.set("mem:graph:nodes", node.id, node);
    for (const edge of edges) await localKv.set("mem:graph:edges", edge.id, edge);
    await localKv.set("mem:memories", "mem_keep", {
      id: "mem_keep",
      sessionIds: ["ses_a"],
      sourceObservationIds: ["obs_a"],
    });
    await localKv.set("mem:lessons", "lsn_keep", {
      id: "lsn_keep",
      sessionIds: ["ses_a"],
      sourceObservationIds: ["obs_a"],
    });
    await localKv.set("mem:commits", "commit_keep", {
      sha: "commit_keep",
      sessionIds: ["ses_a"],
    });
    await localSdk.trigger("mem::graph-snapshot-rebuild", { force: true });
    const listSpy = vi.spyOn(localKv, "list");
    const getSpy = vi.spyOn(localKv, "get");

    const first = await localSdk.trigger("mem::forget", {
      sessionId: "ses_a",
    }) as Record<string, unknown>;
    expect(first).toMatchObject({
      success: true,
      deleted: 3,
      graphNodesDeleted: 1,
      graphNodesDetached: 1,
      graphEdgesDeleted: 1,
      graphEdgesDetached: 1,
    });
    expect(await localKv.get("mem:graph:nodes", "gn_exclusive")).toBeNull();
    expect(await localKv.get("mem:graph:edges", "ge_exclusive")).toBeNull();
    expect(await localKv.get("mem:graph:nodes", "gn_shared")).toMatchObject({
      sourceObservationIds: ["obs_b"],
      sourceSessionIds: ["ses_b"],
    });
    expect(await localKv.get("mem:graph:edges", "ge_shared")).toMatchObject({
      sourceObservationIds: ["obs_b"],
      sourceSessionIds: ["ses_b"],
    });
    expect(await localKv.get("mem:graph:nodes", "gn_other")).toMatchObject({
      sourceObservationIds: ["obs_b"],
      sourceSessionIds: ["ses_b"],
    });
    expect(await localKv.get("mem:memories", "mem_keep")).not.toBeNull();
    expect(await localKv.get("mem:lessons", "lsn_keep")).not.toBeNull();
    expect(await localKv.get("mem:commits", "commit_keep")).not.toBeNull();
    expect(
      listSpy.mock.calls.some(([scope]) =>
        scope === "mem:graph:nodes" || scope === "mem:graph:edges"
      ),
    ).toBe(false);
    expect(
      getSpy.mock.calls.some(
        ([scope, key]) =>
          scope === "mem:graph:query-documents" &&
          String(key).startsWith("provenance-"),
      ),
    ).toBe(true);

    const second = await localSdk.trigger("mem::forget", {
      sessionId: "ses_a",
    }) as Record<string, unknown>;
    expect(second).toMatchObject({
      success: true,
      deleted: 0,
      alreadyAbsent: true,
    });
    expect(await localKv.get("mem:graph:nodes", "gn_shared")).toMatchObject({
      sourceObservationIds: ["obs_b"],
      sourceSessionIds: ["ses_b"],
    });
  });

  it("rewinds a deleted observation cursor and keeps same-session graph provenance", async () => {
    const localSdk = mockSdk();
    const localKv = mockKV();
    registerGraphFunction(localSdk as never, localKv as never, mockProvider as never);
    registerRememberFunction(localSdk as never, localKv as never);
    const createdAt = "2026-02-01T10:00:00Z";
    await localKv.set("mem:sessions", "ses_partial", {
      id: "ses_partial",
      project: "/project-a",
      cwd: "/project-a",
      startedAt: createdAt,
      status: "completed",
      observationCount: 2,
      semanticGraphThroughObservationId: "obs_2",
      semanticGraphStatus: "complete",
    });
    await localKv.set("mem:obs:ses_partial", "obs_1", {
      id: "obs_1",
      sessionId: "ses_partial",
      timestamp: "2026-02-01T10:00:00Z",
      raw: {},
    });
    await localKv.set("mem:obs:ses_partial", "obs_2", {
      id: "obs_2",
      sessionId: "ses_partial",
      timestamp: "2026-02-01T10:01:00Z",
      raw: {},
    });
    await localKv.set("mem:graph:nodes", "gn_partial", {
      id: "gn_partial",
      type: "concept",
      name: "Partial",
      project: "/project-a",
      properties: {},
      sourceObservationIds: ["obs_1", "obs_2"],
      sourceSessionIds: ["ses_partial"],
      createdAt,
    } satisfies GraphNode);
    await localSdk.trigger("mem::graph-snapshot-rebuild", { force: true });

    const result = await localSdk.trigger("mem::forget", {
      sessionId: "ses_partial",
      observationIds: ["obs_2"],
    }) as Record<string, unknown>;
    expect(result).toMatchObject({
      success: true,
      deleted: 1,
      graphNodesDetached: 1,
      graphNodesDeleted: 0,
    });
    expect(await localKv.get("mem:graph:nodes", "gn_partial")).toMatchObject({
      sourceObservationIds: ["obs_1"],
      sourceSessionIds: ["ses_partial"],
    });
    expect(await localKv.get("mem:sessions", "ses_partial")).toMatchObject({
      observationCount: 1,
      semanticGraphThroughObservationId: "obs_1",
      semanticGraphStatus: "complete",
    });
    expect(await localKv.get("mem:obs:ses_partial", "obs_2")).toBeNull();

    const replay = await localSdk.trigger("mem::forget", {
      sessionId: "ses_partial",
      observationIds: ["obs_2"],
    }) as Record<string, unknown>;
    expect(replay).toMatchObject({ success: true, deleted: 0, alreadyAbsent: true });
  });

  it("blocks forget when an exclusive node is still protected by another source edge", async () => {
    const localSdk = mockSdk();
    const localKv = mockKV();
    registerGraphFunction(localSdk as never, localKv as never, mockProvider as never);
    registerRememberFunction(localSdk as never, localKv as never);
    const createdAt = "2026-02-01T10:00:00Z";
    await localKv.set("mem:sessions", "ses_a", {
      id: "ses_a",
      project: "/project-a",
      cwd: "/project-a",
      startedAt: createdAt,
      status: "completed",
      observationCount: 1,
    });
    await localKv.set("mem:obs:ses_a", "obs_a", {
      id: "obs_a",
      sessionId: "ses_a",
      timestamp: createdAt,
      raw: {},
    });
    await localKv.set("mem:graph:nodes", "gn_a", {
      id: "gn_a",
      type: "concept",
      name: "A",
      project: "/project-a",
      properties: {},
      sourceObservationIds: ["obs_a"],
      sourceSessionIds: ["ses_a"],
      createdAt,
    } satisfies GraphNode);
    await localKv.set("mem:graph:nodes", "gn_b", {
      id: "gn_b",
      type: "concept",
      name: "B",
      project: "/project-a",
      properties: {},
      sourceObservationIds: ["obs_b"],
      sourceSessionIds: ["ses_b"],
      createdAt,
    } satisfies GraphNode);
    await localKv.set("mem:graph:edges", "ge_b", {
      id: "ge_b",
      type: "related_to",
      sourceNodeId: "gn_a",
      targetNodeId: "gn_b",
      weight: 1,
      project: "/project-a",
      sourceObservationIds: ["obs_b"],
      sourceSessionIds: ["ses_b"],
      createdAt,
    } satisfies GraphEdge);
    await localSdk.trigger("mem::graph-snapshot-rebuild", { force: true });

    await expect(localSdk.trigger("mem::forget", { sessionId: "ses_a" }))
      .rejects.toThrow("would lose all provenance while a referenced edge remains");
    expect(await localKv.get("mem:sessions", "ses_a")).not.toBeNull();
    expect(await localKv.get("mem:obs:ses_a", "obs_a")).not.toBeNull();
    expect(await localKv.get("mem:graph:nodes", "gn_a")).not.toBeNull();
    expect(await localKv.get("mem:graph:edges", "ge_b")).not.toBeNull();
  });

  it("fails closed before source deletion when the provenance index is legacy", async () => {
    const localSdk = mockSdk();
    const localKv = mockKV();
    registerGraphFunction(localSdk as never, localKv as never, mockProvider as never);
    registerRememberFunction(localSdk as never, localKv as never);
    const createdAt = "2026-02-01T10:00:00Z";
    await localKv.set("mem:sessions", "ses_a", {
      id: "ses_a",
      project: "/project-a",
      cwd: "/project-a",
      startedAt: createdAt,
      status: "completed",
      observationCount: 1,
    });
    await localKv.set("mem:obs:ses_a", "obs_a", {
      id: "obs_a",
      sessionId: "ses_a",
      timestamp: createdAt,
      raw: {},
    });
    await localKv.set("mem:graph:nodes", "gn_a", {
      id: "gn_a",
      type: "concept",
      name: "A",
      project: "/project-a",
      properties: {},
      sourceObservationIds: ["obs_a"],
      sourceSessionIds: ["ses_a"],
      createdAt,
    } satisfies GraphNode);
    await localSdk.trigger("mem::graph-snapshot-rebuild", { force: true });
    const manifest = await localKv.get<Record<string, unknown>>(
      "mem:graph:query-manifest",
      "current",
    );
    const { provenanceVersion: _ignored, ...legacyManifest } = manifest ?? {};
    await localKv.set("mem:graph:query-manifest", "current", legacyManifest);

    await expect(localSdk.trigger("mem::forget", { sessionId: "ses_a" }))
      .rejects.toThrow("exact graph provenance index is unavailable");
    expect(await localKv.get("mem:sessions", "ses_a")).not.toBeNull();
    expect(await localKv.get("mem:obs:ses_a", "obs_a")).not.toBeNull();
    expect(await localKv.get("mem:graph:nodes", "gn_a")).not.toBeNull();
  });

  it("sends only sanitized official narrative to the graph provider", async () => {
    const ambientObs: CompressedObservation = {
      ...testObs,
      narrative: '<panel source="ambient-ui-state">transient UI secret</panel>Kept user decision',
    };
    await kv.set("mem:sessions", "ses_1", {
      id: "ses_1",
      project: "/project-a",
      cwd: "/project-a",
      startedAt: "2026-02-01T10:00:00Z",
      status: "completed",
      observationCount: 1,
    });
    await kv.set("mem:obs:ses_1", "obs_1", ambientObs);
    mockProvider.compress.mockResolvedValueOnce(
      "<entities></entities><relationships></relationships>",
    );

    const result = await sdk.trigger("mem::graph-extract", {
      project: "/project-a",
      sessionId: "ses_1",
      observations: [ambientObs],
    }) as { success: boolean; semanticCompleted: boolean };

    expect(result).toMatchObject({ success: true, semanticCompleted: true });
    const prompt = String(mockProvider.compress.mock.calls[0]?.[1]);
    expect(prompt).toContain("Kept user decision");
    expect(prompt).not.toContain("transient UI secret");
    expect(await kv.get<Record<string, unknown>>("mem:sessions", "ses_1"))
      .toMatchObject({ semanticGraphThroughObservationId: "obs_1" });
  });

  it("repairs one malformed local-Qwen XML response and advances only after valid provenance", async () => {
    const localSdk = mockSdk();
    const localKv = mockKV();
    const provider = {
      name: "local-qwen",
      compress: vi.fn()
        .mockResolvedValueOnce("I found a decision but omitted the XML envelope")
        .mockResolvedValueOnce(`<entities>
<entity key="decision" type="decision" name="Repaired decision" source_observation_ids="obs_1"/>
</entities>
<relationships></relationships>`),
      summarize: vi.fn(),
      getRuntimeInfo: () => null,
    };
    await localKv.set("mem:sessions", "ses_1", {
      id: "ses_1",
      project: "/project-a",
      cwd: "/project-a",
      startedAt: "2026-02-01T10:00:00Z",
      status: "completed",
      observationCount: 1,
    });
    await localKv.set("mem:obs:ses_1", "obs_1", testObs);
    registerGraphFunction(localSdk as never, localKv as never, provider as never);

    const result = await localSdk.trigger("mem::graph-extract", {
      project: "/project-a",
      sessionId: "ses_1",
      observations: [testObs],
    }) as { semanticCompleted: boolean; semanticRepairAttempted: boolean };

    expect(result).toMatchObject({
      semanticCompleted: true,
      semanticRepairAttempted: true,
    });
    expect(provider.compress).toHaveBeenCalledTimes(2);
    expect(String(provider.compress.mock.calls[1]?.[1]))
      .toContain("at most 12 entities and 16 relationships");
    expect(await localKv.get<Record<string, unknown>>("mem:sessions", "ses_1"))
      .toMatchObject({
        semanticGraphThroughObservationId: "obs_1",
        semanticGraphStatus: "complete",
      });
  });

  it("repairs relationships whose endpoints are absent from the repaired entity set", async () => {
    const localSdk = mockSdk();
    const localKv = mockKV();
    const provider = {
      name: "local-qwen",
      compress: vi.fn()
        .mockResolvedValueOnce(`<entities>
<entity key="decision" type="decision" name="Grounded decision" source_observation_ids="obs_1"/>
</entities>
<relationships>
<relationship type="depends_on" source="decision" target="missing" source_observation_ids="obs_1"/>
</relationships>`)
        .mockResolvedValueOnce(`<entities>
<entity key="decision" type="decision" name="Grounded decision" source_observation_ids="obs_1"/>
</entities>
<relationships>
<relationship type="depends_on" source="decision" target="missing" source_observation_ids="obs_1"/>
</relationships>`),
      summarize: vi.fn(),
      getRuntimeInfo: () => null,
    };
    await localKv.set("mem:sessions", "ses_1", {
      id: "ses_1",
      project: "/project-a",
      cwd: "/project-a",
      startedAt: "2026-02-01T10:00:00Z",
      status: "completed",
      observationCount: 1,
    });
    await localKv.set("mem:obs:ses_1", "obs_1", testObs);
    registerGraphFunction(localSdk as never, localKv as never, provider as never);

    const result = await localSdk.trigger("mem::graph-extract", {
      project: "/project-a",
      sessionId: "ses_1",
      observations: [testObs],
    }) as { semanticCompleted: boolean; semanticRepairAttempted: boolean };

    expect(result).toMatchObject({
      semanticCompleted: true,
      semanticRepairAttempted: true,
    });
    expect(provider.compress).toHaveBeenCalledTimes(2);
    expect(String(provider.compress.mock.calls[1]?.[1]))
      .toContain("Every relationship source and target must exactly match an entity key");
    expect(await localKv.list<GraphEdge>("mem:graph:edges")).toEqual([]);
    expect(await localKv.get<Record<string, unknown>>("mem:sessions", "ses_1"))
      .toMatchObject({
        semanticGraphThroughObservationId: "obs_1",
        semanticGraphStatus: "complete",
      });
  });

  it("keeps repaired entity provenance fail-closed while omitting orphan relationships", async () => {
    const localSdk = mockSdk();
    const localKv = mockKV();
    const provider = {
      name: "local-qwen",
      compress: vi.fn()
        .mockResolvedValueOnce("invalid graph envelope")
        .mockResolvedValueOnce(`<entities>
<entity key="decision" type="decision" name="Ungrounded decision" source_observation_ids="obs_outside"/>
</entities>
<relationships>
<relationship type="depends_on" source="decision" target="missing" source_observation_ids="obs_outside"/>
</relationships>`),
      summarize: vi.fn(),
      getRuntimeInfo: () => null,
    };
    await localKv.set("mem:sessions", "ses_1", {
      id: "ses_1",
      project: "/project-a",
      cwd: "/project-a",
      startedAt: "2026-02-01T10:00:00Z",
      status: "completed",
      observationCount: 1,
    });
    await localKv.set("mem:obs:ses_1", "obs_1", testObs);
    registerGraphFunction(localSdk as never, localKv as never, provider as never);

    const result = await localSdk.trigger("mem::graph-extract", {
      project: "/project-a",
      sessionId: "ses_1",
      observations: [testObs],
    }) as { semanticCompleted: boolean; semanticError: string };

    expect(result.semanticCompleted).toBe(false);
    expect(result.semanticError).toContain("outside the input batch");
    expect(await localKv.list<GraphNode>("mem:graph:nodes")).toEqual([]);
    expect((await localKv.get<Record<string, unknown>>("mem:sessions", "ses_1"))
      ?.semanticGraphThroughObservationId).toBeUndefined();
  });

  it.each([
    [
      "prose outside the two roots",
      `answer follows\n<entities><entity key="n1" type="concept" name="Graph" source_observation_ids="obs_1"/></entities><relationships></relationships>`,
    ],
    [
      "an unparsed malformed property",
      `<entities><entity key="n1" type="concept" name="Graph" source_observation_ids="obs_1"><property key="valid">kept</property><property key="broken">unterminated</entity></entities><relationships></relationships>`,
    ],
    [
      "duplicate attributes",
      `<entities><entity key="n1" type="concept" type="error" name="Graph" source_observation_ids="obs_1"/></entities><relationships></relationships>`,
    ],
    [
      "an unparsed attribute fragment",
      `<entities><entity key="n1" type="concept" ignored-fragment name="Graph" source_observation_ids="obs_1"/></entities><relationships></relationships>`,
    ],
    [
      "an unknown XML entity",
      `<entities><entity key="n1" type="concept" name="Graph &unknown; value" source_observation_ids="obs_1"/></entities><relationships></relationships>`,
    ],
  ])("fails closed when repaired graph XML contains %s", async (_label, malformedXml) => {
    const localSdk = mockSdk();
    const localKv = mockKV();
    const provider = {
      name: "local-qwen",
      compress: vi.fn().mockResolvedValue(malformedXml),
      summarize: vi.fn(),
      getRuntimeInfo: () => null,
    };
    await localKv.set("mem:sessions", "ses_1", {
      id: "ses_1",
      project: "/project-a",
      cwd: "/project-a",
      startedAt: "2026-02-01T10:00:00Z",
      status: "completed",
      observationCount: 1,
    });
    await localKv.set("mem:obs:ses_1", "obs_1", testObs);
    registerGraphFunction(localSdk as never, localKv as never, provider as never);

    const result = await localSdk.trigger("mem::graph-extract", {
      project: "/project-a",
      sessionId: "ses_1",
      observations: [testObs],
    }) as { semanticCompleted: boolean; semanticError: string };

    expect(result.semanticCompleted).toBe(false);
    expect(result.semanticError).toMatch(/XML|attribute|property/i);
    expect(provider.compress).toHaveBeenCalledTimes(2);
    expect(await localKv.list<GraphNode>("mem:graph:nodes")).toEqual([]);
    expect((await localKv.get<Record<string, unknown>>("mem:sessions", "ses_1"))
      ?.semanticGraphThroughObservationId).toBeUndefined();
  });

  it("keeps the repaired total relationship bound when every endpoint is orphaned", async () => {
    const localSdk = mockSdk();
    const localKv = mockKV();
    const orphanRelationships = Array.from({ length: 33 }, (_, index) =>
      `<relationship type="related_to" source="missing_${index}" target="also_missing_${index}" source_observation_ids="obs_1"/>`,
    ).join("\n");
    const provider = {
      name: "local-qwen",
      compress: vi.fn()
        .mockResolvedValueOnce("invalid graph envelope")
        .mockResolvedValueOnce(`<entities></entities><relationships>${orphanRelationships}</relationships>`),
      summarize: vi.fn(),
      getRuntimeInfo: () => null,
    };
    await localKv.set("mem:sessions", "ses_1", {
      id: "ses_1",
      project: "/project-a",
      cwd: "/project-a",
      startedAt: "2026-02-01T10:00:00Z",
      status: "completed",
      observationCount: 1,
    });
    await localKv.set("mem:obs:ses_1", "obs_1", testObs);
    registerGraphFunction(localSdk as never, localKv as never, provider as never);

    const result = await localSdk.trigger("mem::graph-extract", {
      project: "/project-a",
      sessionId: "ses_1",
      observations: [testObs],
    }) as { semanticCompleted: boolean; semanticError: string };

    expect(result.semanticCompleted).toBe(false);
    expect(result.semanticError).toContain("bounded relationship limit");
    expect(await localKv.list<GraphEdge>("mem:graph:edges")).toEqual([]);
    expect((await localKv.get<Record<string, unknown>>("mem:sessions", "ses_1"))
      ?.semanticGraphThroughObservationId).toBeUndefined();
  });

  it("repairs raw XML metacharacters and decodes escaped graph values", async () => {
    const localSdk = mockSdk();
    const localKv = mockKV();
    const provider = {
      name: "local-qwen",
      compress: vi.fn()
        .mockResolvedValueOnce(`<entities>
<entity key="location" type="location" name="%TEMP%\\Pilot-<timestamp>" source_observation_ids="obs_1"/>
</entities>
<relationships></relationships>`)
        .mockResolvedValueOnce(`<entities>
<entity key="location" type="location" name="%TEMP%\\Pilot-&lt;timestamp&gt; &amp; evidence" source_observation_ids="obs_1">
<property key="comparison">A &lt; B &amp; C</property>
</entity>
</entities>
<relationships></relationships>`),
      summarize: vi.fn(),
      getRuntimeInfo: () => null,
    };
    await localKv.set("mem:sessions", "ses_1", {
      id: "ses_1",
      project: "/project-a",
      cwd: "/project-a",
      startedAt: "2026-02-01T10:00:00Z",
      status: "completed",
      observationCount: 1,
    });
    await localKv.set("mem:obs:ses_1", "obs_1", testObs);
    registerGraphFunction(localSdk as never, localKv as never, provider as never);

    const result = await localSdk.trigger("mem::graph-extract", {
      project: "/project-a",
      sessionId: "ses_1",
      observations: [testObs],
    }) as { semanticCompleted: boolean; semanticRepairAttempted: boolean };

    expect(result).toMatchObject({
      semanticCompleted: true,
      semanticRepairAttempted: true,
    });
    expect(String(provider.compress.mock.calls[1]?.[1]))
      .toContain("XML-escape attribute and property values");
    expect(await localKv.list<GraphNode>("mem:graph:nodes"))
      .toContainEqual(expect.objectContaining({
        name: "%TEMP%\\Pilot-<timestamp> & evidence",
        properties: expect.objectContaining({ comparison: "A < B & C" }),
      }));
  });

  it("fails closed and repairs when the provider exceeds the bounded graph size", async () => {
    const localSdk = mockSdk();
    const localKv = mockKV();
    const oversizedEntities = Array.from({ length: 25 }, (_, index) =>
      `<entity key="n${index}" type="concept" name="Concept ${index}" source_observation_ids="obs_1"/>`,
    ).join("\n");
    const provider = {
      name: "local-qwen",
      compress: vi.fn()
        .mockResolvedValueOnce(`<entities>${oversizedEntities}</entities><relationships></relationships>`)
        .mockResolvedValueOnce("<entities></entities><relationships></relationships>"),
      summarize: vi.fn(),
      getRuntimeInfo: () => null,
    };
    await localKv.set("mem:sessions", "ses_1", {
      id: "ses_1",
      project: "/project-a",
      cwd: "/project-a",
      startedAt: "2026-02-01T10:00:00Z",
      status: "completed",
      observationCount: 1,
    });
    await localKv.set("mem:obs:ses_1", "obs_1", testObs);
    registerGraphFunction(localSdk as never, localKv as never, provider as never);

    const result = await localSdk.trigger("mem::graph-extract", {
      project: "/project-a",
      sessionId: "ses_1",
      observations: [testObs],
    }) as { semanticCompleted: boolean; semanticRepairAttempted: boolean };

    expect(result).toMatchObject({
      semanticCompleted: true,
      semanticRepairAttempted: true,
    });
    expect(provider.compress).toHaveBeenCalledTimes(2);
    expect(await localKv.list<GraphNode>("mem:graph:nodes")).toEqual([]);
  });

  it("keeps the semantic cursor unchanged when foreground Qwen preempts extraction", async () => {
    const localSdk = mockSdk();
    const localKv = mockKV();
    const provider = {
      name: "local-qwen",
      compress: vi.fn(async () => {
        throw new Error("local_qwen_deferred:foreground_requested");
      }),
      summarize: vi.fn(),
      getRuntimeInfo: () => null,
    };
    await localKv.set("mem:sessions", "ses_1", {
      id: "ses_1",
      project: "/project-a",
      cwd: "/project-a",
      startedAt: "2026-02-01T10:00:00Z",
      status: "completed",
      observationCount: 1,
    });
    await localKv.set("mem:obs:ses_1", "obs_1", testObs);
    registerGraphFunction(localSdk as never, localKv as never, provider as never);

    const result = await localSdk.trigger("mem::graph-extract", {
      project: "/project-a",
      sessionId: "ses_1",
      observations: [testObs],
    }) as { semanticCompleted: boolean; semanticError: string };

    expect(result).toMatchObject({
      semanticCompleted: false,
      semanticError: "local_qwen_deferred:foreground_requested",
    });
    expect(await localKv.get<Record<string, unknown>>("mem:sessions", "ses_1"))
      .toMatchObject({
        semanticGraphStatus: "deferred",
        semanticGraphLastError: "local_qwen_deferred:foreground_requested",
      });
    expect((await localKv.get<Record<string, unknown>>("mem:sessions", "ses_1"))
      ?.semanticGraphThroughObservationId).toBeUndefined();
  });

  it("manual zero-LLM upsert isolates projects and merges exact provenance", async () => {
    for (const [sessionId, project, observationId] of [
      ["ses_a1", "/a", "obs_a1"],
      ["ses_a2", "/a", "obs_a2"],
      ["ses_b1", "/b", "obs_b1"],
    ] as const) {
      await kv.set("mem:sessions", sessionId, {
        id: sessionId,
        project,
        cwd: project,
        startedAt: "2026-01-01T00:00:00Z",
        status: "completed",
        observationCount: 1,
      });
      await kv.set(`mem:obs:${sessionId}`, observationId, {
        ...testObs,
        id: observationId,
        sessionId,
      });
    }
    const upsert = (project: string, sessionId: string, observationId: string) =>
      sdk.trigger("mem::graph-upsert", {
        project,
        sources: [{ sessionId, observationIds: [observationId] }],
        nodes: [{ key: "canonical", type: "decision", name: "Canonical policy" }],
      });

    const firstA = (await upsert("/a", "ses_a1", "obs_a1")) as {
      success: boolean;
      nodeIds: Record<string, string>;
    };
    const firstB = (await upsert("/b", "ses_b1", "obs_b1")) as {
      success: boolean;
      nodeIds: Record<string, string>;
    };
    const secondA = (await upsert("/a", "ses_a2", "obs_a2")) as {
      success: boolean;
      nodeIds: Record<string, string>;
      nodesMerged: number;
    };

    expect(mockProvider.compress).not.toHaveBeenCalled();
    expect(firstA.success).toBe(true);
    expect(firstB.success).toBe(true);
    expect(firstA.nodeIds.canonical).not.toBe(firstB.nodeIds.canonical);
    expect(secondA).toMatchObject({ success: true, nodesMerged: 1 });
    expect(secondA.nodeIds.canonical).toBe(firstA.nodeIds.canonical);

    const merged = await kv.get<GraphNode>("mem:graph:nodes", firstA.nodeIds.canonical);
    expect(merged?.sourceSessionIds).toEqual(["ses_a1", "ses_a2"]);
    expect(merged?.sourceObservationIds).toEqual(["obs_a1", "obs_a2"]);
    const queryA = (await sdk.trigger("mem::graph-query", { project: "/a" })) as GraphQueryResult;
    const queryB = (await sdk.trigger("mem::graph-query", { project: "/b" })) as GraphQueryResult;
    expect(queryA.nodes.map((node) => node.id)).toEqual([firstA.nodeIds.canonical]);
    expect(queryB.nodes.map((node) => node.id)).toEqual([firstB.nodeIds.canonical]);
  });

  it("physically purges one exact bounded project graph and preserves other stores", async () => {
    for (const [sessionId, project, observationId] of [
      ["ses_a", "/a", "obs_a"],
      ["ses_b", "/b", "obs_b"],
    ] as const) {
      await kv.set("mem:sessions", sessionId, {
        id: sessionId,
        project,
        cwd: project,
        startedAt: "2026-01-01T00:00:00Z",
        status: "completed",
        observationCount: 1,
      });
      await kv.set(`mem:obs:${sessionId}`, observationId, {
        ...testObs,
        id: observationId,
        sessionId,
      });
    }
    await kv.set("mem:memories", "mem_keep", { id: "mem_keep", project: "/a" });
    await kv.set("mem:lessons", "lsn_keep", { id: "lsn_keep", project: "/a" });

    const graphA = (await sdk.trigger("mem::graph-upsert", {
      project: "/a",
      sources: [{ sessionId: "ses_a", observationIds: ["obs_a"] }],
      nodes: [
        { key: "a1", type: "project", name: "Project A" },
        { key: "a2", type: "decision", name: "Decision A" },
      ],
      edges: [{ source: "a1", target: "a2", type: "uses" }],
    })) as { success: boolean; nodeIds: Record<string, string> };
    await sdk.trigger("mem::graph-upsert", {
      project: "/b",
      sources: [{ sessionId: "ses_b", observationIds: ["obs_b"] }],
      nodes: [{ key: "b1", type: "project", name: "Project B" }],
    });
    expect(graphA.success).toBe(true);

    const beforeA = (await sdk.trigger("mem::graph-query", {
      project: "/a",
    })) as GraphQueryResult;
    const edgeId = beforeA.edges[0]!.id;
    await kv.set("mem:graph:edge-history", edgeId, beforeA.edges[0]);
    await kv.set("mem:graph:nodes", "gn_stale_a", {
      ...beforeA.nodes[0],
      id: "gn_stale_a",
      name: "Stale Project A",
      stale: true,
    });
    await kv.set("mem:graph:edges", "ge_stale_a", {
      ...beforeA.edges[0],
      id: "ge_stale_a",
      sourceNodeId: "gn_stale_a",
      stale: true,
    });
    await kv.set("mem:graph:edge-history", "ge_stale_a", { stale: true });
    await kv.set(
      "mem:graph:name-index",
      "project|Stale Project A",
      "gn_stale_a",
    );

    const result = (await sdk.trigger("mem::graph-project-purge", {
      project: "/a",
      nodeIds: beforeA.nodes.map((node) => node.id),
      edgeIds: beforeA.edges.map((edge) => edge.id),
      reason: "replace stale project graph",
    })) as {
      success: boolean;
      auditId: string;
      nodesDeleted: number;
      edgesDeleted: number;
    };

    expect(result).toMatchObject({
      success: true,
      nodesDeleted: 3,
      edgesDeleted: 2,
      liveNodesDeleted: 2,
      liveEdgesDeleted: 1,
    });
    expect(await sdk.trigger("mem::graph-query", { project: "/a" })).toMatchObject({
      totalNodes: 0,
      totalEdges: 0,
    });
    expect(await sdk.trigger("mem::graph-query", { project: "/b" })).toMatchObject({
      totalNodes: 1,
      totalEdges: 0,
    });
    expect(await kv.list<GraphNode>("mem:graph:nodes")).toHaveLength(1);
    expect(await kv.list<GraphEdge>("mem:graph:edges")).toEqual([]);
    expect(await kv.get("mem:graph:edge-history", edgeId)).toBeNull();
    expect(await kv.get("mem:graph:edge-history", "ge_stale_a")).toBeNull();
    expect(await kv.get("mem:graph:node-degree", graphA.nodeIds.a1)).toBeNull();
    expect(await kv.list<string>("mem:graph:name-index")).not.toContain(
      graphA.nodeIds.a1,
    );
    expect(await kv.get("mem:sessions", "ses_a")).not.toBeNull();
    expect(await kv.get("mem:obs:ses_a", "obs_a")).not.toBeNull();
    expect(await kv.get("mem:memories", "mem_keep")).not.toBeNull();
    expect(await kv.get("mem:lessons", "lsn_keep")).not.toBeNull();
    expect(await kv.get<{ details: { phase: string } }>("mem:audit", result.auditId))
      .toMatchObject({ details: { phase: "completed" } });
  });

  it("refuses partial or oversized physical graph purge inventories without mutation", async () => {
    await kv.set("mem:sessions", "ses_a", {
      id: "ses_a",
      project: "/a",
      cwd: "/a",
      startedAt: "2026-01-01T00:00:00Z",
      status: "completed",
      observationCount: 1,
    });
    await kv.set("mem:obs:ses_a", "obs_a", {
      ...testObs,
      id: "obs_a",
      sessionId: "ses_a",
    });
    await sdk.trigger("mem::graph-upsert", {
      project: "/a",
      sources: [{ sessionId: "ses_a", observationIds: ["obs_a"] }],
      nodes: [
        { key: "a1", type: "project", name: "Project A" },
        { key: "a2", type: "decision", name: "Decision A" },
      ],
      edges: [{ source: "a1", target: "a2", type: "uses" }],
    });
    const before = (await sdk.trigger("mem::graph-query", {
      project: "/a",
    })) as GraphQueryResult;

    const partial = (await sdk.trigger("mem::graph-project-purge", {
      project: "/a",
      nodeIds: [before.nodes[0]!.id],
      edgeIds: before.edges.map((edge) => edge.id),
      reason: "incomplete inventory",
    })) as { success: boolean; error: string };
    expect(partial.success).toBe(false);
    expect(partial.error).toMatch(/exactly match/);
    expect(await kv.list<GraphNode>("mem:graph:nodes")).toHaveLength(2);

    const snap = await kv.get<Record<string, unknown>>(
      "mem:graph:snapshot",
      "current",
    );
    await kv.set("mem:graph:snapshot", "current", {
      ...snap,
      stats: { totalNodes: 501, totalEdges: 0, nodesByType: {}, edgesByType: {} },
    });
    const oversized = (await sdk.trigger("mem::graph-project-purge", {
      project: "/a",
      nodeIds: before.nodes.map((node) => node.id),
      edgeIds: before.edges.map((edge) => edge.id),
      reason: "oversized snapshot",
    })) as { success: boolean; error: string };
    expect(oversized.success).toBe(false);
    expect(oversized.error).toMatch(/bounded snapshot/);
    expect(await kv.list<GraphNode>("mem:graph:nodes")).toHaveLength(2);
  });

  it("manual upsert reuses the oldest legacy canonical and absorbs a scoped duplicate", async () => {
    await kv.set("mem:sessions", "ses_new", {
      id: "ses_new",
      project: "/app",
      cwd: "/app",
      startedAt: "2026-01-03T00:00:00Z",
      status: "completed",
      observationCount: 1,
    });
    await kv.set("mem:obs:ses_new", "obs_new", {
      ...testObs,
      id: "obs_new",
      sessionId: "ses_new",
    });
    await kv.set("mem:graph:nodes", "gn_legacy", {
      id: "gn_legacy",
      type: "event",
      name: "Canonical event",
      properties: { project: "/app", legacy: "kept" },
      sourceObservationIds: ["obs_old"],
      sourceSessionIds: ["ses_old"],
      createdAt: "2026-01-01T00:00:00Z",
    } satisfies GraphNode);
    await kv.set("mem:graph:nodes", "gn_duplicate", {
      id: "gn_duplicate",
      type: "event",
      name: "canonical event",
      project: "/app",
      properties: { project: "/app", duplicate: "absorbed" },
      sourceObservationIds: ["obs_duplicate"],
      sourceSessionIds: ["ses_duplicate"],
      createdAt: "2026-01-02T00:00:00Z",
    } satisfies GraphNode);
    await kv.set("mem:graph:nodes", "gn_target", {
      id: "gn_target",
      type: "concept",
      name: "Target",
      project: "/app",
      properties: { project: "/app" },
      sourceObservationIds: ["obs_duplicate"],
      sourceSessionIds: ["ses_duplicate"],
      createdAt: "2026-01-02T00:00:00Z",
    } satisfies GraphNode);
    await kv.set("mem:graph:edges", "ge_duplicate", {
      id: "ge_duplicate",
      type: "related_to",
      sourceNodeId: "gn_duplicate",
      targetNodeId: "gn_target",
      project: "/app",
      sourceObservationIds: ["obs_duplicate"],
      sourceSessionIds: ["ses_duplicate"],
      createdAt: "2026-01-02T00:00:00Z",
      weight: 0.5,
    } satisfies GraphEdge);
    await sdk.trigger("mem::graph-snapshot-rebuild", { force: true });

    const originalList = kv.list.bind(kv);
    let canonicalGraphListCalls = 0;
    kv.list = async <T>(scope: string): Promise<T[]> => {
      if (scope === "mem:graph:nodes" || scope === "mem:graph:edges") {
        canonicalGraphListCalls++;
      }
      return originalList<T>(scope);
    };

    const result = (await sdk.trigger("mem::graph-upsert", {
      project: "/app",
      sources: [{ sessionId: "ses_new", observationIds: ["obs_new"] }],
      nodes: [{
        key: "canonical",
        type: "event",
        name: "CANONICAL EVENT",
        properties: { current: "verified" },
      }],
    })) as { success: boolean; nodeIds: Record<string, string>; nodesMerged: number };

    expect(result).toMatchObject({ success: true, nodesMerged: 1 });
    expect(canonicalGraphListCalls).toBe(0);
    expect(result.nodeIds.canonical).toBe("gn_legacy");
    const canonical = await kv.get<GraphNode>("mem:graph:nodes", "gn_legacy");
    const duplicate = await kv.get<GraphNode>("mem:graph:nodes", "gn_duplicate");
    const edge = await kv.get<GraphEdge>("mem:graph:edges", "ge_duplicate");
    expect(canonical?.sourceObservationIds).toEqual([
      "obs_old",
      "obs_duplicate",
      "obs_new",
    ]);
    expect(canonical?.sourceSessionIds).toEqual([
      "ses_old",
      "ses_duplicate",
      "ses_new",
    ]);
    expect(canonical?.properties).toMatchObject({
      legacy: "kept",
      duplicate: "absorbed",
      current: "verified",
    });
    expect(duplicate).toMatchObject({ stale: true, properties: { supersededBy: "gn_legacy" } });
    expect(edge).toMatchObject({
      stale: false,
      sourceNodeId: "gn_legacy",
      targetNodeId: "gn_target",
    });
    expect(await kv.get("mem:graph:edge-key", "gn_duplicate|gn_target|related_to"))
      .toBeNull();
    expect(await kv.get("mem:graph:edge-key", "gn_legacy|gn_target|related_to"))
      .toBe("ge_duplicate");
    expect(await kv.get("mem:graph:node-degree", "gn_legacy")).toBe(1);
    expect(await kv.get("mem:graph:node-degree", "gn_duplicate")).toBe(0);
    const query = (await sdk.trigger("mem::graph-query", {
      project: "/app",
      query: "Canonical event",
    })) as GraphQueryResult;
    expect(query.fromIndex).toBe(true);
    expect(query.nodes.map((node) => node.id)).toEqual(["gn_legacy"]);
    const snapshot = await kv.get<{ stats: { totalNodes: number; totalEdges: number } }>(
      "mem:graph:snapshot",
      "current",
    );
    expect(snapshot?.stats).toMatchObject({ totalNodes: 2, totalEdges: 1 });
  });

  it("manual upsert preserves case-distinct file and function identities", async () => {
    await kv.set("mem:sessions", "ses_case", {
      id: "ses_case",
      project: "/app",
      cwd: "/app",
      startedAt: "2026-01-03T00:00:00Z",
      status: "completed",
      observationCount: 1,
    });
    await kv.set("mem:obs:ses_case", "obs_case", {
      ...testObs,
      id: "obs_case",
      sessionId: "ses_case",
    });

    const result = (await sdk.trigger("mem::graph-upsert", {
      project: "/app",
      sources: [{ sessionId: "ses_case", observationIds: ["obs_case"] }],
      nodes: [
        { key: "file_upper", type: "file", name: "Foo.ts" },
        { key: "file_lower", type: "file", name: "foo.ts" },
        { key: "function_upper", type: "function", name: "Parse" },
        { key: "function_lower", type: "function", name: "parse" },
      ],
    })) as { success: boolean; nodesCreated: number; nodeIds: Record<string, string> };

    expect(result).toMatchObject({ success: true, nodesCreated: 4 });
    expect(new Set(Object.values(result.nodeIds))).toHaveLength(4);
  });

  it.each([
    ["missing observation", "/a", false],
    ["cross-project observation", "/other", false],
    ["excluded session", "/a", true],
  ])("manual upsert rejects %s without graph mutation", async (_label, sourceProject, excluded) => {
    await kv.set("mem:sessions", "ses_invalid", {
      id: "ses_invalid",
      project: sourceProject,
      cwd: sourceProject,
      startedAt: "2026-01-01T00:00:00Z",
      status: "completed",
      observationCount: 1,
      captureExcluded: excluded,
    });
    if (_label !== "missing observation") {
      await kv.set("mem:obs:ses_invalid", "obs_invalid", {
        ...testObs,
        id: "obs_invalid",
        sessionId: "ses_invalid",
      });
    }

    const result = (await sdk.trigger("mem::graph-upsert", {
      project: "/a",
      sources: [{ sessionId: "ses_invalid", observationIds: ["obs_invalid"] }],
      nodes: [{ key: "invalid", type: "decision", name: "Must not persist" }],
    })) as { success: boolean };

    expect(result.success).toBe(false);
    expect(await kv.list("mem:graph:nodes")).toEqual([]);
    expect(await kv.list("mem:graph:edges")).toEqual([]);
  });

  it("graph-extract accepts self-closing entity tags", async () => {
    mockProvider.compress.mockResolvedValueOnce(`<entities>
<entity type="file" name="src/index.ts"/>
<entity type="function" name="main"><property key="lang">typescript</property></entity>
</entities>
<relationships>
<relationship type="uses" source="src/index.ts" target="main" weight="0.9"/>
</relationships>`);

    const result = (await sdk.trigger("mem::graph-extract", {
      observations: [testObs],
    })) as { success: boolean; nodesAdded: number; edgesAdded: number };

    expect(result.success).toBe(true);
    expect(result.nodesAdded).toBe(2);
    expect(result.edgesAdded).toBe(1);

    const nodes = await kv.list<GraphNode>("mem:graph:nodes");
    expect(nodes.some((n) => n.name === "src/index.ts")).toBe(true);
    expect(nodes.some((n) => n.name === "main")).toBe(true);

    const edges = await kv.list<GraphEdge>("mem:graph:edges");
    expect(edges).toHaveLength(1);
    expect(edges[0].type).toBe("uses");
  });

  it("graph-extract tolerates reordered attributes (#635)", async () => {
    // Codex CLI's LLM tends to emit attribute order name→type and
    // source→target→type rather than the hard-coded type-first /
    // type/source/target/weight sequence the old parser required.
    mockProvider.compress.mockResolvedValueOnce(`<entities>
<entity name="src/index.ts" type="file"/>
<entity name="main" type="function"><property key="lang">typescript</property></entity>
</entities>
<relationships>
<relationship source="src/index.ts" target="main" type="uses" weight="0.9"/>
</relationships>`);

    const result = (await sdk.trigger("mem::graph-extract", {
      observations: [testObs],
    })) as { success: boolean; nodesAdded: number; edgesAdded: number };

    expect(result.success).toBe(true);
    expect(result.nodesAdded).toBe(2);
    expect(result.edgesAdded).toBe(1);

    const nodes = await kv.list<GraphNode>("mem:graph:nodes");
    expect(nodes.find((n) => n.name === "src/index.ts")?.type).toBe("file");
    expect(nodes.find((n) => n.name === "main")?.type).toBe("function");

    const edges = await kv.list<GraphEdge>("mem:graph:edges");
    expect(edges).toHaveLength(1);
    expect(edges[0].type).toBe("uses");
    expect(edges[0].weight).toBeCloseTo(0.9, 5);
  });

  it("graph-query with search returns matching nodes", async () => {
    await sdk.trigger("mem::graph-extract", { observations: [testObs] });

    const result = (await sdk.trigger("mem::graph-query", {
      query: "index",
    })) as GraphQueryResult;

    expect(result.nodes.length).toBeGreaterThanOrEqual(1);
    expect(result.nodes.some((n) => n.name.includes("index"))).toBe(true);
  });

  it("graph-query matches a bounded OR-list of federated prompt tokens in one enumeration", async () => {
    await sdk.trigger("mem::graph-extract", { observations: [testObs] });

    const result = (await sdk.trigger("mem::graph-query", {
      project: "*",
      queries: ["index", "main"],
      limit: 10,
    })) as GraphQueryResult;

    expect(result.nodes.some((node) => node.name === "src/index.ts")).toBe(true);
    expect(result.nodes.some((node) => node.name === "main")).toBe(true);
  });

  it("graph-query with startNodeId does BFS traversal", async () => {
    await sdk.trigger("mem::graph-extract", { observations: [testObs] });

    const nodes = await kv.list<GraphNode>("mem:graph:nodes");
    const fileNode = nodes.find((n) => n.name === "src/index.ts")!;

    const result = (await sdk.trigger("mem::graph-query", {
      startNodeId: fileNode.id,
      maxDepth: 2,
    })) as GraphQueryResult;

    expect(result.nodes.length).toBeGreaterThanOrEqual(1);
    expect(result.edges.length).toBeGreaterThanOrEqual(1);
    expect(result.depth).toBe(2);
  });

  it("graph-stats returns counts by type", async () => {
    await sdk.trigger("mem::graph-extract", { observations: [testObs] });

    const result = (await sdk.trigger("mem::graph-stats", {})) as {
      totalNodes: number;
      totalEdges: number;
      nodesByType: Record<string, number>;
      edgesByType: Record<string, number>;
    };

    expect(result.totalNodes).toBe(2);
    expect(result.totalEdges).toBe(1);
    expect(result.nodesByType.file).toBe(1);
    expect(result.nodesByType.function).toBe(1);
    expect(result.edgesByType.uses).toBe(1);
  });

  it("graph-extract returns error for empty observations", async () => {
    const result = (await sdk.trigger("mem::graph-extract", {
      observations: [],
    })) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("No observations");
  });

  // #753: an unbounded {} body used to materialize every node+edge in
  // one payload, which exceeded the iii state response channel on
  // large corpora (11k+ nodes) and returned HTTP 500 "Invocation
  // stopped". The fix caps the page at DEFAULT_GRAPH_QUERY_LIMIT (500)
  // and surfaces totalNodes / totalEdges so callers know it was
  // truncated.
  it("caps an unbounded graph-query body to a default page and reports totals", async () => {
    // Seed a graph with more nodes than the default page size.
    const NODE_COUNT = 1200;
    for (let i = 0; i < NODE_COUNT; i++) {
      const node: GraphNode = {
        id: `n_${i.toString().padStart(4, "0")}`,
        type: "concept",
        name: `node-${i}`,
        properties: {},
        firstSeen: "2026-01-01T00:00:00Z",
        lastSeen: "2026-01-01T00:00:00Z",
        observationCount: 1,
      } as GraphNode;
      await kv.set("mem:graph:nodes", node.id, node);
    }
    // A few edges among the first 50 nodes so high-degree ranking has
    // something to grade.
    for (let i = 0; i < 50; i++) {
      const edge: GraphEdge = {
        id: `e_${i}`,
        type: "related_to",
        sourceNodeId: `n_${i.toString().padStart(4, "0")}`,
        targetNodeId: `n_${((i + 1) % 50).toString().padStart(4, "0")}`,
        weight: 1,
        evidence: [],
        firstSeen: "2026-01-01T00:00:00Z",
        lastSeen: "2026-01-01T00:00:00Z",
      } as GraphEdge;
      await kv.set("mem:graph:edges", edge.id, edge);
    }

    // Post-#814 the empty-body path reads the snapshot exclusively.
    // Backfill the snapshot from the seeded data first.
    await sdk.trigger("mem::graph-snapshot-rebuild", { force: true });

    const unbounded = (await sdk.trigger(
      "mem::graph-query",
      {},
    )) as GraphQueryResult;

    expect(unbounded.totalNodes).toBe(NODE_COUNT);
    expect(unbounded.nodes.length).toBe(500);
    expect(unbounded.truncated).toBe(true);
    expect(unbounded.limit).toBe(500);
    expect(unbounded.offset).toBe(0);
    // The 50 connected nodes should be on the first page since the
    // default ranks by degree.
    const connectedOnPage = unbounded.nodes.filter((n) => /^n_00[0-4]\d$/.test(n.id));
    expect(connectedOnPage.length).toBe(50);
  });

  it("honors limit and offset for paged graph-query traversal", async () => {
    for (let i = 0; i < 50; i++) {
      const node: GraphNode = {
        id: `p_${i.toString().padStart(3, "0")}`,
        type: "concept",
        name: `node-${i}`,
        properties: {},
        firstSeen: "2026-01-01T00:00:00Z",
        lastSeen: "2026-01-01T00:00:00Z",
        observationCount: 1,
      } as GraphNode;
      await kv.set("mem:graph:nodes", node.id, node);
    }

    await sdk.trigger("mem::graph-snapshot-rebuild", { force: true });

    const page1 = (await sdk.trigger("mem::graph-query", {
      limit: 10,
      offset: 0,
    })) as GraphQueryResult;
    const page2 = (await sdk.trigger("mem::graph-query", {
      limit: 10,
      offset: 10,
    })) as GraphQueryResult;

    expect(page1.nodes.length).toBe(10);
    expect(page2.nodes.length).toBe(10);
    expect(page1.totalNodes).toBe(50);
    expect(page2.totalNodes).toBe(50);
    expect(page1.truncated).toBe(true);
    // The two pages must not overlap.
    const overlap = page1.nodes.filter((n) =>
      page2.nodes.some((p) => p.id === n.id),
    );
    expect(overlap.length).toBe(0);
  });

  it("clamps an explicit limit above the cap to the cap value", async () => {
    for (let i = 0; i < 10; i++) {
      await kv.set("mem:graph:nodes", `c_${i}`, {
        id: `c_${i}`,
        type: "concept",
        name: `n-${i}`,
        properties: {},
        firstSeen: "2026-01-01T00:00:00Z",
        lastSeen: "2026-01-01T00:00:00Z",
        observationCount: 1,
      });
    }

    await sdk.trigger("mem::graph-snapshot-rebuild", { force: true });

    const huge = (await sdk.trigger("mem::graph-query", {
      limit: 999999,
    })) as GraphQueryResult;
    expect(huge.limit).toBeLessThanOrEqual(5000);
    expect(huge.nodes.length).toBe(10);
    expect(huge.truncated).toBe(false);
  });

  it("paginate excludes edges whose endpoints fall outside the page", async () => {
    for (let i = 0; i < 60; i++) {
      await kv.set("mem:graph:nodes", `x_${i.toString().padStart(3, "0")}`, {
        id: `x_${i.toString().padStart(3, "0")}`,
        type: "concept",
        name: `n-${i}`,
        properties: {},
        firstSeen: "2026-01-01T00:00:00Z",
        lastSeen: "2026-01-01T00:00:00Z",
        observationCount: 1,
      });
    }
    // Make the first 10 nodes a tightly connected cluster so they
    // rank highest by degree and land on the page deterministically.
    for (let i = 0; i < 10; i++) {
      const next = (i + 1) % 10;
      await kv.set("mem:graph:edges", `cluster_${i}`, {
        id: `cluster_${i}`,
        type: "related_to",
        sourceNodeId: `x_${i.toString().padStart(3, "0")}`,
        targetNodeId: `x_${next.toString().padStart(3, "0")}`,
        weight: 1,
        evidence: [],
        firstSeen: "2026-01-01T00:00:00Z",
        lastSeen: "2026-01-01T00:00:00Z",
      });
    }
    // Cross-page edge: source in the high-degree cluster (on page),
    // target is an isolated node (degree 1; cluster nodes have
    // degree 2 so the target ranks below the cap).
    await kv.set("mem:graph:edges", "cross", {
      id: "cross",
      type: "related_to",
      sourceNodeId: "x_005",
      targetNodeId: "x_055",
      weight: 1,
      evidence: [],
      firstSeen: "2026-01-01T00:00:00Z",
      lastSeen: "2026-01-01T00:00:00Z",
    });

    await sdk.trigger("mem::graph-snapshot-rebuild", { force: true });

    const page = (await sdk.trigger("mem::graph-query", {
      limit: 10,
      offset: 0,
    })) as GraphQueryResult;
    // The cross-page edge should not appear in the page response —
    // otherwise the viewer renders a dangling line to a node it
    // doesn't have.
    expect(page.edges.find((e) => e.id === "cross")).toBeUndefined();
    // Cluster edges among page nodes ARE present.
    expect(page.edges.filter((e) => e.id.startsWith("cluster_")).length).toBe(10);
    // totalEdges counts every edge in the full result universe.
    expect(page.totalEdges).toBe(11);

    const inventoryIds: string[] = [];
    const inventoryRevisions = new Set<string>();
    for (let edgeOffset = 0; edgeOffset < 11; edgeOffset += 4) {
      const inventoryPage = (await sdk.trigger("mem::graph-query", {
        project: "*",
        limit: 1,
        offset: 0,
        edgeLimit: 4,
        edgeOffset,
      })) as GraphQueryResult & { edgeInventory?: GraphEdge[] };
      expect(inventoryPage.edgeInventoryExact).toBe(true);
      expect(inventoryPage.edgeLimit).toBe(4);
      expect(inventoryPage.edgeOffset).toBe(edgeOffset);
      expect(inventoryPage.edgeInventoryRevision).toBeTruthy();
      inventoryRevisions.add(inventoryPage.edgeInventoryRevision!);
      inventoryIds.push(...(inventoryPage.edgeInventory ?? []).map((edge) => edge.id));
    }
    expect(new Set(inventoryIds).size).toBe(11);
    expect(inventoryIds).toHaveLength(11);
    expect(inventoryIds).toContain("cross");
    expect(inventoryRevisions.size).toBe(1);
  });

  it("marks an opted-in edge inventory inexact when the query index is dirty", async () => {
    await kv.set("mem:graph:nodes", "gn_a", {
      id: "gn_a",
      type: "concept",
      name: "A",
      project: "/project-a",
      properties: {},
      sourceObservationIds: ["obs_a"],
      sourceSessionIds: ["ses_a"],
      createdAt: "2026-02-01T10:00:00Z",
    } satisfies GraphNode);
    await sdk.trigger("mem::graph-snapshot-rebuild", { force: true });
    const manifest = await kv.get<Record<string, unknown>>(
      "mem:graph:query-manifest",
      "current",
    );
    await kv.set("mem:graph:query-manifest", "current", {
      ...manifest,
      dirty: true,
    });

    const result = await sdk.trigger("mem::graph-query", {
      project: "*",
      edgeLimit: 10,
      edgeOffset: 0,
    }) as GraphQueryResult;
    expect(result).toMatchObject({
      fromSnapshot: true,
      edgeInventory: [],
      edgeInventoryExact: false,
      edgeLimit: 10,
      edgeOffset: 0,
    });
    expect(result.warning).toContain("exact graph query index is temporarily unavailable");
  });

  // #814: precomputed snapshot path. The viewer-tab default-cap query
  // and graph-stats both have to work at 75K-node scale where the
  // full kv.list enumeration exceeds the iii invocation budget.
  describe("snapshot cache (#814)", () => {
    async function seed(nodeCount: number, edgeCount: number) {
      for (let i = 0; i < nodeCount; i++) {
        await kv.set("mem:graph:nodes", `n_${i}`, {
          id: `n_${i}`,
          type: i % 3 === 0 ? "file" : "function",
          name: `node-${i}`,
          properties: {},
          sourceObservationIds: [`obs_${i}`],
          firstSeen: "2026-01-01T00:00:00Z",
          lastSeen: "2026-01-01T00:00:00Z",
          observationCount: 1,
          stale: false,
        });
      }
      for (let i = 0; i < edgeCount; i++) {
        const src = `n_${i % nodeCount}`;
        const dst = `n_${(i + 1) % nodeCount}`;
        await kv.set("mem:graph:edges", `e_${i}`, {
          id: `e_${i}`,
          type: i % 2 === 0 ? "uses" : "imports",
          sourceNodeId: src,
          targetNodeId: dst,
          weight: 1,
          evidence: [],
          sourceObservationIds: [`obs_${i}`],
          firstSeen: "2026-01-01T00:00:00Z",
          lastSeen: "2026-01-01T00:00:00Z",
          stale: false,
        });
      }
    }

    async function seedProject(nodeCount: number, project = "/large") {
      for (let i = 0; i < nodeCount; i++) {
        await kv.set("mem:graph:nodes", `pn_${i}`, {
          id: `pn_${i}`,
          type: "concept",
          name: `project-node-${i}`,
          project,
          properties: { project, ordinal: String(i) },
          sourceObservationIds: [`obs_${i}`],
          sourceSessionIds: [`ses_${i}`],
          createdAt: `2026-01-01T00:${String(Math.floor(i / 60) % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`,
          stale: false,
        } satisfies GraphNode);
      }
    }

    it("snapshot-rebuild persists top-degree subgraph + aggregate stats", async () => {
      await seed(50, 100);
      const result = (await sdk.trigger("mem::graph-snapshot-rebuild", { force: true })) as {
        success: boolean;
        totalNodes: number;
        totalEdges: number;
        topNodes: number;
        topEdges: number;
      };
      expect(result.success).toBe(true);
      expect(result.totalNodes).toBe(50);
      expect(result.totalEdges).toBe(100);
      // 50 nodes is below the SNAPSHOT_TOP_NODES cap, so every node
      // lands in the snapshot.
      expect(result.topNodes).toBe(50);

      const snap = await kv.get<{
        version: number;
        topNodes: unknown[];
        stats: { totalNodes: number; nodesByType: Record<string, number> };
      }>("mem:graph:snapshot", "current");
      expect(snap).not.toBeNull();
      expect(snap!.version).toBe(1);
      expect(snap!.stats.totalNodes).toBe(50);
      // nodesByType reflects every type seen.
      expect(snap!.stats.nodesByType["file"]).toBeGreaterThan(0);
      expect(snap!.stats.nodesByType["function"]).toBeGreaterThan(0);
    });

    it("rebuild restores project-scoped canonical lookup for manual upsert", async () => {
      const createdAt = "2026-01-01T00:00:00Z";
      await kv.set("mem:graph:nodes", "gn_existing", {
        id: "gn_existing",
        type: "file",
        name: "src/canonical.ts",
        project: "/app",
        properties: { project: "/app" },
        sourceObservationIds: ["obs_old"],
        sourceSessionIds: ["ses_old"],
        createdAt,
        stale: false,
      } satisfies GraphNode);
      await sdk.trigger("mem::graph-snapshot-rebuild", { force: true });
      await kv.set("mem:sessions", "ses_new", {
        id: "ses_new",
        project: "/app",
        cwd: "/app",
        startedAt: createdAt,
        status: "completed",
        observationCount: 1,
      });
      await kv.set("mem:obs:ses_new", "obs_new", {
        ...testObs,
        id: "obs_new",
        sessionId: "ses_new",
      });

      const result = (await sdk.trigger("mem::graph-upsert", {
        project: "/app",
        sources: [{ sessionId: "ses_new", observationIds: ["obs_new"] }],
        nodes: [{ key: "canonical", type: "file", name: "src/canonical.ts" }],
      })) as { success: boolean; nodesCreated: number; nodesMerged: number };

      expect(result).toMatchObject({ success: true, nodesCreated: 0, nodesMerged: 1 });
      const nodes = await kv.list<GraphNode>("mem:graph:nodes");
      expect(nodes).toHaveLength(1);
      expect(nodes[0].sourceObservationIds).toEqual(["obs_old", "obs_new"]);
    });

    it("graph-query empty-body branch serves from snapshot once it exists", async () => {
      await seed(20, 30);
      await sdk.trigger("mem::graph-snapshot-rebuild", { force: true });

      const result = (await sdk.trigger("mem::graph-query", {})) as GraphQueryResult;
      expect(result.fromSnapshot).toBe(true);
      expect(result.totalNodes).toBe(20);
      expect(result.totalEdges).toBe(30);
    });

    it("graph-query nodeType filter respects snapshot type counts", async () => {
      await seed(30, 0);
      await sdk.trigger("mem::graph-snapshot-rebuild", { force: true });

      const fileQuery = (await sdk.trigger("mem::graph-query", {
        nodeType: "file",
      })) as GraphQueryResult;
      expect(fileQuery.fromSnapshot).toBe(true);
      // 30 nodes, every 3rd is "file" → 10 files.
      expect(fileQuery.totalNodes).toBe(10);
      for (const n of fileQuery.nodes) {
        expect(n.type).toBe("file");
      }
    });

    it("project query pages beyond 500 from shards without graph enumeration", async () => {
      await seedProject(1201);
      await sdk.trigger("mem::graph-snapshot-rebuild", { force: true });
      let listCalls = 0;
      const baseList = kv.list;
      kv.list = async <T,>(scope: string): Promise<T[]> => {
        listCalls += 1;
        return baseList.call(kv, scope) as Promise<T[]>;
      };

      const page = (await sdk.trigger("mem::graph-query", {
        project: "/large",
        limit: 500,
        offset: 1000,
      })) as GraphQueryResult;
      expect(page).toMatchObject({
        fromIndex: true,
        totalNodes: 1201,
        limit: 500,
        offset: 1000,
        truncated: false,
      });
      expect(page.nodes).toHaveLength(201);

      const searched = (await sdk.trigger("mem::graph-query", {
        project: "/large",
        query: "project-node-1199",
      })) as GraphQueryResult;
      expect(searched.fromIndex).toBe(true);
      expect(searched.nodes.map((node) => node.id)).toEqual(["pn_1199"]);
      expect(listCalls).toBe(0);
    });

    it("missing query index falls back without bootstrapping from canonical scopes", async () => {
      await seedProject(40, "/missing-index");
      await sdk.trigger("mem::graph-snapshot-rebuild", { force: true });
      await kv.delete("mem:graph:query-manifest", "current");
      let listCalls = 0;
      const baseList = kv.list;
      kv.list = async <T,>(scope: string): Promise<T[]> => {
        listCalls += 1;
        return baseList.call(kv, scope) as Promise<T[]>;
      };

      const result = (await sdk.trigger("mem::graph-query", {
        project: "/missing-index",
        query: "project-node-3",
      })) as GraphQueryResult;
      expect(result.fromSnapshot).toBe(true);
      expect(result.fromIndex).toBeUndefined();
      expect(result.queryIndexRebuilt).toBeUndefined();
      expect(result.nodes.map((node) => node.id)).toContain("pn_3");
      expect(result.warning).toMatch(/without enumerating canonical graph state/);
      expect(listCalls).toBe(0);
    });

    it("indexed BFS uses adjacency shards and preserves bounded traversal", async () => {
      await seed(12, 11);
      await sdk.trigger("mem::graph-snapshot-rebuild", { force: true });
      let listCalls = 0;
      const baseList = kv.list;
      kv.list = async <T,>(scope: string): Promise<T[]> => {
        listCalls += 1;
        return baseList.call(kv, scope) as Promise<T[]>;
      };
      const walked = (await sdk.trigger("mem::graph-query", {
        project: "*",
        startNodeId: "n_0",
        maxDepth: 2,
      })) as GraphQueryResult;
      expect(walked.fromIndex).toBe(true);
      expect(walked.nodes.map((node) => node.id)).toEqual(["n_0", "n_1", "n_2"]);
      expect(walked.edges).toHaveLength(2);
      expect(listCalls).toBe(0);
    });

    it("dirty query index falls back to the bounded snapshot without enumeration", async () => {
      await seedProject(40, "/dirty-index");
      await sdk.trigger("mem::graph-snapshot-rebuild", { force: true });
      const snapshot = await kv.get<GraphSnapshot>("mem:graph:snapshot", "current");
      expect(snapshot).not.toBeNull();
      await kv.set("mem:graph:snapshot", "current", {
        ...snapshot!,
        dirty: true,
      });
      const manifest = await kv.get<Record<string, unknown>>(
        "mem:graph:query-manifest",
        "current",
      );
      expect(manifest).not.toBeNull();
      await kv.set("mem:graph:query-manifest", "current", {
        ...manifest!,
        dirty: true,
      });
      let listCalls = 0;
      const baseList = kv.list;
      kv.list = async <T,>(scope: string): Promise<T[]> => {
        listCalls += 1;
        return baseList.call(kv, scope) as Promise<T[]>;
      };

      const result = (await sdk.trigger("mem::graph-query", {
        project: "/dirty-index",
        query: "project-node-3",
      })) as GraphQueryResult;

      expect(result.fromSnapshot).toBe(true);
      expect(result.nodes.map((node) => node.id)).toContain("pn_3");
      expect(result.warning).toMatch(/without enumerating canonical graph state/);
      expect(listCalls).toBe(0);
    });

    it("missing snapshot refuses canonical graph enumeration", async () => {
      await seedProject(5, "/legacy-query");
      let listCalls = 0;
      const baseList = kv.list;
      kv.list = async <T,>(scope: string): Promise<T[]> => {
        listCalls += 1;
        return baseList.call(kv, scope) as Promise<T[]>;
      };

      const result = (await sdk.trigger("mem::graph-query", {
        project: "/legacy-query",
        query: "project-node",
      })) as GraphQueryResult;

      expect(result).toMatchObject({
        nodes: [],
        edges: [],
        totalNodes: 0,
        totalEdges: 0,
      });
      expect(result.warning).toMatch(/canonical graph enumeration/);
      expect(listCalls).toBe(0);
    });

    it("graph-stats returns from snapshot when not dirty", async () => {
      await seed(15, 25);
      await sdk.trigger("mem::graph-snapshot-rebuild", { force: true });

      const stats = (await sdk.trigger("mem::graph-stats", {})) as {
        totalNodes: number;
        totalEdges: number;
        fromSnapshot: boolean;
      };
      expect(stats.fromSnapshot).toBe(true);
      expect(stats.totalNodes).toBe(15);
      expect(stats.totalEdges).toBe(25);
    });

    it("graph-extract updates snapshot inline (no kv.list, dirty stays false)", async () => {
      // Post-#814 v2 the snapshot is updated incrementally on every
      // extract — no dirty flag bounces. Test asserts that after an
      // extract the snapshot reflects the new nodes/edges.
      await sdk.trigger("mem::graph-extract", { observations: [testObs] });

      const snap = await kv.get<{
        dirty: boolean;
        stats: { totalNodes: number };
      }>("mem:graph:snapshot", "current");
      expect(snap?.dirty).toBe(false);
      // testObs produces 2 nodes (src/index.ts, main) + 1 edge.
      expect(snap?.stats.totalNodes).toBeGreaterThanOrEqual(1);
    });

    it("graph-extract maintains name-index for O(1) dedup on re-extract", async () => {
      // First extract creates nodes.
      await sdk.trigger("mem::graph-extract", { observations: [testObs] });
      const nameIndex = await kv.get<string>(
        "mem:graph:name-index",
        "file|src/index.ts",
      );
      expect(typeof nameIndex).toBe("string");

      // Re-extract the same observation. With name-index lookup the
      // existing node merges; no duplicates.
      await sdk.trigger("mem::graph-extract", { observations: [testObs] });
      const nodes = await kv.list<{ name: string; type: string }>(
        "mem:graph:nodes",
      );
      const fileNodes = nodes.filter(
        (n) => n.name === "src/index.ts" && n.type === "file",
      );
      expect(fileNodes.length).toBe(1);
    });

    it("graph-stats returns empty envelope + warning when no snapshot exists", async () => {
      // Seed nodes but never rebuild the snapshot — simulates a legacy
      // corpus on a post-#814 upgrade.
      await seed(5, 5);

      const stats = (await sdk.trigger("mem::graph-stats", {})) as {
        totalNodes: number;
        totalEdges: number;
        fromSnapshot: boolean;
        warning?: string;
      };
      expect(stats.fromSnapshot).toBe(false);
      expect(stats.totalNodes).toBe(0);
      expect(stats.warning).toMatch(/snapshot-rebuild|graph\/reset/);
    });

    it("graph-reset clears state and writes empty snapshot", async () => {
      await sdk.trigger("mem::graph-extract", { observations: [testObs] });
      const result = (await sdk.trigger("mem::graph-reset", {})) as {
        success: boolean;
        cleared: Record<string, number>;
      };
      expect(result.success).toBe(true);

      const snap = await kv.get<{
        stats: { totalNodes: number };
      }>("mem:graph:snapshot", "current");
      expect(snap?.stats.totalNodes).toBe(0);
    });

    it("keeps routine session forget available after an empty graph reset", async () => {
      registerRememberFunction(sdk as never, kv as never);
      await kv.set("mem:sessions", "ses_after_reset", {
        id: "ses_after_reset",
        project: "/reset",
        cwd: "/reset",
        startedAt: "2026-02-01T00:00:00Z",
        status: "completed",
        observationCount: 1,
      });
      await kv.set("mem:obs:ses_after_reset", "obs_after_reset", {
        id: "obs_after_reset",
        sessionId: "ses_after_reset",
        timestamp: "2026-02-01T00:00:01Z",
        raw: {},
      });
      await sdk.trigger("mem::graph-reset", {});

      const forgotten = await sdk.trigger("mem::forget", {
        sessionId: "ses_after_reset",
      }) as Record<string, unknown>;
      expect(forgotten).toMatchObject({
        success: true,
        deleted: 2,
        graphNodesDeleted: 0,
        graphEdgesDeleted: 0,
      });
      expect(await kv.get("mem:sessions", "ses_after_reset")).toBeNull();
      expect(await kv.get("mem:obs:ses_after_reset", "obs_after_reset")).toBeNull();
    });

    it("graph-reset writes empty snapshot; legacy rows stay as orphans (#825)", async () => {
      await sdk.trigger("mem::graph-extract", { observations: [testObs] });
      // Index entries exist after the extract.
      const nameBefore = await kv.get(
        "mem:graph:name-index",
        "file|src/index.ts",
      );
      expect(nameBefore).not.toBeNull();

      await sdk.trigger("mem::graph-reset", {});

      // Post-#825: reset is enumeration-free. It writes an empty
      // snapshot; the legacy index rows remain on disk as orphans
      // but are never read by any post-#816 code path (hot path
      // reads only the snapshot, which is now empty). Asserting the
      // visible behavior: snapshot empty, hot path returns empty.
      const snap = await kv.get<{
        stats: { totalNodes: number; totalEdges: number };
      }>("mem:graph:snapshot", "current");
      expect(snap?.stats.totalNodes).toBe(0);
      expect(snap?.stats.totalEdges).toBe(0);
    });

    it("reset barrier hides pre-reset rows from project and cross-project queries and rebuild", async () => {
      await kv.set("mem:sessions", "ses_reset", {
        id: "ses_reset",
        project: "/reset",
        cwd: "/reset",
        startedAt: "2026-01-01T00:00:00Z",
        status: "completed",
        observationCount: 1,
      });
      await kv.set("mem:obs:ses_reset", "obs_reset", {
        ...testObs,
        id: "obs_reset",
        sessionId: "ses_reset",
      });
      const before = (await sdk.trigger("mem::graph-upsert", {
        project: "/reset",
        sources: [{ sessionId: "ses_reset", observationIds: ["obs_reset"] }],
        nodes: [{ key: "old", type: "decision", name: "Reset decision" }],
      })) as { success: boolean; nodeIds: Record<string, string> };
      expect(before.success).toBe(true);
      const oldNode = await kv.get<GraphNode>(
        "mem:graph:nodes",
        before.nodeIds.old,
      );
      expect(oldNode).not.toBeNull();
      await kv.set("mem:graph:nodes", before.nodeIds.old, {
        ...oldNode!,
        createdAt: "2026-01-01T00:00:00Z",
      });

      await sdk.trigger("mem::graph-reset", {});
      const projectQuery = (await sdk.trigger("mem::graph-query", {
        project: "/reset",
      })) as GraphQueryResult;
      const crossProjectQuery = (await sdk.trigger("mem::graph-query", {
        project: "*",
      })) as GraphQueryResult;
      expect(projectQuery).toMatchObject({ totalNodes: 0, totalEdges: 0 });
      expect(crossProjectQuery).toMatchObject({ totalNodes: 0, totalEdges: 0 });

      const rebuilt = (await sdk.trigger("mem::graph-snapshot-rebuild", {
        force: true,
      })) as { success: boolean; totalNodes: number; totalEdges: number };
      expect(rebuilt).toMatchObject({ success: true, totalNodes: 0, totalEdges: 0 });
      const rebuiltSnapshot = await kv.get<{ resetAt?: string }>(
        "mem:graph:snapshot",
        "current",
      );
      expect(rebuiltSnapshot?.resetAt).toBeTruthy();

      const purgeAfterReset = (await sdk.trigger("mem::graph-project-purge", {
        project: "/reset",
        nodeIds: [],
        edgeIds: [],
        reason: "must not enumerate hidden pre-reset rows",
      })) as { success: boolean; error: string };
      expect(purgeAfterReset.success).toBe(false);
      expect(purgeAfterReset.error).toMatch(/unavailable after a logical reset/);

      const after = (await sdk.trigger("mem::graph-upsert", {
        project: "/reset",
        sources: [{ sessionId: "ses_reset", observationIds: ["obs_reset"] }],
        nodes: [{ key: "new", type: "decision", name: "Reset decision" }],
      })) as { success: boolean; nodeIds: Record<string, string> };
      expect(after.success).toBe(true);
      expect(after.nodeIds.new).not.toBe(before.nodeIds.old);
      const visible = (await sdk.trigger("mem::graph-query", {
        project: "/reset",
      })) as GraphQueryResult;
      expect(visible.nodes.map((node) => node.id)).toEqual([after.nodeIds.new]);
      expect(await kv.list<GraphNode>("mem:graph:nodes")).toHaveLength(2);
    });
  });

  it("automatic scoped extraction merges case-only semantic node variants", async () => {
    const firstObs = {
      ...testObs,
      id: "obs_case_1",
      sessionId: "ses_case_1",
      narrative: "Qwen is the selected local model",
    };
    const secondObs = {
      ...testObs,
      id: "obs_case_2",
      sessionId: "ses_case_2",
      narrative: "QWEN completed the bounded task",
    };
    for (const [sessionId, observation] of [
      ["ses_case_1", firstObs],
      ["ses_case_2", secondObs],
    ] as const) {
      await kv.set("mem:sessions", sessionId, {
        id: sessionId,
        project: "/project-a",
        cwd: "/project-a",
        startedAt: "2026-02-01T10:00:00Z",
        status: "completed",
        observationCount: 1,
      });
      await kv.set(`mem:obs:${sessionId}`, observation.id, observation);
    }
    await kv.set("mem:graph:nodes", "gn_legacy_qwen", {
      id: "gn_legacy_qwen",
      type: "concept",
      name: "Qwen",
      project: "/project-a",
      properties: { project: "/project-a" },
      sourceObservationIds: [],
      sourceSessionIds: [],
      createdAt: "2026-01-01T00:00:00Z",
    } satisfies GraphNode);
    await kv.set(
      "mem:graph:name-index",
      `concept|${JSON.stringify(["/project-a", "Qwen"])}`,
      "gn_legacy_qwen",
    );
    mockProvider.compress
      .mockResolvedValueOnce(`<entities>
<entity key="qwen" type="concept" name="Qwen" source_observation_ids="obs_case_1"/>
</entities>
<relationships></relationships>`)
      .mockResolvedValueOnce(`<entities>
<entity key="qwen" type="concept" name="QWEN" source_observation_ids="obs_case_2"/>
</entities>
<relationships></relationships>`);

    await sdk.trigger("mem::graph-extract", {
      project: "/project-a",
      sessionId: "ses_case_1",
      observations: [firstObs],
    });
    await sdk.trigger("mem::graph-extract", {
      project: "/project-a",
      sessionId: "ses_case_2",
      observations: [secondObs],
    });

    const nodes = await kv.list<GraphNode>("mem:graph:nodes");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      id: "gn_legacy_qwen",
      name: "Qwen",
      project: "/project-a",
      sourceObservationIds: ["obs_case_1", "obs_case_2"],
      sourceSessionIds: ["ses_case_1", "ses_case_2"],
    });
  });

  // The hot query path must never enumerate canonical graph scopes. Only the
  // explicit snapshot rebuild endpoint may do so, behind its size guards.
  describe("budget + tooLarge guards (#814 v2)", () => {
    it("graph-query startNodeId refuses enumeration when no index exists", async () => {
      const base = mockKV();
      let listCalls = 0;
      const guarded = {
        ...base,
        list: async <T>(scope: string): Promise<T[]> => {
          listCalls += 1;
          return base.list<T>(scope);
        },
      };
      const localSdk = mockSdk();
      registerGraphFunction(
        localSdk as never,
        guarded as never,
        mockProvider as never,
      );

      const result = (await localSdk.trigger("mem::graph-query", {
        startNodeId: "n_missing",
      })) as GraphQueryResult;

      expect(result.warning).toBeTruthy();
      expect(result.warning).toMatch(/enumeration/i);
      expect(result.nodes).toEqual([]);
      expect(listCalls).toBe(0);
    });

    it("graph-snapshot-rebuild refuses corpora past REBUILD_SAFE_NODE_CEILING", async () => {
      // Direct-poke the mock store with > 25K node values so kv.list
      // returns them without paying the per-set cost. Each node only
      // needs id/type/name/stale=false for the rebuild path.
      const localKv = mockKV();
      // Walk the implementation detail: mockKV stores entries in a
      // Map under the scope key. Push directly to that map via the
      // public `set` API in a tight loop.
      const COUNT = 25001;
      const sets: Array<Promise<unknown>> = [];
      for (let i = 0; i < COUNT; i++) {
        sets.push(
          localKv.set("mem:graph:nodes", `bn_${i}`, {
            id: `bn_${i}`,
            type: "concept",
            name: `bulk-${i}`,
            properties: {},
            sourceObservationIds: [],
            createdAt: "2026-01-01T00:00:00Z",
            stale: false,
          }),
        );
      }
      await Promise.all(sets);

      const localSdk = mockSdk();
      registerGraphFunction(localSdk as never, localKv as never, mockProvider as never);

      const result = (await localSdk.trigger(
        "mem::graph-snapshot-rebuild",
        { force: true },
      )) as { success: boolean; tooLarge?: boolean; totalNodes?: number };
      expect(result.success).toBe(false);
      expect(result.tooLarge).toBe(true);
      expect(result.totalNodes).toBeGreaterThanOrEqual(25001);
    });

    // #825: new pre-flight refusal when no snapshot exists (signals
    // legacy corpus that would crash on kv.list). force=true bypasses.
    it("graph-snapshot-rebuild refuses on legacy corpus (no snapshot) without force", async () => {
      const localKv = mockKV();
      // Seed nodes but never persist a snapshot → simulates a corpus
      // built on a pre-#814 agentmemory.
      await localKv.set("mem:graph:nodes", "legacy_n", {
        id: "legacy_n",
        type: "concept",
        name: "legacy",
        properties: {},
        sourceObservationIds: [],
        createdAt: "2026-01-01T00:00:00Z",
        stale: false,
      });
      const localSdk = mockSdk();
      registerGraphFunction(localSdk as never, localKv as never, mockProvider as never);

      const result = (await localSdk.trigger(
        "mem::graph-snapshot-rebuild",
        {},
      )) as { success: boolean; legacyCorpus?: boolean; error?: string };
      expect(result.success).toBe(false);
      expect(result.legacyCorpus).toBe(true);
      expect(result.error).toMatch(/graph\/reset|force/);
    });

    it("graph-reset is enumeration-free (does not call kv.list)", async () => {
      // Wrap the mock kv.list with a counter; assert it stays at 0
      // across a full reset cycle.
      const localKv = mockKV();
      let listCalls = 0;
      const baseList = localKv.list;
      localKv.list = async <T,>(scope: string): Promise<T[]> => {
        listCalls += 1;
        return baseList.call(localKv, scope) as Promise<T[]>;
      };
      const localSdk = mockSdk();
      registerGraphFunction(localSdk as never, localKv as never, mockProvider as never);

      const result = (await localSdk.trigger("mem::graph-reset", {})) as {
        success: boolean;
      };
      expect(result.success).toBe(true);
      expect(listCalls).toBe(0);
    });
  });
});
