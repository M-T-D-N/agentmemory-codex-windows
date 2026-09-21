import { createHash } from "node:crypto";
import { readdir, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { Stats } from "node:fs";
import type { CodexSourceIdentity } from "./codex-source-identity.js";

export interface CodexSourceFile {
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number; buffer: Buffer }>;
  stat(): Promise<Pick<Stats, "dev" | "ino" | "size" | "mtimeMs"> & { identity?: string }>;
}

export type CodexPhysicalReader = <T>(root: string, path: string, sessionId: string,
  read: (source: CodexSourceIdentity, file: FileHandle, headerBytes: number) => Promise<T>) => Promise<T>;

const verifiedPrefixes = new Map<string, boolean>();
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function codexSourceCandidatePaths(root: string, sessionId: string) {
  const paths: string[] = [];
  const pending = ["sessions", "archived_sessions"];
  let count = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    const entries = await readdir(join(root, directory), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" && ["sessions", "archived_sessions"].includes(directory)) return [];
      throw error;
    });
    for (const entry of entries) {
      if (++count > 100_000) throw Error("Native segment discovery exceeded its supported directory bound");
      if (entry.isSymbolicLink()) throw Error("Linked native history directories are not supported");
      const path = directory + "/" + entry.name;
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/i.test(entry.name) && entry.name.toLowerCase().includes(sessionId.toLowerCase())) paths.push(path);
    }
  }
  return paths;
}

async function matchesPrefix(file: FileHandle, path: string, endByteOffset: number, endOrdinalExclusive: number) {
  const before = await file.stat();
  if (before.size < endByteOffset) return false;
  const key = fingerprint([path, before.dev, before.ino, before.size, before.mtimeMs, endByteOffset, endOrdinalExclusive]);
  if (verifiedPrefixes.has(key)) return verifiedPrefixes.get(key)!;
  let offset = 0, records = 0, lastByte = -1;
  const buffer = Buffer.alloc(64 * 1024);
  while (offset < endByteOffset) {
    const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, endByteOffset - offset), offset);
    if (!bytesRead) throw Error("Native base segment shrank while verifying its boundary");
    for (let at = buffer.indexOf(10); at >= 0 && at < bytesRead; at = buffer.indexOf(10, at + 1)) records++;
    offset += bytesRead; lastByte = buffer[bytesRead - 1]!;
  }
  const after = await file.stat();
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw Error("Native base segment changed while verifying its boundary");
  const valid = lastByte === 10 && records === endOrdinalExclusive;
  if (verifiedPrefixes.size >= 64) verifiedPrefixes.delete(verifiedPrefixes.keys().next().value!);
  verifiedPrefixes.set(key, valid);
  return valid;
}

export async function withCodexSourceSegments<T>(root: string, path: string, sessionId: string,
  physicalRead: CodexPhysicalReader, read: (source: CodexSourceIdentity, file: CodexSourceFile) => Promise<T>,
): Promise<T> {
  return physicalRead(root, path, sessionId, async (source, current, headerBytes) => {
    const continuation = source.continuation;
    if (!continuation) return read(source, current);
    const candidates: string[] = [];
    for (const candidate of await codexSourceCandidatePaths(root, sessionId)) {
      if (candidate.toLowerCase() === source.relativePath.toLowerCase()) continue;
      let matches: boolean;
      try {
        matches = await physicalRead(root, candidate, sessionId, async (base, file) => {
          if (base.source !== source.source || Date.parse(base.createdAt) > Date.parse(source.createdAt)) return false;
          if (base.continuation || base.fork) throw Error("Nested or forked prior segments require reconciliation");
          return matchesPrefix(file, candidate, continuation.endByteOffset, continuation.endOrdinalExclusive);
        });
      } catch (error) {
        if (error instanceof Error && error.message === "Codex source session identity does not match") continue;
        throw error;
      }
      if (matches) candidates.push(candidate);
    }
    if (candidates.length !== 1) throw Error(`Native continuation requires one proven prior segment; found ${candidates.length}`);
    const basePath = candidates[0]!;
    return physicalRead(root, basePath, sessionId, async (baseSource, base) => {
      if (baseSource.continuation || baseSource.fork || baseSource.source !== source.source ||
          Date.parse(baseSource.createdAt) > Date.parse(source.createdAt) ||
          !await matchesPrefix(base, basePath, continuation.endByteOffset, continuation.endOrdinalExclusive)) {
        throw Error("Native prior segment changed before the combined read");
      }
      const baseSnapshot = await base.stat();
      const baseKey = [basePath, baseSnapshot.dev, baseSnapshot.ino, baseSnapshot.size, baseSnapshot.mtimeMs];
      const logical: CodexSourceFile = {
        async stat() {
          const previous = await base.stat(), latest = await current.stat();
          if (previous.size !== baseSnapshot.size || previous.mtimeMs !== baseSnapshot.mtimeMs || latest.size < headerBytes) {
            throw Error("Native source segment changed during the combined read");
          }
          const size = continuation.endByteOffset + latest.size - headerBytes;
          if (!Number.isSafeInteger(size)) throw Error("Combined native source exceeds the supported size");
          return { dev: latest.dev, ino: latest.ino, size, mtimeMs: latest.mtimeMs,
            identity: fingerprint([baseKey, latest.dev, latest.ino, headerBytes, source.createdAt, continuation]) };
        },
        async read(buffer, offset, length, position) {
          let bytesRead = 0;
          if (position < continuation.endByteOffset) {
            const count = Math.min(length, continuation.endByteOffset - position);
            while (bytesRead < count) {
              const result = await base.read(buffer, offset + bytesRead, count - bytesRead, position + bytesRead);
              if (!result.bytesRead) throw Error("Native prior segment is shorter than its declared boundary");
              bytesRead += result.bytesRead;
            }
          }
          if (bytesRead < length) {
            const result = await current.read(buffer, offset + bytesRead, length - bytesRead,
              headerBytes + position + bytesRead - continuation.endByteOffset);
            bytesRead += result.bytesRead;
          }
          return { bytesRead, buffer };
        },
      };
      return read({ ...source, createdAt: baseSource.createdAt, continuation: { ...continuation, sourcePath: basePath } }, logical);
    });
  });
}
