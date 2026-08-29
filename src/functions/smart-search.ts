import type { ISdk } from "iii-sdk";
import type {
  CompactLessonResult,
  CompactSearchResult,
  CompressedObservation,
  HybridSearchResult,
  Lesson,
} from "../types.js";
import { KV } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { recordAccessBatch } from "./access-tracker.js";
import {
  getAgentId,
  isAgentScopeIsolated,
  getFollowupWindowSeconds,
} from "../config.js";
import { logger } from "../logger.js";
import { getCounters } from "../telemetry/setup.js";
import type { Memory, Session } from "../types.js";
import {
  isExcludedCodexAmbientSession,
  sanitizeCodexAmbientObservation,
} from "./observation-visibility.js";

// #771: smart-search followup-rate diagnostic. Stored per session as
// the most recent search payload, used to detect whether the next
// search inside the window had a disjoint result set. sessionId is
// duplicated into the row so the hourly sweep can delete by it
// (StateKV.list returns values only).
export interface RecentSearch {
  sessionId: string;
  query: string;
  resultIds: string[];
  at: number;
}

// Module-scope counter mirror so `mem::diagnostic::followup-stats` can
// read the rate back without going through the OTEL collector. The
// OTEL counter is still the canonical export; this is an in-process
// convenience for `agentmemory status` + tests.
const followupStats = {
  followupWithinWindow: 0,
  agentInitiatedSearches: 0,
};

// Tracks the in-flight detection promises so tests (and shutdown
// flushes) can wait for all queued lock bodies to drain. The Set adds
// when a detection is queued and removes when it settles; size === 0
// means no pending detections.
const pendingFollowups = new Set<Promise<void>>();

export function getFollowupStats(): {
  followupWithinWindow: number;
  agentInitiatedSearches: number;
  rate: number;
} {
  const total = followupStats.agentInitiatedSearches;
  return {
    ...followupStats,
    rate: total > 0 ? followupStats.followupWithinWindow / total : 0,
  };
}

export async function flushPendingFollowups(): Promise<void> {
  // Snapshot the current pending set; new detections queued after the
  // snapshot run in a fresh batch.
  await Promise.all(Array.from(pendingFollowups));
}

export function resetFollowupStatsForTests(): void {
  followupStats.followupWithinWindow = 0;
  followupStats.agentInitiatedSearches = 0;
}

// Compact mode trims each lesson's content for at-a-glance display. The
// full content is fetched via memory_lesson_recall when the caller needs it.
const LESSON_CONTENT_PREVIEW_CHARS = 240;

export function registerSmartSearchFunction(
  sdk: ISdk,
  kv: StateKV,
  searchFn: (query: string, limit: number) => Promise<HybridSearchResult[]>,
): void {
  sdk.registerFunction("mem::smart-search",
    async (data: {
      query?: string;
      expandIds?: Array<string | { obsId: string; sessionId: string }>;
      limit?: number;
      project?: string;
      includeLessons?: boolean;
      // optional per-call agent filter for runtimes routing many
      // roles through one server. "*" opts out of the env-default
      // scope and returns hits from every agent.
      agentId?: string;
      // #771: session anchor for the followup-rate diagnostic. The
      // API trigger fills this from req.body / headers; direct
      // sdk.trigger callers can pass it explicitly.
      sessionId?: string;
      // #771: marks viewer-originated searches so the diagnostic
      // ignores them — only agent-initiated re-queries should count.
      source?: string;
      trackAccess?: boolean;
    }) => {
      const requestedProject =
        typeof data.project === "string" && data.project.trim().length > 0
          ? data.project.trim()
          : undefined;
      const projectFilter =
        requestedProject === "*" ? undefined : requestedProject;

      // Compute the agent filter once, up front. Both the expandIds
      // branch and the hybrid-search branch consult it — otherwise
      // expandIds becomes a cross-agent leak (#554 follow-up).
      //
      // #817 follow-up: fail-closed when isolated mode is on AND no
      // agent id is resolvable from any source. Silently letting
      // filterAgentId fall through to `undefined` would be the same
      // cross-agent leak this filter is meant to prevent.
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
          "mem::smart-search: AGENTMEMORY_AGENT_SCOPE=isolated is set but " +
            "no agent id is available (env AGENT_ID unset and no explicit " +
            "agentId in the call). Refusing to read cross-agent rows. " +
            'Pass agentId: "*" to opt in to a wildcard read.',
        );
      }

      if (data.expandIds && data.expandIds.length > 0) {
        const raw = data.expandIds.slice(0, 20);
        const items = raw.map((entry) => {
          if (typeof entry === "string") return { obsId: entry, sessionId: undefined as string | undefined };
          if (entry && typeof entry === "object" && typeof (entry as any).obsId === "string") {
            return { obsId: (entry as any).obsId, sessionId: (entry as any).sessionId as string | undefined };
          }
          return null;
        }).filter((item): item is NonNullable<typeof item> => item !== null);

        const expanded: Array<{
          obsId: string;
          sessionId: string;
          observation: CompressedObservation;
        }> = [];

        const observations = await findObservations(kv, items);
        for (let index = 0; index < items.length; index++) {
          const { obsId } = items[index];
          const observation = observations[index];
          if (observation) {
            expanded.push({
              obsId,
              sessionId: observation.sessionId,
              observation,
            });
          }
        }

        const projectScoped: typeof expanded = [];
        for (const entry of expanded) {
          const session = await kv
            .get<Session>(KV.sessions, entry.sessionId)
            .catch(() => null);
          if (isExcludedCodexAmbientSession(session)) continue;
          const observation = sanitizeCodexAmbientObservation(
            entry.observation,
          );
          if (!observation) continue;
          if (projectFilter) {
            const memoryProject = session
              ? session.project
              : (
                  await kv
                    .get<Memory>(KV.memories, entry.obsId)
                    .catch(() => null)
                )?.project;
            if (memoryProject !== projectFilter) continue;
          }
          projectScoped.push({ ...entry, observation });
        }

        const scoped = filterAgentId
          ? projectScoped.filter(
              (entry) => entry.observation.agentId === filterAgentId,
            )
          : projectScoped;

        if (data.trackAccess !== false) {
          void recordAccessBatch(
            kv,
            scoped.map((e) => e.observation.id),
          );
        }

        const truncated = data.expandIds.length > raw.length;
        logger.info("Smart search expanded", {
          requested: data.expandIds.length,
          attempted: raw.length,
          returned: scoped.length,
          filteredOutOfScope: expanded.length - scoped.length,
          truncated,
        });
        return { mode: "expanded", results: scoped, truncated };
      }

      if (!data.query || typeof data.query !== "string" || !data.query.trim()) {
        return { mode: "compact", results: [], error: "query is required" };
      }

      const limit = Math.max(1, Math.min(data.limit ?? 20, 100));
      // Lesson recall stays capped: lessons are denser than raw
      // observations so 10 covers most recall flows.
      const lessonLimit = Math.min(limit, 10);
      const includeLessons = data.includeLessons !== false;

      // Over-fetch when filtering. Hybrid search can't filter on
      // agentId (BM25/vector indexes don't carry it), so we ask the
      // searcher for more hits than we need and trim post-filter. 3×
      // is a defensible middle ground: enough headroom for a small
      // workload, capped at 300 so a 100-limit request never asks for
      // thousands of hits.
      const overFetchLimit = Math.max(Math.min(limit * 10, 300), 100);

      const [hybridResults, lessons] = await Promise.all([
        searchFn(data.query, overFetchLimit),
        includeLessons
          ? recallLessons(sdk, data.query, lessonLimit, projectFilter)
          : Promise.resolve([]),
      ]);

      const projectScoped: HybridSearchResult[] = [];
      for (const result of hybridResults) {
        const session = await kv
          .get<Session>(KV.sessions, result.sessionId)
          .catch(() => null);
        if (isExcludedCodexAmbientSession(session)) continue;
        const observation = sanitizeCodexAmbientObservation(
          result.observation,
        );
        if (!observation) continue;
        if (projectFilter) {
          const memoryProject = session
            ? session.project
            : (
                await kv
                  .get<Memory>(KV.memories, result.observation.id)
                  .catch(() => null)
              )?.project;
          if (memoryProject !== projectFilter) continue;
        }
        projectScoped.push({ ...result, observation });
        if (projectScoped.length >= limit) break;
      }

      const filteredHybrid = filterAgentId
        ? projectScoped
            .filter((result) => result.observation.agentId === filterAgentId)
            .slice(0, limit)
        : projectScoped.slice(0, limit);

      const compact: CompactSearchResult[] = filteredHybrid.map((r) => ({
        obsId: r.observation.id,
        sessionId: r.sessionId,
        title: r.observation.title,
        type: r.observation.type,
        score: r.combinedScore,
        timestamp: r.observation.timestamp,
      }));

      if (data.trackAccess !== false) {
        void recordAccessBatch(
          kv,
          compact.map((r) => r.obsId),
        );
      }

      // #771: followup-rate diagnostic. Only fires for agent-initiated
      // searches that carry a sessionId — viewer-originated searches
      // (source === "viewer") and direct-sdk callers without a session
      // anchor are skipped. The result-set comparison uses obsIds: a
      // disjoint set under the window suggests the previous call's
      // results were not used, which is our directional proxy for
      // reader-failure-with-evidence.
      if (
        data.sessionId &&
        typeof data.sessionId === "string" &&
        data.source !== "viewer" &&
        compact.length > 0
      ) {
        // Skip detection when retrieval returned nothing: an empty
        // result set is a retrieval failure, not a reader-failure
        // signal. Counting it as "disjoint from prior" would inflate
        // the rate every time search returns no hits.
        followupStats.agentInitiatedSearches++;
        // Off the critical response path. The withKeyedLock(sessionId)
        // call serializes detection per session, so two rapid
        // back-to-back searches from the same agent still see ordered
        // prior-row writes — the second call's lock body queues
        // behind the first's. Other sessions run in parallel.
        const sessionIdForFollowup = data.sessionId;
        const queryForFollowup = data.query;
        const compactForFollowup = compact;
        const detection = withKeyedLock(
          `recent-searches:${sessionIdForFollowup}`,
          () =>
            detectFollowup(
              kv,
              sessionIdForFollowup,
              queryForFollowup,
              compactForFollowup,
            ),
        )
          .catch((err) => {
            logger.warn("Smart search followup detection failed", {
              sessionId: sessionIdForFollowup,
              error: err instanceof Error ? err.message : String(err),
            });
          })
          .finally(() => {
            pendingFollowups.delete(detection);
          });
        pendingFollowups.add(detection);
      }

      logger.info("Smart search compact", {
        query: data.query,
        results: compact.length,
        lessons: lessons.length,
      });
      const response: {
        mode: "compact";
        results: CompactSearchResult[];
        lessons?: CompactLessonResult[];
      } = { mode: "compact", results: compact };
      if (includeLessons) response.lessons = lessons;
      return response;
    },
  );
}

async function recallLessons(
  sdk: ISdk,
  query: string,
  limit: number,
  project?: string,
): Promise<CompactLessonResult[]> {
  try {
    const result = (await sdk.trigger({
      function_id: "mem::lesson-recall",
      payload: { query, limit, project },
    })) as { success?: boolean; lessons?: Array<Lesson & { score?: number }> };
    if (!result?.success || !Array.isArray(result.lessons)) return [];
    return result.lessons.map((l) => ({
      lessonId: l.id,
      content:
        l.content.length > LESSON_CONTENT_PREVIEW_CHARS
          ? l.content.slice(0, LESSON_CONTENT_PREVIEW_CHARS) + "…"
          : l.content,
      confidence: l.confidence,
      score: l.score ?? l.confidence,
      createdAt: l.createdAt,
      project: l.project,
      tags: l.tags ?? [],
    }));
  } catch (err) {
    logger.warn("Smart search: mem::lesson-recall failed; returning empty lesson list", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

async function detectFollowup(
  kv: StateKV,
  sessionId: string,
  query: string,
  compact: CompactSearchResult[],
): Promise<void> {
  const now = Date.now();
  const windowMs = Math.max(1, getFollowupWindowSeconds()) * 1000;
  const currentIds = compact.map((r) => r.obsId);
  const current: RecentSearch = { sessionId, query, resultIds: currentIds, at: now };

  const prior = await kv
    .get<RecentSearch>(KV.recentSearches, sessionId)
    .catch(() => null);

  await kv.set(KV.recentSearches, sessionId, current);

  if (!prior || typeof prior.at !== "number") return;
  if (now - prior.at > windowMs) return;
  // Same query inside the window is a retry, not a follow-up; skip so a
  // duplicate request from a flaky client doesn't inflate the metric.
  if (typeof prior.query === "string" && prior.query === query) return;

  const priorIds = Array.isArray(prior.resultIds) ? prior.resultIds : [];
  const priorSet = new Set(priorIds);
  const hasOverlap = currentIds.some((id) => priorSet.has(id));
  if (hasOverlap) return;

  getCounters().smartSearchFollowupWithinWindow.add(1);
  followupStats.followupWithinWindow++;
  logger.info("Smart search followup detected", {
    sessionId,
    windowSeconds: Math.round(windowMs / 1000),
    priorQuery: prior.query,
    nextQuery: query,
    priorResultCount: priorIds.length,
    nextResultCount: currentIds.length,
  });
}

async function findObservations(
  kv: StateKV,
  items: Array<{ obsId: string; sessionId?: string }>,
): Promise<Array<CompressedObservation | null>> {
  const observations: Array<CompressedObservation | null> = items.map(
    () => null,
  );
  let unresolved: number[] = [];

  for (let index = 0; index < items.length; index++) {
    const { obsId, sessionId } = items[index];
    if (sessionId) {
      observations[index] = await kv
        .get<CompressedObservation>(KV.observations(sessionId), obsId)
        .catch(() => null);
    }
    if (!observations[index]) unresolved.push(index);
  }

  if (unresolved.length === 0) return observations;
  const sessions = await kv.list<{ id: string }>(KV.sessions);

  if (unresolved.length > 1) {
    const indexesByObservationId = new Map<string, number[]>();
    for (const index of unresolved) {
      const indexes = indexesByObservationId.get(items[index].obsId) ?? [];
      indexes.push(index);
      indexesByObservationId.set(items[index].obsId, indexes);
    }

    for (const session of sessions) {
      const sessionObservations = await kv
        .list<CompressedObservation>(KV.observations(session.id))
        .catch(() => []);
      for (const observation of sessionObservations) {
        const indexes = indexesByObservationId.get(observation.id);
        if (!indexes) continue;
        for (const index of indexes) observations[index] = observation;
        indexesByObservationId.delete(observation.id);
      }
      if (indexesByObservationId.size === 0) break;
    }
    return observations;
  }

  for (const session of sessions) {
    const index = unresolved[0];
    const observation = await kv.get<CompressedObservation>(
      KV.observations(session.id),
      items[index].obsId,
    );
    if (!observation) continue;
    observations[index] = observation;
    break;
  }
  return observations;
}
