#!/usr/bin/env node
import { resolveProject, hookCwd } from "./_project.js";
import { REST_URL, authHeaders, isSdkChildContext } from "./_runtime.js";

async function main() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(input);
  } catch {
    return;
  }

  if (!data || typeof data !== "object") return;
  if (isSdkChildContext(data)) return;
  if (data.is_interrupt || data.isInterrupt) return;

  const sessionId = ((data.session_id || data.sessionId || data.conversation_id) as string) || "unknown";
  const toolName = data.tool_name ?? data.toolName;
  const toolInput = data.tool_input ?? data.toolArgs;
  const error = data.error ?? data.errorMessage;

  const cwd = hookCwd(data) || process.cwd();

  fetch(`${REST_URL}/agentmemory/observe`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      hookType: "post_tool_failure",
      sessionId,
      project: resolveProject(cwd),
      cwd,
      timestamp: new Date().toISOString(),
      data: {
        tool_name: toolName,
        tool_input:
          typeof toolInput === "string"
            ? toolInput.slice(0, 4000)
            : JSON.stringify(toolInput ?? "").slice(0, 4000),
        error:
          typeof error === "string"
            ? error.slice(0, 4000)
            : JSON.stringify(error ?? "").slice(0, 4000),
      },
    }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
  setTimeout(() => process.exit(0), 500).unref();
}

main().catch(() => process.exit(0));
