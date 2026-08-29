import type { ISdk } from "iii-sdk";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import type {
  Memory,
  CompressedObservation,
  Session,
} from "../types.js";
import {
  isExcludedCodexAmbientSession,
} from "./observation-visibility.js";
import { findVisibleObservation } from "./observation-access.js";

export function registerVerifyFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::verify", 
    async (data: { id: string; project?: string }) => {
      if (!data.id || typeof data.id !== "string") {
        return { success: false, error: "id is required" };
      }

      const requestedProject =
        typeof data.project === "string" && data.project.trim()
          ? data.project.trim()
          : undefined;
      if (!requestedProject) {
        return { success: false, error: "project is required" };
      }
      const project = requestedProject === "*" ? undefined : requestedProject;
      const memory = await kv.get<Memory>(KV.memories, data.id);
      const memoryInProject = memory
        ? await memoryBelongsToProject(kv, memory, project)
        : false;
      if (memory && memoryInProject) {
        const observationIds = memory.sourceObservationIds || [];
        const observations: Array<{
          observation: CompressedObservation;
          session?: Session;
        }> = [];

        for (const obsId of observationIds) {
          const obs = await findVisibleObservation(
            kv,
            obsId,
            project,
            memory.sessionIds,
          );
          if (obs) {
            const session = await kv.get<Session>(KV.sessions, obs.sessionId);
            observations.push({ observation: obs, session: session || undefined });
          }
        }

        return {
          success: true,
          type: "memory",
          memory: {
            id: memory.id,
            title: memory.title,
            type: memory.type,
            version: memory.version,
            strength: memory.strength,
            isLatest: memory.isLatest,
            createdAt: memory.createdAt,
            updatedAt: memory.updatedAt,
            supersedes: memory.supersedes,
            parentId: memory.parentId,
          },
          citations: observations.map((o) => ({
            observationId: o.observation.id,
            title: o.observation.title,
            type: o.observation.type,
            confidence: o.observation.confidence,
            timestamp: o.observation.timestamp,
            sessionId: o.observation.sessionId,
            sessionProject: o.session?.project,
            sessionStatus: o.session?.status,
          })),
          citationCount: observations.length,
        };
      }

      const obs = await findVisibleObservation(kv, data.id, project);
      if (obs) {
        const session = await kv.get<Session>(KV.sessions, obs.sessionId);
        return {
          success: true,
          type: "observation",
          observation: {
            id: obs.id,
            title: obs.title,
            type: obs.type,
            confidence: obs.confidence,
            importance: obs.importance,
            timestamp: obs.timestamp,
            sessionId: obs.sessionId,
          },
          session: session
            ? {
                id: session.id,
                project: session.project,
                status: session.status,
                startedAt: session.startedAt,
              }
            : null,
          citationCount: 0,
          citations: [],
        };
      }

      return { success: false, error: "not found" };
    },
  );
}

async function memoryBelongsToProject(
  kv: StateKV,
  memory: Memory,
  project?: string,
): Promise<boolean> {
  if (!project) return true;
  if (memory.project) return memory.project === project;
  const sessionIds = memory.sessionIds ?? [];
  if (sessionIds.length === 0) return false;
  const sessions = await Promise.all(
    sessionIds.map((sessionId) => kv.get<Session>(KV.sessions, sessionId)),
  );
  return sessions.every(
    (session) =>
      !!session &&
      session.project === project &&
      !isExcludedCodexAmbientSession(session),
  );
}
