import { getAgentId, isAgentScopeIsolated } from "../config.js";

export function resolveReadAgentId(value: unknown, operation: string): string | undefined {
  if (value !== undefined && (typeof value !== "string" || !value.trim() || value.length > 512)) throw Error("agentId must be a non-empty string of at most 512 characters");
  const explicit = typeof value === "string" ? value.trim() : undefined;
  if (explicit === "*") return undefined;
  const resolved = explicit ?? (isAgentScopeIsolated() ? getAgentId() : undefined);
  if (!resolved && isAgentScopeIsolated()) throw Error(operation + ': AGENTMEMORY_AGENT_SCOPE=isolated requires an agent id. Pass agentId: "*" to opt in to a wildcard read.');
  return resolved;
}
