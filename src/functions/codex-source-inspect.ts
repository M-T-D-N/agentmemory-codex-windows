import type { CodexCaptureExclusion, CompressedObservation, Session } from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { isExcludedCodexAmbientSession } from "./observation-visibility.js";
import { canonicalCodexCwd } from "./codex-source-identity.js";
import { readCodexWindow } from "../replay/codex-window.js";
import { matchCodexMessages, unmatchedCodexCaptures } from "../replay/codex-match.js";
import { readCodexRetainedSources } from "./codex-retained-source.js";
import { readCodexInventory } from "../replay/codex-inventory.js";

export interface CodexSourceInspectInput {
  project: string;
  sessionId: string;
  sourcePath: string;
  limit?: number;
}

export async function inspectCodexSource(
  kv: StateKV, input: CodexSourceInspectInput,
  managed: { sourceRoot: string; agentId: string },
  readWindow: typeof readCodexWindow = readCodexWindow,
) {
  if (!input || ![input.project, input.sessionId, input.sourcePath].every(value =>
    typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 2048) ||
    input.project === "*" || input.project.length > 512 || input.sessionId.length > 512 ||
    !managed.sourceRoot || !managed.agentId || managed.agentId === "*") throw Error("Exact source inspection scope is required");
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw Error("Inspection limit must be between 1 and 200");
  const session = await kv.get<Session>(KV.sessions, input.sessionId);
  if (!session || session.id !== input.sessionId || session.project !== input.project ||
      typeof session.cwd !== "string" || isExcludedCodexAmbientSession(session)) throw Error("Canonical session does not permit source inspection");
  if (session.agentId && session.agentId !== managed.agentId) throw Error("Session belongs to a different agent");
  const { messages, legacyMessages, last, exclusions } = await readCodexInventory({ sourceRoot: managed.sourceRoot,
    sourcePath: input.sourcePath, sessionId: input.sessionId, includeExcludedMessages: true, sourceHolds: session.codexNativeCapture?.sourceHolds }, readWindow);
  const canonicalCwd = canonicalCodexCwd(session.cwd);
  const transitioned = canonicalCodexCwd(last.source.cwd) !== canonicalCwd;
  if (transitioned && (!last.caughtUp || last.cursor.parser.cwd !== canonicalCwd)) throw Error("Native source and canonical session do not match");
  const observations = await kv.list<CompressedObservation>(KV.observations(input.sessionId), { includeDeleted: true });
  const captureExclusions = await kv.list<CodexCaptureExclusion>(KV.codexCaptureExclusions);
  const unresolvedCaptures = session.codexNativeCapture?.unresolvedCaptures;
  let compared = [...messages, ...legacyMessages];
  let decisions = matchCodexMessages(compared, observations, { ...input, agentId: managed.agentId,
    completeNativeInventory: last.caughtUp, exclusions: captureExclusions, unresolvedCaptures });
  const unresolved = new Set(unmatchedCodexCaptures(observations, decisions).map(row => row.observationId));
  const retained = last.caughtUp ? await readCodexRetainedSources({ sourceRoot: managed.sourceRoot, sourcePath: input.sourcePath, sessionId: input.sessionId },
    compared, observations.filter(row => unresolved.has(row.id)), readWindow) : { messages: [] };
  if (retained.messages.length) {
    compared = [...compared, ...retained.messages];
    decisions = matchCodexMessages(compared, observations, { ...input, agentId: managed.agentId,
      completeNativeInventory: last.caughtUp, exclusions: captureExclusions, unresolvedCaptures });
  }
  const unmatched = unmatchedCodexCaptures(observations, decisions);
  const counts: Record<string, number> = {};
  const reasons: Record<string, number> = {};
  for (const decision of decisions) {
    counts[decision.action] = (counts[decision.action] ?? 0) + 1;
    if (decision.reason) reasons[decision.reason] = (reasons[decision.reason] ?? 0) + 1;
  }
  const current = await kv.get<Session>(KV.sessions, input.sessionId);
  if (!current || current.id !== session.id || isExcludedCodexAmbientSession(current) || current.project !== session.project || current.cwd !== session.cwd ||
      current.agentId !== session.agentId || current.observationCount !== session.observationCount || current.updatedAt !== session.updatedAt) {
    throw Error("Canonical session changed during inspection; retry the read-only comparison");
  }
  const ownerReconciliationRequired = session.agentId !== managed.agentId;
  const retainedIds = new Set(unresolvedCaptures?.map(row => row.observationId));
  const unreviewed = unmatched.some(row => !retainedIds.has(row.observationId));
  return {
    readOnly: true, sessionId: session.id, project: session.project, source: last.source,
    ...(transitioned ? { verifiedCurrentCwd: canonicalCwd } : {}),
    inspectedAt: new Date().toISOString(), completeNativeInventory: last.caughtUp,
    ownerReconciliationRequired,
    status: last.issue || counts.blocked || ownerReconciliationRequired || (last.caughtUp && unreviewed) ? "blocked"
      : !last.caughtUp ? "incomplete" : session.codexNativeCapture?.sourceHolds?.length ? "ready_with_source_holds" : unmatched.length ? "ready_with_unresolved" : "ready",
    nativeMessageCount: messages.length, legacyExcludedMessageCount: legacyMessages.length, retainedSourceMessageCount: retained.messages.length,
    observationCount: observations.length, counts, reasons, exclusions,
    sourceHoldCount: session.codexNativeCapture?.sourceHolds?.length ?? 0, sourceHolds: session.codexNativeCapture?.sourceHolds ?? [],
    retainedUnresolvedCaptureCount: unresolvedCaptures?.length ?? 0,
    unmatchedCaptureCount: unmatched.length, unmatchedCaptures: unmatched.slice(0, limit),
    unmatchedCapturesTruncated: unmatched.length > limit,
    issue: last.issue, incompleteTail: last.incompleteTail, waitingForPrimary: last.waitingForPrimary,
    bytesReadThrough: last.cursor.byteOffset, snapshotBytes: last.snapshotBytes,
    details: decisions.slice(0, limit), detailsTruncated: decisions.length > limit,
  };
}
