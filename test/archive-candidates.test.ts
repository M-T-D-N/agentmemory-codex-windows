import { afterEach, describe, expect, it, vi } from "vitest";
import { mockKV, mockSdk } from "./helpers/mocks.js";
import { KV } from "../src/state/schema.js";
import { registerArchiveFunctions, parseArchiveToolInput } from "../src/functions/archive-tools.js";
import { registerRetentionFunctions } from "../src/functions/retention.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { registerMcpEndpoints } from "../src/mcp/server.js";

vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const now = "2026-09-14T00:00:00.000Z";
afterEach(() => vi.useRealTimers());
async function fixture(engineMetadata: boolean) {
  vi.useFakeTimers(); vi.setSystemTime(new Date(now));
  const kv = mockKV(), sdk = mockSdk({ looseTrigger: true });
  registerArchiveFunctions(sdk as never, kv as never);
  if (engineMetadata) {
    const handler = sdk.fns.get("mem::archive")!;
    sdk.fns.set("mem::archive", data => handler(data && typeof data === "object" && !Array.isArray(data)
      ? { ...data, _caller_worker_id: "engine-worker-id" } : data));
  }
  registerRetentionFunctions(sdk as never, kv as never);
  const call = (data: object) => sdk.trigger("mem::archive", data) as Promise<any>;
  const put = async (id: string, extra: object = {}) => kv.set(KV.memories, id, { id, project: "p", type: "fact", isLatest: true,
    content: "private original", createdAt: "2025-09-14T00:00:00.000Z", updatedAt: now, ...extra });
  return { kv, sdk, call, put };
}

describe.each([false, true])("read-only exact-project retention and TTL archive candidates (engine metadata: %s)", engineMetadata => {
  it("uses fresh shared retention rules, keeps recently accessed memories, combines reasons and preserves all stores", async () => {
    const f = await fixture(engineMetadata);
    await f.put("old", { forgetAfter: "2026-09-13T00:00:00.000Z" });
    await f.put("used"); await f.put("other", { project: "other" });
    await f.kv.set(KV.accessLog, "used", { memoryId: "used", count: 1, lastAt: "2026-09-13T00:00:00.000Z", recent: [Date.parse(now) - 86400000] });
    await f.kv.set(KV.retentionScores, "old", { memoryId: "old", score: 1, source: "semantic" });
    const before = structuredClone(f.kv.store);
    const result = await f.call({ action: "candidates", project: "p" });
    expect(result).toMatchObject({ success: true, dryRun: true, evaluatedAt: now, total: 1, reviewRequired: true, automaticArchiveEnabled: false,
      candidates: [{ target: { kind: "memory", id: "old" }, reasons: ["retention-score-below-threshold", "ttl-expired"] }] });
    expect(result.candidates[0].retentionScore).toBeCloseTo(0.5 * Math.exp(-3.65));
    expect(JSON.stringify(result)).not.toContain("private original");
    expect(f.kv.store).toEqual(before);
    const scored = await f.sdk.trigger("mem::retention-score", {}) as any;
    expect(scored.scores.find((s: any) => s.memoryId === "old").score).toBe(result.candidates[0].retentionScore);
  });
  it("resolves semantic provenance before pagination and excludes mixed, orphan, hidden and deleted targets", async () => {
    const f = await fixture(engineMetadata);
    await f.kv.set(KV.sessions, "s", { id: "s", project: "p" });
    await f.kv.set(KV.sessions, "other", { id: "other", project: "q" });
    for (const [id, sourceSessionIds] of [["a", ["s"]], ["mixed", ["s", "other"]], ["orphan", ["missing"]]] as const) {
      await f.kv.set(KV.semantic, id, { id, sourceSessionIds, confidence: 0.8, accessCount: 0, createdAt: "2025-09-14T00:00:00.000Z" });
    }
    await f.put("hidden"); await f.put("deleted", { deleted: true }); await f.put("z");
    const preview = await f.call({ action: "archive", project: "p", target: { kind: "memory", id: "hidden" } });
    await f.call({ action: "archive", project: "p", target: preview.target, expectedDigest: preview.expectedDigest,
      expectedRevision: preview.expectedRevision, reason: "Reviewed", dryRun: false });
    const before = structuredClone(f.kv.store);
    expect(await f.call({ action: "candidates", project: "p", limit: 1 })).toMatchObject({ total: 2, nextOffset: 1, candidates: [{ target: { kind: "memory", id: "z" } }] });
    expect(await f.call({ action: "candidates", project: "p", limit: 1, offset: 1 })).toMatchObject({ total: 2, nextOffset: null, candidates: [{ target: { kind: "semantic", id: "a" } }] });
    expect(f.kv.store).toEqual(before);
  });
  it("preserves strict TTL and score boundaries and reports invalid policy dates", async () => {
    const f = await fixture(engineMetadata);
    await f.put("boundary", { createdAt: now, forgetAfter: now });
    await f.put("past-version", { isLatest: false, forgetAfter: "2026-09-13T00:00:00.000Z" });
    await f.put("invalid", { createdAt: "unknown", forgetAfter: "unknown" });
    expect(await f.call({ action: "candidates", project: "p", threshold: 0.5 })).toMatchObject({ total: 1, invalidPolicyRecords: 1,
      candidates: [{ target: { id: "past-version" }, reasons: ["ttl-expired"] }] });
    expect(await f.call({ action: "candidates", project: "p", policy: "retention", threshold: 0 })).toMatchObject({ total: 0 });
  });
  it("fails closed on access history read failures without writing scores or claiming no candidates", async () => {
    const f = await fixture(engineMetadata); await f.put("old");
    const original = f.kv.list.bind(f.kv);
    vi.spyOn(f.kv, "list").mockImplementation(async (scope: string) => {
      if (scope === KV.accessLog) throw Error("history unavailable"); return original(scope);
    });
    const before = structuredClone(f.kv.store);
    await expect(f.call({ action: "candidates", project: "p" })).rejects.toThrow("history unavailable");
    expect(f.kv.store).toEqual(before);
    expect(await f.call({ action: "candidates", project: "p", policy: "ttl" })).toMatchObject({ total: 0, dryRun: true });
    expect(f.kv.store).toEqual(before);
  });
  it("exposes read-only candidate policy on both official transports and rejects write flags", async () => {
    const f = await fixture(engineMetadata); await f.put("old");
    registerApiTriggers(f.sdk as never, f.kv as never, async () => ({ context: "", blocks: 0, tokens: 0 }));
    registerMcpEndpoints(f.sdk as never, f.kv as never);
    const request = { action: "candidates", project: "p", policy: "retention" };
    expect(await f.sdk.trigger("api::archive", { body: request })).toMatchObject({ status_code: 200, body: { total: 1, dryRun: true } });
    const mcp = await f.sdk.trigger("mcp::tools::call", { headers: {}, body: { name: "memory_archive", arguments: request } }) as any;
    expect(JSON.parse(mcp.body.content[0].text)).toMatchObject({ total: 1, dryRun: true });
    for (const extra of [{ dryRun: false }, { target: { kind: "memory", id: "old" } }, { threshold: NaN }, { policy: "delete" }, { limit: 101 }, { offset: -1 }, { project: "*" }]) {
      expect(() => parseArchiveToolInput({ ...request, ...extra })).toThrow();
    }
  });
});
