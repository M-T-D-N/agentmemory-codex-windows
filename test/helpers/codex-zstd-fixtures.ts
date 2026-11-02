import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { constants, zstdCompressSync } from "node:zlib";
import ts from "typescript";
import type { CodexSourceFile } from "../../src/functions/codex-source-segments.js";
import type * as Scanner from "../../src/functions/codex-source-zstd-frames.js";

export const baselineCommit = "1364cc8bbcc5c6994510c1b545f2486c2f8e3411";
export const baselineSha256 = "cf8b98f362f02e456d279dcebd5fdae91f19d22a7597f27692eb6f0e2a130475";
export function baselineScanner(): Pick<typeof Scanner, "codexZstdFrames" | "decodeCodexZstdFrame"> {
  const source = readFileSync(new URL("../fixtures/codex-zstd-frames.baseline.ts.txt", import.meta.url));
  if (createHash("sha256").update(source).digest("hex") !== baselineSha256) throw Error("Baseline frame scanner fixture changed");
  const code = ts.transpileModule(source.toString("utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  new Function("exports", "require", code)(exports, createRequire(import.meta.url));
  return exports as ReturnType<typeof baselineScanner>;
}

export function noise(size: number, seed = 0x57494e32) {
  const bytes = Buffer.alloc(size); let state = seed;
  for (let index = 0; index < size; index++) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; bytes[index] = state & 255; }
  return bytes;
}
export function skippable(size: number) {
  const prefix = Buffer.alloc(8); prefix.writeUInt32LE(0x184d2a50); prefix.writeUInt32LE(size, 4);
  return Buffer.concat([prefix, Buffer.alloc(size)]);
}
export function rawFrame(payload: Buffer) {
  const header = Buffer.alloc(9); header.writeUInt32LE(0xfd2fb528); header[4] = 0xa0; header.writeUInt32LE(payload.length, 5);
  const blocks: Buffer[] = [header];
  for (let at = 0; at < payload.length || at === 0; at += 128 * 1024) {
    const part = payload.subarray(at, at + 128 * 1024), block = Buffer.alloc(3);
    block.writeUIntLE((part.length << 3) | Number(at + part.length === payload.length), 0, 3);
    blocks.push(block, part);
  }
  return Buffer.concat(blocks);
}
export function fixtureMatrix() {
  const denseFrames = Array.from({ length: 2048 }, (_, index) => zstdCompressSync(Buffer.from(`dense-${index % 10}`)));
  const checked = zstdCompressSync(Buffer.from("checksum synthetic fixture"), { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
  const brokenChecksum = Buffer.from(checked); brokenChecksum[brokenChecksum.length - 1] ^= 255;
  const invalidBlock = rawFrame(Buffer.from("bad")); invalidBlock[9] |= 6;
  const invalidLength = Buffer.from(invalidBlock); invalidLength.writeUIntLE((131073 << 3) | 1, 9, 3);
  const badReserved = Buffer.from(checked); badReserved[4] |= 8;
  const badSize = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0xe0, ...Buffer.alloc(8)]); badSize.writeBigUInt64LE(2n ** 53n + 1n, 5);
  const sparse = rawFrame(noise(4 * 1024 ** 2));
  const wideHeader = Buffer.alloc(13); wideHeader.writeUInt32LE(0xfd2fb528); wideHeader[4] = 0xe0; wideHeader.writeBigUInt64LE(3n, 5);
  const crossing = Buffer.concat([skippable(240), wideHeader, Buffer.from([25, 0, 0, 65, 66, 67]), skippable(8192)]);
  return {
    tiny: zstdCompressSync(Buffer.from("tiny synthetic")),
    dense: Buffer.concat(denseFrames),
    sparse,
    medium: Buffer.concat(Array.from({ length: 64 }, (_, index) => rawFrame(noise(4096, index + 1)))),
    concatenated: Buffer.concat([zstdCompressSync(Buffer.from("one")), zstdCompressSync(Buffer.alloc(0)), zstdCompressSync(Buffer.from("two"))]),
    "unknown-size": zstdCompressSync(noise(256 * 1024), { params: { [constants.ZSTD_c_contentSizeFlag]: 0 } }),
    skippable: Buffer.concat([skippable(1024 ** 2), zstdCompressSync(Buffer.from("after skip")), skippable(3)]),
    mixed: Buffer.concat([...denseFrames.slice(0, 32), skippable(256 * 1024), rawFrame(noise(256 * 1024)), ...denseFrames.slice(0, 32)]),
    "header-crossing": crossing,
    checksum: checked,
    "bad-checksum": brokenChecksum,
    "truncated-magic": Buffer.from([0x28, 0xb5, 0x2f]),
    "truncated-block": sparse.subarray(0, sparse.length - 1),
    "truncated-checksum": checked.subarray(0, checked.length - 1),
    "truncated-later-frame": Buffer.concat([checked, checked.subarray(0, 5)]),
    "truncated-skippable": skippable(100).subarray(0, 20),
    "invalid-magic": Buffer.alloc(32),
    "invalid-block": invalidBlock,
    "invalid-block-length": invalidLength,
    "invalid-reserved": badReserved,
    "invalid-size": badSize,
    "trailing-garbage": Buffer.concat([checked, Buffer.alloc(4)]),
  };
}
let nextIdentity = 900_000;
export function memoryFile(bytes: Buffer, maxRead = Infinity) {
  let physicalBytes = 0, calls = 0, maximumRequest = 0;
  const ino = nextIdentity++;
  const file: CodexSourceFile = {
    stat: async () => ({ dev: 7, ino, size: bytes.length, mtimeMs: 1 }),
    read: async (buffer, offset, length, position) => {
      calls++; maximumRequest = Math.max(maximumRequest, length);
      const bytesRead = Math.max(0, Math.min(length, maxRead, bytes.length - position));
      bytes.copy(buffer, offset, position, position + bytesRead); physicalBytes += bytesRead;
      return { bytesRead, buffer };
    },
  };
  return { file, stats: () => ({ physicalBytes, calls, maximumRequest }) };
}
