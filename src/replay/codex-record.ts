import { createHash } from "node:crypto";
import { isCodexApprovalReviewText, isCodexInternalAmbientText, stripCodexAmbientUiBlocks } from "../functions/observation-visibility.js";
import { stripPrivateData } from "../functions/privacy.js";
import { canonicalCodexCwd } from "../functions/codex-source-identity.js";

export interface CodexParseState {
  turnId: string | null;
  cwd?: string;
  normalUserSeen: boolean;
  normalSessionSeen: boolean;
  internalTurn: boolean;
  finalDigests: string[];
  userMessages: Array<{ key: string; digest: string }>;
  userMirrors: Array<{ id: string; digest: string; sourceLocation?: { ordinal: number; byteOffset: number; recordDigest: string } }>;
  finalMessages: Array<{ id: string | null; digest: string }>;
  finalMirrors: Array<{ id: string; digest: string }>;
  userInputToolIds: string[];
}

export interface CodexNativeMessage {
  key: string;
  sessionId: string;
  nativeMessageId: string | null;
  turnId: string | null;
  kind: "user" | "assistant_final";
  timestamp: string;
  ordinal: number;
  byteOffset: number;
  text: string;
  legacyImageWrappedDigest?: string;
  legacyRecovery?: { observationId: string; textDigest: string };
  legacyExcludedReason?: "assistant_without_normal_user";
}

export type CodexRecordResult =
  | { status: "message"; message: CodexNativeMessage; state: CodexParseState }
  | { status: "excluded"; reason: string; state: CodexParseState; legacyMessage?: CodexNativeMessage;
      legacyUserItem?: { turnId: string; id: string; textDigest: string } }
  | { status: "unknown"; reason: string; state: CodexParseState };

const ignoredResponseTypes = new Set(["reasoning", "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output", "local_shell_call", "web_search_call", "tool_search_call", "tool_search_output", "image_generation_call", "compaction", "agent_message"]);
const ignoredEvents = new Set(["token_count", "agent_reasoning", "context_compacted", "entered_review_mode", "exited_review_mode", "warning", "error", "session_configured", "thread_settings_applied", "thread_goal_updated"]);
const ignoredItems = new Set(["FunctionCallOutput", "CommandExecution", "Reasoning", "Extension", "McpToolCall", "DynamicToolCall", "ContextCompaction", "SubAgentActivity", "CollabAgentToolCall", "ImageView", "FileChange", "WebSearch", "HookPrompt"]);
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const identity = (value: unknown): value is string => typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 512;

export function initialCodexParseState(normalSessionSeen = false): CodexParseState {
  return { turnId: null, normalUserSeen: false, normalSessionSeen, internalTurn: false,
    finalDigests: [], userMessages: [], userMirrors: [], finalMessages: [], finalMirrors: [], userInputToolIds: [] };
}

function isInternalTurnInstruction(text: string): boolean {
  if (isCodexApprovalReviewText(text)) return true;
  if (!isCodexInternalAmbientText(text)) return false;
  if (/^\s*<codex_internal_context\b[^>]*\bsource=["']goal["']/i.test(text)) return false;
  return !/^\s*(?:# agents\.md instructions|# response annotations:|<(?:environment_context|recommended_plugins|app-context|skills_instructions|apps_instructions|plugins_instructions|collaboration_mode|permissions instructions|agentmemory-curation|in-app-browser-context|codex_delegation|subagent_notification|turn_aborted)\b)/i.test(text);
}

const eligibleFinal = (state: CodexParseState) => state.normalUserSeen || (state.normalSessionSeen && !state.internalTurn);

export function pendingCodexMirrors(state: CodexParseState): boolean {
  if (state.userMirrors.some(mirror => state.userMirrors.filter(m => m.digest === mirror.digest).length >
    state.userMessages.filter(m => m.digest === mirror.digest).length)) return true;
  const unmatchedMessages = [...state.finalMessages];
  const unmatchedMirrors = state.finalMirrors.filter(mirror => {
    const index = unmatchedMessages.findIndex(message => message.id === mirror.id && message.digest === mirror.digest);
    if (index < 0) return true;
    unmatchedMessages.splice(index, 1);
    return false;
  });
  return unmatchedMirrors.some(mirror => {
    const index = unmatchedMessages.findIndex(message => message.digest === mirror.digest &&
      (message.id === null || (/^item-\d+$/.test(mirror.id) && /^msg_/.test(message.id))));
    if (index < 0) return true;
    unmatchedMessages.splice(index, 1);
    return false;
  });
}

export function codexUserText(value: string): string | null {
  if (isCodexInternalAmbientText(value) || isCodexApprovalReviewText(value)) return null;
  const text = stripCodexAmbientUiBlocks(value);
  if (!text.trim() || isCodexInternalAmbientText(text) || isCodexApprovalReviewText(text)) return null;
  return stripPrivateData(text);
}

export function parseCodexRecord(
  value: unknown,
  context: { sessionId: string; ordinal: number; byteOffset: number; includeExcludedMessages?: boolean },
  prior: CodexParseState,
): CodexRecordResult {
  const state = { ...prior, finalDigests: [...prior.finalDigests], userMessages: [...prior.userMessages], userMirrors: [...prior.userMirrors],
    finalMessages: [...prior.finalMessages], finalMirrors: [...prior.finalMirrors], userInputToolIds: [...prior.userInputToolIds] };
  const excluded = (reason: string): CodexRecordResult => ({ status: "excluded", reason, state });
  const unknown = (reason: string): CodexRecordResult => ({ status: "unknown", reason, state: prior });
  if (!identity(context.sessionId) || !Number.isSafeInteger(context.ordinal) || context.ordinal < 1 ||
      !Number.isSafeInteger(context.byteOffset) || context.byteOffset < 0) return unknown("invalid_source_location");
  const row = asRecord(value), payload = asRecord(row?.payload);
  if (!row || !payload) return unknown("invalid_record_envelope");
  if (row.type === "session_meta") {
    if (context.ordinal !== 1 || payload.id !== context.sessionId) return unknown("unexpected_session_header");
    // Created tasks receive their initial request as a delegation tool result,
    // rather than a user message. Keep that payload out of conversation text.
    if (payload.thread_source === "agent_created_thread" && ["cli", "vscode"].includes(String(payload.source))) {
      state.normalSessionSeen = true;
    }
    return excluded("verified_session_header");
  }
  if (row.type === "turn_context") {
    if (!identity(payload.turn_id)) return unknown("missing_turn_identity");
    if (state.turnId === null) state.turnId = payload.turn_id;
    if (state.turnId !== payload.turn_id) return unknown("turn_context_mismatch");
    if (payload.cwd !== undefined) {
      if (typeof payload.cwd !== "string") return unknown("invalid_turn_cwd");
      try { state.cwd = canonicalCodexCwd(payload.cwd); }
      catch { return unknown("invalid_turn_cwd"); }
    }
    return excluded("turn_context");
  }
  if (row.type === "compacted") return excluded("compaction_metadata");
  if (row.type === "world_state" && typeof payload.full === "boolean" && asRecord(payload.state)) return excluded("host_world_state");
  if (["token_usage_record", "inter_agent_communication_metadata"].includes(String(row.type))) return excluded("host_telemetry");
  if (row.type === "event_msg") {
    if (payload.type === "task_started") {
      if (!identity(payload.turn_id)) return unknown("missing_turn_identity");
      if (payload.turn_id !== state.turnId) {
        if (pendingCodexMirrors(state)) return unknown("previous_turn_has_unmatched_message_mirrors");
        state.turnId = payload.turn_id; state.normalUserSeen = false; state.finalDigests = [];
        state.internalTurn = false;
        state.userMessages = []; state.userMirrors = [];
        state.finalMessages = []; state.finalMirrors = [];
        state.userInputToolIds = [];
      }
      return excluded("turn_started");
    }
    if (payload.type === "task_complete") {
      if (payload.turn_id !== state.turnId) return unknown("completion_turn_mismatch");
      if (pendingCodexMirrors(state)) return unknown("completion_has_unmatched_message_mirrors");
      if (eligibleFinal(state) && typeof payload.last_agent_message === "string" && payload.last_agent_message.trim() &&
          !state.finalDigests.includes(digest(stripPrivateData(payload.last_agent_message)))) {
        return unknown("completion_without_matching_final_message");
      }
      return excluded("completion_duplicate");
    }
    if (payload.type === "item_completed") {
      const item = asRecord(payload.item);
      if (!item) return unknown("invalid_completed_item");
      if (ignoredItems.has(String(item.type))) return excluded("non_conversation_item");
      if (item.type !== "UserMessage" && item.type !== "AgentMessage") return unknown("unsupported_completed_item");
      if (item.type === "AgentMessage" && typeof item.id === "string" && state.userInputToolIds.includes(item.id)) return excluded("user_input_tool_display");
      if (item.type === "AgentMessage" && ["analysis", "commentary", "summary"].includes(String(item.phase))) return excluded("non_final_assistant_item");
      if (item.type === "AgentMessage" && !["final", "final_answer"].includes(String(item.phase))) return unknown("unclassified_assistant_item_phase");
      if (payload.turn_id !== state.turnId || !identity(item.id) || !Array.isArray(item.content)) return unknown("invalid_conversation_item");
      const parts: string[] = [];
      for (const rawPart of item.content) {
        const part = asRecord(rawPart);
        if (!part) return unknown("invalid_item_content");
        if (["input_image", "image", "image_url", "localImage", "local_image"].includes(String(part.type))) continue;
        if (!["Text", "text", "input_text", "output_text"].includes(String(part.type)) || typeof part.text !== "string") return unknown("unsupported_item_content");
        const text = item.type === "UserMessage" ? codexUserText(part.text) : stripPrivateData(part.text);
        if (text !== null && text.trim()) parts.push(text);
      }
      if (parts.length === 0 || (item.type === "AgentMessage" && !eligibleFinal(state))) return excluded("ineligible_conversation_mirror");
      const fingerprint = digest(parts.join("\n"));
      if (item.type === "AgentMessage") {
        const existing = state.finalMirrors.find(mirror => mirror.id === item.id);
        const primary = state.finalMessages.find(message => message.id === item.id);
        if ((existing && existing.digest !== fingerprint) || (primary && primary.digest !== fingerprint)) return unknown("conflicting_final_item_identity");
        if (!existing) {
          if (state.finalMirrors.length >= 128) return unknown("excessive_final_items_in_turn");
          state.finalMirrors.push({ id: item.id, digest: fingerprint });
        }
        return excluded("final_item_mirror");
      }
      const existing = state.userMirrors.find(mirror => mirror.id === item.id);
      if (existing) return existing.digest === fingerprint ? excluded("verified_user_item_mirror") : unknown("conflicting_user_item_identity");
      if (state.userMirrors.length >= 256) return unknown("excessive_user_items_in_turn");
      state.userMirrors.push({ id: item.id, digest: fingerprint });
      return { ...excluded("user_item_mirror"), ...(context.includeExcludedMessages ? {
        legacyUserItem: { turnId: state.turnId!, id: item.id, textDigest: fingerprint },
      } : {}) };
    }
    if (payload.type === "turn_aborted") return excluded("turn_aborted");
    if (ignoredEvents.has(String(payload.type))) return excluded("non_conversation_event");
    // A legacy mirror without a verified canonical message must not silently
    // count as either captured or excluded merely because its text repeats.
    return unknown("unsupported_event_representation");
  }
  if (row.type !== "response_item") return unknown("unsupported_record_type");
  if (ignoredResponseTypes.has(String(payload.type))) {
    if (payload.type === "function_call" && typeof payload.name === "string" &&
        /(?:^|\.)request_user_input(?:_async)?$/.test(payload.name) && identity(payload.call_id)) {
      if (!state.userInputToolIds.includes(payload.call_id)) {
        if (state.userInputToolIds.length >= 128) return unknown("excessive_user_input_tool_calls");
        state.userInputToolIds.push(payload.call_id);
      }
    }
    return excluded("non_conversation_response");
  }
  if (payload.type !== "message") return unknown("unsupported_response_type");
  if (["system", "developer", "tool"].includes(String(payload.role))) return excluded("non_user_role");
  if (payload.role !== "user" && payload.role !== "assistant") return unknown("unsupported_message_role");
  if (payload.role === "assistant" && ["analysis", "commentary", "summary"].includes(String(payload.phase))) return excluded("non_final_assistant");
  if (payload.role === "assistant" && !["final", "final_answer"].includes(String(payload.phase))) return unknown("unclassified_assistant_phase");
  if (!Array.isArray(payload.content)) return unknown("invalid_message_content");
  const parts: string[] = [];
  const legacyParts: string[] = [];
  let hasImageWrapper = false;
  for (let index = 0; index < payload.content.length; index++) {
    const part = asRecord(payload.content[index]);
    if (!part) return unknown("invalid_content_part");
    if (payload.role === "user" && part.type === "input_text" && typeof part.text === "string" &&
        /^<image\s[^>]*>$/.test(part.text.trim()) &&
        asRecord(payload.content[index + 1])?.type === "input_image" &&
        asRecord(payload.content[index + 2])?.text === "</image>") {
      legacyParts.push(stripPrivateData(part.text), "", "</image>");
      hasImageWrapper = true;
      index += 2;
      continue;
    }
    if (["input_image", "image", "image_url"].includes(String(part.type))) continue;
    if (!["input_text", "output_text", "text"].includes(String(part.type)) || typeof part.text !== "string") return unknown("unsupported_content_part");
    if (payload.role === "user" && isInternalTurnInstruction(part.text)) state.internalTurn = true;
    const text = payload.role === "user" ? codexUserText(part.text) : stripPrivateData(part.text);
    if (text !== null && text.trim()) { parts.push(text); legacyParts.push(text); }
  }
  if (parts.length === 0) return excluded("no_eligible_text");
  if (typeof row.timestamp !== "string" || !Number.isFinite(Date.parse(row.timestamp))) return unknown("invalid_message_timestamp");
  if (!state.turnId) return unknown("message_without_turn_context");
  const excludedFinal = payload.role === "assistant" && !eligibleFinal(state);
  if (excludedFinal && context.includeExcludedMessages !== true) return excluded("assistant_without_normal_user");
  if (payload.id !== undefined && payload.id !== null && !identity(payload.id)) return unknown("invalid_native_message_identity");
  const kind = payload.role === "user" ? "user" as const : "assistant_final" as const;
  const nativeMessageId = identity(payload.id) ? payload.id : null;
  const key = digest(JSON.stringify(["codex-native-v1", context.sessionId, kind,
    nativeMessageId ?? ["legacy-position", row.timestamp, context.ordinal, context.byteOffset]]));
  const text = parts.join("\n");
  const recoveryText = kind === "user" ? codexUserText(payload.content
    .map(part => typeof part.text === "string" ? part.text : "")
    .filter(part => !/^<image name=|^<\/image>$/.test(part.trim())).join("\n")) : null;
  const legacyRecovery = recoveryText !== null && recoveryText !== text ? {
    observationId: "obs_codex_recovery_" + digest([context.sessionId, state.turnId, "prompt_submit", row.timestamp, recoveryText].join("\n")).slice(0, 32),
    textDigest: digest(recoveryText),
  } : undefined;
  const message: CodexNativeMessage = { key, sessionId: context.sessionId, nativeMessageId,
    turnId: state.turnId, kind, timestamp: row.timestamp, ordinal: context.ordinal, byteOffset: context.byteOffset, text,
    ...(hasImageWrapper ? { legacyImageWrappedDigest: digest(legacyParts.join("\n")) } : {}),
    ...(legacyRecovery ? { legacyRecovery } : {}) };
  if (excludedFinal) return { status: "excluded", reason: "assistant_without_normal_user", state,
    legacyMessage: { ...message, legacyExcludedReason: "assistant_without_normal_user" } };
  if (kind === "user") {
    state.normalUserSeen = true;
    state.normalSessionSeen = true;
    state.internalTurn = false;
    const existing = state.userMessages.find(message => message.key === key);
    if (existing && existing.digest !== digest(text)) return unknown("conflicting_user_message_identity");
    if (!existing) {
      if (state.userMessages.length >= 256) return unknown("excessive_user_messages_in_turn");
      state.userMessages.push({ key, digest: digest(text) });
    }
  }
  else {
    if (state.finalDigests.length >= 128) return unknown("excessive_final_messages_in_turn");
    const mirror = nativeMessageId ? state.finalMirrors.find(item => item.id === nativeMessageId) : undefined;
    const existing = nativeMessageId ? state.finalMessages.find(item => item.id === nativeMessageId) : undefined;
    if ((mirror && mirror.digest !== digest(text)) || (existing && existing.digest !== digest(text))) return unknown("conflicting_final_message_identity");
    state.finalDigests.push(digest(text));
    if (!existing) state.finalMessages.push({ id: nativeMessageId, digest: digest(text) });
  }
  return { status: "message", state, message };
}
