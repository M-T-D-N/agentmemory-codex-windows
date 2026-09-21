import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, parse, posix, relative, resolve, sep, win32 } from "node:path";
import { withCodexSourceSegments, type CodexSourceFile } from "./codex-source-segments.js";

export interface CodexSourceIdentity {
  sessionId: string;
  cwd: string;
  createdAt: string;
  source: "cli" | "vscode";
  relativePath: string;
  fork?: { parentSessionId: string; endOrdinalExclusive: number; endByteOffset: number };
  continuation?: { endOrdinalExclusive: number; endByteOffset: number; sourcePath?: string };
}

export function validateCodexFork(value: unknown, sessionId: string): NonNullable<CodexSourceIdentity["fork"]> {
  const fork = record(value);
  if (!fork || Object.keys(fork).sort().join(",") !== "endByteOffset,endOrdinalExclusive,parentSessionId" ||
      typeof fork.parentSessionId !== "string" || !fork.parentSessionId || fork.parentSessionId.trim() !== fork.parentSessionId ||
      fork.parentSessionId.length > 512 || fork.parentSessionId === "*" || fork.parentSessionId === sessionId ||
      !Number.isSafeInteger(fork.endOrdinalExclusive) || (fork.endOrdinalExclusive as number) < 0 ||
      !Number.isSafeInteger(fork.endByteOffset) || (fork.endByteOffset as number) < 0 ||
      (fork.endOrdinalExclusive === 0) !== (fork.endByteOffset === 0)) throw Error("Invalid Codex fork history reference");
  return { parentSessionId: fork.parentSessionId, endOrdinalExclusive: fork.endOrdinalExclusive as number, endByteOffset: fork.endByteOffset as number };
}

export function validateCodexContinuation(value: unknown): NonNullable<CodexSourceIdentity["continuation"]> {
  const reference = record(value);
  if (!reference || Object.keys(reference).some(key => !["endOrdinalExclusive", "endByteOffset", "sourcePath"].includes(key)) ||
      !Number.isSafeInteger(reference.endOrdinalExclusive) || (reference.endOrdinalExclusive as number) < 1 ||
      !Number.isSafeInteger(reference.endByteOffset) || (reference.endByteOffset as number) < 1) {
    throw Error("Invalid Codex continuation reference");
  }
  if (reference.sourcePath !== undefined) {
    if (typeof reference.sourcePath !== "string" || reference.sourcePath.length > 2048 ||
        !/^(sessions|archived_sessions)[\\/]/.test(reference.sourcePath) ||
        reference.sourcePath.split(/[\\/]/).some(part => !part || part === "." || part === ".." || /[:\0]/.test(part)) ||
        !/^rollout-[^/\\]+\.jsonl$/.test(reference.sourcePath.split(/[\\/]/).at(-1)!)) {
      throw Error("Invalid Codex continuation source path");
    }
  }
  return { endOrdinalExclusive: reference.endOrdinalExclusive as number, endByteOffset: reference.endByteOffset as number,
    ...(reference.sourcePath !== undefined ? { sourcePath: reference.sourcePath as string } : {}) };
}

export function canonicalCodexCwd(value: string): string {
  if (/^\\\\\?\\UNC\\/i.test(value)) value = "\\\\" + value.slice(8);
  else if (/^\\\\\?\\[a-z]:\\/i.test(value)) value = value.slice(4);
  if (/^\\\\[?.]\\/.test(value) || value.includes("\0")) throw new Error("Unsupported Codex working directory namespace");
  if (/^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(value)) {
    const normalized = win32.normalize(value);
    return (normalized.length > win32.parse(normalized).root.length
      ? normalized.replace(/[\\/]+$/, "") : normalized).toLowerCase();
  }
  if (value.startsWith("/")) return posix.resolve(value);
  throw new Error("Codex working directory must be absolute");
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function parseCodexSourceIdentity(
  value: unknown, sessionId: string, relativePath: string,
): CodexSourceIdentity {
  const envelope = record(value);
  const payload = record(envelope?.payload);
  if (envelope?.type !== "session_meta" || payload?.id !== sessionId) {
    throw new Error("Codex source session identity does not match");
  }
  if (payload.session_id !== undefined && payload.session_id !== sessionId) throw Error("Codex source session identity does not match");
  if (payload.source !== "cli" && payload.source !== "vscode") {
    throw new Error("Unsupported or non-main Codex source");
  }
  let fork: CodexSourceIdentity["fork"], continuation: CodexSourceIdentity["continuation"];
  if (payload.forked_from_id !== undefined && payload.forked_from_id !== null) {
    const base = record(payload.history_base);
    if (payload.history_mode !== "paginated" || payload.session_id !== sessionId || !base ||
        Object.keys(base).sort().join(",") !== "end_byte_offset,end_ordinal_exclusive,thread_id" ||
        base.thread_id !== payload.forked_from_id || base.end_ordinal_exclusive !== payload.forked_from_ordinal_exclusive) {
      throw new Error("Forked Codex sources require explicit paginated inherited-history references");
    }
    fork = validateCodexFork({ parentSessionId: base.thread_id, endOrdinalExclusive: base.end_ordinal_exclusive,
      endByteOffset: base.end_byte_offset }, sessionId);
  } else if (payload.history_base !== undefined && payload.history_base !== null) {
    const base = record(payload.history_base);
    if (payload.history_mode !== "paginated" || payload.session_id !== sessionId || !base || base.thread_id !== sessionId ||
        Object.keys(base).sort().join(",") !== "end_byte_offset,end_ordinal_exclusive,thread_id" ||
        !Number.isSafeInteger(base.end_ordinal_exclusive) || (base.end_ordinal_exclusive as number) < 1 ||
        !Number.isSafeInteger(base.end_byte_offset) || (base.end_byte_offset as number) < 1) {
      throw Error("Continued Codex sources require explicit prior-segment boundaries");
    }
    continuation = { endOrdinalExclusive: base.end_ordinal_exclusive as number, endByteOffset: base.end_byte_offset as number };
  }
  if (typeof payload.cwd !== "string" || !payload.cwd.trim() ||
      typeof payload.timestamp !== "string" || !Number.isFinite(Date.parse(payload.timestamp))) {
    throw new Error("Incomplete Codex source identity");
  }
  canonicalCodexCwd(payload.cwd);
  return { sessionId, cwd: payload.cwd, createdAt: payload.timestamp,
    source: payload.source, relativePath, ...(fork ? { fork } : {}), ...(continuation ? { continuation } : {}) };
}

export async function rejectLinkedComponents(path: string): Promise<void> {
  let current = parse(path).root;
  for (const component of relative(current, path).split(sep).filter(Boolean)) {
    current = join(current, component);
    if ((await lstat(current)).isSymbolicLink()) {
      throw new Error("Linked Codex source paths are not allowed");
    }
  }
}

export function codexSourceRelativePath(sourceRoot: string, absolutePath: string): string {
  const root = canonicalCodexCwd(sourceRoot);
  const path = canonicalCodexCwd(absolutePath);
  const flavor = /^[a-z]:\\|^\\\\/i.test(root) ? win32 : posix;
  const segments = flavor.relative(root, path).split(/[\\/]/);
  if (!['sessions', 'archived_sessions'].includes(segments[0]) ||
      segments.some(part => !part || part === "." || part === ".." || part.includes(":")) ||
      !/^rollout-[^/\\]+\.jsonl$/.test(segments.at(-1) ?? "")) {
    throw new Error("Codex source path is outside the supported history directories");
  }
  return segments.join("/");
}

export async function withReadOnlyCodexSource<T>(
  sourceRoot: string, relativePath: string, sessionId: string,
  read: (source: CodexSourceIdentity, file: CodexSourceFile) => Promise<T>,
): Promise<T> {
  return withCodexSourceSegments(sourceRoot, relativePath, sessionId, withReadOnlyCodexPhysicalSource, read);
}

export async function withReadOnlyCodexPhysicalSource<T>(
  sourceRoot: string, relativePath: string, sessionId: string,
  read: (source: CodexSourceIdentity, file: FileHandle, headerBytes: number) => Promise<T>,
): Promise<T> {
  if (!sourceRoot || !isAbsolute(sourceRoot)) throw new Error("Codex source root is not configured");
  if (typeof relativePath !== "string" || relativePath.includes("\0") ||
      isAbsolute(relativePath) || win32.isAbsolute(relativePath)) {
    throw new Error("Codex source path must be relative");
  }
  const segments = relativePath.split(/[\\/]/);
  if (!['sessions', 'archived_sessions'].includes(segments[0]) ||
      segments.some(part => !part || part === "." || part === ".." || part.includes(":")) ||
      !/^rollout-[^/\\]+\.jsonl$/.test(segments.at(-1) ?? "")) {
    throw new Error("Codex source path is outside the supported history directories");
  }
  const root = resolve(sourceRoot);
  const path = resolve(root, ...segments);
  if (relative(root, path).startsWith(".." + sep)) throw new Error("Codex source path escapes its root");
  await rejectLinkedComponents(path);
  if (canonicalCodexCwd(await realpath(path)) !== canonicalCodexCwd(path)) throw new Error("Codex source path identity changed");
  const file = await open(path, "r");
  try {
    const identity = await file.stat();
    if (!identity.isFile()) throw new Error("Codex source is not a regular file");
    const maximumHeaderBytes = 2 * 1024 * 1024;
    const bytes = Buffer.alloc(Math.min(identity.size, maximumHeaderBytes));
    let count = 0;
    let end = -1;
    while (count < bytes.length && end === -1) {
      const result = await file.read(bytes, count, Math.min(64 * 1024, bytes.length - count), count);
      if (result.bytesRead === 0) break;
      end = bytes.indexOf(10, count);
      count += result.bytesRead;
      if (end >= count) end = -1;
    }
    if (end === -1) throw new Error("Codex metadata is incomplete or exceeds the supported header size");
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end)).replace(/^\uFEFF/, ""));
    const source = parseCodexSourceIdentity(parsed, sessionId, segments.join("/"));
    const result = await read(source, file, end + 1);
    await rejectLinkedComponents(path);
    if (canonicalCodexCwd(await realpath(path)) !== canonicalCodexCwd(path)) throw new Error("Codex source path identity changed");
    const current = await lstat(path);
    if (current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) {
      throw new Error("Codex source file changed while reading identity");
    }
    return result;
  } finally {
    await file.close();
  }
}

export async function readCodexSourceIdentity(
  sourceRoot: string, relativePath: string, sessionId: string,
): Promise<CodexSourceIdentity> {
  return withReadOnlyCodexSource(sourceRoot, relativePath, sessionId, async source => source);
}
