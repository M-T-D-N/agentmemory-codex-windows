import type { CompressedObservation, Session } from "../types.js";

export function observationSourceKind(observation: CompressedObservation): "user" | "assistant" | undefined {
  if (observation.codexSource) {
    return observation.codexSource.kind === "user" ? "user"
      : observation.codexSource.kind === "assistant_final" ? "assistant" : undefined;
  }
  if (observation.title === "prompt_submit") return "user";
  if (observation.title === "assistant_response") return "assistant";
  return undefined;
}

import { isCodexInternalAmbientText, isExcludedCodexAmbientSession, stripCodexAmbientUiBlocks } from "../../packaging/windows-codex/hooks/codex-visibility.mjs";
export { isCodexInternalAmbientText, isCodexApprovalReviewText, isExcludedCodexAmbientSession, isIncidentalCodexHostEvent, stripCodexAmbientUiBlocks } from "../../packaging/windows-codex/hooks/codex-visibility.mjs";

export function sanitizeCodexAmbientObservation<
  T extends CompressedObservation,
>(observation: T | null | undefined): T | null {
  if (observation?.emptyDeletion?.state === "deleted") return null;
  if (!observation || typeof observation.narrative !== "string") {
    return observation ?? null;
  }
  if (isCodexInternalAmbientText(observation.narrative)) return null;
  const narrative = stripCodexAmbientUiBlocks(observation.narrative);
  if (narrative === observation.narrative) return observation;
  if (!narrative.trim() || isCodexInternalAmbientText(narrative)) return null;
  return { ...observation, narrative };
}

export function sanitizeCodexProcessingObservation<T extends CompressedObservation>(observation: T | null | undefined): T | null {
  if (!observation || observation.emptyDeletion?.state === "deleted") return null;
  const narrative = typeof observation.narrative === "string" ? stripCodexAmbientUiBlocks(observation.narrative) : observation.narrative;
  return narrative === observation.narrative || !narrative?.trim() ? observation : { ...observation, narrative };
}

export async function filterCodexGraphSources<T extends { sourceSessionIds?: string[] }>(
  kv: Pick<import("../state/kv.js").StateKV, "get">,
  rows: T[],
  checked = new Map<string, boolean>(),
  readSession?: (id: string) => Promise<Session | null>,
): Promise<T[]> {
  const ids = [...new Set(rows.flatMap(row => row.sourceSessionIds ?? []))].filter(id => !checked.has(id));
  for (let start = 0; start < ids.length; start += 8) {
    await Promise.all(ids.slice(start, start + 8).map(async id => {
      const session = await (readSession ? readSession(id) : kv.get<Session>("mem:sessions", id));
      checked.set(id, session?.id === id && isExcludedCodexAmbientSession(session));
    }));
  }
  return rows.filter(row => !row.sourceSessionIds?.length || !row.sourceSessionIds.every(id => checked.get(id) === true));
}
