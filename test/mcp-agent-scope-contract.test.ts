import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerMcpEndpoints } from "../src/mcp/server.js";
import { getAllTools } from "../src/mcp/tools-registry.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

describe("MCP recall agent scope contract", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let search: ReturnType<typeof vi.fn>;
  let smartSearch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    sdk = mockSdk();
    search = vi.fn(async () => ({ results: [] }));
    smartSearch = vi.fn(async () => ({ results: [] }));
    sdk.registerFunction("mem::search", search);
    sdk.registerFunction("mem::smart-search", smartSearch);
    registerMcpEndpoints(sdk as never, mockKV() as never);
  });

  const tools = ["memory_recall", "memory_smart_search"] as const;

  it("offers original-user recall with a validated speaker filter", async () => {
    const schema = getAllTools().find(tool => tool.name === "memory_recall")!.inputSchema;
    expect(schema.properties.sourceKind).toMatchObject({ enum: ["user", "assistant"] });
    expect((await call("memory_recall", { sourceKind: "user" })).status_code).toBe(200);
    expect(search.mock.calls[0][0]).toMatchObject({ sourceKind: "user" });
    search.mockClear();
    expect((await call("memory_recall", { sourceKind: "unknown" })).status_code).toBe(400);
    expect(search).not.toHaveBeenCalled();
  });
  function call(name: string, args: Record<string, unknown>) {
    return sdk.trigger("mcp::tools::call", {
      headers: {}, body: { name, arguments: { query: "decision", project: "project-a", ...args } },
    }) as Promise<{ status_code: number; body: unknown }>;
  }

  it.each(tools)("%s advertises optional bounded agent selection", name => {
    const tool = getAllTools().find(tool => tool.name === name)!;
    expect(tool.inputSchema.properties.agentId).toMatchObject({ type: "string", minLength: 1, maxLength: 512 });
    expect(tool.inputSchema.required).not.toContain("agentId");
  });

  it.each(tools)("%s preserves the implicit scope and explicit agent/wildcard", async name => {
    const handler = name === "memory_recall" ? search : smartSearch;
    for (const agentId of [undefined, " agent-a ", "*"]) {
      handler.mockClear();
      const result = await call(name, agentId === undefined ? {} : { agentId });
      expect(result.status_code).toBe(200);
      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][0]).toMatchObject({ project: "project-a", query: "decision" });
      expect((handler.mock.calls[0][0] as Record<string, unknown>).agentId).toBe(agentId?.trim());
    }
  });

  it("forwards agent selection during smart-search expansion too", async () => {
    expect((await call("memory_smart_search", { agentId: "agent-a", expandIds: "obs-a,obs-b" })).status_code).toBe(200);
    expect(smartSearch).toHaveBeenCalledWith(expect.objectContaining({ agentId: "agent-a", expandIds: ["obs-a", "obs-b"] }));
  });

  it.each(tools)("%s rejects malformed explicit scope before querying", async name => {
    for (const agentId of [null, 4, {}, [], "", "  ", "a".repeat(513)]) {
      expect((await call(name, { agentId })).status_code).toBe(400);
    }
    expect(search).not.toHaveBeenCalled();
    expect(smartSearch).not.toHaveBeenCalled();
  });
});
