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
//#region src/hooks/pre-tool-use.ts
const INJECT_CONTEXT = process.env["AGENTMEMORY_INJECT_CONTEXT"] === "true";
async function main() {
	if (!INJECT_CONTEXT) return;
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
	const toolName = typeof data.tool_name === "string" ? data.tool_name : typeof data.toolName === "string" ? data.toolName : void 0;
	if (!toolName) return;
	const normalizedToolName = toolName.toLowerCase();
	if (![
		"edit",
		"write",
		"create",
		"read",
		"view",
		"glob",
		"grep"
	].includes(normalizedToolName)) return;
	const rawToolInput = data.tool_input ?? data.toolArgs;
	const toolInput = typeof rawToolInput === "object" && rawToolInput !== null && !Array.isArray(rawToolInput) ? rawToolInput : {};
	const files = [];
	const fileKeys = normalizedToolName === "grep" ? ["path", "file"] : [
		"file_path",
		"path",
		"file",
		"pattern"
	];
	for (const key of fileKeys) {
		const val = toolInput[key];
		if (typeof val === "string" && val.length > 0) files.push(val);
	}
	if (files.length === 0) return;
	const terms = [];
	if (normalizedToolName === "grep" || normalizedToolName === "glob") {
		const pattern = toolInput["pattern"];
		if (typeof pattern === "string" && pattern.length > 0) terms.push(pattern);
	}
	const rawSessionId = data.session_id || data.sessionId || data.conversation_id;
	const sessionId = typeof rawSessionId === "string" && rawSessionId.length > 0 ? rawSessionId : "unknown";
	const project = typeof data.project === "string" && data.project.trim().length > 0 ? data.project.trim() : void 0;
	try {
		const res = await fetch(`${REST_URL}/agentmemory/enrich`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({
				sessionId,
				files,
				terms,
				toolName,
				...project !== void 0 && { project }
			}),
			signal: AbortSignal.timeout(2e3)
		});
		if (res.ok) {
			const result = await res.json();
			if (result.context) process.stdout.write(result.context);
		}
	} catch {}
}
main().catch(() => process.exit(0));
//#endregion
export {};

//# sourceMappingURL=pre-tool-use.mjs.map