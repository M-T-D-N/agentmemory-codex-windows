import { afterEach, describe, expect, it, vi } from "vitest";
import { mockKV, mockSdk } from "./helpers/mocks.js";
import type { ArchiveTarget } from "../src/types.js";
import { KV } from "../src/state/schema.js";
import { changeArchiveState } from "../src/functions/archive.js";
import { registerContextFunction } from "../src/functions/context.js";
import { registerLessonsFunctions, resetLessonIndex } from "../src/functions/lessons.js";
import { registerMcpEndpoints } from "../src/mcp/server.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { registerRelationsFunction } from "../src/functions/relations.js";
import { registerWorkingMemoryFunctions } from "../src/functions/working-memory.js";
import { registerSkillExtractFunctions } from "../src/functions/skill-extract.js";

vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
afterEach(() => { resetLessonIndex(); vi.unstubAllEnvs(); });
const timestamp = "2026-09-13T00:00:00Z";
async function fixture() {
  const kv = mockKV(), sdk = mockSdk({ looseTrigger: true });
  const context = registerContextFunction(sdk as never, kv as never, 20_000);
  registerLessonsFunctions(sdk as never, kv as never);
  registerMcpEndpoints(sdk as never, kv as never);
  registerApiTriggers(sdk as never, kv as never, context);
  registerRelationsFunction(sdk as never, kv as never);
  registerWorkingMemoryFunctions(sdk as never, kv as never, 20_000);
  registerSkillExtractFunctions(sdk as never, kv as never, { name: "noop" } as never);
  const session = { id: "s", project: "p", cwd: "/p", agentId: "a", startedAt: timestamp, status: "completed", observationCount: 2,
    summary: "hidden cached summary", firstPrompt: "hidden cached prompt" };
  await kv.set(KV.sessions, session.id, session);
  for (const [id, content] of [["o", "hidden original"], ["visible", "remaining original"]]) {
    await kv.set(KV.observations("s"), id, { id, sessionId: "s", agentId: "a", title: content, narrative: content,
      type: "decision", importance: 9, timestamp, facts: [], concepts: [], files: [] });
  }
  await kv.set(KV.summaries, "s", { sessionId: "s", title: "hidden aggregate", narrative: "hidden summarized content", keyDecisions: [], filesModified: [], createdAt: timestamp });
  const change = async (target: ArchiveTarget, action: "archive" | "restore" = "archive") => {
    const preview = await changeArchiveState(kv as never, { project: "p", target, action });
    return changeArchiveState(kv as never, { project: "p", target, action, dryRun: false,
      expectedDigest: preview.expectedDigest, expectedRevision: preview.expectedRevision, reason: "Reviewed reader fixture" });
  };
  const sessions = async () => {
    const result = await sdk.trigger("mcp::tools::call", { headers: {}, body: { name: "memory_sessions", arguments: { project: "p" } } }) as any;
    return JSON.parse(result.body.content[0].text);
  };
  return { kv, sdk, context, session, change, sessions };
}

describe("archive visibility in ordinary context, lesson and session readers", () => {
  it("suppresses summaries containing archived observations while keeping remaining context and canonical data", async () => {
    const f = await fixture();
    expect((await f.context({ sessionId: "current", project: "p" })).context).toContain("hidden aggregate");
    await f.change({ kind: "observation", id: "o", sessionId: "s" });
    const result = await f.context({ sessionId: "current", project: "p" });
    expect(result.context).toContain("remaining original");
    expect(result.context).not.toContain("hidden");
    expect(await f.kv.get(KV.sessions, "s")).toEqual(f.session);
    expect(await f.kv.get(KV.summaries, "s")).not.toBeNull();
    await f.change({ kind: "observation", id: "o", sessionId: "s" }, "restore");
    expect((await f.context({ sessionId: "current", project: "p" })).context).toContain("hidden aggregate");
  });
  it("uses the same observation visibility and totals in REST and removes cached summary text from MCP sessions", async () => {
    const f = await fixture();
    await f.change({ kind: "observation", id: "o", sessionId: "s" });
    const observations = await f.sdk.trigger("api::observations", { query_params: { project: "p", sessionId: "s", limit: "1" } }) as any;
    expect(observations.body).toMatchObject({ total: 1, nextOffset: null, observations: [{ id: "visible" }] });
    const sessions = await f.sessions();
    expect(sessions).toMatchObject({ total: 1, sessions: [{ id: "s" }] });
    expect(sessions.sessions[0]).not.toHaveProperty("summary");
    expect(sessions.sessions[0]).not.toHaveProperty("firstPrompt");
    const rest = await f.sdk.trigger("api::sessions", { query_params: { project: "p" } }) as any;
    expect(rest.body.sessions[0]).not.toHaveProperty("summary");
    expect(JSON.stringify(rest.body)).not.toContain("hidden");
  });
  it("hides an archived session before page counts and restores the same session and source rows", async () => {
    const f = await fixture();
    await f.change({ kind: "session", id: "s" });
    expect(await f.sessions()).toMatchObject({ total: 0, sessions: [], nextOffset: null });
    expect((await f.context({ sessionId: "current", project: "p" })).context).toBe("");
    expect(await f.sdk.trigger("api::observations", { query_params: { project: "p", sessionId: "s" } })).toMatchObject({ status_code: 404 });
    await f.change({ kind: "session", id: "s" }, "restore");
    expect(await f.sessions()).toMatchObject({ total: 1, sessions: [{ id: "s" }] });
    expect(await f.kv.list(KV.observations("s"))).toHaveLength(2);
  });
  it("finds a visible lesson behind over 100 archived hits and observes restore without rebuilding its index", async () => {
    const f = await fixture();
    for (let i = 0; i <= 110; i++) {
      const id = "lesson-" + i.toString().padStart(3, "0");
      await f.kv.set(KV.lessons, id, { id, project: "p", content: "canonical archive decision", context: "", confidence: 0.9,
        source: "manual", sourceIds: [], tags: [], reinforcements: 1, createdAt: timestamp, updatedAt: timestamp });
      if (i < 110) await f.change({ kind: "lesson", id });
    }
    const query = { query: "canonical archive decision", project: "p", limit: 1 };
    expect(await f.sdk.trigger("mem::lesson-recall", query)).toMatchObject({ lessons: [{ id: "lesson-110" }] });
    expect(await f.sdk.trigger("mem::lesson-list", { project: "p", limit: 1 })).toMatchObject({ lessons: [{ id: "lesson-110" }] });
    await f.change({ kind: "lesson", id: "lesson-000" }, "restore");
    expect(await f.sdk.trigger("mem::lesson-recall", query)).toMatchObject({ lessons: [{ id: "lesson-000" }] });
    await f.change({ kind: "lesson", id: "lesson-110" });
    await f.change({ kind: "lesson", id: "lesson-000" });
    expect((await f.context({ sessionId: "current", project: "p" })).context).not.toContain("canonical archive decision");
  });
  it("fails closed on unreadable archive state instead of silently injecting or recalling hidden content", async () => {
    const f = await fixture(), list = f.kv.list;
    f.kv.list = async scope => { if (scope === KV.archiveStates) throw Error("archive state unavailable"); return list(scope); };
    await expect(f.context({ sessionId: "current", project: "p" })).rejects.toThrow("archive state unavailable");
    await expect(f.sdk.trigger("mem::lesson-list", {})).rejects.toThrow("archive state unavailable");
    for (const [id, args] of [
      ["mem::get-related", { memoryId: "m" }], ["mem::working-context", {}],
      ["mem::skill-list", {}], ["mem::skill-match", { query: "archive" }],
      ["api::memories", { query_params: { project: "p" } }],
      ["api::memory-by-id", { path_params: { id: "m" }, query_params: { project: "p" } }],
      ["api::semantic-list", {}], ["api::procedural-list", {}],
    ] as const) await expect(f.sdk.trigger(id, args)).rejects.toThrow("archive state unavailable");
  });
  it("excludes archived memory from list counts, detail and working context without changing the canonical row", async () => {
    const f = await fixture();
    const row = { id: "m", project: "p", agentId: "a", type: "pattern", title: "hidden memory", content: "hidden memory body",
      strength: 1, isLatest: true, sessionIds: ["s"], createdAt: timestamp, updatedAt: timestamp };
    await f.kv.set(KV.memories, "m", row);
    await f.kv.set(KV.memories, "v", { ...row, id: "v", title: "visible memory", content: "visible memory body" });
    await f.change({ kind: "memory", id: "m" });
    const list = await f.sdk.trigger("api::memories", { query_params: { project: "p", agentId: "*", limit: "1" } }) as any;
    expect(list.body).toMatchObject({ total: 1, memories: [{ id: "v" }] });
    expect(await f.sdk.trigger("api::memories", { query_params: { project: "p", agentId: "*", count: "true" } }))
      .toMatchObject({ body: { total: 1, latestCount: 1 } });
    const detail = { path_params: { id: "m" }, query_params: { project: "p" } };
    expect(await f.sdk.trigger("api::memory-by-id", detail)).toMatchObject({ status_code: 404 });
    const working = await f.sdk.trigger("mem::working-context", {}) as any;
    expect(working.context).toContain("visible memory body");
    expect(working.context).not.toContain("hidden memory");
    expect(await f.kv.get(KV.memories, "m")).toEqual(row);
    await f.change({ kind: "memory", id: "m" }, "restore");
    expect(await f.sdk.trigger("api::memory-by-id", detail)).toMatchObject({ body: { memory: row } });
    expect((await f.sdk.trigger("mem::working-context", {}) as any).context).toContain("hidden memory body");
  });
  it("does not traverse an archived related-memory bridge and restores the same relationships", async () => {
    const f = await fixture();
    for (const [id, relatedIds] of [["start", ["bridge"]], ["bridge", ["far"]], ["far", []]] as const) {
      await f.kv.set(KV.memories, id, { id, project: "p", sessionIds: ["s"], relatedIds, updatedAt: timestamp });
    }
    const request = { memoryId: "start", maxHops: 3 };
    expect((await f.sdk.trigger("mem::get-related", request) as any).results).toHaveLength(2);
    await f.change({ kind: "memory", id: "bridge" });
    expect(await f.sdk.trigger("mem::get-related", request)).toEqual({ results: [] });
    expect(await f.sdk.trigger("mem::get-related", { memoryId: "bridge" })).toEqual({ results: [] });
    await f.change({ kind: "memory", id: "bridge" }, "restore");
    expect((await f.sdk.trigger("mem::get-related", request) as any).results).toHaveLength(2);
  });
  it("filters semantic and procedural lists and skill ranking before limits, including pending imports", async () => {
    const f = await fixture();
    for (const id of ["hidden", "visible"]) {
      await f.kv.set(KV.semantic, id, { id, project: "p", content: id, updatedAt: timestamp });
      await f.kv.set(KV.procedural, id, { id, project: "p", name: "archive procedure " + id,
        triggerCondition: "archive", steps: ["archive"], strength: id === "hidden" ? 1 : 0.5, updatedAt: timestamp });
    }
    await f.change({ kind: "semantic", id: "hidden" });
    await f.change({ kind: "procedural", id: "hidden" });
    const assertVisible = async () => {
      expect(await f.sdk.trigger("api::semantic-list", {})).toMatchObject({ body: { semantic: [{ id: "visible" }] } });
      expect(await f.sdk.trigger("api::procedural-list", {})).toMatchObject({ body: { procedural: [{ id: "visible" }] } });
      expect(await f.sdk.trigger("mem::skill-list", { limit: 1 })).toMatchObject({ total: 1, skills: [{ id: "visible" }] });
      expect(await f.sdk.trigger("mem::skill-match", { query: "archive", limit: 1 })).toMatchObject({ matches: [{ skill: { id: "visible" } }] });
    };
    await assertVisible();
    await f.change({ kind: "procedural", id: "hidden" }, "restore");
    expect(await f.sdk.trigger("mem::skill-list", { limit: 1 })).toMatchObject({ total: 2, skills: [{ id: "hidden" }] });
    const state = (await f.kv.list<any>(KV.archiveStates)).find(row => row.target.kind === "procedural")!;
    await f.kv.set(KV.archiveStates, state.id, { ...state, importPendingDigest: state.targetDigest });
    await assertVisible();
  });
});
