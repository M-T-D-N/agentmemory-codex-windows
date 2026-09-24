import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { initialCodexParseState, parseCodexRecord, type CodexParseState } from "../src/replay/codex-record.js";

const at = "2026-09-13T00:00:00Z";
const record = (role: string, id: string | null, text: string, phase?: string) => ({
  type: "response_item", timestamp: at, payload: { type: "message", role, id, phase,
    content: [{ type: role === "user" ? "input_text" : "output_text", text }] },
});
const turn = { type: "event_msg", payload: { type: "task_started", turn_id: "turn-a" } };
function harness() {
  let state: CodexParseState = initialCodexParseState();
  let ordinal = 1;
  return (value: unknown, position?: number) => {
    const result = parseCodexRecord(value, { sessionId: "session-a", ordinal: position ?? ordinal++, byteOffset: (position ?? ordinal) * 100 }, state);
    if (result.status !== "unknown") state = JSON.parse(JSON.stringify(result.state));
    return result;
  };
}

describe("canonical native Codex conversation records", () => {
  it("continues through configuration updates without importing settings or losing message identity", () => {
    const parse = harness(); parse(turn);
    const user = parse(record("user", "user-1", "Preserve my requirement"));
    const update = parse({ type: "response_item", timestamp: at,
      payload: { type: "configuration_update", reasoning: { effort: "xhigh" } } });
    expect(update).toMatchObject({ status: "excluded", reason: "non_conversation_response", state: user.state });
    expect(parse(record("assistant", "final-1", "Done", "final_answer")))
      .toMatchObject({ status: "message", message: { kind: "assistant_final" } });
    expect(parse({ type: "response_item", payload: { type: "future_unknown_update" } }).status).toBe("unknown");
    const internal = harness(); internal(turn);
    internal({ type: "response_item", payload: { type: "configuration_update", reasoning: { effort: "high" } } });
    expect(internal(record("assistant", "internal", "Settings are not a user request", "final_answer")).status).toBe("excluded");
  });
  it("captures a created task's final without promoting its delegation tool output", () => {
    const parse = harness();
    parse({ type: "session_meta", payload: { id: "session-a", source: "vscode", thread_source: "agent_created_thread" } });
    parse(turn);
    expect(parse({ type: "response_item", payload: { type: "function_call_output", name: "create_thread",
      namespace: "codex_app", output: "<codex_delegation><input>Do the work</input></codex_delegation>" } }))
      .toMatchObject({ status: "excluded" });
    expect(parse(record("assistant", "final-1", "The requested work is complete", "final_answer")))
      .toMatchObject({ status: "message", message: { kind: "assistant_final" } });
  });
  it.each(["user", "subagent", "guardian_review", undefined])("does not authorize a final from thread source %s alone", thread_source => {
    const parse = harness();
    parse({ type: "session_meta", payload: { id: "session-a", source: "vscode", thread_source } });
    parse(turn);
    expect(parse(record("assistant", "final-1", "Internal result", "final_answer")))
      .toMatchObject({ status: "excluded", reason: "assistant_without_normal_user" });
  });
  it("still excludes internal title turns in a created task", () => {
    const parse = harness();
    parse({ type: "session_meta", payload: { id: "session-a", source: "vscode", thread_source: "agent_created_thread" } });
    parse(turn);
    parse(record("user", "title-prompt", "You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task that will be created from that prompt."));
    expect(parse(record("assistant", "title-answer", "A short title", "final_answer")))
      .toMatchObject({ status: "excluded", reason: "assistant_without_normal_user" });
  });
  it("captures a request and its final after marked browser context without duplicating its display mirror", () => {
    const parse = harness(); parse(turn);
    const body = '\n<in-app-browser-context source="ambient-ui-state">' + "x".repeat(500) + '</in-app-browser-context>\n\n## My request:\nKeep identifiers\n';
    const result = parse(record("user", "mixed-user", body));
    expect(result).toMatchObject({ status: "message", message: { nativeMessageId: "mixed-user", text: "\n## My request:\nKeep identifiers\n" } });
    expect(parse({ type: "event_msg", timestamp: at, payload: { type: "item_completed", turn_id: "turn-a", item: { type: "UserMessage", id: "display-mixed", content: [{ type: "text", text: body }] } } }).status).toBe("excluded");
    expect(parse(record("assistant", "mixed-final", "Done", "final_answer"))).toMatchObject({ status: "message", message: { kind: "assistant_final" } });
    const internal = harness(); internal(turn);
    expect(internal(record("user", "state-only", '<in-app-browser-context source="ambient-ui-state">state</in-app-browser-context>')).status).toBe("excluded");
    expect(internal(record("assistant", "internal-final", "Internal", "final_answer"))).toMatchObject({ status: "excluded", reason: "assistant_without_normal_user" });
  });

  it("proves historical recovery IDs from the original content-part assembly", () => {
    const parse = harness(); parse(turn);
    const raw = record("user", "image-recovery", "original\n");
    raw.payload.content.push({ type: "input_image", text: "" }, { type: "input_text", text: "\n" });
    const result = parse(raw);
    expect(result.status).toBe("message");
    if (result.status !== "message") throw Error("Expected original message");
    const legacyText = "original\n\n\n\n";
    const hash = (text: string) => createHash("sha256").update(text).digest("hex");
    expect(result.message).toMatchObject({ text: "original\n", legacyRecovery: {
      observationId: "obs_codex_recovery_" + hash(["session-a", "turn-a", "prompt_submit", at, legacyText].join("\n")).slice(0, 32),
      textDigest: hash(legacyText),
    } });
    const plain = parse(record("user", "plain", "original\n"));
    if (plain.status !== "message") throw Error("Expected plain message");
    expect(plain.message).not.toHaveProperty("legacyRecovery");
  });
  it("fingerprints only actual image wrapper triplets while preserving the ordinary user text", () => {
    const parse = harness(); parse(turn);
    const opening = '<image name="one" path="C:/images/one.png">';
    const user = record("user", "image-user", "본문");
    const result = parse({ ...user, payload: { ...user.payload, content: [
      { type: "input_text", text: "본문" }, { type: "input_text", text: opening },
      { type: "input_image", image_url: "data:image/png;base64,aA==" }, { type: "input_text", text: "</image>" },
      { type: "input_text", text: "추가 요청" },
    ] } });
    expect(result).toMatchObject({ status: "message", message: { text: "본문\n추가 요청",
      legacyImageWrappedDigest: createHash("sha256").update(`본문\n${opening}\n\n</image>\n추가 요청`).digest("hex") } });
    const literal = parse(record("user", "literal", 'Explain <image name="one"> in this example'));
    if (literal.status !== "message") throw Error("Expected ordinary text");
    expect(literal.message).not.toHaveProperty("legacyImageWrappedDigest");
  });
  it.each([
    { type: "ImageView", id: "image-tool", path: "private image path" },
    { type: "DynamicToolCall", id: "dynamic-tool", tool: "call", content_items: ["private tool output"] },
    { type: "CollabAgentToolCall", id: "agent-tool", tool: "send_message", agents_states: { child: "private tool output" } },
    { type: "WebSearch", id: "web-tool", query: "private search query", action: {} },
    { type: "HookPrompt", id: "hook-input", fragments: ["private injected context"] },
  ])("keeps completed $type tool activity out of user conversation capture", item => {
    const parse = harness(); parse(turn);
    const result = parse({ type: "event_msg", timestamp: at, payload: { type: "item_completed", turn_id: "turn-a", item } });
    expect(result).toMatchObject({ status: "excluded", reason: "non_conversation_item" });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(parse(record("user", "user-after-tool", "Continue the actual user task")).status).toBe("message");
  });
  it("preserves distinct identical user messages inside one turn and stable replay identity", () => {
    const parse = harness(); parse(turn);
    const a = parse(record("user", "message-a", "진행"));
    const b = parse(record("user", "message-b", "진행"));
    const replay = parse(record("user", "message-a", "진행"));
    expect(a.status).toBe("message"); expect(b.status).toBe("message");
    if (a.status !== "message" || b.status !== "message" || replay.status !== "message") throw Error("missing message");
    expect(a.message.key).not.toBe(b.message.key);
    expect(replay.message.key).toBe(a.message.key);
  });
  it("keeps the final primary message once while excluding its matching completion mirror", () => {
    const parse = harness(); parse(turn); parse(record("user", "u", "Fix parser"));
    expect(parse(record("assistant", "c", "Working", "commentary"))).toMatchObject({ status: "excluded" });
    expect(parse(record("assistant", "f", "Fixed", "final"))).toMatchObject({ status: "message" });
    expect(parse({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn-a", last_agent_message: "Fixed" } }))
      .toMatchObject({ status: "excluded", reason: "completion_duplicate" });
  });
  it("matches Desktop item mirrors before or after the primary records without merging user messages", () => {
    const parse = harness(); parse(turn);
    const item = (type: string, id: string, text: string, phase?: string) => ({ type: "event_msg", payload: {
      type: "item_completed", turn_id: "turn-a", item: { type, id, phase, content: [{ type: type === "UserMessage" ? "text" : "Text", text }] },
    } });
    expect(parse(item("UserMessage", "ui-user-1", "진행")).status).toBe("excluded");
    expect(parse(record("user", "native-user-1", "진행")).status).toBe("message");
    expect(parse(record("user", "native-user-2", "진행")).status).toBe("message");
    expect(parse(item("UserMessage", "ui-user-2", "진행")).status).toBe("excluded");
    expect(parse(item("AgentMessage", "native-final", "Fixed", "final_answer")).status).toBe("excluded");
    expect(parse(record("assistant", "native-final", "Fixed", "final_answer")).status).toBe("message");
    expect(parse({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn-a", last_agent_message: "Fixed" } }).status).toBe("excluded");
  });
  it("detects a missing repeated primary message from the unmatched mirror at turn completion", () => {
    const parse = harness(); parse(turn); parse(record("user", "u", "진행"));
    for (const id of ["item-1", "item-2"]) parse({ type: "event_msg", payload: {
      type: "item_completed", turn_id: "turn-a", item: { type: "UserMessage", id, content: [{ type: "text", text: "진행" }] },
    } });
    expect(parse({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn-a" } }))
      .toMatchObject({ status: "unknown", reason: "completion_has_unmatched_message_mirrors" });
  });

  it.each([true, false])("matches legacy Desktop aliases without changing primary identity (mirror first: %s)", mirrorFirst => {
    const parse = harness(); parse(turn); parse(record("user", "u", "Fix parser"));
    const mirror = { type: "event_msg", payload: { type: "item_completed", turn_id: "turn-a", item: {
      type: "AgentMessage", id: "item-45", phase: "final_answer", content: [{ type: "Text", text: "Fixed" }],
    } } };
    if (mirrorFirst) expect(parse(mirror).status).toBe("excluded");
    expect(parse(record("assistant", "msg_legacy", "Fixed", "final_answer")))
      .toMatchObject({ status: "message", message: { nativeMessageId: "msg_legacy" } });
    if (!mirrorFirst) expect(parse(mirror).status).toBe("excluded");
    expect(parse({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn-a", last_agent_message: "Fixed" } }).status)
      .toBe("excluded");
  });

  it.each([null, "msg_legacy"])("does not reuse one %s final primary for multiple mirror identities", id => {
    const parse = harness(); parse(turn); parse(record("user", "u", "Fix parser"));
    parse(record("assistant", id, "Fixed", "final_answer"));
    for (const mirrorId of ["item-45", "item-63"]) parse({ type: "event_msg", payload: {
      type: "item_completed", turn_id: "turn-a", item: {
        type: "AgentMessage", id: mirrorId, phase: "final_answer", content: [{ type: "Text", text: "Fixed" }],
      },
    } });
    expect(parse({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn-a" } }))
      .toMatchObject({ status: "unknown", reason: "completion_has_unmatched_message_mirrors" });
  });

  it.each([["item-45", "Different"], ["unrelated-id", "Fixed"]])("keeps unmatched final %s/%s pending across turn boundaries", (id, text) => {
    const parse = harness(); parse(turn); parse(record("user", "u", "Fix parser"));
    parse(record("assistant", "msg_legacy", "Fixed", "final_answer"));
    parse({ type: "event_msg", payload: { type: "item_completed", turn_id: "turn-a", item: {
      type: "AgentMessage", id, phase: "final_answer", content: [{ type: "Text", text }],
    } } });
    expect(parse({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-b" } }))
      .toMatchObject({ status: "unknown", reason: "previous_turn_has_unmatched_message_mirrors" });
  });
  it("recognizes linked question-tool displays and image wrappers without collecting tool output or image bytes", () => {
    const parse = harness(); parse(turn);
    const message = record("user", "u", "Explain this image");
    message.payload.content.push({ type: "input_text", text: '<image name="one" path="C:/image.png">' },
      { type: "input_image", text: "not copied image bytes" }, { type: "input_text", text: "</image>" });
    expect(parse(message)).toMatchObject({ status: "message", message: { text: "Explain this image" } });
    expect(parse({ type: "event_msg", payload: { type: "item_completed", turn_id: "turn-a", item: {
      type: "UserMessage", id: "ui-user", content: [{ type: "text", text: "Explain this image" }, { type: "local_image", path: "C:/image.png" }],
    } } }).status).toBe("excluded");
    parse({ type: "response_item", payload: { type: "function_call", name: "request_user_input_async", call_id: "call-question" } });
    expect(parse({ type: "event_msg", payload: { type: "item_completed", turn_id: "turn-a", item: {
      type: "AgentMessage", id: "call-question", phase: "final_answer", content: [{ type: "Text", text: "Question?" }],
    } } })).toMatchObject({ status: "excluded", reason: "user_input_tool_display" });
    expect(parse({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn-a" } }).status).toBe("excluded");
  });
  it("continues a conversation across tool discovery calls and results", () => {
    const parse = harness(); parse(turn); parse(record("user", "u", "Find the previous decision"));
    for (const type of ["tool_search_call", "tool_search_output"]) {
      expect(parse({ type: "response_item", payload: { type, call_id: "discovery", status: "completed", execution: "client" } }))
        .toMatchObject({ status: "excluded", reason: "non_conversation_response" });
    }
    expect(parse(record("assistant", "f", "Found the decision", "final")))
      .toMatchObject({ status: "message", message: { kind: "assistant_final", text: "Found the decision" } });
    expect(parse({ type: "response_item", payload: { type: "unrecognized_conversation_item" } }).status).toBe("unknown");
  });
  it("reports unsupported or missing primary evidence rather than a false completion", () => {
    const parse = harness(); parse(turn); parse(record("user", "u", "Fix parser"));
    for (const value of [record("assistant", "f", "Fixed"),
      { type: "event_msg", payload: { type: "user_message", message: "Fix parser" } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-a", last_agent_message: "Fixed" } }]) {
      expect(parse(value).status).toBe("unknown");
    }
  });
  it("filters host blocks per content part without losing the actual user request", () => {
    const parse = harness(); parse(turn);
    const input = record("user", "u", "<environment_context>host</environment_context>");
    input.payload.content.push({ type: "input_text", text: "Fix parser" });
    expect(parse(input)).toMatchObject({ status: "message", message: { text: "Fix parser" } });
  });
  it("does not promote ambient-only assistant output or an explicit internal turn after normal work", () => {
    const parse = harness(); parse(turn);
    expect(parse(record("user", "u", "<heartbeat>internal</heartbeat>")).status).toBe("excluded");
    expect(parse(record("assistant", "f", "internal response", "final")).status).toBe("excluded");
    parse(record("user", "normal", "Fix parser"));
    parse({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-b" } });
    parse(record("user", "ambient", "<heartbeat>internal</heartbeat>"));
    expect(parse(record("assistant", "other", "not verified", "final")).status).toBe("excluded");
  });
  it("keeps the main task's final result from a goal continuation without storing its internal prompt", () => {
    const parse = harness(); parse(turn); parse(record("user", "normal", "Finish implementation"));
    parse({ type: "event_msg", payload: { type: "task_started", turn_id: "goal-continuation" } });
    expect(parse(record("user", "internal", '<codex_internal_context source="goal">Continue working</codex_internal_context>')).status).toBe("excluded");
    expect(parse(record("assistant", "goal-result", "Implementation and verification completed", "final_answer")))
      .toMatchObject({ status: "message", message: { kind: "assistant_final" } });
  });
  it("keeps legacy positions distinct and does not substitute wall-clock timestamps", () => {
    const parse = harness(); parse(turn);
    const a = parse(record("user", null, "진행"), 20), b = parse(record("user", null, "진행"), 21);
    if (a.status !== "message" || b.status !== "message") throw Error("missing legacy message");
    expect(a.message.key).not.toBe(b.message.key);
    expect(parse({ ...record("user", "invalid", "request"), timestamp: null })).toMatchObject({ status: "unknown" });
  });
});
