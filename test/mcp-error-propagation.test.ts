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
});
