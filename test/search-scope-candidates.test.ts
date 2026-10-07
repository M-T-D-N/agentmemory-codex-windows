import { afterEach, describe, expect, it, vi } from "vitest";
import { HybridSearch } from "../src/state/hybrid-search.js";
import { VectorIndex } from "../src/state/vector-index.js";
import { SearchIndex } from "../src/state/search-index.js";
import { createSearchCandidateSelection } from "../src/functions/search-candidates.js";
import { getSearchIndex, registerSearchFunction, setHybridRanker, setVectorIndex } from "../src/functions/search.js";
import { registerSmartSearchFunction } from "../src/functions/smart-search.js";
import { KV } from "../src/state/schema.js";
import type { CompressedObservation, Session } from "../src/types.js";

afterEach(() => { getSearchIndex().clear(); setHybridRanker(null); setVectorIndex(null); });
function fixture() {
  const store = new Map<string, Map<string, unknown>>();
  let active = 0, maximum = 0, reads = 0;
  const kv = {
    async get<T>(scope: string, key: string): Promise<T | null> {
      active++; reads++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 0));
      active--;
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    async list<T>(scope: string): Promise<T[]> { return [...(store.get(scope)?.values() ?? [])] as T[]; },
    async set<T>(scope: string, key: string, value: T) {
      if (!store.has(scope)) store.set(scope, new Map()); store.get(scope)!.set(key, value); return value;
    },
  };
  const session = (id: string, project: string): Session => ({ id, project, cwd: "/" + project, startedAt: "2026-09-13T00:00:00Z", status: "completed", observationCount: 1 });
  const obs = (id: string, sessionId: string, agentId: string, title = "AuthService"): CompressedObservation => ({
    id, sessionId, agentId, title, timestamp: "2026-09-13T00:00:00Z", type: "decision", narrative: title,
    facts: [], concepts: [], files: [], importance: 1,
  });
  return { kv, session, obs, reads: () => reads, maximum: () => maximum };
}

describe("scope before retrieval candidate limits", () => {
  it("uses verified indexed locations for shared graph provenance while retaining stale-hint fallback", async () => {
    const { kv, session, obs, reads } = fixture();
    const sources = Array.from({ length: 40 }, (_, i) => "source-" + i);
    for (const id of sources) await kv.set(KV.sessions, id, session(id, "own"));
    const owner = sources.at(-1)!;
    const assistant = obs("assistant", owner, "agent", "assistant_response");
    const user = obs("user", owner, "agent", "prompt_submit");
    await kv.set(KV.observations(owner), assistant.id, assistant);
    await kv.set(KV.observations(owner), user.id, user);
    const candidates = [assistant, user].map(row => ({ obsId: row.id, sessionId: "", sourceSessionIds: sources }));
    const selector = createSearchCandidateSelection(kv as never, { project: "own", sourceKind: "user" });
    expect((await selector.select(candidates, 1, () => owner)).map(row => row.obsId)).toEqual([user.id]);
    expect(reads()).toBe(2);
    const stale = createSearchCandidateSelection(kv as never, { project: "own", sourceKind: "user" });
    expect((await stale.select([candidates[1]], 1, () => sources[0])).map(row => row.obsId)).toEqual([user.id]);
    const outside = createSearchCandidateSelection(kv as never, { project: "own", sourceKind: "user" });
    expect((await outside.select([candidates[1]], 1, () => "unrelated")).map(row => row.obsId)).toEqual([user.id]);
    const index = new SearchIndex(); index.add(assistant); index.add(user);
    await kv.set(KV.graphNodes, "shared", { id: "shared", name: "AuthService", type: "concept", project: "own",
      sourceObservationIds: [assistant.id, user.id], sourceSessionIds: sources, properties: {}, createdAt: user.timestamp });
    const read = vi.spyOn(kv, "get");
    const hybrid = new HybridSearch(index, null, null, kv as never);
    const result = await hybrid.search("AuthService", 1, createSearchCandidateSelection(kv as never, { project: "own", sourceKind: "user" }));
    expect(result.map(row => row.observation.id)).toEqual([user.id]);
    expect(result[0].graphScore).toBeGreaterThan(0);
    expect(read.mock.calls.filter(([scope]) => scope.startsWith("mem:obs:"))).toHaveLength(2);
  });

  it("retrieves original user requirements below assistant summaries without changing ordinary recall", async () => {
    const { kv, session, obs } = fixture();
    await kv.set(KV.sessions, "legacy", session("legacy", "legacy-space"));
    const index = getSearchIndex();
    for (let i = 0; i < 75; i++) {
      const row = { ...obs("summary-" + i, "legacy", "agent", "assistant_response"), narrative: "Invoice rounding" };
      index.add(row); await kv.set(KV.observations("legacy"), row.id, row);
    }
    const target = { ...obs("original", "legacy", "agent", "prompt_submit"), narrative: "Invoice rounding must remain exact until the final total. " + "supporting context ".repeat(40) };
    index.add(target); await kv.set(KV.observations("legacy"), target.id, target);
    const handlers = new Map<string, Function>();
    registerSearchFunction({ registerFunction(id: string, fn: Function) { handlers.set(id, fn); } } as never, kv as never);
    const input = { query: "Invoice rounding", project: "*", limit: 1, trackAccess: false };
    const search = handlers.get("mem::search")!;
    const ranker = vi.fn(async () => []);
    setHybridRanker(ranker);
    expect((await search({ ...input, sourceKind: "user", searchMode: "keyword" })).results.map((r: any) => r.observation.id)).toEqual(["original"]);
    expect(ranker).not.toHaveBeenCalled();
    await search(input);
    expect(ranker).toHaveBeenCalledOnce();
    await expect(search({ ...input, searchMode: "invented" })).rejects.toThrow("searchMode");
    setHybridRanker(null);
    expect((await search(input)).results[0].observation.title).toBe("assistant_response");
    expect((await search({ ...input, sourceKind: "user" })).results.map((r: any) => r.observation.id)).toEqual(["original"]);
    expect((await search({ ...input, sourceKind: "user", project: "other" })).results).toEqual([]);
    expect((await search({ ...input, sourceKind: "user", agentId: "other" })).results).toEqual([]);
    await expect(search({ ...input, sourceKind: "invented" })).rejects.toThrow("sourceKind");
    const misleading = { ...target, title: "prompt_submit", codexSource: { kind: "assistant_final" } };
    await kv.set(KV.observations("legacy"), target.id, misleading);
    expect((await search({ ...input, sourceKind: "user" })).results).toEqual([]);
    await kv.set(KV.observations("legacy"), target.id, { ...target, emptyDeletion: { state: "deleted" } });
    expect((await search({ ...input, sourceKind: "user" })).results).toEqual([]);
  });

  it("finds the keyword hit below hundreds of out-of-project and out-of-agent hits through both service entry points", async () => {
    const { kv, session, obs, maximum } = fixture();
    await kv.set(KV.sessions, "other", session("other", "other"));
    await kv.set(KV.sessions, "own", session("own", "own"));
    const index = getSearchIndex(); index.clear();
    for (let i = 0; i < 350; i++) {
      const row = obs("ranked-" + i, i < 175 ? "other" : "own", "other-agent");
      index.add(row); await kv.set(KV.observations(row.sessionId), row.id, row);
    }
    const target = obs("target", "own", "chosen-agent", "AuthService " + "additional context ".repeat(100));
    index.add(target); await kv.set(KV.observations("own"), target.id, target);
    const handlers = new Map<string, Function>();
    const sdk = { registerFunction(id: string, fn: Function) { handlers.set(id, fn); } };
    registerSearchFunction(sdk as never, kv as never);
    const hybrid = new HybridSearch(index, null, null, kv as never);
    registerSmartSearchFunction(sdk as never, kv as never, (query, limit, selection) => hybrid.search(query, limit, selection));
    const input = { query: "AuthService", project: "own", agentId: "chosen-agent", limit: 1, trackAccess: false, includeLessons: false };
    const plain = await handlers.get("mem::search")!(input);
    expect(plain.results.map((r: any) => r.observation.id)).toEqual([target.id]);
    const compact = await handlers.get("mem::smart-search")!(input);
    expect(compact.results.map((r: any) => r.obsId)).toEqual([target.id]);
    expect(maximum()).toBeLessThanOrEqual(8);
  });

  it("filters vector candidates before nearest-neighbor depth truncation", async () => {
    const { kv, session, obs } = fixture();
    await kv.set(KV.sessions, "other", session("other", "other"));
    await kv.set(KV.sessions, "own", session("own", "own"));
    const vector = new VectorIndex();
    for (let i = 0; i < 120; i++) {
      const row = obs("near-" + i, "other", "other");
      vector.add(row.id, row.sessionId, new Float32Array([1, 0]));
      await kv.set(KV.observations(row.sessionId), row.id, row);
    }
    const target = obs("distant", "own", "own");
    vector.add(target.id, "own", new Float32Array([0.1, 1]));
    await kv.set(KV.observations("own"), target.id, target);
    const hybrid = new HybridSearch(new SearchIndex(), vector, { embed: async () => new Float32Array([1, 0]) } as never, kv as never);
    const result = await hybrid.search("query", 1, createSearchCandidateSelection(kv as never, { project: "own" }));
    expect(result.map(row => row.observation.id)).toEqual([target.id]);
    expect(result[0].vectorScore).toBeGreaterThan(0);
  });

  it("resolves graph-only hits from verified session provenance and excludes another project's graph context", async () => {
    const { kv, session, obs } = fixture();
    for (const project of ["other", "own"]) {
      await kv.set(KV.sessions, project, session(project, project));
      const row = obs(project + "-observation", project, "agent", "different words");
      await kv.set(KV.observations(project), row.id, row);
      await kv.set(KV.graphNodes, project, { id: project, name: "AuthService " + project, type: "concept", project,
        sourceObservationIds: [row.id], sourceSessionIds: [project], properties: {}, createdAt: row.timestamp });
    }
    const hybrid = new HybridSearch(new SearchIndex(), null, null, kv as never);
    const result = await hybrid.search("AuthService", 1, createSearchCandidateSelection(kv as never, { project: "own", agentId: "agent" }));
    expect(result.map(row => [row.observation.id, row.sessionId])).toEqual([["own-observation", "own"]]);
    expect(result[0].graphContext).not.toContain("other");
    const handlers = new Map<string, Function>();
    registerSearchFunction({ registerFunction(id: string, fn: Function) { handlers.set(id, fn); } } as never, kv as never);
    setHybridRanker((query, limit, selection) => hybrid.search(query, limit, selection));
    const primary = await handlers.get("mem::search")!({ query: "AuthService", project: "own", agentId: "agent", limit: 1, trackAccess: false });
    expect(primary.results.map((row: any) => row.observation.id)).toEqual(["own-observation"]);
  });

  it("does not disguise a failed canonical scope read as an empty vector result", async () => {
    const { kv, session } = fixture();
    await kv.set(KV.sessions, "own", session("own", "own"));
    const broken = { ...kv, get: async () => { throw Error("canonical read failed"); } };
    const vector = new VectorIndex(); vector.add("target", "own", new Float32Array([1, 0]));
    const hybrid = new HybridSearch(new SearchIndex(), vector, { embed: async () => new Float32Array([1, 0]) } as never, broken as never);
    await expect(hybrid.search("query", 1, createSearchCandidateSelection(broken as never, { project: "own" }))).rejects.toThrow("canonical read failed");
  });

  it("reuses canonical candidate checks across streams and does not accept a missing or hidden record", async () => {
    const { kv, session, obs, reads } = fixture();
    await kv.set(KV.sessions, "own", session("own", "own"));
    const row = obs("hidden", "own", "agent");
    row.emptyDeletion = { state: "deleted", version: 1, changedAt: row.timestamp, reason: "empty", auditId: "a" };
    await kv.set(KV.observations("own"), row.id, row);
    const selector = createSearchCandidateSelection(kv as never, { project: "own" });
    const candidates = [{ obsId: "missing", sessionId: "own" }, { obsId: "hidden", sessionId: "own" }];
    expect(await selector.select(candidates, 1)).toEqual([]);
    const count = reads();
    expect(await selector.select(candidates, 1)).toEqual([]);
    expect(reads()).toBe(count);
  });
  it("reuses verified observations and session metadata through hybrid and final loading only within one request", async () => {
    const { kv, session, obs } = fixture();
    await kv.set(KV.sessions, "own", session("own", "own"));
    const index = getSearchIndex();
    const vector = new VectorIndex();
    for (let i = 0; i < 10; i++) {
      const row = obs("shared-" + i, "own", "agent", "auth");
      index.add(row); vector.add(row.id, row.sessionId, new Float32Array([1, 0]));
      await kv.set(KV.observations("own"), row.id, row);
    }
    const read = vi.spyOn(kv, "get");
    const list = vi.spyOn(kv, "list");
    const hybrid = new HybridSearch(index, vector, { embed: async () => new Float32Array([1, 0]) } as never, kv as never, 0.4, 0.6, 0, false);
    const handlers = new Map<string, Function>();
    registerSearchFunction({ registerFunction(id: string, fn: Function) { handlers.set(id, fn); } } as never, kv as never);
    setHybridRanker((query, limit, selection) => hybrid.search(query, limit, selection));
    const search = handlers.get("mem::search")!;
    const input = { query: "auth", project: "own", limit: 3, trackAccess: false };
    expect((await search(input)).results).toHaveLength(3);
    expect(read.mock.calls.filter(([scope]) => scope.startsWith("mem:obs:"))).toHaveLength(10);
    expect(read.mock.calls.filter(([scope]) => scope === KV.sessions)).toHaveLength(0);
    expect(list.mock.calls.filter(([scope]) => scope === KV.sessions)).toHaveLength(1);
    expect((await search(input)).results).toHaveLength(3);
    expect(read.mock.calls.filter(([scope]) => scope.startsWith("mem:obs:"))).toHaveLength(20);
    expect(list.mock.calls.filter(([scope]) => scope === KV.sessions)).toHaveLength(2);
    await kv.set(KV.memories, "saved-memory", {
      id: "saved-memory", agentId: "agent", project: "memory-owner", sessionIds: ["own"],
      createdAt: "2026-09-13T00:00:00Z", updatedAt: "2026-09-13T00:00:00Z",
      type: "fact", title: "saved", content: "saved canonical content", concepts: [], files: [],
      strength: 1, version: 1, isLatest: true,
    });
    index.add(obs("saved-memory", "own", "agent", "saved"));
    const saved = await search({ query: "saved", project: "memory-owner", agentId: "agent", limit: 1, trackAccess: false });
    expect(saved.results.map((row: any) => [row.observation.narrative, row.sessionId, row.project]))
      .toEqual([["saved canonical content", "own", "memory-owner"]]);
    expect(read.mock.calls.filter(([scope]) => scope.startsWith("mem:obs:") || scope === KV.memories || scope === KV.sessions)).toHaveLength(20);

  });

  it("never reuses a ranker's unverified body or a mismatched candidate location", async () => {
    const { kv, session, obs, reads } = fixture();
    await kv.set(KV.sessions, "own", session("own", "own"));
    const row = obs("original", "own", "agent", "prompt_submit");
    await kv.set(KV.observations("own"), row.id, row);
    const selector = createSearchCandidateSelection(kv as never, { project: "own" });
    const selected = await selector.select([{ obsId: row.id, sessionId: "", sourceSessionIds: ["missing", "own"] }], 1, () => "own");
    const count = reads();
    expect((await selector.resolve({ obsId: row.id, sessionId: "own" }))?.observation).toEqual(row);
    expect(reads()).toBe(count);
    expect(await selector.resolve({ obsId: row.id, sessionId: "missing" })).toBeNull();
    expect(selected[0].sessionId).toBe("own");
    const handlers = new Map<string, Function>();
    registerSearchFunction({ registerFunction(id: string, fn: Function) { handlers.set(id, fn); } } as never, kv as never);
    getSearchIndex().add(row);
    const search = handlers.get("mem::search")!;
    const input = { query: "prompt_submit", project: "own", sourceKind: "user", trackAccess: false };
    setHybridRanker(async () => [{ observation: { ...row, narrative: "forged" }, sessionId: "own", combinedScore: 1 }]);
    expect((await search(input)).results[0].observation.narrative).toBe(row.narrative);
    setHybridRanker(async () => [{ observation: row, sessionId: "missing", combinedScore: 1 }]);
    expect((await search(input)).results).toEqual([]);
    await kv.set(KV.observations("own"), row.id, { ...row, sessionId: "unrelated" });
    setHybridRanker(async () => [{ observation: row, sessionId: "own", combinedScore: 1 }]);
    expect((await search(input)).results).toEqual([]);
    await kv.set(KV.observations("own"), row.id, { ...row, emptyDeletion: { state: "deleted" } });
    expect((await search(input)).results).toEqual([]);
  });

  it("reuses selector session metadata in entity retrieval and vector graph expansion", async () => {
    const { kv, session, obs } = fixture();
    await kv.set(KV.sessions, "own", session("own", "own"));
    await kv.set(KV.sessions, "ambient", { ...session("ambient", "own"), captureExcluded: true });
    const seed = obs("seed", "own", "agent");
    const related = obs("related", "own", "agent", "different words");
    const hidden = obs("hidden", "ambient", "agent", "different words");
    for (const row of [seed, related, hidden]) await kv.set(KV.observations(row.sessionId), row.id, row);
    for (const [id, name, row] of [["start", "AuthService", seed], ["related", "Neighbor", related], ["hidden", "Private", hidden]] as const) {
      await kv.set(KV.graphNodes, id, { id, name, type: "concept", project: "own", sourceObservationIds: [row.id],
        sourceSessionIds: [row.sessionId], properties: {}, createdAt: seed.timestamp });
    }
    for (const id of ["related", "hidden"]) await kv.set(KV.graphEdges, id, {
      id, type: "related_to", project: "own", sourceNodeId: "start", targetNodeId: id, weight: 0.8, isLatest: true,
      sourceObservationIds: [seed.id], sourceSessionIds: ["own"], createdAt: seed.timestamp,
    });
    const index = new SearchIndex(); index.add(seed);
    const vector = new VectorIndex(); vector.add(seed.id, seed.sessionId, new Float32Array([1, 0]));
    const read = vi.spyOn(kv, "get");
    const list = vi.spyOn(kv, "list");
    const hybrid = new HybridSearch(index, vector, { embed: async () => new Float32Array([1, 0]) } as never, kv as never, 0.4, 0.6, 0.3, false);
    const selection = createSearchCandidateSelection(kv as never, { project: "own" });
    const results = await hybrid.search("AuthService", 5, selection);
    expect(results.map(row => row.observation.id)).toEqual(["seed", "related"]);
    expect(read.mock.calls.filter(([scope]) => scope === KV.sessions)).toHaveLength(0);
    expect(list.mock.calls.filter(([scope]) => scope === KV.sessions)).toHaveLength(1);
    expect(list.mock.calls.filter(([scope]) => scope === KV.graphEdges)).toHaveLength(2);
    expect(await selection.readSession!("absent")).toBeNull();
    expect(list.mock.calls.filter(([scope]) => scope === KV.sessions)).toHaveLength(1);
  });

});
