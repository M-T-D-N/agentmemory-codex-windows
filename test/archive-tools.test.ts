import { describe, expect, it, vi } from "vitest";
import { mockKV, mockSdk } from "./helpers/mocks.js";
import { KV } from "../src/state/schema.js";
import { registerArchiveFunctions, parseArchiveToolInput } from "../src/functions/archive-tools.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { registerMcpEndpoints } from "../src/mcp/server.js";
import { readArchiveVisibility } from "../src/functions/archive.js";

vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const target = { kind: "memory", id: "m" };
async function fixture(engineMetadata: boolean) {
  const kv = mockKV(), sdk = mockSdk({ looseTrigger: true });
  registerArchiveFunctions(sdk as never, kv as never);
  if (engineMetadata) {
    const handler = sdk.fns.get("mem::archive")!;
    sdk.fns.set("mem::archive", data => handler(data && typeof data === "object" && !Array.isArray(data)
      ? { ...data, _caller_worker_id: "engine-worker-id" } : data));
  }
  registerMcpEndpoints(sdk as never, kv as never);
  registerApiTriggers(sdk as never, kv as never, async () => ({ context: "", blocks: 0, tokens: 0 }));
  const memory = { id: "m", project: "p", content: "preserved original", title: "decision", version: 2,
    supersedes: ["prior-memory"], sourceObservationIds: ["o"], sessionIds: ["s"], imageRef: "image-ref" };
  await kv.set(KV.memories, "m", memory);
  await kv.set(KV.memories, "other", { ...memory, id: "other", project: "other-project" });
  const call = (data: object) => sdk.trigger("mem::archive", data) as Promise<any>;
  const mcp = async (args: object) => {
    const result = await sdk.trigger("mcp::tools::call", { headers: {}, body: { name: "memory_archive", arguments: args } }) as any;
    return { ...JSON.parse(result.body.content[0].text), isError: result.body.isError };
  };
  return { kv, sdk, memory, call, mcp };
}

describe.each([false, true])("official explicit archive inspection and lifecycle tool (engine metadata: %s)", engineMetadata => {
  it("defaults to read-only inspection and gives an exact original without modifying provenance", async () => {
    const f = await fixture(engineMetadata), before = structuredClone(f.kv.store);
    expect(await f.mcp({ project: "p", target })).toMatchObject({ success: true, state: "active", record: f.memory });
    expect(f.kv.store).toEqual(before);
    await expect(f.call({ project: "wrong", target })).rejects.toThrow("ownership");
    expect(f.kv.store).toEqual(before);
  });
  it("previews through REST, applies through MCP, explicitly inspects archived content, and restores the same original", async () => {
    const f = await fixture(engineMetadata);
    const response = await f.sdk.trigger("api::archive", { body: { action: "archive", project: "p", target } }) as any;
    expect(response).toMatchObject({ status_code: 200, body: { dryRun: true, expectedRevision: 0, changed: 1 } });
    expect(await f.kv.list(KV.archiveStates)).toEqual([]);
    const apply = { action: "archive", project: "p", target, dryRun: false, expectedRevision: response.body.expectedRevision,
      expectedDigest: response.body.expectedDigest, reason: "Reviewed lifecycle candidate" };
    expect(await f.mcp(apply)).toMatchObject({ success: true, changed: 1 });
    expect(await f.mcp(apply)).toMatchObject({ success: true, changed: 0 });
    expect((await readArchiveVisibility(f.kv as never))({ kind: "memory", id: "m" })).toBe(true);
    expect(await f.mcp({ project: "p", target })).toMatchObject({ state: "archived", record: f.memory });
    const preview = await f.call({ action: "restore", project: "p", target });
    expect(await f.sdk.trigger("api::archive", { body: { action: "restore", project: "p", target, dryRun: false,
      expectedRevision: preview.expectedRevision, expectedDigest: preview.expectedDigest, reason: "Useful again" } })).toMatchObject({ status_code: 200, body: { changed: 1 } });
    expect((await readArchiveVisibility(f.kv as never))({ kind: "memory", id: "m" })).toBe(false);
    expect(await f.kv.get(KV.memories, "m")).toEqual(f.memory);
    expect(await f.kv.list(KV.audit)).toHaveLength(2);
  });
  it("lists only exact-project lifecycle metadata with bounded totals and no original content", async () => {
    const f = await fixture(engineMetadata);
    for (const [project, id] of [["p", "m"], ["other-project", "other"]]) {
      const request = { action: "archive", project, target: { kind: "memory", id } };
      const preview = await f.call(request);
      await f.call({ ...request, dryRun: false, expectedRevision: preview.expectedRevision, expectedDigest: preview.expectedDigest, reason: "Retention review" });
    }
    const result = await f.call({ action: "list", project: "p", limit: 1 });
    expect(result).toMatchObject({ total: 1, offset: 0, nextOffset: null, archives: [{ target }] });
    expect(JSON.stringify(result)).not.toContain("preserved original");
    expect(await f.call({ action: "list", project: "p", state: "restored" })).toMatchObject({ total: 0 });
  });
  it.each([
    { project: "*", action: "list" }, { project: "p", action: "list", limit: 101 },
    { project: "p", action: "list", offset: -1 }, { project: "p", action: "list", target },
    { project: "p", action: "archive", target, dryRun: "false" },
    { project: "p", target: { kind: "observation", id: "o" } },
    { project: "p", target: { ...target, scope: KV.sessions } },
    { project: "p", target, sourceRoot: "untrusted" },
    { project: "p", target, _caller_worker_id: "public-caller-input" },
  ])("rejects invalid or overbroad request before writing: %j", async input => {
    const f = await fixture(engineMetadata), before = structuredClone(f.kv.store);
    expect(() => parseArchiveToolInput(input)).toThrow();
    expect(await f.sdk.trigger("api::archive", { body: input })).toMatchObject({ status_code: 400 });
    expect(await f.mcp(input)).toMatchObject({ isError: true });
    expect(f.kv.store).toEqual(before);
  });
  it("still rejects unknown internal fields without changing canonical or archive state", async () => {
    const f = await fixture(engineMetadata), before = structuredClone(f.kv.store);
    await expect(f.call({ project: "p", target, _unexpected: true })).rejects.toThrow("Unexpected archive request field");
    expect(f.kv.store).toEqual(before);
  });
  it("rejects apply without preview evidence and never restores a missing original", async () => {
    const f = await fixture(engineMetadata);
    expect(await f.sdk.trigger("api::archive", { body: { action: "archive", project: "p", target, dryRun: false } }))
      .toMatchObject({ status_code: 422 });
    expect(await f.kv.list(KV.archiveStates)).toEqual([]);
    await f.kv.delete(KV.memories, "m");
    await expect(f.call({ action: "restore", project: "p", target })).rejects.toThrow("missing");
    expect(await f.kv.get(KV.memories, "m")).toBeNull();
  });
  it("enforces REST authentication before inspecting a target", async () => {
    const f = await fixture(engineMetadata);
    registerApiTriggers(f.sdk as never, f.kv as never, async () => ({ context: "", blocks: 0, tokens: 0 }), "fixture-secret");
    const before = structuredClone(f.kv.store);
    expect(await f.sdk.trigger("api::archive", { body: { project: "p", target } })).toMatchObject({ status_code: 401 });
    expect(await f.sdk.trigger("api::archive", { headers: { authorization: "Bearer fixture-secret" }, body: { project: "p", target } }))
      .toMatchObject({ status_code: 200, body: { record: f.memory } });
    expect(f.kv.store).toEqual(before);
  });
  it("keeps an unfinished restored import discoverable in the default hidden-state list", async () => {
    const f = await fixture(engineMetadata);
    const preview = await f.call({ action: "archive", project: "p", target });
    const applied = await f.call({ action: "archive", project: "p", target, dryRun: false,
      expectedRevision: preview.expectedRevision, expectedDigest: preview.expectedDigest, reason: "Fixture" });
    await f.kv.set(KV.archiveStates, applied.archive.id, { ...applied.archive, state: "restored", importPendingDigest: preview.expectedDigest });
    expect(await f.call({ action: "list", project: "p" })).toMatchObject({ total: 1, archives: [{ importPendingDigest: preview.expectedDigest }] });
    expect(await f.call({ action: "list", project: "p", state: "restored" })).toMatchObject({ total: 0 });
    expect(await f.call({ project: "p", target })).toMatchObject({ importPending: true });
    await expect(f.call({ action: "restore", project: "p", target })).rejects.toThrow("recovery must finish");
  });
});
