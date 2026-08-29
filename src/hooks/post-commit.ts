#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hookCwd } from "./_project.js";
import { REST_URL, authHeaders, isSdkChildContext } from "./_runtime.js";

const exec = promisify(execFile);

const TIMEOUT_MS = 1500;

async function git(args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", args, { cwd, timeout: 1500 });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let data: Record<string, unknown> = {};
  if (input.trim()) {
    try {
      data = JSON.parse(input);
    } catch {
      // Direct invocation from .git/hooks/post-commit may pass no stdin.
    }
  }

  if (!data || typeof data !== "object") data = {};
  if (isSdkChildContext(data)) return;

  const cwd =
    hookCwd(data) || process.env["AGENTMEMORY_CWD"] || process.cwd();
  const sessionId =
    (data.session_id as string) ||
    process.env["AGENTMEMORY_SESSION_ID"] ||
    undefined;

  const sha =
    process.env["AGENTMEMORY_COMMIT_SHA"] ||
    (await git(["rev-parse", "HEAD"], cwd));
  if (!sha) return;

  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const repo = await git(["config", "--get", "remote.origin.url"], cwd);
  const message = await git(["log", "-1", "--pretty=%B", sha], cwd);
  const author = await git(["log", "-1", "--pretty=%an <%ae>", sha], cwd);
  const authoredAt = await git(["log", "-1", "--pretty=%aI", sha], cwd);
  const filesRaw = await git(
    ["diff-tree", "--no-commit-id", "--name-only", "-r", sha],
    cwd,
  );
  const files = filesRaw ? filesRaw.split("\n").filter(Boolean) : undefined;

  const body = {
    sessionId,
    sha,
    branch: branch || undefined,
    repo: repo || undefined,
    message: message || undefined,
    author: author || undefined,
    authoredAt: authoredAt || undefined,
    files,
  };

  try {
    await fetch(`${REST_URL}/agentmemory/session/commit`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // best-effort
  }
}

main().catch(() => process.exit(0));
