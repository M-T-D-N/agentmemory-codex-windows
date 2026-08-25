import type { CompressedObservation, Session } from "../types.js";

export function isCodexInternalAmbientText(value: unknown): boolean {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!text) return false;
  const structuredHostContext = [
    "<environment_context",
    "<codex_internal_context",
    "<heartbeat",
    "<codex_delegation",
    "<subagent_notification",
    "<agentmemory-curation",
    "<in-app-browser-context",
    "<hook_prompt",
    "<recommended_plugins",
    "<app-context",
    "<skills_instructions",
    "<apps_instructions",
    "<plugins_instructions",
    "<collaboration_mode",
    "<permissions instructions",
    "<turn_aborted",
    "# agents.md instructions",
    "# response annotations:",
  ].some((prefix) => text.startsWith(prefix));
  return (
    structuredHostContext ||
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

export function isExcludedCodexAmbientSession(
  session: Session | null | undefined,
): boolean {
  return (
    session?.captureExcluded === true ||
    isCodexInternalAmbientText(session?.firstPrompt)
  );
}

const CODEX_AMBIENT_UI_BLOCK =
  /<([a-z][a-z0-9-]*)\b(?=[^>]*\bsource=(["'])ambient-ui-state\2)[^>]*>[\s\S]*?<\/\1>\s*/gi;
const AGENTMEMORY_AMBIENT_BLOCK =
  /<agentmemory-ambient-ui-state\b[^>]*>[\s\S]*?<\/agentmemory-ambient-ui-state>\s*/gi;
const CODEX_AMBIENT_UI_PREFIX =
  /^\s*<([a-z][a-z0-9-]*)\b(?=[^>]*\bsource=(["'])ambient-ui-state\2)[^>]*>/i;

export function sanitizeCodexAmbientObservation<
  T extends CompressedObservation,
>(observation: T | null | undefined): T | null {
  if (!observation || typeof observation.narrative !== "string") {
    return observation ?? null;
  }
  if (isCodexInternalAmbientText(observation.narrative)) return null;
  const narrative = observation.narrative
    .replace(CODEX_AMBIENT_UI_BLOCK, "")
    .replace(AGENTMEMORY_AMBIENT_BLOCK, "");
  if (
    narrative === observation.narrative &&
    CODEX_AMBIENT_UI_PREFIX.test(observation.narrative)
  ) {
    return null;
  }
  if (narrative === observation.narrative) return observation;
  if (!narrative.trim() || isCodexInternalAmbientText(narrative)) return null;
  return { ...observation, narrative };
}
