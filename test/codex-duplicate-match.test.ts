import { describe, expect, it } from "vitest";
import { codexTextDigest, matchCodexMessages, unmatchedCodexCaptures } from "../src/replay/codex-match.js";
import type { CodexNativeMessage } from "../src/replay/codex-record.js";
import type { CompressedObservation } from "../src/types.js";

const scope = { sessionId: "s", project: "p", agentId: "codex-global", completeNativeInventory: true };
const message: CodexNativeMessage = { sessionId: "s", key: codexTextDigest("m"), nativeMessageId: "m", turnId: "t", kind: "user",
  timestamp: "2026-09-13T00:00:01Z", text: "request\n", ordinal: 3, byteOffset: 200 };
const row = (id: string): CompressedObservation => ({ id, sessionId: "s", project: "p", agentId: scope.agentId, title: "prompt_submit", type: "conversation",
  timestamp: message.timestamp, narrative: message.text, facts: [], concepts: [], files: [], importance: 5, confidence: 0.3 });
const bound = (id: string, duplicateOfObservationId?: string): CompressedObservation => ({ ...row(id), codexSource: { version: 1, key: message.key,
  nativeMessageId: message.nativeMessageId, kind: message.kind, timestamp: message.timestamp, textDigest: codexTextDigest(message.text), ordinal: 3, byteOffset: 200,
  ...(duplicateOfObservationId ? { duplicateOfObservationId } : {}) } });

describe("proven native duplicate captures", () => {
  it("requires explicit full-inventory opt-in and keeps all existing IDs", () => {
    const rows = [row("b"), row("a")];
    expect(matchCodexMessages([message], rows, scope)).toMatchObject([{ action: "blocked" }]);
    expect(() => matchCodexMessages([message], rows, { ...scope, reconcileDuplicates: true, completeNativeInventory: false })).toThrow("complete native inventory");
    const decisions = matchCodexMessages([message], rows, { ...scope, reconcileDuplicates: true });
    expect(decisions).toEqual([{ sourceKey: message.key, observationId: "a", action: "adopt" },
      { sourceKey: message.key, observationId: "b", action: "adopt", duplicateOfObservationId: "a" }]);
    expect(unmatchedCodexCaptures(rows, decisions)).toEqual([]);
  });
  it("retains the existing canonical representative and previously linked copies during interrupted adoption", () => {
    const decisions = matchCodexMessages([message], [bound("z"), bound("b", "z"), row("a")], { ...scope, reconcileDuplicates: true });
    expect(decisions).toHaveLength(3);
    expect(decisions).toContainEqual({ sourceKey: message.key, observationId: "a", action: "adopt", duplicateOfObservationId: "z" });
    expect(decisions).toContainEqual({ sourceKey: message.key, observationId: "b", action: "present", duplicateOfObservationId: "z" });
  });
  it("uses existing source identity during incremental capture without another opt-in", () => {
    const decisions = matchCodexMessages([message, message], [bound("a"), bound("b", "a")], { ...scope, completeNativeInventory: false });
    expect(decisions.filter(d => d.action === "present")).toHaveLength(2);
    expect(decisions.filter(d => d.action === "duplicate")).toHaveLength(1);
    expect(decisions.some(d => d.action === "adopt" || d.action === "insert")).toBe(false);
  });
  it("does not collapse two genuine primary messages with identical text", () => {
    const second = { ...message, key: codexTextDigest("second"), nativeMessageId: "second", timestamp: "2026-09-13T00:00:02Z", ordinal: 4, byteOffset: 300 };
    expect(matchCodexMessages([message, second], [row("a"), row("b")], { ...scope, reconcileDuplicates: true }).every(d => d.action === "blocked")).toBe(true);
  });
  it.each(["orphan", "cycle", "chain", "body", "owner", "key", "protected"])("rejects %s alias provenance", variant => {
    const a = bound("a"); const b = bound("b", "a");
    if (variant === "orphan") b.codexSource!.duplicateOfObservationId = "missing";
    if (variant === "cycle" || variant === "chain") a.codexSource!.duplicateOfObservationId = variant === "cycle" ? "b" : "missing";
    if (variant === "body") b.narrative = "changed";
    if (variant === "owner") b.agentId = "different";
    if (variant === "key") b.codexSource!.key = codexTextDigest("different");
    if (variant === "protected") b.emptyDeletion = { state: "deleted" } as never;
    expect(() => matchCodexMessages([message], [a, b], scope)).toThrow("duplicate capture provenance");
  });
  it("does not reconcile an unverified or protected competing row", () => {
    for (const b of [{ ...row("b"), narrative: "different" }, { ...row("b"), agentId: "different" }, { ...row("b"), emptyDeletion: { state: "deleted" } }]) {
      const rows = [row("a"), b as CompressedObservation];
      const result = matchCodexMessages([message], rows, { ...scope, reconcileDuplicates: true });
      expect(result.some(d => d.duplicateOfObservationId)).toBe(false);
      expect(unmatchedCodexCaptures(rows, result).length).toBeGreaterThan(0);
    }
  });
});
