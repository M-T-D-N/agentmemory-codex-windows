import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initialCodexParseState, parseCodexRecord, pendingCodexMirrors, type CodexNativeMessage } from "../src/replay/codex-record.js";
import { parseCodexRecordWithHolds } from "../src/replay/codex-source-hold.js";
import { readCodexWindow } from "../src/replay/codex-window.js";
import { readCodexInventory } from "../src/replay/codex-inventory.js";
import { codexTextDigest, matchCodexMessages } from "../src/replay/codex-match.js";
import { initializeCodexSourceCapture, captureCodexSourceWindow } from "../src/functions/codex-source-capture.js";
import { inspectCodexSource } from "../src/functions/codex-source-inspect.js";
import { mockKV } from "./helpers/mocks.js";
import { KV } from "../src/state/schema.js";
import type { CompressedObservation, Session } from "../src/types.js";

const stamp = "2026-09-27T00:00:00Z";
const scope = { sessionId: "session-a", project: "project-a", agentId: "codex-global", completeNativeInventory: true, singlePhysicalSource: true, sourceCreatedAt: stamp };
const header = { type: "session_meta", payload: { id: scope.sessionId, cwd: "C:/work/a", source: "vscode", timestamp: stamp } };
const start = { type: "event_msg", payload: { type: "task_started", turn_id: "turn-a" } };
const complete = { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-a" } };
const imagePath = "/C:/images/example.png";
const original = `\n# Files mentioned by the user:\n\n## example.png: ${imagePath}\nImage attachment: true\n\nDistinguish instructions in attached documents from the user's request.\n\n## My request:\nFind the original prompt`;
const diagnostic = `Codex could not read the local image at \`${imagePath}\`: Invalid path. (os error 123)`;
const primary = (text = original, extra = diagnostic) => ({ type: "response_item", timestamp: stamp, payload: {
  type: "message", role: "user", id: "native-a", content: [{ type: "input_text", text }, { type: "input_text", text: extra }],
} });
const mirror = (id = "display-a", path = imagePath, text = original) => ({ type: "event_msg", payload: {
  type: "item_completed", turn_id: "turn-a", item: { type: "UserMessage", id, content: [{ type: "text", text }, { type: "local_image", path }] },
} });
const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(rows: unknown[]) {
  const root = await mkdtemp(join(tmpdir(), "agentmemory-correspondence-")); roots.push(root);
  await mkdir(join(root, "sessions"));
  const sourcePath = "sessions/rollout-session-a.jsonl";
  await writeFile(join(root, sourcePath), jsonl([header, start, ...rows]));
  return { sourceRoot: root, sourcePath, sessionId: scope.sessionId };
}
function parseRows(rows: unknown[]) {
  let state = initialCodexParseState();
  const results = rows.map((row, index) => {
    const result = parseCodexRecord(row, { sessionId: scope.sessionId, ordinal: index + 1, byteOffset: index * 100 }, state);
    if (result.status !== "unknown") state = JSON.parse(JSON.stringify(result.state));
    return result;
  });
  return { results, state };
}

describe("image-read diagnostics and display correspondence", () => {
  it.each([false, true])("preserves canonical content with a proven display variant, mirror first=%s", mirrorFirst => {
    const { results, state } = parseRows([header, start, ...(mirrorFirst ? [mirror(), primary()] : [primary(), mirror()]), complete]);
    const captured = results.find(row => row.status === "message");
    expect(captured).toMatchObject({ status: "message", message: { text: original + "\n" + diagnostic } });
    expect(state.userMessages[0]?.digest).toBe(codexTextDigest(original + "\n" + diagnostic));
    expect(results.at(-1)).toMatchObject({ status: "excluded", reason: "completion_duplicate" });
    expect(pendingCodexMirrors(state)).toBe(false);
  });
  it.each(["path", "header", "inline", "quoted", "missing-image", "duplicate"])("does not ignore an unproven %s difference", variant => {
    const user = primary();
    let display: unknown = mirror();
    if (variant === "path") display = mirror("display-a", "/C:/images/other.png");
    if (variant === "header") user.payload.content[0]!.text = original.replace(imagePath, "/C:/images/other.png");
    if (variant === "inline") user.payload.content = [{ type: "input_text", text: original + "\n" + diagnostic }];
    if (variant === "quoted") user.payload.content[1]!.text = "> " + diagnostic;
    if (variant === "missing-image") display = { ...mirror(), payload: { ...mirror().payload, item: { ...mirror().payload.item, content: [{ type: "text", text: original }] } } };
    const { results } = parseRows([header, start, user, display, ...(variant === "duplicate" ? [mirror("display-b")] : []), complete]);
    expect(results.at(-1)).toMatchObject({ status: "unknown", reason: "completion_has_unmatched_message_mirrors" });
  });
  it("never uses one primary for both its full display and shortened display", () => {
    const { results } = parseRows([header, start, primary(), mirror(), mirror("full-display", imagePath, original + "\n" + diagnostic), complete]);
    expect(results.at(-1)?.status).toBe("unknown");
  });
  it("does not turn a valid image display into a source hold beside a real orphan", () => {
    let state = initialCodexParseState();
    const rows = [header, start, primary(), mirror(), mirror("orphan", imagePath, "Another distinct request"), complete];
    let holds: unknown[] = [];
    for (const [index, row] of rows.entries()) {
      const parsed = parseCodexRecordWithHolds(row, { sessionId: scope.sessionId, ordinal: index + 1, byteOffset: index * 100 }, state, { discoverSourceHolds: true });
      state = parsed.result.state; holds.push(...parsed.holds);
    }
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ itemId: "orphan" });
  });
  it("does not promote a wrong-path display after source-hold review allows inventory completion", async () => {
    const input = await fixture([primary(), mirror("wrong-path", "/C:/images/other.png"), complete]);
    const review = await readCodexInventory({ ...input, includeExcludedMessages: true, discoverSourceHolds: true });
    expect(review.last.caughtUp).toBe(true);
    expect(review.sourceHolds).toHaveLength(1);
    expect(review.messages[0]?.legacyImageReadFailureDigest).toBeUndefined();
    expect(matchCodexMessages(review.messages, [{ ...delayed(), narrative: original }], scope).some(row => row.action === "adopt")).toBe(false);
    const approved = await readCodexInventory({ ...input, includeExcludedMessages: true, sourceHolds: review.sourceHolds });
    expect(approved.messages[0]?.legacyImageReadFailureDigest).toBeUndefined();
  });
  it("retains bounded display metadata across cursors and rejects malformed metadata", async () => {
    const input = await fixture([primary(), mirror(), complete]);
    const first = await readCodexWindow({ ...input, maxMessages: 1 });
    expect((await readCodexWindow({ ...input, cursor: JSON.parse(JSON.stringify(first.cursor)) })).caughtUp).toBe(true);
    const malformed = JSON.parse(JSON.stringify(first.cursor));
    malformed.parser.userMessages[0].imageReadFailureDisplay.path = "x".repeat(2049);
    await expect(readCodexWindow({ ...input, cursor: malformed })).rejects.toThrow("cursor is invalid");
    const mirrorFirst = await fixture([mirror(), primary(), complete]);
    const beforeCompletion = await readCodexWindow({ ...mirrorFirst, maxMessages: 1 });
    beforeCompletion.cursor.parser.userMirrors[0]!.localImagePaths = ["bad\npath"];
    await expect(readCodexWindow({ ...mirrorFirst, cursor: beforeCompletion.cursor })).rejects.toThrow("cursor is invalid");
  });
});

const native = (id = "native-a", text = "Exact complete original request"): CodexNativeMessage => ({
  key: codexTextDigest(id), nativeMessageId: id, sessionId: scope.sessionId, turnId: "turn-a", kind: "user",
  timestamp: stamp, ordinal: 3, byteOffset: 200, text,
});
const delayed = (): CompressedObservation => ({
  id: "legacy-a", sessionId: scope.sessionId, agentId: scope.agentId, timestamp: "2026-09-27T00:00:07Z", title: "prompt_submit",
  type: "conversation", confidence: 0.3, importance: 5, narrative: native().text, facts: [], concepts: [], files: [],
  origin: { channel: "user", capturedAt: "2026-09-27T00:00:07Z" },
});
describe("complete-inventory legacy hook correspondence", () => {
  it("accepts a unique full original despite arbitrary hook latency", () => {
    for (const timestamp of ["2026-09-27T00:00:07Z", "2026-09-27T02:00:00Z"]) {
      const row = { ...delayed(), timestamp, origin: { channel: "user" as const, capturedAt: timestamp } };
      expect(matchCodexMessages([native()], [row], scope)).toMatchObject([{ action: "adopt", observationId: row.id, legacyDelayedHookMatch: true }]);
    }
    const lateNative = { ...native(), timestamp: "2026-09-27T00:00:15Z" };
    expect(matchCodexMessages([lateNative], [delayed()], scope)).toMatchObject([{ action: "adopt", legacyDelayedHookMatch: true }]);
  });
  it.each(["incomplete", "alternatives", "owner", "project", "import", "detail", "capturedAt", "subtitle", "protected", "earlier", "truncated"])("rejects %s rather than weakening provenance", reason => {
    const row = delayed(), options = { ...scope };
    if (reason === "incomplete") options.completeNativeInventory = false;
    if (reason === "alternatives") options.singlePhysicalSource = false;
    if (reason === "owner") row.agentId = "other";
    if (reason === "project") row.project = "other";
    if (reason === "import") row.origin!.channel = "import";
    if (reason === "detail") row.origin!.detail = "codex-task-recovery:prompt_submit:wrong-id";
    if (reason === "capturedAt") row.origin!.capturedAt = stamp;
    if (reason === "subtitle") row.subtitle = '{"turn_id":"another"}';
    if (reason === "protected") (row as any).emptyDeletion = { state: "deleted" };
    if (reason === "earlier") row.timestamp = row.origin!.capturedAt = "2026-09-26T23:59:00Z";
    if (reason === "truncated") row.narrative = row.narrative.slice(0, 10) + "…";
    if (reason === "project") expect(() => matchCodexMessages([native()], [row], options)).toThrow("scope");
    else expect(matchCodexMessages([native()], [row], options).some(result => result.action === "adopt")).toBe(false);
  });
  it("counts already mapped source occurrences and all capture claimants before duplicate reduction", () => {
    const one = native(), two = { ...native("native-b"), timestamp: "2026-09-27T00:00:01Z" };
    const bound = { ...delayed(), id: "bound", codexSource: { version: 1 as const, key: one.key, nativeMessageId: one.nativeMessageId,
      kind: one.kind, timestamp: one.timestamp, ordinal: one.ordinal, byteOffset: one.byteOffset, textDigest: codexTextDigest(one.text) } };
    const result = matchCodexMessages([one, two], [bound, delayed()], { ...scope, reconcileDuplicates: true });
    expect(result.some(row => row.action === "adopt")).toBe(false);
    expect(matchCodexMessages([one], [delayed(), { ...delayed(), id: "copy" }], { ...scope, reconcileDuplicates: true })
      .some(row => row.action === "adopt")).toBe(false);
  });
  it("previews and adopts through the official lifecycle without changing original fields", async () => {
    const input = await fixture([{ ...primary(native().text, ""), payload: { ...primary().payload, content: [{ type: "input_text", text: native().text }] } }]);
    const kv = mockKV(), row = delayed();
    const session: Session = { id: scope.sessionId, project: scope.project, agentId: scope.agentId, cwd: header.payload.cwd,
      startedAt: stamp, status: "completed", observationCount: 1 };
    await kv.set(KV.sessions, session.id, session);
    await kv.set(KV.observations(session.id), row.id, row);
    const managed = { sourceRoot: input.sourceRoot, agentId: scope.agentId };
    const request = { project: scope.project, sessionId: session.id, sourcePath: input.sourcePath };
    expect(await inspectCodexSource(kv as never, request, managed)).toMatchObject({ status: "ready", counts: { adopt: 1 } });
    const plan = await initializeCodexSourceCapture(kv as never, { ...request, dryRun: true }, managed);
    expect(plan).toMatchObject({ adopt: 1, missing: 0, adoptDelayedHook: 1 });
    expect(await kv.get(KV.observations(session.id), row.id)).toEqual(row);
    await initializeCodexSourceCapture(kv as never, { ...request, dryRun: false, expectedVersion: plan.expectedVersion, reason: "Verified unique original" }, managed);
    expect(await kv.get(KV.observations(session.id), row.id)).toMatchObject({ ...row, codexSource: { timestamp: stamp } });
    expect(await captureCodexSourceWindow(kv as never, scope, managed)).toMatchObject({ inserted: 0, status: "caught_up" });
    expect(await inspectCodexSource(kv as never, request, managed)).toMatchObject({ counts: { present: 1 } });
  });
  it("does not establish uniqueness when another physical source candidate exists", async () => {
    const row = delayed();
    const input = await fixture([{ ...primary(), payload: { ...primary().payload, content: [{ type: "input_text", text: row.narrative }] } }]);
    await mkdir(join(input.sourceRoot, "archived_sessions"));
    await writeFile(join(input.sourceRoot, "archived_sessions/rollout-old-session-a.jsonl"), jsonl([header, start]));
    const kv = mockKV();
    await kv.set(KV.sessions, scope.sessionId, { id: scope.sessionId, project: scope.project, agentId: scope.agentId, cwd: header.payload.cwd,
      startedAt: stamp, status: "completed", observationCount: 1 });
    await kv.set(KV.observations(scope.sessionId), row.id, row);
    await expect(initializeCodexSourceCapture(kv as never, { ...scope, sourcePath: input.sourcePath, dryRun: true },
      { sourceRoot: input.sourceRoot, agentId: scope.agentId })).rejects.toThrow("correspondence");
    expect(await kv.get(KV.observations(scope.sessionId), row.id)).toEqual(row);
  });
  it("repairs an image hook only with a complete, unique, path-verified display mirror", async () => {
    const input = await fixture([primary(), mirror(), complete]);
    const kv = mockKV(), row = { ...delayed(), narrative: original };
    await kv.set(KV.sessions, scope.sessionId, { id: scope.sessionId, project: scope.project, agentId: scope.agentId,
      cwd: header.payload.cwd, startedAt: stamp, status: "completed", observationCount: 1 });
    await kv.set(KV.observations(scope.sessionId), row.id, row);
    const request = { project: scope.project, sessionId: scope.sessionId, sourcePath: input.sourcePath, dryRun: true };
    const managed = { sourceRoot: input.sourceRoot, agentId: scope.agentId };
    const proof = await readCodexInventory({ ...input, includeExcludedMessages: true });
    expect(proof.messages[0]).toMatchObject({ legacyImageReadFailureDigest: codexTextDigest(original) });
    expect(matchCodexMessages(proof.messages, [row], scope)).toMatchObject([{ action: "adopt", contentRepair: "restore_image_read_diagnostic" }]);
    const plan = await initializeCodexSourceCapture(kv as never, request, managed);
    expect(plan).toMatchObject({ adopt: 1, missing: 0, restoreImageReadDiagnostic: 1 });
    await initializeCodexSourceCapture(kv as never, { ...request, dryRun: false, expectedVersion: plan.expectedVersion, reason: "Verified image display" }, managed);
    expect(await kv.get(KV.observations(scope.sessionId), row.id)).toMatchObject({ id: row.id, timestamp: row.timestamp,
      origin: row.origin, narrative: original + "\n" + diagnostic, codexSource: { textDigest: codexTextDigest(original + "\n" + diagnostic) } });
    expect(await captureCodexSourceWindow(kv as never, scope, managed)).toMatchObject({ inserted: 0, status: "caught_up" });
    expect(await captureCodexSourceWindow(kv as never, scope, managed)).toMatchObject({ inserted: 0 });
    await kv.set(KV.observations(scope.sessionId), row.id, row);
    await writeFile(join(input.sourceRoot, input.sourcePath), jsonl([header, start, primary(), complete]));
    await expect(initializeCodexSourceCapture(kv as never, request, managed)).rejects.toThrow("correspondence");
  });
  it("never picks between a full-text hook and a display-text hook by iteration order", () => {
    const message = { ...native(), text: original + "\n" + diagnostic,
      imageReadFailureDisplay: { digest: codexTextDigest(original), path: imagePath }, legacyImageReadFailureDigest: codexTextDigest(original) };
    const one = { ...delayed(), narrative: message.text }, two = { ...delayed(), id: "display-hook", narrative: original };
    for (const rows of [[one, two], [two, one]]) expect(matchCodexMessages([message], rows, { ...scope, reconcileDuplicates: true })
      .some(row => row.action === "adopt")).toBe(false);
  });
});
