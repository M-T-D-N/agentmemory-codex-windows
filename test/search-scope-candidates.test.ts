import { afterEach, describe, expect, it } from "vitest";
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
});
