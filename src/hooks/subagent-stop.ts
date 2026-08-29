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

  const sessionId = ((data.session_id || data.sessionId || data.conversation_id) as string) || "unknown";
  const agentId = data.agent_id || data.agentName;
  const agentType = data.agent_type || data.agentDisplayName || data.agentName;
  const lastMsg =
    typeof data.last_assistant_message === "string"
      ? data.last_assistant_message.slice(0, 4000)
      : "";

  const cwd = hookCwd(data) || process.cwd();

  fetch(`${REST_URL}/agentmemory/observe`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      hookType: "subagent_stop",
      sessionId,
      project: resolveProject(cwd),
      cwd,
      timestamp: new Date().toISOString(),
      data: {
        agent_id: agentId,
        agent_type: agentType,
        last_message: lastMsg,
      },
    }),
    signal: AbortSignal.timeout(2000),
  }).catch(() => {});
  setTimeout(() => process.exit(0), 500).unref();
}

main().catch(() => process.exit(0));
