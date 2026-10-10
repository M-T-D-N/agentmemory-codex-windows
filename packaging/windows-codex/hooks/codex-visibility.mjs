export function isCodexApprovalReviewText(value) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return text.startsWith("the following is the codex agent history whose request action you are assessing.")
    || text.startsWith("the following is the codex agent history added since your last approval assessment.");
}

export function isCodexInternalAmbientText(value) {
  const original = typeof value === "string" ? value : "";
  const visible = stripCodexAmbientUiBlocks(original);
  const firstContent = visible.search(/\S/u);
  if (markdownLiteralRanges(visible).some(([start, end]) => firstContent >= start && firstContent < end)) return false;
  const text = visible.trim().toLowerCase();
  if (!text) return original.trim().length > 0;
  if (CODEX_AMBIENT_UI_PREFIX.test(text)) return true;
  const structuredHostContext = isCompleteCodexHostEnvelope(text);
  return (
    isCodexEffortEvaluatorText(original) || isCodexApprovalReviewText(text) || isIncidentalCodexHostEvent(text) || structuredHostContext ||
    text.startsWith("this is an app-generated request for a suggested next user message. the user did not write this message.") ||
    (text.startsWith("# overview") &&
      text.includes("hyperpersonalized suggestion")) ||
    text.startsWith(
      "you are an expert at upholding safety and compliance standards for codex ambient suggestions",
    ) ||
    text.startsWith(
      "you are a helpful assistant. you will be presented with a user prompt, and your job is to provide a short title for a task that will be created from that prompt.",
    ) ||
    text.startsWith(
      "you are in a fork of an existing codex thread. fill the structured description field with a compact, search-oriented summary",
    ) ||
    text.startsWith(
      "you are a helpful assistant. you will be presented with the most recent messages in an existing conversation",
    ) ||
    (text.startsWith(
      "you write the one-line activity update displayed beneath an existing codex task title.",
    ) &&
      text.includes("fill the structured summary field with one plain-text sentence"))
  );
}

const CODEX_AMBIENT_UI_BLOCK =
  /<([a-z][a-z0-9-]*)\b(?=[^>]*\bsource=(["'])ambient-ui-state\2)[^>]*>[\s\S]*?<\/\1>\s*/gi;
const AGENTMEMORY_AMBIENT_BLOCK =
  /<agentmemory-ambient-ui-state\b[^>]*>[\s\S]*?<\/agentmemory-ambient-ui-state>\s*/gi;
const CODEX_AMBIENT_UI_PREFIX =
  /^\s*<([a-z][a-z0-9-]*)\b(?=[^>]*\bsource=(["'])ambient-ui-state\2)[^>]*>/i;

export function stripCodexAmbientUiBlocks(value) {
  const protectedRanges = markdownLiteralRanges(value);
  const matches = [...value.matchAll(CODEX_AMBIENT_UI_BLOCK), ...value.matchAll(AGENTMEMORY_AMBIENT_BLOCK)]
    .filter(match => !protectedRanges.some(([start, end]) => match.index < end && match.index + match[0].trimEnd().length > start))
    .sort((a, b) => a.index - b.index || b[0].length - a[0].length);
  const removals = [];
  for (const match of matches) {
    const previous = removals.at(-1);
    if (!previous || match.index >= previous.index + previous[0].length) removals.push(match);
  }
  let result = value;
  for (const match of removals.reverse()) result = result.slice(0, match.index) + result.slice(match.index + match[0].length);
  return result;
}

function markdownLiteralRanges(value) {
  const ranges = [];
  let fence = null;
  let offset = 0;
  for (const line of value.split(/(?<=\n)/u)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*?)(?:\r?\n)?$/u.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.marker && marker[1].length >= fence.length && !marker[2].trim()) {
        ranges.push([fence.start, offset + line.length]); fence = null;
      }
    } else if (marker && !(marker[1][0] === "`" && marker[2].includes("`"))) {
      fence = { marker: marker[1][0], length: marker[1].length, start: offset };
    } else if (/^ {0,3}>/u.test(line) || /^(?: {4}|\t)/u.test(line)) {
      ranges.push([offset, offset + line.length]);
    }
    offset += line.length;
  }
  if (fence) ranges.push([fence.start, value.length]);
  for (const match of value.matchAll(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/gu)) {
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}


export function isIncidentalCodexHostEvent(value) {
  if (typeof value !== "string") return false;
  const text = value.trim();
  return /^<external_codex_apps_open_page>\s*\{"page_id":null\}\s*<\/external_codex_apps_open_page>$/u.test(text)
    || /^<external_codex_apps_writing_block_edits>The user manually edited these writing blocks\. Treat the following snapshots as the current versions of those blocks, superseding the earlier assistant output\.\s*\[\s*\]\s*<\/external_codex_apps_writing_block_edits>$/iu.test(text);
}

export function isExcludedCodexAmbientSession(session) {
  if (session?.captureExcluded === true) return true;
  const preview = session?.firstPrompt;
  if (typeof preview !== "string" || preview.trim().toLowerCase() === "# response annotations:") return false;
  const evaluatorPreview = isLegacyCodexEffortEvaluatorPreview(preview);
  const openAmbientPreview = CODEX_AMBIENT_UI_PREFIX.test(preview) && stripCodexAmbientUiBlocks(preview) === preview;
  if (session?.codexNativeCapture?.cursor?.parser?.normalUserSeen === true && (evaluatorPreview || openAmbientPreview)) return false;
  return evaluatorPreview || (isCodexInternalAmbientText(preview) && !isIncidentalCodexHostEvent(preview));
}

function isLegacyCodexEffortEvaluatorPreview(value) {
  if (value.length !== 200 || !/^\s*\{\s*"instructions"\s*:\s*"You are an independent reasoning-effort evaluator, not the task executor\./u.test(value)) return false;
  try { JSON.parse(value); return false; } catch { return true; }
}

function isCompleteCodexHostEnvelope(text) {
  let remaining = text;
  if (remaining.startsWith("# agents.md instructions")) {
    const header = /^# agents\.md instructions[^\n]*(?:\n|$)/i.exec(remaining);
    remaining = remaining.slice(header[0].length).trim();
    if (!remaining) return true;
    if (!remaining.startsWith("<instructions>")) return false;
    remaining = remaining.replace(/^<instructions>[\s\S]*?<\/instructions>\s*/i, "");
  }
  if (remaining.startsWith("# response annotations:")) {
    const header = /^# response annotations:[ \t]*(?:\r?\n|$)/i.exec(remaining);
    if (!header) return false;
    remaining = remaining.slice(header[0].length).trim();
  }
  const envelope = /^<(environment_context|codex_internal_context|heartbeat|codex_delegation|subagent_notification|agentmemory-curation|in-app-browser-context|hook_prompt|recommended_plugins|app-context|skills_instructions|apps_instructions|plugins_instructions|collaboration_mode|permissions instructions|turn_aborted)\b[^>]*>[\s\S]*?<\/\1>\s*/i;
  let matched = remaining !== text;
  while (envelope.test(remaining)) { matched = true; remaining = remaining.replace(envelope, ""); }
  return matched && !remaining.trim();
}

export function isCodexEffortEvaluatorText(value) {
  if (typeof value !== "string") return false;
  const signature = "You are an independent reasoning-effort evaluator, not the task executor.";
  try {
    const payload = JSON.parse(value);
    if (typeof payload?.instructions !== "string" || !payload.instructions.startsWith(signature)) return false;
    return (typeof payload.question === "string" && payload.question.startsWith("Which reasoning effort is sufficient for the NEXT generation of state.model?")
      && payload.state?.coverage?.source === "native DecisionContext + local projectEvidence")
      || isOlderCodexEffortEvaluatorPayload(payload);
  } catch { return false; }
}

function sameStringSet(value, expected) {
  return Array.isArray(value) && value.length === expected.length
    && new Set(value).size === value.length && value.every(item => expected.includes(item));
}

function hasExactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && sameStringSet(Object.keys(value), keys);
}

function isOlderCodexEffortEvaluatorPayload(payload) {
  if (payload.question !== "Which supported effort is sufficient for the NEXT generation? Judge remaining reasoning, not vocabulary."
    || !sameStringSet(payload.state?.supportedEfforts, ["medium", "high", "xhigh", "max"])) return false;
  const schema = payload.outputSchema;
  if (!hasExactKeys(schema, ["type", "additionalProperties", "properties", "required"])
    || schema.type !== "object" || schema.additionalProperties !== false
    || !sameStringSet(schema.required, ["action", "effort", "reason"])
    || !hasExactKeys(schema.properties, ["action", "effort", "reason"])) return false;
  const { action, effort, reason } = schema.properties;
  if (!hasExactKeys(action, ["type", "enum"]) || action.type !== "string"
    || !sameStringSet(action.enum, ["recommend", "abstain"])
    || !hasExactKeys(reason, ["type"]) || reason.type !== "string"
    || !hasExactKeys(effort, ["anyOf"]) || !Array.isArray(effort.anyOf) || effort.anyOf.length !== 2) return false;
  return effort.anyOf.some(option => hasExactKeys(option, ["type"]) && option.type === "null")
    && effort.anyOf.some(option => hasExactKeys(option, ["type", "enum"]) && option.type === "string"
      && sameStringSet(option.enum, payload.state.supportedEfforts));
}
