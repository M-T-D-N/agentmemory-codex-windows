import { describe, expect, it, vi } from "vitest";
import { mockKV, mockSdk } from "./helpers/mocks.js";
import { KV } from "../src/state/schema.js";
import { registerArchiveFunctions } from "../src/functions/archive-tools.js";
import { registerAutoForgetFunction } from "../src/functions/auto-forget.js";
import { registerEvictFunction } from "../src/functions/evict.js";
import { registerRetentionFunctions } from "../src/functions/retention.js";
import { registerLessonsFunctions } from "../src/functions/lessons.js";

vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
async function fixture() {
  const kv = Object.assign(mockKV(), { hasObservationRecovery: () => false });
  const sdk = mockSdk({ looseTrigger: true });
  registerArchiveFunctions(sdk as never, kv as never);
  registerAutoForgetFunction(sdk as never, kv as never);
  registerEvictFunction(sdk as never, kv as never);
  registerRetentionFunctions(sdk as never, kv as never);
  registerLessonsFunctions(sdk as never, kv as never);
  const call = (id: string, data: object = {}) => sdk.trigger(id, data) as Promise<any>;
  const archive = async (kind: string, id: string, action = "archive", sessionId?: string) => {
    const target = { kind, id, ...(sessionId ? { sessionId } : {}) };
    const preview = await call("mem::archive", { project: "p", target, action });
    return call("mem::archive", { project: "p", target, action, dryRun: false,
      expectedRevision: preview.expectedRevision, expectedDigest: preview.expectedDigest, reason: "Reviewed decision" });
  };
  for (const id of ["s", "unprotected"]) {
    await kv.set(KV.sessions, id, { id, project: "p", startedAt: "2020-01-01T00:00:00.000Z", observationCount: 1 });
    await kv.set(KV.observations(id), "obs-" + id, { id: "obs-" + id, sessionId: id, title: "old observation",
      content: "original evidence", importance: 1, timestamp: "2020-01-01T00:00:00.000Z" });
  }
  const memory = { project: "p", content: "original decision", concepts: [], isLatest: true, type: "fact", createdAt: "2020-01-01T00:00:00.000Z",
    forgetAfter: "2020-02-01T00:00:00.000Z", sessionIds: ["s"] };
  await kv.set(KV.memories, "kept", { ...memory, id: "kept" });
  await kv.set(KV.memories, "expired", { ...memory, id: "expired", sessionIds: [] });
  await archive("memory", "kept");
  return { kv, call, archive };
}

describe("archive lifecycle protection from automatic cleanup", () => {
  it("keeps archived TTL originals and their source session while ordinary unprotected cleanup still runs", async () => {
    const f = await fixture();
    const original = structuredClone(await f.kv.get(KV.memories, "kept"));
    expect(await f.call("mem::auto-forget", { dryRun: true })).toMatchObject({ ttlExpired: ["expired"], lowValueObs: ["obs-unprotected"] });
    await f.call("mem::auto-forget", { dryRun: false });
    expect(await f.kv.get(KV.memories, "kept")).toEqual(original);
    expect(await f.kv.get(KV.observations("s"), "obs-s")).not.toBeNull();
    expect(await f.kv.get(KV.memories, "expired")).toBeNull();
    expect(await f.kv.get(KV.observations("unprotected"), "obs-unprotected")).toBeNull();
  });
  it("keeps a restored manual decision protected from automatic expiry", async () => {
    const f = await fixture(); await f.archive("memory", "kept", "restore");
    const original = structuredClone(await f.kv.get(KV.memories, "kept"));
    await f.call("mem::auto-forget", {});
    expect(await f.kv.get(KV.memories, "kept")).toEqual(original);
    expect(await f.call("mem::archive", { project: "p", target: { kind: "memory", id: "kept" } })).toMatchObject({ state: "restored" });
  });
  it("protects archived observations' parents from stale-session, age and capacity eviction", async () => {
    const f = await fixture(); await f.archive("observation", "obs-unprotected", "archive", "unprotected");
    await f.kv.set(KV.config, "eviction", { staleSessionDays: 1, lowImportanceMaxDays: 1, lowImportanceThreshold: 10, maxObservationsPerProject: 0 });
    const sessions = structuredClone(await f.kv.list(KV.sessions));
    expect(await f.call("mem::evict", { dryRun: true })).toMatchObject({ staleSessions: 0, lowImportanceObs: 0, capEvictions: 0, expiredMemories: 1 });
    await f.call("mem::evict", {});
    expect(await f.kv.list(KV.sessions)).toEqual(sessions);
    expect(await f.kv.get(KV.observations("unprotected"), "obs-unprotected")).not.toBeNull();
    expect(await f.kv.get(KV.memories, "expired")).toBeNull();
  });
  it("filters retention protection before maxEvict, including legacy rows with no source tag", async () => {
    const f = await fixture();
    await f.kv.set(KV.semantic, "semantic", { id: "semantic", sourceSessionIds: ["s"], createdAt: "2020-01-01T00:00:00.000Z", confidence: 0.5, accessCount: 0 });
    await f.archive("semantic", "semantic");
    for (const [id, score, source] of [["kept", 0, "episodic"], ["semantic", 0.01, undefined], ["expired", 0.02, "episodic"]]) {
      await f.kv.set(KV.retentionScores, String(id), { memoryId: id, score, ...(source ? { source } : {}) });
    }
    expect(await f.call("mem::retention-evict", { dryRun: true, maxEvict: 1 })).toMatchObject({ wouldEvict: 1, candidates: [{ id: "expired" }] });
    expect(await f.call("mem::retention-evict", { maxEvict: 1 })).toMatchObject({ evicted: 1 });
    expect(await f.kv.get(KV.memories, "kept")).not.toBeNull();
    expect(await f.kv.get(KV.semantic, "semantic")).not.toBeNull();
  });
  it("does not decay or soft-delete archived lessons", async () => {
    const f = await fixture();
    for (const id of ["archived-lesson", "old-lesson"]) await f.kv.set(KV.lessons, id,
      { id, project: "p", content: "lesson evidence", confidence: 0.2, decayRate: 0.05, reinforcements: 0, createdAt: "2020-01-01T00:00:00.000Z" });
    await f.archive("lesson", "archived-lesson");
    const original = structuredClone(await f.kv.get(KV.lessons, "archived-lesson"));
    await f.call("mem::lesson-decay-sweep");
    expect(await f.kv.get(KV.lessons, "archived-lesson")).toEqual(original);
    expect(await f.kv.get(KV.lessons, "old-lesson")).toMatchObject({ deleted: true });
  });
  it("does not let an archive decision race a retention sweep after selection starts", async () => {
    const f = await fixture();
    let entered!: () => void, release!: () => void;
    const selected = new Promise<void>(resolve => { entered = resolve; });
    const pause = new Promise<void>(resolve => { release = resolve; });
    const list = f.kv.list.bind(f.kv);
    vi.spyOn(f.kv, "list").mockImplementation(async scope => {
      if (scope === KV.retentionScores) { entered(); await pause; }
      return list(scope);
    });
    const sweep = f.call("mem::retention-evict", { dryRun: true });
    await selected;
    try {
      await expect(f.call("mem::archive", { action: "archive", project: "p", target: { kind: "memory", id: "expired" } })).rejects.toThrow("writers are active");
    } finally { release(); }
    await sweep;
    expect(await f.call("mem::archive", { action: "archive", project: "p", target: { kind: "memory", id: "expired" } })).toMatchObject({ dryRun: true });
  });
  it.each(["mem::auto-forget", "mem::evict", "mem::retention-evict", "mem::lesson-decay-sweep"])("fails before cleanup if archive protection cannot be read: %s", async id => {
    const f = await fixture(), before = structuredClone(f.kv.store);
    const list = f.kv.list.bind(f.kv);
    vi.spyOn(f.kv, "list").mockImplementation(async scope => { if (scope === KV.archiveStates) throw Error("archive unavailable"); return list(scope); });
    await expect(f.call(id)).rejects.toThrow("archive unavailable");
    expect(f.kv.store).toEqual(before);
  });
});
