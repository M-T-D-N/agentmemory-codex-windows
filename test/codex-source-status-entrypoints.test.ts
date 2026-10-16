import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockKV, mockSdk } from "./helpers/mocks.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { readCodexSourceStatus } from "../src/functions/codex-source-status.js";
import { registerExportImportFunction } from "../src/functions/export-import.js";
import { registerMcpEndpoints } from "../src/mcp/server.js";
import * as config from "../src/config.js";
import { KV } from "../src/state/schema.js";
import { changeArchiveState } from "../src/functions/archive.js";
import { unresolvedCodexCapture } from "../src/replay/codex-unresolved-capture.js";
import type { CompressedObservation, Session } from "../src/types.js";

const row = (id: string): Session => ({ id, project: "p", agentId: "mine", cwd: "C:/source", startedAt: "2026-01-01T00:00:00Z",
  observationCount: 0, status: "active", codexNativeCapture: { version: 1, initializedAt: "2026-01-01T00:00:00Z",
    checkedAt: "2026-01-01T00:00:00Z", status: "caught_up", cursor: { byteOffset: 0 } as never,
    source: { sessionId: id, cwd: "C:/source", createdAt: "2026-01-01T00:00:00Z", source: "cli", relativePath: "private/path" } } });
const request = (query_params = {}, body = {}, authenticated = true) => ({ query_params, body,
  headers: authenticated ? { authorization: "Bearer test-secret", accept: "application/json" } : {} });
let kv: ReturnType<typeof mockKV>, sdk: ReturnType<typeof mockSdk>;
beforeEach(() => {
  vi.stubEnv("AGENTMEMORY_CODEX_SOURCE_ROOT", "C:/native");
  vi.spyOn(config, "getAgentId").mockReturnValue("mine");
  kv = mockKV(); sdk = mockSdk({ looseTrigger: true });
  registerApiTriggers(sdk as never, kv as never, (() => ({})) as never, "test-secret", undefined, undefined, undefined,
    () => ({ captureSnapshot: { observedAt: new Date().toISOString(), cycleComplete: true, freshness: "current",
      components: { unknownSessions: 0, reconciliationSessions: 0, batchFailureEvents: 0 } } }));
  registerMcpEndpoints(sdk as never, kv as never, "test-secret", () => ({ captureSnapshot: {
    observedAt: new Date().toISOString(), cycleComplete: true, freshness: "current",
    components: { unknownSessions: 0, reconciliationSessions: 0, batchFailureEvents: 0 } } }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
async function seedClosed() {
  const session = row("closed");
  const original = { id: "legacy", sessionId: session.id, agentId: "mine", type: "conversation", title: "prompt_submit",
    narrative: "private original never returned", timestamp: "2026-01-01T00:00:00Z", confidence: 0.3, importance: 5 } as CompressedObservation;
  session.codexNativeCapture!.unresolvedCaptures = [unresolvedCodexCapture(original, { sessionId: session.id, project: "p", agentId: "mine" })];
  await kv.set(KV.sessions, session.id, session); await kv.set(KV.observations(session.id), original.id, original);
  const input = { project: "p", target: { kind: "observation" as const, sessionId: session.id, id: original.id }, action: "archive" as const };
  const preview = await changeArchiveState(kv as never, input);
  await changeArchiveState(kv as never, { ...input, dryRun: false, expectedRevision: preview.expectedRevision,
    expectedDigest: preview.expectedDigest, reason: "Reviewed historical original" });
}
describe("source status through existing REST and MCP handlers", () => {
  it("does not hide an unresolved failure after the official native export/import boundary", async () => {
    const failed = row("transfer");
    failed.codexNativeCapture!.source.relativePath = "sessions/rollout-transfer.jsonl";
    failed.codexNativeCapture!.status = "unknown";
    failed.codexNativeCapture!.issue = "native_capture_rpc_failed";
    failed.codexNativeCapture!.lastFailure = { reason: "native_capture_rpc_failed", observedAt: "2026-01-01T00:00:00Z" };
    await kv.set(KV.sessions, failed.id, failed);
    const before = structuredClone(kv.store);
    registerExportImportFunction(sdk as never, kv as never);
    const exported = await sdk.trigger("mem::export", {});
    expect(kv.store).toEqual(before);
    const freshKv = mockKV(), freshSdk = mockSdk();
    registerExportImportFunction(freshSdk as never, freshKv as never);
    expect(await freshSdk.trigger("mem::import", { exportData: exported })).toMatchObject({ success: true });
    const report = await readCodexSourceStatus(freshKv as never, "mine");
    expect(report).toMatchObject({ status: "attention", complete: true, uniqueSessionCount: 1,
      components: { reconciliationSessions: 1 } });
    expect(report.issues).toContainEqual(expect.objectContaining({ reason: "canonical_capture_state_requires_reconciliation" }));
  });

  it("omits retired history on both normal surfaces without collection or writes", async () => {
    await seedClosed();
    const before = structuredClone(kv.store), writes = vi.spyOn(kv, "set"), deletes = vi.spyOn(kv, "delete");
    const collect = vi.fn(); sdk.registerFunction("mem::codex-source-drain", collect);
    const rest = await sdk.trigger("api::status", request()) as { status_code: number; body: Record<string, any> };
    expect(rest.status_code).toBe(200);
    expect(rest.body.nativeCapture).toMatchObject({ complete: true, uniqueSessionCount: 0, uniqueEventCount: 0, issues: [],
      batch: { scope: "latest_drain", freshness: "current", cycleComplete: true } });
    expect(rest.body.nativeCapture).not.toHaveProperty("history");
    expect(rest.body.problems).not.toContainEqual(expect.objectContaining({ code: "native-capture-attention" }));
    const mcp = await sdk.trigger("mcp::resources::read", request({}, { uri: "agentmemory://status" })) as { status_code: number; body: { contents: Array<{ text: string }> } };
    const resource = JSON.parse(mcp.body.contents[0].text);
    expect(resource.nativeCapture).toMatchObject({ complete: true, uniqueSessionCount: 0, issues: [], batch: { freshness: "current", cycleComplete: true } });
    expect(JSON.stringify([rest.body.nativeCapture, resource])).not.toMatch(/private|legacy|reviewedLegacy/);
    expect(collect).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); expect(deletes).not.toHaveBeenCalled();
    expect(kv.store).toEqual(before);
    const history = await sdk.trigger("api::status", request({ nativeHistory: "true", nativeProject: "p" })) as { body: Record<string, any> };
    expect(history.body.nativeCapture.history.reviewedLegacy[0]).toMatchObject({ observationId: "legacy", revision: 1,
      disposition: "archived_reviewed_original" });
  });
  it("pages current errors without double-counting one failure as two events", async () => {
    for (const id of ["failed-a", "failed-b"]) {
      const session = row(id); session.codexNativeCapture!.status = "unknown";
      session.codexNativeCapture!.issue = "native_capture_rpc_failed"; await kv.set(KV.sessions, id, session);
    }
    const records = new Set<string>();
    for (let offset = 0; offset < 4; offset++) {
      const result = await sdk.trigger("api::status", request({ nativeLimit: "1", nativeOffset: String(offset) })) as { body: Record<string, any> };
      expect(result.body.nativeCapture).toMatchObject({ uniqueSessionCount: 2, uniqueEventCount: 2, issueCount: 4 });
      const issue = result.body.nativeCapture.issues[0]; records.add(issue.sessionId + ":" + issue.category);
      expect(result.body.problems).toContainEqual(expect.objectContaining({ code: "native-capture-attention" }));
    }
    expect(records.size).toBe(4);
  });
  it("returns a failed verification rather than leaked content or a healthy source report", async () => {
    await seedClosed();
    const list = kv.list.bind(kv);
    vi.spyOn(kv, "list").mockImplementation(async scope => { if (scope === KV.archiveStates) throw Error("private archive path"); return list(scope); });
    const rest = await sdk.trigger("api::status", request()) as { body: Record<string, any> };
    expect(rest.body.nativeCapture).toMatchObject({ status: "unavailable", complete: false, uniqueSessionCount: null });
    expect(rest.body.problems).toContainEqual(expect.objectContaining({ code: "native-capture-unverified" }));
    expect(JSON.stringify(rest.body.nativeCapture)).not.toContain("private");
    const mcp = await sdk.trigger("mcp::resources::read", request({}, { uri: "agentmemory://status" })) as { body: { contents: Array<{ text: string }> } };
    expect(JSON.parse(mcp.body.contents[0].text).nativeCapture).toMatchObject({ status: "unavailable", complete: false });
  });
  it("preserves authentication and rejects invalid exact source selection", async () => {
    expect(await sdk.trigger("api::status", request({}, {}, false))).toMatchObject({ status_code: 401 });
    for (const query of [{ nativeProject: "*" }, { nativeProject: " p " }, { nativeLimit: "0" }, { nativeOffset: "-1" }, { nativeHistory: "invalid" }]) {
      expect(await sdk.trigger("api::status", request(query))).toMatchObject({ status_code: 400 });
    }
  });
});
