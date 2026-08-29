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

  const cwd = hookCwd(data) || process.cwd();

  fetch(`${REST_URL}/agentmemory/observe`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      hookType: "task_completed",
      sessionId,
      project: resolveProject(cwd),
      cwd,
      timestamp: new Date().toISOString(),
      data: {
        task_id: data.task_id,
        task_subject: data.task_subject,
        task_description: typeof data.task_description === "string"
          ? data.task_description.slice(0, 2000)
          : "",
        teammate_name: data.teammate_name,
        team_name: data.team_name,
      },
    }),
    signal: AbortSignal.timeout(2000),
  }).catch(() => {});
  setTimeout(() => process.exit(0), 500).unref();
}

main().catch(() => process.exit(0));
