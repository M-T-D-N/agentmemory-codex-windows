import { describe, it, expect, beforeEach } from "vitest";
import { SearchIndex } from "../src/state/search-index.js";
import { segmentCjk } from "../src/state/cjk-segmenter.js";
import type { CompressedObservation } from "../src/types.js";

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

describe("SearchIndex", () => {
  let index: SearchIndex;

  beforeEach(() => {
    index = new SearchIndex();
  });

  it("counts memory and lesson documents apart from observations", () => {
    index.add(makeObs({ id: "obs_1" }));
    index.add(makeObs({ id: "mem_1", sessionId: "memory" }));
    index.add(makeObs({ id: "mem_2", sessionId: "ses_1" }));
    index.add(makeObs({ id: "lsn_1", sessionId: "lesson" }));

    expect(index.documentKindCounts()).toEqual({ memories: 2, lessons: 1 });
  });

  it("starts empty", () => {
    expect(index.size).toBe(0);
  });

  it("tracks content mutations without revising unchanged records or empty removals", () => {
    expect(index.revision).toBe(0);
    index.remove("missing"); index.clear();
    expect(index.revision).toBe(0);
    const observation = makeObs();
    index.add(observation);
    const added = index.revision;
    expect(added).toBeGreaterThan(0);
    index.add({ ...observation, importance: 9, timestamp: "2026-10-03T00:00:00Z" });
    index.remove("missing");
    expect(index.revision).toBe(added);
    index.add({ ...observation, sessionId: "new-owner" });
    expect(index.revision).toBeGreaterThan(added);
    const changed = index.revision;
    index.remove(observation.id);
    expect(index.revision).toBeGreaterThan(changed);
    const removed = index.revision;
    index.clear(); index.remove(observation.id);
    expect(index.revision).toBe(removed);
    const restored = new SearchIndex(); restored.add(observation);
    index.restoreFrom(restored);
    expect(index.revision).toBeGreaterThan(removed);
    const snapshot = JSON.parse(index.serialize());
    expect(snapshot.v).toBe(3);
    expect(snapshot).not.toHaveProperty("revision");
    const beforeClear = index.revision;
    index.clear();
    expect(index.revision).toBeGreaterThan(beforeClear);
  });

  it("revises targets when captured changes insert or remove their postings", () => {
    const capture = index.captureChanges();
    index.add(makeObs());
    const target = new SearchIndex();
    capture.applyTo(target);
    expect(target.revision).toBeGreaterThan(0);
    expect(target.search("auth")[0]?.obsId).toBe("obs_1");
    const inserted = target.revision;
    index.remove("obs_1");
    capture.applyTo(target);
    expect(target.revision).toBeGreaterThan(inserted);
    expect(target.size).toBe(0);
    capture.stop();
  });

  it("detects an empty live clear during rebuild even though its revision is unchanged", () => {
    const capture = index.captureChanges();
    const target = new SearchIndex(); target.add(makeObs());
    index.clear();
    expect(index.revision).toBe(0);
    expect(() => capture.applyTo(target)).toThrow("Search index reset during rebuild");
    capture.stop();
  });

  it("reads v2 snapshots and preserves their posting order and scores in compact snapshots", () => {
    const legacy = JSON.stringify({
      v: 2,
      entries: [
        ["a", { obsId: "a", sessionId: "first", termCount: 2 }],
        ["b", { obsId: "b", sessionId: "second", termCount: 2 }],
      ],
      inverted: [["auth", ["b", "a"]], ["작업한", ["a", "b"]]],
      docTerms: [["b", [["작업한", 1], ["auth", 1]]], ["a", [["auth", 1], ["작업한", 1]]]],
      totalDocLength: 4,
    });
    const original = SearchIndex.deserialize(legacy);
    const compact = original.serialize();
    const restored = SearchIndex.deserialize(compact);
    expect(restored.size).toBe(2);
    for (const query of ["auth", "작업", "auth 작업"]) {
      expect(restored.search(query)).toEqual(original.search(query));
    }
    expect(restored.search("auth").map(row => row.obsId)).toEqual(["b", "a"]);
    expect(restored.serialize()).toBe(compact);
    restored.remove("b");
    expect(restored.search("auth").map(row => row.obsId)).toEqual(["a"]);
  });

  it.each(["postings", "docTerms"])("rejects invalid compact %s references without exposing a partial index", field => {
    index.add(makeObs());
    const snapshot = JSON.parse(index.serialize());
    if (field === "postings") snapshot.postings[0][0] = snapshot.documents.length;
    else snapshot.docTerms[0][1][0][0] = snapshot.terms.length;
    const restored = SearchIndex.deserialize(JSON.stringify(snapshot));
    expect(restored.size).toBe(0);
    expect(restored.search("auth")).toEqual([]);
  });

  it("adds and finds observations", () => {
    index.add(makeObs());
    expect(index.size).toBe(1);
    const results = index.search("auth");
    expect(results.length).toBe(1);
    expect(results[0].obsId).toBe("obs_1");
  });

  it("returns empty for no matches", () => {
    index.add(makeObs());
    expect(index.search("database")).toEqual([]);
  });

  it("finds escaped Markdown identifiers using their displayed spelling", () => {
    for (const [id, narrative] of [
      ["escaped", "qwen\\_only"],
      ["escaped-code", "\\`qwen\\_only\\`"],
      ["plain", "qwen_only"],
    ]) {
      index.add(makeObs({ id, title: "", subtitle: "", facts: [], concepts: [], files: [], narrative }));
    }
    expect(index.search("qwen_only").map(row => row.obsId).sort()).toEqual(["escaped", "escaped-code", "plain"]);
    expect(index.search("qwen\\_only").map(row => row.obsId).sort()).toEqual(["escaped", "escaped-code", "plain"]);
    expect(SearchIndex.deserialize(index.serialize()).search("qwen_only")).toHaveLength(3);
  });

  it("keeps drive, UNC and relative Windows underscore path queries searchable", () => {
    for (const [id, narrative] of [
      ["drive", String.raw`D:\_private\qwen_only`],
      ["drive-root", String.raw`D:\_private`],
      ["unc", String.raw`\\server\_private`],
      ["relative", String.raw`folder\_private`],
    ]) {
      index.add(makeObs({ id, title: "", subtitle: "", facts: [], concepts: [], files: [], narrative }));
      expect(index.search(narrative).map(row => row.obsId)).toContain(id);
    }
    expect(index.search("server_private")).toEqual([]);
    expect(index.search("_private")).toEqual([]);
  });

  it("keeps scores stable when the same canonical observations are indexed again", () => {
    const observations = [makeObs(), makeObs({ id: "obs_2", narrative: "auth ".repeat(40) })];
    for (const observation of observations) index.add(observation);
    const before = index.search("auth");
    for (let retry = 0; retry < 4; retry++) for (const observation of observations) index.add(observation);
    expect(index.size).toBe(2);
    expect(index.search("auth")).toEqual(before);
  });


  it("preserves snapshot and tie order for an unchanged reindexed subset", () => {
    const observations = [makeObs(), makeObs({ id: "obs_2" }), makeObs({ id: "obs_3" })];
    for (const observation of observations) index.add(observation);
    const snapshot = index.serialize(), ranking = index.search("auth");
    index.add({ ...observations[0], timestamp: "2026-09-16T00:00:00Z", importance: 9 });
    expect(index.serialize()).toBe(snapshot);
    expect(index.search("auth")).toEqual(ranking);
    index.add({ ...observations[0], sessionId: "changed-owner" });
    expect(index.search("auth").find(row => row.obsId === "obs_1")?.sessionId).toBe("changed-owner");
    expect(index.serialize()).not.toBe(snapshot);
  });

  it("replaces postings and session ownership when an indexed record changes", () => {
    const original = makeObs({ title: "uniquestale", narrative: "uniquestale", subtitle: "", concepts: [], facts: [], files: [] });
    index.add(original);
    index.add({ ...original, sessionId: "new-session", title: "uniquecurrent", narrative: "uniquecurrent" });
    expect(index.size).toBe(1);
    expect(index.search("uniquestale")).toEqual([]);
    expect(index.search("uniquecurrent")).toMatchObject([{ obsId: original.id, sessionId: "new-session" }]);
    index.remove(original.id);
    expect(index.size).toBe(0);
    expect(index.search("uniquecurrent")).toEqual([]);
  });

  it("scores exact matches higher than prefix matches", () => {
    index.add(
      makeObs({
        id: "obs_exact",
        title: "redis cache",
        narrative: "Set up redis caching layer",
        concepts: ["redis"],
        facts: ["Added redis"],
        files: ["src/redis.ts"],
      }),
    );
    index.add(
      makeObs({
        id: "obs_prefix",
        title: "redistool handler",
        narrative: "Set up redistool for ops",
        concepts: ["redistool"],
        facts: ["Added redistool"],
        files: ["src/redistool.ts"],
      }),
    );
    const results = index.search("redis");
    const exact = results.find((r) => r.obsId === "obs_exact");
    const prefix = results.find((r) => r.obsId === "obs_prefix");
    expect(exact).toBeDefined();
    expect(prefix).toBeDefined();
    expect(exact!.score).toBeGreaterThanOrEqual(prefix!.score);
  });


  it("bounds distinct prefix variants while accumulating different query terms", () => {
    const clean = { title: "", subtitle: "", facts: [], concepts: [], files: [], type: "other" as const };
    const suffixes = Array.from("가나다라마바사아자차카타파하");
    const variants = suffixes.flatMap(suffix => ["작업" + suffix, "추론" + suffix]);
    index.add(makeObs({ ...clean, id: "exact", narrative: "작업 추론" }));
    index.add(makeObs({ ...clean, id: "variants", narrative: variants.join(" ") + " 작업하 작업하" }));

    expect(index.search("작업", 1)[0].obsId).toBe("exact");
    expect(index.search("작업 추론", 1)[0].obsId).toBe("exact");
    const variantScore = (query: string) => index.search(query).find(row => row.obsId === "variants")!.score;
    expect(variantScore("작업")).toBeCloseTo(variantScore("작업하") * 0.5, 12);
    index.add(makeObs({ ...clean, id: "one-term", narrative: "작업" }));
    const combined = index.search("작업 추론").map(row => row.obsId);
    expect(combined.indexOf("variants")).toBeLessThan(combined.indexOf("one-term"));
    expect(SearchIndex.deserialize(index.serialize()).search("작업 추론")).toEqual(index.search("작업 추론"));
  });

  it("does not add prefix variants to a document with an exact query term", () => {
    const clean = { title: "", subtitle: "", facts: [], concepts: [], files: [], type: "other" as const };
    const variants = Array.from("가나다라마바사아자차카타파하", suffix => "작업" + suffix);
    index.add(makeObs({ ...clean, id: "with-variants", narrative: "작업 " + variants.join(" ") }));
    index.add(makeObs({ ...clean, id: "exact-only", narrative: "작업 " + Array(variants.length).fill("무관").join(" ") }));
    const results = index.search("작업");
    expect(results).toHaveLength(2);
    expect(results.find(row => row.obsId === "with-variants")!.score).toBeCloseTo(
      results.find(row => row.obsId === "exact-only")!.score, 12,
    );
  });

  it("matches numeric query terms exactly while retaining word prefixes", () => {
    const clean = { title: "", subtitle: "", facts: [], concepts: [], files: [] };
    index.add(makeObs({ ...clean, id: "ordinal", narrative: "2차 MVP" }));
    index.add(makeObs({ ...clean, id: "number", narrative: "20" }));
    index.add(makeObs({ ...clean, id: "dates", narrative: "2026.01 2026.02 2026.03 2026.04" }));
    index.add(makeObs({ ...clean, id: "word", narrative: "redistool" }));
    expect(index.search("20").map(row => row.obsId)).toEqual(["number"]);
    expect(index.search("2차").map(row => row.obsId)).toEqual(["ordinal"]);
    expect(index.search("redis").map(row => row.obsId)).toEqual(["word"]);
    expect(SearchIndex.deserialize(index.serialize()).search("2차").map(row => row.obsId)).toEqual(["ordinal"]);
  });

  it("respects limit", () => {
    for (let i = 0; i < 30; i++) {
      index.add(makeObs({ id: `obs_${i}`, title: `auth feature ${i}` }));
    }
    expect(index.search("auth", 5).length).toBe(5);
  });

  it("clears the index", () => {
    index.add(makeObs());
    index.clear();
    expect(index.size).toBe(0);
    expect(index.search("auth")).toEqual([]);
  });

  // Regression coverage: deleted docs must not keep occupying result
  // slots after remove(). Without remove(), a limit-capped search can
  // return fewer live results than requested because the slot is held
  // by a doc that no longer exists in storage.
  describe("remove", () => {
    it("drops a removed doc from search results", () => {
      index.add(makeObs({ id: "obs_a", title: "jose for JWT" }));
      index.add(
        makeObs({ id: "obs_b", title: "JWT tokens expire after 30 minutes" }),
      );
      expect(index.search("jose jwt", 1)[0].obsId).toBe("obs_a");

      index.remove("obs_a");

      // With limit=1, the survivor must now surface instead of getting
      // masked by the deleted doc's slot.
      const after = index.search("jose jwt", 1);
      expect(after).toHaveLength(1);
      expect(after[0].obsId).toBe("obs_b");
      expect(index.size).toBe(1);
    });

    it("is a no-op for unknown ids", () => {
      index.add(makeObs({ id: "obs_a" }));
      expect(() => index.remove("does_not_exist")).not.toThrow();
      expect(index.size).toBe(1);
      expect(index.search("auth")).toHaveLength(1);
    });

    it("cleans up empty posting lists and the prefix cache", () => {
      // unique_concept_xyz appears only in obs_a. After removing obs_a,
      // a prefix search for "unique_" must NOT surface it from the
      // sortedTerms cache.
      index.add(
        makeObs({
          id: "obs_a",
          concepts: ["unique_concept_xyz"],
        }),
      );
      index.add(makeObs({ id: "obs_b", title: "completely different" }));
      // Prime the sortedTerms cache.
      expect(index.search("unique_")).toHaveLength(1);

      index.remove("obs_a");

      expect(index.search("unique_concept_xyz")).toEqual([]);
      expect(index.search("unique_")).toEqual([]);
    });

    it("keeps scoring consistent after add/remove/add cycles", () => {
      // totalDocLength bookkeeping desync would skew BM25 normalization
      // (docLen / avgDocLen). Round-trip add → remove → re-add and
      // confirm size + retrievability hold.
      const obs = makeObs({ id: "obs_a" });
      index.add(obs);
      expect(index.size).toBe(1);
      index.remove("obs_a");
      expect(index.size).toBe(0);
      index.add(obs);
      expect(index.size).toBe(1);
      expect(index.search("auth")[0].obsId).toBe("obs_a");
    });

    it("survives serialize/deserialize after removes", () => {
      index.add(makeObs({ id: "obs_a", title: "alpha doc" }));
      index.add(makeObs({ id: "obs_b", title: "beta doc" }));
      index.remove("obs_a");

      const restored = SearchIndex.deserialize(index.serialize());
      expect(restored.size).toBe(1);
      expect(restored.search("alpha")).toEqual([]);
      expect(restored.search("beta")).toHaveLength(1);
    });
  });

  it("returns empty for empty query", () => {
    index.add(makeObs());
    expect(index.search("")).toEqual([]);
  });

  it("searches across multiple fields", () => {
    index.add(
      makeObs({ id: "obs_file", title: "something", files: ["auth.ts"] }),
    );
    expect(index.search("auth").length).toBe(1);
  });

  it("handles multiple query terms", () => {
    index.add(
      makeObs({
        id: "obs_both",
        title: "redis cache",
        narrative: "Set up redis and cache layer",
        concepts: ["redis", "cache"],
        facts: ["Added caching"],
        files: ["src/cache.ts"],
      }),
    );
    index.add(
      makeObs({
        id: "obs_one",
        title: "redis only",
        narrative: "Set up redis connection",
        concepts: ["redis"],
        facts: ["Added redis"],
        files: ["src/redis.ts"],
      }),
    );
    const results = index.search("redis cache");
    expect(results[0].obsId).toBe("obs_both");
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it("indexes and finds non-ASCII (Greek) text", () => {
    index.add(
      makeObs({
        id: "obs_greek",
        title: "Προβολή μνήμης",
        narrative: "Δοκιμάζουμε αναζήτηση σε ελληνικά",
        concepts: ["δοκιμή", "μνήμη"],
      }),
    );
    const results = index.search("μνήμη");
    expect(results.length).toBe(1);
    expect(results[0].obsId).toBe("obs_greek");
  });

  it("tokenizes mixed ASCII and non-ASCII (Greek) queries", () => {
    index.add(
      makeObs({
        id: "obs_mixed",
        title: "JWT middleware ρύθμιση",
        narrative: "Configured JWT with ελληνικά σχόλια",
        concepts: ["auth", "jwt", "ρύθμιση"],
      }),
    );
    const results = index.search("JWT ρύθμιση");
    expect(results.length).toBe(1);
    expect(results[0].obsId).toBe("obs_mixed");
  });

  it("segments Chinese (Han) text into words", () => {
    index.add(
      makeObs({
        id: "obs_zh",
        title: "项目记忆存储",
        narrative: "我们正在测试中文分词",
        concepts: ["项目", "记忆"],
      }),
    );
    const results = index.search("项目");
    expect(results.length).toBeGreaterThan(0);
    const hit = results.find((r) => r.obsId === "obs_zh");
    expect(hit).toBeDefined();
    expect(hit!.score).toBeGreaterThan(0);
  });

  it("segments Japanese (kana + kanji) text into words", () => {
    index.add(
      makeObs({
        id: "obs_ja",
        title: "プロジェクト記憶",
        narrative: "日本語の分かち書きをテストしています",
        concepts: ["プロジェクト", "記憶"],
      }),
    );
    const results = index.search("プロジェクト");
    expect(results.length).toBeGreaterThan(0);
    const hit = results.find((r) => r.obsId === "obs_ja");
    expect(hit).toBeDefined();
    expect(hit!.score).toBeGreaterThan(0);
  });

  it("segments Korean (Hangul) syllable blocks into words", () => {
    index.add(
      makeObs({
        id: "obs_ko",
        title: "프로젝트 메모리 저장소",
        narrative: "한국어 검색을 테스트합니다",
        concepts: ["프로젝트", "메모리"],
      }),
    );
    const results = index.search("메모리");
    expect(results.length).toBeGreaterThan(0);
    const hit = results.find((r) => r.obsId === "obs_ko");
    expect(hit).toBeDefined();
    expect(hit!.score).toBeGreaterThan(0);
  });

  it("retrieves Korean inflections through shared syllable bigrams without replacing exact words", () => {
    const clean = { title: "", subtitle: "", facts: [], concepts: [], files: [], type: "other" as const };
    index.add(makeObs({ ...clean, id: "inflected", narrative: "추론모델은 어떤 일에 적합하지" }));
    index.add(makeObs({ ...clean, id: "exact", narrative: "추론모델 적합한 작업" }));
    index.add(makeObs({ ...clean, id: "unrelated", narrative: "불합리한 모델의 수정 작업" }));
    const results = index.search("적합한");
    expect(results.map(row => row.obsId)).toEqual(["exact", "inflected"]);
    expect(index.search("론모델").map(row => row.obsId)).toContain("inflected");
    expect(index.search("리")).toEqual([]);
  });

  it("does not reward a rare prefix variant over the original search word", () => {
    const clean = { title: "", subtitle: "", facts: [], concepts: [], files: [], type: "other" as const };
    for (let i = 0; i < 12; i++) index.add(makeObs({ ...clean, id: "exact-" + i, narrative: "release" }));
    index.add(makeObs({ ...clean, id: "variant", narrative: "releaseVariant" }));
    expect(index.search("release")[0].obsId).not.toBe("variant");
  });

  it("combines Korean word and syllable evidence without rewriting stored terms", () => {
    const clean = { title: "", subtitle: "", facts: [], concepts: [], files: [], type: "other" as const };
    index.add(makeObs({ ...clean, id: "target", narrative: "추론모델은 뭘할때 적합하지" }));
    for (let i = 0; i < 200; i++) index.add(makeObs({ ...clean, id: "other-" + i, narrative: "추론모델 작업" }));
    const snapshot = index.serialize();
    expect(index.search("추론모델 적합한 작업", 100).map(row => row.obsId)).toContain("target");
    expect(index.serialize()).toBe(snapshot);
    index.add(makeObs({ ...clean, id: "target", narrative: "다른 내용" }));
    expect(index.search("추론모델 적합한 작업", 100).map(row => row.obsId)).not.toContain("target");
    const restored = SearchIndex.deserialize(snapshot);
    expect(restored.search("추론모델 적합한 작업", 100).map(row => row.obsId)).toContain("target");
    restored.remove("target");
    expect(restored.search("추론모델 적합한 작업", 100).map(row => row.obsId)).not.toContain("target");
  });

  it("derives Korean matches from old snapshots and refreshes them after replacement, removal and rebuild", () => {
    const clean = { title: "", subtitle: "", facts: [], concepts: [], files: [] };
    index.add(makeObs({ ...clean, id: "old", narrative: "적합하지" }));
    const serialized = index.serialize();
    const restored = SearchIndex.deserialize(serialized);
    expect(restored.search("적합한").map(row => row.obsId)).toEqual(["old"]);
    expect(restored.serialize()).toBe(serialized);
    restored.add(makeObs({ ...clean, id: "old", narrative: "진행되었습니다" }));
    expect(restored.search("적합한")).toEqual([]);
    expect(restored.search("진행한").map(row => row.obsId)).toEqual(["old"]);
    restored.remove("old");
    expect(restored.search("진행한")).toEqual([]);
    restored.restoreFrom(index);
    expect(restored.search("적합한").map(row => row.obsId)).toEqual(["old"]);
    restored.clear();
    expect(restored.search("적합한")).toEqual([]);
  });

  it("keeps a long exact Korean result above a short bigram-only result", () => {
    const clean = { title: "", subtitle: "", facts: [], concepts: [], files: [], type: "other" as const };
    index.add(makeObs({ ...clean, id: "exact", narrative: "적합한 진행한 검색한 " + "unrelated ".repeat(100) }));
    index.add(makeObs({ ...clean, id: "partial", narrative: "적합하지 진행하지 검색하지" }));
    for (let i = 0; i < 100; i++) index.add(makeObs({ ...clean, id: `noise${i}`, narrative: "무관한 내용" }));
    expect(index.search("적합한", 1)[0].obsId).toBe("exact");
    expect(index.search("적합한 진행한 검색한", 1)[0].obsId).toBe("exact");
  });

  it("preserves source order across mixed CJK and non-CJK runs", () => {
    expect(segmentCjk("hello 项目 world")).toEqual(["hello", "项目", "world"]);
    expect(segmentCjk("abc 메모리 def 项目 ghi")).toEqual([
      "abc",
      "메모리",
      "def",
      "项目",
      "ghi",
    ]);
    expect(segmentCjk("leading 项目")).toEqual(["leading", "项目"]);
    expect(segmentCjk("项目 trailing")).toEqual(["项目", "trailing"]);
  });
  it("keeps warmed Korean ranks identical to a fresh snapshot across index changes", () => {
    const query = "추론모델 적합한 작업";
    const a = makeObs({ id: "a", narrative: "추론모델은 적합하지" });
    const b = makeObs({ id: "b", narrative: "추론모델 작업" });
    index.add(a);
    index.add(b);
    const target = SearchIndex.deserialize(index.serialize());
    const capture = index.captureChanges();
    target.search(query);
    index.search(query);
    const verify = () => expect(index.search(query)).toEqual(SearchIndex.deserialize(index.serialize()).search(query));
    index.add(makeObs({ id: "a", narrative: "다른 작업을 검토한" }));
    verify();
    index.remove("b");
    index.add(makeObs({ id: "c", narrative: "추론모델 적합한 작업" }));
    verify();
    capture.applyTo(target);
    expect(target.search(query)).toEqual(index.search(query));
    capture.stop();
    target.restoreFrom(SearchIndex.deserialize(index.serialize()));
    expect(target.search(query)).toEqual(index.search(query));
  });

});
