import { describe, it, expect, beforeEach, vi } from "vitest";
import * as reranker from "../src/state/reranker.js";
import { HybridSearch } from "../src/state/hybrid-search.js";
import { SearchIndex } from "../src/state/search-index.js";
import { createSearchCandidateSelection } from "../src/functions/search-candidates.js";
import type { CompressedObservation, EmbeddingProvider } from "../src/types.js";

function makeObs(
  overrides: Partial<CompressedObservation> = {},
): CompressedObservation {
  return {
    id: "obs_1",
    sessionId: "ses_1",
    timestamp: new Date().toISOString(),
    type: "file_edit",
    title: "Edit auth middleware",
    subtitle: "JWT validation",
    facts: ["Added token check"],
    narrative: "Modified the auth middleware to validate JWT tokens",
    concepts: ["authentication", "jwt"],
    files: ["src/middleware/auth.ts"],
    importance: 7,
    ...overrides,
  };
}

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
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

describe("HybridSearch", () => {
  let bm25: SearchIndex;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    bm25 = new SearchIndex();
    kv = mockKV();
  });

  it.each(["no-vector", "provider-down", "large-index"])("bounds automatic hybrid and reports %s without graph traversal", async (mode) => {
    const observation = makeObs(); bm25.add(observation); await kv.set("mem:obs:ses_1", observation.id, observation);
    const list = vi.spyOn(kv, "list");
    const embed = vi.fn(async () => { if (mode === "provider-down") throw Error("offline"); return new Float32Array([1,0]); });
    const vectorSearch = vi.fn(() => [{obsId:observation.id,sessionId:observation.sessionId,score:1}]);
    const vector = mode === "no-vector" ? null : {size:mode === "large-index" ? 4097 : 1,search:vectorSearch};
    const channels: Record<string,string> = {};
    const hybrid = new HybridSearch(bm25, vector as never, {embed} as never, kv as never);
    const result = await hybrid.search("auth", 8, undefined, {maxVectorScan:4096,channels});
    expect(result[0].observation.narrative).toBe(observation.narrative);
    expect(channels.graph).toBe("skipped-automatic");
    expect(channels.vector).toBe(mode === "no-vector" ? "unavailable" : mode === "provider-down" ? "failed" : "skipped-scan-bound");
    expect(list).not.toHaveBeenCalled();
    expect(vectorSearch).not.toHaveBeenCalled();
    expect(embed).toHaveBeenCalledTimes(mode === "provider-down" ? 1 : 0);
  });

  it("retains labelled semantic candidates below the automatic vector scan cap and leaves manual vector behavior unchanged", async () => {
    const observation = makeObs({narrative:"Preserve pennies until aggregation.",title:"Original user request"});
    await kv.set("mem:obs:ses_1", observation.id, observation);
    const embed = vi.fn(async () => new Float32Array([1,0]));
    const vectorSearch = vi.fn(() => [{obsId:observation.id,sessionId:observation.sessionId,score:1}]);
    const vector = {size:4096,search:vectorSearch};
    const hybrid = new HybridSearch(bm25, vector as never, {embed} as never, kv as never);
    const channels: Record<string,string> = {};
    expect((await hybrid.search("invoice rounding",8,undefined,{maxVectorScan:4096,channels}))[0].observation.narrative).toBe(observation.narrative);
    expect(channels.vector).toBe("available");
    vector.size = 100000;
    expect((await hybrid.search("invoice rounding",8))[0].observation.id).toBe(observation.id);
    expect(embed).toHaveBeenCalledTimes(2);
    expect(vectorSearch).toHaveBeenCalledTimes(2);
  });

  it.each(["manual", "automatic"])("keeps higher-ranked same-session originals in %s search", async (mode) => {
    const originals: string[] = [];
    for (let i = 0; i < 4; i++) {
      const observation = makeObs({
        id: `original_${i}`, sessionId: "target_session",
        narrative: "session_bridge_probe routing ".repeat(5),
      });
      originals.push(observation.id);
      bm25.add(observation);
      await kv.set("mem:obs:target_session", observation.id, observation);
    }
    for (let i = 0; i < 30; i++) {
      const observation = makeObs({
        id: `background_${i}`, sessionId: `background_session_${i}`,
        narrative: "routing",
      });
      bm25.add(observation);
      await kv.set(`mem:obs:${observation.sessionId}`, observation.id, observation);
    }
    const query = "session_bridge_probe routing";
    expect(bm25.search(query, 4).map(r => r.obsId)).toEqual(originals);
    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search(query, 10, undefined,
      mode === "automatic" ? { maxVectorScan: 4096, channels: {} } : undefined);
    expect(results.map(r => r.observation.id)).toEqual(expect.arrayContaining(originals));
    expect(results.every((r, i) => i === 0 || r.combinedScore <= results[i - 1].combinedScore)).toBe(true);
  });


  it.each(["manual", "automatic"])("avoids excess canonical reads for keyword-only %s search without losing filtered originals", async mode => {
    const canonical = new Map<string, CompressedObservation>();
    await kv.set("mem:sessions", "ses_1", { id: "ses_1", project: "target" });
    await kv.set("mem:sessions", "other", { id: "other", project: "other" });
    for (let i = 0; i < 180; i++) {
      const row = makeObs({ id: "candidate_" + String(i).padStart(3, "0"), title: "auth", sessionId: i < 40 ? "other" : "ses_1" });
      bm25.add(row);
      if (i !== 40 && i !== 41) { canonical.set(row.id, row); await kv.set("mem:obs:" + row.sessionId, row.id, row); }
    }
    const expected = bm25.search("auth", bm25.size).filter(row => canonical.get(row.obsId)?.sessionId === "ses_1").slice(0, 20).map(row => row.obsId);
    const policy = mode === "automatic" ? { maxVectorScan: 4096, channels: {} } : undefined;
    const search = new HybridSearch(bm25, null, null, kv as never, 0.4, 0.6, 0.3, false);
    const read = vi.spyOn(kv, "get");
    const legacy = createSearchCandidateSelection(kv as never, { project: "target" });
    const baseline = await search.search("auth", 20, { ...legacy, resolve: undefined }, policy);
    const priorReads = read.mock.calls.length; read.mockClear();
    const result = await search.search("auth", 20, createSearchCandidateSelection(kv as never, { project: "target" }), policy);
    expect(result.map(row => row.observation.id)).toEqual(expected);
    expect(result).toEqual(baseline);
    expect(read.mock.calls.length).toBeLessThan(priorReads);
  });

  it("returns BM25-only results when no vector index is provided", async () => {
    const obs = makeObs({ id: "obs_1", sessionId: "ses_1" });
    bm25.add(obs);
    await kv.set("mem:obs:ses_1", "obs_1", obs);

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("auth");

    expect(results.length).toBe(1);
    expect(results[0].observation.id).toBe("obs_1");
    expect(results[0].vectorScore).toBe(0);
    expect(results[0].bm25Score).toBeGreaterThan(0);
  });

  it("returns empty results for no-match query", async () => {
    const obs = makeObs({ id: "obs_1", sessionId: "ses_1" });
    bm25.add(obs);
    await kv.set("mem:obs:ses_1", "obs_1", obs);

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("database");
    expect(results).toEqual([]);
  });

  it("combinedScore is derived from bm25Score when no vector index", async () => {
    const obs = makeObs({ id: "obs_1", sessionId: "ses_1" });
    bm25.add(obs);
    await kv.set("mem:obs:ses_1", "obs_1", obs);

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("auth");

    expect(results[0].combinedScore).toBeGreaterThan(0);
    expect(results[0].vectorScore).toBe(0);
    expect(results[0].graphScore).toBe(0);
  });

  it("results are sorted by combinedScore descending", async () => {
    const obs1 = makeObs({
      id: "obs_1",
      sessionId: "ses_1",
      title: "auth handler",
      narrative: "auth auth auth module",
      concepts: ["auth"],
    });
    const obs2 = makeObs({
      id: "obs_2",
      sessionId: "ses_1",
      title: "database setup",
      narrative: "auth connection config",
      concepts: ["database"],
    });
    bm25.add(obs1);
    bm25.add(obs2);
    await kv.set("mem:obs:ses_1", "obs_1", obs1);
    await kv.set("mem:obs:ses_1", "obs_2", obs2);

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("auth");

    expect(results.length).toBe(2);
    expect(results[0].combinedScore).toBeGreaterThanOrEqual(
      results[1].combinedScore,
    );
  });

  it("respects limit parameter", async () => {
    for (let i = 0; i < 10; i++) {
      const obs = makeObs({
        id: `obs_${i}`,
        sessionId: "ses_1",
        title: `auth feature ${i}`,
      });
      bm25.add(obs);
      await kv.set("mem:obs:ses_1", `obs_${i}`, obs);
    }

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("auth", 3);
    expect(results.length).toBe(3);
  });

  it("skips observations not found in KV", async () => {
    const obs = makeObs({ id: "obs_missing", sessionId: "ses_1" });
    bm25.add(obs);

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("auth");
    expect(results).toEqual([]);
  });

  it("falls back to KV.memories when an indexed entry is a saved memory (#265)", async () => {
    // mem::remember writes to KV.memories under the synthetic sessionId
    // "memory" — the BM25 index sees that synthetic sessionId, but
    // KV.observations("memory") never has anything.
    const indexable = makeObs({
      id: "mem_abc",
      sessionId: "memory",
      title: "Test memory for search",
      narrative: "Test memory for search",
      concepts: ["test", "search"],
    });
    bm25.add(indexable);

    const memory = {
      id: "mem_abc",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      type: "fact",
      title: "Test memory for search",
      content: "Test memory for search",
      concepts: ["test", "search"],
      files: [],
      sessionIds: [],
      strength: 7,
      version: 1,
      isLatest: true,
    };
    await kv.set("mem:memories", "mem_abc", memory);

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("test memory search");

    expect(results.length).toBe(1);
    expect(results[0].observation.id).toBe("mem_abc");
    expect(results[0].observation.narrative).toBe("Test memory for search");
    expect(results[0].observation.concepts).toEqual(["test", "search"]);
  });

  it("does not hydrate superseded memories from a stale index entry", async () => {
    bm25.add({
      id: "mem_stale",
      sessionId: "memory",
      timestamp: "2026-01-01T00:00:00Z",
      type: "decision",
      title: "Stale memory search token",
      facts: ["stale memory search token"],
      narrative: "stale memory search token",
      concepts: ["stale"],
      files: [],
      importance: 7,
    });
    await kv.set("mem:memories", "mem_stale", {
      id: "mem_stale",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
      type: "fact",
      title: "Stale memory search token",
      content: "stale memory search token",
      concepts: ["stale"],
      files: [],
      sessionIds: [],
      strength: 7,
      version: 1,
      isLatest: false,
    });

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("stale memory search token");
    expect(results.some((entry) => entry.observation.id === "mem_stale")).toBe(
      false,
    );
  });
  it.each([
    { limit: 3, rerankEnabled: false, automatic: false, window: 3 },
    { limit: 3, rerankEnabled: true, automatic: false, window: 20 },
    { limit: 25, rerankEnabled: true, automatic: false, window: 25 },
    { limit: 3, rerankEnabled: true, automatic: true, window: 3 },
  ])("hydrates only the required valid head with limit $limit, reranking $rerankEnabled and automatic $automatic", async ({ limit, rerankEnabled, automatic, window }) => {
    for (let i = 0; i < 60; i++) bm25.add(makeObs({ id: "obs_" + String(i).padStart(2, "0"), title: "auth" }));
    const ranked = bm25.search("auth", 60);
    const missing = new Set(ranked.slice(0, 2).map(row => row.obsId));
    for (const row of ranked) if (!missing.has(row.obsId)) await kv.set("mem:obs:ses_1", row.obsId, makeObs({ id: row.obsId, title: "auth" }));
    const read = vi.spyOn(kv, "get");
    const rerankSpy = vi.spyOn(reranker, "rerank").mockImplementation(async (_query, rows) => [...rows].reverse());
    try {
      const hybrid = new HybridSearch(bm25, null, null, kv as never, 0.4, 0.6, 0, rerankEnabled);
      const selection = { select: async <T>(rows: T[], count: number) => rows.slice(0, count) };
      const results = await hybrid.search("auth", limit, selection, automatic ? { maxVectorScan: 4096, channels: {} } : undefined);
      const validIds = ranked.filter(row => !missing.has(row.obsId)).map(row => row.obsId);
      const expected = rerankEnabled && !automatic ? validIds.slice(0, 20).reverse().concat(validIds.slice(20)) : validIds;
      expect(results.map(row => row.observation.id)).toEqual(expected.slice(0, limit));
      expect(read.mock.calls.filter(([scope]) => scope.startsWith("mem:obs:"))).toHaveLength(window + 2);
      expect(read.mock.calls.filter(([scope]) => scope === "mem:memories")).toHaveLength(2);
      if (rerankEnabled && !automatic) {
        expect(rerankSpy).toHaveBeenCalledOnce();
        expect(rerankSpy.mock.calls[0][1]).toHaveLength(20);
        expect(rerankSpy.mock.calls[0][2]).toBe(20);
      } else expect(rerankSpy).not.toHaveBeenCalled();
    } finally { rerankSpy.mockRestore(); }
  });

});
