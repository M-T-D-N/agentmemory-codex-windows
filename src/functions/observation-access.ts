import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import type { CompressedObservation, Session } from "../types.js";
import {
  isExcludedCodexAmbientSession,
  sanitizeCodexAmbientObservation,
} from "./observation-visibility.js";

// Keep fan-out below the iii state-channel saturation point observed on the
// Windows service. Larger bursts can strand one state::get and hold the whole
// invocation even though each lookup is read-only.
const OBSERVATION_LOOKUP_BATCH_SIZE = 8;

export function sessionAllowsObservationAccess(
  session: Session | null | undefined,
  project?: string,
): session is Session {
  return Boolean(
    session &&
      (!project || session.project === project) &&
      !isExcludedCodexAmbientSession(session),
  );
}

export async function readVisibleObservation(
  kv: StateKV,
  sessionId: string,
  observationId: string,
): Promise<CompressedObservation | null> {
  const observation = await kv.get<CompressedObservation>(
    KV.observations(sessionId),
    observationId,
  );
  if (observation?.sessionId !== sessionId) return null;
  return sanitizeCodexAmbientObservation(observation) || null;
}

export async function findVisibleObservation(
  kv: StateKV,
  observationId: string,
  project?: string,
  hintSessionIds?: string[],
): Promise<CompressedObservation | null> {
  if (hintSessionIds) {
    for (const sessionId of hintSessionIds) {
      const session = await kv.get<Session>(KV.sessions, sessionId);
      if (!sessionAllowsObservationAccess(session, project)) continue;
      const observation = await readVisibleObservation(
        kv,
        sessionId,
        observationId,
      );
      if (observation) return observation;
    }
  }

  const sessions = (await kv.list<Session>(KV.sessions)).filter(
    (session) =>
      !hintSessionIds?.includes(session.id) &&
      sessionAllowsObservationAccess(session, project),
  );
  for (
    let start = 0;
    start < sessions.length;
    start += OBSERVATION_LOOKUP_BATCH_SIZE
  ) {
    const batch = sessions.slice(start, start + OBSERVATION_LOOKUP_BATCH_SIZE);
    const observations = await Promise.all(
      batch.map((session) =>
        readVisibleObservation(kv, session.id, observationId)
      ),
    );
    const match = observations.find(
      (observation): observation is CompressedObservation => observation !== null,
    );
    if (match) return match;
  }
  return null;
}
