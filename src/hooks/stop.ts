#!/usr/bin/env node
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
  if (isSdkChildContext(data)) {
    // Do not summarize from inside a Claude Agent SDK child session;
    // would re-enter agent-sdk provider and loop (see sdk-guard.ts).
    return;
  }

  const sessionId = ((data.session_id || data.sessionId || data.conversation_id) as string) || "unknown";

  // session/end already fans out the summary server-side (#1203).
  fetch(`${REST_URL}/agentmemory/session/end`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ sessionId }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});

  setTimeout(() => process.exit(0), 1500).unref();
}

main().catch(() => process.exit(0));
