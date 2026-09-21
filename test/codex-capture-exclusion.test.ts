import { afterEach, describe, expect, it, vi } from "vitest";
import { mockKV } from "./helpers/mocks.js";
import { codexExclusionId, prepareCodexExclusionImport, retainCodexForgetExclusions, validateCodexExclusion } from "../src/functions/codex-capture-exclusion.js";
import { codexTextDigest, matchCodexMessages } from "../src/replay/codex-match.js";
import { KV } from "../src/state/schema.js";
import type { CodexCaptureExclusion, ExportData, Session } from "../src/types.js";
import type { CodexNativeMessage } from "../src/replay/codex-record.js";

const session: Session = { id: "s", project: "p", cwd: "C:/p", startedAt: "2026-09-13T00:00:00Z", status: "active", observationCount: 1 };
const timestamp = "2026-09-13T00:01:00Z";
const row = { id: "o", sessionId: "s", title: "prompt_submit", timestamp, narrative: "forgotten secret body" };
const message: CodexNativeMessage = { sessionId: "s", key: codexTextDigest("source-a"), nativeMessageId: "source-a",
  turnId: "turn-a", kind: "user", timestamp, text: row.narrative, ordinal: 3, byteOffset: 200 };
const scope = { sessionId: "s", project: "p", agentId: "codex-global", completeNativeInventory: true };
const emptyExport = (): ExportData => ({ version: "0.9.29-codex-lifecycle-1", exportedAt: timestamp,
  sessions: [], observations: {}, memories: [], summaries: [] });
afterEach(() => vi.unstubAllEnvs());

describe("Codex forgotten source identity", () => {
  it("retains only a minimal digest and identities, and is idempotent", async () => {
    vi.stubEnv("AGENTMEMORY_CODEX_SOURCE_ROOT", "C:/native");
    const kv = mockKV();
    await retainCodexForgetExclusions(kv as never, session, [row], false);
    const before = await kv.list<CodexCaptureExclusion>(KV.codexCaptureExclusions);
    expect(before).toMatchObject([{ observationId: "o", match: { kind: "legacy", messageKind: "user", timestamp, textDigest: codexTextDigest(row.narrative) } }]);
    expect(JSON.stringify(before)).not.toContain(row.narrative);
    await retainCodexForgetExclusions(kv as never, session, [row], false);
    expect(await kv.list(KV.codexCaptureExclusions)).toEqual(before);
    expect(matchCodexMessages([message], [], { ...scope, exclusions: before })[0]).toMatchObject({ action: "excluded", reason: "intentionally_forgotten_capture" });
    const repeat = { ...message, key: codexTextDigest("source-b"), nativeMessageId: "source-b" };
    expect(matchCodexMessages([message, repeat], [], { ...scope, exclusions: before }).map(row => row.action)).toEqual(["blocked", "blocked"]);
    expect(matchCodexMessages([message], [], { ...scope, completeNativeInventory: false, exclusions: before })[0]).toMatchObject({ action: "blocked" });
  });
  it("retains native keys even outside the managed host and does not exclude another message", async () => {
    vi.stubEnv("AGENTMEMORY_CODEX_SOURCE_ROOT", "");
    const kv = mockKV();
    await retainCodexForgetExclusions(kv as never, session, [{ ...row, codexSource: { key: message.key } }], false);
    const exclusions = await kv.list<CodexCaptureExclusion>(KV.codexCaptureExclusions);
    const other = { ...message, key: codexTextDigest("other"), nativeMessageId: "other" };
    expect(matchCodexMessages([message, other], [], { ...scope, exclusions, completeNativeInventory: false }).map(row => row.action)).toEqual(["excluded", "insert"]);
    await expect(prepareCodexExclusionImport(kv as never, { ...emptyExport(), observations: {
      s: [{ ...row, id: "different-id", codexSource: { key: message.key } } as never],
    } })).rejects.toThrow("restore forgotten Codex capture");
  });
  it("does not guess a missing legacy timestamp or treat a surviving forgotten row as absent", async () => {
    vi.stubEnv("AGENTMEMORY_CODEX_SOURCE_ROOT", "C:/native");
    const kv = mockKV();
    await retainCodexForgetExclusions(kv as never, session, [{ ...row, timestamp: undefined }], false);
    const exclusions = await kv.list<CodexCaptureExclusion>(KV.codexCaptureExclusions);
    expect(exclusions[0]!.match).toEqual({ kind: "unresolved" });
    expect(matchCodexMessages([message], [], { ...scope, exclusions })[0]).toMatchObject({ action: "blocked", reason: "unresolved_forgotten_capture" });
    await kv.set(KV.codexCaptureExclusions, exclusions[0]!.id, { ...exclusions[0], match: { kind: "source", sourceKey: message.key } });
    expect(matchCodexMessages([message], [{ ...row, type: "conversation", facts: [], concepts: [], files: [], importance: 5, agentId: "codex-global" }],
      { ...scope, exclusions: await kv.list(KV.codexCaptureExclusions) })[0]).toMatchObject({ action: "blocked", reason: "forgotten_capture_still_present" });
  });
  it("preserves whole-session suppression after canonical session deletion", async () => {
    vi.stubEnv("AGENTMEMORY_CODEX_SOURCE_ROOT", "C:/native");
    const kv = mockKV();
    await retainCodexForgetExclusions(kv as never, session, [], true);
    const exclusions = await kv.list<CodexCaptureExclusion>(KV.codexCaptureExclusions);
    expect(exclusions).toMatchObject([{ id: codexExclusionId("s"), match: { kind: "session" } }]);
    const cutoff = Date.parse(exclusions[0]!.forgottenAt);
    expect(matchCodexMessages([{ ...message, timestamp: new Date(cutoff).toISOString() }], [], { ...scope, exclusions })[0]).toMatchObject({ action: "excluded" });
    expect(matchCodexMessages([{ ...message, timestamp: new Date(cutoff + 1).toISOString() }], [], { ...scope, exclusions })[0]).toMatchObject({ action: "insert" });
    await expect(prepareCodexExclusionImport(kv as never, { ...emptyExport(), sessions: [session] })).rejects.toThrow("restore forgotten Codex capture");
    await expect(prepareCodexExclusionImport(kv as never, emptyExport())).resolves.toEqual([]);
  });
  it("rejects injected content, mismatched source scope and conflicting imported exclusions without writes", async () => {
    vi.stubEnv("AGENTMEMORY_CODEX_SOURCE_ROOT", "C:/native");
    const kv = mockKV();
    await retainCodexForgetExclusions(kv as never, session, [row], false);
    const [exclusion] = await kv.list<CodexCaptureExclusion>(KV.codexCaptureExclusions);
    expect(() => validateCodexExclusion({ ...exclusion, narrative: "not allowed" })).toThrow("Invalid Codex capture exclusion");
    expect(() => matchCodexMessages([message], [], { ...scope, exclusions: [{ ...exclusion!, project: "other" }] })).toThrow("different project");
    await expect(prepareCodexExclusionImport(kv as never, { ...emptyExport(), codexCaptureExclusions: [{ ...exclusion!, project: "other" }] })).rejects.toThrow("Conflicting");
    expect(await kv.list(KV.codexCaptureExclusions)).toEqual([exclusion]);
  });
  it("leaves portable upstream and nonconversation partial forget behavior alone", async () => {
    const kv = mockKV();
    vi.stubEnv("AGENTMEMORY_CODEX_SOURCE_ROOT", "");
    await retainCodexForgetExclusions(kv as never, session, [row], false);
    vi.stubEnv("AGENTMEMORY_CODEX_SOURCE_ROOT", "C:/native");
    await retainCodexForgetExclusions(kv as never, session, [{ id: "manual", sessionId: "s", title: "manual decision" }], false);
    expect(await kv.list(KV.codexCaptureExclusions)).toEqual([]);
  });
  it("keeps the later whole-session boundary when exclusions are merged", async () => {
    const kv = mockKV();
    const older: CodexCaptureExclusion = { version: 1, id: codexExclusionId("s"), sessionId: "s", project: "p",
      forgottenAt: "2026-09-13T00:00:00Z", match: { kind: "session" } };
    await kv.set(KV.codexCaptureExclusions, older.id, older);
    const newer = { ...older, forgottenAt: "2026-09-13T01:00:00Z" };
    expect(await prepareCodexExclusionImport(kv as never, { ...emptyExport(), codexCaptureExclusions: [newer] })).toEqual([newer]);
    await kv.set(KV.codexCaptureExclusions, older.id, newer);
    expect(await prepareCodexExclusionImport(kv as never, { ...emptyExport(), codexCaptureExclusions: [older] })).toEqual([]);
    await kv.set(KV.sessions, "s", session);
    await expect(prepareCodexExclusionImport(kv as never, { ...emptyExport(), codexCaptureExclusions: [
      { ...newer, forgottenAt: "2026-09-13T02:00:00Z" },
    ] })).rejects.toThrow("surviving canonical session");
  });
});
