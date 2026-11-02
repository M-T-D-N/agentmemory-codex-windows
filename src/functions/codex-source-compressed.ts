import { codexZstdFrames, decodeCodexZstdFrame, type CodexZstdFrame } from "./codex-source-zstd-frames.js";
import type { CodexSourceFile } from "./codex-source-segments.js";
import type { CodexReadBudget } from "../replay/codex-read-budget.js";

interface FrameCatalog { size: number; frames?: readonly CodexZstdFrame[] }
const catalogs = new Map<string, FrameCatalog>();
const maximumCatalogFrames = 4096;
const maximumCachedFrames = 16_384;
let cachedFrames = 0;
function forgetCatalog(key: string) {
  const prior = catalogs.get(key);
  cachedFrames -= prior?.frames?.length ?? 0;
  catalogs.delete(key);
}
function rememberCatalog(key: string, catalog: FrameCatalog) {
  forgetCatalog(key);
  catalogs.set(key, catalog); cachedFrames += catalog.frames?.length ?? 0;
  while (catalogs.size > 256 || cachedFrames > maximumCachedFrames) forgetCatalog(catalogs.keys().next().value!);
}
async function* decodedChunks(physical: CodexSourceFile, size: number, frames: readonly CodexZstdFrame[] | undefined, budget?: CodexReadBudget) {
  for await (const frame of frames ?? codexZstdFrames(physical, size)) {
    for await (const chunk of decodeCodexZstdFrame(physical, frame, budget)) { budget?.decoded(chunk.length); yield chunk; }
  }
}

interface CachedRead { file: string; start: number; bytes: Buffer; checkpoint: boolean }
const reads = new Map<string, CachedRead>();
let cachedBytes = 0;
let checkpointBytes = 0;
const maximumCachedBytes = 32 * 1024 * 1024;
const prefetchBytes = 4 * 1024 * 1024;
const maximumRetainedBytes = prefetchBytes + 256 * 1024;
function remember(key: string, file: string, start: number, bytes: Buffer, checkpoint = false) {
  if (bytes.length > maximumCachedBytes) return;
  const discard = (id: string) => {
    const row = reads.get(id)!; cachedBytes -= row.bytes.length;
    if (row.checkpoint) checkpointBytes -= row.bytes.length;
    reads.delete(id);
  };
  if (reads.has(key)) discard(key);
  checkpoint = checkpoint && bytes.length <= 64 * 1024;
  const saved = Buffer.from(bytes); reads.set(key, { file, start, bytes: saved, checkpoint }); cachedBytes += saved.length;
  if (checkpoint) checkpointBytes += saved.length;
  while (cachedBytes > maximumCachedBytes || reads.size > 1024 || checkpointBytes > 8 * 1024 * 1024) {
    let victim: string | undefined;
    for (const [id, row] of reads) if (checkpointBytes > 8 * 1024 * 1024 ? row.checkpoint : !row.checkpoint) { victim = id; break; }
    discard(victim ?? reads.keys().next().value!);
  }
}

export async function withCodexCompressedFile<T>(physical: CodexSourceFile, path: string,
  read: (file: CodexSourceFile) => Promise<T>, budget?: CodexReadBudget): Promise<T> {
  const snapshot = await physical.stat();
  const key = JSON.stringify([path, snapshot.dev, snapshot.ino, snapshot.size, snapshot.mtimeMs]);
  const verify = async () => {
    const current = await physical.stat();
    if (current.dev !== snapshot.dev || current.ino !== snapshot.ino || current.size !== snapshot.size || current.mtimeMs !== snapshot.mtimeMs) throw Error("Codex compressed source changed while reading");
  };
  let catalog = catalogs.get(key);
  if (catalog === undefined) {
    let total = 0;
    let frames: CodexZstdFrame[] | undefined = [];
    for await (const frame of codexZstdFrames(physical, snapshot.size)) {
      if (frames && frames.length < maximumCatalogFrames) frames.push(frame); else frames = undefined;
      if (frame.size !== undefined) total += frame.size;
      else for await (const chunk of decodeCodexZstdFrame(physical, frame, budget)) { budget?.decoded(chunk.length); total += chunk.length; }
      if (!Number.isSafeInteger(total)) throw Error("Invalid Codex compressed original size");
    }
    await verify(); catalog = { size: total, ...(frames ? { frames } : {}) }; rememberCatalog(key, catalog);
  }
  const originalSize = catalog.size, frames = catalog.frames;
  let active = true;
  const assertActive = () => { if (!active) throw Error("Codex compressed read scope is closed"); };

  let iterator: AsyncGenerator<Buffer> | undefined;
  let through = 0, tailBytes = 0, done = false;
  let tail: Buffer[] = [];
  const stop = async () => { const previous = iterator; iterator = undefined; await previous?.return(undefined); };
  const start = async () => {
    await stop(); through = 0; tail = []; tailBytes = 0; done = false;
    iterator = decodedChunks(physical, snapshot.size, frames, budget);
  };
  const next = async (retainFrom = 0) => {
    const item = await iterator!.next();
    if (item.done) { done = true; if (through !== originalSize) throw Error("Codex compressed original size does not match"); return; }
    const chunk = item.value; const at = through; through += chunk.length;
    if (through > originalSize) throw Error("Codex compressed original exceeds its verified original size");
    if (through <= retainFrom) { tail = []; tailBytes = 0; return; }
    remember(JSON.stringify([key, at, chunk.length]), key, at, chunk);
    tail.push(chunk); tailBytes += chunk.length;
    while (tailBytes > maximumRetainedBytes) {
      const first = tail[0]!, remove = Math.min(first.length, tailBytes - maximumRetainedBytes);
      if (remove === first.length) tail.shift(); else tail[0] = first.subarray(remove);
      tailBytes -= remove;
    }
  };
  try {
    return await read({
      async stat() {
        assertActive();
        await verify();
        return { dev: snapshot.dev, ino: snapshot.ino, size: originalSize, mtimeMs: snapshot.mtimeMs, identity: "zstd:" + key };
      },
      async read(buffer, offset, length, position) {
        assertActive();
        budget?.check();
        if (!Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(length) || length < 0 || offset < 0 || offset + length > buffer.length) throw Error("Invalid compressed source read");
        const count = Math.min(length, Math.max(0, originalSize - position));
        const cacheKey = JSON.stringify([key, position, count]); const cached = reads.get(cacheKey);
        if (cached) { await verify(); reads.delete(cacheKey); reads.set(cacheKey, cached); cached.bytes.copy(buffer, offset); return { bytesRead: cached.bytes.length, buffer }; }
        let copied = 0;
        while (copied < count) {
          const at = position + copied;
          let match: [string, CachedRead] | undefined;
          for (const entry of reads) {
            const range = entry[1];
            if (range.file === key && range.start <= at && at < range.start + range.bytes.length) { match = entry; break; }
          }
          if (!match) break;
          const [cacheId, range] = match;
          const n = Math.min(count - copied, range.start + range.bytes.length - at);
          range.bytes.copy(buffer, offset + copied, at - range.start, at - range.start + n); copied += n;
          reads.delete(cacheId); reads.set(cacheId, range);
        }
        if (copied === count) { await verify(); return { bytesRead: copied, buffer }; }

        if (!iterator || position + copied < through - tailBytes) await start();
        while (copied < count) {
          const at = position + copied;
          while (!done && through <= at) await next(at);
          if (done && through <= at) throw Error("Codex compressed source is truncated");
          const tailAt = at - (through - tailBytes);
          if (tailAt < 0) throw Error("Compressed source read exceeded the streaming window");
          const n = Math.min(count - copied, through - at);
          let skip = tailAt, remaining = n;
          for (const chunk of tail) {
            if (skip >= chunk.length) { skip -= chunk.length; continue; }
            const bytes = Math.min(remaining, chunk.length - skip);
            chunk.copy(buffer, offset + copied, skip, skip + bytes); copied += bytes; remaining -= bytes;
            skip = 0;
            if (remaining === 0) break;
          }
          if (remaining !== 0) throw Error("Compressed source read exceeded the streaming window");
        }
        if (position + count === originalSize) { while (!done) await next(); }
        const prefetchEnd = Math.min(originalSize, position + count + prefetchBytes);
        while (!done && (through < prefetchEnd || prefetchEnd === originalSize)) await next();
        await verify();
        remember(cacheKey, key, position, buffer.subarray(offset, offset + copied), true);
        return { bytesRead: copied, buffer };
      },
    });
  } catch (error) {
    forgetCatalog(key);
    for (const [cacheId, range] of reads) if (range.file === key) {
      cachedBytes -= range.bytes.length; if (range.checkpoint) checkpointBytes -= range.bytes.length; reads.delete(cacheId);
    }
    throw error;
  } finally { active = false; await stop(); }
}
