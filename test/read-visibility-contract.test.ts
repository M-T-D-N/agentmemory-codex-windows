import { memoryToObservation } from "../src/state/memory-utils.js";
import { registerRememberFunction } from "../src/functions/remember.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockKV, mockSdk } from "./helpers/mocks.js";
import { KV } from "../src/state/schema.js";
import type { CompressedObservation, Session } from "../src/types.js";
import { registerTimelineFunction } from "../src/functions/timeline.js";
import { registerFileIndexFunction } from "../src/functions/file-index.js";
import { registerPatternsFunction } from "../src/functions/patterns.js";
import { registerProfileFunction, profileCacheKey } from "../src/functions/profile.js";
import { registerContextFunction } from "../src/functions/context.js";
import { changeArchiveState } from "../src/functions/archive.js";
import { registerSearchFunction, rebuildIndex } from "../src/functions/search.js";
import { registerSmartSearchFunction } from "../src/functions/smart-search.js";
import { readVisibleObservation } from "../src/functions/observation-access.js";
import { summarySourceDigest, SUMMARY_VISIBILITY_REVISION } from "../src/functions/summary-visibility.js";
import { selectSessionPage, parseSessionQuery } from "../src/functions/session-query.js";
import { registerMcpEndpoints } from "../src/mcp/server.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { validateObservationProvenance } from "../src/functions/provenance.js";

vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const approval = "The following is the Codex agent history added since your last approval assessment. approval-secret";
const page = '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>';
const obs = (sessionId: string, agentId: string, suffix: string, narrative = agentId + " normal decision"): CompressedObservation => ({ id: sessionId + suffix, sessionId, agentId, timestamp: "2026-10-02T00:00:00Z", type: "error", title: agentId + " decision", narrative, concepts: [agentId + "-concept"], files: [agentId + ".ts", agentId + "-two.ts"], facts: [], importance: 8 });
let kv: ReturnType<typeof mockKV>, sdk: ReturnType<typeof mockSdk>;
beforeEach(async () => {
 vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "shared"); vi.stubEnv("AGENT_ID", "");
 kv = mockKV(); sdk = mockSdk({ looseTrigger: true });
 registerTimelineFunction(sdk as never, kv as never); registerFileIndexFunction(sdk as never, kv as never);
 registerPatternsFunction(sdk as never, kv as never); registerProfileFunction(sdk as never, kv as never);
 registerContextFunction(sdk as never, kv as never, 20000); registerSearchFunction(sdk as never, kv as never);
 registerSmartSearchFunction(sdk as never, kv as never, async () => []);
 for (const agentId of ["A", "B"]) for (let i=0;i<3;i++) {
  const id = agentId + i;
  await kv.set(KV.sessions, id, { id, project: "p", agentId, cwd: "/p", startedAt: "2026-10-02T00:00:00Z", status: "completed", observationCount: 1 } satisfies Session);
  const o = obs(id, agentId, "o"); await kv.set(KV.observations(id), o.id, o);
 }
});
afterEach(() => vi.unstubAllEnvs());
const call = (id: string, input: object = {}) => sdk.trigger(id, { project: "p", ...input }) as Promise<any>;
const reads = async (input: object = {}) => ({
 timeline: await call("mem::timeline", { anchor: "2026-10-02", before: 100, after: 100, trackAccess: false, ...input }),
 files: await call("mem::file-context", { files: ["A.ts", "B.ts"], ...input }),
 patterns: await call("mem::patterns", input), profile: await call("mem::profile", input),
 context: await call("mem::context", { sessionId: "current", ...input }),
});
async function lifecycle(action: "archive" | "restore", target: any) {
 const request = { project: "p", action, target }; const preview: any = await changeArchiveState(kv as never, request);
 return changeArchiveState(kv as never, { ...request, dryRun: false, expectedRevision: preview.expectedRevision, expectedDigest: preview.expectedDigest, reason: "Fixture reviewed" });
}
describe("consistent visibility across official reads and derived caches", () => {
 it("rejects mixed-owner compound forget before deleting any observation", async () => {
  registerRememberFunction(sdk as never, kv as never);
  vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "isolated"); vi.stubEnv("AGENT_ID", "A");
  await kv.set(KV.memories, "foreign-memory", { id: "foreign-memory", project: "p", agentId: "B", isLatest: true });
  const before = await kv.list(KV.observations("A0"));
  await expect(call("mem::forget", { sessionId: "A0", observationIds: ["A0o"], memoryId: "foreign-memory" })).rejects.toThrow(/ownership mismatch/);
  expect(await kv.list(KV.observations("A0"))).toEqual(before);
  await expect(call("mem::forget", { sessionId: "B0", observationIds: ["B0o"] })).rejects.toThrow(/ownership mismatch/);
  expect(await kv.list(KV.observations("B0"))).toHaveLength(1);
 });

 it("REST, recent and handoff summaries use current sources after partial forget", async () => {
  registerMcpEndpoints(sdk as never, kv as never);
  registerApiTriggers(sdk as never, kv as never, async () => ({ context: "", blocks: 0, tokens: 0 }));
  const observations = await kv.list<CompressedObservation>(KV.observations("A0"));
  await kv.set(KV.summaries, "A0", { sessionId: "A0", project: "p", createdAt: "2026-10-03T00:00:00Z", visibilityRevision: SUMMARY_VISIBILITY_REVISION, sourceDigest: summarySourceDigest(observations), title: "forgotten-summary-secret", narrative: "old aggregate", keyDecisions: [], filesModified: [], concepts: [], observationCount: 1 });
  const session = await kv.get<Session>(KV.sessions, "A0");
  await kv.set(KV.sessions, "A0", { ...session!, summary: "unproved-embedded-secret", firstPrompt: "forgotten-first-prompt-secret" });
  registerRememberFunction(sdk as never, kv as never);
  const entryPoints = async () => Promise.all([
   sdk.trigger("api::sessions", { query_params: { project: "p", sessionId: "A0" } }),
   sdk.trigger("mcp::resources::read", { body: { uri: "agentmemory://project/p/recent" } }),
   sdk.trigger("mcp::prompts::get", { body: { name: "session_handoff", arguments: { session_id: "A0" } } }),
  ]);
  const before = await entryPoints();
  for (const result of before) { expect(JSON.stringify(result)).toContain("forgotten-summary-secret"); expect(JSON.stringify(result)).not.toContain("unproved-embedded-secret"); }
  expect(await call("mem::forget", { sessionId: "A0", observationIds: ["A0o"] })).toMatchObject({ success: true, deleted: 1 });
  const after = await entryPoints();
  for (const result of after) { expect(JSON.stringify(result)).not.toContain("forgotten-summary-secret"); expect(JSON.stringify(result)).not.toContain("unproved-embedded-secret"); expect(JSON.stringify(result)).not.toContain("forgotten-first-prompt-secret"); }
  expect(await kv.get(KV.summaries, "A0")).not.toBeNull();
 });
 it("persisted supersession is consistent across latest, search expansion and cross-owner links", async () => {
  registerMcpEndpoints(sdk as never, kv as never);
  vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "isolated"); vi.stubEnv("AGENT_ID", "A");
  const old = { id: "mem_old", project: "p", agentId: "A", isLatest: true, version: 1, title: "old-head-secret", content: "old content", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", type: "fact" as const, concepts: [], files: [], sessionIds: [], strength: 7 };
  const current = { ...old, id: "mem_current", version: 2, title: "current-head-visible", content: "current content", parentId: old.id, supersedes: [old.id] };
  const foreign = { ...current, id: "mem_foreign", agentId: "B", version: 3, parentId: current.id, supersedes: [current.id] };
  for (const row of [old, current, foreign]) await kv.set(KV.memories, row.id, row);
  await rebuildIndex(kv as never);
  const latest = await sdk.trigger("mcp::resources::read", { body: { uri: "agentmemory://memories/latest" } });
  expect(JSON.stringify(latest)).toContain("current-head-visible"); expect(JSON.stringify(latest)).not.toContain("old-head-secret");
  const expanded = await call("mem::smart-search", { expandIds: [{obsId: old.id, sessionId: "memory"}, {obsId: current.id, sessionId: "memory"}], exactExpansion: true, trackAccess: false });
  expect(expanded.results.map((row: any) => row.obsId)).toEqual([current.id]);
  registerApiTriggers(sdk as never, kv as never, async () => ({ context: "", blocks: 0, tokens: 0 }));
  const counted: any = await sdk.trigger("api::memories", { query_params: { project: "p", count: "true" } });
  expect(counted.body).toMatchObject({ total: 2, latestCount: 1 });
  const listed: any = await sdk.trigger("api::memories", { query_params: { project: "p", latest: "true" } });
  expect(listed.body.memories.map((row: any) => row.id)).toEqual([current.id]);
  expect(memoryToObservation(current).agentId).toBe("A");
 });
 it("pending-import rows stay hidden and storage read errors are not empty successes", async () => {
  registerMcpEndpoints(sdk as never, kv as never);
  await kv.set(KV.memories, "pending", { id: "pending", project: "p", agentId: "A", title: "pending-memory-secret", isLatest: true });
  await lifecycle("archive", { kind: "memory", id: "pending" });
  await lifecycle("restore", { kind: "memory", id: "pending" });
  for (const state of await kv.list<any>(KV.archiveStates)) await kv.set(KV.archiveStates, state.id, { ...state, importPendingDigest: "a".repeat(64) });
  const latest: any = await sdk.trigger("mcp::resources::read", { body: { uri: "agentmemory://memories/latest" } });
  expect(JSON.stringify(latest)).not.toContain("pending-memory-secret");
  await lifecycle("archive", { kind: "session", id: "A0" });
  await lifecycle("restore", { kind: "session", id: "A0" });
  for (const state of await kv.list<any>(KV.archiveStates)) if (state.target.kind === "session") await kv.set(KV.archiveStates, state.id, { ...state, importPendingDigest: "a".repeat(64) });
  const handoff: any = await sdk.trigger("mcp::prompts::get", { body: { name: "session_handoff", arguments: { session_id: "A0" } } });
  expect(handoff.status_code).toBe(404);
  const list = kv.list;
  kv.list = async scope => { if (scope === KV.memories) throw Error("storage failed"); return list(scope); };
  const failed: any = await sdk.trigger("mcp::resources::read", { body: { uri: "agentmemory://memories/latest" } });
  expect(failed.status_code).toBe(500);
 });
 it("recent and latest filter hidden and foreign rows before their result limit", async () => {
  registerMcpEndpoints(sdk as never, kv as never);
  vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "isolated"); vi.stubEnv("AGENT_ID", "A");
  for (let i=0; i<12; i++) {
   const id = "foreign" + i;
   await kv.set(KV.sessions, id, { id, project: "p", agentId: "B", startedAt: "2026-10-10T00:00:00Z", cwd: "/p", status: "completed", observationCount: 0 });
   await kv.set(KV.summaries, id, { sessionId: id, project: "p", createdAt: "2026-10-10T00:00:00Z", visibilityRevision: SUMMARY_VISIBILITY_REVISION, sourceDigest: summarySourceDigest([]), title: "foreign-secret", narrative: "private", keyDecisions: [], filesModified: [], concepts: [], observationCount: 0 });
   await kv.set(KV.memories, id, { id, project: "p", agentId: "B", title: "foreign-secret", isLatest: true, updatedAt: "2026-10-10T00:00:00Z" });
  }
  const original = await kv.list<CompressedObservation>(KV.observations("A0"));
  await kv.set(KV.summaries, "A0", { sessionId: "A0", project: "p", createdAt: "2026-10-02T00:00:00Z", visibilityRevision: SUMMARY_VISIBILITY_REVISION, sourceDigest: summarySourceDigest(original), title: "own-visible", narrative: "normal", keyDecisions: [], filesModified: [], concepts: [], observationCount: 1 });
  await kv.set(KV.memories, "own", { id: "own", project: "p", agentId: "A", title: "own-visible", isLatest: true, updatedAt: "2026-10-02T00:00:00Z" });
  await kv.set(KV.memories, "hidden", { id: "hidden", project: "p", agentId: "A", title: "hidden-secret", isLatest: true, updatedAt: "2026-10-11T00:00:00Z" });
  await lifecycle("archive", { kind: "memory", id: "hidden" });
  for (const uri of ["agentmemory://project/p/recent", "agentmemory://memories/latest"]) {
   const response: any = await sdk.trigger("mcp::resources::read", { body: { uri } });
   expect(response.status_code).toBe(200);
   expect(JSON.stringify(response)).toContain("own-visible");
   expect(JSON.stringify(response)).not.toMatch(/foreign-secret|hidden-secret/);
  }
  const foreign: any = await sdk.trigger("mcp::prompts::get", { body: { name: "session_handoff", arguments: { session_id: "foreign0" } } });
  expect(foreign.status_code).toBe(404);
  const wildcard: any = await sdk.trigger("mcp::prompts::get", { body: { name: "session_handoff", arguments: { session_id: "foreign0", agentId: "*" } } });
  expect(wildcard.status_code).toBe(200); expect(JSON.stringify(wildcard)).toContain("foreign-secret");
  await lifecycle("archive", { kind: "observation", id: "A0o", sessionId: "A0" });
  const recent = await sdk.trigger("mcp::resources::read", { body: { uri: "agentmemory://project/p/recent" } });
  expect(JSON.stringify(recent)).not.toContain("own-visible");
  const handoff = await sdk.trigger("mcp::prompts::get", { body: { name: "session_handoff", arguments: { session_id: "A0" } } });
  expect(JSON.stringify(handoff)).not.toContain("own-visible");
  await lifecycle("archive", { kind: "session", id: "A0" });
  expect((await sdk.trigger("mcp::prompts::get", { body: { name: "session_handoff", arguments: { session_id: "A0" } } }) as any).status_code).toBe(404);
 });

 it("invalid explicit file-history projects cannot widen the read scope", async () => {
  registerMcpEndpoints(sdk as never, kv as never);
  for (const project of ["", 42, { project: "p" }]) {
   await expect(call("mem::file-context", { project, files: ["A.ts"] })).rejects.toThrow("project must be a non-empty string");
   const response: any = await sdk.trigger("mcp::tools::call", { headers: {}, body: { name: "memory_file_history", arguments: { project, files: "A.ts" } } });
   expect(response.status_code).toBe(400);
  }
 });
 it("archive visibility applies to sessions and observations before derivation and preserves canonical rows", async () => {
  const originals = await kv.list(KV.observations("B0"));
  const before = await reads({ agentId: "*" }); expect(JSON.stringify(before)).toContain("B-concept");
  await lifecycle("archive", { kind: "session", id: "B0" });
  for (const id of ["B1", "B2"]) await lifecycle("archive", { kind: "observation", id: id + "o", sessionId: id });
  const hidden = await reads({ agentId: "*" });
  expect(hidden.timeline.entries.map((e: any) => e.sessionId)).toEqual(["A0", "A1", "A2"]);
  expect(JSON.stringify(hidden)).not.toContain("B-concept"); expect(JSON.stringify(hidden)).not.toContain("B.ts"); expect(JSON.stringify(hidden)).not.toContain("B decision");
  expect(hidden.profile.cached).toBe(false); expect(hidden.patterns.patterns.some((p: any) => p.files.includes("B.ts"))).toBe(false);
  expect(await kv.list(KV.observations("B0"))).toEqual(originals);
  await lifecycle("restore", { kind: "session", id: "B0" });
  expect((await call("mem::profile", { agentId: "*" })).profile.topConcepts).toContainEqual({ concept: "B-concept", frequency: 1 });
 });
 it("isolated reads and cache keys do not cross agents; explicit wildcard remains deliberate", async () => {
  vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "isolated"); vi.stubEnv("AGENT_ID", "A");
  const a = await reads(); expect(JSON.stringify(a)).not.toContain("B-concept"); expect(JSON.stringify(a)).not.toContain("B.ts");
  expect(a.timeline.entries).toHaveLength(3); expect(a.profile.profile.agentId).toBe("A");
  const wildcard = await reads({ agentId: "*" }); expect(wildcard.timeline.entries).toHaveLength(6); expect(JSON.stringify(wildcard)).toContain("B-concept");
  expect((await call("mem::profile")).cached).toBe(true);
  vi.stubEnv("AGENT_ID", "B"); const b = await call("mem::profile"); expect(b.profile.agentId).toBe("B"); expect(b.cached).toBe(false);
  expect(await kv.get(KV.profiles, profileCacheKey("p", "A"))).toMatchObject({ agentId: "A" });
 });
 it("explicit isolated mode without identity fails closed across reads and session enumeration", async () => {
  vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "isolated"); vi.stubEnv("AGENT_ID", "");
  for (const [id, args] of [["mem::timeline", { anchor: "2026-10-02" }], ["mem::file-context", { files: ["A.ts"] }], ["mem::profile", {}], ["mem::patterns", {}], ["mem::context", { sessionId: "current" }], ["mem::search", { query: "decision" }], ["mem::smart-search", {query:"decision"}]] as const) await expect(call(id, args)).rejects.toThrow(/agent id|agentId|AGENT_ID/);
  const query = parseSessionQuery({ project: "p" }); if ("error" in query) throw Error(query.error);
  expect(() => selectSessionPage([], query)).toThrow(/agent id/);
  expect((await call("mem::timeline", { anchor: "2026-10-02", agentId: "*" })).entries).toHaveLength(6);
 });
 it("stale profile and unproved approval summary are omitted in favor of current visible observations", async () => {
  await kv.set(KV.profiles, "p", { project: "p", updatedAt: new Date().toISOString(), visibilityRevision: 0, topConcepts: [{ concept: "stale-secret", frequency: 1 }], topFiles: [], conventions: [approval], commonErrors: [], recentActivity: [], sessionCount: 6, totalObservations: 6 });
  await kv.set(KV.summaries, "A0", { sessionId: "A0", project: "p", createdAt: new Date().toISOString(), title: "cached-secret", narrative: approval, keyDecisions: [], filesModified: [], concepts: [], observationCount: 1 });
  const result = await call("mem::context", { sessionId: "current" });
  expect(result.context).toContain("A normal decision"); expect(result.context).not.toMatch(/stale-secret|approval-secret|cached-secret/);
 });
 it("rejects current-revision internal cache content even when its source fingerprint matches", async () => {
  const generated = await call("mem::profile");
  await kv.set(KV.profiles, profileCacheKey("p"), { ...generated.profile, conventions: [approval] });
  expect((await call("mem::context", {sessionId:"current"})).context).not.toContain("approval-secret");
  const rebuilt = await call("mem::profile"); expect(rebuilt.cached).toBe(false); expect(JSON.stringify(rebuilt)).not.toContain("approval-secret");
 });
 it("proved normal summary remains useful and is invalidated when its source changes or is archived", async () => {
  const original = await kv.get<CompressedObservation>(KV.observations("A0"), "A0o");
  await kv.set(KV.summaries, "A0", { sessionId: "A0", project: "p", createdAt: new Date().toISOString(), visibilityRevision: SUMMARY_VISIBILITY_REVISION, sourceDigest: summarySourceDigest([original!]), title: "normal-cached-summary", narrative: "useful cached narrative", keyDecisions: [], filesModified: [], concepts: [], observationCount: 1 });
  expect((await call("mem::context", { sessionId: "current" })).context).toContain("normal-cached-summary");
  await kv.set(KV.observations("A0"), "A0o", { ...original!, narrative: "changed normal original" });
  const changed = await call("mem::context", { sessionId: "current" }); expect(changed.context).not.toContain("normal-cached-summary"); expect(changed.context).toContain("changed normal original");
  await lifecycle("archive", { kind: "observation", id: "A0o", sessionId: "A0" });
  expect((await call("mem::context", { sessionId: "current" })).context).not.toContain("changed normal original");
 });
 it("legacy approval and pure page rows cannot be searched, expanded or cited for manual durable writes", async () => {
  for (const [suffix,narrative] of [["approval", approval],["page",page]]) { const row={...obs("A0","A",suffix,narrative), title:"prompt_submit"}; await kv.set(KV.observations("A0"),row.id,row); }
  await rebuildIndex(kv as never);
  expect((await call("mem::search", { query: "approval-secret", sourceKind: "user", trackAccess: false })).results).toEqual([]);
  expect((await call("mem::smart-search", {expandIds:[{obsId:"A0approval", sessionId:"A0"},{obsId:"A0page",sessionId:"A0"}],exactExpansion:true,trackAccess:false})).results).toEqual([]);
  expect(await readVisibleObservation(kv as never,"A0","A0approval")).toBeNull(); expect(await readVisibleObservation(kv as never,"A0","A0page")).toBeNull();
  await expect(validateObservationProvenance(kv as never, { project: "p", sources: [{ sessionId: "A0", observationIds: ["A0approval"] }] })).rejects.toThrow("unknown source observation");
 });
 it("excludes legacy native effort sessions across reads while preserving both canonical turns", async () => {
   const narrative = JSON.stringify({instructions: "You are an independent reasoning-effort evaluator, not the task executor. Return only the supplied JSON schema. " + "Use recommend with one supported effort, or abstain with effort null if uncertain. ".repeat(2),
     question: "Which reasoning effort is sufficient for the NEXT generation of state.model?",
     state: { coverage: { source: "native DecisionContext + local projectEvidence" } }, marker: "evaluation-secret"});
   const session = {id:"machine",project:"p",agentId:"A",cwd:"/p",startedAt:"2026-10-02T00:00:00Z",status:"completed",observationCount:2,firstPrompt:narrative.slice(0,200)};
   await kv.set(KV.sessions, session.id, session);
   for (const [suffix,text] of [["user",narrative],["final",'{"action":"recommend","effort":"high","reason":"evaluation-secret"}']]) {
     const row=obs(session.id,"A",suffix,text); await kv.set(KV.observations(session.id),row.id,row);
   }
   const originals = structuredClone(await kv.list(KV.observations(session.id)));
   await rebuildIndex(kv as never);
   expect((await call("mem::search",{query:"evaluation-secret",trackAccess:false})).results).toEqual([]);
   expect((await call("mem::smart-search",{expandIds:[{obsId:"machinefinal",sessionId:"machine"}],exactExpansion:true,trackAccess:false})).results).toEqual([]);
   expect(await readVisibleObservation(kv as never,"machine","machinefinal")).toBeNull();
   expect(JSON.stringify(await reads())).not.toContain("evaluation-secret");
   expect(await kv.list(KV.observations(session.id))).toEqual(originals);
 });
 it("MCP and REST forward explicit project and agent scope on all exposed derived reads", async () => {
  registerMcpEndpoints(sdk as never, kv as never); registerApiTriggers(sdk as never, kv as never, async () => ({ context: "", blocks:0, tokens:0 }));
  for (const [tool, fn, args] of [["memory_file_history", "mem::file-context", { files: "A.ts" }], ["memory_patterns","mem::patterns",{}], ["memory_profile","mem::profile",{}], ["memory_timeline","mem::timeline",{ anchor: "2026-10-02" }]] as const) {
    const payloads: any[]=[]; sdk.fns.set(fn, async payload => {payloads.push(payload);return {context:"ok"};});
    await sdk.trigger("mcp::tools::call", { headers: {}, body: { name:tool, arguments:{...args,project:"p",agentId:"B"} } }); expect(payloads[0]).toMatchObject({project:"p",agentId:"B"});
  }
  const captured: any[]=[]; for (const id of ["mem::file-context","mem::patterns","mem::profile","mem::timeline"]) sdk.fns.set(id, async payload => { captured.push(payload);return {}; });
  await sdk.trigger("api::file-context", { body: { files:["A.ts"],project:"p",agentId:"B",untrusted:"drop" } });
  await sdk.trigger("api::patterns", { body: {project:"p",agentId:"B",untrusted:"drop"} });
  await sdk.trigger("api::profile", {query_params:{project:"p",agentId:"B"} });
  await sdk.trigger("api::timeline", {body:{anchor:"2026-10-02",project:"p",agentId:"B",untrusted:"drop"} });
  expect(captured).toHaveLength(4); for (const payload of captured) {expect(payload).toMatchObject({project:"p",agentId:"B"});expect(payload).not.toHaveProperty("untrusted");}
 });
});
