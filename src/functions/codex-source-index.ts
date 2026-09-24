import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { canonicalCodexCwd, codexSourceRelativePath, parseCodexSourceIdentity, rejectLinkedComponents, withReadOnlyCodexPhysicalSource } from "./codex-source-identity.js";

export interface CodexThreadCandidate {
  status: "candidate";
  sessionId: string;
  sourcePath: string;
  cwd: string;
  source: "cli" | "vscode";
  threadSource: string | null;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  hasConversationEvidence?: boolean;
}

export type CodexThreadIndexEntry = CodexThreadCandidate | {
  sessionId: string;
  status: "excluded" | "unknown";
  reason: string;
};

const identifier = (value: unknown): value is string => typeof value === "string" &&
  value.length > 0 && value.length <= 512 && value.trim() === value && value !== "*" && !/[\x00-\x1f]/.test(value);
const timestamp = (value: unknown): value is number => typeof value === "number" &&
  Number.isSafeInteger(value) && value >= 0 && Number.isFinite(new Date(value).getTime());

function classifyThread(row: Record<string, unknown>, sourceRoot: string): CodexThreadIndexEntry {
  if (!identifier(row.id)) throw Error("Codex thread index contains an invalid session identifier");
  const sessionId = row.id;
  const unknown = (reason: string): CodexThreadIndexEntry => ({ sessionId, status: "unknown", reason });
  if (row.source !== "cli" && row.source !== "vscode") {
    let source: unknown;
    try { source = typeof row.source === "string" ? JSON.parse(row.source) : null; } catch { /* Unknown host source. */ }
    if (source && typeof source === "object" && !Array.isArray(source) && Object.hasOwn(source, "subagent")) {
      return { sessionId, status: "excluded", reason: "subagent_source" };
    }
    return unknown("unsupported_source");
  }
  if (["subagent", "guardian_review"].includes(String(row.thread_source))) {
    return { sessionId, status: "excluded", reason: "internal_thread_source" };
  }
  if (row.thread_source !== null && !["user", "agent_created_thread", "agent_forked_thread"].includes(String(row.thread_source))) {
    return unknown("unsupported_thread_source");
  }
  if (!timestamp(row.created_at_ms) || !timestamp(row.updated_at_ms) || row.updated_at_ms < row.created_at_ms ||
      ![0, 1].includes(row.archived as number)) return unknown("invalid_thread_metadata");
  if (typeof row.rollout_path !== "string" || typeof row.cwd !== "string") return unknown("invalid_thread_path");
  let sourcePath: string, cwd: string;
  try { sourcePath = codexSourceRelativePath(sourceRoot, row.rollout_path); cwd = canonicalCodexCwd(row.cwd); }
  catch { return unknown("invalid_thread_path"); }
  return { status: "candidate", sessionId, sourcePath, cwd, source: row.source,
    threadSource: row.thread_source as string | null, createdAt: new Date(row.created_at_ms).toISOString(),
    updatedAt: new Date(row.updated_at_ms).toISOString(), archived: row.archived === 1,
    ...([0, 1].includes(row.has_conversation_evidence as number) ? { hasConversationEvidence: row.has_conversation_evidence === 1 } : {}) };
}

async function classifyIndexedThread(row: Record<string, unknown>, root: string): Promise<CodexThreadIndexEntry> {
  const classified = classifyThread(row, root);
  if (classified.status !== "unknown" || row.source !== "unknown" || typeof row.cwd !== "string" || row.thread_source !== null ||
      ![0, 1].includes(row.archived as number) || !timestamp(row.created_at_ms) || !timestamp(row.updated_at_ms)) return classified;
  try {
    const relativePath = codexSourceRelativePath(root, row.rollout_path as string);
    return await withReadOnlyCodexPhysicalSource(root, relativePath, classified.sessionId, async (source, file, headerBytes) => {
      const bytes = Buffer.alloc(headerBytes);
      const { bytesRead } = await file.read(bytes, 0, headerBytes, 0);
      if (bytesRead !== headerBytes) throw Error("Source metadata changed while reading");
      const header = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, ""));
      if (!isDeepStrictEqual(parseCodexSourceIdentity(header, classified.sessionId, relativePath), source)) throw Error("Source metadata changed while reading");
      if (row.cwd !== "" && canonicalCodexCwd(row.cwd as string) !== canonicalCodexCwd(source.cwd)) return classified;
      const threadSource = header.payload?.thread_source;
      if (["subagent", "guardian_review"].includes(threadSource)) return { sessionId: source.sessionId, status: "excluded", reason: "internal_thread_source" };
      if (!["user", "agent_created_thread", "agent_forked_thread"].includes(threadSource)) return classified;
      return { status: "candidate", sessionId: source.sessionId, sourcePath: source.relativePath,
        cwd: canonicalCodexCwd(source.cwd), source: source.source, threadSource, createdAt: source.createdAt,
        updatedAt: new Date(Math.max(Date.parse(source.createdAt), row.updated_at_ms as number)).toISOString(), archived: row.archived === 1 };
    });
  } catch { return classified; }
}

/** A bounded view of Codex's source index; candidates are not ownership or capture authorization. */
export async function readCodexThreadIndex(sourceRoot: string, input: { afterId?: string; sessionId?: string; limit?: number } = {}) {
  if (!sourceRoot || !isAbsolute(sourceRoot)) throw Error("Codex source root is not configured");
  const limit = input.limit ?? 200;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 ||
      (input.afterId !== undefined && !identifier(input.afterId)) ||
      (input.sessionId !== undefined && (!identifier(input.sessionId) || input.afterId !== undefined))) throw Error("Invalid Codex thread index bounds");
  const root = resolve(sourceRoot);
  await rejectLinkedComponents(root);
  const versions = (await readdir(root)).flatMap(name => {
    const match = /^state_(\d+)\.sqlite$/i.exec(name);
    return match ? [Number(match[1])] : [];
  });
  if (!versions.includes(5) || versions.some(version => version > 5)) throw Error("Unsupported or missing Codex thread index version");
  const path = join(root, "state_5.sqlite");
  await rejectLinkedComponents(path);
  const before = await lstat(path);
  if (!before.isFile()) throw Error("Codex thread index is not a regular file");
  const verifyPath = async () => {
    await rejectLinkedComponents(path);
    if (canonicalCodexCwd(await realpath(path)) !== canonicalCodexCwd(path)) throw Error("Codex thread index path changed");
    const after = await lstat(path);
    if (before.dev !== after.dev || before.ino !== after.ino) throw Error("Codex thread index was replaced");
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      const sidecar = await lstat(path + suffix).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (sidecar && (!sidecar.isFile() || sidecar.isSymbolicLink())) throw Error("Linked or non-file Codex index sidecar");
    }
  };
  await verifyPath();
  const { DatabaseSync } = await import("node:sqlite").catch(() => {
    throw Error("Native Codex discovery requires a Node.js runtime with node:sqlite");
  });
  const db = new DatabaseSync(path, { readOnly: true, allowExtension: false, timeout: 250 });
  let rows: Record<string, unknown>[];
  try {
    db.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF");
    const table = db.prepare("SELECT type FROM sqlite_schema WHERE name = 'threads'").get();
    if (table?.type !== "table") throw Error("Unsupported Codex thread index schema");
    const columns = db.prepare("PRAGMA table_info(threads)").all();
    if (!columns.some(column => column.name === "id" && column.type === "TEXT" && column.pk === 1) ||
        columns.some(column => column.name !== "id" && column.pk !== 0)) throw Error("Unsupported Codex thread index identity schema");
    const hasEvidenceColumns = ["has_user_event", "tokens_used", "first_user_message"].every(name => columns.some(column => column.name === name));
    const evidence = hasEvidenceColumns ? ", CASE WHEN has_user_event = 0 AND tokens_used = 0 AND first_user_message = '' THEN 0 WHEN has_user_event = 1 OR tokens_used > 0 OR length(first_user_message) > 0 THEN 1 ELSE NULL END AS has_conversation_evidence" : "";
    rows = db.prepare(`SELECT id, rollout_path, cwd, source, thread_source, created_at_ms, updated_at_ms, archived${evidence}
      FROM threads WHERE (? IS NULL OR id = ?) AND (? IS NULL OR id > ?) ORDER BY id LIMIT ?`)
      .all(input.sessionId ?? null, input.sessionId ?? null, input.afterId ?? null, input.afterId ?? null, limit + 1);
  } finally { db.close(); }
  await verifyPath();
  const hasMore = rows.length > limit;
  const entries: CodexThreadIndexEntry[] = [];
  for (const row of rows.slice(0, limit)) entries.push(await classifyIndexedThread(row, root));
  return { version: 5 as const, checkedAt: new Date().toISOString(), entries,
    nextAfterId: hasMore ? entries.at(-1)!.sessionId : null };
}
