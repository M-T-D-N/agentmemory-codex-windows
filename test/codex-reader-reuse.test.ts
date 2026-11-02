import { randomBytes } from "node:crypto";
import { codexZstdFrames } from "../src/functions/codex-source-zstd-frames.js";
import { afterEach, describe, expect, it } from "vitest";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { zstdCompressSync } from "node:zlib";
import { withCodexCompressedFile } from "../src/functions/codex-source-compressed.js";
import type { CodexSourceFile } from "../src/functions/codex-source-segments.js";
import { withReadOnlyCodexPhysicalSource } from "../src/functions/codex-source-identity.js";
import { CodexReadBudget } from "../src/replay/codex-read-budget.js";
import { readCodexInventory } from "../src/replay/codex-inventory.js";
import { readCodexWindow } from "../src/replay/codex-window.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
let nextIdentity = 500_000;
function physical(bytes: Buffer) {
  const identity = nextIdentity++;
  let readBytes = 0;
  const file: CodexSourceFile = {
    stat: async () => ({ dev: 7, ino: identity, size: bytes.length, mtimeMs: 1 }),
    read: async (buffer, offset, length, position) => {
      const bytesRead = Math.max(0, Math.min(length, bytes.length - position));
      bytes.copy(buffer, offset, position, position + bytesRead); readBytes += bytesRead;
      return { buffer, bytesRead };
    },
  };
  return { file, path: `synthetic-${identity}.zst`, readBytes: () => readBytes };
}
async function fixture(megabytes = 1) {
  const root = await mkdtemp(join(tmpdir(), "codex-reader-reuse-")); roots.push(root);
  await mkdir(join(root, "sessions"));
  const sourcePath = "sessions/rollout-reuse-session.jsonl";
  const header = JSON.stringify({ type: "session_meta", payload: { id: "reuse-session", cwd: root,
    timestamp: "2026-10-21T00:00:00Z", source: "vscode" } }) + "\n";
  const ignored = JSON.stringify({ type: "event_msg", payload: { type: "token_count", padding: "a".repeat(1024 ** 2) } }) + "\n";
  const original = Buffer.from(header + ignored.repeat(megabytes));
  const packed = zstdCompressSync(original);
  const path = join(root, sourcePath + ".zst"); await writeFile(path, packed);
  return { root, path, original, packed, input: { sourceRoot: root, sourcePath, sessionId: "reuse-session" } };
}

describe("bounded compressed native inventory reuse", () => {
  it("preserves exact ranges across discarded prefixes, backward seeks and EOF", async () => {
    const original = Buffer.concat(Array.from({ length: 40 }, (_, index) => Buffer.alloc(1024 ** 2, index)));
    const source = physical(zstdCompressSync(original));
    const budget = new CodexReadBudget({ maxDecodedBytes: 128 * 1024 ** 2, maxMilliseconds: 5000 });
    await withCodexCompressedFile(budget.physical(source.file), source.path, async file => {
      for (const position of [0, 31 * 1024 ** 2 - 129, 12 * 1024 ** 2 - 129, original.length - 256]) {
        const output = Buffer.alloc(256);
        const result = await file.read(output, 0, output.length, position);
        expect(result.bytesRead).toBe(output.length);
        expect(output).toEqual(original.subarray(position, position + output.length));
      }
    }, budget);
    expect(budget.usage().decodedBytes).toBeGreaterThanOrEqual(original.length);
  });

  it("enumerates sparse block headers without reading payload-sized metadata windows", async () => {
    const packed = zstdCompressSync(randomBytes(4 * 1024 ** 2));
    const source = physical(packed);
    const frames = [];
    for await (const frame of codexZstdFrames(source.file, packed.length)) frames.push(frame);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ start: 0, end: packed.length, size: 4 * 1024 ** 2 });
    expect(source.readBytes()).toBeLessThan(packed.length / 32);
  });
  it.each([
    [{ discoverSourceHolds: "yes" }, "Invalid source hold review option"],
    [{ includeExcludedMessages: "yes" }, "Invalid Codex read bounds"],
  ])("preserves read-option validation before opening a source: %j", async (options, message) => {
    const input = { sourceRoot: "C:/synthetic/absent", sourcePath: "sessions/rollout-absent.jsonl", sessionId: "absent", ...options };
    await expect(readCodexInventory(input as unknown as Parameters<typeof readCodexInventory>[0])).rejects.toThrow(message);
  });

  it("enumerates a snapshot's frame metadata once even when ranges need a new decoder", async () => {
    const bytes = zstdCompressSync(Buffer.alloc(64 * 1024 ** 2, 97));
    const source = physical(bytes);
    for (const [index, position] of [40 * 1024 ** 2, 56 * 1024 ** 2].entries()) {
      const budget = new CodexReadBudget({ maxPhysicalBytes: 1024 ** 2, maxDecodedBytes: 80 * 1024 ** 2, maxMilliseconds: 2000 });
      const before = source.readBytes();
      await withCodexCompressedFile(budget.physical(source.file), source.path, async file => {
        const output = Buffer.alloc(64 * 1024);
        await file.read(output, 0, output.length, 0);
        await file.read(output, 0, output.length, position);
        expect(output.every(value => value === 97)).toBe(true);
      }, budget);
      expect(source.readBytes() - before).toBeLessThanOrEqual(bytes.length * (index === 0 ? 2 : 1));
    }
  });

  it("keeps one decoder across real inventory windows with the same canonical references", async () => {
    const { input, original } = await fixture(52);
    const costs: number[] = [];
    let previous: Awaited<ReturnType<typeof readCodexInventory>> | undefined;
    for (const shared of [false, true]) {
      const budget = new CodexReadBudget({ maxPhysicalBytes: 8 * 1024 ** 2, maxDecodedBytes: 256 * 1024 ** 2, maxMilliseconds: 5000 });
      const result = shared ? await readCodexInventory({ ...input, readBudget: budget })
        : await readCodexInventory({ ...input, readBudget: budget }, options => readCodexWindow(options));
      expect(result.last.caughtUp).toBe(true);
      expect(result.last.cursor.byteOffset).toBe(original.length);
      if (previous) expect(result).toEqual(previous);
      previous = result; costs.push(budget.usage().decodedBytes);
    }
    expect(costs[0]).toBeGreaterThan(original.length * 1.5);
    expect(costs[1]).toBeLessThanOrEqual(original.length);
  }, 15_000);

  it.each(["replace", "append", "truncate", "recompress"])("invalidates metadata and ranges after %s", async mode => {
    const { input, path, original } = await fixture();
    const read = () => withReadOnlyCodexPhysicalSource(input.sourceRoot, input.sourcePath, input.sessionId, async (_source, file) => {
      const size = (await file.stat()).size, output = Buffer.alloc(32);
      await file.read(output, 0, output.length, size - output.length); return { size, output };
    });
    await read();
    if (mode === "truncate") {
      const packed = await readFile(path); await writeFile(path, packed.subarray(0, packed.length - 2));
      await expect(read()).rejects.toThrow(); return;
    }
    const addition = Buffer.from(JSON.stringify({ type: "event_msg", payload: { type: "warning", detail: mode } }) + "\n");
    const changed = Buffer.concat([original, addition]);
    if (mode === "append") await appendFile(path, zstdCompressSync(addition));
    else {
      if (mode === "replace") await rename(path, path + ".prior");
      await writeFile(path, zstdCompressSync(changed));
    }
    const result = await read(); expect(result.size).toBe(changed.length); expect(result.output).toEqual(changed.subarray(-32));
  });

  it.each(["exact", "contained"])("checks snapshot identity on a %s cached range and closes escaped readers", async mode => {
    const source = physical(zstdCompressSync(Buffer.alloc(1024, 65)));
    const originalStat = source.file.stat;
    let changed = false, escaped: CodexSourceFile | undefined;
    source.file.stat = async () => ({ ...await originalStat(), mtimeMs: changed ? 2 : 1 });
    await expect(withCodexCompressedFile(source.file, source.path, async file => {
      escaped = file; const output = Buffer.alloc(32); await file.read(output, 0, 32, 0);
      changed = true; await file.read(output, 0, mode === "exact" ? 32 : 9, mode === "exact" ? 0 : 13);
    })).rejects.toThrow("changed while reading");
    await expect(escaped!.read(Buffer.alloc(1), 0, 1, 0)).rejects.toThrow("scope is closed");
    await expect(escaped!.stat()).rejects.toThrow("scope is closed");
  });

  it("preserves overlapping cached ranges and verifies their snapshot without another decode", async () => {
    const raw = Buffer.from(Array.from({ length: 1024 }, (_, index) => index % 251));
    const source = physical(zstdCompressSync(raw));
    const originalStat = source.file.stat; let verifications = 0;
    source.file.stat = async () => { verifications++; return originalStat(); };
    await withCodexCompressedFile(source.file, source.path, async file => {
      await file.read(Buffer.alloc(32), 0, 32, 0);
      const physicalBytes = source.readBytes();
      for (const [position, length] of [[13, 9], [15, 40], [1020, 20], [13, 9]]) {
        const output = Buffer.alloc(length!); const checks = verifications;
        const value = await file.read(output, 0, output.length, position!);
        expect(output.subarray(0, value.bytesRead)).toEqual(raw.subarray(position!, position! + length!));
        expect(verifications).toBe(checks + 1);
        expect(source.readBytes()).toBe(physicalBytes);
      }
    });
  });

  it("rejects cancellation before a contained cached read can return bytes", async () => {
    const source = physical(zstdCompressSync(Buffer.alloc(1024, 65)));
    const controller = new AbortController();
    const budget = new CodexReadBudget({}, controller.signal);
    await expect(withCodexCompressedFile(budget.physical(source.file), source.path, async file => {
      await file.read(Buffer.alloc(32), 0, 32, 0);
      const physicalBytes = source.readBytes(); controller.abort();
      try { await file.read(Buffer.alloc(9), 0, 9, 13); }
      finally { expect(source.readBytes()).toBe(physicalBytes); }
    }, budget)).rejects.toMatchObject({ name: "NativeSourceShutdownError" });
  });

  it("cancels a running production inventory, releases it, and permits a clean independent retry", async () => {
    const { input } = await fixture(10);
    const controller = new AbortController();
    class CancellingBudget extends CodexReadBudget {
      decoded(bytes: number) {
        super.decoded(bytes);
        if (this.usage().decodedBytes >= 5 * 1024 ** 2) controller.abort();
        this.check();
      }
    }
    const budget = new CancellingBudget({ maxPhysicalBytes: 8 * 1024 ** 2, maxDecodedBytes: 32 * 1024 ** 2, maxMilliseconds: 2000 }, controller.signal);
    await expect(readCodexInventory({ ...input, readBudget: budget })).rejects.toMatchObject({ name: "NativeSourceShutdownError" });
    expect(budget.usage().decodedBytes).toBeLessThan(6 * 1024 ** 2);
    expect((await readCodexInventory(input)).last.caughtUp).toBe(true);
  });

  it("rejects a pathname replacement during a production inventory and releases its file scope", async () => {
    const { input, path, packed } = await fixture();
    let reads = 0, changed = false;
    class ReplacingBudget extends CodexReadBudget {
      physical(file: CodexSourceFile): CodexSourceFile {
        const measured = super.physical(file);
        return { stat: () => measured.stat(), read: async (buffer, offset, length, position) => {
          const result = await measured.read(buffer, offset, length, position);
          if (++reads === 2) { await rename(path, path + ".prior"); await writeFile(path, packed); changed = true; }
          return result;
        } };
      }
    }
    await expect(readCodexInventory({ ...input, readBudget: new ReplacingBudget() })).rejects.toThrow("changed while reading identity");
    expect(changed).toBe(true);
    expect((await readCodexInventory(input)).last.caughtUp).toBe(true);
  });

  it("enforces one total decoded budget across inventory windows without false caught_up", async () => {
    const { input } = await fixture(20);
    const budget = new CodexReadBudget({ maxPhysicalBytes: 8 * 1024 ** 2, maxDecodedBytes: 18 * 1024 ** 2, maxMilliseconds: 2000 });
    await expect(readCodexInventory({ ...input, readBudget: budget })).rejects.toMatchObject({ name: "CodexReadBudgetError", reason: "decoded_bytes" });
  });

  it("does not read again after the owner finishes the read phase for canonical mutations", async () => {
    const { input } = await fixture(); const budget = new CodexReadBudget();
    await expect(withReadOnlyCodexPhysicalSource(input.sourceRoot, input.sourcePath, input.sessionId,
      async () => { budget.finishReading(); return "canonical-boundary"; }, budget)).resolves.toBe("canonical-boundary");
  });

  it("evicts bounded frame catalogs without retaining unbounded snapshot metadata", async () => {
    const source = physical(zstdCompressSync(Buffer.alloc(0)));
    const use = (path: string) => withCodexCompressedFile(source.file, path, async file => { expect((await file.stat()).size).toBe(0); });
    await use(source.path); const before = source.readBytes(); await use(source.path); expect(source.readBytes()).toBe(before);
    for (let index = 0; index < 256; index++) await use(source.path + "." + index);
    const evicted = source.readBytes(); await use(source.path); expect(source.readBytes()).toBeGreaterThan(evicted);
  });
});
