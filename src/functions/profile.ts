import { createHash } from "node:crypto";
import { readArchiveVisibility } from "./archive.js";
import { resolveReadAgentId } from "./read-agent-scope.js";
import type { ISdk } from "iii-sdk";
import type {
  CompressedObservation,
  Session,
  ProjectProfile,
} from "../types.js";
import { KV } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { recordAudit } from "./audit.js";
import { logger } from "../logger.js";
import {
  isExcludedCodexAmbientSession,
  isCodexInternalAmbientText,
  sanitizeCodexAmbientObservation,
} from "./observation-visibility.js";

export const PROFILE_VISIBILITY_REVISION = 2;
export function profileCacheKey(project: string, agentId?: string) { return agentId === undefined ? project : JSON.stringify([project, agentId]); }

export function registerProfileFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::profile", 
    async (data: { project: string; refresh?: boolean; agentId?: string } | undefined) => {
      if (!data || typeof data.project !== "string" || !data.project.trim()) {
        return { success: false, error: "project is required" };
      }
      const project = data.project.trim();

      const agentId = resolveReadAgentId(data.agentId, "mem::profile");
      const cacheKey = profileCacheKey(project, agentId);
      const { sessions: projectSessions, selectedSessions: top20Sessions, observations: visiblePerSession, sourceDigest } = await readProfileSources(kv, project, agentId);
      if (projectSessions.length === 0) return { profile: null, reason: "no_sessions" };
      const conceptFreq = new Map<string, number>();
      const fileFreq = new Map<string, number>();
      const errors: string[] = [];
      const recentActivity: string[] = [];
      let totalObs = 0;

      if (!data.refresh) {
        const cached = await kv.get<ProjectProfile>(KV.profiles, cacheKey).catch(() => null);
        if (cached && cached.project === project && cached.agentId === agentId && cached.visibilityRevision === PROFILE_VISIBILITY_REVISION && cached.sourceDigest === sourceDigest && profileContentIsVisible(cached) && Date.now() - new Date(cached.updatedAt).getTime() < 3600_000) return { profile: cached, cached: true };
      }
      for (let i = 0; i < top20Sessions.length; i++) {
        const session = top20Sessions[i];
        const observations = visiblePerSession[i];
        totalObs += observations.length;

        for (const obs of observations) {
          for (const concept of obs.concepts || []) {
            conceptFreq.set(concept, (conceptFreq.get(concept) || 0) + 1);
          }
          for (const file of obs.files || []) {
            fileFreq.set(file, (fileFreq.get(file) || 0) + 1);
          }
          if (obs.type === "error") {
            errors.push(obs.title);
          }
        }

        const important = observations
          .filter((o) => o.importance >= 7)
          .sort((a, b) => b.importance - a.importance);
        if (important.length > 0) {
          recentActivity.push(
            `[${session.startedAt.slice(0, 10)}] ${important[0].title}`,
          );
        }
      }

      const topConcepts = Array.from(conceptFreq.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([concept, frequency]) => ({ concept, frequency }));

      const topFiles = Array.from(fileFreq.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([file, frequency]) => ({ file, frequency }));

      const uniqueErrors = [...new Set(errors)].slice(0, 10);

      const profile: ProjectProfile = {
        project,
        updatedAt: new Date().toISOString(),
        visibilityRevision: PROFILE_VISIBILITY_REVISION,
        agentId,
        sourceDigest,
        topConcepts,
        topFiles,
        conventions: extractConventions(topConcepts, topFiles),
        commonErrors: uniqueErrors,
        recentActivity: recentActivity.slice(0, 10),
        sessionCount: projectSessions.length,
        totalObservations: totalObs,
      };

      await kv.set(KV.profiles, cacheKey, profile);
      await recordAudit(kv, "share", "mem::profile", [project], {
        sessionCount: projectSessions.length,
        totalObservations: totalObs,
      });

      logger.info("Profile generated", {
        project,
        sessions: projectSessions.length,
        observations: totalObs,
      });
      return { profile, cached: false };
    },
  );
}

function extractConventions(
  concepts: Array<{ concept: string; frequency: number }>,
  files: Array<{ file: string; frequency: number }>,
): string[] {
  const conventions: string[] = [];

  const tsFiles = files.filter((f) => f.file.endsWith(".ts")).length;
  const jsFiles = files.filter((f) => f.file.endsWith(".js")).length;
  if (tsFiles > jsFiles && tsFiles > 0) {
    conventions.push("TypeScript project");
  }

  const srcFiles = files.filter((f) => f.file.includes("/src/")).length;
  if (srcFiles > files.length * 0.5) {
    conventions.push("Standard src/ directory structure");
  }

  const testFiles = files.filter(
    (f) => f.file.includes("test") || f.file.includes("spec"),
  ).length;
  if (testFiles > 0) {
    conventions.push("Has test files");
  }

  for (const { concept, frequency } of concepts.slice(0, 5)) {
    if (frequency >= 3) {
      conventions.push(`Frequently uses: ${concept}`);
    }
  }

  return conventions;
}

export function profileSourceDigest(sessions: Session[], observations: CompressedObservation[][]): string {
  return createHash("sha256").update(JSON.stringify([sessions.map(s => [s.id, s.startedAt]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))), observations.flat().sort((a,b) => a.id.localeCompare(b.id))])).digest("hex");
}

export async function readProfileSources(kv: StateKV, project: string, agentId?: string) {
  const archived = await readArchiveVisibility(kv);
  const sessions = (await kv.list<Session>(KV.sessions)).filter(s => s.project === project && !isExcludedCodexAmbientSession(s) && !archived({ kind: "session", id: s.id }) && (agentId === undefined || s.agentId === agentId));
  const selectedSessions = [...sessions].sort((a,b) => String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? "")) || a.id.localeCompare(b.id)).slice(0,20);
  const observations = await Promise.all(selectedSessions.map(async session => (await kv.list<CompressedObservation>(KV.observations(session.id))).map(sanitizeCodexAmbientObservation).filter((o): o is CompressedObservation => o !== null && !archived({ kind: "observation", id: o.id, sessionId: session.id }) && (agentId === undefined || o.agentId === agentId))));
  return { sessions, selectedSessions, observations, sourceDigest: profileSourceDigest(sessions, observations) };
}

export function profileContentIsVisible(profile: ProjectProfile): boolean {
  if (![profile.topConcepts, profile.topFiles, profile.conventions, profile.commonErrors, profile.recentActivity].every(Array.isArray)) return false;
  const text = [...profile.topConcepts.map(row => row.concept), ...profile.topFiles.map(row => row.file), ...profile.conventions, ...profile.commonErrors, ...profile.recentActivity, ...(profile.summary ? [profile.summary] : [])];
  return text.every(value => typeof value === "string" && !isCodexInternalAmbientText(value));
}

export async function readCurrentProfile(kv: StateKV, project: string, agentId?: string): Promise<ProjectProfile | null> {
  const cached = await kv.get<ProjectProfile>(KV.profiles, profileCacheKey(project, agentId)).catch(() => null);
  if (!cached || cached.project !== project || cached.agentId !== agentId || cached.visibilityRevision !== PROFILE_VISIBILITY_REVISION || !profileContentIsVisible(cached)) return null;
  const sources = await readProfileSources(kv, project, agentId);
  return cached.sourceDigest === sources.sourceDigest ? cached : null;
}
