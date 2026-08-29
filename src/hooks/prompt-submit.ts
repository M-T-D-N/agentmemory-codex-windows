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
      hookType: "prompt_submit",
      sessionId,
      project: resolveProject(cwd),
      cwd,
      timestamp: new Date().toISOString(),
      data: { prompt: data.prompt ?? data.userPrompt },
    }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
  setTimeout(() => process.exit(0), 500).unref();
}

main().catch(() => process.exit(0));
