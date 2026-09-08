import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { mockKV, mockSdk } from "./helpers/mocks.js";
import { registerMcpEndpoints } from "../src/mcp/server.js";
import { registerApiTriggers } from "../src/triggers/api.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
describe("official memory_sessions scope and paging", () => {
  let kv: ReturnType<typeof mockKV>;
  let sdk: ReturnType<typeof mockSdk>;
  async function query(args: Record<string, unknown>) {
    const result = await sdk.trigger("mcp::tools::call", {
      headers: {}, body: { name: "memory_sessions", arguments: args },
    }) as any;
    return { ...JSON.parse(result.body.content[0].text), isError: result.body.isError };
  }
  beforeEach(async () => {
    kv = mockKV();
    sdk = mockSdk({ looseTrigger: true });
    registerMcpEndpoints(sdk as never, kv as never);
    registerApiTriggers(sdk as never, kv as never, async () => ({ context: "", blocks: 0, tokens: 0 }));
    for (let i = 0; i < 25; i++) {
      const id = "s" + String(i).padStart(2, "0");
      await kv.set("mem:sessions", id, { id, project: "a", cwd: "/a",
        startedAt: "2026-09-07T00:00:00Z", status: "active", observationCount: 1, agentId: "agent-a" });
    }
    await kv.set("mem:sessions", "other", { id: "other", project: "b", startedAt: "2026-09-08" });
    await kv.set("mem:sessions", "internal", { id: "internal", project: "a",
      startedAt: "2026-09-09", captureExcluded: true });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("requires explicit project and validates bounded numeric and exclusion arguments", async () => {
    for (const args of [{}, { project: "" }, { project: "a", limit: 0 },
      { project: "a", limit: 1.5 }, { project: "a", offset: -1 },
      { project: "a", limit: "5" }, { project: "a", includeExcluded: "false" },
      { project: "*", sessionId: "internal", includeExcluded: true },
      { project: "a", includeExcluded: true }]) {
      expect(await query(args)).toMatchObject({ isError: true });
    }
  });
  it("defaults to 20 scoped sessions and pages ties deterministically", async () => {
    const first = await query({ project: "a" });
    expect(first).toMatchObject({ total: 25, limit: 20, offset: 0, nextOffset: 20 });
    const second = await query({ project: "a", offset: first.nextOffset });
    expect(second).toMatchObject({ total: 25, nextOffset: null });
    const ids = [...first.sessions, ...second.sessions].map(s => s.id);
    expect(ids).toHaveLength(25);
    expect(new Set(ids).size).toBe(25);
    expect(first.sessions.map(s => s.id)).toEqual((await query({ project: "a" })).sessions.map(s => s.id));
  });
  it("honors exact session lookup, deliberate wildcard and exact excluded inspection", async () => {
    expect((await query({ project: "a", sessionId: "other" })).sessions).toEqual([]);
    expect((await query({ project: "*", limit: 1 })).sessions[0].id).toBe("other");
    expect((await query({ project: "a", sessionId: "internal" })).sessions).toEqual([]);
    expect((await query({ project: "a", sessionId: "internal", includeExcluded: true })).sessions[0].id).toBe("internal");
    expect((await query({ project: "a", limit: 9999 })).limit).toBe(500);
  });
  it("keeps REST backlog ordering ascending while MCP returns recent sessions", async () => {
    const rest = await sdk.trigger("api::sessions", { headers: {},
      query_params: { project: "*", limit: "1" } }) as any;
    expect(rest.body.sessions[0].id).not.toBe("other");
    expect((await query({ project: "*", limit: 1 })).sessions[0].id).toBe("other");
  });
  it("keeps legacy terminal-only records out of session pages without rewriting them", async () => {
    const terminal = { endedAt: "2026-09-07T00:00:00Z", status: "completed" };
    await kv.set("mem:sessions", "legacy-one", { ...terminal });
    await kv.set("mem:sessions", "legacy-two", { ...terminal });
    const page = await query({ project: "*", agentId: "*", limit: 500 });
    expect(page).toMatchObject({ total: 26, nextOffset: null });
    expect(page.sessions.every((s: any) => typeof s.id === "string" && typeof s.project === "string")).toBe(true);
    expect(await kv.get("mem:sessions", "legacy-one")).toEqual(terminal);
    const rest = await sdk.trigger("api::sessions", { headers: {}, query_params: { project: "*" } }) as any;
    expect(rest.status_code).toBe(200);
    expect(rest.body.total).toBe(26);
  });
  it("does not create partial metadata when SessionEnd arrives without a session", async () => {
    const result = await sdk.trigger("api::session::end", { headers: {}, body: { sessionId: "never-started" } }) as any;
    expect(result).toMatchObject({ status_code: 200, body: { success: true, skipped: true } });
    expect(await kv.get("mem:sessions", "never-started")).toBeNull();
    const terminal = { endedAt: "2026-09-07T00:00:00Z", status: "completed" };
    await kv.set("mem:sessions", "legacy", terminal);
    await sdk.trigger("api::session::end", { headers: {}, body: { sessionId: "legacy" } });
    expect(await kv.get("mem:sessions", "legacy")).toEqual(terminal);
    await sdk.trigger("api::session::end", { headers: {}, body: { sessionId: "s00" } });
    expect(await kv.get("mem:sessions", "s00")).toMatchObject({ id: "s00", project: "a", status: "completed" });
  });
  it("applies the configured isolated agent scope by default", async () => {
    vi.stubEnv("AGENT_ID", "agent-a");
    vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "isolated");
    expect((await query({ project: "*" })).total).toBe(25);
    expect((await query({ project: "*", agentId: "*" })).total).toBe(26);
  });
  it("preserves explicit agent filtering and agent wildcard", async () => {
    expect((await query({ project: "*", agentId: "missing" })).sessions).toEqual([]);
    expect((await query({ project: "a", agentId: "agent-a" })).total).toBe(25);
    expect((await query({ project: "*", agentId: "*" })).total).toBe(26);
  });
});
