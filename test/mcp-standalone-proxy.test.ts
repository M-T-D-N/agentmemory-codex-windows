import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryKV } from "../src/mcp/in-memory-kv.js";
import { resetHandleForTests } from "../src/mcp/rest-proxy.js";
import { handleToolCall, handleToolsList } from "../src/mcp/standalone.js";

type FetchMock = ReturnType<typeof vi.fn>;

function installFetch(
  handler: (url: string, init?: RequestInit) => Response,
): FetchMock {
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) =>
    handler(url.toString(), init),
  );
  (globalThis as { fetch: typeof fetch }).fetch = fn as unknown as typeof fetch;
  return fn;
}

function mcpResponse(payload: unknown, isError = false): Response {
  return new Response(
    JSON.stringify({
      content: [{ type: "text", text: JSON.stringify(payload) }],
      ...(isError ? { isError: true } : {}),
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const BASE = "http://localhost:3111";

describe("@agentmemory/mcp standalone official proxy", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetHandleForTests();
    process.env["AGENTMEMORY_URL"] = BASE;
    delete process.env["AGENTMEMORY_SECRET"];
    delete process.env["AGENTMEMORY_FORCE_PROXY"];
    delete process.env["AGENTMEMORY_PROBE_TIMEOUT_MS"];
  });

  afterEach(() => {
    resetHandleForTests();
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
    delete process.env["AGENTMEMORY_URL"];
    delete process.env["AGENTMEMORY_SECRET"];
    delete process.env["AGENTMEMORY_FORCE_PROXY"];
    delete process.env["AGENTMEMORY_PROBE_TIMEOUT_MS"];
  });

  it.each([
    ["memory_sessions", { limit: 5 }, { sessions: [{ id: "sess-1" }] }],
    [
      "memory_smart_search",
      { query: "auth bug", project: "project-a", limit: 5 },
      { mode: "compact", results: [{ id: "m1" }] },
    ],
    [
      "memory_recall",
      {
        query: "auth bug",
        project: "project-a",
        limit: 5,
        format: "full",
        token_budget: 800,
      },
      { mode: "full", facts: [{ id: "m1" }] },
    ],
    [
      "memory_governance_delete",
      { memoryIds: "mem_1, mem_2", reason: "cleanup" },
      { success: true, deleted: 2 },
    ],
    [
      "memory_lesson_save",
      { title: "Pin lockfiles", content: "...", project: "project-a" },
      { saved: "lesson_xyz" },
    ],
  ])("forwards %s arguments unchanged through /mcp/call", async (name, args, payload) => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    installFetch((url, init) => {
      if (url.endsWith("/agentmemory/livez")) return new Response("ok");
      calls.push({
        url,
        method: init?.method || "GET",
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      if (url.endsWith("/agentmemory/mcp/call")) return mcpResponse(payload);
      return new Response("not found", { status: 404 });
    });

    const result = await handleToolCall(name, args);
    expect(JSON.parse(result.content[0].text)).toEqual(payload);
    expect(calls).toEqual([
      {
        url: `${BASE}/agentmemory/mcp/call`,
        method: "POST",
        body: { name, arguments: args },
      },
    ]);
  });

  it("preserves a structured MCP domain failure and never writes locally", async () => {
    installFetch((url) => {
      if (url.endsWith("/agentmemory/livez")) return new Response("ok");
      return mcpResponse({ success: false, error: "invalid provenance" }, true);
    });
    const localKv = new InMemoryKV(undefined);
    const result = await handleToolCall(
      "memory_save",
      { content: "do not store", project: "project-a" },
      localKv,
    );
    expect(result.isError).toBe(true);
    expect(await localKv.list("mem:memories")).toEqual([]);
  });

  it("does not fall back locally after a live server call fails", async () => {
    let probes = 0;
    installFetch((url) => {
      if (url.endsWith("/agentmemory/livez")) {
        probes++;
        return new Response("ok");
      }
      return new Response("boom", {
        status: 500,
        statusText: "Internal Server Error",
      });
    });
    const localKv = new InMemoryKV(undefined);
    await expect(
      handleToolCall(
        "memory_save",
        { content: "must not fall back", project: "project-a" },
        localKv,
      ),
    ).rejects.toThrow(/500/);
    expect(await localKv.list("mem:memories")).toEqual([]);

    await expect(handleToolCall("memory_sessions", {}, localKv)).rejects.toThrow(/500/);
    expect(probes).toBe(2);
  });

  it("attaches the bearer token to livez and /mcp/call", async () => {
    process.env["AGENTMEMORY_SECRET"] = "s3cret";
    const authByPath = new Map<string, string | undefined>();
    installFetch((url, init) => {
      const path = new URL(url).pathname;
      authByPath.set(
        path,
        (init?.headers as Record<string, string> | undefined)?.authorization,
      );
      if (url.endsWith("/agentmemory/livez")) return new Response("ok");
      return mcpResponse({ sessions: [] });
    });
    await handleToolCall("memory_sessions", {});
    expect(authByPath.get("/agentmemory/livez")).toBe("Bearer s3cret");
    expect(authByPath.get("/agentmemory/mcp/call")).toBe("Bearer s3cret");
  });

  it("uses local fallback only when no server was reachable", async () => {
    installFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const localKv = new InMemoryKV(undefined);
    await handleToolCall("memory_save", { content: "local only" }, localKv);
    const result = await handleToolCall("memory_recall", { query: "local" }, localKv);
    expect(JSON.parse(result.content[0].text).results[0].content).toBe("local only");
  });

  it("rejects unsupported local tools when no server was reachable", async () => {
    installFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    await expect(handleToolCall("memory_lesson_save", { title: "x" })).rejects.toThrow(
      /Unknown tool/,
    );
  });

  it("force-proxy skips livez and uses /mcp/call", async () => {
    process.env["AGENTMEMORY_FORCE_PROXY"] = "1";
    const calls: string[] = [];
    installFetch((url) => {
      calls.push(url);
      if (url.endsWith("/agentmemory/livez")) throw new Error("probe should be skipped");
      if (url.endsWith("/agentmemory/mcp/call")) return mcpResponse({ id: "m-1" });
      return new Response("not found", { status: 404 });
    });
    await handleToolCall("memory_save", {
      content: "force-proxy",
      project: "project-a",
    });
    expect(calls.some((url) => url.endsWith("/agentmemory/livez"))).toBe(false);
    expect(calls.some((url) => url.endsWith("/agentmemory/mcp/call"))).toBe(true);
  });

  it("allows proxy calls to use the engine's 180 second invocation window", async () => {
    process.env["AGENTMEMORY_FORCE_PROXY"] = "1";
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    installFetch((url) => {
      if (url.endsWith("/agentmemory/mcp/call")) {
        return mcpResponse({ sessions: [] });
      }
      return new Response("not found", { status: 404 });
    });

    await handleToolCall("memory_sessions", {});

    expect(timeoutSpy).toHaveBeenCalledWith(180_000);
  });

  it("force-proxy refuses a local store when the server is unavailable", async () => {
    process.env["AGENTMEMORY_FORCE_PROXY"] = "1";
    installFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const localKv = new InMemoryKV(undefined);
    await expect(
      handleToolCall("memory_save", { content: "no local copy" }, localKv),
    ).rejects.toThrow(/ECONNREFUSED/);
    expect(await localKv.list("mem:memories")).toEqual([]);
  });

  it("local tools/list remains the seven explicitly supported fallback tools", async () => {
    installFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const result = await handleToolsList();
    expect((result.tools as Array<{ name: string }>).map((tool) => tool.name).sort()).toEqual([
      "memory_audit",
      "memory_export",
      "memory_governance_delete",
      "memory_recall",
      "memory_save",
      "memory_sessions",
      "memory_smart_search",
    ]);
  });

  it("honors the probe timeout knob before the generic call", async () => {
    process.env["AGENTMEMORY_PROBE_TIMEOUT_MS"] = "50";
    let probes = 0;
    installFetch((url) => {
      if (url.endsWith("/agentmemory/livez")) {
        probes++;
        return new Response("ok");
      }
      return mcpResponse({ sessions: [] });
    });
    await handleToolCall("memory_sessions", {});
    expect(probes).toBe(1);
  });
});
