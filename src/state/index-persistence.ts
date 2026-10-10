import { VectorPersistence, type IndexPersistenceStatus } from "./vector-persistence.js";
export type { IndexLegStatus, IndexPersistenceStatus, VectorLoadState, VectorLoadResult, PendingReplayResult } from "./vector-persistence.js";
import { createHash } from "node:crypto";
import { SearchIndex } from "./search-index.js";
import { VectorIndex } from "./vector-index.js";
import type { StateKV } from "./kv.js";
import { KV, generateId } from "./schema.js";
import { logger } from "../logger.js";
import { safeAudit } from "../functions/audit.js";

const DEBOUNCE_MS = 5000;
const FAILURE_LOG_THROTTLE_MS = 60_000;
const INDEX_PERSISTENCE_FUNCTION_ID = "mem::index-persistence";
const BM25_KEY = "data";
const BM25_MANIFEST_KEY = "data:manifest";
const BM25_SHARD_SCOPE_PREFIX = `${KV.bm25Index}:bm25:`;
const INDEX_SHARD_KEY = "data";
const DEFAULT_INDEX_SHARD_CHARS = 2_000_000;
const INDEX_READ_BATCH = 4;

type IndexShardManifest = {
  v: 1;
  generation?: string;
  shards: Array<{ scope: string; key: string; chars: number }>;
  obsoleteShards?: Array<{ scope: string; key: string; chars: number }>;
  chars: number;
};

type IndexPersistenceOptions = {
  shardChars?: number;
  createGeneration?: () => string;
};

function shardChars(options: IndexPersistenceOptions): number {
  const configured = options.shardChars;
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return DEFAULT_INDEX_SHARD_CHARS;
  }
  const wholeChars = Math.floor(configured);
  return wholeChars >= 1 ? wholeChars : DEFAULT_INDEX_SHARD_CHARS;
}

function createIndexGeneration(): string {
  return generateId("idx");
}

function statePath(scope: string, key: string): string {
  return `${scope}/${key}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isValidShardDescriptor(
  shard: unknown,
): shard is IndexShardManifest["shards"][number] {
  if (!shard || typeof shard !== "object") return false;
  const candidate = shard as { scope?: unknown; key?: unknown; chars?: unknown };
  return (
    typeof candidate.scope === "string" &&
    candidate.scope.length > 0 &&
    typeof candidate.key === "string" &&
    candidate.key.length > 0 &&
    typeof candidate.chars === "number" &&
    Number.isInteger(candidate.chars) &&
    candidate.chars >= 0
  );
}

export class IndexPersistence {
  private readonly vectorPersistence: VectorPersistence;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastFailureLogAt = 0;
  private saving = false;
  private pendingSave: { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void } | null = null;
  private retryAttempts = 0;
  private stopped = false;
  private persistedContent = new Map<string, { fingerprint: string; manifest: IndexShardManifest }>();
  private persistedBm25Revision: number | undefined;

  constructor(
    private kv: StateKV,
    private bm25: SearchIndex,
    vector: VectorIndex | null,
    private options: IndexPersistenceOptions = {},
  ) { this.vectorPersistence = new VectorPersistence(kv, vector); }

  status(): IndexPersistenceStatus { return this.vectorPersistence.status(); }
  replayPendingLog(expectedDimensions = 0) { return this.vectorPersistence.replayPendingLog(expectedDimensions); }
  readBackfillMarker() { return this.vectorPersistence.readBackfillMarker(); }
  markBackfillSince(since: string) { return this.vectorPersistence.markBackfillSince(since); }
  clearBackfillMarker() { return this.vectorPersistence.clearBackfillMarker(); }
  flushPendingLog() { return this.vectorPersistence.flushPendingLog(); }

  scheduleSave(): void {
    if (this.stopped) return;
    this.vectorPersistence.scheduleSave();
    this.retryAttempts = 0;
    this.reserveSave(DEBOUNCE_MS);
  }

  private reserveSave(delay: number): void {
    if (this.timer || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.enqueueSave().catch(() => {});
    }, delay);
    this.timer.unref?.();
  }

  async save(options: { requireSuccess?: boolean } = {}): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.retryAttempts = 0;
    const outcomes = await Promise.allSettled([
      this.enqueueSave(),
      this.vectorPersistence.save({ requireSuccess: true }),
    ]);
    try {
      const failed = outcomes.find(result => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    }
    catch (error) { if (options.requireSuccess) throw error; }
  }

  private enqueueSave(): Promise<void> {
    if (!this.pendingSave) {
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
      this.pendingSave = { promise, resolve, reject };
    }
    const promise = this.pendingSave.promise;
    if (!this.saving) void this.drainSaves();
    return promise;
  }

  private async drainSaves(): Promise<void> {
    this.saving = true;
    try {
      while (this.pendingSave) {
        const batch = this.pendingSave;
        this.pendingSave = null;
        try {
          await this.saveCurrent();
          this.retryAttempts = 0;
          batch.resolve();
        } catch (error) {
          this.logFailure(error);
          batch.reject(error);
          if (!this.pendingSave && this.retryAttempts < 3) {
            this.reserveSave([5000, 15000, 30000][this.retryAttempts++]);
          }
        }
      }
    } finally { this.saving = false; }
  }

  private async saveCurrent(): Promise<void> {
    const persisted = this.persistedContent.get(BM25_MANIFEST_KEY);
    const revision = this.persistedBm25Revision;
    if (revision === undefined || revision !== this.bm25.revision || !persisted || persisted.manifest.obsoleteShards?.length ||
        !await this.isManifestPublished(BM25_MANIFEST_KEY, persisted.manifest) || revision !== this.bm25.revision) {
      this.persistedBm25Revision = undefined;
      const snapshotRevision = this.bm25.revision;
      await this.saveBm25Index(this.bm25.serialize());
      this.persistedBm25Revision = snapshotRevision;
    }
  }

  async load(): Promise<{
    bm25: SearchIndex | null;
    vector: VectorIndex | null;
    state: import("./vector-persistence.js").VectorLoadState;
    savedAt: string | null;
    expectedCount?: number;
  }> {
    this.persistedBm25Revision = undefined;
    try {
      let bm25: SearchIndex | null = null;
      let vector: VectorIndex | null = null;

      const bm25Data = await this.loadBm25Data();
      if (bm25Data && typeof bm25Data === "string") {
        bm25 = SearchIndex.deserialize(bm25Data);
      }

      const loaded = await this.vectorPersistence.load();
      vector = loaded.vector;

      return { ...loaded, bm25, vector };
    } finally {
      this.persistedBm25Revision = undefined;
    }
  }

  stop(): void {
    this.stopped = true;
    this.vectorPersistence.stop();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private logFailure(err: unknown): void {
    const now = Date.now();
    // Throttle: persistence failures under load arrive in bursts
    // (iii-engine queue pressure). Logging every debounce flush adds
    // noise without information.
    if (now - this.lastFailureLogAt < FAILURE_LOG_THROTTLE_MS) return;
    this.lastFailureLogAt = now;
    const code = (err as { code?: string })?.code;
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("index persistence: failed to save BM25/vector index", {
      code,
      message,
      hint:
        code === "TIMEOUT"
          ? "iii-engine state::set timed out; recent index updates remain in memory; scheduled failures retry up to three times and later writes can retry again"
          : undefined,
    });
  }

  private async saveBm25Index(serialized: string): Promise<void> {
    await this.saveShardedIndex(
      serialized,
      BM25_MANIFEST_KEY,
      BM25_KEY,
      BM25_SHARD_SCOPE_PREFIX,
    );
  }


  private async saveShardedIndex(
    serialized: string,
    manifestKey: string,
    legacyKey: string,
    scopePrefix: string,
  ): Promise<void> {
    // Hash the actual snapshot, including vector buffers retained by callers.
    // A mutation counter at save-request sites would miss those changes.
    const fingerprint = createHash("sha256").update(serialized).digest("hex");
    const persisted = this.persistedContent.get(manifestKey);
    if (persisted?.fingerprint === fingerprint &&
        await this.isManifestPublished(manifestKey, persisted.manifest)) {
      persisted.manifest = await this.cleanupObsoleteShards(manifestKey, persisted.manifest);
      return;
    }

    const previous = await this.kv.get<IndexShardManifest>(KV.bm25Index, manifestKey);
    if (previous?.v === 1) this.validateObsoleteShards(manifestKey, previous);
    const obsolete = previous?.v === 1 ? [...(previous.shards ?? []), ...(previous.obsoleteShards ?? [])] : [];
    if (obsolete.some(shard => !isValidShardDescriptor(shard) || !shard.scope.startsWith(scopePrefix) || shard.key !== INDEX_SHARD_KEY)) {
      throw new Error("Invalid obsolete index shard descriptor; preserving existing state");
    }
    const generation =
      this.options.createGeneration?.() ?? createIndexGeneration();
    const chunkChars = shardChars(this.options);
    const shards: IndexShardManifest["shards"] = [];
    const chunks: string[] = [];

    for (let offset = 0; offset < serialized.length; offset += chunkChars) {
      const shardIndex = shards.length;
      const scope = `${scopePrefix}${generation}:${String(shardIndex).padStart(
        5,
        "0",
      )}`;
      const chunk = serialized.slice(offset, offset + chunkChars);
      shards.push({ scope, key: INDEX_SHARD_KEY, chars: chunk.length });
      chunks.push(chunk);
    }

    const pendingManifest: IndexShardManifest = previous?.v === 1
      ? { ...previous }
      : { v: 1, generation, shards: [], chars: 0 };
    pendingManifest.obsoleteShards = [...new Map(
      [...(pendingManifest.obsoleteShards ?? []), ...shards]
        .map(shard => [shard.scope + "\0" + shard.key, shard]),
    ).values()];
    this.validateObsoleteShards(manifestKey, pendingManifest);
    // Record unpublished shards durably before their first write so a process
    // exit cannot strand a generation outside the existing cleanup queue.
    this.persistedContent.delete(manifestKey);
    await this.kv.set(KV.bm25Index, manifestKey, pendingManifest);
    await this.auditIndexPersistence("generation_prepare", [statePath(KV.bm25Index, manifestKey)], {
      manifestKey, generation, shards: shards.length,
    });
    // iii-state serializes file-backed writes. Fanning every multi-megabyte
    // shard out at once saturates that single writer, delays foreground MCP
    // calls, and can make the HTTP proxy abort the worker connection before
    // the snapshot finishes. Keep only one large state::set in flight and
    // emit one generation-level audit row instead of another state write per
    // shard. A failed set may have committed before rejecting, so rollback
    // every shard whose write was attempted.
    const attemptedShards: IndexShardManifest["shards"] = [];
    try {
      for (let index = 0; index < shards.length; index++) {
        const shard = shards[index];
        const chunk = chunks[index] ?? "";
        attemptedShards.push(shard);
        await this.kv.set(shard.scope, shard.key, chunk);
      }
    } catch (err) {
      await this.deleteShards(attemptedShards, "shard_write_rollback");
      throw err;
    }
    await this.auditIndexPersistence(
      "shard_write",
      shards.map((shard) => statePath(shard.scope, shard.key)),
      {
        manifestKey,
        generation,
        chars: serialized.length,
        shards: shards.length,
      },
    );

    let nextManifest: IndexShardManifest = {
      v: 1,
      generation,
      shards,
      chars: serialized.length,
    };
    const currentShardIds = new Set(shards.map(shard => shard.scope + "\0" + shard.key));
    const obsoleteById = new Map(obsolete.map(shard => [shard.scope + "\0" + shard.key, shard]));
    for (const id of currentShardIds) obsoleteById.delete(id);
    if (obsoleteById.size) nextManifest.obsoleteShards = [...obsoleteById.values()];
    let publicationError: unknown;
    try {
      await this.kv.set<IndexShardManifest>(
        KV.bm25Index,
        manifestKey,
        nextManifest,
      );
      await this.auditIndexPersistence("manifest_publish", [
        statePath(KV.bm25Index, manifestKey),
      ], {
        manifestKey,
        generation,
        chars: serialized.length,
        shards: shards.length,
        result: "committed",
      });
    } catch (err) {
      let published: boolean;
      try {
        published = await this.isManifestPublished(manifestKey, nextManifest);
      } catch (verificationError) {
        await this.auditIndexPersistence("manifest_publish", [statePath(KV.bm25Index, manifestKey)], {
          manifestKey, generation, result: "unknown", error: errorMessage(err),
          verificationError: errorMessage(verificationError),
        });
        throw new AggregateError([err, verificationError], "Index manifest publication outcome is unknown; preserving all shards");
      }
      if (published) {
        await this.auditIndexPersistence("manifest_publish", [
          statePath(KV.bm25Index, manifestKey),
        ], {
          manifestKey,
          generation,
          chars: serialized.length,
          shards: shards.length,
          result: "committed_after_error",
          error: errorMessage(err),
        });
        publicationError = err;
      } else {
        await this.deleteShards(shards, "manifest_publish_rollback");
        throw err;
      }
    }

    await this.deleteKey(KV.bm25Index, legacyKey, "legacy_cleanup");
    nextManifest = await this.cleanupObsoleteShards(manifestKey, nextManifest);
    if (publicationError !== undefined) throw publicationError;
    this.persistedContent.set(manifestKey, { fingerprint, manifest: structuredClone(nextManifest) });
  }

  private async auditIndexPersistence(
    action: string,
    targetIds: string[],
    details: Record<string, unknown>,
  ): Promise<void> {
    await safeAudit(
      this.kv,
      "index_persist",
      INDEX_PERSISTENCE_FUNCTION_ID,
      targetIds,
      { action, ...details },
    );
  }

  private async deleteKey(
    scope: string,
    key: string,
    reason: string,
  ): Promise<void> {
    await this.deleteShards([{ scope, key, chars: 0 }], reason);
  }

  private async deleteShards(
    shards: IndexShardManifest["shards"],
    reason: string,
  ): Promise<IndexShardManifest["shards"]> {
    if (!shards.length) return [];
    const failed: IndexShardManifest["shards"] = [];
    const results: Array<{ scope: string; key: string; result: string; error?: string }> = [];
    for (const shard of shards) {
      const { scope, key } = shard;
      try {
        await this.kv.delete(scope, key);
        results.push({ scope, key, result: "deleted" });
      } catch (err) {
        failed.push(shard);
        results.push({ scope, key, result: "failed", error: errorMessage(err) });
      }
    }
    await this.auditIndexPersistence("delete", shards.map(shard => statePath(shard.scope, shard.key)), {
      reason,
      result: results.some(row => row.result === "failed") ? "partial_failure" : "deleted",
      results,
    });
    return failed;
  }

  private validateObsoleteShards(_manifestKey: string, manifest: IndexShardManifest): void {
    if (manifest.obsoleteShards === undefined) return;
    const prefix = BM25_SHARD_SCOPE_PREFIX;
    const active = new Set(manifest.shards.map(shard => shard.scope + "\0" + shard.key));
    if (!Array.isArray(manifest.obsoleteShards) || manifest.obsoleteShards.some(shard =>
      !isValidShardDescriptor(shard) || !shard.scope.startsWith(prefix) || shard.key !== INDEX_SHARD_KEY || active.has(shard.scope + "\0" + shard.key))) {
      throw new Error("Invalid obsolete index shard descriptor; preserving existing state");
    }
  }

  private async cleanupObsoleteShards(manifestKey: string, manifest: IndexShardManifest): Promise<IndexShardManifest> {
    this.validateObsoleteShards(manifestKey, manifest);
    if (!manifest.obsoleteShards?.length) return manifest;
    const failed = await this.deleteShards(manifest.obsoleteShards, "previous_generation_cleanup");
    if (failed.length === manifest.obsoleteShards.length) return manifest;
    const next = { ...manifest };
    if (failed.length) next.obsoleteShards = failed;
    else delete next.obsoleteShards;
    await this.kv.set(KV.bm25Index, manifestKey, next);
    return next;
  }

  private async isManifestPublished(
    manifestKey: string,
    expected: IndexShardManifest,
  ): Promise<boolean> {
    const published = await this.kv.get<IndexShardManifest>(KV.bm25Index, manifestKey);
    if (
      published?.v !== 1 ||
      published.generation !== expected.generation ||
      published.chars !== expected.chars ||
      !Array.isArray(published.shards) ||
      published.shards.length !== expected.shards.length
    ) {
      return false;
    }
    return published.shards.every((shard, index) => {
      const expectedShard = expected.shards[index];
      if (!expectedShard) return false;
      return (
        shard.scope === expectedShard.scope &&
        shard.key === expectedShard.key &&
        shard.chars === expectedShard.chars
      );
    });
  }

  private async loadBm25Data(): Promise<string | null> {
    return this.loadShardedData(BM25_KEY, BM25_MANIFEST_KEY, "BM25");
  }


  private async loadShardedData(
    legacyKey: string,
    manifestKey: string,
    label: string,
  ): Promise<string | null> {
    const manifest = await this.readIndexValue<IndexShardManifest>(
      KV.bm25Index,
      manifestKey,
      label,
      "manifest",
    );
    if (!manifest.ok) return null;
    // #797: some iii-state adapters return `undefined` (not `null`) for
    // a missing key. The previous `value !== null` check passed
    // undefined through to loadManifestData, which then crashed on
    // `manifest.v` with TypeError. Treat both null and undefined as
    // "no manifest" and fall through to the legacy path. The shape
    // check stays so a malformed-but-present row still fails closed.
    if (
      manifest.value != null &&
      typeof manifest.value === "object"
    ) {
      const value = manifest.value;
      if (value.v !== 1 || value.chars !== 0 || !Array.isArray(value.shards) || value.shards.length !== 0 ||
          typeof value.generation !== "string" || !value.generation || !value.obsoleteShards?.length) {
        return this.loadManifestData(value, label);
      }
      try { this.validateObsoleteShards(manifestKey, value); }
      catch (err) {
        logger.warn(`index persistence: ${label} pending manifest invalid`, { message: errorMessage(err) });
        return null;
      }
    }

    const legacy = await this.readIndexValue<string>(
      KV.bm25Index,
      legacyKey,
      label,
      "legacy",
    );
    if (!legacy.ok) return null;
    if (legacy.value && typeof legacy.value === "string") return legacy.value;
    return null;
  }

  private async readIndexValue<T>(
    scope: string,
    key: string,
    label: string,
    source: "manifest" | "legacy",
  ): Promise<{ ok: true; value: T | null } | { ok: false }> {
    try {
      return { ok: true, value: await this.kv.get<T>(scope, key) };
    } catch (err) {
      logger.warn(`index persistence: ${label} ${source} read failed`, {
        scope,
        key,
        message: errorMessage(err),
      });
      return { ok: false };
    }
  }

  private async loadManifestData(
    manifest: IndexShardManifest,
    label: string,
  ): Promise<string | null> {
    if (
      manifest.v !== 1 ||
      !Array.isArray(manifest.shards) ||
      manifest.shards.length === 0 ||
      !Number.isInteger(manifest.chars) ||
      manifest.chars < 0
    ) {
      logger.warn(`index persistence: ${label} shard manifest invalid`);
      return null;
    }
    for (const shard of manifest.shards) {
      if (!isValidShardDescriptor(shard)) {
        logger.warn(`index persistence: ${label} shard manifest invalid`);
        return null;
      }
    }
    const chunks: string[] = [];
    let chars = 0;
    for (let offset = 0; offset < manifest.shards.length; offset += INDEX_READ_BATCH) {
      const loadedShards = await Promise.all(manifest.shards.slice(offset, offset + INDEX_READ_BATCH).map(async shard => ({
        shard, chunk: await this.kv.get<string>(shard.scope, shard.key).catch(() => null),
      })));
      for (const { shard, chunk } of loadedShards) {
        if (typeof chunk !== "string") {
          logger.warn(`index persistence: ${label} shard missing`, {
            scope: shard.scope,
            key: shard.key,
          });
          return null;
        }
        if (chunk.length !== shard.chars) {
          logger.warn(`index persistence: ${label} shard length mismatch`, {
            scope: shard.scope,
            key: shard.key,
            expected: shard.chars,
            actual: chunk.length,
          });
          return null;
        }
        chunks.push(chunk);
        chars += chunk.length;
      }
    }
    if (chars !== manifest.chars) {
      logger.warn(`index persistence: ${label} total length mismatch`, {
        expected: manifest.chars,
        actual: chars,
      });
      return null;
    }
    const serialized = chunks.join("");
    const key = BM25_MANIFEST_KEY;
    this.persistedContent.set(key, { fingerprint: createHash("sha256").update(serialized).digest("hex"), manifest: structuredClone(manifest) });
    return serialized;
  }
}
