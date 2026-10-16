import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockKV, mockSdk } from "./helpers/mocks.js";
import { KV } from "../src/state/schema.js";
import { captureEventScope } from "../src/capture/event-record.js";
import type { InboxRecord } from "../src/functions/capture.js";
import { codexTextDigest } from "../src/replay/codex-match.js";
const readers = vi.hoisted(() => ({ index: vi.fn(), inventory: vi.fn() }));
vi.mock("../src/functions/codex-source-index.js", () => ({ readCodexThreadIndex: readers.index }));
vi.mock("../src/replay/codex-inventory.js", () => ({ readCodexInventory: readers.inventory }));
vi.mock("../src/config.js", async importOriginal => ({ ...await importOriginal<Record<string, unknown>>(), getAgentId: () => "owner" }));
import { resolveStoredNativeCapture } from "../src/functions/capture-native-recovery.js";
import { registerCaptureFunctions } from "../src/functions/capture.js";

function fixture() {
  const kv = mockKV();
  const source = { sessionId: "session", cwd: "/original", createdAt: "2026-10-01T00:00:00Z", source: "vscode", relativePath: "sessions/original.jsonl" };
  const text = "Original retained message", textDigest = codexTextDigest(text), key = "a".repeat(64);
  const message = { sessionId: "session", key, kind: "user", turnId: "turn", nativeMessageId: "native", timestamp: "2026-10-10T00:00:00Z", ordinal: 5, byteOffset: 500, textDigest };
  const row = { id: "original", sessionId: "session", project: "legacy", agentId: "owner", narrative: text, codexSource: { ...message, version: 1 } };
  const session = { id: "session", project: "legacy", agentId: "owner", cwd: "/original", codexNativeCapture: { version: 1, source } };
  kv.store.set(KV.sessions, new Map([["session", session]]));
  kv.store.set(KV.observations("session"), new Map([["original", row]]));
  const rec = { key: "cap_" + "b".repeat(40), eventId: "evs_event", eventSource: "server", sessionId: "session", project: "registered", hookType: "prompt_submit", observationId: "failed", status: "dead", attempts: 1, acceptedAt: "2026-10-10T00:00:01Z", updatedAt: "2026-10-10T00:00:02Z", deadAt: "2026-10-10T00:00:02Z", lastError: "Session project mismatch: legacy != registered", payload: { project: "registered", sessionId: "session", hookType: "prompt_submit", cwd: "/current", timestamp: "2026-10-10T00:00:01Z", data: { codex_turn_id: "turn", prompt: JSON.stringify(text) } } } as InboxRecord;
  kv.store.set(KV.captureInbox, new Map([[rec.key, rec]]));
  readers.index.mockResolvedValue({ entries: [{ status: "candidate", sourcePath: "sessions/current.jsonl" }] });
  const inventory = { messages: [message], last: { caughtUp: true, source: { ...source, relativePath: "sessions/current.jsonl" } } };
  readers.inventory.mockResolvedValue(inventory);
  return { kv, rec, row, session, inventory };
}

describe("native original correspondence for explicit legacy capture retry", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("AGENTMEMORY_CODEX_SOURCE_ROOT", "/source"); });
  afterEach(() => vi.unstubAllEnvs());
  it("proves the exact turn and source while preserving both project identities", async () => {
    const { kv, rec, session } = fixture();
    expect(await resolveStoredNativeCapture(kv as never, rec, new Map())).toEqual({ observationId: "original", sourceProject: "legacy", sourceKey: "a".repeat(64), turnId: "turn" });
    expect(session.project).toBe("legacy"); expect(rec.project).toBe("registered");
  });
  it("retains failure when the native original has not been stored", async () => {
    const { kv, rec } = fixture(); kv.store.get(KV.observations("session"))!.clear();
    expect(await resolveStoredNativeCapture(kv as never, rec, new Map())).toBeNull();
  });
  it("does not match repeated text from a different turn", async () => {
    const { kv, rec } = fixture(); (rec.payload.data as Record<string, unknown>).codex_turn_id = "another-turn";
    expect(await resolveStoredNativeCapture(kv as never, rec, new Map())).toBeNull();
  });
  it("does not resolve deleted original data", async () => {
    const { kv, rec, row } = fixture(); Object.assign(row, { emptyDeletion: { state: "deleted" } });
    expect(await resolveStoredNativeCapture(kv as never, rec, new Map())).toBeNull();
  });
  it("requires complete and unchanged native source identity", async () => {
    const { kv, rec, inventory } = fixture(); inventory.last.caughtUp = false;
    expect(await resolveStoredNativeCapture(kv as never, rec, new Map())).toBeNull();
    inventory.last.caughtUp = true; inventory.last.source.createdAt = "2026-10-02T00:00:00Z";
    expect(await resolveStoredNativeCapture(kv as never, rec, new Map())).toBeNull();
  });
  it("rejects conflicting or incorrect stored provenance", async () => {
    const { kv, rec, row } = fixture(); row.codexSource.byteOffset++;
    expect(await resolveStoredNativeCapture(kv as never, rec, new Map())).toBeNull();
  });
  it("keeps client events and unrelated failures on the existing retry path", async () => {
    const { kv, rec } = fixture(); rec.eventSource = "client";
    expect(await resolveStoredNativeCapture(kv as never, rec, new Map())).toBeNull();
    rec.eventSource = "server"; rec.lastError = "storage unavailable";
    expect(await resolveStoredNativeCapture(kv as never, rec, new Map())).toBeNull();
    expect(readers.inventory).not.toHaveBeenCalled();
  });
  it("keeps the original failure intact when source verification cannot run", async () => {
    const { kv, rec } = fixture(); const before = structuredClone(rec);
    readers.inventory.mockRejectedValue(new Error("source is unavailable"));
    const sdk = mockSdk(); const observe = vi.fn(); sdk.registerFunction("mem::observe", observe);
    const controller = registerCaptureFunctions(sdk as never, kv as never);
    expect(await sdk.trigger("mem::capture-retry", { eventId: rec.eventId })).toEqual({ matched: 1, recovered: 0, dead: 1, waiting: 0 });
    expect(await kv.get(KV.captureInbox, rec.key)).toEqual(before);
    expect(observe).not.toHaveBeenCalled(); controller.stop();
  });

  it("explicit retry removes only the proven failed job and keeps its error/source receipt", async () => {
    const { kv, rec, row } = fixture(); const before = structuredClone(row);
    const sdk = mockSdk(); const observe = vi.fn(async () => ({ success: false, error: rec.lastError }));
    sdk.registerFunction("mem::observe", observe); const controller = registerCaptureFunctions(sdk as never, kv as never);
    expect(await sdk.trigger("mem::capture-retry", { eventId: rec.eventId })).toEqual({ matched: 1, recovered: 1, dead: 0, waiting: 0 });
    expect(await kv.get(KV.captureInbox, rec.key)).toBeNull();
    expect(await kv.get(KV.observations("session"), "original")).toEqual(before);
    expect(await kv.get(captureEventScope(rec.key), rec.key)).toMatchObject({ project: "registered", observationId: "original", nativeSourceRecovery: { sourceProject: "legacy", previousError: rec.lastError, previousDeadAt: rec.deadAt, previousAttempts: 1 } });
    expect(observe).not.toHaveBeenCalled(); controller.stop();
  });
});
