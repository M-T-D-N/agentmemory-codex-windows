import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockKV } from "./helpers/mocks.js";
import { getSearchIndex, indexRecords, rebuildIndex, setEmbeddingProvider, setIndexPersistence, setVectorIndex, vectorIndexAddGuarded } from "../src/functions/search.js";
import { IndexPersistence } from "../src/state/index-persistence.js";
import { VectorIndex } from "../src/state/vector-index.js";
import type { CompressedObservation } from "../src/types.js";

vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const obs: CompressedObservation = { id: "live", sessionId: "session", timestamp: "2026-09-30T00:00:00Z", type: "other", title: "checkpoint", narrative: "original text", facts: [], concepts: [], files: [], importance: 5 };

describe("live index checkpoint scheduling", () => {
  let persistence: IndexPersistence;
  beforeEach(() => {
    vi.useFakeTimers(); getSearchIndex().clear(); setVectorIndex(null); setEmbeddingProvider(null);
    persistence = new IndexPersistence(mockKV() as never, getSearchIndex(), null);
    setIndexPersistence(persistence);
  });
  afterEach(() => {
    persistence.stop(); setIndexPersistence(null); setVectorIndex(null); setEmbeddingProvider(null); getSearchIndex().clear(); vi.useRealTimers();
  });

  it.each(["no-vector", "offline", "success"])("persists added BM25 records with %s embedding", async (mode) => {
    const vector = mode === "no-vector" ? null : new VectorIndex(); setVectorIndex(vector);
    persistence = new IndexPersistence(mockKV() as never, getSearchIndex(), vector); setIndexPersistence(persistence);
    if (vector) setEmbeddingProvider({ name: "test", dimensions: 2,
      embed: async () => { if (mode === "offline") throw Error("offline"); return new Float32Array([1,0]); },
      embedBatch: async (texts) => { if (mode === "offline") throw Error("offline"); return texts.map(() => new Float32Array([1,0])); } });
    expect(await indexRecords([obs], [])).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    const restored = await persistence.load();
    expect(restored.bm25?.search("checkpoint")[0]?.obsId).toBe("live");
    if (mode === "success") expect(restored.vector?.search(new Float32Array([1,0]))[0]?.obsId).toBe("live");
  });

  it("does not checkpoint an unfinished bulk rebuild", async () => {
    const kv = mockKV(); const vector = new VectorIndex(); setVectorIndex(vector);
    persistence = new IndexPersistence(kv as never, getSearchIndex(), vector); setIndexPersistence(persistence);
    for (let i = 0; i < 11; i++) {
      await kv.set("mem:sessions", `session_${i}`, { id: `session_${i}`, project: "test" });
      await kv.set(`mem:obs:session_${i}`, `obs_${i}`, { ...obs, id: `obs_${i}`, sessionId: `session_${i}` });
    }
    let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void; const secondBatch = new Promise<void>(resolve => { entered = resolve; });
    let calls = 0;
    setEmbeddingProvider({ name: "test", dimensions: 2, embed: async () => new Float32Array([1,0]),
      embedBatch: async (texts) => { if (++calls === 2) { entered(); await blocked; } return texts.map(() => new Float32Array([1,0])); } });
    const rebuilding = rebuildIndex(kv as never);
    await secondBatch;
    await vi.advanceTimersByTimeAsync(5000);
    expect((await persistence.load()).bm25).toBeNull();
    release(); expect(await rebuilding).toBe(11);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await persistence.load()).bm25?.size).toBe(11);
  });

  it("checkpoints a late single-vector add independently of the prior BM25 save", async () => {
    const vector = new VectorIndex(); setVectorIndex(vector);
    persistence = new IndexPersistence(mockKV() as never, getSearchIndex(), vector); setIndexPersistence(persistence);
    setEmbeddingProvider({ name: "test", dimensions: 2, embed: async () => new Float32Array([1,0]), embedBatch: async () => [] });
    expect(await vectorIndexAddGuarded("late", "session", "text", { kind: "observation", logId: "late" })).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await persistence.load()).vector?.search(new Float32Array([1,0]))[0]?.obsId).toBe("late");
  });
});
