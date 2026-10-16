import { describe, expect, it, vi } from "vitest";
import { mockKV } from "./helpers/mocks.js";
import { KV } from "../src/state/schema.js";
import type { CompressedObservation, Session } from "../src/types.js";
import { changeArchiveState } from "../src/functions/archive.js";
import { unresolvedCodexCapture } from "../src/replay/codex-unresolved-capture.js";
import { readCodexSourceStatus } from "../src/functions/codex-source-status.js";

const session = (id: string, extra = {}): Session => ({ id, project: "p", agentId: "mine", cwd: "C:/source",
  startedAt: "2026-01-01T00:00:00Z", observationCount: 1, status: "active", codexNativeCapture: {
    version: 1, initializedAt: "2026-01-01T00:00:00Z", checkedAt: "2026-01-01T00:00:00Z",
    source: { sessionId: id, cwd: "C:/source", source: "cli", createdAt: "2026-01-01T00:00:00Z", relativePath: "private/path" },
    status: "caught_up", cursor: { byteOffset: 0 } as never,
  }, ...extra });
const archive = async (kv: ReturnType<typeof mockKV>, target: { kind: "session" | "observation"; id: string; sessionId?: string }) => {
  const request = { project: "p", target, action: "archive" as const };
  const preview = await changeArchiveState(kv as never, request);
  await changeArchiveState(kv as never, { ...request, dryRun: false, expectedDigest: preview.expectedDigest,
    expectedRevision: preview.expectedRevision, reason: "Reviewed exact historical original" });
};
async function closed(kv: ReturnType<typeof mockKV>, id: string) {
  const row = session(id);
  const observation = { id: `legacy-${id}`, sessionId: id, agentId: "mine", narrative: "private original content",
    title: "prompt_submit", type: "conversation", timestamp: "2026-01-01T00:00:00Z", confidence: 0.3, importance: 5 } as CompressedObservation;
  row.codexNativeCapture!.unresolvedCaptures = [unresolvedCodexCapture(observation, { sessionId: id, project: "p", agentId: "mine" })];
  await kv.set(KV.sessions, id, row);
  await kv.set(KV.observations(id), observation.id, observation);
  await archive(kv, { kind: "observation", sessionId: id, id: observation.id });
  return observation;
}
describe("read-only native capture reporting", () => {
  it("counts a stored source error and its failed RPC wrapper at the same time as one event", async () => {
    const kv = mockKV(), failed = session("same-event");
    failed.codexNativeCapture!.status = "unknown"; failed.codexNativeCapture!.issue = "native_source_read_failed";
    failed.codexNativeCapture!.lastFailure = { reason: "native_capture_rpc_failed", observedAt: failed.codexNativeCapture!.checkedAt! };
    await kv.set(KV.sessions, failed.id, failed);
    expect(await readCodexSourceStatus(kv as never, "mine")).toMatchObject({ uniqueSessionCount: 1, uniqueEventCount: 1,
      issueCount: 2, components: { unknownSessions: 1, failureSessions: 1 } });
    delete failed.codexNativeCapture!.checkedAt;
    expect((await readCodexSourceStatus(kv as never, "mine")).uniqueEventCount).toBeNull();
  });

  it("keeps closed 9+1+5 out of ordinary reporting and preserves explicit exact history", async () => {
    const kv = mockKV();
    for (let i = 0; i < 9; i++) await closed(kv, `reviewed-${i}`);
    const holder = session("held");
    holder.codexNativeCapture!.version = 2;
    holder.codexNativeCapture!.sourceHolds = [{ sessionId: holder.id, turnId: "held-turn", itemId: "held-item",
      ordinal: 1, byteOffset: 0, completionOrdinal: 2, completionByteOffset: 1, reason: "unmatched_user_display",
      recordDigest: "a".repeat(64), textDigest: "b".repeat(64), completionDigest: "c".repeat(64) }];
    await kv.set(KV.sessions, holder.id, holder);
    for (let i = 0; i < 5; i++) {
      const row = session(`archived-${i}`);
      row.codexNativeCapture!.status = "unknown"; row.codexNativeCapture!.issue = "native_source_missing";
      await kv.set(KV.sessions, row.id, row); await archive(kv, { kind: "session", id: row.id });
    }
    const before = structuredClone(kv.store);
    const report = await readCodexSourceStatus(kv as never, "mine");
    expect(report).toMatchObject({ readOnly: true, status: "checking", complete: true, uniqueSessionCount: 0, issueCount: 0, issues: [] });
    expect(report).not.toHaveProperty("history");
    expect(JSON.stringify(report)).not.toMatch(/private|reviewed|legacy|archived|sourceHolds/);
    const historical = await readCodexSourceStatus(kv as never, "mine", { includeHistory: true });
    expect(historical.history).toMatchObject({ archivedUnavailableSessions: 5, approvedSourceHolds: 1 });
    expect(historical.history?.reviewedLegacy).toHaveLength(9);
    expect(kv.store).toEqual(before);
  });
  it("keeps ordinary enrichment closed but reopens a changed source fingerprint or exact restored target", async () => {
    const kv = mockKV(), observation = await closed(kv, "reviewed");
    observation.importance = 10; observation.facts = ["normal enrichment"]; observation.concepts = ["normal"];
    expect((await readCodexSourceStatus(kv as never, "mine")).status).toBe("checking");
    observation.narrative = "new relevant original";
    expect((await readCodexSourceStatus(kv as never, "mine")).issues[0]).toMatchObject({ reason: "unresolved_capture_correspondence_changed" });
    observation.narrative = "private original content";
    const request = { project: "p", target: { kind: "observation" as const, sessionId: "reviewed", id: observation.id }, action: "restore" as const };
    const preview = await changeArchiveState(kv as never, request);
    await changeArchiveState(kv as never, { ...request, dryRun: false, expectedDigest: preview.expectedDigest,
      expectedRevision: preview.expectedRevision, reason: "Explicit historical review" });
    expect((await readCodexSourceStatus(kv as never, "mine")).issues[0]).toMatchObject({ reason: "unresolved_capture_requires_review" });
  });
  it("reports only new errors in mixed history, counts overlapping categories as one target, and pages distinct issues", async () => {
    const kv = mockKV(); await closed(kv, "closed");
    const failed = session("failed");
    failed.codexNativeCapture!.status = "unknown"; failed.codexNativeCapture!.issue = "native_capture_rpc_failed";
    await kv.set(KV.sessions, failed.id, failed);
    const report = await readCodexSourceStatus(kv as never, "mine", { limit: 1 });
    expect(report).toMatchObject({ components: { unknownSessions: 1, reconciliationSessions: 0, failureSessions: 1 },
      uniqueSessionCount: 1, uniqueEventCount: 1, issueCount: 2, nextOffset: 1, status: "attention" });
    const next = await readCodexSourceStatus(kv as never, "mine", { limit: 1, offset: 1 });
    expect(next.nextOffset).toBeNull();
    expect(next.issues[0].category).not.toBe(report.issues[0].category);
    expect(JSON.stringify([report, next])).not.toContain("private");
  });
  it("keeps absent-source history closed while showing a new source read failure on that exact target", async () => {
    const kv = mockKV(), row = session("archived");
    row.codexNativeCapture!.status = "unknown"; row.codexNativeCapture!.issue = "native_source_missing";
    await kv.set(KV.sessions, row.id, row); await archive(kv, { kind: "session", id: row.id });
    expect((await readCodexSourceStatus(kv as never, "mine")).issueCount).toBe(0);
    row.codexNativeCapture!.issue = "native_source_read_failed";
    expect((await readCodexSourceStatus(kv as never, "mine")).issues[0].reason).toBe("native_source_read_failed");
  });
  it("returns unavailable with unknown counts on archive failures or pending verification without leaking originals", async () => {
    const kv = mockKV(); await closed(kv, "reviewed");
    vi.spyOn(kv, "list").mockRejectedValueOnce(Error("private archive path"));
    expect(await readCodexSourceStatus(kv as never, "mine")).toMatchObject({ status: "unavailable", complete: false,
      components: null, uniqueSessionCount: null, issueCount: null, issues: [] });
    const rows = await kv.list<Record<string, unknown>>(KV.archiveStates);
    rows[0].importPendingDigest = "a".repeat(64);
    expect(await readCodexSourceStatus(kv as never, "mine")).toMatchObject({ status: "unavailable", complete: false });
  });
  it("does not treat a foreign owner or ambient capture as current work", async () => {
    const kv = mockKV();
    for (const extra of [{ agentId: "foreign" }, { captureExcluded: true, captureExclusionReason: "codex_internal_prompt" }]) {
      const row = session("outside", extra); row.codexNativeCapture!.status = "unknown";
      await kv.set(KV.sessions, row.id, row);
      expect((await readCodexSourceStatus(kv as never, "mine")).uniqueSessionCount).toBe(0);
    }
    await expect(readCodexSourceStatus(kv as never, "mine", { project: "*" })).rejects.toThrow("Invalid capture status selection");
  });
});
