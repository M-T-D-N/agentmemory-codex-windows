import { afterEach, describe, expect, it } from "vitest";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCodexWindow } from "../src/replay/codex-window.js";
import { codexSessionForTransfer } from "../src/replay/codex-capture-state.js";
import { validateCodexContinuation } from "../src/functions/codex-source-identity.js";

const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
const header = { type: "session_meta", payload: { id: "session-a", session_id: "session-a",
  cwd: "C:/work/a", source: "vscode", timestamp: "2026-09-13T00:00:00Z" } };
const user = (id: string) => ({ type: "response_item", timestamp: "2026-09-13T00:00:01Z",
  payload: { type: "message", role: "user", id, content: [{ type: "input_text", text: id }] } });
const lines = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
async function fixture(boundaryChange = {}) {
  const sourceRoot = await mkdtemp(join(tmpdir(), "agentmemory-native-segments-")); roots.push(sourceRoot);
  await mkdir(join(sourceRoot, "sessions"));
  const basePath = join(sourceRoot, "sessions/rollout-session-a-original.jsonl");
  const prefix = lines([header, { type: "event_msg", payload: { type: "task_started", turn_id: "turn-a" } }, user("old")]);
  const original = prefix + lines([user("excluded-old-tail")]);
  const currentHeader = { ...header, payload: { ...header.payload, timestamp: "2026-09-13T02:00:00Z", history_mode: "paginated",
    history_base: { thread_id: "session-a", end_ordinal_exclusive: 3, end_byte_offset: Buffer.byteLength(prefix), ...boundaryChange } } };
  const current = lines([currentHeader, user("new")]);
  const sourcePath = "sessions/rollout-session-a-current.jsonl";
  const currentPath = join(sourceRoot, sourcePath);
  await writeFile(basePath, original); await writeFile(currentPath, current);
  return { input: { sourceRoot, sourcePath, sessionId: "session-a" }, basePath, currentPath, original, current, prefix };
}

describe("same-task native continuation segments", () => {
  it("joins only the declared old prefix and new body, resumes across the boundary and preserves the originals", async () => {
    const sample = await fixture();
    const old = await readCodexWindow({ ...sample.input, sourcePath: "sessions/rollout-session-a-original.jsonl", maxMessages: 1 });
    const first = await readCodexWindow({ ...sample.input, maxMessages: 1 });
    expect(first.messages.map(row => row.nativeMessageId)).toEqual(["old"]);
    expect(first.messages[0]!.key).toBe(old.messages[0]!.key);
    expect(first.cursor.byteOffset).toBe(Buffer.byteLength(sample.prefix));
    const second = await readCodexWindow({ ...sample.input, cursor: first.cursor });
    expect(second.messages.map(row => row.nativeMessageId)).toEqual(["new"]);
    expect(second.caughtUp).toBe(true);
    expect(second.source.createdAt).toBe(header.payload.timestamp);
    expect(second.cursor.byteOffset).toBe(second.snapshotBytes);
    expect(second.source.continuation?.sourcePath).toBe("sessions/rollout-session-a-original.jsonl");
    await appendFile(sample.currentPath, lines([user("appended")]));
    expect((await readCodexWindow({ ...sample.input, cursor: second.cursor })).messages.map(row => row.nativeMessageId)).toEqual(["appended"]);
    expect(await readFile(sample.basePath, "utf8")).toBe(sample.original);
    expect((await readFile(sample.currentPath, "utf8")).startsWith(sample.current)).toBe(true);
    const all = await readCodexWindow(sample.input);
    expect(all.messages.map(row => row.nativeMessageId)).toEqual(["old", "new", "appended"]);
  });
  it.each(["missing", "ambiguous"] as const)("holds a %s prior source without claiming completion", async mode => {
    const sample = await fixture();
    if (mode === "missing") await rm(sample.basePath);
    else await copyFile(sample.basePath, join(sample.input.sourceRoot, "sessions/rollout-session-a-copy.jsonl"));
    await expect(readCodexWindow(sample.input)).rejects.toThrow("one proven prior segment");
  });
  it.each([{ end_ordinal_exclusive: 4 }, { end_byte_offset: 1 }])("rejects an incorrect record/byte boundary %j", async change => {
    const sample = await fixture(change);
    await expect(readCodexWindow(sample.input)).rejects.toThrow("one proven prior segment");
  });
  it("invalidates a cursor when its proven prior source changes", async () => {
    const sample = await fixture();
    const first = await readCodexWindow({ ...sample.input, maxMessages: 1 });
    await appendFile(sample.basePath, lines([user("changed-base")]));
    await expect(readCodexWindow({ ...sample.input, cursor: first.cursor })).rejects.toThrow("reconciliation");
  });
  it("does not silently flatten a nested external history reference", async () => {
    const sample = await fixture();
    const nested = { ...header, payload: { ...header.payload, history_mode: "paginated",
      history_base: { thread_id: "session-a", end_ordinal_exclusive: 1, end_byte_offset: 100 } } };
    await writeFile(join(sample.input.sourceRoot, "sessions/rollout-session-a-intermediate.jsonl"), lines([nested, user("old")]));
    await expect(readCodexWindow(sample.input)).rejects.toThrow("Nested or forked prior segments");
  });
  it("preserves proven continuation metadata in transfer while requiring cursor reconciliation", async () => {
    const sample = await fixture();
    const result = await readCodexWindow(sample.input);
    const session = { id: "session-a", project: "p", cwd: result.source.cwd, startedAt: result.source.createdAt,
      status: "active" as const, observationCount: 2, codexNativeCapture: { version: 1 as const, source: result.source,
        initializedAt: result.source.createdAt, status: "pending" as const, cursor: result.cursor } };
    const transfer = codexSessionForTransfer(session).codexNativeCapture!;
    expect(transfer.source).toEqual(result.source);
    expect(transfer.cursor).toBeUndefined();
    expect(transfer.status).toBe("reconcile_required");
    for (const sourcePath of ["sessions/../rollout-a.jsonl", "C:/rollout-a.jsonl", "sessions/config.toml", "sessions/rollout-a.jsonl\0"]) {
      expect(() => validateCodexContinuation({ ...result.source.continuation, sourcePath })).toThrow();
    }
    expect(() => validateCodexContinuation({ ...result.source.continuation, endByteOffset: 0 })).toThrow();
  });
});
