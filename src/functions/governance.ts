import type { ISdk } from "iii-sdk";
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

export function registerGovernanceFunction(sdk: ISdk, kv: StateKV): void {
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

      let deleted = 0;
      for (const id of data.memoryIds) {
        const mem = await kv.get<Memory>(KV.memories, id);
        if (mem) {
          await kv.delete(KV.memories, id);
          await deleteAccessLog(kv, id);
          getSearchIndex().remove(id);
          vectorIndexRemove(id);
          deleted++;
        }
      }
      const archiveStatesRemoved = await finishArchive();

      if (deleted > 0) await flushIndexSave();

      await recordAudit(
        kv,
        "delete",
        "mem::governance-delete",
        data.memoryIds,
        {
          reason: data.reason || "manual deletion",
          deleted,
        },
      );

      logger.info("Governance delete", {
        requested: data.memoryIds.length,
        deleted,
      });
      return { success: true, deleted, total: data.memoryIds.length, ...(archiveStatesRemoved ? { archiveStatesRemoved } : {}) };
    },
  );

  registerObservationWriter(sdk, "mem::governance-bulk",
    async (data: GovernanceFilter & { dryRun?: boolean }) => {

      const hasFilter =
        (data.type && data.type.length > 0) ||
        data.dateFrom ||
        data.dateTo ||
        data.qualityBelow !== undefined || data.project !== undefined;
      if (data.project !== undefined && !exactProject(data.project)) return { success: false, error: "exact project is required" };
      if (!hasFilter && !data.dryRun) {
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
      const failures: Array<{ id: string; error: string }> = [];
      for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
        const batch = candidates.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(
          batch.map(async (mem) => {
            await kv.delete(KV.memories, mem.id);
            await deleteAccessLog(kv, mem.id);
            getSearchIndex().remove(mem.id);
            vectorIndexRemove(mem.id);
            archiveStatesRemoved += await finishArchive({ kind: "memory", id: mem.id });
          }),
        );
        results.forEach((result, j) => {
          const mem = batch[j];
          if (result.status === "fulfilled") {
            successfulIds.push(mem.id);
          } else {
            logger.warn("Governance bulk delete failed", {
              memoryId: mem.id,
              error:
                result.reason instanceof Error
                  ? result.reason.message
                  : String(result.reason),
            });
            failures.push({
              id: mem.id,
              error: "delete_failed",
            });
          }
        });
      }

      if (successfulIds.length > 0) await flushIndexSave();

      await safeAudit(
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
        failed: failures.length,
      });
      return {
        success: failures.length === 0,
        deleted: successfulIds.length,
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
