import { describe, expect, it, vi } from "vitest";
import { mockKV, mockSdk } from "./helpers/mocks.js";
import { KV } from "../src/state/schema.js";
import { registerArchiveFunctions } from "../src/functions/archive-tools.js";
import { registerGovernanceFunction } from "../src/functions/governance.js";
import { registerLessonsFunctions } from "../src/functions/lessons.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { registerMcpEndpoints } from "../src/mcp/server.js";
import { archiveTargetAddress } from "../src/functions/archive.js";

vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
async function fixture() {
  const kv = mockKV(), sdk = mockSdk({ looseTrigger: true });
  registerArchiveFunctions(sdk as never, kv as never); registerGovernanceFunction(sdk as never, kv as never); registerLessonsFunctions(sdk as never, kv as never);
  registerApiTriggers(sdk as never, kv as never, async () => ({ context: "", blocks: 0, tokens: 0 })); registerMcpEndpoints(sdk as never, kv as never);
  for (const project of ["p", "q"]) {
    await kv.set(KV.memories, "m-" + project, { id: "m-" + project, project, content: "original", type: "fact", isLatest: true, createdAt: "2026-01-01T00:00:00Z" });
    await kv.set(KV.lessons, "l-" + project, { id: "l-" + project, project, content: "lesson", confidence: 0.9, createdAt: "2026-01-01T00:00:00Z" });
  }
  const call = (name: string, data: object) => sdk.trigger(name, data) as Promise<any>;
  const archive = async (kind: string, id: string, project = "p") => {
    const target = { kind, id }, preview = await call("mem::archive", { action: "archive", project, target });
    return call("mem::archive", { action: "archive", project, target, dryRun: false, expectedRevision: preview.expectedRevision, expectedDigest: preview.expectedDigest, reason: "Reviewed" });
  };
  const mcp = async (name: string, args: object) => {
    const response = await call("mcp::tools::call", { headers: {}, body: { name, arguments: args } });
    return JSON.parse(response.body.content[0].text);
  };
  return { kv, call, archive, mcp };
}

describe("legacy delete surfaces share the archive lifecycle", () => {
  it("passes exact project through MCP governance deletion and keeps the other project untouched", async () => {
    const f = await fixture(); await f.archive("memory", "m-p");
    expect(await f.mcp("memory_governance_delete", { memoryIds: "m-p", project: "p" })).toMatchObject({ success: true, deleted: 1, archiveStatesRemoved: 1 });
    expect(await f.kv.get(KV.memories, "m-p")).toBeNull(); expect(await f.kv.get(KV.memories, "m-q")).not.toBeNull();
    expect(await f.kv.list(KV.archiveStates)).toEqual([]);
  });
  it("honors the bulk project filter in REST preview and apply", async () => {
    const f = await fixture(); await f.archive("memory", "m-p"); await f.archive("memory", "m-q", "q");
    const before = structuredClone(f.kv.store);
    expect(await f.call("api::governance-bulk", { body: { project: "p", type: ["fact"], dryRun: true } })).toMatchObject({ body: { ids: ["m-p"], archiveTargets: [{ project: "p" }] } });
    expect(f.kv.store).toEqual(before);
    expect(await f.call("api::governance-bulk", { body: { project: "p", type: ["fact"] } })).toMatchObject({ body: { success: true, deleted: 1, archiveStatesRemoved: 1 } });
    expect(await f.kv.get(KV.memories, "m-q")).not.toBeNull(); expect(await f.kv.list(KV.archiveStates)).toMatchObject([{ project: "q" }]);
  });
  it("rejects missing archive project and mixed explicit IDs before the first mutation", async () => {
    const f = await fixture(); await f.archive("memory", "m-p"); const before = structuredClone(f.kv.store);
    await expect(f.call("mem::governance-delete", { memoryIds: ["m-p"] })).rejects.toThrow("exact project");
    expect(await f.call("mem::governance-delete", { project: "p", memoryIds: ["m-p", "m-q"] })).toMatchObject({ success: false, error: "memory project mismatch" });
    expect(await f.call("mem::governance-bulk", { project: "*", dryRun: false })).toMatchObject({ success: false });
    expect(f.kv.store).toEqual(before);
  });
  it("finishes a failed bulk archive cleanup through exact governance IDs", async () => {
    const f = await fixture(); await f.archive("memory", "m-p");
    const del = f.kv.delete.bind(f.kv); let fail = true;
    vi.spyOn(f.kv, "delete").mockImplementation(async (scope, id) => { if (scope === KV.archiveStates && fail) { fail = false; throw Error("cleanup unavailable"); } await del(scope, id); });
    expect(await f.call("mem::governance-bulk", { project: "p", type: ["fact"] })).toMatchObject({ success: false, failed: 1, failures: [{ id: "m-p" }] });
    expect(await f.kv.get(KV.memories, "m-p")).toBeNull();
    expect(await f.call("api::governance-delete", { body: { project: "p", memoryIds: ["m-p"] } })).toMatchObject({ body: { success: true, deleted: 0, archiveStatesRemoved: 1 } });
  });
  it("keeps lesson soft-delete semantics and removes archive metadata through MCP and REST", async () => {
    const f = await fixture(); await f.archive("lesson", "l-p");
    expect(await f.mcp("memory_lesson_delete", { lessonId: "l-p", project: "p" })).toMatchObject({ success: true, archiveStatesRemoved: 1, lesson: { deleted: true } });
    expect(await f.kv.get(KV.lessons, "l-p")).toMatchObject({ content: "lesson", deleted: true });
    await f.archive("lesson", "l-q", "q");
    expect(await f.call("api::lesson-delete", { body: { project: "q", lessonId: "l-q" } })).toMatchObject({ body: { success: true, archiveStatesRemoved: 1 } });
    expect(await f.kv.list(KV.archiveStates)).toEqual([]);
  });
  it("allows exact retry after lesson soft-delete succeeds but metadata cleanup fails", async () => {
    const f = await fixture(); await f.archive("lesson", "l-p");
    const del = f.kv.delete.bind(f.kv); let fail = true;
    vi.spyOn(f.kv, "delete").mockImplementation(async (scope, id) => { if (scope === KV.archiveStates && fail) { fail = false; throw Error("cleanup unavailable"); } await del(scope, id); });
    await expect(f.call("mem::lesson-delete", { project: "p", lessonId: "l-p" })).rejects.toThrow("cleanup unavailable");
    expect(await f.call("mem::lesson-delete", { project: "p", lessonId: "l-p" })).toMatchObject({ success: true, alreadyDeleted: true, archiveStatesRemoved: 1 });
    await expect(f.call("mem::archive", { action: "restore", project: "p", target: { kind: "lesson", id: "l-p" } })).rejects.toThrow("deleted");
  });
  it("blocks pending import before changing the lesson row", async () => {
    const f = await fixture(); await f.archive("lesson", "l-p");
    const key = archiveTargetAddress({ kind: "lesson", id: "l-p" }).key;
    await f.kv.set(KV.archiveStates, key, { ...await f.kv.get<any>(KV.archiveStates, key), importPendingDigest: "a".repeat(64) });
    const before = structuredClone(f.kv.store);
    await expect(f.call("mem::lesson-delete", { project: "p", lessonId: "l-p" })).rejects.toThrow("import recovery");
    expect(f.kv.store).toEqual(before);
  });
  it("rejects archive metadata stored under the wrong target key before deleting an original", async () => {
    const f = await fixture(); await f.archive("lesson", "l-p");
    const lessonKey = archiveTargetAddress({ kind: "lesson", id: "l-p" }).key;
    const memoryKey = archiveTargetAddress({ kind: "memory", id: "m-p" }).key;
    await f.kv.set(KV.archiveStates, memoryKey, await f.kv.get(KV.archiveStates, lessonKey));
    const before = structuredClone(f.kv.store);
    await expect(f.call("mem::governance-delete", { project: "p", memoryIds: ["m-p"] })).rejects.toThrow("does not match");
    expect(f.kv.store).toEqual(before);
  });
  it("preserves source-based ownership for a legacy lesson without a direct project field", async () => {
    const f = await fixture();
    await f.kv.set(KV.sessions, "s", { id: "s", project: "p" });
    await f.kv.set(KV.lessons, "legacy", { id: "legacy", sourceSessionIds: ["s"], content: "legacy evidence", confidence: 0.9 });
    await f.archive("lesson", "legacy");
    const del = f.kv.delete.bind(f.kv); let fail = true;
    vi.spyOn(f.kv, "delete").mockImplementation(async (scope, id) => { if (scope === KV.archiveStates && fail) { fail = false; throw Error("cleanup unavailable"); } await del(scope, id); });
    await expect(f.call("mem::lesson-delete", { project: "p", lessonId: "legacy" })).rejects.toThrow("cleanup unavailable");
    expect(await f.call("mem::lesson-delete", { project: "p", lessonId: "legacy" })).toMatchObject({ success: true, alreadyDeleted: true, archiveStatesRemoved: 1 });
    expect(await f.kv.get(KV.lessons, "legacy")).toMatchObject({ sourceSessionIds: ["s"], content: "legacy evidence", deleted: true });
  });
});
