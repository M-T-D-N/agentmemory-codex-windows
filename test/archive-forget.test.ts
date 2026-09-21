import { describe, expect, it, vi } from "vitest";
import { mockKV, mockSdk } from "./helpers/mocks.js";
import { KV } from "../src/state/schema.js";
import { registerRememberFunction } from "../src/functions/remember.js";
import { registerArchiveFunctions } from "../src/functions/archive-tools.js";
import { archiveTargetAddress } from "../src/functions/archive.js";
import { prepareArchiveForget } from "../src/functions/archive-forget.js";
import { captureExportData } from "../src/functions/export-import.js";

vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
async function fixture() {
  const base = mockKV();
  const kv = Object.assign(base, { hasObservationRecovery: () => false, assertRecoveryImportAllowed: () => {}, listGroups: async () => [...base.store.keys()] });
  const sdk = mockSdk({ looseTrigger: true });
  registerRememberFunction(sdk as never, kv as never); registerArchiveFunctions(sdk as never, kv as never);
  await kv.set(KV.sessions, "s", { id: "s", project: "p", agentId: "test", observationCount: 1, startedAt: "2026-01-01T00:00:00Z" });
  await kv.set(KV.observations("s"), "o", { id: "o", sessionId: "s", title: "original", narrative: "original evidence", timestamp: "2026-01-01T00:00:00Z" });
  await kv.set(KV.memories, "m", { id: "m", project: "p", title: "decision", content: "original evidence", sessionIds: ["s"], isLatest: true });
  const call = (id: string, data: object) => sdk.trigger(id, data) as Promise<any>;
  const archive = async (target: object) => {
    const preview = await call("mem::archive", { action: "archive", project: "p", target });
    return call("mem::archive", { action: "archive", project: "p", target, dryRun: false, reason: "Reviewed", expectedRevision: preview.expectedRevision, expectedDigest: preview.expectedDigest });
  };
  return { kv, call, archive };
}

describe("explicit forget reconciles only deleted archive targets", () => {
  it("deletes an archived memory and its metadata without treating forget as archive or allowing restore", async () => {
    const f = await fixture(); await f.archive({ kind: "memory", id: "m" });
    expect(await f.call("mem::forget", { project: "p", memoryId: "m" })).toMatchObject({ success: true, deleted: 1, archiveStatesRemoved: 1 });
    expect(await f.kv.get(KV.memories, "m")).toBeNull(); expect(await f.kv.list(KV.archiveStates)).toEqual([]);
    await expect(f.call("mem::archive", { action: "restore", project: "p", target: { kind: "memory", id: "m" } })).rejects.toThrow("missing");
    expect(await f.kv.get(KV.observations("s"), "o")).not.toBeNull();
    const exported = await captureExportData(f.kv as never, {});
    expect(exported.memories).toEqual([]); expect(exported.archiveStates).toBeUndefined();
  });
  it("previews archive effects without writing, then removes selected observation metadata and keeps session history", async () => {
    const f = await fixture(); await f.archive({ kind: "session", id: "s" }); await f.archive({ kind: "observation", id: "o", sessionId: "s" });
    const before = structuredClone(f.kv.store);
    const request = { project: "p", sessionId: "s", observationIds: ["o"] };
    expect(await f.call("mem::forget", { ...request, dryRun: true })).toMatchObject({ dryRun: true,
      archiveTargets: [{ target: { kind: "observation", id: "o", sessionId: "s" } }] });
    expect(f.kv.store).toEqual(before);
    expect(await f.call("mem::forget", request)).toMatchObject({ success: true, deleted: 1, archiveStatesRemoved: 1 });
    expect(await f.kv.list(KV.archiveStates)).toMatchObject([{ target: { kind: "session", id: "s" } }]);
    expect(await f.kv.get(KV.sessions, "s")).toMatchObject({ observationCount: 0 });
  });
  it("retries metadata cleanup after its delete fails without recreating originals", async () => {
    const f = await fixture(); await f.archive({ kind: "memory", id: "m" });
    const del = f.kv.delete.bind(f.kv); let fail = true;
    vi.spyOn(f.kv, "delete").mockImplementation(async (scope, id) => { if (scope === KV.archiveStates && fail) { fail = false; throw Error("metadata write unavailable"); } await del(scope, id); });
    await expect(f.call("mem::forget", { project: "p", memoryId: "m" })).rejects.toThrow("metadata write unavailable");
    expect(await f.kv.get(KV.memories, "m")).toBeNull();
    expect(await f.kv.list(KV.archiveStates)).toHaveLength(1);
    await expect(f.call("mem::forget", { project: "wrong", memoryId: "m" })).rejects.toThrow("exact project");
    expect(await f.call("mem::forget", { project: "p", memoryId: "m" })).toMatchObject({ deleted: 0, archiveStatesRemoved: 1 });
    expect(await f.kv.list(KV.archiveStates)).toEqual([]);
    expect(await f.kv.get(KV.memories, "m")).toBeNull();
  });
  it("does not repeat deletion or restore content after metadata removal commits but its acknowledgement is lost", async () => {
    const f = await fixture(); await f.archive({ kind: "memory", id: "m" });
    const del = f.kv.delete.bind(f.kv); let fail = true;
    vi.spyOn(f.kv, "delete").mockImplementation(async (scope, id) => {
      await del(scope, id);
      if (scope === KV.archiveStates && fail) { fail = false; throw Error("acknowledgement lost"); }
    });
    await expect(f.call("mem::forget", { project: "p", memoryId: "m" })).rejects.toThrow("acknowledgement lost");
    expect(await f.kv.get(KV.memories, "m")).toBeNull(); expect(await f.kv.list(KV.archiveStates)).toEqual([]);
    const before = structuredClone(f.kv.store);
    expect(await f.call("mem::forget", { project: "p", memoryId: "m" })).toMatchObject({ success: true, deleted: 0 });
    expect(f.kv.store).toEqual(before);
  });
  it("preserves metadata and visibility when the original delete fails", async () => {
    const f = await fixture(); await f.archive({ kind: "memory", id: "m" });
    const before = structuredClone(f.kv.store), del = f.kv.delete.bind(f.kv);
    vi.spyOn(f.kv, "delete").mockImplementation(async (scope, id) => { if (scope === KV.memories) throw Error("original write failed"); return del(scope, id); });
    await expect(f.call("mem::forget", { project: "p", memoryId: "m" })).rejects.toThrow("original write failed");
    expect(f.kv.store).toEqual(before);
  });
  it("removes session and observation archive metadata only for an explicit whole-session forget", async () => {
    const f = await fixture(); await f.archive({ kind: "session", id: "s" }); await f.archive({ kind: "observation", id: "o", sessionId: "s" });
    expect(await f.call("mem::forget", { project: "p", sessionId: "s" })).toMatchObject({ success: true, archiveStatesRemoved: 2 });
    expect(await f.kv.list(KV.archiveStates)).toEqual([]); expect(await f.kv.get(KV.sessions, "s")).toBeNull();
    expect(await f.kv.get(KV.memories, "m")).not.toBeNull();
  });
  it("rejects pending import, current ownership drift and dependent archive ownership loss before deletion", async () => {
    const f = await fixture(); await f.archive({ kind: "memory", id: "m" });
    const key = archiveTargetAddress({ kind: "memory", id: "m" }).key;
    const state = await f.kv.get<any>(KV.archiveStates, key);
    await f.kv.set(KV.archiveStates, key, { ...state, importPendingDigest: "a".repeat(64) });
    await expect(f.call("mem::forget", { project: "p", memoryId: "m" })).rejects.toThrow("import recovery");
    await f.kv.set(KV.archiveStates, key, state);
    await f.kv.set(KV.memories, "m", { id: "m", project: "q" });
    await expect(f.call("mem::forget", { project: "p", memoryId: "m" })).rejects.toThrow("ownership");
    await f.kv.set(KV.semantic, "sem", { id: "sem", sourceSessionIds: ["s"] }); await f.archive({ kind: "semantic", id: "sem" });
    await expect(f.call("mem::forget", { project: "p", sessionId: "s" })).rejects.toThrow("required archive ownership provenance");
    expect(await f.kv.get(KV.observations("s"), "o")).not.toBeNull();
  });
  it("cleans deleted graph targets while keeping independently retained graph originals and archive metadata", async () => {
    const f = await fixture();
    for (const id of ["deleted-node", "retained-node"]) {
      await f.kv.set(KV.graphNodes, id, { id, project: "p", sourceSessionIds: ["s"], sourceObservationIds: ["o"] });
      await f.archive({ kind: "graph_node", id });
    }
    const finish = await prepareArchiveForget(f.kv as never, { project: "p", sessionId: "s", observationIds: ["o"] });
    await f.kv.delete(KV.graphNodes, "deleted-node");
    expect(await finish()).toBe(1);
    expect(await f.kv.list(KV.archiveStates)).toMatchObject([{ target: { id: "retained-node" } }]);
  });
});
