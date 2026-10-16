import { describe, expect, it, vi } from "vitest";
import { CodexReadBudget, CodexReadBudgetError } from "../src/replay/codex-read-budget.js";

describe("shared native source read budget", () => {
  const file = (read = vi.fn(async (_buffer: Buffer, _offset: number, length: number) => ({ bytesRead: length, buffer: _buffer }))) => ({
    stat: async () => ({ dev: 1, ino: 2, size: 100, mtimeMs: 0 }), read,
  });
  it("shares physical reservations across independent source handles", async () => {
    const budget = new CodexReadBudget({ maxPhysicalBytes: 10 });
    const first = file(), second = file();
    await budget.physical(first).read(Buffer.alloc(8), 0, 8, 0);
    await expect(budget.physical(second).read(Buffer.alloc(3), 0, 3, 0)).rejects.toMatchObject({ reason: "physical_bytes" });
    expect(second.read).not.toHaveBeenCalled();
    expect(budget.usage().physicalBytes).toBe(8);
  });
  it("accounts for observed decoded output even when one decoder chunk crosses its limit", () => {
    const budget = new CodexReadBudget({ maxDecodedBytes: 4 });
    expect(() => budget.decoded(16)).toThrow(CodexReadBudgetError);
    expect(budget.usage().decodedBytes).toBe(16);
  });
  it("checks time after an awaited read without pretending to forcibly cancel that read", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      const budget = new CodexReadBudget({ maxMilliseconds: 5 });
      const physical = file(vi.fn(async buffer => { clock.mockReturnValue(10); return { bytesRead: 1, buffer }; }));
      await expect(budget.physical(physical).read(Buffer.alloc(1), 0, 1, 0)).rejects.toMatchObject({ reason: "elapsed_time" });
      expect(physical.read).toHaveBeenCalledTimes(1);
    } finally { clock.mockRestore(); }
  });
  it("refuses invalid byte limits and decoder window sizes", () => {
    expect(() => new CodexReadBudget({ maxPhysicalBytes: 0 })).toThrow();
    expect(() => new CodexReadBudget({ maxWindowBytes: 1000 })).toThrow();
    expect(() => new CodexReadBudget({ maxWindowBytes: 3000 })).toThrow();
  });
});
