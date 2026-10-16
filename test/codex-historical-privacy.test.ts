import { describe, expect, it } from "vitest";
import { historicalPrivacyDigest, HISTORICAL_PRIVACY_RULES_DIGEST } from "../src/replay/codex-historical-privacy.js";
import { stripPrivateData } from "../src/functions/privacy.js";
import { codexMessageReference, codexTextDigest, matchCodexMessages } from "../src/replay/codex-match.js";
import { initialCodexParseState, parseCodexRecord } from "../src/replay/codex-record.js";
import type { CompressedObservation } from "../src/types.js";
import { mockKV } from "./helpers/mocks.js";
import { KV } from "../src/state/schema.js";
import { captureExportData } from "../src/functions/export-import.js";
import { getSearchIndex, rebuildIndex } from "../src/functions/search.js";

const raw = "identifier_sk-" + "a".repeat(32);
const masked = "identifier_[REDACTED_SECRET]";
const at = "2026-09-10T07:43:20.470Z";
const scope = { project: "fixture", sessionId: "session", agentId: "codex-global", completeNativeInventory: true };
function fixture(role = "assistant", content = raw) {
  const parsed = parseCodexRecord({ type: "response_item", timestamp: at,
    payload: { type: "message", role, id: "native", phase: "final_answer", content: [{ type: "text", text: content }] } },
  { sessionId: scope.sessionId, ordinal: 147, byteOffset: 4409063 },
  { ...initialCodexParseState(true), turnId: "turn", normalUserSeen: true });
  if (parsed.status !== "message") throw Error("Fixture did not parse");
  const message = parsed.message;
  const row: CompressedObservation = { id: "existing", sessionId: scope.sessionId, project: scope.project,
    agentId: scope.agentId, timestamp: at, title: role === "user" ? "prompt_submit" : "assistant_response",
    type: role === "user" ? "conversation" : "other", narrative: masked, facts: [], concepts: [], files: [], importance: 5,
    codexSource: { version: 1, key: message.key, nativeMessageId: message.nativeMessageId, kind: message.kind,
      timestamp: at, ordinal: message.ordinal, byteOffset: message.byteOffset, textDigest: codexTextDigest(masked) } };
  return { message, row };
}

describe("fixed historical privacy correspondence", () => {
  it("keeps the stored mask and original source metadata in search and export after planning", async () => {
    const { message, row } = fixture();
    const kv = mockKV();
    await kv.set(KV.sessions, scope.sessionId, { id: scope.sessionId, project: scope.project, agentId: scope.agentId,
      cwd: "/fixture", startedAt: at, status: "completed", observationCount: 1 });
    await kv.set(KV.observations(scope.sessionId), row.id, row);
    expect(matchCodexMessages([message], [row], scope)[0].action).toBe("present");
    const index = getSearchIndex(); index.clear();
    try {
      await rebuildIndex(kv as never, { reuseVectors: true });
      expect(index.search("identifier")).toEqual(expect.arrayContaining([expect.objectContaining({ obsId: row.id })]));
      const exported = await captureExportData(kv as never);
      expect(exported.observations[scope.sessionId]).toEqual([row]);
      expect(JSON.stringify(exported)).not.toContain(raw);
      expect(await kv.get(KV.observations(scope.sessionId), row.id)).toEqual(row);
    } finally { index.clear(); }
  });
  it("pins the exact ordered historical rule inventory", () => {
    expect(HISTORICAL_PRIVACY_RULES_DIGEST).toBe("56172de611aacbecb78dfb7ea9f88b15ead1da934eab6f4bbf1529a0be653a68");
  });
  it("uses the historical full order, including private blocks and Bearer before embedded sk patterns", () => {
    const input = [raw, "<private>" + raw + "</private>", "-----BEGIN PRIVATE KEY-----\n" + raw + "\n-----END PRIVATE KEY-----",
      "https://user:" + raw + "@example.invalid", "Bearer " + raw,
      "sk-proj-" + "a".repeat(24), "sk-ant-" + "b".repeat(24), "ghp_" + "c".repeat(36),
      "github_pat_" + "d".repeat(22), "xoxb-synthetic-value", "AKIA" + "E".repeat(16), "AIza" + "f".repeat(35),
      "eyJ" + "g".repeat(10) + "." + "h".repeat(10) + "." + "i".repeat(10), "npm_" + "j".repeat(36),
      "glpat-" + "k".repeat(20), "dop_v1_" + "a".repeat(64)];
    const expected = [masked, "[REDACTED]", "[REDACTED_SECRET]", "https://[REDACTED_SECRET]@example.invalid",
      ...Array(12).fill("[REDACTED_SECRET]")].join("\n");
    const current = input.map(stripPrivateData).join("\n");
    expect(historicalPrivacyDigest(input, current)?.textDigest).toBe(codexTextDigest(expected));
    expect(historicalPrivacyDigest([raw], raw)?.rulesDigest).toBe(HISTORICAL_PRIVACY_RULES_DIGEST);
    expect(historicalPrivacyDigest([raw], raw + " changed")).toBeUndefined();
    expect(historicalPrivacyDigest(["already [REDACTED_SECRET]"], "already [REDACTED_SECRET]")).toBeUndefined();
  });
  it.each(["assistant", "user"])("preserves the exact bound %s row across references and retries", role => {
    const { message, row } = fixture(role), before = structuredClone(row);
    expect(message.text).toBe(raw);
    for (const source of [message, codexMessageReference(message), codexMessageReference(message)]) {
      const result = matchCodexMessages([source], [row], scope);
      expect(result[0]).toMatchObject({ action: "present", observationId: row.id,
        historicalPrivacyPreserved: { version: "before-455854b1", textDigest: row.codexSource!.textDigest, currentTextDigest: codexTextDigest(raw) } });
      expect(JSON.stringify(result)).not.toContain(raw);
      expect(row).toEqual(before);
    }
    expect(matchCodexMessages([message], [], scope)[0].action).toBe("insert");
    expect(matchCodexMessages([message], [row], { ...scope, completeNativeInventory: false })[0].action).toBe("blocked");
    expect(message.text).toBe(raw);
  });
  it("rejects different text, markers, metadata, ownership, and protected records", () => {
    const { message, row } = fixture();
    for (const changed of [
      { ...row, narrative: masked + " changed" }, { ...row, narrative: "identifier_[PRIVATE]" },
      { ...row, codexSource: undefined }, { ...row, agentId: "other" }, { ...row, project: undefined },
      { ...row, timestamp: "2026-09-10T07:43:21Z" },
      { ...row, emptyDeletion: { state: "deleted", version: 1, changedAt: at, reason: "protected", auditId: "audit" } },
      ...["key", "nativeMessageId", "kind", "timestamp", "ordinal", "byteOffset", "textDigest"].map(field => ({
        ...row, codexSource: { ...row.codexSource, [field]: field === "ordinal" || field === "byteOffset" ? 1 : "different" } })),
    ]) {
      expect(matchCodexMessages([message], [changed as CompressedObservation], scope).some(x => x.action === "present" || x.action === "adopt")).toBe(false);
    }
    expect(() => matchCodexMessages([message], [{ ...row, project: "other" }], scope)).toThrow();
    expect(() => matchCodexMessages([message], [{ ...row, sessionId: "other" }], scope)).toThrow();
    const changed = fixture("assistant", raw + " changed").message;
    expect(matchCodexMessages([changed], [row], scope)[0].action).toBe("blocked");
    for (const field of ["version", "rulesDigest", "currentTextDigest"]) {
      expect(() => matchCodexMessages([{ ...message, historicalPrivacy: { ...message.historicalPrivacy!, [field]: "invalid" } }], [row], scope)).toThrow();
    }
  });
});
