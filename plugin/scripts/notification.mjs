#!/usr/bin/env node
import { execSync } from "node:child_process";
import { basename } from "node:path";
//#region src/hooks/_project.ts
function resolveProject(cwd) {
	const explicit = process.env["AGENTMEMORY_PROJECT_NAME"];
	if (explicit && explicit.trim()) return explicit.trim();
	const dir = cwd && cwd.trim() ? cwd : process.cwd();
	try {
		const top = execSync("git rev-parse --show-toplevel", {
			cwd: dir,
			stdio: [
				"ignore",
				"pipe",
				"ignore"
			],
			timeout: 500
		}).toString().trim();
		if (top) return basename(top);
	} catch {}
	return basename(dir);
}
function hookCwd(data) {
	if (!data || typeof data !== "object") return void 0;
	if (typeof data.cwd === "string" && data.cwd.trim()) return data.cwd;
	const roots = data.workspace_roots;
	if (Array.isArray(roots)) {
		for (const root of roots) if (typeof root === "string" && root.trim()) return root;
	}
	const projectDir = process.env["DEVIN_PROJECT_DIR"] || process.env["CLAUDE_PROJECT_DIR"];
	if (projectDir && projectDir.trim()) return projectDir;
}
//#endregion
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
//#region src/hooks/notification.ts
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
	const notificationType = data.notification_type ?? data.notificationType;
	if (notificationType !== "permission_prompt") return;
	const rawSessionId = [
		data.session_id,
		data.sessionId,
		data.conversation_id
	].find((v) => typeof v === "string" && v.length > 0);
	const sessionId = typeof rawSessionId === "string" ? rawSessionId : "unknown";
	const cwd = hookCwd(data) || process.cwd();
	fetch(`${REST_URL}/agentmemory/observe`, {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify({
			hookType: "notification",
			sessionId,
			project: resolveProject(cwd),
			cwd,
			timestamp: (/* @__PURE__ */ new Date()).toISOString(),
			data: {
				notification_type: notificationType,
				title: data.title,
				message: data.message
			}
		}),
		signal: AbortSignal.timeout(2e3)
	}).catch(() => {});
	setTimeout(() => process.exit(0), 500).unref();
}
main().catch(() => process.exit(0));
//#endregion
export {};

//# sourceMappingURL=notification.mjs.map