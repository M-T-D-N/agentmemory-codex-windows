#!/usr/bin/env node
//#region src/hooks/sdk-guard.ts
/**
* Recursion guard shared by every hook script.
*
* A Claude Code session spawned via @anthropic-ai/claude-agent-sdk inherits
* the same plugin hooks as the parent CC session. If any hook script in that
* child session calls back into /agentmemory/* (e.g. Stop → /summarize →
* provider.summarize() → another child session), we get unbounded recursion
* that burns tokens and fills .claude/projects/ with ghost sessions
* (#149 follow-up; see reported loop under v0.9.1).
*
* Two signals identify a SDK-child context:
*   1. AGENTMEMORY_SDK_CHILD=1 env var — set by our agent-sdk provider
*      before it spawns `query()`. Inherited by child processes.
*   2. payload.entrypoint === "sdk-ts" — CC writes this into the hook
*      stdin jsonl when the session was spawned by the Agent SDK.
*
* Hook scripts must call isSdkChildContext(payload) EARLY and return
* silently when it is true.
*/
function isSdkChildContext(payload) {
	if (process.env.AGENTMEMORY_SDK_CHILD === "1") return true;
	if (!payload || typeof payload !== "object") return false;
	if (payload["entrypoint"] === "sdk-ts") return true;
	return false;
}
//#endregion
//#region src/hooks/_runtime.ts
const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";
function authHeaders() {
	const headers = { "Content-Type": "application/json" };
	if (SECRET) headers["Authorization"] = `Bearer ${SECRET}`;
	return headers;
}
//#endregion
//#region src/hooks/stop.ts
async function main() {
	let input = "";
	for await (const chunk of process.stdin) input += chunk;
	let data;
	try {
		data = JSON.parse(input);
	} catch {
		return;
	}
	if (!data || typeof data !== "object") return;
	if (isSdkChildContext(data)) return;
	const sessionId = data.session_id || data.sessionId || data.conversation_id || "unknown";
	fetch(`${REST_URL}/agentmemory/session/end`, {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify({ sessionId }),
		signal: AbortSignal.timeout(5e3)
	}).catch(() => {});
	setTimeout(() => process.exit(0), 1500).unref();
}
main().catch(() => process.exit(0));
//#endregion
export {};

//# sourceMappingURL=stop.mjs.map