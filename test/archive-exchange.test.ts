import { afterEach, describe, expect, it, vi } from "vitest";
import { mockKV, mockSdk } from "./helpers/mocks.js";
import type { StateKV } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";
import { changeArchiveState } from "../src/functions/archive.js";
import { registerMeshFunction } from "../src/functions/mesh.js";
import { registerClaudeBridgeFunction } from "../src/functions/claude-bridge.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { writeFileSync } from "node:fs";

vi.mock("node:fs", async () => ({ ...(await vi.importActual("node:fs")), writeFileSync: vi.fn(), mkdirSync: vi.fn() }));
vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const timestamp = "2026-09-13T00:00:00Z";
const memory = { id: "m", project: "p", title: "private decision", content: "hidden original", sessionIds: [],
  isLatest: true, strength: 1, createdAt: timestamp, updatedAt: timestamp };
const request = { headers: { authorization: "Bearer test-secret" }, query_params: {} };
async function fixture() {
  const backing = mockKV();
  const kv = { ...backing, assertRecoveryImportAllowed() {} } as unknown as StateKV;
  const sdk = mockSdk();
  registerMeshFunction(sdk as never, kv, "test-secret");
  registerApiTriggers(sdk as never, kv, async () => ({ context: "", blocks: 0, tokens: 0 }), "test-secret");
  registerClaudeBridgeFunction(sdk as never, kv, { enabled: true, memoryFilePath: "memory.md", projectPath: "", lineBudget: 200 });
  await kv.set(KV.memories, "m", structuredClone(memory));
  const change = async (action: "archive" | "restore" = "archive") => {
    const target = { kind: "memory" as const, id: "m" };
    const preview = await changeArchiveState(kv, { target, project: "p", action });
    return changeArchiveState(kv, { target, project: "p", action, dryRun: false,
      expectedDigest: preview.expectedDigest, expectedRevision: preview.expectedRevision, reason: "reviewed" });
  };
  return { kv, backing, sdk, change };
}
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("archive boundaries for legacy exchange", () => {
  it.each(["archived", "restored"])("rejects legacy exchange with %s history before data writes or network access", async state => {
    const f = await fixture();
    await f.change();
    if (state === "restored") await f.change("restore");
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const before = structuredClone(f.backing.store);
    expect(await f.sdk.trigger("mem::mesh-sync", { direction: "both" })).toMatchObject({ success: false, error: expect.stringContaining("archive/restore") });
    expect(await f.sdk.trigger("mem::mesh-receive", { memories: [{ ...memory, content: "overwrite", updatedAt: "2030-01-01T00:00:00Z" }] }))
      .toMatchObject({ success: false, error: expect.stringContaining("archive/restore") });
    expect(await f.sdk.trigger("api::mesh-export", request)).toMatchObject({ status_code: 409 });
    expect(await f.sdk.trigger("api::mesh-receive", { ...request, body: { memories: [memory] } })).toMatchObject({ status_code: 409 });
    expect(fetcher).not.toHaveBeenCalled();
    expect(f.backing.store).toEqual(before);
  });

  it("rejects an archive envelope on receive and pull instead of dropping its lifecycle metadata", async () => {
    const f = await fixture();
    const incoming = { memories: [{ ...memory, id: "remote" }], archiveStates: [] };
    expect(await f.sdk.trigger("mem::mesh-receive", incoming)).toMatchObject({ success: false });
    await f.kv.set(KV.mesh, "peer", { id: "peer", name: "peer", url: "https://8.8.8.8", sharedScopes: ["memories"], lastSyncAt: timestamp });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => incoming })));
    expect(await f.sdk.trigger("mem::mesh-sync", { peerId: "peer", direction: "pull" }))
      .toMatchObject({ results: [{ pulled: 0, errors: [expect.stringContaining("archive lifecycle")] }] });
    expect(await f.kv.get(KV.memories, "remote")).toBeNull();
    expect(await f.kv.get(KV.mesh, "peer")).toMatchObject({ lastSyncAt: timestamp, status: "error" });
  });

  it("regenerates MEMORY.md with visible memories and restores the same original", async () => {
    const f = await fixture();
    await f.kv.set(KV.memories, "visible", { ...memory, id: "visible", title: "current", content: "visible decision" });
    await f.change();
    expect(await f.sdk.trigger("mem::claude-bridge-sync", {})).toMatchObject({ success: true });
    const output = String(vi.mocked(writeFileSync).mock.calls.at(-1)?.[1]);
    expect(output).toContain("visible decision");
    expect(output).not.toContain("hidden original");
    expect(await f.kv.get(KV.memories, "m")).toEqual(memory);
    await f.change("restore");
    expect(await f.sdk.trigger("mem::claude-bridge-sync", {})).toMatchObject({ success: true });
    expect(String(vi.mocked(writeFileSync).mock.calls.at(-1)?.[1])).toContain("hidden original");
  });

  it("keeps the sync cursor unchanged when a peer rejects a push in a successful HTTP response", async () => {
    const f = await fixture();
    await f.kv.set(KV.mesh, "peer", { id: "peer", name: "peer", url: "https://8.8.8.8", sharedScopes: ["memories"], lastSyncAt: timestamp });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ success: false, error: "archive lifecycle unsupported" }) })));
    expect(await f.sdk.trigger("mem::mesh-sync", { peerId: "peer", direction: "push" }))
      .toMatchObject({ results: [{ pushed: 0, errors: [expect.stringContaining("push rejected")] }] });
    expect(await f.kv.get(KV.mesh, "peer")).toMatchObject({ lastSyncAt: timestamp, status: "error" });
  });

  it("does not export content when archive metadata cannot be read", async () => {
    const f = await fixture(), list = f.kv.list.bind(f.kv);
    f.kv.list = async (scope, options) => { if (scope === KV.archiveStates) throw Error("archive read failed"); return list(scope, options); };
    await expect(f.sdk.trigger("api::mesh-export", request)).rejects.toThrow("archive read failed");
    expect(await f.sdk.trigger("mem::claude-bridge-sync", {})).toMatchObject({ success: false, error: "archive read failed" });
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it.each(["api::mesh-export", "mem::claude-bridge-sync"])("prevents a concurrent archive transition during %s", async functionId => {
    const f = await fixture(), list = f.kv.list.bind(f.kv);
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.kv.list = async (scope, options) => {
      const result = await list(scope, options);
      if (scope === KV.archiveStates) { entered(); await gate; }
      return result;
    };
    const exporting = f.sdk.trigger(functionId, request);
    await waiting;
    try { await expect(f.change()).rejects.toThrow("writers are active"); }
    finally { release(); await exporting; }
    expect(await f.kv.list(KV.archiveStates)).toEqual([]);
  });
});
