import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockKV } from "./helpers/mocks.js";
import { initializeCodexSourceCapture, captureCodexSourceWindow } from "../src/functions/codex-source-capture.js";
import { KV } from "../src/state/schema.js";
import { withObservationWrite } from "../src/state/observation-write.js";
import type { CompressedObservation, Session } from "../src/types.js";
import { changeArchiveState, readArchiveVisibility } from "../src/functions/archive.js";
import { readCodexWindow } from "../src/replay/codex-window.js";
import { createHash } from "node:crypto";
import { inspectCodexSource } from "../src/functions/codex-source-inspect.js";
import { codexSessionForTransfer } from "../src/replay/codex-capture-state.js";
import { retainCodexForgetExclusions, codexExclusionId } from "../src/functions/codex-capture-exclusion.js";

describe("native source capture checkpoints", () => {
  it.each([false, true])("preserves proven duplicate IDs across archive, restore and capture (raw: %s)", async raw => {
    const first = raw ? rawPrompt("a-original", 1) : legacy("a-original", 1);
    const copy = legacy("b-copy", 1);
    await kv.set(KV.observations("s"), first.id, first); await kv.set(KV.observations("s"), copy.id, copy);
    await expect(preview()).rejects.toThrow("Unresolved capture correspondence");
    const input = { ...scope, sourcePath, dryRun: true, reconcileDuplicates: true };
    const plan = await initializeCodexSourceCapture(kv as never, input, managed());
    expect(plan).toMatchObject({ adopt: 2, missing: 1, linkDuplicateCaptures: 1, duplicateCaptures: [{ observationId: "b-copy", duplicateOfObservationId: "a-original" }] });
    await expect(initializeCodexSourceCapture(kv as never, { ...input, dryRun: false, expectedVersion: plan.expectedVersion, reconcileDuplicates: false, reason: "changed option" }, managed())).rejects.toThrow();
    await initializeCodexSourceCapture(kv as never, { ...input, dryRun: false, expectedVersion: plan.expectedVersion, reason: "same physical source" }, managed());
    expect(await kv.get(KV.observations("s"), "b-copy")).toMatchObject({ narrative: copy.narrative, facts: copy.facts, codexSource: { duplicateOfObservationId: "a-original" } });
    const published: CompressedObservation[] = [];
    expect(await capture(async rows => { published.push(...rows); })).toMatchObject({ inserted: 1, status: "caught_up" });
    expect(published.some(row => row.id === "a-original")).toBe(true);
    const target = { kind: "observation" as const, id: "b-copy", sessionId: "s" };
    for (const action of ["archive", "restore"] as const) {
      const preview = await changeArchiveState(kv as never, { target, project: scope.project, action, dryRun: true });
      await changeArchiveState(kv as never, { target, project: scope.project, action, dryRun: false, expectedRevision: (preview as any).expectedRevision, expectedDigest: (preview as any).expectedDigest, reason: "reviewed duplicate lifecycle" });
      expect((await readArchiveVisibility(kv as never))(target)).toBe(action === "archive");
      expect(await capture()).toMatchObject({ inserted: 0, status: "caught_up" });
    }
    expect(await kv.list(KV.observations("s"))).toHaveLength(3);
    expect(await initializeCodexSourceCapture(kv as never, { ...input, reconcileDuplicates: false }, managed())).toMatchObject({ adopt: 0, linkDuplicateCaptures: 0 });
  });
  it("retries an interrupted duplicate adoption without changing its established representative", async () => {
    for (const id of ["a-original", "b-copy", "c-copy"]) await kv.set(KV.observations("s"), id, legacy(id, 1));
    const input = { ...scope, sourcePath, dryRun: true, reconcileDuplicates: true };
    const plan = await initializeCodexSourceCapture(kv as never, input, managed());
    const set = kv.set; let failed = false;
    kv.set = async (group, id, value) => { if (id === "c-copy" && !failed) { failed = true; throw Error("injected alias write failure"); } return set(group, id, value); };
    await expect(initializeCodexSourceCapture(kv as never, { ...input, dryRun: false, expectedVersion: plan.expectedVersion, reason: "verified duplicates" }, managed())).rejects.toThrow("injected alias write failure");
    kv.set = set;
    const retry = await initializeCodexSourceCapture(kv as never, input, managed());
    expect(retry).toMatchObject({ linkDuplicateCaptures: 1, duplicateCaptures: expect.arrayContaining([{ observationId: "b-copy", duplicateOfObservationId: "a-original", sourceKey: expect.any(String) }, { observationId: "c-copy", duplicateOfObservationId: "a-original", sourceKey: expect.any(String) }]) });
    await initializeCodexSourceCapture(kv as never, { ...input, dryRun: false, expectedVersion: retry.expectedVersion, reason: "retry remaining alias" }, managed());
    expect(await capture()).toMatchObject({ inserted: 1, status: "caught_up" });
    expect(await capture()).toMatchObject({ inserted: 0, status: "caught_up" });
  });
  it("adopts a prior browser-context request in place and captures its final exactly once", async () => {
    const text = "\n## My request:\nKeep identifiers\n";
    const mixed = '\n<in-app-browser-context source="ambient-ui-state">state</in-app-browser-context>\n\n' + text.slice(1);
    const final = assistantMessage("final", 2, "Done");
    await writeFile(join(root, sourcePath), [
      { type: "session_meta", payload: { id: "s", source: "vscode", cwd: session.cwd, timestamp: session.startedAt } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-a" } }, message("mixed", 1, mixed), final,
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    const row = { ...legacy("existing-mixed", 1), narrative: text.trim(), confidence: 0.3 };
    await kv.set(KV.observations("s"), row.id, row);
    expect(await preview()).toMatchObject({ adopt: 1, missing: 1, restoreLegacyPromptWhitespace: 1 });
    await initialize();
    expect(await kv.get(KV.observations("s"), row.id)).toMatchObject({ narrative: text, codexSource: { nativeMessageId: "mixed" } });
    expect(await capture()).toMatchObject({ inserted: 1, status: "caught_up" });
    expect(await capture()).toMatchObject({ inserted: 0, status: "caught_up" });
    expect(await kv.list(KV.observations("s"))).toHaveLength(2);
  });
  it.each(["short", "truncated", "raw"])("restores a proven boundary-stripped %s prompt in place and retries indexing the same ID", async variant => {
    const text = "\n" + (variant === "truncated" ? "Original request ".repeat(50) : "original request") + " \n\n";
    await writeFile(join(root, sourcePath), [
      { type: "session_meta", payload: { id: "s", source: "vscode", cwd: session.cwd, timestamp: session.startedAt } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-a" } }, message("trimmed", 1, text),
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    const stripped = text.trim();
    const row = { ...legacy("existing-prompt", 1), narrative: variant === "truncated" ? stripped.slice(0, 399) + "…" : stripped,
      confidence: 0.3, facts: ["retained fact"], imageData: "retained image" };
    const raw = { id: row.id, sessionId: "s", timestamp: row.timestamp, agentId: row.agentId,
      hookType: "prompt_submit", userPrompt: stripped, raw: true, imageData: row.imageData };
    const stored = variant === "raw" ? raw : row;
    await kv.set(KV.observations("s"), row.id, stored);
    expect(await preview()).toMatchObject({ adopt: 1, restoreLegacyPromptWhitespace: 1 });
    expect(await kv.get(KV.observations("s"), row.id)).toEqual(stored);
    await initialize();
    const recovered = await kv.get<CompressedObservation>(KV.observations("s"), row.id);
    expect(recovered).toMatchObject({ id: row.id, timestamp: row.timestamp, narrative: text, imageData: row.imageData,
      codexSource: { nativeMessageId: "trimmed" } });
    if (variant !== "raw") expect(recovered?.facts).toEqual(row.facts);
    expect(JSON.stringify(await kv.list(KV.audit))).toContain('"restoreLegacyPromptWhitespaceObservationIds":["' + row.id + '"]');
    expect(await capture(async () => { throw Error("index temporarily unavailable"); })).toMatchObject({ inserted: 0, indexPending: true });
    expect(await kv.get<Session>(KV.sessions, "s")).toMatchObject({ codexNativeCapture: { indexPending: true } });
    const published: CompressedObservation[] = [];
    expect(await capture(async rows => { published.push(...rows); })).toMatchObject({ inserted: 0, status: "caught_up", indexPending: false });
    expect(published.filter(value => value.id === row.id)).toHaveLength(1);
    expect(published.find(value => value.id === row.id)?.narrative).toBe(text);
    expect(await kv.list(KV.observations("s"))).toHaveLength(1);
    expect(await preview()).toMatchObject({ restoreLegacyPromptWhitespace: 0, missing: 0 });
  });
  it("binds a proven later cwd without moving the canonical project or rewriting the source header", async () => {
    const originalCwd = "C:/work/original";
    await writeFile(join(root, sourcePath), [
      { type: "session_meta", payload: { id: "s", source: "vscode", cwd: originalCwd, timestamp: session.startedAt } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-a" } },
      { type: "turn_context", payload: { turn_id: "turn-a", cwd: originalCwd } }, message("m1", 1),
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-b" } },
      { type: "turn_context", payload: { turn_id: "turn-b", cwd: session.cwd } }, message("m2", 21, "later request"),
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    const row = legacy("original-observation", 1);
    await kv.set(KV.observations("s"), row.id, row);
    expect(await preview()).toMatchObject({ verifiedCurrentCwd: "c:\\work\\p", adopt: 1, missing: 1 });
    await initialize();
    expect(await kv.get(KV.sessions, "s")).toMatchObject({ project: session.project, cwd: session.cwd,
      codexNativeCapture: { source: { cwd: originalCwd }, captureCwd: "c:\\work\\p" } });
    expect(await capture()).toMatchObject({ status: "caught_up", inserted: 1 });
    expect(await capture()).toMatchObject({ status: "caught_up", inserted: 0 });
    expect(await kv.get(KV.observations("s"), row.id)).toMatchObject(row);
    expect(await preview()).toMatchObject({ verifiedCurrentCwd: "c:\\work\\p", missing: 0 });
    await kv.update(KV.sessions, "s", [{ type: "set", path: "cwd", value: "C:/work/unverified" }]);
    await expect(capture()).rejects.toThrow("source identity changed");
    expect(await kv.list(KV.observations("s"))).toHaveLength(2);
  });
  it.each([undefined, "C:/work/other", "relative"])("rejects a moved canonical cwd without a valid last native context: %s", async cwd => {
    await writeFile(join(root, sourcePath), [
      { type: "session_meta", payload: { id: "s", source: "vscode", cwd: "C:/original", timestamp: session.startedAt } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-a" } },
      ...(cwd === undefined ? [] : [{ type: "turn_context", payload: { turn_id: "turn-a", cwd: session.cwd } },
        { type: "turn_context", payload: { turn_id: "turn-a", cwd } }]), message("m1", 1),
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    await expect(preview()).rejects.toThrow();
    await expectUninitialized();
  });
  it("preserves an imported user's ID and collection time after proven display-to-primary reconciliation", async () => {
    await writeFile(join(root, sourcePath), [
      { type: "session_meta", payload: { id: "s", source: "vscode", cwd: session.cwd, timestamp: session.startedAt } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-a" } }, message("primary", 10, "original request"),
      { type: "event_msg", payload: { type: "item_completed", turn_id: "turn-a",
        item: { type: "UserMessage", id: "display-user", content: [{ type: "Text", text: "original request" }] } } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    const row = { ...legacy("imported-user", 0), narrative: "original request", origin: {
      channel: "import" as const, capturedAt: session.startedAt, detail: "codex-task-recovery:prompt_submit:display-user",
    } };
    await kv.set(KV.observations("s"), row.id, row);
    expect(await preview()).toMatchObject({ adoptImportedUserItem: 1, missing: 0 });
    await initialize();
    const saved = await kv.get<CompressedObservation>(KV.observations("s"), row.id);
    expect(saved).toEqual({ ...row, codexSource: expect.objectContaining({ nativeMessageId: "primary", timestamp: message("primary", 10).timestamp }) });
    expect(JSON.stringify(saved)).not.toContain("legacyUserItemId");
    expect(JSON.stringify(await kv.list(KV.audit))).toContain('"adoptImportedUserItemObservationIds":["imported-user"]');
    expect(await capture()).toMatchObject({ inserted: 0, status: "caught_up" });
    expect(await capture()).toMatchObject({ inserted: 0, status: "caught_up" });
    expect(await preview()).toMatchObject({ adoptImportedUserItem: 0, missing: 0 });
    await appendFile(join(root, sourcePath), JSON.stringify(message("later", 21, "later request")) + "\n");
    expect(await capture()).toMatchObject({ inserted: 1, status: "caught_up" });
    expect(await kv.list(KV.observations("s"))).toHaveLength(2);
  });
  it("preserves unresolved legacy content while capturing the original and future messages exactly once", async () => {
    const row = { ...legacy("unmatched", 0), narrative: "Earlier request without the later link" };
    await kv.set(KV.observations("s"), row.id, row);
    const input = { ...scope, sourcePath, dryRun: true, retainUnmatched: true };
    await expect(preview()).rejects.toThrow("correspondence");
    const plan = await initializeCodexSourceCapture(kv as never, input, managed());
    expect(plan).toMatchObject({ adopt: 0, missing: 2, unresolvedCaptureCount: 1, unresolvedCaptures: [{ observationId: row.id }] });
    expect(await kv.get(KV.observations("s"), row.id)).toEqual(row);
    await expect(initializeCodexSourceCapture(kv as never, { ...input, dryRun: false, retainUnmatched: false,
      expectedVersion: plan.expectedVersion, reason: "changed option" }, managed())).rejects.toThrow();
    await initializeCodexSourceCapture(kv as never, { ...input, dryRun: false, expectedVersion: plan.expectedVersion, reason: "retain exact historical evidence" }, managed());
    expect(await capture()).toMatchObject({ inserted: 2, status: "caught_up", unresolvedCaptureCount: 1 });
    expect(await capture()).toMatchObject({ inserted: 0, unresolvedCaptureCount: 1 });
    expect(await kv.get(KV.observations("s"), row.id)).toEqual(row);
    expect(await inspectCodexSource(kv as never, { ...scope, sourcePath }, managed())).toMatchObject({
      completeNativeInventory: true, unmatchedCaptureCount: 1, retainedUnresolvedCaptureCount: 1, status: "ready_with_unresolved" });
    for (const action of ["archive", "restore"] as const) {
      const target = { kind: "observation" as const, id: row.id, sessionId: "s" };
      const preview = await changeArchiveState(kv as never, { target, project: "p", action, dryRun: true });
      await changeArchiveState(kv as never, { target, project: "p", action, dryRun: false, expectedRevision: (preview as any).expectedRevision,
        expectedDigest: (preview as any).expectedDigest, reason: "preserve source review state" });
      expect(await capture()).toMatchObject({ inserted: 0, unresolvedCaptureCount: 1 });
    }
    await appendFile(join(root, sourcePath), JSON.stringify(message("new", 40, "new request")) + "\n");
    expect(await capture()).toMatchObject({ inserted: 1, unresolvedCaptureCount: 1 });
    expect(await kv.list(KV.observations("s"))).toHaveLength(4);
    const current = (await kv.get<Session>(KV.sessions, "s"))!;
    await expect(retainCodexForgetExclusions(kv as never, current, [row], false)).rejects.toThrow("before individual forget");
    expect(await kv.list(KV.codexCaptureExclusions)).toEqual([]);
    const transfer = codexSessionForTransfer(current);
    expect(transfer.codexNativeCapture).toMatchObject({ status: "reconcile_required" });
    expect(transfer.codexNativeCapture).not.toHaveProperty("cursor");
    expect(transfer.codexNativeCapture).not.toHaveProperty("unresolvedCaptures");
    await kv.set(KV.sessions, "s", transfer);
    await expect(capture()).rejects.toThrow("initialization");
    await expect(preview()).rejects.toThrow("correspondence");
    const again = await initializeCodexSourceCapture(kv as never, input, managed());
    expect(again).toMatchObject({ missing: 0, unresolvedCaptureCount: 1 });
  });
  it("does not assign an ambiguous legacy input to either of two genuine native messages", async () => {
    await appendFile(join(root, sourcePath), JSON.stringify(message("near-copy", 3)) + "\n");
    const row = legacy("ambiguous", 0);
    await kv.set(KV.observations("s"), row.id, row);
    const input = { ...scope, sourcePath, dryRun: true, retainUnmatched: true, reconcileDuplicates: true };
    const plan = await initializeCodexSourceCapture(kv as never, input, managed());
    expect(plan).toMatchObject({ adopt: 0, missing: 3, unresolvedCaptureCount: 1, linkDuplicateCaptures: 0 });
    await initializeCodexSourceCapture(kv as never, { ...input, dryRun: false, expectedVersion: plan.expectedVersion, reason: "do not guess either primary" }, managed());
    expect(await capture()).toMatchObject({ inserted: 3, unresolvedCaptureCount: 1 });
    expect(await capture()).toMatchObject({ inserted: 0 });
    expect(await kv.get(KV.observations("s"), row.id)).toEqual(row);
    expect((await kv.list<CompressedObservation>(KV.observations("s"))).filter(row => row.codexSource)).toHaveLength(3);
  });
  it("rejects changed retained content without advancing capture and requires a new explicit review", async () => {
    const row = { ...legacy("unmatched", 0), narrative: "old body" };
    await kv.set(KV.observations("s"), row.id, row);
    const input = { ...scope, sourcePath, dryRun: true, retainUnmatched: true };
    const plan = await initializeCodexSourceCapture(kv as never, input, managed());
    await initializeCodexSourceCapture(kv as never, { ...input, dryRun: false, expectedVersion: plan.expectedVersion, reason: "review" }, managed());
    await kv.set(KV.observations("s"), row.id, { ...row, narrative: "changed body" });
    await expect(capture()).rejects.toThrow("reconciliation");
    expect((await kv.get<Session>(KV.sessions, "s"))!.codexNativeCapture!.cursor!.byteOffset).toBe(0);
    await expect(initializeCodexSourceCapture(kv as never, input, managed())).rejects.toThrow("changed");
  });
  it("reconciles a formerly unresolved observation after exact evidence appears, including interrupted adoption", async () => {
    const row = { ...legacy("unmatched", 40), narrative: "recovered exact body" };
    await kv.set(KV.observations("s"), row.id, row);
    const input = { ...scope, sourcePath, dryRun: true, retainUnmatched: true };
    const plan = await initializeCodexSourceCapture(kv as never, input, managed());
    await initializeCodexSourceCapture(kv as never, { ...input, dryRun: false, expectedVersion: plan.expectedVersion, reason: "review" }, managed());
    await appendFile(join(root, sourcePath), JSON.stringify(message("recovered", 40, row.narrative)) + "\n");
    const recovered = await preview();
    expect(recovered).toMatchObject({ adopt: 1, unresolvedCaptureCount: 0 });
    const set = kv.set;
    kv.set = async (group, id, value) => { if (group === KV.sessions) throw Error("interrupted initialization checkpoint"); return set(group, id, value); };
    await expect(initializeCodexSourceCapture(kv as never, { ...scope, sourcePath, dryRun: false,
      expectedVersion: recovered.expectedVersion, reason: "now proven" }, managed())).rejects.toThrow("interrupted initialization");
    kv.set = set;
    expect(await kv.get(KV.observations("s"), row.id)).toHaveProperty("codexSource.nativeMessageId", "recovered");
    await initialize();
    expect(await capture()).toMatchObject({ inserted: 2, unresolvedCaptureCount: 0 });
    expect(await capture()).toMatchObject({ inserted: 0 });
  });
  it.each(["raw", "protected", "bound", "owner", "empty"])("never retains an unresolved %s capture", async kind => {
    const row = kind === "raw" ? rawPrompt("unsafe", 40, "not in source") : { ...legacy("unsafe", 40), narrative: "not in source",
      ...(kind === "protected" ? { emptyDeletion: { state: "deleted" } } : {}),
      ...(kind === "bound" ? { codexSource: { key: "a".repeat(64) } } : {}),
      ...(kind === "owner" ? { agentId: "other" } : {}), ...(kind === "empty" ? { narrative: "" } : {}) };
    await kv.set(KV.observations("s"), row.id, row);
    await expect(initializeCodexSourceCapture(kv as never, { ...scope, sourcePath, dryRun: true, retainUnmatched: true }, managed())).rejects.toThrow();
    expect(await kv.get(KV.observations("s"), row.id)).toEqual(row);
    await expectUninitialized();
  });
  it("never uses partial initialization to bypass ambiguous forget provenance", async () => {
    const row = { ...legacy("unmatched", 40), narrative: "not in source" };
    await kv.set(KV.observations("s"), row.id, row);
    const id = codexExclusionId("s", "forgotten");
    await kv.set(KV.codexCaptureExclusions, id, { version: 1, id, sessionId: "s", project: "p", observationId: "forgotten",
      forgottenAt: "2026-09-13T00:01:00Z", match: { kind: "unresolved" } });
    await expect(initializeCodexSourceCapture(kv as never, { ...scope, sourcePath, dryRun: true, retainUnmatched: true }, managed())).rejects.toThrow("correspondence");
    await expectUninitialized();
  });
  let root: string; let kv: ReturnType<typeof mockKV>;
  const sourcePath = "sessions/rollout-a.jsonl";
  const scope = { project: "p", sessionId: "s" };
  const session: Session = { id: "s", project: "p", cwd: "C:/work/p", agentId: "codex-global",
    startedAt: "2026-09-13T00:00:00Z", observationCount: 0, status: "active" };
  const managed = () => ({ sourceRoot: root, agentId: "codex-global" });
  const message = (id: string, seconds: number, text = "진행") => ({ type: "response_item", timestamp: `2026-09-13T00:00:${seconds.toString().padStart(2, "0")}Z`,
    payload: { type: "message", role: "user", id, content: [{ type: "input_text", text }] } });
  const assistantMessage = (id: string, seconds: number, text = "완료") => ({ type: "response_item", timestamp: `2026-09-13T00:00:${seconds.toString().padStart(2, "0")}Z`,
    payload: { type: "message", role: "assistant", phase: "final", id, content: [{ type: "output_text", text }] } });
  const legacy = (id: string, seconds: number): CompressedObservation => ({ id, sessionId: "s", timestamp: message(id, seconds).timestamp,
    type: "conversation", title: "prompt_submit", narrative: "진행", facts: ["preserved"], concepts: [], files: [], importance: 7, agentId: "codex-global" });
  const rawPrompt = (id: string, seconds: number, text = "진행") => ({ id, sessionId: "s", timestamp: message(id, seconds, text).timestamp,
    hookType: "prompt_submit", userPrompt: text, raw: { prompt: text }, agentId: "codex-global",
    origin: { channel: "user", capturedAt: message(id, seconds, text).timestamp } });
  const rawAssistant = (id: string, seconds: number, text = "완료") => ({ id, sessionId: "s", timestamp: assistantMessage(id, seconds, text).timestamp,
    hookType: "post_tool_use", toolName: "assistant_response", toolInput: { turn_id: "turn-a" }, toolOutput: text,
    raw: { tool_output: text }, agentId: "codex-global",
    origin: { channel: "agent", detail: "assistant_response", capturedAt: assistantMessage(id, seconds, text).timestamp } });
  const preview = () => initializeCodexSourceCapture(kv as never, { ...scope, sourcePath, dryRun: true }, managed());
  const initialize = async () => {
    const plan = await preview();
    return initializeCodexSourceCapture(kv as never, { ...scope, sourcePath, dryRun: false, expectedVersion: plan.expectedVersion, reason: "verified fixture" }, managed());
  };
  const capture = (publish?: (rows: CompressedObservation[]) => Promise<void>) => captureCodexSourceWindow(kv as never, scope, managed(), { publish });
  const expectUninitialized = async () => {
    expect(await kv.get(KV.sessions, "s")).not.toHaveProperty("codexNativeCapture");
    expect(await kv.list(KV.audit)).toEqual([]);
  };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agentmemory-native-capture-"));
    await mkdir(join(root, "sessions"));
    await writeFile(join(root, sourcePath), [{ type: "session_meta", payload: { id: "s", source: "vscode", cwd: session.cwd, timestamp: session.startedAt } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-a" } }, message("m1", 1), message("m2", 21)].map(row => JSON.stringify(row)).join("\n") + "\n");
    kv = mockKV(); await kv.set(KV.sessions, "s", structuredClone(session));
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("initializes past an already deleted empty row without restoring, rewriting or binding it", async () => {
    const row = { ...legacy("deleted-empty", 10), narrative: "", facts: [], title: "assistant_response", type: "other" as const,
      emptyDeletion: { state: "deleted" as const, version: 1, changedAt: "2026-09-14T00:00:00Z", reason: "Intentional deletion", auditId: "existing-audit" } };
    await kv.set(KV.observations("s"), row.id, row);
    expect(await preview()).toMatchObject({ adopt: 0, recoverRaw: 0, missing: 2 });
    await initialize();
    expect(await kv.get(KV.observations("s"), row.id, { includeDeleted: true })).toEqual(row);
    expect(JSON.stringify(await kv.list(KV.audit))).not.toContain('"' + row.id + '"');
    expect(await capture()).toMatchObject({ inserted: 2, status: "caught_up" });
    expect(await kv.get(KV.observations("s"), row.id, { includeDeleted: true })).toEqual(row);
  });

  it("restores a verified 400-character user compression in place and republishes the complete original", async () => {
    const text = "Original request ".repeat(50);
    await writeFile(join(root, sourcePath), [
      { type: "session_meta", payload: { id: "s", source: "vscode", cwd: session.cwd, timestamp: session.startedAt } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-a" } }, message("long", 1, text),
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    const row = { ...legacy("truncated-prompt", 1), narrative: text.slice(0, 399) + "…", confidence: 0.3 };
    await kv.set(KV.observations("s"), row.id, row);
    expect(await preview()).toMatchObject({ restoreLegacySynthetic: 1 });
    await initialize();
    expect(await kv.get(KV.observations("s"), row.id)).toEqual({ ...row, narrative: text,
      codexSource: expect.objectContaining({ nativeMessageId: "long" }) });
    const published: CompressedObservation[] = [];
    expect(await capture(async rows => { published.push(...rows); })).toMatchObject({ inserted: 0, indexPending: false });
    expect(published.find(item => item.id === row.id)?.narrative).toBe(text);
    expect(await preview()).toMatchObject({ restoreLegacySynthetic: 0 });
  });

  it("adopts a delayed final while preserving its observed time and publishing canonical source time", async () => {
    await appendFile(join(root, sourcePath), JSON.stringify(assistantMessage("final", 24, "finished")) + "\n");
    const row = { ...legacy("delayed-final", 40), type: "other" as const, title: "assistant_response",
      subtitle: JSON.stringify({ turn_id: "turn-a" }), narrative: "finished" };
    await kv.set(KV.observations("s"), row.id, row);
    expect(await preview()).toMatchObject({ adoptDelayedFinal: 1 });
    await initialize();
    expect(await kv.get(KV.observations("s"), row.id)).toEqual({ ...row,
      codexSource: expect.objectContaining({ timestamp: assistantMessage("final", 24).timestamp, nativeMessageId: "final" }) });
    expect(JSON.stringify(await kv.list(KV.audit))).toContain('"adoptDelayedFinalObservationIds":["delayed-final"]');
    const published: CompressedObservation[] = [];
    expect(await capture(async rows => { published.push(...rows); })).toMatchObject({ inserted: 2, indexPending: false });
    expect(published.find(item => item.id === row.id)?.timestamp).toBe(row.timestamp);
    expect(await preview()).toMatchObject({ adoptDelayedFinal: 0, missing: 0 });
  });

  it("restores proven recovery content parts in the same row and reindexes without storing helper proof", async () => {
    const native = message("parts", 1, "request\n");
    native.payload.content.push({ type: "input_image", text: "" });
    await writeFile(join(root, sourcePath), [
      { type: "session_meta", payload: { id: "s", source: "vscode", cwd: session.cwd, timestamp: session.startedAt } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-a" } }, native, message("m2", 21),
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    const oldText = "request\n\n";
    const id = "obs_codex_recovery_" + createHash("sha256").update(["s", "turn-a", "prompt_submit", native.timestamp, oldText].join("\n")).digest("hex").slice(0, 32);
    const row = { ...legacy(id, 1), narrative: oldText, origin: {
      channel: "user" as const, detail: "Codex original turn turn-a", capturedAt: native.timestamp } };
    await kv.set(KV.observations("s"), id, row);
    expect(await preview()).toMatchObject({ restoreLegacyRecoveryParts: 1 });
    expect(await kv.get(KV.observations("s"), id)).toEqual(row);
    await initialize();
    expect(await kv.get(KV.observations("s"), id)).toEqual({ ...row, narrative: "request\n",
      codexSource: expect.objectContaining({ nativeMessageId: "parts" }) });
    expect((await kv.get<CompressedObservation>(KV.observations("s"), id))!.codexSource).not.toHaveProperty("legacyRecovery");
    expect(JSON.stringify(await kv.list(KV.audit))).toContain('"restoreLegacyRecoveryPartsObservationIds":["' + id + '"]');
    const published: CompressedObservation[] = [];
    expect(await capture(async rows => { published.push(...rows); })).toMatchObject({ inserted: 1, indexPending: false });
    expect(published.find(item => item.id === id)?.narrative).toBe("request\n");
    expect(await preview()).toMatchObject({ restoreLegacyRecoveryParts: 0, missing: 0 });
  });

  it("restores a proven UTC timestamp in place and publishes it through the existing retry path", async () => {
    const native = { ...message("m1", 1), timestamp: "2026-09-13T00:00:01.625Z" };
    await writeFile(join(root, sourcePath), [
      { type: "session_meta", payload: { id: "s", source: "vscode", cwd: session.cwd, timestamp: session.startedAt } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-a" } }, native, message("m2", 21),
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    const row = { ...legacy("original-time", 1), timestamp: "09/13/2026 00:00:01" };
    await kv.set(KV.observations("s"), row.id, row);
    expect(await preview()).toMatchObject({ restoreLegacyTimestamp: 1 });
    expect(await kv.get(KV.observations("s"), row.id)).toEqual(row);
    await initialize();
    expect(await kv.get(KV.observations("s"), row.id)).toEqual({ ...row, timestamp: native.timestamp,
      codexSource: expect.objectContaining({ timestamp: native.timestamp, nativeMessageId: "m1" }) });
    expect((await kv.get<Session>(KV.sessions, "s"))!.codexNativeCapture!.indexPending).toBe(true);
    expect(JSON.stringify(await kv.list(KV.audit))).toContain('"restoreLegacyTimestampObservationIds":["original-time"]');
    const published: CompressedObservation[] = [];
    expect(await capture(async rows => { published.push(...rows); })).toMatchObject({ status: "caught_up", inserted: 1, indexPending: false });
    expect(published.filter(item => item.id === row.id)).toMatchObject([{ timestamp: native.timestamp }]);
    expect(await capture()).toMatchObject({ inserted: 0 });
    expect(await preview()).toMatchObject({ restoreLegacyTimestamp: 0, missing: 0 });
  });

  it("accepts engine-reordered source keys but rejects a changed source value", async () => {
    await initialize();
    const current = (await kv.get<Session>(KV.sessions, "s"))!;
    const original = current.codexNativeCapture!.source;
    current.codexNativeCapture!.source = Object.fromEntries(Object.entries(original).sort(([a], [b]) => a.localeCompare(b))) as typeof original;
    expect(JSON.stringify(current.codexNativeCapture!.source)).not.toBe(JSON.stringify(original));
    await kv.set(KV.sessions, "s", current);
    expect(await capture()).toMatchObject({ inserted: 2, status: "caught_up" });
    const altered = (await kv.get<Session>(KV.sessions, "s"))!;
    altered.codexNativeCapture!.source.createdAt = "2026-09-12T00:00:00Z";
    await kv.set(KV.sessions, "s", altered);
    await expect(capture()).rejects.toThrow("Native capture source identity changed");
    expect(await kv.list(KV.observations("s"))).toHaveLength(2);
  });

  it("adopts the exact existing ID and captures repeated messages once across restart and append", async () => {
    const row = legacy("old-id", 1); await kv.set(KV.observations("s"), row.id, row);
    const plan = await preview();
    expect(plan).toMatchObject({ dryRun: true, adopt: 1, missing: 1 });
    expect(await kv.list(KV.audit)).toEqual([]);
    await initialize();
    expect(await kv.get(KV.observations("s"), row.id)).toMatchObject({ ...row, codexSource: { nativeMessageId: "m1" } });
    expect((await kv.get<Session>(KV.sessions, "s"))!.codexNativeCapture!.cursor!.byteOffset).toBe(0);
    const published: string[] = [];
    const first = await capture(async rows => { published.push(...rows.map(row => row.id)); });
    expect(first).toMatchObject({ inserted: 1, status: "caught_up", indexPending: false });
    expect(published).toHaveLength(2);
    expect(new Set(published).size).toBe(2);
    expect(await capture()).toMatchObject({ inserted: 0, status: "caught_up" });
    await appendFile(join(root, sourcePath), JSON.stringify(message("m3", 41)) + "\n");
    expect(await capture()).toMatchObject({ inserted: 1, status: "caught_up", indexPending: true });
    expect(await kv.get(KV.sessions, "s")).toMatchObject({ observationCount: 3 });
    expect(await kv.get(KV.observations("s"), row.id)).toMatchObject(row);
  });
  it("rejects a stale initialization preview before changing any rows", async () => {
    await kv.set(KV.observations("s"), "old-id", legacy("old-id", 1));
    const plan = await preview();
    await kv.set(KV.observations("s"), "old-id", { ...legacy("old-id", 1), importance: 9 });
    await expect(initializeCodexSourceCapture(kv as never, { ...scope, sourcePath, dryRun: false,
      expectedVersion: plan.expectedVersion, reason: "fixture" }, managed())).rejects.toThrow("stale");
    expect(await kv.get(KV.observations("s"), "old-id")).not.toHaveProperty("codexSource");
    expect(await kv.list(KV.audit)).toEqual([]);
  });
  it("does not treat a bounded automatic inventory as complete when more original messages remain", async () => {
    let windows = 0;
    await expect(initializeCodexSourceCapture(kv as never, { ...scope, sourcePath, dryRun: true },
      { ...managed(), maxInventoryWindows: 1 }, async input => { windows++; return readCodexWindow({ ...input, maxMessages: 1 }); }))
      .rejects.toThrow("complete supported native inventory");
    expect(windows).toBe(1);
    expect(await kv.get(KV.sessions, "s")).not.toHaveProperty("codexNativeCapture");
    expect(await kv.list(KV.observations("s"))).toEqual([]);
  });
  it("ignores a source root injected through an internal function input", async () => {
    expect(await initializeCodexSourceCapture(kv as never, { ...scope, sourcePath, dryRun: true,
      sourceRoot: "C:/untrusted", agentId: "other-agent" } as never, managed())).toMatchObject({ dryRun: true, missing: 2 });
  });
  it("retries an interrupted adoption without replacing existing observations", async () => {
    for (const [id, seconds] of [["old-1", 1], ["old-2", 21]] as const) await kv.set(KV.observations("s"), id, legacy(id, seconds));
    const set = kv.set;
    kv.set = async (scope, key, value) => { if (key === "old-2") throw Error("interrupted adoption"); return set(scope, key, value); };
    await expect(initialize()).rejects.toThrow("interrupted adoption");
    expect(await kv.get(KV.sessions, "s")).not.toHaveProperty("codexNativeCapture");
    expect(await kv.get(KV.observations("s"), "old-1")).toHaveProperty("codexSource");
    kv.set = set;
    await initialize();
    expect(await capture()).toMatchObject({ inserted: 0, status: "caught_up" });
    expect((await kv.list<CompressedObservation>(KV.observations("s"))).map(row => row.id).sort()).toEqual(["old-1", "old-2"]);
  });
  it.each(["observation", "checkpoint"])("recovers from %s write failure without advancing past unstored messages", async failure => {
    await initialize(); const set = kv.set; let writes = 0;
    kv.set = async (scope, key, value) => {
      if (scope === KV.observations("s") && ++writes === 2 && failure === "observation") throw Error("interrupted capture");
      if (scope === KV.sessions && failure === "checkpoint" && (value as Session).codexNativeCapture?.cursor?.byteOffset) throw Error("interrupted capture");
      return set(scope, key, value);
    };
    await expect(capture()).rejects.toThrow("interrupted capture");
    expect((await kv.get<Session>(KV.sessions, "s"))!.codexNativeCapture!.cursor!.byteOffset).toBe(0);
    const before = await kv.list<CompressedObservation>(KV.observations("s"));
    kv.set = set;
    expect(await capture()).toMatchObject({ status: "caught_up", inserted: failure === "observation" ? 1 : 0 });
    const after = await kv.list<CompressedObservation>(KV.observations("s"));
    expect(after).toHaveLength(2);
    for (const row of before) expect(after.find(stored => stored.id === row.id)).toEqual(row);
    expect(await kv.get(KV.sessions, "s")).toMatchObject({ observationCount: 2 });
  });
  it("records an unsupported appended record as unknown without skipping it", async () => {
    await initialize(); await capture();
    await appendFile(join(root, sourcePath), JSON.stringify(message("m3", 41)) + "\n" + JSON.stringify({ type: "future_record" }) + "\n");
    const first = await capture();
    expect(first).toMatchObject({ status: "unknown", inserted: 1 });
    expect(await capture()).toMatchObject({ status: "unknown", inserted: 0, bytesReadThrough: first.bytesReadThrough });
  });
  it("captures while an unrelated observation writer is waiting, and keeps index failure separate", async () => {
    await initialize(); let release!: () => void;
    const held = withObservationWrite(() => new Promise<void>(resolve => { release = resolve; }));
    try { expect(await capture(async () => { throw Error("index unavailable"); })).toMatchObject({ status: "caught_up", inserted: 2, indexPending: true }); }
    finally { release(); await held; }
    expect(await kv.get(KV.sessions, "s")).toMatchObject({ observationCount: 2 });
    const indexed: string[] = [];
    expect(await capture(async rows => { indexed.push(...rows.map(row => row.id)); })).toMatchObject({ inserted: 0, indexPending: false });
    expect(indexed).toHaveLength(2);
  });
  it("serializes concurrent catch-up requests for the same session", async () => {
    await initialize();
    const results = await Promise.all([capture(), capture()]);
    expect(results.map(row => row.inserted).sort()).toEqual([0, 2]);
    expect(await kv.list(KV.observations("s"))).toHaveLength(2);
    expect(await kv.get(KV.sessions, "s")).toMatchObject({ observationCount: 2 });
  });
  it("does not leave a stale caught-up status after a source read failure", async () => {
    await initialize(); await capture();
    const before = (await kv.get<Session>(KV.sessions, "s"))!.codexNativeCapture!.cursor;
    await expect(captureCodexSourceWindow(kv as never, scope, managed(), { readWindow: async () => { throw Error("source unavailable"); } })).rejects.toThrow("source unavailable");
    expect(await kv.get(KV.sessions, "s")).toMatchObject({ codexNativeCapture: { status: "unknown", issue: "native_source_read_failed", cursor: before } });
  });
  it("refuses new unbound hook captures instead of duplicating them", async () => {
    await initialize();
    await kv.set(KV.observations("s"), "late-hook", legacy("late-hook", 1));
    await expect(capture()).rejects.toThrow("correspondence changed");
    expect(await kv.get(KV.sessions, "s")).toMatchObject({ codexNativeCapture: { status: "unknown", cursor: { byteOffset: 0 } } });
    expect(await kv.list(KV.observations("s"))).toHaveLength(1);
  });
  it("recovers raw prompt and assistant rows in place from the actual JSONL inventory", async () => {
    const prompt = message("native-user", 1, "raw prompt");
    const assistant = assistantMessage("native-assistant", 2, "raw answer");
    await writeFile(join(root, sourcePath), [
      { type: "session_meta", payload: { id: "s", source: "vscode", cwd: session.cwd, timestamp: session.startedAt } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-a" } }, prompt, assistant,
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    const promptRow = { ...rawPrompt("raw-prompt", 1, "raw prompt"), project: "p" };
    const assistantRow = rawAssistant("raw-assistant", 2, "raw answer");
    await kv.set(KV.observations("s"), promptRow.id, promptRow);
    await kv.set(KV.observations("s"), assistantRow.id, assistantRow);

    expect(await preview()).toMatchObject({ dryRun: true, adopt: 2, missing: 0, recoverRaw: 2 });
    expect(await kv.get(KV.observations("s"), promptRow.id)).toEqual(promptRow);
    expect(await kv.get(KV.observations("s"), assistantRow.id)).toEqual(assistantRow);
    expect(await kv.list(KV.audit)).toEqual([]);

    expect(await initialize()).toMatchObject({ initialized: true, recoverRaw: 2 });
    const recoveredPrompt = await kv.get<any>(KV.observations("s"), promptRow.id);
    const recoveredAssistant = await kv.get<any>(KV.observations("s"), assistantRow.id);
    expect(recoveredPrompt).toMatchObject({ id: promptRow.id, sessionId: "s", timestamp: promptRow.timestamp,
      project: "p", agentId: "codex-global", type: "conversation", title: "prompt_submit", narrative: "raw prompt",
      origin: promptRow.origin, codexSource: { nativeMessageId: "native-user", kind: "user" } });
    expect(recoveredAssistant).toMatchObject({ id: assistantRow.id, sessionId: "s", timestamp: assistantRow.timestamp,
      project: "p", agentId: "codex-global", title: "assistant_response", narrative: "raw answer",
      origin: assistantRow.origin, codexSource: { nativeMessageId: "native-assistant", kind: "assistant_final" } });
    expect(recoveredPrompt).not.toHaveProperty("hookType");
    expect(recoveredPrompt).not.toHaveProperty("raw");
    expect(recoveredAssistant).not.toHaveProperty("toolName");
    expect(recoveredAssistant).not.toHaveProperty("raw");
    expect(await kv.get<Session>(KV.sessions, "s")).toMatchObject({ codexNativeCapture: { indexPending: true } });
    expect(await kv.list<any>(KV.audit)).toMatchObject([{ functionId: "mem::codex-source-initialize", targetIds: ["s"],
      details: { recoverRaw: 2, recoverRawObservationIds: [promptRow.id, assistantRow.id] } }]);
  });
  it("restores only the missing final LF proven by the full source, retaining the row metadata and retrying idempotently", async () => {
    const row = { ...legacy("legacy-lf", 1), narrative: "진행" };
    await writeFile(join(root, sourcePath), [
      { type: "session_meta", payload: { id: "s", source: "vscode", cwd: session.cwd, timestamp: session.startedAt } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-a" } }, message("m1", 1, "진행\n"),
    ].map(value => JSON.stringify(value)).join("\n") + "\n");
    await kv.set(KV.observations("s"), row.id, row);
    expect(await preview()).toMatchObject({ adopt: 1, restoreTerminalLf: 1 });
    expect(await kv.get(KV.observations("s"), row.id)).toEqual(row);
    expect(await initialize()).toMatchObject({ initialized: true, restoreTerminalLf: 1 });
    const repaired = await kv.get<any>(KV.observations("s"), row.id);
    expect(repaired).toEqual({ ...row, narrative: "진행\n", codexSource: expect.objectContaining({ nativeMessageId: "m1" }) });
    expect(await kv.list<any>(KV.audit)).toMatchObject([{ details: { restoreTerminalLfObservationIds: [row.id] } }]);
    expect(await preview()).toMatchObject({ adopt: 0, restoreTerminalLf: 0 });
    await initialize();
    const indexed: string[] = [];
    expect(await capture(async rows => { indexed.push(...rows.map(item => item.id)); })).toMatchObject({ inserted: 0, indexPending: false });
    expect(indexed).toEqual([row.id]);
    expect(await kv.get(KV.observations("s"), row.id)).toEqual(repaired);
  });
  it.each(["short answer", "complete original answer ".repeat(100)])("restores an exactly re-encoded legacy assistant from actual source bytes (%#)", async text => {
    const input = JSON.stringify({ turn_id: "turn-a" });
    const old = input + " | " + text;
    const row = { ...legacy("old-synthetic", 2), title: "assistant_response", type: "other" as const,
      subtitle: input, confidence: 0.3, narrative: old.length > 400 ? old.slice(0, 399) + "…" : old };
    await writeFile(join(root, sourcePath), [
      { type: "session_meta", payload: { id: "s", source: "vscode", cwd: session.cwd, timestamp: session.startedAt } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-a" } },
      message("m1", 1), assistantMessage("answer", 2, text),
    ].map(value => JSON.stringify(value)).join("\n") + "\n");
    await kv.set(KV.observations("s"), row.id, row);
    expect(await preview()).toMatchObject({ adopt: 1, restoreTerminalLf: 0, restoreLegacySynthetic: 1 });
    expect(await kv.get(KV.observations("s"), row.id)).toEqual(row);
    await initialize();
    expect(await kv.get(KV.observations("s"), row.id)).toEqual({ ...row, narrative: text,
      codexSource: expect.objectContaining({ nativeMessageId: "answer" }) });
    expect(await kv.list<any>(KV.audit)).toMatchObject([{ details: { restoreLegacySyntheticObservationIds: [row.id] } }]);
    expect(await preview()).toMatchObject({ adopt: 0, restoreLegacySynthetic: 0 });
  });
  it("repairs image wrapper serialization from real source without changing identity, metadata or image payloads", async () => {
    const opening = '<image name="one" path="C:/images/one.png">';
    const native = message("image-user", 1, "사진을 확인해줘");
    const row = { ...legacy("image-old", 1), narrative: `사진을 확인해줘\n${opening}\n\n</image>`,
      modality: "mixed" as const, imageRef: "existing-image-ref" };
    await writeFile(join(root, sourcePath), [
      { type: "session_meta", payload: { id: "s", source: "vscode", cwd: session.cwd, timestamp: session.startedAt } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-a" } },
      { ...native, payload: { ...native.payload, content: [...native.payload.content,
        { type: "input_text", text: opening }, { type: "input_image", image_url: "data:image/png;base64,aA==" },
        { type: "input_text", text: "</image>" }] } },
    ].map(value => JSON.stringify(value)).join("\n") + "\n");
    await kv.set(KV.observations("s"), row.id, row);
    expect(await preview()).toMatchObject({ adopt: 1, missing: 0, restoreLegacyImageText: 1 });
    expect(await kv.get(KV.observations("s"), row.id)).toEqual(row);
    await initialize();
    const repaired = await kv.get<CompressedObservation>(KV.observations("s"), row.id);
    expect(repaired).toEqual({ ...row, narrative: "사진을 확인해줘", codexSource: expect.objectContaining({ nativeMessageId: "image-user" }) });
    expect(repaired!.codexSource).not.toHaveProperty("legacyImageWrappedDigest");
    expect(await kv.list<any>(KV.audit)).toMatchObject([{ details: { restoreLegacyImageTextObservationIds: [row.id] } }]);
    const published: string[] = [];
    expect(await capture(async rows => { published.push(...rows.map(value => value.id)); })).toMatchObject({ inserted: 0, indexPending: false });
    expect(published).toEqual([row.id]);
    expect(await preview()).toMatchObject({ adopt: 0, restoreLegacyImageText: 0 });
  });
  it("refuses an oversized full answer before a legacy recovery writes anything", async () => {
    const { SAFE_PAYLOAD_BYTES } = await import("../src/state/frame-guard.js");
    const text = "가".repeat(SAFE_PAYLOAD_BYTES / 3);
    const input = JSON.stringify({ turn_id: "turn-a" });
    const row = { ...legacy("oversized-legacy", 2), title: "assistant_response", type: "other" as const,
      subtitle: input, confidence: 0.3, narrative: (input + " | " + text).slice(0, 399) + "…" };
    await writeFile(join(root, sourcePath), [
      { type: "session_meta", payload: { id: "s", source: "vscode", cwd: session.cwd, timestamp: session.startedAt } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-a" } },
      message("m1", 1), assistantMessage("answer", 2, text),
    ].map(value => JSON.stringify(value)).join("\n") + "\n");
    await kv.set(KV.observations("s"), row.id, row);
    await expect(preview()).rejects.toThrow("frame limit");
    expect(await kv.get(KV.observations("s"), row.id)).toEqual(row);
    await expectUninitialized();
  });
  it("keeps dry-run raw recovery read-only and rejects metadata-only stale apply", async () => {
    const row = rawPrompt("raw-prompt", 1);
    await kv.set(KV.observations("s"), row.id, row);
    const plan = await preview();
    expect(plan).toMatchObject({ dryRun: true, recoverRaw: 1 });
    expect(await kv.get(KV.observations("s"), row.id)).toEqual(row);
    expect(await kv.list(KV.audit)).toEqual([]);
    await kv.set(KV.observations("s"), row.id, { ...row, origin: { ...row.origin, detail: "changed" } });
    await expect(initializeCodexSourceCapture(kv as never, { ...scope, sourcePath, dryRun: false,
      expectedVersion: plan.expectedVersion, reason: "stale raw recovery" }, managed())).rejects.toThrow("stale");
    expect(await kv.get<any>(KV.observations("s"), row.id)).not.toHaveProperty("codexSource");
    await expectUninitialized();
  });
  it("refuses raw rows carrying protected or derived metadata before any write", async () => {
    const row = { ...rawPrompt("raw-prompt", 1), emptyDeletion: { state: "restored", version: 1,
      reason: "preserve", auditId: "audit-a", changedAt: "2026-09-13T00:00:00Z" } };
    await kv.set(KV.observations("s"), row.id, row);
    await expect(preview()).rejects.toThrow("derived metadata");
    expect(await kv.get(KV.observations("s"), row.id)).toEqual(row);
    await expectUninitialized();
  });
  it("refuses raw rows with the wrong owner before any write", async () => {
    const row = { ...rawPrompt("raw-prompt", 1), agentId: "other-agent" };
    await kv.set(KV.observations("s"), row.id, row);
    await expect(preview()).rejects.toThrow("invalid canonical shape");
    expect(await kv.get(KV.observations("s"), row.id)).toEqual(row);
    await expectUninitialized();
  });
  it("keeps a body mismatch blocked by the existing exact digest gate", async () => {
    const row = rawPrompt("raw-prompt", 1, "different body");
    await kv.set(KV.observations("s"), row.id, row);
    await expect(preview()).rejects.toThrow("correspondence");
    expect(await kv.get(KV.observations("s"), row.id)).toEqual(row);
    await expectUninitialized();
  });
  it.each([
    { project: "other-project" }, { modality: "unknown" }, { imageData: 123 },
  ])("rejects invalid raw ownership or media metadata %j without writes", async patch => {
    const row = { ...rawPrompt("raw-prompt", 1), ...patch };
    await kv.set(KV.observations("s"), row.id, row);
    await expect(preview()).rejects.toThrow("invalid canonical shape");
    expect(await kv.get(KV.observations("s"), row.id)).toEqual(row);
    await expectUninitialized();
  });
  it.each([
    { hookType: "session_end" }, { assistantResponse: "alternate answer" }, { narrative: "already compressed" },
  ])("does not recover an unsupported or already compressed assistant shape %j", async patch => {
    const row = { ...rawAssistant("raw-assistant", 2), ...patch };
    await kv.set(KV.observations("s"), row.id, row);
    await expect(preview()).rejects.toThrow(/invalid canonical shape|derived metadata/);
    expect(await kv.get(KV.observations("s"), row.id)).toEqual(row);
    await expectUninitialized();
  });
  it("keeps competing raw candidates blocked as an ambiguous correspondence", async () => {
    const first = rawPrompt("raw-prompt-a", 1);
    const second = rawPrompt("raw-prompt-b", 1);
    await kv.set(KV.observations("s"), first.id, first);
    await kv.set(KV.observations("s"), second.id, second);
    await expect(preview()).rejects.toThrow("correspondence");
    expect(await kv.get(KV.observations("s"), first.id)).toEqual(first);
    expect(await kv.get(KV.observations("s"), second.id)).toEqual(second);
    await expectUninitialized();
  });
  it("does not report a raw internal notification as recovered without an adopted native source", async () => {
    const row = rawPrompt("raw-internal", 1, "<subagent_notification>internal</subagent_notification>");
    await kv.set(KV.observations("s"), row.id, row);
    await expect(preview()).rejects.toThrow("correspondence");
    expect(await kv.get(KV.observations("s"), row.id)).toEqual(row);
    await expectUninitialized();
  });
  it("blocks raw recovery when another stored observation is unmatched", async () => {
    const row = rawPrompt("raw-prompt", 1);
    await kv.set(KV.observations("s"), row.id, row);
    await kv.set(KV.observations("s"), "unmatched", { ...legacy("unmatched", 21), narrative: "unmatched body" });
    await expect(preview()).rejects.toThrow("correspondence");
    expect(await kv.get(KV.observations("s"), row.id)).toEqual(row);
    expect(await kv.get<any>(KV.observations("s"), "unmatched")).not.toHaveProperty("codexSource");
    await expectUninitialized();
  });
  it("restarts partial raw recovery using present rows without creating duplicate IDs", async () => {
    const first = rawPrompt("raw-prompt-a", 1);
    const second = rawPrompt("raw-prompt-b", 21);
    await kv.set(KV.observations("s"), first.id, first);
    await kv.set(KV.observations("s"), second.id, second);
    const set = kv.set;
    kv.set = async (scope, key, value) => {
      if (scope === KV.observations("s") && key === second.id) throw Error("interrupted raw recovery");
      return set(scope, key, value);
    };
    await expect(initialize()).rejects.toThrow("interrupted raw recovery");
    kv.set = set;
    expect(await kv.get<any>(KV.observations("s"), first.id)).toMatchObject({ codexSource: { nativeMessageId: "m1" } });
    expect(await kv.get<any>(KV.observations("s"), second.id)).toHaveProperty("hookType", "prompt_submit");
    expect(await kv.get(KV.sessions, "s")).not.toHaveProperty("codexNativeCapture");
    expect(await preview()).toMatchObject({ adopt: 1, recoverRaw: 1 });
    await initialize();
    const rows = await kv.list<any>(KV.observations("s"));
    expect(rows.map(row => row.id).sort()).toEqual([first.id, second.id]);
    expect(rows.every(row => row.codexSource)).toBe(true);
    expect(await kv.get<Session>(KV.sessions, "s")).toMatchObject({ codexNativeCapture: { indexPending: true } });
  });
  it("keeps the recovered session index pending until capture publication succeeds", async () => {
    await writeFile(join(root, sourcePath), [
      { type: "session_meta", payload: { id: "s", source: "vscode", cwd: session.cwd, timestamp: session.startedAt } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-a" } }, message("m1", 1),
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    const row = rawPrompt("raw-prompt", 1);
    await kv.set(KV.observations("s"), row.id, row);
    await initialize();
    expect(await capture(async () => { throw Error("index unavailable"); })).toMatchObject({ inserted: 0, indexPending: true });
    expect(await kv.get<Session>(KV.sessions, "s")).toMatchObject({ codexNativeCapture: { indexPending: true } });
    const indexed: string[] = [];
    expect(await capture(async rows => { indexed.push(...rows.map(item => item.id)); })).toMatchObject({ inserted: 0, indexPending: false });
    expect(indexed).toEqual([row.id]);
    expect(await kv.get<Session>(KV.sessions, "s")).toMatchObject({ codexNativeCapture: { indexPending: false } });
  });
});
