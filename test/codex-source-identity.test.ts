import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalCodexCwd, codexSourceRelativePath, parseCodexSourceIdentity, readCodexSourceIdentity } from "../src/functions/codex-source-identity.js";
import { codexSessionForTransfer } from "../src/replay/codex-capture-state.js";
import type { Session } from "../src/types.js";

const header = { type: "session_meta", payload: { id: "session-a", cwd: "C:/work/a",
  timestamp: "2026-09-07T08:14:02Z", source: "vscode", base_instructions: "untrusted text" } };
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(content: string) {
  const root = await mkdtemp(join(tmpdir(), "agentmemory-codex-identity-"));
  roots.push(root);
  await mkdir(join(root, "sessions"));
  const relative = "sessions/rollout-session-a.jsonl";
  await writeFile(join(root, relative), content);
  return { root, relative };
}

describe("read-only native Codex ownership evidence", () => {
  it("normalizes fully qualified Windows paths while preserving POSIX case", () => {
    expect(canonicalCodexCwd("C:/Work/A/" )).toBe("c:\\work\\a");
    expect(canonicalCodexCwd("C:/")).toBe("c:\\");
    expect(canonicalCodexCwd("\\\\?\\C:\\Work\\A\\")).toBe("c:\\work\\a");
    expect(canonicalCodexCwd("\\\\?\\UNC\\Host\\Share\\Work")).toBe("\\\\host\\share\\work");
    expect(canonicalCodexCwd("/Work/A/../B")).toBe("/Work/B");
    for (const value of ["C:work", "\\work", "work"]) expect(() => canonicalCodexCwd(value)).toThrow("absolute");
    for (const value of ["\\\\?\\GLOBALROOT\\Device", "\\\\.\\C:\\Work", "C:/Work\0suffix"]) expect(() => canonicalCodexCwd(value)).toThrow("namespace");
  });
  it("resolves the indexed source path without guessing identity from a filename", () => {
    expect(codexSourceRelativePath("C:/Native", "\\\\?\\C:\\Native\\sessions\\rollout-parent_child.jsonl"))
      .toBe("sessions/rollout-parent_child.jsonl");
    expect(codexSourceRelativePath("/Native", "/Native/archived_sessions/rollout-A.jsonl"))
      .toBe("archived_sessions/rollout-A.jsonl");
    for (const path of ["C:/Native2/sessions/rollout-a.jsonl", "C:/Native/config.toml", "D:/Native/sessions/rollout-a.jsonl"]) {
      expect(() => codexSourceRelativePath("C:/Native", path)).toThrow();
    }
  });
  it("keeps only identity metadata from a supported main session", async () => {
    const { root, relative } = await fixture(JSON.stringify(header) + "\nnot a parsed transcript\n");
    const identity = await readCodexSourceIdentity(root, relative, "session-a");
    expect(identity).toEqual({ sessionId: "session-a", cwd: "C:/work/a", createdAt: header.payload.timestamp,
      source: "vscode", relativePath: relative });
  });
  it.each(["cli", "vscode"])("accepts normal %s sources", source => {
    expect(parseCodexSourceIdentity({ ...header, payload: { ...header.payload, source } }, "session-a", "source").source).toBe(source);
  });
  it.each([{ subagent: "review" }, "unknown", null])("rejects non-main or unknown source %j", source => {
    expect(() => parseCodexSourceIdentity({ ...header, payload: { ...header.payload, source } }, "session-a", "source"))
      .toThrow("Unsupported or non-main");
  });
  it("refuses mismatched and inherited fork identity", () => {
    expect(() => parseCodexSourceIdentity(header, "other", "source")).toThrow("does not match");
    expect(() => parseCodexSourceIdentity({ ...header, payload: { ...header.payload, forked_from_id: "parent" } }, "session-a", "source"))
      .toThrow("Forked");
  });
  it("preserves a verified capture cwd in transfer but requires fresh native reconciliation", () => {
    const source = parseCodexSourceIdentity(header, "session-a", "sessions/rollout-a.jsonl");
    const session: Session = { id: "session-a", project: "same-project", cwd: "C:/work/later", startedAt: source.createdAt,
      status: "active", observationCount: 1, codexNativeCapture: { version: 1, source,
        captureCwd: "c:\\work\\later", initializedAt: source.createdAt, status: "caught_up" } };
    const transferred = codexSessionForTransfer(session);
    expect(transferred).toMatchObject({ project: session.project, cwd: session.cwd, codexNativeCapture: {
      source, captureCwd: "c:\\work\\later", status: "reconcile_required", indexPending: true,
    } });
    expect(transferred.codexNativeCapture).not.toHaveProperty("cursor");
    for (const captureCwd of [undefined, "C:/other", "relative"]) {
      expect(() => codexSessionForTransfer({ ...session, codexNativeCapture: { ...session.codexNativeCapture!, captureCwd } })).toThrow();
    }
    expect(() => codexSessionForTransfer({ ...session, codexNativeCapture: { ...session.codexNativeCapture!,
      source: { ...source, cwd: "relative" } } })).toThrow();
  });
  it("preserves an explicit paginated fork reference through native session transfer", () => {
    const value = { ...header, payload: { ...header.payload, session_id: "session-a", history_mode: "paginated",
      forked_from_id: "parent-a", forked_from_ordinal_exclusive: 12,
      history_base: { thread_id: "parent-a", end_ordinal_exclusive: 12, end_byte_offset: 1200 } } };
    const source = parseCodexSourceIdentity(value, "session-a", "sessions/rollout-child.jsonl");
    expect(source.fork).toEqual({ parentSessionId: "parent-a", endOrdinalExclusive: 12, endByteOffset: 1200 });
    const session = { id: "session-a", project: "p", cwd: source.cwd, startedAt: source.createdAt, status: "active" as const,
      observationCount: 0, codexNativeCapture: { version: 1 as const, source, initializedAt: source.createdAt, status: "pending" as const } };
    expect(codexSessionForTransfer(session).codexNativeCapture).toMatchObject({ source, status: "reconcile_required" });
    expect(() => codexSessionForTransfer({ ...session, codexNativeCapture: { ...session.codexNativeCapture,
      source: { ...source, fork: { ...source.fork!, parentSessionId: "session-a" } } } })).toThrow("fork history");
    for (const change of [{ history_mode: "copied" }, { forked_from_id: "other-parent" }, { forked_from_ordinal_exclusive: 13 },
      { session_id: "other-child" }]) {
      expect(() => parseCodexSourceIdentity({ ...value, payload: { ...value.payload, ...change } }, "session-a", "source")).toThrow();
    }
  });
  it("does not mistake a continuation referencing the same task's earlier file for a complete standalone source", () => {
    expect(() => parseCodexSourceIdentity({ ...header, payload: { ...header.payload, history_mode: "paginated",
      history_base: { thread_id: "session-a", end_ordinal_exclusive: 12, end_byte_offset: 1200 } } }, "session-a", "source"))
      .toThrow("prior-segment boundaries");
  });
  it("does not treat an incomplete header as complete evidence", async () => {
    const { root, relative } = await fixture(JSON.stringify(header));
    await expect(readCodexSourceIdentity(root, relative, "session-a")).rejects.toThrow("incomplete");
  });
  it("rejects absolute paths, traversal and unrelated native files", async () => {
    const { root, relative } = await fixture(JSON.stringify(header) + "\n");
    for (const path of [join(root, relative), "C:/outside.jsonl", "sessions/../rollout-a.jsonl", "config.toml", "sessions/C:rollout-a.jsonl"]) {
      await expect(readCodexSourceIdentity(root, path, "session-a")).rejects.toThrow();
    }
  });
  it("rejects a directory junction instead of following it into another source", async () => {
    const original = await fixture(JSON.stringify(header) + "\n");
    const linked = await mkdtemp(join(tmpdir(), "agentmemory-codex-link-"));
    roots.push(linked);
    await symlink(join(original.root, "sessions"), join(linked, "sessions"), "junction");
    await expect(readCodexSourceIdentity(linked, original.relative, "session-a")).rejects.toThrow("Linked");
  });
});
