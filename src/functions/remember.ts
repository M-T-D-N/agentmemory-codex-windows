import { markCaptureEventDeleted } from "../capture/event-record.js";
import { unindexObservationSession } from "../state/obs-index.js";
import { removeSessionFromProjectIndex, addSessionToProjectIndex } from "../state/session-index.js";
import { withObservationWrite, registerObservationWriter } from "../state/observation-write.js";
import { TriggerAction, type IIIClient } from "iii-sdk";
import type { Memory, RawObservation, Session } from "../types.js";
import { KV, generateId, jaccardSimilarity } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { withKeyedLock, withKeyedLocks } from "../state/keyed-mutex.js";
import { currentMemoryHeads, memoryToObservation } from "../state/memory-utils.js";
import { deleteAccessLog } from "./access-tracker.js";
import { safeAudit } from "./audit.js";
import {
  getSearchIndex,
  isMemoryIndexReady,
  vectorIndexAddGuarded,
  vectorIndexRemove,
  flushIndexSave,
  scheduleIndexSave,
} from "./search.js";
import { resolveReadAgentId } from "./read-agent-scope.js";
import { readArchiveVisibility } from "./archive.js";
import { getAgentId } from "../config.js";
import { logger } from "../logger.js";
import {
  validateObservationProvenance,
  type ObservationSourceInput,
} from "./provenance.js";
import { sessionLifecycleLockKey } from "./session-lifecycle.js";
import { retainCodexForgetExclusions } from "./codex-capture-exclusion.js";
import { prepareArchiveForget } from "./archive-forget.js";
import {
  GRAPH_WRITE_LOCK,
  detachForgottenGraphProvenance,
  type GraphForgetProvenanceResult,
} from "./graph.js";

type ForgetObservation = RawObservation & { imageRef?: string };

// Slicing by UTF-16 code unit can cut an astral character (emoji, some CJK
// extensions) mid surrogate pair, leaving a lone high surrogate that renders
// as a replacement glyph. Drop a dangling trailing high surrogate so the
// title stays valid.
function safeSlice(text: string, length: number): string {
  const sliced = text.slice(0, length);
  return /[\uD800-\uDBFF]$/.test(sliced) ? sliced.slice(0, -1) : sliced;
}

export function memoryTitleFromContent(content: string): string { return safeSlice(content, 80); }

export function registerRememberFunction(sdk: IIIClient, kv: StateKV): void {
  registerObservationWriter(sdk, "mem::remember",
    async (data: {
      content: string;
      type?: string;
      concepts?: string[];
      files?: string[];
      ttlDays?: number;
      sourceObservationIds?: string[];
      sources?: ObservationSourceInput[];
      agentId?: string;
      project?: string;
    }) => {
      if (
        !data.content ||
        typeof data.content !== "string" ||
        !data.content.trim()
      ) {
        return { success: false, error: "content is required" };
      }
      if (data.files && !Array.isArray(data.files)) {
        return { success: false, error: "files must be an array" };
      }
      if (data.concepts && !Array.isArray(data.concepts)) {
        return { success: false, error: "concepts must be an array" };
      }
      if (data.sourceObservationIds !== undefined && !Array.isArray(data.sourceObservationIds)) {
        return { success: false, error: "sourceObservationIds must be an array" };
      }
      if (data.sources !== undefined && !Array.isArray(data.sources)) {
        return { success: false, error: "sources must be an array" };
      }
      const validTypes = new Set([
        "pattern",
        "preference",
        "architecture",
        "bug",
        "workflow",
        "fact",
      ]);
      const memType = validTypes.has(data.type || "")
        ? (data.type as Memory["type"])
        : "fact";

      const now = new Date().toISOString();
      // Normalize project early so every subsequent comparison and storage
      // operation uses the same cleaned value. Raw data.project must not be
      // referenced below this point.
      const project =
        typeof data.project === "string" && data.project.trim().length > 0
          ? data.project.trim()
          : undefined;
      if (project === "*") {
        return { success: false, error: "project '*' is read-only and cannot be used for durable writes" };
      }
      if (project && project.length > 512) {
        return { success: false, error: "project must be at most 512 characters" };
      }

      if (data.agentId !== undefined && (typeof data.agentId !== "string" || data.agentId.length > 512 || data.agentId.trim() === "*")) {
        return { success: false, error: "agentId must be an exact non-empty owner of at most 512 characters" };
      }
      const callAgentId = data.agentId?.trim() || getAgentId();

      const result = await withKeyedLock("mem:remember", async () => {
        let provenance = {
          sourceSessionIds: [] as string[],
          sourceObservationIds: [] as string[],
        };
        if (
          (data.sources?.length ?? 0) > 0 ||
          (data.sourceObservationIds?.length ?? 0) > 0
        ) {
          if (!project) {
            return {
              success: false,
              error: "project is required when source provenance is provided",
            };
          }
          try {
            provenance = await validateObservationProvenance(kv, {
              project,
              sources: data.sources,
              sourceObservationIds: data.sourceObservationIds,
            });
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }

        // Candidate generation: query the BM25 index with the new content
        // and Jaccard-compare only the top hits, instead of walking the
        // full memory corpus on every save. The index receives every
        // memory at save time and is rebuilt at boot, so it covers the
        // corpus whenever it is non-empty; a cold, never-queried index
        // falls back to the full scan so supersession never silently
        // stops working.
        const archived = await readArchiveVisibility(kv);
        const owns = (memory: Memory) => memory.project === project && memory.agentId === callAgentId
          && !archived({ kind: "memory", id: memory.id });
        const idx = getSearchIndex();
        let candidateMemories: Memory[];
        try {
          if (isMemoryIndexReady() && idx.size > 0) {
            const hits = idx.search(data.content, idx.size).filter(h => h.obsId.startsWith("mem_"));
            candidateMemories = [];
            for (let offset = 0; offset < hits.length && candidateMemories.length < 50; offset += 50) {
              const loaded = await Promise.all(hits.slice(offset, offset + 50).map(h => kv.get<Memory>(KV.memories, h.obsId)));
              candidateMemories.push(...loaded.filter((m): m is Memory => m !== null && owns(m) && m.isLatest !== false));
            }
            candidateMemories = candidateMemories.slice(0, 50);
          } else {
            candidateMemories = currentMemoryHeads(await kv.list<Memory>(KV.memories)).filter(owns);
          }
        } catch (err) {
          // Candidate generation is an optimization; a failure here must
          // never block the save itself.
          logger.warn("supersession candidate lookup failed, using full scan", {
            error: err instanceof Error ? err.message : JSON.stringify(err),
          });
          candidateMemories = currentMemoryHeads(await kv.list<Memory>(KV.memories)).filter(owns);
        }
        let supersededId: string | undefined;
        let supersededVersion = 1;
        let supersededMemory: Memory | undefined;
        // Track the closest sub-threshold match: not similar enough to
        // supersede, but similar enough that the caller may want to
        // consolidate. Reported back as a hint; never acted on here.
        let nearMatch: { id: string; title: string; similarity: number } | undefined;
        const lowerContent = data.content.toLowerCase();
        for (const candidate of candidateMemories) {
          const existing = await kv.get<Memory>(KV.memories, candidate.id);
          if (!existing || existing.isLatest === false || !owns(existing)) continue;
          const similarity = jaccardSimilarity(
            lowerContent,
            existing.content.toLowerCase(),
          );
          if (similarity > 0.7) {
            supersededId = existing.id;
            supersededVersion = existing.version ?? 1;
            supersededMemory = existing;
            break;
          }
          if (
            similarity > 0.4 &&
            (!nearMatch || similarity > nearMatch.similarity)
          ) {
            nearMatch = { id: existing.id, title: existing.title, similarity };
          }
        }

        const memory: Memory = {
          id: generateId("mem"),
          createdAt: now,
          updatedAt: now,
          type: memType,
          title: memoryTitleFromContent(data.content),
          content: data.content,
          concepts: data.concepts || [],
          files: data.files || [],
          sessionIds: [
            ...new Set([
              ...(supersededMemory?.sessionIds ?? []),
              ...provenance.sourceSessionIds,
            ]),
          ],
          strength: 7,
          version: supersededId ? supersededVersion + 1 : 1,
          parentId: supersededId,
          supersedes: supersededId ? [supersededId] : [],
          sourceObservationIds: [
            ...new Set(
              [
                ...(supersededMemory?.sourceObservationIds ?? []),
                ...provenance.sourceObservationIds,
              ].filter(
                (id): id is string => typeof id === "string" && id.length > 0,
              ),
            ),
          ],
          isLatest: true,
          origin: { channel: "agent", capturedAt: now },
          ...(callAgentId ? { agentId: callAgentId } : {}),
          ...(project !== undefined && { project }),
        };

        if (data.ttlDays && typeof data.ttlDays === "number" && data.ttlDays > 0) {
          memory.forgetAfter = new Date(Date.now() + data.ttlDays * 86400000).toISOString();
        }

        await kv.set(KV.memories, memory.id, memory);
        if (supersededMemory) {
          await kv.set(KV.memories, supersededMemory.id, { ...supersededMemory, isLatest: false });
          // The superseded version stays in KV (the viewer's version
          // chain reads it there) but leaves both search indexes:
          // recall returning an outdated fact as if current is worse
          // than returning nothing.
          try {
            getSearchIndex().remove(supersededMemory.id);
          } catch {}
          vectorIndexRemove(supersededMemory.id);
        }

        // Without this, mem::remember persists the row but the BM25
        // index never sees it, so memory_smart_search and memory_recall
        // return empty even seconds after save (#257). Use try/catch so
        // an indexing failure doesn't block the save itself — the
        // restart-time rebuild will pick the memory up either way.
        try {
          getSearchIndex().add(memoryToObservation(memory));
        } catch (err) {
          logger.warn("Failed to index saved memory into BM25", {
            memId: memory.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        if (supersededMemory) await flushIndexSave({ reportFailure: true });
        else scheduleIndexSave();

        if (supersededId) {
          await sdk.trigger({
            function_id: "mem::cascade-update",
            payload: {
              supersededMemoryId: supersededId,
            },
            action: TriggerAction.Void(),
          });
        }

        await safeAudit(kv, "remember", "mem::remember", [memory.id], {
          project: memory.project,
          sourceSessionIds: memory.sessionIds,
          sourceObservationIds: memory.sourceObservationIds,
          supersededId,
        });

        logger.info("Memory saved", {
          memId: memory.id,
          type: memory.type,
          project: memory.project,
        });
        // similarTo is advisory only: a close-but-not-superseding match
        // the caller may want to consolidate via memory_update/forget.
        return {
          success: true,
          memory,
          ...(nearMatch && !supersededId
            ? {
                similarTo: {
                  ...nearMatch,
                  similarity: Math.round(nearMatch.similarity * 100) / 100,
                },
              }
            : {}),
        };
      });
      if (result.success && "memory" in result && result.memory) {
        const memory = result.memory;
        await vectorIndexAddGuarded(memory.id, memory.sessionIds?.[0] ?? "memory",
          memory.title + " " + memory.content, { kind: "memory", logId: memory.id },
          write => withKeyedLock("mem:remember", async () => {
            const current = await kv.get<Memory>(KV.memories, memory.id);
            if (!current || current.isLatest === false || current.content !== memory.content ||
                current.title !== memory.title || current.project !== memory.project) return false;
            write();
            return true;
          }));
      }
      return result;
    },
  );

  sdk.registerFunction("mem::forget",
    async (data: {
      sessionId?: string;
      observationIds?: string[];
      memoryId?: string;
      agentId?: string;
      project?: string;
      dryRun?: boolean;
      action?: string;
      expectedVersion?: number;
      reason?: string;
    }) => {
      if (data.action !== undefined) {
        const { changeEmptyObservation } = await import("./empty-observation.js");
        return changeEmptyObservation(kv, data);
      }
      if (data.dryRun !== undefined && typeof data.dryRun !== "boolean") return { success: false, error: "dryRun must be a boolean" };
      if (data.observationIds !== undefined && (!Array.isArray(data.observationIds) || data.observationIds.length === 0)) {
        return { success: false, error: "observationIds must be a non-empty array; omit it only for explicit whole-session deletion" };
      }
      if (data.dryRun === true) {
        try {
          const { previewSessionForget } = await import("./forget-preview.js");
          return await previewSessionForget(kv, data);
        } catch (error) {
          return { success: false, dryRun: true, error: error instanceof Error ? error.message : String(error) };
        }
      }
      return withObservationWrite(async () => {
      kv.assertRecoveryImportAllowed({ sessionId: data.sessionId, observationIds: data.observationIds });
      const agentId = resolveReadAgentId(data.agentId, "mem::forget");
      const assertOwner = (row: { project?: string; agentId?: string } | null) => {
        if (row && (data.project !== undefined && data.project !== row.project || agentId !== undefined && agentId !== row.agentId)) throw Error("Forget ownership mismatch");
      };
      const owners = await Promise.all([
        data.sessionId ? kv.get<Session>(KV.sessions, data.sessionId) : Promise.resolve(null),
        data.memoryId ? kv.get<Memory>(KV.memories, data.memoryId) : Promise.resolve(null),
      ]);
      owners.forEach(assertOwner);
      let finishArchiveForget = async () => 0;
      let memoryArchiveStatesRemoved = 0;
      let deleted = 0;
      const deletedMemoryIds: string[] = [];
      const deletedObservationIds: string[] = [];
      let deletedSession = false;
      let alreadyAbsent = false;
      let graphResult: GraphForgetProvenanceResult = {
        graphNodesDetached: 0,
        graphNodesDeleted: 0,
        graphEdgesDetached: 0,
        graphEdgesDeleted: 0,
        graphNodeIds: [],
        graphEdgeIds: [],
      };
      const { decrementImageRef } = await import("./image-refs.js");

      const cleanupFailures: Array<{ id: string; step: string; error: string }> = [];
      const cleanup = async (id: string, step: string, action: () => void | Promise<void>) => {
        try { await action(); }
        catch (error) { cleanupFailures.push({ id, step, error: error instanceof Error ? error.message : String(error) }); }
      };
      let indexFlushAttempted = false;
      try {
      const sessionId = data.sessionId;
      if (sessionId) {
        await withKeyedLock(
          GRAPH_WRITE_LOCK,
          () =>
            withKeyedLocks(
              ["mem:remember", sessionLifecycleLockKey(sessionId)],
              async () => {
                finishArchiveForget = await prepareArchiveForget(kv, data);
                const session = await kv.get<Session>(KV.sessions, sessionId);
                assertOwner(session);
                const summary = await kv.get(KV.summaries, sessionId);
                const observations = await kv.list<ForgetObservation>(
                  KV.observations(sessionId),
                );
                if (!session) {
                  if (observations.length > 0 || summary) {
                    throw new Error(
                      `session metadata is missing for exact forget: ${sessionId}`,
                    );
                  }
                  alreadyAbsent = true;
                  return;
                }
                const requestedObservationIds = Array.isArray(data.observationIds)
                  ? [...new Set(data.observationIds.filter(
                      (id): id is string => typeof id === "string" && id.length > 0,
                    ))]
                  : [];
                if (
                  Array.isArray(data.observationIds) &&
                  requestedObservationIds.length !== data.observationIds.length
                ) {
                  throw new Error("observationIds must contain unique non-empty strings");
                }
                const wholeSession = requestedObservationIds.length === 0 && !data.memoryId;
                const observationById = new Map(
                  observations.map((observation) => [observation.id, observation]),
                );
                const targetObservations = wholeSession
                  ? observations
                  : requestedObservationIds
                    .map((id) => observationById.get(id))
                    .filter((observation): observation is ForgetObservation => Boolean(observation));
                if (wholeSession || targetObservations.length > 0) {
                  await retainCodexForgetExclusions(kv, session,
                    targetObservations as unknown as Array<{ id: string; [key: string]: unknown }>, wholeSession);
                  graphResult = await detachForgottenGraphProvenance(kv, {
                    project: session.project,
                    sessionId,
                    forgottenObservationIds: targetObservations.map((observation) =>
                      observation.id
                    ),
                    sessionObservationIds: observations.map((observation) => observation.id),
                  });
                }

                const targetIds = new Set(
                  targetObservations.map((observation) => observation.id),
                );
                for (const obs of targetObservations) {
                  await markCaptureEventDeleted(kv, obs);
                  await kv.delete(KV.observations(sessionId), obs.id);
                  await unindexObservationSession(kv, obs.id);
                  deletedObservationIds.push(obs.id);
                  deleted++;
                  if (obs.imageData) await cleanup(obs.id, "image", () => decrementImageRef(kv, sdk, obs.imageData!));
                  if (obs.imageRef && obs.imageRef !== obs.imageData) {
                    await cleanup(obs.id, "image", () => decrementImageRef(kv, sdk, obs.imageRef!));
                  }
                  await cleanup(obs.id, "keyword-index", () => getSearchIndex().remove(obs.id));
                  await cleanup(obs.id, "vector-index", () => vectorIndexRemove(obs.id));
                }

                if (wholeSession) {
                  await kv.delete(KV.sessions, sessionId);
                  await removeSessionFromProjectIndex(kv, session.project, sessionId);
                  deletedSession = true;
                  deleted++;
                  if (summary) {
                    await kv.delete(KV.summaries, sessionId);
                    deleted++;
                  }
                } else if (targetIds.size > 0) {
                  const ordered = [...observations].sort(
                    (a, b) =>
                      String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? "")) ||
                      a.id.localeCompare(b.id),
                  );
                  const remaining = ordered.filter((observation) => !targetIds.has(observation.id));
                  const nextSession: Session = {
                    ...session,
                    observationCount: remaining.length,
                    updatedAt: new Date().toISOString(),
                  };
                  delete nextSession.summary;
                  delete nextSession.firstPrompt;
                  for (const field of [
                    "semanticGraphThroughObservationId",
                    "semanticGraphBackfillThroughObservationId",
                  ] as const) {
                    const cursor = session[field];
                    if (!cursor || !targetIds.has(cursor)) continue;
                    const cursorIndex = ordered.findIndex((observation) => observation.id === cursor);
                    const prior = ordered
                      .slice(0, Math.max(0, cursorIndex))
                      .filter((observation) => !targetIds.has(observation.id))
                      .at(-1);
                    delete nextSession[field];
                    if (prior) nextSession[field] = prior.id;
                  }
                  await kv.set(KV.sessions, sessionId, nextSession);
                  await addSessionToProjectIndex(kv, nextSession.project, nextSession);
                } else {
                  alreadyAbsent = true;
                }
              },
            ),
        );
      }

      const memoryId = data.memoryId;
      if (memoryId) await withKeyedLock("mem:remember", async () => {
        const finishMemoryArchive = await prepareArchiveForget(kv, { memoryId: memoryId, project: data.project });
        const mem = await kv.get<Memory>(KV.memories, memoryId);
        if (mem) {
          assertOwner(mem);
          const ancestors = new Map((await kv.list<Memory>(KV.memories)).map(row => [row.id, row]));
          const pending = [...(mem.supersedes ?? []), ...(mem.parentId ? [mem.parentId] : [])];
          const visited = new Set<string>();
          const retired: string[] = [];
          while (pending.length) {
            const id = pending.pop()!;
            if (visited.has(id)) continue;
            visited.add(id);
            const ancestor = ancestors.get(id);
            if (!ancestor || ancestor.project !== mem.project || ancestor.agentId !== mem.agentId
              || (ancestor.version ?? 1) >= (mem.version ?? 1)) continue;
            pending.push(...(ancestor.supersedes ?? []), ...(ancestor.parentId ? [ancestor.parentId] : []));
            if (ancestor.isLatest !== false) {
              await kv.set(KV.memories, id, { ...ancestor, isLatest: false });
              retired.push(id);
            }
          }
          if (retired.length) await safeAudit(kv, "forget", "mem::forget", retired, { action: "retire-superseded-ancestors", memoryId });
          await kv.delete(KV.memories, memoryId);
          deletedMemoryIds.push(memoryId);
          deleted++;
          alreadyAbsent = false;
          if (mem.imageRef) await cleanup(memoryId, "image", () => decrementImageRef(kv, sdk, mem.imageRef!));
          await cleanup(memoryId, "access", () => deleteAccessLog(kv, memoryId!, { requireSuccess: true }));
          await cleanup(memoryId, "keyword-index", () => getSearchIndex().remove(memoryId!));
          await cleanup(memoryId, "vector-index", () => vectorIndexRemove(memoryId!));
        } else if (!sessionId || deleted === 0) {
          alreadyAbsent = true;
        }
        memoryArchiveStatesRemoved += await finishMemoryArchive();
      });

      const archiveStatesRemoved = memoryArchiveStatesRemoved + await finishArchiveForget();
      if (deleted > 0) { indexFlushAttempted = true; await cleanup("search", "persistence", () => flushIndexSave({ reportFailure: true })); }
      logger.info("Memory forgotten", { deleted });
      return {
        success: true,
        deleted,
        ...(cleanupFailures.length ? { cleanupFailed: cleanupFailures.length, cleanupFailures } : {}),
        ...(archiveStatesRemoved ? { archiveStatesRemoved } : {}),
        ...(sessionId && alreadyAbsent && deleted === 0 ? { alreadyAbsent: true } : {}),
        ...(sessionId ? graphResult : {}),
      };
      } finally {
        if (deleted > 0) {
          if (!indexFlushAttempted) await cleanup("search", "persistence", () => flushIndexSave({ reportFailure: true }));
        await safeAudit(
          kv,
          "forget",
          "mem::forget",
          [
            ...deletedMemoryIds,
            ...deletedObservationIds,
            ...graphResult.graphNodeIds,
            ...graphResult.graphEdgeIds,
          ],
          {
            sessionId: data.sessionId,
            deleted,
            memoriesDeleted: deletedMemoryIds.length,
            observationsDeleted: deletedObservationIds.length,
            sessionDeleted: deletedSession,
            ...graphResult,
            reason: "user-initiated forget",
            ...(cleanupFailures.length ? { cleanupFailed: cleanupFailures.length, cleanupFailures } : {}),
          },
        );
        }
      }
      });
    },
  );
}
