import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockKV, mockSdk } from "./helpers/mocks.js";
import { KV } from "../src/state/schema.js";
import { registerMeshFunction } from "../src/functions/mesh.js";
vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]) }));
vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const oldSync = "2025-01-01T00:00:00Z";
function memory(id: string, project?: string) { return { id, ...(project ? { project } : {}), sessionId: "fixture", content: id, type: "insight", importance: 5, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" }; }
async function fixture(project: string | null = "A", scopes = ["memories"]) {
  const kv = mockKV(), sdk = mockSdk({ looseTrigger: true });
  const peer = { id: "peer-fixture", name: "fixture", url: "https://peer.example.test", sharedScopes: scopes, ...(project ? { syncFilter: { project } } : {}), status: "connected", lastSyncAt: oldSync };
  await kv.set(KV.mesh, peer.id, peer);
  for (const row of [memory("local-A", project ?? "A"), memory("local-B", "B"), memory("local-legacy")]) await kv.set(KV.memories, row.id, row);
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let incoming: unknown = { memories: [memory("remote-A", project ?? "A")], actions: [] };
  const fetchStub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify(init?.method === "POST" ? { success: true, accepted: 1 } : incoming), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchStub);
  registerMeshFunction(sdk as never, kv as never, "synthetic-mesh-auth-only");
  const sync = (direction: "push" | "pull" | "both", override?: string[]) => sdk.trigger("mem::mesh-sync", { peerId: peer.id, direction, ...(override ? { scopes: override } : {}) });
  return { kv, sdk, peer, requests, fetchStub, incoming: (value: unknown) => { incoming = value; }, sync };
}
beforeEach(() => vi.clearAllMocks());
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("dot F11 outgoing and incoming exact-project mesh boundary", () => {
  it.each(["push", "both"] as const)("%s serializes only A and omits legacy ownership", async direction => {
    const f = await fixture();
    await f.sync(direction);
    const post = f.requests.find(row => row.init?.method === "POST")!;
    expect(JSON.parse(String(post.init?.body)).memories.map((row: { id: string }) => row.id)).toEqual(["local-A"]);
  });
  it.each(["pull", "both"] as const)("%s encodes the project and since query", async direction => {
    const project = "A + 한글/&";
    const f = await fixture(project);
    await f.sync(direction);
    const get = f.requests.find(row => row.init?.method !== "POST")!;
    const url = new URL(get.url);
    expect(url.searchParams.get("project")).toBe(project);
    expect(url.searchParams.get("since")).toBe(oldSync);
  });
  it.each(["pull", "both"] as const)("%s rejects a peer's B rows before applying A rows", async direction => {
    const f = await fixture();
    f.incoming({ memories: [memory("remote-A", "A"), memory("remote-B", "B")] });
    const result = await f.sync(direction);
    expect(result.results[0].errors.length).toBeGreaterThan(0);
    expect(await f.kv.get(KV.memories, "remote-A")).toBeNull();
    expect(await f.kv.get(KV.memories, "remote-B")).toBeNull();
    expect(await f.kv.get(KV.mesh, f.peer.id)).toMatchObject({ lastSyncAt: oldSync });
  });
  it("does not overwrite an existing A memory with a same-ID foreign row", async () => {
    const f = await fixture(); const original = structuredClone(await f.kv.get(KV.memories, "local-A"));
    f.incoming({ memories: [{ ...memory("local-A", "B"), updatedAt: "2026-11-01T00:00:00Z" }] });
    await f.sync("pull");
    expect(await f.kv.get(KV.memories, "local-A")).toEqual(original);
    expect(await f.kv.get(KV.mesh, f.peer.id)).toMatchObject({ lastSyncAt: oldSync });
  });
  it("does not overwrite a local foreign owner even when the incoming project is A", async () => {
    const f = await fixture(); const original = structuredClone(await f.kv.get(KV.memories, "local-B"));
    f.incoming({ memories: [{ ...memory("local-B", "A"), updatedAt: "2026-11-01T00:00:00Z" }] });
    await f.sync("pull");
    expect(await f.kv.get(KV.memories, "local-B")).toEqual(original);
  });
  it("a scopes override cannot expand a restricted peer into global semantic data", async () => {
    const f = await fixture(); f.incoming({ semantic: [{ id: "global-row", concept: "foreign", updatedAt: "2026-10-01T00:00:00Z" }] });
    const result = await f.sync("both", ["semantic"]);
    expect(result.results[0].errors.length).toBeGreaterThan(0);
    expect(f.fetchStub).not.toHaveBeenCalled();
    expect(await f.kv.get(KV.semantic, "global-row")).toBeNull();
    expect(await f.kv.get(KV.mesh, f.peer.id)).toMatchObject({ lastSyncAt: oldSync });
  });
  it("a project-bound peer's declared globals are never applied", async () => {
    const f = await fixture("A", ["memories", "semantic", "procedural", "relations", "graph:nodes", "graph:edges"]);
    f.incoming({ memories: [memory("remote-A", "A")], semantic: [{ id: "global-row", updatedAt: "2026-10-01T00:00:00Z" }] });
    const result = await f.sync("pull");
    expect(result.results[0].errors.length).toBeGreaterThan(0);
    expect(await f.kv.get(KV.semantic, "global-row")).toBeNull();
    expect(await f.kv.get(KV.memories, "remote-A")).toBeNull();
  });
  it.each([null, { error: "peer export failed" }, { memories: {} }, { memories: [memory("legacy-remote")] }])("invalid or partial incoming response preserves the retry cursor", async response => {
    const f = await fixture(); f.incoming(response);
    const result = await f.sync("pull");
    expect(result.results[0].errors.length).toBeGreaterThan(0);
    expect(await f.kv.get(KV.mesh, f.peer.id)).toMatchObject({ lastSyncAt: oldSync });
  });
  it("retries a failed scoped response without losing the legitimate delta", async () => {
    const f = await fixture(); f.incoming({ memories: [memory("remote-B", "B")] });
    await f.sync("pull");
    f.incoming({ memories: [memory("remote-A", "A")] });
    const retry = await f.sync("pull");
    expect(retry.results[0].errors).toEqual([]);
    expect(await f.kv.get(KV.memories, "remote-A")).toMatchObject({ project: "A" });
    expect(await f.kv.get(KV.memories, "remote-B")).toBeNull();
    expect(new URL(f.requests.at(-1)!.url).searchParams.get("since")).toBe(oldSync);
  });
  it("preserves deliberate unscoped behavior", async () => {
    const f = await fixture(null); f.incoming({ memories: [memory("remote-B", "B"), memory("legacy-remote")] });
    const result = await f.sync("both");
    expect(result.results[0].errors).toEqual([]);
    const body = JSON.parse(String(f.requests.find(row => row.init?.method === "POST")!.init?.body));
    expect(body.memories).toHaveLength(3);
    expect(await f.kv.get(KV.memories, "remote-B")).toMatchObject({ project: "B" });
    expect(await f.kv.get(KV.memories, "legacy-remote")).not.toBeNull();
  });
});

it("filters outgoing actions with the same A-only policy", async () => {
  const f = await fixture("A", ["memories", "actions"]);
  for (const row of [memory("action-A", "A"), memory("action-B", "B"), memory("action-legacy")]) await f.kv.set(KV.actions, row.id, row);
  await f.sync("push");
  const body = JSON.parse(String(f.requests[0].init?.body));
  expect(body.actions.map((row: { id: string }) => row.id)).toEqual(["action-A"]);
  expect(body.memories.map((row: { id: string }) => row.id)).toEqual(["local-A"]);
});

it("rejects foreign actions before writing any valid incoming memory", async () => {
  const f = await fixture("A", ["memories", "actions"]);
  f.incoming({ memories: [memory("remote-A", "A")], actions: [memory("foreign-action", "B")] });
  const result = await f.sync("pull");
  expect(result.results[0].errors.length).toBeGreaterThan(0);
  expect(await f.kv.get(KV.memories, "remote-A")).toBeNull();
  expect(await f.kv.get(KV.actions, "foreign-action")).toBeNull();
});

it("checks ownership again inside the per-row write lock", async () => {
  const f = await fixture(); f.incoming({ memories: [memory("remote-A", "A")] });
  const get = f.kv.get.bind(f.kv); let reads = 0;
  vi.spyOn(f.kv, "get").mockImplementation(async (scope, key) => {
    if (scope === KV.memories && key === "remote-A" && ++reads === 2) await f.kv.set(KV.memories, key, memory(key, "B"));
    return get(scope, key);
  });
  const result = await f.sync("pull");
  expect(result.results[0].errors.length).toBeGreaterThan(0);
  expect(await f.kv.get(KV.memories, "remote-A")).toMatchObject({ project: "B" });
  expect(await f.kv.get(KV.mesh, f.peer.id)).toMatchObject({ lastSyncAt: oldSync });
});

it("invalid later rows do not allow an earlier valid row to be committed", async () => {
  const f = await fixture();
  f.incoming({ memories: [memory("remote-A", "A"), { id: "invalid-A", project: "A", updatedAt: "invalid" }] });
  const result = await f.sync("pull");
  expect(result.results[0].errors.length).toBeGreaterThan(0);
  expect(await f.kv.get(KV.memories, "remote-A")).toBeNull();
});

it("a later storage failure does not advance the cursor and valid rows remain retryable", async () => {
  const f = await fixture(); f.incoming({ memories: [memory("remote-A", "A"), memory("remote-A-2", "A")] });
  const set = f.kv.set.bind(f.kv); let fail = true;
  vi.spyOn(f.kv, "set").mockImplementation(async (scope, key, row) => {
    if (fail && scope === KV.memories && key === "remote-A-2") { fail = false; throw Error("fixture storage unavailable"); }
    return set(scope, key, row);
  });
  const first = await f.sync("pull");
  expect(first.results[0]).toMatchObject({ retryable: true });
  expect(first.results[0].errors.length).toBeGreaterThan(0);
  expect(await f.kv.get(KV.mesh, f.peer.id)).toMatchObject({ lastSyncAt: oldSync });
  const retry = await f.sync("pull");
  expect(retry.results[0].errors).toEqual([]);
  expect(await f.kv.get(KV.memories, "remote-A-2")).toMatchObject({ project: "A" });
  expect(new URL(f.requests.at(-1)!.url).searchParams.get("since")).toBe(oldSync);
});

it("a subset scope override does not skip the other configured collection's delta", async () => {
  const f = await fixture("A", ["memories", "actions"]);
  const result = await f.sync("pull", ["memories"]);
  expect(result.results[0]).toMatchObject({ errors: [], partial: true });
  expect(await f.kv.get(KV.mesh, f.peer.id)).toMatchObject({ lastSyncAt: oldSync });
});

it.each([{ accepted: 1, partial: true }, { accepted: 1, complete: false }, { accepted: 1, errors: ["some rows refused"] }, { success: false, error: "refused" }, {}])("incomplete push acknowledgement preserves the cursor", async acknowledgement => {
  const f = await fixture(); f.fetchStub.mockImplementationOnce(async () => new Response(JSON.stringify(acknowledgement), { status: 200 }));
  const result = await f.sync("push");
  expect(result.results[0].errors.length).toBeGreaterThan(0);
  expect(await f.kv.get(KV.mesh, f.peer.id)).toMatchObject({ lastSyncAt: oldSync });
});
