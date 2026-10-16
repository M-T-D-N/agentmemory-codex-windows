import type { CodexSourceFile } from "../functions/codex-source-segments.js";

export interface CodexReadLimits {
  maxPhysicalBytes: number;
  maxDecodedBytes: number;
  maxMilliseconds: number;
  maxWindowBytes: number;
}

export interface CodexReadUsage extends CodexReadLimits {
  physicalBytes: number;
  decodedBytes: number;
  elapsedMilliseconds: number;
}

export class CodexReadBudgetError extends Error {
  constructor(readonly reason: "physical_bytes" | "decoded_bytes" | "elapsed_time", readonly usage: CodexReadUsage) {
    super("Codex source read budget exceeded");
    this.name = "CodexReadBudgetError";
  }
}

export class CodexReadBudget {
  private readonly startedAt = performance.now();
  private physicalBytes = 0;
  private decodedBytes = 0;
  readonly limits: CodexReadLimits;

  constructor(limits: Partial<CodexReadLimits> = {}) {
    this.limits = { maxPhysicalBytes: 8 * 1024 ** 3, maxDecodedBytes: 8 * 1024 ** 3,
      maxMilliseconds: 30_000, maxWindowBytes: 128 * 1024 ** 2, ...limits };
    for (const value of Object.values(this.limits)) if (!Number.isSafeInteger(value) || value < 1) throw Error("Invalid Codex read budget");
    if (this.limits.maxWindowBytes < 1024 || !Number.isInteger(Math.log2(this.limits.maxWindowBytes))) throw Error("Invalid Codex decoder window limit");
  }

  usage(): CodexReadUsage {
    return { ...this.limits, physicalBytes: this.physicalBytes, decodedBytes: this.decodedBytes,
      elapsedMilliseconds: Math.ceil(performance.now() - this.startedAt) };
  }

  check() {
    if (performance.now() - this.startedAt >= this.limits.maxMilliseconds)
      throw new CodexReadBudgetError("elapsed_time", this.usage());
  }

  decoded(bytes: number) {
    this.check();
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw Error("Invalid Codex decoded byte count");
    this.decodedBytes += bytes;
    if (this.decodedBytes > this.limits.maxDecodedBytes)
      throw new CodexReadBudgetError("decoded_bytes", this.usage());
  }

  physical(file: CodexSourceFile): CodexSourceFile {
    return {
      stat: async () => { this.check(); const result = await file.stat(); this.check(); return result; },
      read: async (buffer, offset, length, position) => {
        this.check();
        if (length > this.limits.maxPhysicalBytes - this.physicalBytes)
          throw new CodexReadBudgetError("physical_bytes", this.usage());
        this.physicalBytes += length;
        const result = await file.read(buffer, offset, length, position);
        this.physicalBytes -= length - result.bytesRead;
        this.check();
        return result;
      },
    };
  }
}
