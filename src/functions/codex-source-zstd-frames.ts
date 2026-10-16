import { Readable } from "node:stream";
import { constants, createZstdDecompress } from "node:zlib";
import type { CodexSourceFile } from "./codex-source-segments.js";
import type { CodexReadBudget } from "../replay/codex-read-budget.js";

interface Frame { start: number; end: number; size?: number }

// RFC 8878 container boundaries keep Node's single-frame decoder from dropping later frames.
export async function* codexZstdFrames(file: CodexSourceFile, physicalSize: number): AsyncGenerator<Frame> {
  let position = 0, windowAt = -1, window = Buffer.alloc(0);
  const bytes = async (at: number, length: number) => {
    if (at + length > physicalSize) throw Error("Codex compressed source is truncated");
    if (at < windowAt || at + length > windowAt + window.length) {
      windowAt = at; window = Buffer.alloc(Math.min(64 * 1024, physicalSize - at));
      let count = 0;
      while (count < window.length) {
        const result = await file.read(window, count, window.length - count, at + count);
        if (!result.bytesRead) throw Error("Codex compressed source shrank while reading");
        count += result.bytesRead;
      }
    }
    return window.subarray(at - windowAt, at - windowAt + length);
  };
  while (position < physicalSize) {
    const start = position, magic = (await bytes(position, 4)).readUInt32LE();
    if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) {
      position += 8 + (await bytes(position + 4, 4)).readUInt32LE();
      if (position > physicalSize) throw Error("Codex compressed skippable frame is truncated");
      continue;
    }
    if (magic !== 0xfd2fb528) throw Error("Unsupported Codex compressed frame header");
    const descriptor = (await bytes(position + 4, 1))[0]!;
    if (descriptor & 8) throw Error("Unsupported Codex compressed frame header");
    const single = Boolean(descriptor & 0x20), width = [single ? 1 : 0, 2, 4, 8][descriptor >>> 6]!;
    position += 5 + Number(!single) + [0, 1, 2, 4][descriptor & 3]!;
    let size: number | undefined;
    if (width) {
      const field = await bytes(position, width);
      size = width === 8 ? Number(field.readBigUInt64LE()) : field.readUIntLE(0, width) + (width === 2 ? 256 : 0);
      if (!Number.isSafeInteger(size)) throw Error("Invalid Codex compressed original size");
    }
    position += width;
    let last = false;
    while (!last) {
      const block = (await bytes(position, 3)).readUIntLE(0, 3);
      const type = (block >>> 1) & 3, length = block >>> 3;
      if (type === 3 || length > 128 * 1024) throw Error("Invalid Codex compressed block header");
      last = Boolean(block & 1); position += 3 + (type === 1 ? 1 : length);
      if (position > physicalSize) throw Error("Codex compressed source is truncated");
    }
    if (descriptor & 4) position += 4;
    if (position > physicalSize) throw Error("Codex compressed checksum is truncated");
    yield { start, end: position, ...(size === undefined ? {} : { size }) };
  }
}

export async function* decodeCodexZstdFrame(file: CodexSourceFile, frame: Frame, budget?: CodexReadBudget): AsyncGenerator<Buffer> {
  const stream = Readable.from((async function* () {
    let position = frame.start;
    while (position < frame.end) {
      const bytes = Buffer.alloc(Math.min(64 * 1024, frame.end - position));
      const { bytesRead } = await file.read(bytes, 0, bytes.length, position);
      if (!bytesRead) throw Error("Codex compressed source shrank while reading");
      position += bytesRead; yield bytes.subarray(0, bytesRead);
    }
  })());
  const windowLogMax = budget ? Math.log2(budget.limits.maxWindowBytes) : 27;
  const decoder = createZstdDecompress({ params: { [constants.ZSTD_d_windowLogMax]: windowLogMax } });
  stream.on("error", error => decoder.destroy(error)); stream.pipe(decoder);
  let count = 0;
  try {
    for await (const chunk of decoder) { count += chunk.length; yield Buffer.from(chunk); }
    if (frame.size !== undefined && count !== frame.size) throw Error("Codex compressed original size does not match");
  } finally { stream.unpipe(); stream.destroy(); decoder.destroy(); }
}
