import { beforeEach, describe, expect, it } from "vitest";
import { registerMcpEndpoints } from "../src/mcp/server.js";

function mockKV() {
  return {
    get: async () => null,
    set: async <T>(_scope: string, _key: string, data: T): Promise<T> => data,
    delete: async () => {},
    list: async () => [],
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  const triggerOverrides = new Map<string, Function>();
  return {
    registerFunction: (
      idOrOptions: string | { id: string },
      handler: Function,
    ) => {
      const id =
        typeof idOrOptions === "string" ? idOrOptions : idOrOptions.id;
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (
      input: string | { function_id: string; payload: unknown },
      data?: unknown,
    ) => {
      const id = typeof input === "string" ? input : input.function_id;
      const payload = typeof input === "string" ? data : input.payload;
      const override = triggerOverrides.get(id);
      if (override) return override(payload);
      const handler = functions.get(id);
      if (!handler) throw new Error(`No function: ${id}`);
      return handler(payload);
    },
    overrideTrigger: (id: string, handler: Function) => {
      triggerOverrides.set(id, handler);
    },
    getFunction: (id: string) => functions.get(id),
  };
}

function request(name: string, args: Record<string, unknown> = {}) {
  return { body: { name, arguments: args }, headers: {}, query_params: {} };
}

describe("MCP error propagation", () => {
  let sdk: ReturnType<typeof mockSdk>;

  beforeEach(() => {
    sdk = mockSdk();
    registerMcpEndpoints(sdk as never, mockKV() as never);
  });

  it("returns non-2xx when graph query throws", async () => {
    sdk.overrideTrigger("mem::graph-query", async () => {
      throw new Error("graph unavailable");
    });

    const result = await sdk.getFunction("mcp::tools::call")!(
      request("memory_graph_query", { project: "project-a" }),
    );

    expect(result.status_code).toBe(503);
    expect(result.body).toEqual({ error: "graph unavailable" });
  });

  it("passes bounded independent edge pagination through memory_graph_query", async () => {
    let seen: unknown;
    sdk.overrideTrigger("mem::graph-query", async (payload: unknown) => {
      seen = payload;
      return { nodes: [], edges: [], edgeInventory: [], edgeInventoryExact: true };
    });

    const result = await sdk.getFunction("mcp::tools::call")!(
      request("memory_graph_query", {
        project: "project-a",
        limit: 1,
        edgeLimit: 5000,
        edgeOffset: 12,
      }),
    );

    expect(result.status_code).toBe(200);
    expect(seen).toMatchObject({
      project: "project-a",
      limit: 1,
      edgeLimit: 1000,
      edgeOffset: 12,
    });
  });

  it("returns non-2xx for disabled consolidation results", async () => {
    sdk.overrideTrigger("mem::consolidate-pipeline", async () => ({
      success: false,
      skipped: true,
      reason: "Consolidation disabled",
    }));

    const result = await sdk.getFunction("mcp::tools::call")!(
      request("memory_consolidate"),
    );

    expect(result.status_code).toBe(503);
    expect(result.body).toMatchObject({ success: false, skipped: true });
  });

  it("returns structured MCP isError for rejected graph provenance", async () => {
    sdk.overrideTrigger("mem::graph-upsert", async () => ({
      success: false,
      error: "unknown or cross-project source observation",
    }));

    const result = await sdk.getFunction("mcp::tools::call")!(
      request("memory_graph_upsert", {
        project: "project-a",
        sources: [{ sessionId: "session-a", observationIds: ["obs-foreign"] }],
        nodes: [{ key: "policy", type: "decision", name: "Policy" }],
      }),
    );

    expect(result.status_code).toBe(200);
    expect(result.body).toMatchObject({ isError: true });
    expect(result.body.content[0].text).toContain("cross-project");
  });

  it("returns structured MCP isError when physical graph purge is refused", async () => {
    sdk.overrideTrigger("mem::graph-project-purge", async () => ({
      success: false,
      error: "nodeIds must exactly match the project's live graph nodes",
    }));

    const result = await sdk.getFunction("mcp::tools::call")!(
      request("memory_graph_purge", {
        project: "project-a",
        nodeIds: ["gn_wrong"],
        edgeIds: [],
        reason: "replace stale graph",
      }),
    );

    expect(result.status_code).toBe(200);
    expect(result.body).toMatchObject({ isError: true });
    expect(result.body.content[0].text).toContain("exactly match");
  });

  it("forwards trackAccess=false for all reinforcing retrieval tools", async () => {
    const payloads = new Map<string, Record<string, unknown>>();
    for (const functionId of [
      "mem::search",
      "mem::smart-search",
      "mem::timeline",
    ]) {
      sdk.overrideTrigger(functionId, async (payload: Record<string, unknown>) => {
        payloads.set(functionId, payload);
        return { results: [], entries: [] };
      });
    }

    const calls = [
      ["memory_recall", { query: "needle", project: "project-a", trackAccess: false }],
      ["memory_smart_search", { query: "needle", project: "project-a", trackAccess: false }],
      ["memory_timeline", { anchor: "needle", project: "project-a", trackAccess: false }],
    ] as const;
    for (const [name, args] of calls) {
      const response = await sdk.getFunction("mcp::tools::call")!(request(name, args));
      expect(response.status_code).toBe(200);
    }

    expect(payloads.get("mem::search")?.trackAccess).toBe(false);
    expect(payloads.get("mem::smart-search")?.trackAccess).toBe(false);
    expect(payloads.get("mem::timeline")?.trackAccess).toBe(false);
  });

  it("rejects non-boolean trackAccess values", async () => {
    const calls = [
      ["memory_recall", { query: "needle", project: "project-a", trackAccess: "false" }],
      ["memory_smart_search", { query: "needle", project: "project-a", trackAccess: 0 }],
      ["memory_timeline", { anchor: "needle", project: "project-a", trackAccess: null }],
    ] as const;

    for (const [name, args] of calls) {
      const response = await sdk.getFunction("mcp::tools::call")!(request(name, args));
      expect(response).toEqual({
        status_code: 400,
        body: { error: "trackAccess must be a boolean" },
      });
    }
  });
});
