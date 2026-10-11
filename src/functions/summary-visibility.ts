import { createHash } from "node:crypto";
import type { CompressedObservation, Session, SessionSummary } from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import type { ArchiveVisibility } from "./archive.js";
import { isCodexInternalAmbientText, isExcludedCodexAmbientSession, sanitizeCodexAmbientObservation } from "./observation-visibility.js";

export const SUMMARY_VISIBILITY_REVISION = 2;
export function summarySourceDigest(observations: CompressedObservation[]): string {
  return createHash("sha256").update(JSON.stringify(observations.filter(o => !!o.title).sort((a,b) => a.id.localeCompare(b.id)))).digest("hex");
}

export function isCurrentSessionSummary(
  summary: SessionSummary | null,
  session: Session,
  observations: CompressedObservation[],
  archived: ArchiveVisibility,
): summary is SessionSummary {
  if (!summary || isExcludedCodexAmbientSession(session)
    || archived({ kind: "session", id: session.id })
    || archived.hasArchivedObservations(session.id)
    || summary.sessionId !== session.id || summary.project !== session.project
    || summary.visibilityRevision !== SUMMARY_VISIBILITY_REVISION
    || summary.sourceDigest !== summarySourceDigest(observations)
    || summary.observationCount !== observations.filter(o => !!o.title).length
    || ![summary.keyDecisions, summary.filesModified, summary.concepts].every(Array.isArray)) return false;
  return [summary.title, summary.narrative, ...summary.keyDecisions, ...summary.filesModified, ...summary.concepts]
    .every(text => typeof text === "string" && !isCodexInternalAmbientText(text));
}

export async function readVisibleSessionSummary(
  kv: StateKV,
  session: Session,
  archived: ArchiveVisibility,
  agentId?: string,
  candidate?: SessionSummary,
): Promise<SessionSummary | null> {
  if (isExcludedCodexAmbientSession(session) || (agentId !== undefined && session.agentId !== agentId)
    || archived({ kind: "session", id: session.id }) || archived.hasArchivedObservations(session.id)) return null;
  const summary = candidate ?? await kv.get<SessionSummary>(KV.summaries, session.id);
  if (!summary || summary.visibilityRevision !== SUMMARY_VISIBILITY_REVISION) return null;
  const observations = (await kv.list<CompressedObservation>(KV.observations(session.id)))
    .map(sanitizeCodexAmbientObservation)
    .filter((o): o is CompressedObservation => o !== null && o.sessionId === session.id
      && !archived({ kind: "observation", id: o.id, sessionId: session.id })
      && (agentId === undefined || o.agentId === agentId));
  return isCurrentSessionSummary(summary, session, observations, archived) ? summary : null;
}
