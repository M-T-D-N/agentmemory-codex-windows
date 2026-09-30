import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockKV } from "./helpers/mocks.js";
import { getSearchIndex, rebuildIndex, isMemoryIndexReady, setEmbeddingProvider, setIndexPersistence, setVectorIndex } from "../src/functions/search.js";
import { IndexPersistence } from "../src/state/index-persistence.js";
import { VectorIndex } from "../src/state/vector-index.js";
import { KV } from "../src/state/schema.js";
import type { CompressedObservation } from "../src/types.js";
vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const row = (id: string): CompressedObservation => ({ id, sessionId: "s", timestamp: "2026-10-01T00:00:00Z", type: "other", title: id, narrative: `evidence ${id}`, facts: [], concepts: [], files: [], importance: 5 });
const barrier = () => { let resolve!: () => void; const promise = new Promise<void>(ok => { resolve = ok; }); return { promise, resolve }; };
describe("complete search index publication", () => {
  beforeEach(() => { getSearchIndex().clear(); setEmbeddingProvider(null); setVectorIndex(null); });
  afterEach(() => { setIndexPersistence(null); setVectorIndex(null); setEmbeddingProvider(null); getSearchIndex().clear(); vi.useRealTimers(); });
  it.each([KV.memories, KV.sessions, KV.observations("s")])("keeps the previous searchable generation on %s read failure", async scope => {
    const kv = mockKV(); await kv.set(KV.sessions, "s", { id: "s" });
    getSearchIndex().add(row("previous"));
    const list = kv.list.bind(kv); kv.list = vi.fn(async name => { if (name === scope) throw Error("read outage"); return list(name); });
    const persistence = { scheduleSave: vi.fn(), save: vi.fn() }; setIndexPersistence(persistence);
    await expect(rebuildIndex(kv as never)).rejects.toThrow("read outage");
    expect(getSearchIndex().search("previous")[0]?.obsId).toBe("previous");
    expect(persistence.scheduleSave).not.toHaveBeenCalled();
  });
  it("keeps an already-reserved checkpoint on the previous generation while rebuilding", async () => {
    vi.useFakeTimers(); const kv = mockKV(); const wait = barrier(), entered = barrier();
    await kv.set(KV.sessions, "s", { id: "s" }); await kv.set(KV.observations("s"), "new", row("new"));
    const list = kv.list.bind(kv); kv.list = vi.fn(async scope => { if (scope === KV.observations("s")) { entered.resolve(); await wait.promise; } return list(scope); });
    getSearchIndex().add(row("previous")); const persistence = new IndexPersistence(kv as never, getSearchIndex(), null); setIndexPersistence(persistence);
    persistence.scheduleSave(); const rebuilding = rebuildIndex(kv as never); await entered.promise;
    await vi.advanceTimersByTimeAsync(5000);
    expect((await persistence.load()).bm25?.search("previous")[0]?.obsId).toBe("previous");
    wait.resolve(); await rebuilding; await vi.advanceTimersByTimeAsync(5000);
    expect((await persistence.load()).bm25?.search("new")[0]?.obsId).toBe("new"); persistence.stop();
  });
  it("preserves concurrent additions and removals, including deletion absent from the live snapshot", async () => {
    const kv = mockKV(), wait = barrier(), entered = barrier(); const vector = new VectorIndex(); setVectorIndex(vector);
    await kv.set(KV.sessions, "s", { id: "s" }); for (const id of ["old", "canonical-only"]) await kv.set(KV.observations("s"), id, row(id));
    getSearchIndex().add(row("old")); vector.add("old", "s", new Float32Array([1, 0]));
    const list = kv.list.bind(kv); kv.list = vi.fn(async scope => { if (scope === KV.observations("s")) { const rows = await list(scope); entered.resolve(); await wait.promise; return rows; } return list(scope); });
    const rebuilding = rebuildIndex(kv as never, { reuseVectors: true }); await entered.promise;
    getSearchIndex().remove("old"); getSearchIndex().remove("canonical-only"); vector.remove("old");
    getSearchIndex().add(row("concurrent")); vector.add("concurrent", "s", new Float32Array([1, 0]));
    wait.resolve(); await rebuilding;
    expect(getSearchIndex().has("old")).toBe(false); expect(getSearchIndex().has("canonical-only")).toBe(false);
    expect(getSearchIndex().search("concurrent")[0]?.obsId).toBe("concurrent");
    expect(vector.search(new Float32Array([1, 0])).map(x => x.obsId)).toEqual(["concurrent"]);
  });
  it("reconciles a nonempty persisted generation without re-embedding and marks it ready", async () => {
    const kv = mockKV(), vector = new VectorIndex(); setVectorIndex(vector);
    const provider = { name: "test", dimensions: 2, embed: vi.fn(), embedBatch: vi.fn() }; setEmbeddingProvider(provider);
    getSearchIndex().add(row("stale")); vector.add("stale", "s", new Float32Array([1, 0])); vector.add("canonical", "s", new Float32Array([0, 1]));
    await kv.set(KV.sessions, "s", { id: "s" }); await kv.set(KV.observations("s"), "canonical", row("canonical"));
    await rebuildIndex(kv as never, { reuseVectors: true });
    expect(getSearchIndex().has("stale")).toBe(false); expect(getSearchIndex().has("canonical")).toBe(true);
    expect(isMemoryIndexReady()).toBe(true); expect(provider.embedBatch).not.toHaveBeenCalled();
    expect(vector.search(new Float32Array([0, 1])).map(x => x.obsId)).toEqual(["canonical"]);
  });
  it("does not publish a cancelled boot candidate", async () => {
    const kv = mockKV(), wait = barrier(), entered = barrier(), controller = new AbortController(); const list = kv.list.bind(kv);
    getSearchIndex().add(row("previous")); kv.list = vi.fn(async scope => { if (scope === KV.memories) { entered.resolve(); await wait.promise; } return list(scope); });
    const pending = rebuildIndex(kv as never, { signal: controller.signal }); await entered.promise; controller.abort(); wait.resolve();
    await expect(pending).rejects.toThrow(); expect(getSearchIndex().has("previous")).toBe(true);
  });
  it("does not preserve a late vector for a concurrently deleted canonical row", async () => {
    const kv = mockKV(), wait = barrier(), entered = barrier(), vector = new VectorIndex(); setVectorIndex(vector); const list = kv.list.bind(kv);
    await kv.set(KV.sessions, "s", { id: "s" }); await kv.set(KV.observations("s"), "removed", row("removed"));
    kv.list = vi.fn(async scope => { if (scope === KV.observations("s")) { const result = await list(scope); entered.resolve(); await wait.promise; return result; } return list(scope); });
    const pending = rebuildIndex(kv as never, { reuseVectors: true }); await entered.promise; getSearchIndex().remove("removed");
    vector.add("removed", "s", new Float32Array([1, 0])); wait.resolve(); await pending;
    expect(vector.size).toBe(0); expect(getSearchIndex().has("removed")).toBe(false);
  });
  it("shares boot and request rebuilds and refuses a concurrent reset", async () => {
    const kv = mockKV(), wait = barrier(), entered = barrier(); const list = kv.list.bind(kv);
    kv.list = vi.fn(async scope => { if (scope === KV.memories) { entered.resolve(); await wait.promise; } return list(scope); });
    const first = rebuildIndex(kv as never); await entered.promise; const second = rebuildIndex(kv as never);
    expect(second).toBe(first); getSearchIndex().clear(); getSearchIndex().add(row("reset")); wait.resolve();
    await expect(first).rejects.toThrow("reset during rebuild"); expect(getSearchIndex().has("reset")).toBe(true);
  });
});
