import { afterEach, describe, expect, it } from "vitest";
import { appendFile, mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCodexWindow } from "../src/replay/codex-window.js";
import { readCodexInventory } from "../src/replay/codex-inventory.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const header = { type: "session_meta", payload: { id: "session-a", cwd: "C:/work/a", source: "vscode", timestamp: "2026-09-13T00:00:00Z" } };
const start = { type: "event_msg", payload: { type: "task_started", turn_id: "turn-a" } };
const user = (id: string, text = "진행") => ({ type: "response_item", timestamp: "2026-09-13T00:00:01Z",
  payload: { type: "message", role: "user", id, content: [{ type: "input_text", text }] } });
const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
async function fixture(content = jsonl([header, start, user("u1"), user("u2")])) {
  const sourceRoot = await mkdtemp(join(tmpdir(), "agentmemory-native-window-")); roots.push(sourceRoot);
  await mkdir(join(sourceRoot, "sessions"));
  const sourcePath = "sessions/rollout-session-a.jsonl";
  const path = join(sourceRoot, sourcePath);
  await writeFile(path, content);
  return { path, input: { sourceRoot, sourcePath, sessionId: "session-a" } };
}

describe("bounded restartable native Codex reads", () => {
  it("retains verified turn cwd across read windows and rejects an invalid cursor cwd", async () => {
    const context = (turnId: string, cwd: string) => ({ type: "turn_context", payload: { turn_id: turnId, cwd } });
    const { input } = await fixture(jsonl([header, start, context("turn-a", "C:/work/a"), user("one"),
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-b" } }, context("turn-b", "C:/work/b"), user("two")]));
    const first = await readCodexWindow({ ...input, maxMessages: 1 });
    expect(first.cursor.parser.cwd).toBe("c:\\work\\a");
    const last = await readCodexWindow({ ...input, cursor: first.cursor });
    expect(last.caughtUp).toBe(true);
    expect(last.source.cwd).toBe("C:/work/a");
    expect(last.cursor.parser.cwd).toBe("c:\\work\\b");
    await expect(readCodexWindow({ ...input, cursor: { ...first.cursor, parser: { ...first.cursor.parser, cwd: "relative" } } }))
      .rejects.toThrow();
  });
  const userItem = (id: string, text = "진행", turnId = "turn-a") => ({ type: "event_msg", payload: {
    type: "item_completed", turn_id: turnId, item: { type: "UserMessage", id, content: [{ type: "Text", text }] },
  } });
  it.each([true, false])("proves imported user item identity across bounded windows, mirror first=%s", async mirrorFirst => {
    const primary = user("primary", "exact original request");
    const mirror = userItem("display-item", "exact original request");
    const { input } = await fixture(jsonl([header, start, ...(mirrorFirst ? [mirror, primary] : [primary, mirror])]));
    const readOne: typeof readCodexWindow = options => readCodexWindow({ ...options, maxMessages: 1 });
    const result = await readCodexInventory({ ...input, includeExcludedMessages: true }, readOne);
    expect(result.last.caughtUp).toBe(true);
    expect(result.messages).toMatchObject([{ nativeMessageId: "primary", legacyUserItemId: "display-item" }]);
    expect((await readCodexInventory(input)).messages[0]).not.toHaveProperty("legacyUserItemId");
    expect((await readCodexWindow(input))).not.toHaveProperty("legacyUserItems");
  });
  it("does not prove an imported item from incomplete or competing primary history", async () => {
    for (const rows of [[userItem("display-only")], [user("one"), userItem("display"), user("two")]]) {
      const { input } = await fixture(jsonl([header, start, ...rows]));
      const result = await readCodexInventory({ ...input, includeExcludedMessages: true });
      expect(result.messages.every(message => message.legacyUserItemId === undefined)).toBe(true);
    }
    const { input } = await fixture(jsonl([header, start, user("one"), userItem("display")]));
    const result = await readCodexInventory({ ...input, includeExcludedMessages: true },
      options => readCodexWindow({ ...options, maxMessages: 1 }), { maxWindows: 1 });
    expect(result.last.caughtUp).toBe(false);
    expect(result.messages[0]).not.toHaveProperty("legacyUserItemId");
  });
  it("keeps repeated text in different turns attached to each turn's own display item", async () => {
    const { input } = await fixture(jsonl([header, start, user("one"), userItem("display-one"),
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-b" } }, user("two"), userItem("display-two", "진행", "turn-b")]));
    const result = await readCodexInventory({ ...input, includeExcludedMessages: true });
    expect(result.last.caughtUp).toBe(true);
    expect(result.messages.map(message => message.legacyUserItemId)).toEqual(["display-one", "display-two"]);
  });
  it("does not reuse a display item claimed by different turns", async () => {
    const { input } = await fixture(jsonl([header, start, user("one"), userItem("reused-item"),
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-b" } },
      user("two", "other request"), userItem("reused-item", "other request", "turn-b")]));
    const result = await readCodexInventory({ ...input, includeExcludedMessages: true });
    expect(result.last.caughtUp).toBe(true);
    expect(result.messages.every(message => message.legacyUserItemId === undefined)).toBe(true);
  });
  const forkHeader = { ...header, payload: { ...header.payload, session_id: "session-a", history_mode: "paginated",
    forked_from_id: "parent-a", forked_from_ordinal_exclusive: 12,
    history_base: { thread_id: "parent-a", end_ordinal_exclusive: 12, end_byte_offset: 1200 } } };
  const forkStart = { ...start, timestamp: "2026-09-13T00:00:00Z" };
  it("keeps a fork's new final without replaying inherited user input, but excludes internal title turns", async () => {
    const final = { type: "response_item", timestamp: "2026-09-13T00:00:01Z", payload: {
      type: "message", role: "assistant", phase: "final_answer", id: "own-final", content: [{ type: "output_text", text: "Verified the inherited task" }],
    } };
    const normal = await fixture(jsonl([forkHeader, forkStart, user("context", "# AGENTS.md instructions for C:/work/a"), final]));
    expect((await readCodexWindow(normal.input)).messages.map(row => row.nativeMessageId)).toEqual(["own-final"]);
    const internal = await fixture(jsonl([forkHeader, forkStart,
      user("title-instruction", "You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task that will be created from that prompt."), final]));
    expect((await readCodexWindow(internal.input)).messages).toEqual([]);
    const standalone = await fixture(jsonl([header, start, final]));
    expect((await readCodexWindow(standalone.input)).messages).toEqual([]);
  });
  it("reads only a paginated fork's own source and resumes with the parent boundary bound to the cursor", async () => {
    const { path, input } = await fixture(jsonl([forkHeader, forkStart, user("own-1", "x".repeat(500)), user("own-2")]));
    const first = await readCodexWindow({ ...input, maxMessages: 1 });
    expect(first.messages.map(row => row.nativeMessageId)).toEqual(["own-1"]);
    expect(first.source.fork).toMatchObject({ parentSessionId: "parent-a", endByteOffset: 1200 });
    const second = await readCodexWindow({ ...input, cursor: first.cursor });
    expect(second.messages.map(row => row.nativeMessageId)).toEqual(["own-2"]);
    expect(second.caughtUp).toBe(true);
    await writeFile(path, jsonl([{ ...forkHeader, payload: { ...forkHeader.payload,
      history_base: { ...forkHeader.payload.history_base, end_byte_offset: 1201 } } }, forkStart, user("own-1", "x".repeat(500)), user("own-2")]));
    await expect(readCodexWindow({ ...input, cursor: first.cursor })).rejects.toThrow("reconciliation");
  });
  it.each([undefined, "2026-09-12T23:59:59Z"])("does not capture a fork record with unproven own-history time %s", async timestamp => {
    const prefix = jsonl([forkHeader, forkStart]);
    const { input } = await fixture(prefix + jsonl([{ ...user("unproven"), timestamp }]));
    const result = await readCodexWindow(input);
    expect(result).toMatchObject({ caughtUp: false, messages: [], issue: { reason: "fork_record_precedes_or_lacks_own_history_timestamp" } });
    expect(result.cursor.byteOffset).toBe(Buffer.byteLength(prefix));
  });
  it("resumes by canonical cursor with distinct identical messages and bounded output", async () => {
    const { input } = await fixture();
    const first = await readCodexWindow({ ...input, maxMessages: 1 });
    expect(first.messages.map(row => row.nativeMessageId)).toEqual(["u1"]);
    expect(first.caughtUp).toBe(false);
    const second = await readCodexWindow({ ...input, cursor: JSON.parse(JSON.stringify(first.cursor)), maxMessages: 1 });
    expect(second.messages.map(row => row.nativeMessageId)).toEqual(["u2"]);
    expect(second.caughtUp).toBe(true);
    expect(second.cursor.byteOffset).toBe(second.snapshotBytes);
    const retryBeforeCommit = await readCodexWindow({ ...input, maxMessages: 1 });
    expect(retryBeforeCommit.messages[0]!.key).toBe(first.messages[0]!.key);
    const done = await readCodexWindow({ ...input, cursor: second.cursor });
    expect(done.messages).toEqual([]); expect(done.caughtUp).toBe(true);
  });
  it("leaves a partial UTF-8 final line uncommitted and reads it after append", async () => {
    const prefix = jsonl([header, start]);
    const line = Buffer.from(JSON.stringify(user("u1", "가나다")) + "\n");
    const split = line.indexOf(Buffer.from("가")) + 1;
    const { path, input } = await fixture(prefix);
    await appendFile(path, line.subarray(0, split));
    const partial = await readCodexWindow(input);
    expect(partial).toMatchObject({ messages: [], incompleteTail: true, caughtUp: false, issue: null });
    expect(partial.cursor.byteOffset).toBe(Buffer.byteLength(prefix));
    await appendFile(path, line.subarray(split));
    const complete = await readCodexWindow({ ...input, cursor: partial.cursor });
    expect(complete.messages[0]!.text).toBe("가나다"); expect(complete.caughtUp).toBe(true);
  });
  it("does not report a display-only final as caught up before its primary message is stored in the source", async () => {
    const display = { type: "event_msg", payload: { type: "item_completed", turn_id: "turn-a", item: {
      type: "AgentMessage", id: "final-a", phase: "final_answer", content: [{ type: "Text", text: "Fixed" }],
    } } };
    const { path, input } = await fixture(jsonl([header, start, user("u1"), display]));
    const pending = await readCodexWindow(input);
    expect(pending).toMatchObject({ caughtUp: false, waitingForPrimary: true, issue: null });
    await appendFile(path, jsonl([{ type: "response_item", timestamp: "2026-09-13T00:00:02Z", payload: {
      type: "message", role: "assistant", id: "final-a", phase: "final_answer", content: [{ type: "output_text", text: "Fixed" }],
    } }, { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-a", last_agent_message: "Fixed" } }]));
    const completed = await readCodexWindow({ ...input, cursor: pending.cursor });
    expect(completed).toMatchObject({ caughtUp: true, waitingForPrimary: false, issue: null });
    expect(completed.messages.map(row => row.nativeMessageId)).toEqual(["final-a"]);
  });
  it("stops at an unknown or malformed record without advancing past it", async () => {
    const prefix = jsonl([header, start, user("u1")]);
    const { input } = await fixture(prefix + '{"type":"new_native_format","payload":{}}\n' + jsonl([user("u2")]));
    const result = await readCodexWindow(input);
    expect(result.messages).toHaveLength(1);
    expect(result.issue).toMatchObject({ reason: "unsupported_record_type", byteOffset: Buffer.byteLength(prefix) });
    expect(result.cursor.byteOffset).toBe(Buffer.byteLength(prefix)); expect(result.caughtUp).toBe(false);
    expect((await readCodexWindow({ ...input, cursor: result.cursor })).messages).toEqual([]);
  });
  it("rejects truncation, file replacement and rewritten cursor boundaries", async () => {
    for (const mode of ["truncate", "replace", "rewrite"]) {
      const { path, input } = await fixture();
      const prior = await readCodexWindow({ ...input, maxMessages: 1 });
      if (mode === "truncate") await writeFile(path, jsonl([header]));
      if (mode === "replace") { await rename(path, path + ".old"); await writeFile(path, jsonl([header, start, user("u1"), user("u2")])); }
      if (mode === "rewrite") await writeFile(path, jsonl([header, start, user("u9"), user("u2")]));
      await expect(readCodexWindow({ ...input, cursor: prior.cursor })).rejects.toThrow("reconciliation is required");
    }
  });
  it("makes progress for a record larger than the byte budget without cutting the event", async () => {
    const { input } = await fixture(jsonl([header, start, user("u1", "a".repeat(200_000))]));
    let result = await readCodexWindow({ ...input, maxBytes: 1000 });
    if (!result.caughtUp) result = await readCodexWindow({ ...input, cursor: result.cursor, maxBytes: 1000 });
    expect(result.messages[0]!.text.length).toBe(200_000); expect(result.caughtUp).toBe(true);
  });
  it("preserves UTF-8 text and exact resume offsets across multiple read chunks", async () => {
    const text = "가나다🙂".repeat(20_000);
    const prefix = jsonl([header, start, user("large", text)]);
    const { input } = await fixture(prefix + jsonl([user("following", "다음 입력")]));
    const first = await readCodexWindow({ ...input, maxMessages: 1 });
    expect(first.messages.map(row => row.text)).toEqual([text]);
    expect(first.cursor.byteOffset).toBe(Buffer.byteLength(prefix));
    expect(first.cursor.ordinal).toBe(3);
    const resumed = await readCodexWindow({ ...input, cursor: JSON.parse(JSON.stringify(first.cursor)) });
    expect(resumed.messages.map(row => row.nativeMessageId)).toEqual(["following"]);
    expect(resumed.cursor.byteOffset).toBe(resumed.snapshotBytes);
    expect(resumed.caughtUp).toBe(true);
  });
  it("reads a 36 MiB compaction record without replaying its replacement history", async () => {
    const compacted = { type: "compacted", payload: { message: "", replacement_history: [
      user("inherited", "x".repeat(36 * 1024 * 1024)),
    ] } };
    const prefix = jsonl([header, start, compacted]);
    const { input } = await fixture(prefix + jsonl([user("following")]));
    const first = await readCodexWindow(input);
    expect(first.issue).toBeNull();
    expect(first.messages).toEqual([]);
    expect(first.cursor.byteOffset).toBe(Buffer.byteLength(prefix));
    expect(first.caughtUp).toBe(false);
    const resumed = await readCodexWindow({ ...input, cursor: first.cursor });
    expect(resumed.messages.map(row => row.nativeMessageId)).toEqual(["following"]);
    expect(resumed.caughtUp).toBe(true);
  });
  it("keeps a record exceeding 64 MiB uncommitted and does not skip its following message", async () => {
    const prefix = jsonl([header, start]);
    const { path, input } = await fixture(prefix);
    await appendFile(path, '{"type":"compacted","payload":{"message":"');
    const chunk = "x".repeat(1024 * 1024);
    for (let i = 0; i < 64; i++) await appendFile(path, chunk);
    await appendFile(path, '"}}\n' + jsonl([user("following")]));
    const result = await readCodexWindow(input);
    expect(result).toMatchObject({ messages: [], caughtUp: false,
      issue: { reason: "record_exceeds_supported_size", byteOffset: Buffer.byteLength(prefix), ordinal: 3 } });
    expect(result.cursor.byteOffset).toBe(Buffer.byteLength(prefix));
  });
});
