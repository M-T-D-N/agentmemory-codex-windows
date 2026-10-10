import type { IIIClient } from "iii-sdk";
import type { Memory, GovernanceFilter, AuditEntry } from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { recordAudit, safeAudit, queryAudit } from "./audit.js";
import { deleteAccessLog } from "./access-tracker.js";
import { getSearchIndex, vectorIndexRemove, flushIndexSave } from "./search.js";
import { logger } from "../logger.js";
import { registerObservationWriter } from "../state/observation-write.js";
import { prepareArchiveTargetForget } from "./archive-forget.js";

const exactProject = (project: unknown) => typeof project === "string" && Boolean(project) && project === project.trim() && project !== "*" && project.length <= 512 && !project.includes("\0");
const bulkKeys = new Set(["type", "dateFrom", "dateTo", "project", "qualityBelow", "dryRun", "reason"]);

export function registerGovernanceFunction(sdk: IIIClient, kv: StateKV): void {
  registerObservationWriter(sdk, "mem::governance-delete",
    async (data: { memoryIds: string[]; reason?: string; project?: string }) => {
      if (
        !data.memoryIds ||
        !Array.isArray(data.memoryIds) ||
        data.memoryIds.length === 0 || data.memoryIds.some(id => typeof id !== "string" || !id.trim())
      ) {
        return { success: false, error: "memoryIds array is required" };
      }
      if (data.project !== undefined && !exactProject(data.project)) return { success: false, error: "exact project is required" };
      if (data.project !== undefined) {
        for (const id of data.memoryIds) {
          const row = await kv.get<Memory>(KV.memories, id);
          if (row && row.project !== data.project) return { success: false, error: "memory project mismatch" };
        }
      }
      const finishArchive = await prepareArchiveTargetForget(kv, data.memoryIds.map(id => ({ kind: "memory", id })), data.project, "mem::governance-delete");

      const deletedIds: string[] = [];
      const failures: Array<{ id: string; error: string }> = [];
      const notFound: string[] = [];
      let archiveStatesRemoved = 0;
      for (const id of new Set(data.memoryIds)) {
        try {
          const mem = await kv.get<Memory>(KV.memories, id);
          if (!mem) {
            notFound.push(id);
            archiveStatesRemoved += await finishArchive({ kind: "memory", id });
            continue;
          }
          await kv.delete(KV.memories, id);
          deletedIds.push(id);
          getSearchIndex().remove(id);
          vectorIndexRemove(id);
          const cleanup = await Promise.allSettled([
            deleteAccessLog(kv, id),
            finishArchive({ kind: "memory", id }).then(count => { archiveStatesRemoved += count; }),
          ]);
          if (cleanup.some(result => result.status === "rejected")) failures.push({ id, error: "cleanup_failed" });
        } catch {
          failures.push({ id, error: deletedIds.includes(id) ? "cleanup_failed" : "delete_failed" });
        }
      }
      const deleted = deletedIds.length;

      if (deleted > 0) await flushIndexSave();

      if (deleted > 0) await recordAudit(
        kv,
        "delete",
        "mem::governance-delete",
        deletedIds,
        {
          reason: data.reason || "manual deletion",
          deleted,
          notFound,
          failures: failures.length ? failures : undefined,
        },
      );

      logger.info("Governance delete", {
        requested: data.memoryIds.length,
        deleted,
      });
      return { success: failures.length === 0, deleted, notFound, failed: failures.length, failures: failures.length ? failures : undefined, total: data.memoryIds.length, ...(archiveStatesRemoved ? { archiveStatesRemoved } : {}) };
    },
  );

  registerObservationWriter(sdk, "mem::governance-bulk",
    async (data: GovernanceFilter & { dryRun?: boolean }) => {
      const unknown = Object.keys(data).filter(key => !bulkKeys.has(key));
      if (unknown.length) return { success: false, error: `Unsupported bulk delete filter: ${unknown.join(", ")}` };
      const hasFilter =
        (data.type && data.type.length > 0) ||
        data.dateFrom ||
        data.dateTo ||
        data.qualityBelow !== undefined || data.project !== undefined;
      if (data.project !== undefined && !exactProject(data.project)) return { success: false, error: "project must be a non-empty string naming an exact project" };
      if (!hasFilter) {
        return {
          success: false,
          error: "At least one filter is required for non-dryRun bulk delete",
        };
      }

      const memories = await kv.list<Memory>(KV.memories);
      let candidates = data.project === undefined ? memories : memories.filter(memory => memory.project === data.project);

      if (data.type && data.type.length > 0) {
        candidates = candidates.filter((m) => data.type!.includes(m.type));
      }
      if (data.dateFrom) {
        const from = new Date(data.dateFrom).getTime();
        if (Number.isNaN(from)) {
          return { success: false, error: "Invalid dateFrom format" };
        }
        candidates = candidates.filter(
          (m) => new Date(m.createdAt).getTime() >= from,
        );
      }
      if (data.dateTo) {
        const to = new Date(data.dateTo).getTime();
        if (Number.isNaN(to)) {
          return { success: false, error: "Invalid dateTo format" };
        }
        candidates = candidates.filter(
          (m) => new Date(m.createdAt).getTime() <= to,
        );
      }
      if (data.qualityBelow !== undefined) {
        candidates = candidates.filter((m) => m.strength < data.qualityBelow!);
      }

      const finishArchive = await prepareArchiveTargetForget(kv, candidates.map(memory => ({ kind: "memory", id: memory.id })), data.project, "mem::governance-bulk");
      if (data.dryRun) {
        return {
          success: true,
          dryRun: true,
          wouldDelete: candidates.length,
          ids: candidates.map((m) => m.id),
          ...(finishArchive.targets.length ? { archiveTargets: finishArchive.targets } : {}),
        };
      }

      const BATCH_SIZE = 50;
      let archiveStatesRemoved = 0;
      const successfulIds: string[] = [];
      const notFound: string[] = [];
      const failures: Array<{ id: string; error: string }> = [];
      for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
        const batch = candidates.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(
          batch.map(async (mem) => {
            const current = await kv.get<Memory>(KV.memories, mem.id);
            if (!current) { notFound.push(mem.id); return; }
            if ((data.project !== undefined && current.project !== data.project) ||
                (data.type?.length && !data.type.includes(current.type)) ||
                (data.dateFrom && Date.parse(current.createdAt) < Date.parse(data.dateFrom)) ||
                (data.dateTo && Date.parse(current.createdAt) > Date.parse(data.dateTo)) ||
                (data.qualityBelow !== undefined && !(current.strength < data.qualityBelow))) throw Error("candidate_changed");
            await kv.delete(KV.memories, mem.id);
            successfulIds.push(mem.id);
            getSearchIndex().remove(mem.id);
            vectorIndexRemove(mem.id);
            const cleanup = await Promise.allSettled([
              deleteAccessLog(kv, mem.id),
              finishArchive({ kind: "memory", id: mem.id }).then(count => { archiveStatesRemoved += count; }),
            ]);
            if (cleanup.some(result => result.status === "rejected")) throw Error("cleanup_failed");
          }),
        );
        results.forEach((result, j) => {
          const mem = batch[j];
          if (result.status === "rejected") {
            logger.warn("Governance bulk delete failed", {
              memoryId: mem.id,
              error:
                result.reason instanceof Error
                  ? result.reason.message
                  : String(result.reason),
            });
            failures.push({
              id: mem.id,
              error: successfulIds.includes(mem.id) ? "cleanup_failed" : "delete_failed",
            });
          }
        });
      }

      if (successfulIds.length > 0) await flushIndexSave();

      if (successfulIds.length > 0) await safeAudit(
        kv,
        "delete",
        "mem::governance-bulk",
        successfulIds,
        {
          filter: data,
          deleted: successfulIds.length,
          failed: failures.length,
          failures: failures.length > 0 ? failures : undefined,
        },
      );

      logger.info("Governance bulk delete", {
        deleted: successfulIds.length,
        notFound,
        failed: failures.length,
      });
      return {
        success: failures.length === 0,
        deleted: successfulIds.length,
        notFound,
        failed: failures.length,
        failures: failures.length > 0 ? failures : undefined,
        ...(archiveStatesRemoved ? { archiveStatesRemoved } : {}),
      };
    },
  );

  sdk.registerFunction("mem::audit-query", 
    async (data?: {
      operation?: AuditEntry["operation"];
      dateFrom?: string;
      dateTo?: string;
      limit?: number;
    }) => {
      return queryAudit(kv, data);
    },
  );
}
