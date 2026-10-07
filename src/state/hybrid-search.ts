import { SearchIndex } from "./search-index.js";
import { VectorIndex } from "./vector-index.js";
import type {
  EmbeddingProvider,
  HybridSearchResult,
  CompressedObservation,
  Memory,
  QueryExpansion,
} from "../types.js";
import { memoryToObservation } from "./memory-utils.js";
import type { StateKV } from "./kv.js";
import { KV } from "./schema.js";
import {
  GraphRetrieval,
  type GraphRetrievalResult,
} from "../functions/graph-retrieval.js";
import { extractEntitiesFromQuery } from "../functions/query-expansion.js";
import { rerank } from "./reranker.js";
import type { SearchCandidateSelection } from "../functions/search-candidates.js";

export interface AutomaticRetrievalPolicy {
  maxVectorScan: number;
  channels: Record<string, string>;
}

const RRF_K = 60;

export class HybridSearch {
  private graphRetrieval: GraphRetrieval;

  constructor(
    private bm25: SearchIndex,
    private vector: VectorIndex | null,
    private embeddingProvider: EmbeddingProvider | null,
    private kv: StateKV,
    private bm25Weight = 0.4,
    private vectorWeight = 0.6,
    private graphWeight = 0.3,
    private rerankEnabled = process.env.RERANK_ENABLED === "true",
  ) {
    this.graphRetrieval = new GraphRetrieval(kv);
  }

  async search(query: string, limit = 20, selection?: SearchCandidateSelection, policy?: AutomaticRetrievalPolicy): Promise<HybridSearchResult[]> {
    return this.tripleStreamSearch(query, limit, undefined, selection, policy);
  }

  async searchWithExpansion(
    query: string,
    limit: number,
    expansion: QueryExpansion,
  ): Promise<HybridSearchResult[]> {
    const allQueries = [
      query,
      ...expansion.reformulations,
      ...expansion.temporalConcretizations,
    ];

    const allEntities = [
      ...expansion.entityExtractions,
      ...extractEntitiesFromQuery(query),
    ];

    const resultSets = await Promise.all(
      allQueries.map((q) => this.tripleStreamSearch(
        q, limit, allEntities, undefined, undefined, expansion.entityExtractions.length > 0,
      )),
    );

    const merged = new Map<string, HybridSearchResult>();
    for (const results of resultSets) {
      for (const r of results) {
        const existing = merged.get(r.observation.id);
        if (!existing || r.combinedScore > existing.combinedScore) {
          merged.set(r.observation.id, r);
        }
      }
    }

    return Array.from(merged.values())
      .sort(
        (a, b) =>
          b.combinedScore - a.combinedScore ||
          (a.observation.id < b.observation.id
            ? -1
            : a.observation.id > b.observation.id
              ? 1
              : 0),
      )
      .slice(0, limit);
  }

  private async tripleStreamSearch(
    query: string,
    limit: number,
    entityHints?: string[],
    selection?: SearchCandidateSelection,
    policy?: AutomaticRetrievalPolicy,
    hasExplicitEntityHints = false,
  ): Promise<HybridSearchResult[]> {
    const fetchDepth = Math.max(limit * 5, 50);
    const entities = entityHints?.length ? entityHints : extractEntitiesFromQuery(query);
    const graphEnabled = !policy && this.graphWeight > 0;
    const bm25Candidates = this.bm25.search(query, selection ? this.bm25.size : fetchDepth);

    if (policy) policy.channels.graph = "skipped-automatic";
    const vectorEligible = this.vector && this.embeddingProvider && this.vector.size > 0;
    if (policy) policy.channels.vector = !vectorEligible ? "unavailable" : this.vector!.size > policy.maxVectorScan ? "skipped-scan-bound" : "available";

    const keywordDepth = selection?.resolve && !vectorEligible && (!graphEnabled || entities.length === 0) && (policy || !this.rerankEnabled)
      ? limit : fetchDepth;
    const [bm25Results, vectorResults, entityGraphResults] = await Promise.all([
      selection ? selection.select(bm25Candidates, keywordDepth) : Promise.resolve(bm25Candidates),
      (async () => {
        let rows: Array<{ obsId: string; sessionId: string; score: number }> = [];
        if (vectorEligible && (!policy || this.vector!.size <= policy.maxVectorScan)) {
          try {
            const embedding = await this.embeddingProvider!.embed(query);
            rows = this.vector!.search(embedding, selection ? this.vector!.size : fetchDepth);
          } catch {
            if (policy) policy.channels.vector = "failed";
          }
        }
        return selection ? selection.select(rows, fetchDepth) : rows;
      })(),
      (async () => {
        let rows: GraphRetrievalResult[] = [];
        if (graphEnabled && entities.length > 0) {
          try {
            rows = await this.graphRetrieval.searchByEntities(
              entities, 2, selection ? Number.MAX_SAFE_INTEGER : limit,
              selection?.project, selection?.readSession,
            );
          } catch {
            // graph search is best-effort
          }
        }
        return selection ? selection.select(rows, limit, id => this.bm25.getSessionId(id)) : rows;
      })(),
    ]);
    let graphResults = entityGraphResults;

    let graphExpansionMatched = false;
    const topVectorObs = vectorResults.slice(0, 5).map((r) => r.obsId);
    if (graphEnabled && topVectorObs.length > 0) {
      let expansionResults: GraphRetrievalResult[] = [];
      try {
        expansionResults =
          await this.graphRetrieval.expandFromChunks(topVectorObs, 1, selection ? Number.MAX_SAFE_INTEGER : 5, selection?.project, selection?.readSession);
      } catch {
        // expansion is best-effort
      }
      const selectedExpansion = selection ? await selection.select(expansionResults, 5, id => this.bm25.getSessionId(id)) : expansionResults;
      graphExpansionMatched = selectedExpansion.length > 0;
      graphResults = [...graphResults, ...selectedExpansion];
    }

    const scores = new Map<
      string,
      {
        bm25Rank: number;
        vectorRank: number;
        graphRank: number;
        sessionId: string;
        bm25Score: number;
        vectorScore: number;
        graphScore: number;
        graphContext?: string;
      }
    >();

    bm25Results.forEach((r, i) => {
      scores.set(r.obsId, {
        bm25Rank: i + 1,
        vectorRank: Infinity,
        graphRank: Infinity,
        sessionId: r.sessionId,
        bm25Score: r.score,
        vectorScore: 0,
        graphScore: 0,
      });
    });

    vectorResults.forEach((r, i) => {
      const existing = scores.get(r.obsId);
      if (existing) {
        existing.vectorRank = i + 1;
        existing.vectorScore = r.score;
      } else {
        scores.set(r.obsId, {
          bm25Rank: Infinity,
          vectorRank: i + 1,
          graphRank: Infinity,
          sessionId: r.sessionId,
          bm25Score: 0,
          vectorScore: r.score,
          graphScore: 0,
        });
      }
    });

    graphResults.forEach((r, i) => {
      const existing = scores.get(r.obsId);
      if (existing) {
        existing.graphRank = Math.min(existing.graphRank, i + 1);
        existing.graphScore = Math.max(existing.graphScore, r.score);
        if (r.graphContext && !existing.graphContext) {
          existing.graphContext = r.graphContext;
        }
      } else {
        scores.set(r.obsId, {
          bm25Rank: Infinity,
          vectorRank: Infinity,
          graphRank: i + 1,
          sessionId: r.sessionId,
          bm25Score: 0,
          vectorScore: 0,
          graphScore: r.score,
          graphContext: r.graphContext,
        });
      }
    });

    // Normalize once per query by the best attainable weighted score over
    // the streams that produced results, so configured stream weights
    // survive for single-stream hits and a silent stream carries no penalty.
    const queryTerms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_./\\-]+/gu) ?? [])];
    const entityTerms = new Set(entities.flatMap(entity =>
      entity.toLowerCase().match(/[\p{L}\p{N}_./\\-]+/gu) ?? []));
    const entityCoverage = queryTerms.length > 0
      ? queryTerms.filter(term => entityTerms.has(term)).length / queryTerms.length : 0;
    const graphQueryWeight = this.graphWeight * (
      graphExpansionMatched || hasExplicitEntityHints ? 1 : entityCoverage
    );
    const AGREEMENT_BONUS = 0.05;
    const activeWeight =
      (bm25Results.length > 0 ? this.bm25Weight : 0) +
      (vectorResults.length > 0 ? this.vectorWeight : 0) +
      (graphResults.length > 0 ? graphQueryWeight : 0);
    const maxAttainable = activeWeight * (1 / (RRF_K + 1));
    const ranked = Array.from(scores.entries()).map(([obsId, s]) => {
      const wB = Number.isFinite(s.bm25Rank) ? this.bm25Weight : 0;
      const wV = Number.isFinite(s.vectorRank) ? this.vectorWeight : 0;
      const wG = Number.isFinite(s.graphRank) ? graphQueryWeight : 0;
      const matchedStreams =
        (wB > 0 ? 1 : 0) + (wV > 0 ? 1 : 0) + (wG > 0 ? 1 : 0);
      const weighted =
        wB * (1 / (RRF_K + s.bm25Rank)) +
        wV * (1 / (RRF_K + s.vectorRank)) +
        wG * (1 / (RRF_K + s.graphRank));
      const rrf = maxAttainable > 0 ? weighted / maxAttainable : 0;
      return {
        obsId,
        s,
        combinedScore: rrf * (1 + AGREEMENT_BONUS * (matchedStreams - 1)),
        minRank: Math.min(s.bm25Rank, s.vectorRank, s.graphRank),
      };
    });

    ranked.sort(
      (a, b) =>
        b.combinedScore - a.combinedScore ||
        a.minRank - b.minRank ||
        (a.obsId < b.obsId ? -1 : a.obsId > b.obsId ? 1 : 0),
    );
    const combined = ranked.map(({ obsId, s, combinedScore }) => ({
      obsId,
      sessionId: s.sessionId,
      bm25Score: s.bm25Score,
      vectorScore: s.vectorScore,
      graphScore: s.graphScore,
      graphContext: s.graphContext,
      combinedScore,
    }));

    const rerankWindow = 20;
    const enrichmentLimit = !policy && this.rerankEnabled ? Math.max(limit, rerankWindow) : limit;
    const enriched = await this.enrichResults(combined, enrichmentLimit, selection);

    if (!policy && this.rerankEnabled && enriched.length > 1) {
      try {
        const head = enriched.slice(0, rerankWindow);
        const tail = enriched.slice(rerankWindow);
        const reranked = await rerank(query, head, rerankWindow);
        return reranked.concat(tail).slice(0, limit);
      } catch {
        return enriched.slice(0, limit);
      }
    }

    return enriched.slice(0, limit);
  }

  private async enrichResults(
    results: Array<{
      obsId: string;
      sessionId: string;
      bm25Score: number;
      vectorScore: number;
      graphScore: number;
      combinedScore: number;
      graphContext?: string;
    }>,
    limit: number,
    selection?: SearchCandidateSelection,
  ): Promise<HybridSearchResult[]> {
    const enriched: HybridSearchResult[] = [];
    for (let offset = 0; offset < results.length && enriched.length < limit;) {
      const batch = results.slice(offset, offset + Math.min(8, limit - enriched.length));
      offset += batch.length;
      const observations = await Promise.all(batch.map(async (r) => {
        if (selection?.resolve) return (await selection.resolve(r))?.observation ?? null;
        const obs = await this.kv
          .get<CompressedObservation>(KV.observations(r.sessionId), r.obsId)
          .catch(() => null);
        if (obs) return obs;
        // Saved memories use a synthetic observation location in the index.
        const mem = await this.kv
          .get<Memory>(KV.memories, r.obsId)
          .catch(() => null);
        return mem && mem.isLatest !== false ? memoryToObservation(mem) : null;
      }));
      for (let i = 0; i < batch.length; i++) {
        const obs = observations[i];
        if (obs) {
          enriched.push({
            observation: obs,
            bm25Score: batch[i].bm25Score,
            vectorScore: batch[i].vectorScore,
            graphScore: batch[i].graphScore,
            combinedScore: batch[i].combinedScore,
            sessionId: batch[i].sessionId,
            graphContext: batch[i].graphContext,
          });
        }
      }
    }
    return enriched;
  }
}
