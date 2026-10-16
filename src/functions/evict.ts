import { registerObservationWriter } from "../state/observation-write.js";
import type { IIIClient } from "iii-sdk";
import { markCaptureEventDeleted } from "../capture/event-record.js";
import type {
  Session,
  CompressedObservation,
  RawObservation,
  SessionSummary,
  Memory,
} from "../types.js";
import { KV } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { removeSessionFromProjectIndex } from "../state/session-index.js";
import { unindexObservationSession } from "../state/obs-index.js";
import { isConsolidationEnabled } from "../config.js";
import { recordAudit } from "./audit.js";
import { deleteAccessLog } from "./access-tracker.js";
import { logger } from "../logger.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { sessionLifecycleLockKey } from "./session-lifecycle.js";
import { readArchiveCleanupProtection } from "./archive.js";

interface EvictionConfig {
  staleSessionDays: number;
  lowImportanceMaxDays: number;
  lowImportanceThreshold: number;
  maxObservationsPerProject: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const DEFAULTS: EvictionConfig = {
  staleSessionDays: 30,
  lowImportanceMaxDays: 90,
  lowImportanceThreshold: 3,
  maxObservationsPerProject: 10_000,
};

interface EvictionStats {
  staleSessions: number;
  lowImportanceObs: number;
  capEvictions: number;
  expiredMemories: number;
  nonLatestMemories: number;
  dryRun: boolean;
  protectedSessionsSkipped?: number;
}

function isValidRecoveryResult(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  if (!("success" in result)) return true;
  return (result as { success?: unknown }).success !== false;
}

function isCompressedObservation(
  observation: CompressedObservation | RawObservation,
): observation is CompressedObservation {
  return (
    "title" in observation &&
    typeof observation.title === "string" &&
    observation.title.length > 0
  );
}

async function recoverStaleSession(
  sdk: IIIClient,
  sessionId: string,
): Promise<boolean> {
  try {
    const result = await sdk.trigger({
      function_id: "event::session::stopped",
      // Suppress the per-session consolidation fan-out: eviction runs a
      // single corpus-wide consolidation pass after all recoveries instead.
      payload: { sessionId, skipConsolidation: true },
    });
    if (!isValidRecoveryResult(result)) {
      logger.warn("Stale session recovery failed", {
        sessionId,
        result,
      });
      return false;
    }
    return true;
  } catch (err) {
    logger.warn("Stale session recovery failed", {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

async function runRecoveredSessionConsolidation(sdk: IIIClient): Promise<void> {
  // Same gate as the session-stop path: keyless installs must not fire
  // no-op LLM consolidation from an eviction sweep either.
  if (!isConsolidationEnabled()) return;
  try {
    await sdk.trigger({
      function_id: "mem::consolidate-pipeline",
      payload: { tier: "all", force: true },
    });
    // One crystallization pass for the batch (the per-session fan-out was
    // suppressed with skipConsolidation), keeping recovered sessions
    // consistent with normally-stopped ones without the N-fold amplification.
    await sdk.trigger({
      function_id: "mem::auto-crystallize",
      payload: { olderThanDays: 0 },
    });
  } catch (err) {
    logger.warn("Recovered session consolidation failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function registerEvictFunction(sdk: IIIClient, kv: StateKV): void {
  registerObservationWriter(sdk, "mem::evict",
    async (data: { dryRun?: boolean }): Promise<EvictionStats> => {
      const dryRun = data?.dryRun ?? false;
      const { decrementImageRef } = await import("./image-refs.js");

      const configOverride = await kv
        .get<Partial<EvictionConfig>>(KV.config, "eviction")
        .catch(() => null);
      const cfg = { ...DEFAULTS, ...configOverride };

      const now = Date.now();
      const stats: EvictionStats = {
        staleSessions: 0,
        lowImportanceObs: 0,
        capEvictions: 0,
        expiredMemories: 0,
        nonLatestMemories: 0,
        dryRun,
      };

      let recoveredStaleSessions = 0;
      const protectedArchive = await readArchiveCleanupProtection(kv);
      const allSessions = await kv.list<Session>(KV.sessions).catch(() => []);
      const sessions = allSessions.filter(session => !kv.hasObservationRecovery(session.id) && !protectedArchive({ kind: "session", id: session.id }));
      const protectedSessionsSkipped = allSessions.length - sessions.length;
      const summaries = await kv
        .list<SessionSummary>(KV.summaries)
        .catch(() => []);
      const summaryIds = new Set(summaries.map((s) => s.sessionId));

      for (const session of sessions) {
        if (!session.startedAt) continue;
        const age = now - new Date(session.startedAt).getTime();
        const staleDays = cfg.staleSessionDays * MS_PER_DAY;
        if (age > staleDays && !summaryIds.has(session.id)) {
          if (dryRun) {
            stats.staleSessions++;
          } else {
            const observations = await kv
              .list<CompressedObservation | RawObservation>(
                KV.observations(session.id),
              )
              .catch((err) => {
                logger.warn("Stale session observation scan failed", {
                  sessionId: session.id,
                  error: err instanceof Error ? err.message : String(err),
                });
                return null;
              });
            if (!observations) continue;

            let recovered = false;
            const hasCompressedObservations = observations.some(
              isCompressedObservation,
            );
            if (hasCompressedObservations) {
              recovered = await recoverStaleSession(sdk, session.id);
              if (!recovered) continue;
              recoveredStaleSessions++;
            } else if (observations.length > 0) {
              logger.warn("Stale session has no compressed observations", {
                sessionId: session.id,
              });
              continue;
            }

            try {
              await withKeyedLock(
                sessionLifecycleLockKey(session.id),
                () => kv.delete(KV.sessions, session.id),
              );
              stats.staleSessions++;
            } catch (err) {
              logger.warn("Eviction delete failed", {
                resource: "session",
                id: session.id,
                error: err instanceof Error ? err.message : String(err),
              });
              continue;
            }
            for (const o of observations) {
              await unindexObservationSession(kv, o.id).catch(() => {});
            }
            await removeSessionFromProjectIndex(
              kv,
              session.project,
              session.id,
            ).catch(() => {});
            await recordAudit(kv, "delete", "mem::evict", [session.id], {
              resource: "session",
              reason: recovered
                ? "stale_session_recovered_then_evicted"
                : "stale_session_without_summary",
              dryRun,
            });
          }
        }
      }

      if (!dryRun && recoveredStaleSessions > 0) {
        await runRecoveredSessionConsolidation(sdk);
      }

      const projectObs = new Map<string, CompressedObservation[]>();
      const plannedLow = new Set<string>();
      const keyOf = (o: CompressedObservation) => JSON.stringify([o.sessionId, o.id]);
      const removeSelected = (selected: CompressedObservation, expectedProject: string, reason: string) =>
        withKeyedLock(sessionLifecycleLockKey(selected.sessionId), async () => {
          const [current, session] = await Promise.all([
            kv.get<CompressedObservation>(KV.observations(selected.sessionId), selected.id),
            kv.get<Session>(KV.sessions, selected.sessionId),
          ]);
          const protection = await readArchiveCleanupProtection(kv);
          if (!current || !session || (session.project || "unknown") !== expectedProject
            || !isCompressedObservation(current) || JSON.stringify(current) !== JSON.stringify(selected)
            || kv.hasObservationRecovery(selected.sessionId)
            || protection({ kind: "session", id: selected.sessionId })
            || protection({ kind: "observation", id: selected.id, sessionId: selected.sessionId })) return false;
          if (dryRun) return true;
          await markCaptureEventDeleted(kv, current);
          await kv.delete(KV.observations(current.sessionId), current.id);
          await unindexObservationSession(kv, current.id).catch(() => {});
          if (current.imageData) await decrementImageRef(kv, sdk, current.imageData);
          if (current.imageRef && current.imageRef !== current.imageData) await decrementImageRef(kv, sdk, current.imageRef);
          await recordAudit(kv, "delete", "mem::evict", [current.id], {
            resource: "observation", reason, sessionId: current.sessionId, dryRun,
          });
          return true;
        });
      for (const session of sessions) {
        const obs = await kv.list<CompressedObservation>(KV.observations(session.id)).catch(() => []);
        const compressed = obs.filter(isCompressedObservation);
        const project = session.project || "unknown";
        for (const o of compressed) {
          if (!o.timestamp) continue;
          const age = now - new Date(o.timestamp).getTime();
          if (age > cfg.lowImportanceMaxDays * MS_PER_DAY && (o.importance ?? 5) < cfg.lowImportanceThreshold) {
            plannedLow.add(keyOf(o));
            if (await removeSelected(o, project, "low_importance_old_observation")) stats.lowImportanceObs++;
          }
        }
        const existing = projectObs.get(project) || [];
        existing.push(...compressed.filter(o => !plannedLow.has(keyOf(o))));
        projectObs.set(project, existing);
      }
      for (const [project, obs] of projectObs) {
        if (obs.length <= cfg.maxObservationsPerProject) continue;
        const sorted = obs.sort((a, b) => (a.importance ?? 5) - (b.importance ?? 5));
        for (const o of sorted.slice(0, obs.length - cfg.maxObservationsPerProject)) {
          if (await removeSelected(o, project, "project_observation_cap")) stats.capEvictions++;
        }
      }

      const memories = (await kv.list<Memory>(KV.memories)).filter(mem => !protectedArchive({ kind: "memory", id: mem.id }));
      const evictedMemIds = new Set<string>();
      for (const mem of memories) {
        if (mem.forgetAfter) {
          const expiry = new Date(mem.forgetAfter).getTime();
          if (now > expiry) {
            if (dryRun) {
              stats.expiredMemories++;
              evictedMemIds.add(mem.id);
            } else {
              try {
                await kv.delete(KV.memories, mem.id);
                stats.expiredMemories++;
                evictedMemIds.add(mem.id);
              } catch (err) {
                logger.warn("Eviction delete failed", {
                  resource: "memory",
                  id: mem.id,
                  reason: "expired_memory",
                  error: err instanceof Error ? err.message : String(err),
                });
                continue;
              }
              if (mem.imageRef) {
                await decrementImageRef(kv, sdk, mem.imageRef);
              }
              await recordAudit(kv, "delete", "mem::evict", [mem.id], {
                resource: "memory",
                reason: "expired_memory",
                dryRun,
              });
              await deleteAccessLog(kv, mem.id);
            }
          }
        }

        if (
          !evictedMemIds.has(mem.id) &&
          mem.isLatest === false &&
          mem.createdAt
        ) {
          const age = now - new Date(mem.createdAt).getTime();
          if (age > cfg.lowImportanceMaxDays * MS_PER_DAY) {
            if (dryRun) {
              stats.nonLatestMemories++;
            } else {
              try {
                await kv.delete(KV.memories, mem.id);
                stats.nonLatestMemories++;
              } catch (err) {
                logger.warn("Eviction delete failed", {
                  resource: "memory",
                  id: mem.id,
                  reason: "old_non_latest_memory",
                  error: err instanceof Error ? err.message : String(err),
                });
                continue;
              }
              if (mem.imageRef) {
                await decrementImageRef(kv, sdk, mem.imageRef);
              }
              await recordAudit(kv, "delete", "mem::evict", [mem.id], {
                resource: "memory",
                reason: "old_non_latest_memory",
                dryRun,
              });
              await deleteAccessLog(kv, mem.id);
            }
          }
        }
      }

      logger.info("Eviction complete", { stats });
      return { ...stats, protectedSessionsSkipped };
    },
  );
}
