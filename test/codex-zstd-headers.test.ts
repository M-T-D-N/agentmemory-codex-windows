import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { codexZstdFrames, decodeCodexZstdFrame } from "../src/functions/codex-source-zstd-frames.js";
import { withCodexCompressedFile } from "../src/functions/codex-source-compressed.js";
import { CodexReadBudget } from "../src/replay/codex-read-budget.js";
import { baselineScanner, fixtureMatrix, memoryFile, rawFrame, noise } from "./helpers/codex-zstd-fixtures.js";
const baseline = baselineScanner(), fixtures = fixtureMatrix();
const scan = async (reader: typeof codexZstdFrames, bytes: Buffer, maxRead?: number) => {
  const source = memoryFile(bytes, maxRead); const frames = [];
  try { for await (const frame of reader(source.file, bytes.length)) frames.push(frame); return { frames, error: null, ...source.stats() }; }
  catch (error) { return { frames, error: { name: (error as Error).name, message: (error as Error).message }, ...source.stats() }; }
};
const decoded = async (scanner: ReturnType<typeof baselineScanner>, bytes: Buffer) => {
  const source = memoryFile(bytes), digest = createHash("sha256"); let count = 0;
  try {
    for await (const frame of scanner.codexZstdFrames(source.file, bytes.length))
      for await (const chunk of scanner.decodeCodexZstdFrame(source.file, frame)) { count += chunk.length; digest.update(chunk); }
    return { bytes: count, sha256: digest.digest("hex"), error: null };
  } catch (error) { return { bytes: count, sha256: digest.digest("hex"), error: { name: (error as Error).name, code: (error as NodeJS.ErrnoException).code } }; }
};

describe("bounded adaptive zstd frame header reads", () => {
  it.each(Object.keys(fixtures).flatMap(name => [undefined, 31].map(maxRead => ({ name, maxRead }))))("preserves baseline frame lists and grammar errors for $name (maxRead=$maxRead)", async ({ name, maxRead }) => {
    const bytes = fixtures[name as keyof typeof fixtures];
    const before = await scan(baseline.codexZstdFrames, bytes, maxRead), after = await scan(codexZstdFrames, bytes, maxRead);
    expect(after.frames).toEqual(before.frames); expect(after.error).toEqual(before.error);
    expect(after.maximumRequest).toBeLessThanOrEqual(64 * 1024);
  });
  it.each(["tiny", "dense", "sparse", "medium", "concatenated", "unknown-size", "skippable", "mixed", "header-crossing", "checksum", "bad-checksum"] as const)("keeps decode/checksum outcomes for %s", async name => {
    const before = await decoded(baseline, fixtures[name]), after = await decoded({ codexZstdFrames, decodeCodexZstdFrame }, fixtures[name]);
    expect(after).toEqual(before);
    if (name === "bad-checksum") expect(after.error).not.toBeNull(); else expect(after.error).toBeNull();
  });
  it("reduces skipped sparse bytes without increasing its read count", async () => {
    const before = await scan(baseline.codexZstdFrames, fixtures.sparse), after = await scan(codexZstdFrames, fixtures.sparse);
    expect(after.error).toBeNull(); expect(after.frames).toEqual(before.frames);
    expect(after.physicalBytes).toBeLessThan(before.physicalBytes / 64); expect(after.calls).toBeLessThanOrEqual(before.calls + 1);
  });
  it("bounds dense warm-up calls and preserves one-read tiny files", async () => {
    const before = await scan(baseline.codexZstdFrames, fixtures.dense), after = await scan(codexZstdFrames, fixtures.dense);
    expect(after.calls).toBeLessThanOrEqual(before.calls + 6); expect(after.physicalBytes).toBeLessThanOrEqual(before.physicalBytes + 128);
    expect((await scan(codexZstdFrames, fixtures.tiny)).calls).toBe(1);
  });
  it.each([1, 2, 7, 31])("fills short reads of %i bytes without changing frame boundaries", async maxRead => {
    const bytes = rawFrame(noise(256 * 1024));
    const before = await scan(baseline.codexZstdFrames, bytes, maxRead), after = await scan(codexZstdFrames, bytes, maxRead);
    expect(after.frames).toEqual(before.frames); expect(after.error).toBeNull();
  });
  it("rejects zero-progress physical reads with the original error", async () => {
    const before = await scan(baseline.codexZstdFrames, fixtures.sparse, 0), after = await scan(codexZstdFrames, fixtures.sparse, 0);
    expect(after.error).toEqual(before.error); expect(after.error?.message).toContain("shrank");
  });
  it("accounts for actual bytes and refuses the next reservation at the unchanged cap", async () => {
    const source = memoryFile(fixtures.sparse), budget = new CodexReadBudget({ maxPhysicalBytes: 300 });
    await expect((async () => { for await (const _ of codexZstdFrames(budget.physical(source.file), fixtures.sparse.length)) {} })()).rejects.toMatchObject({ reason: "physical_bytes" });
    expect(budget.usage().physicalBytes).toBe(source.stats().physicalBytes); expect(source.stats().physicalBytes).toBe(256); expect(source.stats().calls).toBe(1);
  });
  it("checks elapsed time after an awaited header read", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      const source = memoryFile(fixtures.sparse), originalRead = source.file.read;
      source.file.read = async (...args) => { const result = await originalRead(...args); clock.mockReturnValue(10); return result; };
      const budget = new CodexReadBudget({ maxMilliseconds: 5 });
      await expect((async () => { for await (const _ of codexZstdFrames(budget.physical(source.file), fixtures.sparse.length)) {} })()).rejects.toMatchObject({ reason: "elapsed_time" });
      expect(source.stats().calls).toBe(1);
    } finally { clock.mockRestore(); }
  });
  it("propagates cancellation during a short-read fill without another I/O", async () => {
    const controller = new AbortController(), source = memoryFile(fixtures.sparse, 7), originalRead = source.file.read;
    source.file.read = async (...args) => { const result = await originalRead(...args); controller.abort(); return result; };
    const budget = new CodexReadBudget({}, controller.signal);
    await expect((async () => { for await (const _ of codexZstdFrames(budget.physical(source.file), fixtures.sparse.length)) {} })()).rejects.toMatchObject({ name: "NativeSourceShutdownError" });
    expect(source.stats().calls).toBe(1); expect(budget.usage().physicalBytes).toBe(7);
  });
  it("rejects a snapshot changed during frame enumeration before invoking its consumer", async () => {
    const source = memoryFile(fixtures.sparse), originalRead = source.file.read, originalStat = source.file.stat;
    let changed = false, consumed = false;
    source.file.read = async (...args) => { const result = await originalRead(...args); changed = true; return result; };
    source.file.stat = async () => ({ ...await originalStat(), mtimeMs: changed ? 2 : 1 });
    await expect(withCodexCompressedFile(source.file, "synthetic-header-snapshot.zst", async () => { consumed = true; })).rejects.toThrow("changed while reading");
    expect(consumed).toBe(false);
  });
});
