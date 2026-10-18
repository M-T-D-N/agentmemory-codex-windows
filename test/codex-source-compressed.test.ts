import { randomBytes } from "node:crypto";
import { withCodexCompressedFile } from "../src/functions/codex-source-compressed.js";
import type { FileHandle } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { constants, zstdCompressSync } from "node:zlib";
import { withReadOnlyCodexPhysicalSource } from "../src/functions/codex-source-identity.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(body = "한글 원문🙂\n".repeat(100_000)) {
  const parent = resolve(".tmp"); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "compressed-source-")); roots.push(root);
  await mkdir(join(root, "archived_sessions"));
  const path = "archived_sessions/rollout-s1.jsonl";
  const header = JSON.stringify({ type: "session_meta", payload: { id: "s1", source: "vscode", cwd: root, timestamp: "2026-10-14T00:00:00.000Z" } }) + "\n";
  const original = Buffer.from(header + body);
  const compressed = zstdCompressSync(original);
  await writeFile(join(root, path + ".zst"), compressed);
  return { root, path, original, compressed, header };
}

describe("compressed Codex original transport", () => {
  it("preserves small verified checkpoint reads across unrelated streaming cache pressure", async () => {
    const { root } = await fixture();
    const raw = randomBytes(6 * 1024 * 1024), noise = randomBytes(36 * 1024 * 1024);
    const path = join(root, "checkpoint.zst"), otherPath = join(root, "pressure.zst");
    await writeFile(path, zstdCompressSync(raw)); await writeFile(otherPath, zstdCompressSync(noise));
    const physical = await open(path, "r"), other = await open(otherPath, "r"); let bytes = 0;
    const measured = { stat: () => physical.stat(), read: async (...args: [Buffer, number, number, number]) => {
      const result = await physical.read(...args); bytes += result.bytesRead; return result;
    } } as unknown as FileHandle;
    const check = () => withCodexCompressedFile(measured, path, async file => {
      for (const position of [0, raw.length - 64]) {
        const output = Buffer.alloc(64); await file.read(output, 0, output.length, position);
        expect(output).toEqual(raw.subarray(position, position + 64));
      }
    });
    try {
      await check();
      await withCodexCompressedFile(other, otherPath, async file => {
        const output = Buffer.alloc(noise.length); await file.read(output, 0, output.length, 0);
        expect(output.equals(noise)).toBe(true);
      });
      const before = bytes; await check(); expect(bytes).toBe(before);
    } finally { await physical.close(); await other.close(); }
  }, 30_000);
  it("continues a sequential reader after another archive evicts its shared prefetch", async () => {
    const { root } = await fixture();
    const raw = randomBytes(6 * 1024 * 1024), noise = randomBytes(36 * 1024 * 1024);
    const path = join(root, "interleaved-main.zst"), otherPath = join(root, "interleaved-other.zst");
    await writeFile(path, zstdCompressSync(raw)); await writeFile(otherPath, zstdCompressSync(noise));
    const physical = await open(path, "r"), other = await open(otherPath, "r");
    let prefixReads = 0;
    const measured = { stat: () => physical.stat(), read: async (...args: [Buffer, number, number, number]) => {
      if (args[3] === 0) prefixReads++;
      return physical.read(...args);
    } } as unknown as FileHandle;
    try { await withCodexCompressedFile(measured, path, async file => {
      const size = 512 * 1024, head = Buffer.alloc(size), next = Buffer.alloc(size);
      await file.read(head, 0, size, 0); expect(head).toEqual(raw.subarray(0, size));
      const before = prefixReads;
      await withCodexCompressedFile(other, otherPath, async unrelated => {
        const output = Buffer.alloc(noise.length); await unrelated.read(output, 0, output.length, 0);
        expect(output.equals(noise)).toBe(true);
      });
      await file.read(next, 0, size, size); expect(next).toEqual(raw.subarray(size, size * 2));
      expect(prefixReads).toBe(before);
    }); } finally { await physical.close(); await other.close(); }
  }, 30_000);
  it("keeps independent range reads within the physical cost of a shared decoder", async () => {
    const { root } = await fixture(); const raw = randomBytes(4 * 1024 * 1024), packed = zstdCompressSync(raw), costs: number[] = [];
    for (const independent of [false, true]) {
      const path = join(root, `cost-${independent}.zst`); await writeFile(path, packed); let total = 0, calls = 0;
      const use = async (indices: number[]) => {
        const physical = await open(path, "r");
        const measured = { stat: () => physical.stat(), read: async (...args: [Buffer, number, number, number]) => {
          const result = await physical.read(...args); total += result.bytesRead; calls++; return result;
        } } as unknown as FileHandle;
        try { await withCodexCompressedFile(measured, path, async file => {
          for (const n of indices) { const buffer = Buffer.alloc(512 * 1024); await file.read(buffer, 0, buffer.length, n * buffer.length);
            expect(buffer.equals(raw.subarray(n * buffer.length, (n + 1) * buffer.length))).toBe(true); }
        }); } finally { await physical.close(); }
      };
      if (independent) for (let n = 0; n < 8; n++) await use([n]); else await use([0,1,2,3,4,5,6,7]);
      costs.push(total);
      expect(total).toBeLessThanOrEqual(2 * packed.length + 64 * 1024);
      expect(calls).toBeLessThanOrEqual(2 * Math.ceil(packed.length / (64 * 1024)) + 2);
    }
    expect(costs[1]).toBeLessThanOrEqual(costs[0]!);
  });
  it("bounds a small head read and verifies later/backward reads on an original larger than prefetch", async () => {
    const { root } = await fixture(); const raw = randomBytes(6 * 1024 * 1024), packed = zstdCompressSync(raw);
    const path = join(root, "larger.zst"); await writeFile(path, packed); const physical = await open(path, "r"); let bytes = 0, calls = 0;
    const measured = { stat: () => physical.stat(), read: async (...args: [Buffer, number, number, number]) => { const r = await physical.read(...args); bytes += r.bytesRead; calls++; return r; } } as unknown as FileHandle;
    try { await withCodexCompressedFile(measured, path, async file => {
      const head = Buffer.alloc(256); await file.read(head, 0, head.length, 0); expect(head.equals(raw.subarray(0, 256))).toBe(true);
      expect(bytes).toBeLessThanOrEqual(2 * packed.length + 64 * 1024);
      expect(calls).toBeLessThanOrEqual(2 * Math.ceil(packed.length / (64 * 1024)) + 2);
      for (const at of [raw.length - 256, 512]) { const output = Buffer.alloc(256); await file.read(output, 0, output.length, at); expect(output.equals(raw.subarray(at, at + 256))).toBe(true); }
    }); } finally { await physical.close(); }
  });
  it("never serves cached output from a failed checksum on a subsequent call", async () => {
    const { root, path, original } = await fixture(); const checked = zstdCompressSync(original, { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
    checked[checked.length - 1] ^= 255; await writeFile(join(root, path + ".zst"), checked);
    for (let n = 0; n < 2; n++) await expect(withReadOnlyCodexPhysicalSource(root, path, "s1", async () => {})).rejects.toThrow();
  });
  it.each(["unknown-size", "concatenated", "mixed-frames"])("reads complete original offsets for %s frames", async mode => {
    const { root, path, original } = await fixture();
    const cut = original.indexOf(Buffer.from("🙂")) + 2;
    const packed = mode === "unknown-size"
      ? zstdCompressSync(original, { params: { [constants.ZSTD_c_contentSizeFlag]: 0 } })
      : Buffer.concat([
          ...(mode === "mixed-frames" ? [Buffer.from([0x50, 0x2a, 0x4d, 0x18, 3, 0, 0, 0, 1, 2, 3]), zstdCompressSync(Buffer.alloc(0))] : []),
          zstdCompressSync(original.subarray(0, cut)),
          zstdCompressSync(original.subarray(cut), mode === "mixed-frames" ? { params: { [constants.ZSTD_c_contentSizeFlag]: 0 } } : {}),
        ]);
    await writeFile(join(root, path + ".zst"), packed);
    await withReadOnlyCodexPhysicalSource(root, path, "s1", async (_source, file) => {
      expect((await file.stat()).size).toBe(original.length);
      for (const position of [0, cut - 4, original.length - 256]) {
        const bytes = Buffer.alloc(256);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, position);
        expect(bytes.subarray(0, bytesRead)).toEqual(original.subarray(position, position + bytesRead));
      }
    });
    expect(await readFile(join(root, path + ".zst"))).toEqual(packed);
  });
  it("re-resolves the exact original when a representation transition briefly leaves no file", async () => {
    const { root, path, compressed } = await fixture();
    await rm(join(root, path + ".zst"));
    const arrival = new Promise<void>((resolve, reject) => setTimeout(() => {
      writeFile(join(root, path + ".zst"), compressed).then(resolve, reject);
    }, 30));
    try {
      await withReadOnlyCodexPhysicalSource(root, path, "s1", async source => { expect(source.sessionId).toBe("s1"); });
    } finally { await arrival; }
  });
  it("leaves permanent absence as ENOENT without calling the consumer", async () => {
    const { root, path } = await fixture(); await rm(join(root, path + ".zst"));
    let calls = 0;
    await expect(withReadOnlyCodexPhysicalSource(root, path, "s1", async () => { calls++; })).rejects.toMatchObject({ code: "ENOENT" });
    expect(calls).toBe(0);
  });
  it("does not repeat a consumer after its ENOENT error", async () => {
    const { root, path } = await fixture(); let calls = 0;
    await expect(withReadOnlyCodexPhysicalSource(root, path, "s1", async () => {
      calls++; throw Object.assign(Error("consumer"), { code: "ENOENT" });
    })).rejects.toThrow("consumer");
    expect(calls).toBe(1);
  });
  it.each(["trailing-garbage", "truncated-later-frame", "bad-checksum"])("rejects %s without hiding the damage as source absence", async mode => {
    const { root, path, original, compressed } = await fixture();
    const checked = zstdCompressSync(original, { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
    checked[checked.length - 1] ^= 0xff;
    const damaged = mode === "bad-checksum" ? checked : Buffer.concat([compressed,
      mode === "trailing-garbage" ? Buffer.alloc(24) : compressed.subarray(0, compressed.length - 1)]);
    await writeFile(join(root, path + ".zst"), damaged);
    await expect(withReadOnlyCodexPhysicalSource(root, path, "s1", async (_source, file) => {
      const size = (await file.stat()).size; await file.read(Buffer.alloc(256), 0, 256, size - 256);
    })).rejects.toThrow();
  });
  it("reads original offsets and UTF-8 bytes while preserving the archive and logical source path", async () => {
    const { root, path, original, compressed } = await fixture();
    const before = await stat(join(root, path + ".zst"));
    await withReadOnlyCodexPhysicalSource(root, path, "s1", async (source, file, headerBytes) => {
      expect(source.relativePath).toBe(path); expect(headerBytes).toBeGreaterThan(0);
      expect((await file.stat()).size).toBe(original.length);
      for (const position of [0, 180, original.length - 65536, original.length - 256, 512]) {
        const bytes = Buffer.alloc(Math.min(65536, original.length - position));
        const read = await file.read(bytes, 0, bytes.length, position);
        expect(bytes.subarray(0, read.bytesRead)).toEqual(original.subarray(position, position + bytes.length));
      }
    });
    expect(await readFile(join(root, path + ".zst"))).toEqual(compressed);
    expect((await stat(join(root, path + ".zst"))).mtimeMs).toBe(before.mtimeMs);
  });
  it("reuses proved original ranges on a second independent read", async () => {
    const { root, path, original } = await fixture();
    for (let n = 0; n < 2; n++) await withReadOnlyCodexPhysicalSource(root, path, "s1", async (_source, file) => {
      const bytes = Buffer.alloc(256); await file.read(bytes, 0, bytes.length, original.length - 256);
      expect(bytes).toEqual(original.subarray(-256));
    });
  });
  it("keeps a real plain original authoritative when both forms exist", async () => {
    const { root, path, original } = await fixture(); await writeFile(join(root, path), original);
    await writeFile(join(root, path + ".zst"), "broken");
    await withReadOnlyCodexPhysicalSource(root, path, "s1", async (_source, file) => {
      expect((await file.stat()).identity).toBeUndefined();
    });
  });
  it("does not classify a corrupt compressed original as a missing original", async () => {
    const { root, path } = await fixture(); await writeFile(join(root, path + ".zst"), Buffer.alloc(24));
    await expect(withReadOnlyCodexPhysicalSource(root, path, "s1", async () => {})).rejects.toThrow("compressed frame header");
  });
  it("rejects a truncated compressed stream", async () => {
    const { root, path, original, compressed } = await fixture();
    await writeFile(join(root, path + ".zst"), compressed.subarray(0, compressed.length - 10));
    await expect(withReadOnlyCodexPhysicalSource(root, path, "s1", async (_source, file) => {
      await file.read(Buffer.alloc(256), 0, 256, original.length - 256);
    })).rejects.toThrow();
  });
  it("does not reuse cached ranges after an archive replacement", async () => {
    const { root, path, original, header } = await fixture();
    await withReadOnlyCodexPhysicalSource(root, path, "s1", async (_source, file) => { await file.read(Buffer.alloc(256), 0, 256, original.length - 256); });
    const replacement = Buffer.from(header + "replacement\n".repeat(100_000));
    await rm(join(root, path + ".zst")); await writeFile(join(root, path + ".zst"), zstdCompressSync(replacement));
    await withReadOnlyCodexPhysicalSource(root, path, "s1", async (_source, file) => {
      const bytes = Buffer.alloc(256); await file.read(bytes, 0, 256, replacement.length - 256);
      expect(bytes).toEqual(replacement.subarray(-256));
    });
  });
  it("preserves exact session identity checks", async () => {
    const { root, path } = await fixture();
    await expect(withReadOnlyCodexPhysicalSource(root, path, "other", async () => {})).rejects.toThrow("session identity does not match");
  });
});
