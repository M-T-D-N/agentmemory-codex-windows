import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { readCodexThreadIndex } from "../src/functions/codex-source-index.js";
import { readCodexSourceIdentity } from "../src/functions/codex-source-identity.js";
import { registerCodexSourceBacklog } from "../src/functions/codex-source-backlog.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

const sqlite = await import("node:sqlite").catch((error: NodeJS.ErrnoException) => {
  if (error.code === "ERR_UNKNOWN_BUILTIN_MODULE") return null;
  throw error;
});

const roots: Array<{ path: string; parent: string }> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const { path, parent } of roots.splice(0)) {
    const actual = await realpath(path);
    if (!actual.startsWith(parent + sep)) throw Error("Index test cleanup escaped its owned root");
    await rm(actual, { recursive: true, force: true });
  }
});

async function fixture(rows: Array<Record<string, unknown>> = [{}]) {
  const scratch = resolve(".tmp"); await mkdir(scratch, { recursive: true });
  const parent = await realpath(scratch);
  const root = await mkdtemp(join(parent, "codex-index-")); roots.push({ path: root, parent });
  const path = join(root, "state_5.sqlite");
  const db = new sqlite!.DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, source TEXT,
      thread_source TEXT, created_at_ms INTEGER, updated_at_ms INTEGER, archived INTEGER, title TEXT)`);
    const insert = db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const [i, input] of rows.entries()) {
      const row = { id: `s${i}`, rollout_path: join(root, "sessions", `rollout-original_${i}.jsonl`), cwd: root,
        source: "vscode", thread_source: "user", created_at_ms: 1000, updated_at_ms: 2000, archived: 0, ...input };
      insert.run(row.id, row.rollout_path, row.cwd, row.source, row.thread_source, row.created_at_ms,
        row.updated_at_ms, row.archived, "PRIVATE TITLE MUST NOT BE QUERIED");
    }
  } finally { db.close(); }
  return { root, path };
}

describe.skipIf(!sqlite)("read-only Codex source index adapter", () => {
  it("follows the indexed path, retains the indexed ID, and does not read titles or write the index", async () => {
    const { root, path } = await fixture([{ id: "s1" }]);
    const before = await readFile(path);
    await mkdir(join(root, "sessions"));
    const sourcePath = "sessions/rollout-original_0.jsonl";
    await writeFile(join(root, sourcePath), JSON.stringify({ type: "session_meta", payload: {
      id: "s1", cwd: root, source: "vscode", timestamp: "1970-01-01T00:00:01.000Z",
    } }) + "\n");
    const page = await readCodexThreadIndex(root);
    expect(page.entries).toEqual([{ status: "candidate", sessionId: "s1", sourcePath, cwd: process.platform === "win32" ? root.toLowerCase() : root,
      source: "vscode", threadSource: "user", createdAt: "1970-01-01T00:00:01.000Z", updatedAt: "1970-01-01T00:00:02.000Z", archived: false }]);
    expect(page.nextAfterId).toBeNull();
    expect(JSON.stringify(page)).not.toContain("PRIVATE");
    expect((await readCodexSourceIdentity(root, sourcePath, "s1")).sessionId).toBe("s1");
    expect(await readFile(path)).toEqual(before);
  });
  it("paginates by exact ID with a bounded next-page cursor", async () => {
    const { root } = await fixture([{ id: "z" }, { id: "a" }, { id: "m" }]);
    const first = await readCodexThreadIndex(root, { limit: 2 });
    expect(first.entries.map(row => row.sessionId)).toEqual(["a", "m"]);
    expect(first.nextAfterId).toBe("m");
    const second = await readCodexThreadIndex(root, { afterId: first.nextAfterId!, limit: 2 });
    expect(second.entries.map(row => row.sessionId)).toEqual(["z"]);
    expect(second.nextAfterId).toBeNull();
    expect((await readCodexThreadIndex(root, { afterId: "z" })).entries).toEqual([]);
  });
  it("looks up one exact session without substituting a neighboring candidate", async () => {
    const { root, path } = await fixture([{ id: "z" }, { id: "a" }, { id: "m" }]);
    const before = await readFile(path);
    expect((await readCodexThreadIndex(root, { sessionId: "m", limit: 1 })).entries.map(row => row.sessionId)).toEqual(["m"]);
    expect((await readCodexThreadIndex(root, { sessionId: "missing", limit: 1 })).entries).toEqual([]);
    await expect(readCodexThreadIndex(root, { sessionId: "m", afterId: "a" })).rejects.toThrow("bounds");
    expect(await readFile(path)).toEqual(before);
  });
  it("separates subagents and unsupported sources from normal user-owned tasks", async () => {
    const { root } = await fixture([
      { source: '{"subagent":{"spawn":{}}}' }, { thread_source: "subagent" },
      { thread_source: "guardian_review" }, { source: "future-client" }, { thread_source: "future-task" },
      { source: "cli", thread_source: null }, { thread_source: "agent_created_thread" },
      { thread_source: "agent_forked_thread" },
    ]);
    const page = await readCodexThreadIndex(root);
    expect(page.entries.map(row => row.status)).toEqual(["excluded", "excluded", "excluded", "unknown", "unknown", "candidate", "candidate", "candidate"]);
  });
  it("does not equate index candidates with readable or reconciled originals", async () => {
    const { root } = await fixture([{ thread_source: "agent_forked_thread" }]);
    const page = await readCodexThreadIndex(root);
    expect(page.entries[0].status).toBe("candidate");
    await expect(readCodexSourceIdentity(root, "sessions/rollout-original_0.jsonl", "s0")).rejects.toThrow();
  });
  it("keeps invalid paths and metadata visible as unknown rather than silently dropping them", async () => {
    const { root } = await fixture([
      { rollout_path: "C:/outside/sessions/rollout-other.jsonl" }, { cwd: "relative" },
      { created_at_ms: -1 }, { updated_at_ms: 500 }, { archived: 2 },
    ]);
    expect((await readCodexThreadIndex(root)).entries.map(row => row.status)).toEqual(Array(5).fill("unknown"));
  });
  it("does not silently use an old index when a newer index version exists", async () => {
    const { root } = await fixture();
    await writeFile(join(root, "state_6.sqlite"), "unsupported");
    await expect(readCodexThreadIndex(root)).rejects.toThrow("version");
  });
  it("rejects incompatible schemas and invalid session IDs", async () => {
    const { root, path } = await fixture([{ id: " bad " }]);
    await expect(readCodexThreadIndex(root)).rejects.toThrow("identifier");
    const db = new sqlite!.DatabaseSync(path);
    try { db.exec("DROP TABLE threads; CREATE VIEW threads AS SELECT 1 AS id"); } finally { db.close(); }
    await expect(readCodexThreadIndex(root)).rejects.toThrow("schema");
  });
  it("does not silently omit an empty identifier at the first page boundary", async () => {
    const { root } = await fixture([{ id: "" }]);
    await expect(readCodexThreadIndex(root)).rejects.toThrow("identifier");
  });
  it("exposes the source read through iii using only the managed source root and no state writes", async () => {
    const { root } = await fixture();
    vi.stubEnv("AGENTMEMORY_CODEX_SOURCE_ROOT", root);
    const sdk = mockSdk(), kv = mockKV();
    const set = vi.spyOn(kv, "set"), remove = vi.spyOn(kv, "delete");
    registerCodexSourceBacklog(sdk as never, kv as never, () => "mine");
    const result = await sdk.trigger("mem::codex-source-index", { sourceRoot: "C:/untrusted", limit: 1 });
    expect(result).toMatchObject({ entries: [{ status: "candidate", sessionId: "s0" }], nextAfterId: null });
    expect(set).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    vi.stubEnv("AGENTMEMORY_CODEX_SOURCE_ROOT", "");
    expect(await sdk.trigger("mem::codex-source-index", {})).toEqual({ disabled: true });
  });
  it("rejects a linked source root", async () => {
    const { root } = await fixture();
    const { root: owner } = await fixture();
    const link = join(owner, "linked");
    await symlink(root, link, "junction");
    await expect(readCodexThreadIndex(link)).rejects.toThrow("Linked");
  });
  it("reads committed WAL rows without requiring a checkpoint", async () => {
    const { root, path } = await fixture();
    const writer = new sqlite!.DatabaseSync(path);
    try {
      writer.exec("PRAGMA journal_mode = WAL");
      writer.prepare("UPDATE threads SET updated_at_ms = ?").run(9000);
      const before = await readFile(path);
      expect((await readCodexThreadIndex(root)).entries[0]).toMatchObject({ updatedAt: "1970-01-01T00:00:09.000Z" });
      expect(await readFile(path)).toEqual(before);
    } finally { writer.close(); }
  });
  it("reports a locked index instead of returning empty coverage", async () => {
    const { root, path } = await fixture();
    const writer = new sqlite!.DatabaseSync(path);
    try {
      writer.exec("BEGIN EXCLUSIVE");
      await expect(readCodexThreadIndex(root)).rejects.toThrow(/locked|busy/i);
    } finally { writer.exec("ROLLBACK"); writer.close(); }
  });
  it("validates bounds before source access", async () => {
    for (const input of [{ limit: 0 }, { limit: 501 }, { limit: 1.5 }, { afterId: "*" }, { afterId: " " }]) {
      await expect(readCodexThreadIndex(resolve("absent-native"), input)).rejects.toThrow("bounds");
    }
  });
});
