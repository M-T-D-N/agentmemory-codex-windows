import type { AutomaticRetrievalPolicy } from "../state/hybrid-search.js";
import type { ISdk } from 'iii-sdk'
import type { CompactSearchResult, CompressedObservation, Memory, SearchResult, Session } from '../types.js'
import { KV } from '../state/schema.js'
import { StateKV } from '../state/kv.js'
import { SearchIndex } from '../state/search-index.js'
import { VectorIndex } from '../state/vector-index.js'
import type { EmbeddingProvider } from '../types.js'
import { memoryToObservation } from '../state/memory-utils.js'
import { recordAccessBatch } from './access-tracker.js'
import { logger } from "../logger.js";
import { createSearchCandidateSelection, type SearchCandidateSelection } from "./search-candidates.js";
import { getAgentId, isAgentScopeIsolated } from "../config.js";
import { observationSourceKind } from "./observation-visibility.js";

let index: SearchIndex | null = null
let vectorIndex: VectorIndex | null = null
let currentEmbeddingProvider: EmbeddingProvider | null = null

// Hybrid ranking hook for mem::search. Wired by index.ts once the
// hybrid searcher exists (it is constructed after this module's
// registration runs). When set and the vector index has entries,
// mem::search ranks candidates through the full BM25+vector+graph
// fusion instead of BM25 alone — previously only mem::smart-search got
// hybrid ranking while the primary recall surface stayed keyword-only.
type HybridRanker = (
  query: string,
  limit: number,
  selection?: SearchCandidateSelection,
  policy?: AutomaticRetrievalPolicy,
) => Promise<Array<{ observation: CompressedObservation; sessionId: string; combinedScore: number }>>
let hybridRanker: HybridRanker | null = null

export function setHybridRanker(fn: HybridRanker | null): void {
  hybridRanker = fn
}

// Dedupes the lazy cold-start rebuild kicked off from the mem::search
// request path. A full rebuildIndex walks every observation across every
// session, so N concurrent queries against an empty index would each
// launch their own rebuild and saturate the engine invocation pool. The
// first query with an empty index starts one rebuild and shares its
// promise; concurrent queries await the same rebuild instead of spawning
// duplicates. Boot-time and request rebuilds share the same candidate.
let rebuildPromise: Promise<number> | null = null

let memoryIndexReady = false
export function isMemoryIndexReady(): boolean {
  return memoryIndexReady
}

export function getSearchIndex(): SearchIndex {
  if (!index) index = new SearchIndex()
  return index
}

export function setVectorIndex(idx: VectorIndex | null): void {
  vectorIndex = idx
}

export function getVectorIndex(): VectorIndex | null {
  return vectorIndex
}

export function setEmbeddingProvider(provider: EmbeddingProvider | null): void {
  currentEmbeddingProvider = provider
}

export function vectorIndexRemove(id: string): void {
  vectorIndex?.remove(id);
}

// Persistence sync hook. Without this, index removals only live in
// memory; a crash/SIGKILL before graceful shutdown reloads a stale
// snapshot at boot and the deleted entry resurrects in the index.
// Wired by src/index.ts after IndexPersistence is constructed; no-op
// until then so unit tests that exercise the delete paths in
// isolation don't need to wire persistence.
let indexPersistence: {
  scheduleSave: () => void;
  save: (options?: { requireSuccess?: boolean }) => Promise<void>;
} | null = null;

export function setIndexPersistence(
  p: { scheduleSave: () => void; save: (options?: { requireSuccess?: boolean }) => Promise<void> } | null,
): void {
  indexPersistence = p;
}

export function scheduleIndexSave(): void {
  indexPersistence?.scheduleSave();
}

// Synchronous flush variant for delete paths. The debounced
// scheduleSave is fine for adds (chatty), but a hard process exit
// inside the 5s debounce window would lose deletes and resurrect
// removed entries on next boot. Deletes are infrequent enough that
// awaiting a single write per operation is acceptable. save() catches
// its own errors via IndexPersistence.logFailure, so this resolves
// even when persistence fails — callers must not treat a failed
// flush as a fatal error on the delete itself (the KV delete already
// committed before this is invoked).
export async function flushIndexSave(options: { requireSuccess?: boolean; reportFailure?: boolean } = {}): Promise<void> {
  if (options.requireSuccess && !indexPersistence) throw new Error("Index persistence is not configured");
  await indexPersistence?.save(options.reportFailure ? { requireSuccess: true } : options);
}

// Hard cap on embedding input length. Most providers cap input around
// 8k tokens (~32k chars at ~4 chars/token). Truncate defensively so a
// huge memory.content can't 400 the embed call or blow context budget
// on a single doc. 16k chars ≈ 4k tokens, safely under every provider.
const EMBED_MAX_CHARS = 16_000

export function clipEmbedInput(text: string): string {
  if (text.length <= EMBED_MAX_CHARS) return text
  return text.slice(0, EMBED_MAX_CHARS)
}

// Single guarded vector-index write. Returns true on success. Logs and
// no-ops on:
//   - dimension mismatch (mis-configured provider would silently corrupt
//     the index per #248 otherwise — guarded at persistence load there;
//     this is the symmetric guard at the write site)
//   - embed throwing (network, rate limit, provider down)
// Always soft-fails so a downed embedder doesn't break the upstream save.
export async function vectorIndexAddGuarded(
  id: string,
  sessionId: string,
  text: string,
  context: { kind: "memory" | "observation" | "synthetic"; logId: string },
): Promise<boolean> {
  const vi = vectorIndex
  const ep = currentEmbeddingProvider
  if (!vi || !ep) return false
  try {
    const embedding = await ep.embed(clipEmbedInput(text))
    if (embedding.length !== ep.dimensions) {
      logger.warn("vector-index add: dimension mismatch — skipping", {
        kind: context.kind,
        id: context.logId,
        provider: ep.name,
        expected: ep.dimensions,
        received: embedding.length,
      })
      return false
    }
    vi.add(id, sessionId, embedding)
    scheduleIndexSave()
    return true
  } catch (err) {
    logger.warn("vector-index add: embed failed — skipping", {
      kind: context.kind,
      id: context.logId,
      provider: ep.name,
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}

// Batched variant: calls EmbeddingProvider.embedBatch ONCE for the whole
// batch, then writes each resulting vector. Use this for bulk paths
// (rebuildIndex, future bulk-add APIs) where per-item serial awaits
// dominate wallclock. A batch of N has roughly the latency of a single
// embed (network + GPU setup amortized), so backfilling a 500k-obs
// corpus drops from days to hours on a per-batch endpoint like vLLM.
//
// Per-item failure shape:
//   - whole-batch network/provider error → all skipped, single warn line
//   - per-item dimension mismatch → that item skipped, others continue
export async function vectorIndexAddBatchGuarded(
  items: Array<{
    id: string
    sessionId: string
    text: string
    context: { kind: "memory" | "observation" | "synthetic"; logId: string }
  }>,
  target?: { vector: VectorIndex | null; provider: EmbeddingProvider | null },
): Promise<{ ok: number; fail: number }> {
  const vi = target ? target.vector : vectorIndex
  const ep = target ? target.provider : currentEmbeddingProvider
  if (!vi || !ep || items.length === 0) return { ok: 0, fail: 0 }

  let embeddings: Float32Array[]
  try {
    embeddings = await ep.embedBatch(items.map((i) => clipEmbedInput(i.text)))
  } catch (err) {
    logger.warn("vector-index add batch: embed failed — skipping batch", {
      batchSize: items.length,
      provider: ep.name,
      error: err instanceof Error ? err.message : String(err),
    })
    return { ok: 0, fail: items.length }
  }

  if (embeddings.length !== items.length) {
    logger.warn(
      "vector-index add batch: provider returned wrong length — skipping batch",
      {
        batchSize: items.length,
        returned: embeddings.length,
        provider: ep.name,
      },
    )
    return { ok: 0, fail: items.length }
  }

  let ok = 0
  let fail = 0
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const embedding = embeddings[i]
    if (embedding.length !== ep.dimensions) {
      logger.warn("vector-index add batch: dimension mismatch — skipping item", {
        kind: item.context.kind,
        id: item.context.logId,
        provider: ep.name,
        expected: ep.dimensions,
        received: embedding.length,
      })
      fail++
      continue
    }
    try {
      vi.add(item.id, item.sessionId, embedding)
      ok++
    } catch (err) {
      logger.warn("vector-index add batch: index write failed — skipping item", {
        kind: item.context.kind,
        id: item.context.logId,
        error: err instanceof Error ? err.message : String(err),
      })
      fail++
    }
  }
  return { ok, fail }
}

// Embed-batch size for rebuild. Each item is one /v1/embeddings call's
// `input` array element; the provider sees the whole batch as one HTTP
// round-trip. 32 fits comfortably under typical per-request token budgets
// (32 × ~110 tok/item ≈ 3.5k tokens) and gets close to per-call
// throughput for GPU-backed endpoints (vLLM, Triton, etc.). Override via
// REBUILD_EMBED_BATCH_SIZE for endpoints that prefer smaller/larger
// batches. Set to 1 to fall back to the legacy per-item path.
const DEFAULT_REBUILD_EMBED_BATCH = 32

function getRebuildEmbedBatchSize(): number {
  const raw = process.env.REBUILD_EMBED_BATCH_SIZE
  if (!raw) return DEFAULT_REBUILD_EMBED_BATCH
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_REBUILD_EMBED_BATCH
}

// Shared BM25 + batched-vector indexing for a set of records. The full
// rebuild and every import path (export-import, jsonl replay) funnel
// through this so they index identically and none can silently skip the
// vector side. It does NOT clear the index — callers that rebuild clear
// first; importers add. When no embedding provider is configured it skips
// the vector enqueue entirely, so a keyless install never allocates embed
// jobs it would immediately discard.
export async function indexRecords(
  observations: CompressedObservation[],
  memories: Memory[],
  options: { schedulePersistence?: boolean; target?: { keyword: SearchIndex; vector: VectorIndex | null; provider: EmbeddingProvider | null } } = {},
): Promise<number> {
  const idx = options.target?.keyword ?? getSearchIndex()
  const vectorEnabled = options.target ? Boolean(options.target.vector && options.target.provider) : Boolean(vectorIndex && currentEmbeddingProvider)
  const batchSize = getRebuildEmbedBatchSize()
  type EmbedJob = {
    id: string
    sessionId: string
    text: string
    context: { kind: "memory" | "observation" | "synthetic"; logId: string }
  }
  const pending: EmbedJob[] = []
  const flush = async (): Promise<void> => {
    if (pending.length === 0) return
    await vectorIndexAddBatchGuarded(pending, options.target)
    pending.length = 0
  }
  const enqueue = async (job: EmbedJob): Promise<void> => {
    if (!vectorEnabled) return
    pending.push(job)
    if (pending.length >= batchSize) await flush()
  }

  let count = 0
  for (const memory of memories) {
    if (memory.isLatest === false) continue
    if (!memory.title || !memory.content) continue
    idx.add(memoryToObservation(memory))
    await enqueue({
      id: memory.id,
      sessionId: memory.sessionIds?.[0] ?? 'memory',
      text: memory.title + ' ' + memory.content,
      context: { kind: "memory", logId: memory.id },
    })
    count++
  }
  for (const obs of observations) {
    if (!obs.title || !obs.narrative) continue
    idx.add(obs)
    await enqueue({
      id: obs.id,
      sessionId: obs.sessionId,
      text: obs.title + ' ' + obs.narrative,
      context: { kind: "observation", logId: obs.id },
    })
    count++
  }
  await flush()
  if (count > 0 && options.schedulePersistence !== false) scheduleIndexSave()
  return count
}

export function rebuildIndex(kv: StateKV, options: { reuseVectors?: boolean; signal?: AbortSignal } = {}): Promise<number> {
  if (!rebuildPromise) {
    rebuildPromise = buildIndexCandidate(kv, options).finally(() => { rebuildPromise = null });
  }
  return rebuildPromise;
}

async function buildIndexCandidate(kv: StateKV, options: { reuseVectors?: boolean; signal?: AbortSignal }): Promise<number> {
  const live = getSearchIndex();
  const liveVector = vectorIndex;
  const provider = currentEmbeddingProvider;
  const keyword = new SearchIndex();
  const vector = liveVector ? new VectorIndex() : null;
  const keywordChanges = live.captureChanges();
  let vectorChanges: ReturnType<VectorIndex["captureChanges"]> | undefined;
  try {
    vectorChanges = liveVector?.captureChanges();
    options.signal?.throwIfAborted();
    const memories = await kv.list<Memory>(KV.memories);
    const sessions = await kv.list<Session>(KV.sessions);
    let indexed = 0;
    const target = { keyword, vector, provider: options.reuseVectors ? null : provider };
    for (let batch = 0; batch < sessions.length; batch += 10) {
      const rows = await Promise.all(sessions.slice(batch, batch + 10).map(session =>
        kv.list<CompressedObservation>(KV.observations(session.id))));
      indexed += await indexRecords(rows.flat(), [], { schedulePersistence: false, target });
    }
    indexed += await indexRecords([], memories, { schedulePersistence: false, target });
    options.signal?.throwIfAborted();
    if (vectorIndex !== liveVector || currentEmbeddingProvider !== provider) throw new Error("Search configuration changed during rebuild");
    keywordChanges.applyTo(keyword);
    if (vector && options.reuseVectors) liveVector!.copyMatchingTo(vector, id => keyword.has(id));
    if (vector) vectorChanges?.applyTo(vector, id => keyword.has(id));
    keywordChanges.stop(); vectorChanges?.stop();
    live.restoreFrom(keyword);
    if (liveVector && vector) liveVector.restoreFrom(vector);
    memoryIndexReady = true;
    scheduleIndexSave();
    return indexed;
  } finally { keywordChanges.stop(); vectorChanges?.stop(); }
}

export function registerSearchFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    'mem::search',
    async (data: {
      query: string
      limit?: number
      project?: string
      cwd?: string
      format?: string
      token_budget?: number
      agentId?: string
      trackAccess?: boolean
      sourceKind?: "user" | "assistant"
      searchMode?: "keyword" | "hybrid"
      retrievalPolicy?: "automatic"
    }) => {
      const idx = getSearchIndex()

      // Input validation / normalization.
      if (typeof data?.query !== 'string' || !data.query.trim()) {
        throw new Error('mem::search: query must be a non-empty string')
      }
      const query = data.query.trim()
      if (data.retrievalPolicy !== undefined && data.retrievalPolicy !== "automatic") throw new Error("mem::search: retrievalPolicy must be automatic")
      const retrieval: Record<string, string> | undefined = data.retrievalPolicy === "automatic"
        ? { keyword: "available", vector: "not-requested", graph: "skipped-automatic" } : undefined
      if (data.searchMode !== undefined && !["keyword", "hybrid"].includes(data.searchMode)) {
        throw new Error('mem::search: searchMode must be keyword or hybrid')
      }
      if (data.sourceKind !== undefined && !["user", "assistant"].includes(data.sourceKind)) {
        throw new Error('mem::search: sourceKind must be user or assistant')
      }
      const MAX_LIMIT = 100
      let effectiveLimit = 20
      if (data.limit !== undefined) {
        if (!Number.isInteger(data.limit) || data.limit < 1) {
          throw new Error('mem::search: limit must be a positive integer')
        }
        effectiveLimit = Math.min(data.limit, MAX_LIMIT)
      }
      const requestedProject = typeof data.project === 'string' && data.project.trim().length > 0 ? data.project.trim() : undefined
      const projectFilter = requestedProject === '*' ? undefined : requestedProject
      const cwdFilter = typeof data.cwd === 'string' && data.cwd.trim().length > 0 ? data.cwd.trim() : undefined
      // #817: agent-scope isolation. mem::search backs REST /search,
      // memory_recall and recall_context. Without filtering here a
      // worker booted with AGENT_ID=B + AGENTMEMORY_AGENT_SCOPE=isolated
      // could read A's memories — the cross-agent leak the issue
      // documented. Mirrors the smart-search pattern: wildcard "*"
      // bypasses, explicit agentId pins, isolated mode falls back to
      // the worker's own AGENT_ID.
      //
      // Fail-closed: if isolated mode is on AND no explicit agentId
      // is given AND env AGENT_ID is unset, refuse the call rather
      // than silently dropping the filter. Allowing the call through
      // with filterAgentId=undefined is the same leak this fix is
      // supposed to close.
      const isolated = isAgentScopeIsolated();
      const explicitAgentId =
        typeof data.agentId === "string" && data.agentId.trim().length > 0
          ? data.agentId.trim()
          : undefined;
      const wildcardAgent = explicitAgentId === "*";
      const envAgentId = isolated ? getAgentId() : undefined;
      const filterAgentId = wildcardAgent
        ? undefined
        : explicitAgentId ?? envAgentId;
      if (
        isolated &&
        !wildcardAgent &&
        !explicitAgentId &&
        !envAgentId
      ) {
        throw new Error(
          "mem::search: AGENTMEMORY_AGENT_SCOPE=isolated is set but no " +
            "agent id is available (env AGENT_ID unset and no explicit " +
            "agentId in the call). Refusing to read cross-agent rows. " +
            'Pass agentId: "*" to opt in to a wildcard read.',
        );
      }
      const format = typeof data.format === 'string' ? data.format : 'full'
      if (!['full', 'compact', 'narrative'].includes(format)) {
        throw new Error("mem::search: format must be one of 'full', 'compact', or 'narrative'")
      }
      let tokenBudget: number | undefined
      if (data.token_budget !== undefined) {
        if (!Number.isInteger(data.token_budget) || data.token_budget < 1) {
          throw new Error('mem::search: token_budget must be a positive integer')
        }
        tokenBudget = data.token_budget
      }

      if (idx.size === 0 && !retrieval) {
        await rebuildIndex(kv).catch(error => logger.warn("Index rebuild failed", {
          error: error instanceof Error ? error.message : String(error),
        }));
      }

      if (retrieval && (idx.size === 0 || !memoryIndexReady)) retrieval.keyword = "index-not-ready"
      const selection = createSearchCandidateSelection(kv, { project: projectFilter, cwd: cwdFilter, agentId: filterAgentId, sourceKind: data.sourceKind })
      const fetchLimit = effectiveLimit
      let results: Array<{
        obsId: string
        sessionId: string
        score: number
      }>
      if (retrieval && !hybridRanker && data.searchMode !== "keyword") retrieval.vector = "unavailable"
      if (hybridRanker && data.searchMode !== "keyword") {
        try {
          const hybrid = await hybridRanker(query, fetchLimit, selection, retrieval ? { maxVectorScan: 4096, channels: retrieval } : undefined)
          results = hybrid.map((r) => ({
            obsId: r.observation.id,
            sessionId: r.sessionId,
            score: r.combinedScore,
          }))
        } catch (err) {
          if (retrieval) retrieval.vector = "failed"
          logger.warn("hybrid ranking failed, falling back to keyword search", {
            error: err instanceof Error ? err.message : String(err),
          })
          results = await selection.select(idx.search(query, idx.size), fetchLimit)
        }
      } else {
        results = await selection.select(idx.search(query, idx.size), fetchLimit)
      }

      const enriched: SearchResult[] = []
      for (let offset = 0; offset < results.length && enriched.length < effectiveLimit; offset += 8) {
        const batch = results.slice(offset, offset + 8)
        const resolved = await Promise.all(batch.map(r => selection.resolve(r)))
        for (let i = 0; i < batch.length && enriched.length < effectiveLimit; i++) {
          const canonical = resolved[i]
          if (!canonical) continue
          enriched.push({
            observation: canonical.observation,
            score: batch[i].score,
            sessionId: canonical.observation.sessionId,
            ...(canonical.project ? { project: canonical.project } : {}),
          })
        }
      }

      if (data.trackAccess !== false) {
        void recordAccessBatch(
          kv,
          enriched.map((r) => r.observation.id),
        )
      }

      const estimateTokens = (value: unknown): number =>
        Math.max(1, Math.ceil(JSON.stringify(value).length / 3))

      const applyTokenBudget = <T>(items: T[]): {
        items: T[]
        used: number
        truncated: boolean
      } => {
        if (!tokenBudget) return { items, used: items.reduce((sum, item) => sum + estimateTokens(item), 0), truncated: false }
        const selected: T[] = []
        let used = 0
        for (const item of items) {
          const itemTokens = estimateTokens(item)
          if (used + itemTokens > tokenBudget) {
            continue
          }
          selected.push(item)
          used += itemTokens
        }
        return { items: selected, used, truncated: selected.length < items.length }
      }

      if (format === 'compact') {
        const compactResults: CompactSearchResult[] = enriched.map((r) => ({
          obsId: r.observation.id,
          sessionId: r.sessionId,
          title: r.observation.title,
          type: r.observation.type,
          score: r.score,
          timestamp: r.observation.timestamp,
          project: r.project,
          sourceKind: observationSourceKind(r.observation) ?? "derived",
        }))
        const packed = applyTokenBudget(compactResults)
        return {
          format,
          results: packed.items,
          tokens_used: packed.used,
          tokens_budget: tokenBudget,
          truncated: packed.truncated,
          ...(retrieval ? { retrieval } : {}),
        }
      }

      if (format === 'narrative') {
        const narrativeResults = enriched.map((r) => ({
          obsId: r.observation.id,
          sessionId: r.sessionId,
          title: r.observation.title,
          narrative: r.observation.narrative,
          score: r.score,
          timestamp: r.observation.timestamp,
          project: r.project,
        }))
        const packed = applyTokenBudget(narrativeResults)
        const text = packed.items
          .map((r, index) => `${index + 1}. ${r.title}\n${r.narrative}`)
          .join('\n\n')
        return {
          format,
          results: packed.items,
          text,
          tokens_used: packed.used,
          tokens_budget: tokenBudget,
          truncated: packed.truncated,
          ...(retrieval ? { retrieval } : {}),
        }
      }

      const packed = applyTokenBudget(enriched)

      // Avoid logging raw cwd/project (host paths). Log only that filters were active.
      logger.info('Search completed', {
        query,
        results: packed.items.length,
        hasProjectFilter: !!projectFilter,
        hasCwdFilter: !!cwdFilter,
      })
      return {
        format,
        results: packed.items,
        tokens_used: packed.used,
        tokens_budget: tokenBudget,
        truncated: packed.truncated,
        ...(retrieval ? { retrieval } : {}),
      }
    }
  )
}
