import { describe, expect, it } from "vitest";
import { codexMessageReference, codexTextDigest, matchCodexMessages, unmatchedCodexCaptures } from "../src/replay/codex-match.js";
import type { CodexNativeMessage } from "../src/replay/codex-record.js";
import type { CompressedObservation } from "../src/types.js";

const scope = { sessionId: "session-a", project: "a", agentId: "codex-global", completeNativeInventory: true };
const message = (id: string, timestamp = "2026-09-13T00:00:00Z", text = "진행"): CodexNativeMessage => ({
  key: codexTextDigest(id), sessionId: scope.sessionId, nativeMessageId: id, turnId: "turn-a",
  kind: "user", timestamp, ordinal: 3, byteOffset: 200, text,
});
const observation = (id = "legacy-a", timestamp = "2026-09-13T00:00:01Z", narrative = "진행"): CompressedObservation => ({
  id, sessionId: scope.sessionId, timestamp, title: "prompt_submit", narrative, facts: [], concepts: [], files: [],
  importance: 5, type: "conversation", agentId: scope.agentId,
});

describe("canonical native-to-legacy observation correspondence", () => {
  it.each(["\nrequest body\n\n", "request body \n", " \tfirst\n  second\t\r\n", "\n" + "long request ".repeat(60) + "\n"])("reconciles only the complete boundary-stripped prompt or its exact legacy truncation: %j", text => {
    const native = message("boundary-prompt", "2026-09-13T00:00:00Z", text);
    const stripped = text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
    for (const narrative of new Set([stripped, stripped.length > 400 ? stripped.slice(0, 399) + "…" : stripped])) {
      const row = { ...observation("old-boundary", native.timestamp, narrative), confidence: 0.3 };
      for (const source of [native, codexMessageReference(native)]) {
        expect(matchCodexMessages([source], [row], scope)[0]).toMatchObject({ action: "adopt", observationId: row.id, contentRepair: "restore_legacy_prompt_whitespace" });
        expect(matchCodexMessages([source], [row], { ...scope, completeNativeInventory: false })[0]?.action).toBe("blocked");
        expect(matchCodexMessages([source], [{ ...row, confidence: 0.8 }], scope)[0]?.action).toBe("blocked");
        expect(matchCodexMessages([source], [{ ...row, narrative: narrative + " changed" }], scope)[0]?.action).toBe("blocked");
        expect(matchCodexMessages([source], [{ ...row, timestamp: "2026-09-13T00:00:10Z" }], scope)[0]?.action).not.toBe("adopt");
        expect(matchCodexMessages([source], [row, { ...row, id: "duplicate" }], scope)[0]?.action).toBe("blocked");
        const other = message("other-primary", native.timestamp, stripped);
        expect(matchCodexMessages([source, other], [row], scope).every(result => result.action === "blocked")).toBe(true);
      }
    }
  });
  it("does not normalize internal whitespace, Unicode spacing, canonical or protected prompt content", () => {
    const native = message("boundary-prompt", "2026-09-13T00:00:00Z", "\nfirst  second\n");
    const row = { ...observation("old-boundary", native.timestamp, "first  second"), confidence: 0.3 };
    const canonical = { ...row, codexSource: { version: 1 as const, key: native.key, nativeMessageId: native.nativeMessageId,
      kind: native.kind, timestamp: native.timestamp, ordinal: native.ordinal, byteOffset: native.byteOffset, textDigest: codexTextDigest(native.text) } };
    for (const invalid of [{ ...row, narrative: "first second" }, canonical,
      { ...row, emptyDeletion: { state: "restored" as const, version: 1, changedAt: row.timestamp, reason: "protected", auditId: "audit" } }]) {
      expect(matchCodexMessages([native], [invalid], scope)[0]?.action).toBe("blocked");
    }
    expect(matchCodexMessages([{ ...native, text: "\u00a0first  second\u00a0" }], [row], scope)[0]?.action).toBe("blocked");
    expect(() => matchCodexMessages([{ ...codexMessageReference(native), legacyPromptDigests: { textDigest: "invalid" } }], [row], scope)).toThrow("Invalid native");
    expect(() => matchCodexMessages([codexMessageReference(native), { ...codexMessageReference(native), legacyPromptDigests: undefined }], [row], scope)).toThrow("Conflicting native");
  });
  it("adopts an imported user only by its proven display item and full unchanged body", () => {
    const native = { ...codexMessageReference(message("primary", "2026-09-13T00:00:10Z", "original request")), legacyUserItemId: "display-id" };
    const row = { ...observation("imported", "2026-09-13T00:00:00Z", "original request"), origin: {
      channel: "import" as const, detail: "codex-task-recovery:prompt_submit:display-id", capturedAt: "2026-09-13T00:00:00Z",
    } };
    expect(matchCodexMessages([native], [row], scope)[0]).toEqual({ sourceKey: native.key,
      observationId: row.id, action: "adopt", legacyUserItemMatch: true });
    for (const invalid of [{ ...row, narrative: "changed request" }, { ...row, origin: undefined },
      { ...row, origin: { ...row.origin, channel: "user" as const } },
      { ...row, origin: { ...row.origin, detail: "codex-task-recovery:prompt_submit:other-id" } },
      { ...row, origin: { ...row.origin, capturedAt: "2026-09-13T00:00:01Z" } },
      { ...row, emptyDeletion: { state: "restored" as const, version: 1, changedAt: row.timestamp, reason: "protected", auditId: "audit" } }]) {
      const decisions = matchCodexMessages([native], [invalid], scope);
      expect(decisions[0]?.action).not.toBe("adopt");
      expect(unmatchedCodexCaptures([invalid], decisions)).toHaveLength(1);
    }
    expect(matchCodexMessages([native], [row], { ...scope, completeNativeInventory: false })[0]?.action).toBe("blocked");
    expect(matchCodexMessages([native, { ...native, key: codexTextDigest("competing") }], [row], scope)
      .every(result => result.action === "blocked")).toBe(true);
    expect(matchCodexMessages([native], [row, { ...row, id: "duplicate" }], scope)[0]?.action).toBe("blocked");
    expect(() => matchCodexMessages([{ ...native, legacyUserItemId: "" }], [row], scope)).toThrow("Invalid native");
  });
  it("keeps content-free deleted recovery rows outside native correspondence without hiding surviving content", () => {
    const row = { ...observation("deleted-empty", "2026-09-13T00:00:01Z", ""), title: "assistant_response", type: "other" as const,
      emptyDeletion: { state: "deleted" as const, version: 1, changedAt: "2026-09-14T00:00:00Z", reason: "Deleted empty", auditId: "audit" } };
    const before = structuredClone(row);
    const native = { ...message("new-final", row.timestamp, "real answer"), kind: "assistant_final" as const };
    const decisions = matchCodexMessages([native], [row], scope);
    expect(decisions[0]?.action).toBe("insert");
    expect(unmatchedCodexCaptures([row], decisions)).toEqual([]);
    expect(row).toEqual(before);
    for (const retained of [{ ...row, narrative: "real answer" }, { ...row, facts: ["existing fact"] },
      { ...row, emptyDeletion: { ...row.emptyDeletion, state: "restored" as const } }]) {
      const held = matchCodexMessages([native], [retained], scope);
      expect(held[0]?.action).toBe("blocked");
      expect(unmatchedCodexCaptures([retained], held)).toHaveLength(1);
    }
  });
  it("restores an exact upstream-truncated user prompt without accepting a partial or competing prefix", () => {
    const native = message("long-prompt", "2026-09-13T00:00:00Z", "a".repeat(399) + "full original request");
    const row = { ...observation("old-prompt", native.timestamp, "a".repeat(399) + "…"), confidence: 0.3 };
    expect(matchCodexMessages([codexMessageReference(native)], [row], scope)[0]).toMatchObject({
      action: "adopt", contentRepair: "restore_legacy_synthetic", observationId: row.id,
    });
    expect(matchCodexMessages([native], [{ ...row, confidence: 0.9 }], scope)[0]?.action).toBe("blocked");
    expect(matchCodexMessages([native], [{ ...row, narrative: row.narrative.slice(0, 399) }], scope)[0]?.action).toBe("blocked");
    expect(matchCodexMessages([native, { ...native, key: codexTextDigest("same-prefix"), text: native.text + " other" }], [row], scope)
      .every(result => result.action === "blocked")).toBe(true);
  });
  it("adopts delayed final hooks only by a unique full body and exact source turn", () => {
    const native = { ...message("late-final", "2026-09-13T00:00:00Z", "verified final"), kind: "assistant_final" as const };
    const row = { ...observation("delayed", "2026-09-13T00:00:13Z", native.text), type: "other" as const,
      title: "assistant_response", subtitle: JSON.stringify({ turn_id: "turn-a" }) };
    expect(matchCodexMessages([native], [row], scope)[0]).toEqual({ sourceKey: native.key,
      observationId: row.id, action: "adopt", legacyTurnMatch: true });
    for (const invalid of [{ ...row, narrative: "different final" }, { ...row, subtitle: undefined },
      { ...row, subtitle: JSON.stringify({ turn_id: "other-turn" }) }, { ...row, timestamp: "2026-09-12T23:59:40Z" }]) {
      expect(matchCodexMessages([native], [invalid], scope)[0]?.action).not.toBe("adopt");
    }
    expect(matchCodexMessages([native, { ...native, key: codexTextDigest("second-final") }], [row], scope)
      .every(result => result.action === "blocked")).toBe(true);
    expect(matchCodexMessages([native], [row], { ...scope, completeNativeInventory: false })[0]?.action).toBe("blocked");
  });
  it("requires the historical recovery ID, exact origin and full assembled-body digest", () => {
    const native = message("parts", "2026-09-13T00:00:00Z", "body\n");
    const oldText = "body\n\n";
    const id = "obs_codex_recovery_" + codexTextDigest([scope.sessionId, "turn-a", "prompt_submit", native.timestamp, oldText].join("\n")).slice(0, 32);
    native.legacyRecovery = { observationId: id, textDigest: codexTextDigest(oldText) };
    const row = { ...observation(id, native.timestamp, oldText),
      origin: { channel: "user" as const, detail: "Codex original turn turn-a", capturedAt: native.timestamp } };
    expect(matchCodexMessages([codexMessageReference(native)], [row], scope)[0]).toMatchObject({
      action: "adopt", observationId: id, contentRepair: "restore_legacy_recovery_parts",
    });
    for (const invalid of [{ ...row, id: "unproven" }, { ...row, origin: undefined },
      { ...row, timestamp: "2026-09-13T00:00:01Z" }, { ...row, narrative: oldText + " changed" },
      { ...row, origin: { ...row.origin, detail: "Codex original turn other-turn" } }]) {
      expect(matchCodexMessages([native], [invalid], scope)[0]?.action).toBe("blocked");
    }
    expect(matchCodexMessages([native, { ...native, key: codexTextDigest("competing-primary") }], [row], scope)
      .every(result => result.action === "blocked")).toBe(true);
    expect(matchCodexMessages([native], [row], { ...scope, completeNativeInventory: false })[0]?.action).toBe("blocked");
  });
  it("restores only a uniquely proven legacy UTC timestamp representation", () => {
    const native = message("utc", "2026-08-28T09:26:42.633Z", "Unique original body");
    const row = observation("old-time", "08/28/2026 09:26:42", native.text);
    const before = structuredClone(row);
    expect(matchCodexMessages([native], [row], scope)[0]).toMatchObject({
      action: "adopt", observationId: row.id, timestampRepair: "restore_legacy_utc",
    });
    expect(row).toEqual(before);
    expect(matchCodexMessages([native], [row], { ...scope, completeNativeInventory: false })[0]?.action).toBe("blocked");
    const competing = message("utc-other", "2026-08-28T09:26:42.900Z", native.text);
    expect(matchCodexMessages([native, competing], [row], scope).every(result => result.action === "blocked")).toBe(true);
    for (const changed of [{ ...row, narrative: native.text + " changed" }, { ...row, timestamp: "08/28/2026 09:26:43" },
      { ...row, timestamp: "2026-08-28T09:26:43Z" }]) {
      expect(matchCodexMessages([native], [changed], scope)[0]).not.toHaveProperty("timestampRepair");
    }
    const protectedRow = { ...row, emptyDeletion: { state: "restored" as const, version: 1,
      changedAt: native.timestamp, reason: "Protected", auditId: "existing-audit" } };
    expect(matchCodexMessages([native], [protectedRow], scope)[0]).not.toHaveProperty("timestampRepair");
  });
  it("requires the complete native image encoding, exact timestamp and unique correspondence", () => {
    const old = '본문\n<image name="one">\n\n</image>';
    const row = observation("image-old", "2026-09-13T00:00:00Z", old);
    const native = { ...message("image", undefined, "본문"), legacyImageWrappedDigest: codexTextDigest(old) };
    expect(matchCodexMessages([codexMessageReference(native)], [row], scope)[0])
      .toMatchObject({ action: "adopt", contentRepair: "restore_legacy_image_text", observationId: row.id });
    for (const changed of [{ ...row, narrative: old + "extra" }, { ...row, timestamp: "2026-09-13T00:00:00.001Z" },
      { ...row, type: "other" as const }]) {
      expect(matchCodexMessages([native], [changed], scope)[0]?.action).toBe("blocked");
    }
    expect(matchCodexMessages([native, { ...native, key: codexTextDigest("other"), nativeMessageId: "other" }], [row], scope)
      .every(result => result.action === "blocked")).toBe(true);
    expect(matchCodexMessages([native], [row, { ...row, id: "duplicate" }], scope)[0]?.action).toBe("blocked");
  });
  it.each([
    "<subagent_notification>internal completion</subagent_notification>",
    "The following is the Codex agent history whose request action you are assessing. internal review",
  ])("keeps known internal legacy traffic out of normal correspondence without changing it: %s", text => {
    const rows = [observation(), observation("internal", undefined, text)];
    const before = structuredClone(rows);
    const decisions = matchCodexMessages([message("m")], rows, scope);
    expect(decisions).toMatchObject([{ action: "adopt", observationId: "legacy-a" }]);
    expect(unmatchedCodexCaptures(rows, decisions)).toEqual([]);
    expect(rows).toEqual(before);
  });
  it("does not hide an ordinary user mentioning an internal marker or unmatched normal capture", () => {
    const text = "Please explain <subagent_notification> from the log";
    const row = observation("user", undefined, text);
    expect(matchCodexMessages([message("m", undefined, text)], [row], scope)[0]).toMatchObject({ action: "adopt" });
    expect(unmatchedCodexCaptures([row], [])).toMatchObject([{ observationId: "user" }]);
  });
  it("retains correspondence checks for protected and source-bound internal-looking rows", () => {
    const m = message("m");
    const text = "<subagent_notification>internal completion</subagent_notification>";
    const protectedRow = { ...observation("protected", undefined, text), emptyDeletion: {
      state: "restored" as const, version: 1 as const, reason: "test", auditId: "audit-a", changedAt: "2026-09-13" } };
    expect(matchCodexMessages([m], [protectedRow], scope)[0]).toMatchObject({ action: "blocked", reason: "protected_observation_lifecycle" });
    const mapped = { ...observation("mapped", undefined, text), codexSource: {
      version: 1 as const, key: m.key, nativeMessageId: m.nativeMessageId, kind: m.kind,
      timestamp: m.timestamp, ordinal: m.ordinal, byteOffset: m.byteOffset, textDigest: codexTextDigest(m.text) } };
    const decisions = matchCodexMessages([m], [mapped], scope);
    expect(decisions[0]).toMatchObject({ action: "blocked", reason: "legacy_or_canonical_content_mismatch" });
    expect(unmatchedCodexCaptures([mapped], decisions)).toMatchObject([{ observationId: "mapped" }]);
  });
  it("adopts an unambiguous existing ID without changing any canonical content or timestamp", () => {
    const row = observation(); const before = structuredClone(row);
    expect(matchCodexMessages([message("m1")], [row], scope)).toEqual([
      { sourceKey: codexTextDigest("m1"), observationId: "legacy-a", action: "adopt" },
    ]);
    expect(row).toEqual(before);
    const compact = codexMessageReference(message("m1"));
    expect(compact).not.toHaveProperty("text");
    expect(matchCodexMessages([compact], [row], scope)[0]).toMatchObject({ action: "adopt", observationId: row.id });
  });
  it("does not guess which repeated input a single legacy observation belongs to", () => {
    const result = matchCodexMessages([message("m1"), message("m2", "2026-09-13T00:00:02Z")], [observation()], scope);
    expect(result.map(row => row.reason)).toEqual(["ambiguous_legacy_correspondence", "ambiguous_legacy_correspondence"]);
    expect(result.every(row => row.action === "blocked")).toBe(true);
  });
  it("uses unique full content to distinguish different messages in the same time window", () => {
    const messages = [message("a", undefined, "alpha"), message("b", "2026-09-13T00:00:02Z", "beta")];
    const rows = [observation("old-b", undefined, "beta"), observation("old-a", undefined, "alpha")];
    expect(matchCodexMessages(messages, rows, scope)).toMatchObject([
      { action: "adopt", observationId: "old-a" }, { action: "adopt", observationId: "old-b" },
    ]);
    expect(matchCodexMessages(messages, [rows[1]!], scope)).toMatchObject([
      { action: "adopt", observationId: "old-a" }, { action: "insert" },
    ]);
    const orphan = observation("orphan", undefined, "different truncated body");
    const decisions = matchCodexMessages(messages, [...rows, orphan], scope);
    expect(unmatchedCodexCaptures([...rows, orphan], decisions)).toMatchObject([{ observationId: "orphan" }]);
  });
  it("proposes only a proven single final LF restoration and leaves stored content untouched", () => {
    const row = observation("legacy", undefined, "exact body");
    const before = structuredClone(row);
    expect(matchCodexMessages([codexMessageReference(message("m", undefined, "exact body\n"))], [row], scope)[0])
      .toMatchObject({ action: "adopt", observationId: row.id, contentRepair: "restore_terminal_lf" });
    expect(row).toEqual(before);
    for (const text of [" exact body", "exact body ", "exact body\n\n", "EXACT BODY"]) {
      expect(matchCodexMessages([message("m", undefined, text)], [row], scope)[0]).toMatchObject({ action: "blocked" });
    }
  });
  it("does not choose between an exact message and an LF variant or competing stored copies", () => {
    const rows = [observation("legacy", undefined, "same")];
    const messages = [message("a", undefined, "same"), message("b", undefined, "same\n")];
    expect(matchCodexMessages(messages, rows, scope).every(row => row.reason === "ambiguous_legacy_correspondence")).toBe(true);
    expect(matchCodexMessages([messages[1]!], [...rows, observation("other", undefined, "same\n")], scope)[0])
      .toMatchObject({ action: "blocked", reason: "ambiguous_legacy_correspondence" });
    expect(matchCodexMessages([messages[1]!], rows, { ...scope, completeNativeInventory: false })[0])
      .toMatchObject({ action: "blocked", reason: "legacy_matching_requires_complete_native_inventory" });
  });
  it("recognizes the exact upstream synthetic assistant transform with its matching turn metadata", () => {
    const native = { ...message("final", undefined, "long original answer ".repeat(60)), kind: "assistant_final" as const };
    const input = JSON.stringify({ turn_id: native.turnId });
    const old = input + " | " + native.text;
    const row = { ...observation("old", undefined, old.slice(0, 399) + "…"), title: "assistant_response",
      type: "other" as const, subtitle: input, confidence: 0.3 };
    for (const source of [native, codexMessageReference(native)]) {
      expect(matchCodexMessages([source], [row], scope)[0]).toMatchObject({ action: "adopt", contentRepair: "restore_legacy_synthetic" });
    }
    for (const patch of [{ subtitle: '{"turn_id":"other"}' }, { confidence: 0.8 }, { narrative: row.narrative.slice(1) },
      { codexSource: { version: 1 as const, key: native.key, nativeMessageId: native.nativeMessageId, kind: native.kind,
        timestamp: native.timestamp, ordinal: native.ordinal, byteOffset: native.byteOffset, textDigest: codexTextDigest(native.text) } }]) {
      expect(matchCodexMessages([native], [{ ...row, ...patch }], scope)[0]).toMatchObject({ action: "blocked" });
    }
    const second = { ...native, key: codexTextDigest("other-final"), nativeMessageId: "other-final", text: native.text + "different suffix" };
    expect(matchCodexMessages([native, second], [row], scope).every(result => result.reason === "ambiguous_legacy_correspondence")).toBe(true);
    expect(row.narrative).toBe(old.slice(0, 399) + "…");
  });
  it("requires the full initial source inventory before adopting legacy records across window boundaries", () => {
    expect(matchCodexMessages([message("m1")], [observation()], { ...scope, completeNativeInventory: false })[0])
      .toMatchObject({ action: "blocked", reason: "legacy_matching_requires_complete_native_inventory" });
  });
  it("does not overwrite a deterministic ID occupied by unrelated content", () => {
    const m = message("m1");
    expect(matchCodexMessages([m], [{ ...observation(`obs_codex_${m.key}`), title: "command_run" }], scope)[0])
      .toMatchObject({ action: "blocked", reason: "deterministic_observation_identity_conflict" });
  });
  it("keeps distinct identical messages while replaying the same event only once", () => {
    const results = matchCodexMessages([message("m1"), message("m2"), message("m1")], [], scope);
    expect(results.map(row => row.action)).toEqual(["insert", "insert", "duplicate"]);
    expect(results[0]!.observationId).not.toBe(results[1]!.observationId);
    expect(results[2]!.observationId).toBe(results[0]!.observationId);
  });
  it("blocks a nearby truncated or modified legacy record instead of inserting a duplicate", () => {
    expect(matchCodexMessages([message("m")], [observation("legacy-a", undefined, "진행... truncated")], scope)[0])
      .toMatchObject({ action: "blocked", reason: "legacy_or_canonical_content_mismatch" });
  });
  it("does not mistake an unfinished raw observation for missing history", () => {
    const raw = { id: "raw-a", sessionId: scope.sessionId, hookType: "prompt_submit", userPrompt: "진행" };
    expect(() => matchCodexMessages([message("m")], [raw as CompressedObservation], scope)).toThrow("Unfinished raw capture");
  });
  it("requires an owner correction and honors existing recovery protection", () => {
    expect(matchCodexMessages([message("m")], [{ ...observation(), agentId: undefined }], scope)[0])
      .toMatchObject({ action: "blocked", reason: "owner_reconciliation_required" });
    expect(matchCodexMessages([message("m")], [{ ...observation(), emptyDeletion: { state: "restored", version: 1, reason: "test", auditId: "audit-a", changedAt: "2026-09-13" } }], scope)[0])
      .toMatchObject({ action: "blocked", reason: "protected_observation_lifecycle" });
  });
  it("validates existing source provenance before treating capture as complete", () => {
    const m = message("m");
    const source = { version: 1 as const, key: m.key, nativeMessageId: m.nativeMessageId, kind: m.kind,
      timestamp: m.timestamp, ordinal: m.ordinal, byteOffset: m.byteOffset, textDigest: codexTextDigest(m.text) };
    const row = { ...observation(), codexSource: source };
    expect(matchCodexMessages([m], [row], scope)[0]).toMatchObject({ action: "present", observationId: row.id });
    expect(matchCodexMessages([m], [{ ...row, codexSource: { ...source, nativeMessageId: "wrong" } }], scope)[0])
      .toMatchObject({ action: "blocked", reason: "canonical_source_provenance_mismatch" });
    expect(matchCodexMessages([m], [row, { ...row, id: "duplicate-row" }], scope)[0])
      .toMatchObject({ action: "blocked", reason: "duplicate_canonical_source_identity" });
  });
});
