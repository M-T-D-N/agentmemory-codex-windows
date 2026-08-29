import type { Session } from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import {
  isExcludedCodexAmbientSession,
} from "./observation-visibility.js";
import { readVisibleObservation } from "./observation-access.js";

export interface ObservationSourceInput {
  sessionId: string;
  observationIds: string[];
}

export interface ValidatedObservationProvenance {
  sourceSessionIds: string[];
  sourceObservationIds: string[];
}

const MAX_TOTAL_SOURCE_OBSERVATIONS = 500;

function normalizedIds(value: unknown, label: string, max: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > max) throw new Error(`${label} may contain at most ${max} IDs`);
  const ids = value.map((raw) =>
    typeof raw === "string" ? raw.trim() : "",
  );
  if (ids.some((id) => !id)) {
    throw new Error(`${label} must contain only non-empty strings`);
  }
  return [...new Set(ids)];
}

async function validateSession(
  kv: StateKV,
  sessionId: string,
  project: string,
): Promise<Session> {
  const session = await kv.get<Session>(KV.sessions, sessionId);
  if (!session) throw new Error(`unknown source session: ${sessionId}`);
  if (session.project !== project) {
    throw new Error(`source session project mismatch: ${sessionId}`);
  }
  if (isExcludedCodexAmbientSession(session)) {
    throw new Error(`source session is excluded from capture: ${sessionId}`);
  }
  return session;
}

async function requireObservation(
  kv: StateKV,
  sessionId: string,
  observationId: string,
): Promise<void> {
  const observation = await readVisibleObservation(kv, sessionId, observationId);
  if (!observation) {
    throw new Error(`unknown source observation: ${observationId}`);
  }
}

/**
 * Validate durable-write citations against official sessions and observations.
 * Structured sources are preferred. Flat observation IDs remain supported for
 * older clients and are resolved only inside the exact project.
 */
export async function validateObservationProvenance(
  kv: StateKV,
  input: {
    project: string;
    sources?: ObservationSourceInput[];
    sourceObservationIds?: string[];
  },
): Promise<ValidatedObservationProvenance> {
  const project = input.project.trim();
  if (!project || project === "*" || project.length > 512) {
    throw new Error(
      "project is required for durable writes, must not be '*', and must be at most 512 characters",
    );
  }

  const sourceSessionIds: string[] = [];
  const sourceObservationIds: string[] = [];
  const structured = input.sources ?? [];
  if (!Array.isArray(structured) || structured.length > 50) {
    throw new Error("sources must be an array with at most 50 entries");
  }
  const flatIds = normalizedIds(
    input.sourceObservationIds,
    "sourceObservationIds",
    MAX_TOTAL_SOURCE_OBSERVATIONS,
  );
  const requestedIds = new Set(flatIds);
  for (const source of structured) {
    for (const id of normalizedIds(
      source?.observationIds,
      "source.observationIds",
      MAX_TOTAL_SOURCE_OBSERVATIONS,
    )) requestedIds.add(id);
  }
  if (requestedIds.size > MAX_TOTAL_SOURCE_OBSERVATIONS) {
    throw new Error(
      `provenance may cite at most ${MAX_TOTAL_SOURCE_OBSERVATIONS} observations in total`,
    );
  }
  for (const source of structured) {
    const sessionId =
      typeof source?.sessionId === "string" ? source.sessionId.trim() : "";
    if (!sessionId) throw new Error("each source.sessionId is required");
    await validateSession(kv, sessionId, project);
    const ids = normalizedIds(
      source.observationIds,
      "source.observationIds",
      MAX_TOTAL_SOURCE_OBSERVATIONS,
    );
    if (ids.length === 0) {
      throw new Error("each source.observationIds must contain at least one ID");
    }
    await Promise.all(
      ids.map((observationId) => requireObservation(kv, sessionId, observationId)),
    );
    sourceObservationIds.push(...ids);
    sourceSessionIds.push(sessionId);
  }

  const unresolved = new Set(flatIds);
  for (const id of sourceObservationIds) unresolved.delete(id);
  if (unresolved.size > 0) {
    const sessions = (await kv.list<Session>(KV.sessions)).filter(
      (session) =>
        session.project === project && !isExcludedCodexAmbientSession(session),
    );
    for (const session of sessions) {
      if (unresolved.size === 0) break;
      const candidates = [...unresolved];
      const observations = await Promise.all(
        candidates.map((observationId) =>
          readVisibleObservation(kv, session.id, observationId)
        ),
      );
      for (let index = 0; index < candidates.length; index++) {
        const observationId = candidates[index];
        const observation = observations[index];
        if (observation) {
          sourceSessionIds.push(session.id);
          sourceObservationIds.push(observationId);
          unresolved.delete(observationId);
        }
      }
    }
    if (unresolved.size > 0) {
      throw new Error(
        `unknown or cross-project source observation: ${[...unresolved][0]}`,
      );
    }
  }

  return {
    sourceSessionIds: [...new Set(sourceSessionIds)],
    sourceObservationIds: [...new Set(sourceObservationIds)],
  };
}
