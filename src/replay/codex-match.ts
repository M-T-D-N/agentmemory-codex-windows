import { createHash } from "node:crypto";
import { validateUnresolvedCodexCaptures } from "./codex-unresolved-capture.js";
import { matchCodexDuplicateCaptures } from "./codex-duplicate-match.js";
import type { CodexCaptureExclusion, CompressedObservation } from "../types.js";
import type { CodexNativeMessage } from "./codex-record.js";
import { validateCodexExclusion } from "../functions/codex-capture-exclusion.js";
import { isCodexApprovalReviewText, isCodexInternalAmbientText } from "../functions/observation-visibility.js";
import { observationContentFields } from "../functions/forget-preview.js";

export interface CodexMatchDecision {
  sourceKey: string;
  observationId: string | null;
  action: "insert" | "adopt" | "present" | "duplicate" | "excluded" | "blocked";
  contentRepair?: "restore_terminal_lf" | "restore_legacy_synthetic" | "restore_legacy_image_text" | "restore_legacy_recovery_parts" | "restore_legacy_prompt_whitespace";
  timestampRepair?: "restore_legacy_utc";
  legacyTurnMatch?: true;
  legacyUserItemMatch?: true;
  duplicateOfObservationId?: string;
  reason?: string;
}

export const codexTextDigest = (text: string) => createHash("sha256").update(text).digest("hex");
export type CodexMessageReference = Omit<CodexNativeMessage, "text"> & {
  textDigest: string; legacySyntheticDigest?: string; legacyUserItemId?: string;
  legacyPromptDigests?: { textDigest: string; syntheticDigest?: string };
  retainedSourcePath?: string;
};
export function codexLegacySyntheticDigest(message: CodexNativeMessage): string | undefined {
  if (message.kind === "user") return message.text.length > 400 ? codexTextDigest(message.text.slice(0, 399) + "…") : undefined;
  if (message.kind !== "assistant_final" || !message.turnId) return;
  const input = JSON.stringify({ turn_id: message.turnId }) + " | ";
  const prefix = input + message.text.slice(0, 400);
  return codexTextDigest(input.length + message.text.length > 400 ? prefix.slice(0, 399) + "…" : prefix);
}
export function codexLegacyPromptDigests(message: CodexNativeMessage): CodexMessageReference["legacyPromptDigests"] {
  if (message.kind !== "user") return;
  const text = message.text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
  if (!text || text === message.text) return;
  return { textDigest: codexTextDigest(text),
    ...(text.length > 400 ? { syntheticDigest: codexTextDigest(text.slice(0, 399) + "…") } : {}) };
}
export function codexMessageReference(message: CodexNativeMessage): CodexMessageReference {
  const { text, ...source } = message;
  const legacySyntheticDigest = codexLegacySyntheticDigest(message);
  const legacyPromptDigests = codexLegacyPromptDigests(message);
  return { ...source, textDigest: codexTextDigest(text), ...(legacySyntheticDigest ? { legacySyntheticDigest } : {}),
    ...(legacyPromptDigests ? { legacyPromptDigests } : {}) };
}
const messageDigest = (message: CodexNativeMessage | CodexMessageReference) =>
  "text" in message ? codexTextDigest(message.text) : message.textDigest;
const syntheticDigest = (message: CodexNativeMessage | CodexMessageReference) =>
  "text" in message ? codexLegacySyntheticDigest(message) : message.legacySyntheticDigest;
const promptDigests = (message: CodexNativeMessage | CodexMessageReference) =>
  "text" in message ? codexLegacyPromptDigests(message) : message.legacyPromptDigests;
const matchesLegacyPromptWhitespace = (row: CompressedObservation, message: CodexNativeMessage | CodexMessageReference, digest: string) => {
  if (message.kind !== "user" || !matchesLegacySyntheticShape(row, message)) return false;
  const expected = promptDigests(message);
  return expected !== undefined && (digest === expected.textDigest || digest === expected.syntheticDigest);
};
const matchesLegacySyntheticShape = (row: CompressedObservation, message: CodexNativeMessage | CodexMessageReference) => {
  if (message.kind === "user") return row.emptyDeletion === undefined && row.codexSource === undefined &&
    row.title === "prompt_submit" && row.type === "conversation" && row.confidence === 0.3;
  if (row.emptyDeletion !== undefined || row.codexSource !== undefined || row.title !== "assistant_response" ||
      row.type !== "other" || row.confidence !== 0.3 || message.kind !== "assistant_final" || !message.turnId) return false;
  const input = JSON.stringify({ turn_id: message.turnId });
  return row.subtitle === (input.length > 120 ? input.slice(0, 119) + "…" : input);
};
const matchesLegacyImageShape = (row: CompressedObservation, message: CodexNativeMessage | CodexMessageReference) =>
  row.codexSource === undefined && row.emptyDeletion === undefined && row.title === "prompt_submit" &&
  row.type === "conversation" && message.kind === "user" && Date.parse(row.timestamp) === Date.parse(message.timestamp);
const matchesLegacyUtcTimestamp = (row: CompressedObservation, message: CodexNativeMessage | CodexMessageReference) => {
  if (row.codexSource !== undefined || row.emptyDeletion !== undefined ||
      !/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/.test(row.timestamp)) return false;
  const utc = new Date(message.timestamp).toISOString();
  return row.timestamp === `${utc.slice(5, 7)}/${utc.slice(8, 10)}/${utc.slice(0, 4)} ${utc.slice(11, 19)}`;
};
const matchesLegacyRecovery = (row: CompressedObservation, message: CodexNativeMessage | CodexMessageReference) =>
  message.kind === "user" && row.codexSource === undefined && row.emptyDeletion === undefined &&
  row.title === "prompt_submit" && row.type === "conversation" && row.id === message.legacyRecovery?.observationId &&
  row.timestamp === message.timestamp && row.origin?.channel === "user" &&
  row.origin.detail === `Codex original turn ${message.turnId}` && row.origin.capturedAt === message.timestamp;
const matchesLegacyFinalTurn = (row: CompressedObservation, message: CodexNativeMessage | CodexMessageReference) =>
  message.kind === "assistant_final" && Boolean(message.turnId) && row.codexSource === undefined && row.emptyDeletion === undefined &&
  row.title === "assistant_response" && row.type === "other" && row.subtitle === JSON.stringify({ turn_id: message.turnId }) &&
  Date.parse(row.timestamp) >= Date.parse(message.timestamp);
const matchesLegacyUserItem = (row: CompressedObservation, message: CodexNativeMessage | CodexMessageReference) =>
  message.kind === "user" && "legacyUserItemId" in message && Boolean(message.legacyUserItemId) &&
  row.codexSource === undefined && row.emptyDeletion === undefined && row.title === "prompt_submit" && row.type === "conversation" &&
  row.origin?.channel === "import" && row.origin.capturedAt === row.timestamp &&
  row.origin.detail === `codex-task-recovery:prompt_submit:${message.legacyUserItemId}`;
const validRetainedPath = (value: unknown) => typeof value === "string" && value.length <= 2048 &&
  /^(sessions|archived_sessions)[\\/]/.test(value) && !value.split(/[\\/]/).some(part => !part || part === "." || part === ".." || /[:\0]/.test(part)) &&
  /^rollout-[^/\\]+\.jsonl$/.test(value.split(/[\\/]/).at(-1)!);
const retainedPath = (message: CodexNativeMessage | CodexMessageReference) => "retainedSourcePath" in message ? message.retainedSourcePath : undefined;
const capturedKind = (row: CompressedObservation) => {
  if (row.codexSource === undefined && row.emptyDeletion?.state === "deleted" &&
      observationContentFields(row as unknown as Record<string, unknown>).length === 0) return null;
  if (row.title === "prompt_submit" || (row.type === "conversation" && row.origin?.channel === "user")) {
    if (row.codexSource === undefined && row.emptyDeletion === undefined &&
        (isCodexInternalAmbientText(row.narrative) || isCodexApprovalReviewText(row.narrative))) return null;
    return "user";
  }
  return row.title === "assistant_response" || row.origin?.detail === "assistant_response" ? "assistant_final" : null;
};

export function unmatchedCodexCaptures(observations: CompressedObservation[], decisions: CodexMatchDecision[]) {
  const matched = new Set(decisions.filter(row => row.action === "adopt" || row.action === "present")
    .map(row => row.observationId));
  const conflicted = new Set(decisions.filter(row => row.action === "blocked").map(row => row.observationId));
  return observations.filter(row => (row.codexSource !== undefined || capturedKind(row) !== null) && !matched.has(row.id))
    .map(row => ({ observationId: row.id,
      reason: conflicted.has(row.id) ? "blocked_native_correspondence" : "unresolved_native_correspondence" }));
}

export function codexSourceMessages<T extends CodexNativeMessage | CodexMessageReference>(messages: T[], sessionId: string) {
  const sources = new Map<string, T>();
  for (const message of messages) {
    const prompt = promptDigests(message);
    if (retainedPath(message) !== undefined && !validRetainedPath(retainedPath(message))) throw Error("Invalid retained native source path");
    if (message.sessionId !== sessionId || !/^[a-f0-9]{64}$/.test(message.key) ||
        !Number.isFinite(Date.parse(message.timestamp)) || !/^[a-f0-9]{64}$/.test(messageDigest(message)) ||
        (syntheticDigest(message) !== undefined && !/^[a-f0-9]{64}$/.test(syntheticDigest(message)!)) ||
        (message.legacyExcludedReason !== undefined && (message.legacyExcludedReason !== "assistant_without_normal_user" ||
          message.kind !== "assistant_final" || !message.turnId)) ||
        (message.legacyImageWrappedDigest !== undefined && (message.kind !== "user" || !/^[a-f0-9]{64}$/.test(message.legacyImageWrappedDigest))) ||
        ("legacyUserItemId" in message && (message.kind !== "user" || !message.turnId ||
          typeof message.legacyUserItemId !== "string" || !message.legacyUserItemId || message.legacyUserItemId.length > 512 ||
          message.legacyUserItemId.trim() !== message.legacyUserItemId)) ||
        (prompt !== undefined && (!prompt || message.kind !== "user" || !/^[a-f0-9]{64}$/.test(prompt.textDigest) ||
          (prompt.syntheticDigest !== undefined && !/^[a-f0-9]{64}$/.test(prompt.syntheticDigest)))) ||
        (message.legacyRecovery !== undefined && (message.kind !== "user" || !message.turnId ||
          !/^obs_codex_recovery_[a-f0-9]{32}$/.test(message.legacyRecovery?.observationId) ||
          !/^[a-f0-9]{64}$/.test(message.legacyRecovery?.textDigest)))) throw Error("Invalid native message identity");
    const prior = sources.get(message.key);
    if (prior && (messageDigest(prior) !== messageDigest(message) || prior.kind !== message.kind ||
        prior.nativeMessageId !== message.nativeMessageId || prior.turnId !== message.turnId || syntheticDigest(prior) !== syntheticDigest(message) ||
        prior.legacyExcludedReason !== message.legacyExcludedReason || retainedPath(prior) !== retainedPath(message) ||
        promptDigests(prior)?.textDigest !== prompt?.textDigest || promptDigests(prior)?.syntheticDigest !== prompt?.syntheticDigest ||
        ("legacyUserItemId" in prior ? prior.legacyUserItemId : undefined) !== ("legacyUserItemId" in message ? message.legacyUserItemId : undefined) ||
        prior.legacyRecovery?.observationId !== message.legacyRecovery?.observationId ||
        prior.legacyRecovery?.textDigest !== message.legacyRecovery?.textDigest ||
        prior.legacyImageWrappedDigest !== message.legacyImageWrappedDigest)) throw Error("Conflicting native message identity");
    sources.set(message.key, message);
  }
  return sources;
}

export interface CodexMatchScope {
  sessionId: string; project: string; agentId: string; completeNativeInventory: boolean;
  exclusions?: CodexCaptureExclusion[]; reconcileDuplicates?: boolean;
  unresolvedCaptures?: import("../types.js").CodexUnresolvedCapture[];
}

export function matchCodexMessages(messages: Array<CodexNativeMessage | CodexMessageReference>, observations: CompressedObservation[], scope: CodexMatchScope): CodexMatchDecision[] {
  const unresolved = validateUnresolvedCodexCaptures(scope.unresolvedCaptures, observations, scope);
  return matchCodexDuplicateCaptures(messages, observations.filter(row => !unresolved.has(row.id)),
    { ...scope, unresolvedCaptures: undefined }, matchSingleCodexMessages, unmatchedCodexCaptures);
}

function matchSingleCodexMessages(
  messages: Array<CodexNativeMessage | CodexMessageReference>,
  observations: CompressedObservation[],
  scope: CodexMatchScope,
): CodexMatchDecision[] {
  if (!scope.sessionId || !scope.project || scope.project === "*" || !scope.agentId || scope.agentId === "*") throw Error("An exact Codex capture scope is required");
  const seen = new Set<string>();
  for (const row of observations) {
    if (!row || typeof row.id !== "string" || !row.id || seen.has(row.id) || row.sessionId !== scope.sessionId ||
        (row.project !== undefined && row.project !== scope.project)) throw Error("Invalid or conflicting observation scope");
    const raw = row as unknown as { hookType?: string; toolName?: string };
    if (raw.hookType === "prompt_submit" || raw.toolName === "assistant_response") throw Error(`Unfinished raw capture requires canonical recovery: ${row.id}`);
    if (row.codexSource?.retainedSourcePath !== undefined && !validRetainedPath(row.codexSource.retainedSourcePath)) throw Error("Invalid retained capture source path");
    seen.add(row.id);
  }
  const sources = codexSourceMessages(messages, scope.sessionId);
  const exact = new Map<string, CompressedObservation[]>();
  const nearby = new Map<string, CompressedObservation[]>();
  const compatible = new Map<string, CompressedObservation[]>();
  const claimants = new Map<string, Set<string>>();
  const legacy = observations.filter(row => !row.codexSource && capturedKind(row) !== null);
  for (const row of legacy) {
    if (typeof row.narrative !== "string" || !Number.isFinite(Date.parse(row.timestamp))) throw Error("Unverifiable legacy capture content or timestamp");
  }
  const digests = new Map(legacy.map(row => [row.id, {
    exact: codexTextDigest(row.narrative), terminalLf: codexTextDigest(row.narrative + "\n"),
  }]));
  for (const [key, message] of sources) {
    const mapped = observations.filter(row => row.codexSource?.key === key);
    exact.set(key, mapped);
    const digest = messageDigest(message);
    const candidates = mapped.length ? [] : legacy.filter(row => capturedKind(row) === message.kind &&
      (Math.abs(Date.parse(row.timestamp) - Date.parse(message.timestamp)) <= 5000 ||
        (digests.get(row.id)!.exact === digest && (matchesLegacyUtcTimestamp(row, message) || matchesLegacyFinalTurn(row, message) || matchesLegacyUserItem(row, message)))));
    nearby.set(key, candidates);
    const synthetic = syntheticDigest(message);
    const matching = candidates.filter(row => (message.legacyExcludedReason === undefined ||
      row.subtitle === JSON.stringify({ turn_id: message.turnId })) && (digests.get(row.id)!.exact === digest ||
      (row.emptyDeletion === undefined && digests.get(row.id)!.terminalLf === digest) ||
      (synthetic !== undefined && digests.get(row.id)!.exact === synthetic && matchesLegacySyntheticShape(row, message)) ||
      matchesLegacyPromptWhitespace(row, message, digests.get(row.id)!.exact) ||
      (digests.get(row.id)!.exact === message.legacyRecovery?.textDigest && matchesLegacyRecovery(row, message)) ||
      (message.legacyImageWrappedDigest !== undefined && digests.get(row.id)!.exact === message.legacyImageWrappedDigest && matchesLegacyImageShape(row, message))));
    compatible.set(key, matching);
    for (const row of matching) {
      const keys = claimants.get(row.id) ?? new Set<string>(); keys.add(key); claimants.set(row.id, keys);
    }
  }
  const decisions = new Map<string, CodexMatchDecision>();
  for (const [key, message] of sources) {
    const mapped = exact.get(key)!;
    const matching = compatible.get(key)!;
    const candidates = matching.length ? matching : nearby.get(key)!.filter(row => !claimants.has(row.id));
    const blocked = (reason: string, row?: CompressedObservation): CodexMatchDecision => ({
      sourceKey: key, observationId: row?.id ?? null, action: "blocked", reason,
    });
    if (!mapped.length && legacy.length && scope.completeNativeInventory !== true) {
      decisions.set(key, blocked("legacy_matching_requires_complete_native_inventory")); continue;
    }
    if (mapped.length > 1) { decisions.set(key, blocked("duplicate_canonical_source_identity")); continue; }
    const candidate = mapped[0] ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (!mapped.length && candidates.length && (!candidate || (claimants.get(candidate.id)?.size ?? 1) !== 1)) {
      decisions.set(key, blocked("ambiguous_legacy_correspondence")); continue;
    }
    if (!candidate) {
      if (retainedPath(message)) { decisions.set(key, blocked("retained_source_capture_missing")); continue; }
      if (message.legacyExcludedReason) {
        decisions.set(key, { sourceKey: key, observationId: null, action: "excluded", reason: message.legacyExcludedReason }); continue;
      }
      const observationId = `obs_codex_${key}`;
      decisions.set(key, seen.has(observationId) ? blocked("deterministic_observation_identity_conflict")
        : { sourceKey: key, observationId, action: "insert" }); continue;
    }
    if (candidate.agentId !== scope.agentId) { decisions.set(key, blocked("owner_reconciliation_required", candidate)); continue; }
    if (candidate.emptyDeletion !== undefined) { decisions.set(key, blocked("protected_observation_lifecycle", candidate)); continue; }
    if (!candidate.codexSource && message.legacyExcludedReason && candidate.subtitle !== JSON.stringify({ turn_id: message.turnId })) {
      decisions.set(key, blocked("excluded_legacy_turn_mismatch", candidate)); continue;
    }
    const repair = !mapped.length && codexTextDigest(candidate.narrative) !== messageDigest(message)
      ? digests.get(candidate.id)?.terminalLf === messageDigest(message) ? "restore_terminal_lf" as const
        : digests.get(candidate.id)?.exact === syntheticDigest(message) && matchesLegacySyntheticShape(candidate, message) ? "restore_legacy_synthetic" as const
        : message.legacyImageWrappedDigest !== undefined && digests.get(candidate.id)?.exact === message.legacyImageWrappedDigest && matchesLegacyImageShape(candidate, message) ? "restore_legacy_image_text" as const
        : digests.get(candidate.id)?.exact === message.legacyRecovery?.textDigest && matchesLegacyRecovery(candidate, message) ? "restore_legacy_recovery_parts" as const
        : matchesLegacyPromptWhitespace(candidate, message, digests.get(candidate.id)!.exact) ? "restore_legacy_prompt_whitespace" as const : undefined
      : undefined;
    if (typeof candidate.narrative !== "string" || (codexTextDigest(candidate.narrative) !== messageDigest(message) && !repair)) { decisions.set(key, blocked("legacy_or_canonical_content_mismatch", candidate)); continue; }
    if (candidate.codexSource) {
      const source = candidate.codexSource;
      if (source.version !== 1 || source.nativeMessageId !== message.nativeMessageId || source.kind !== message.kind || capturedKind(candidate) !== message.kind ||
          source.timestamp !== message.timestamp || source.textDigest !== messageDigest(message) || source.legacyExcludedReason !== message.legacyExcludedReason ||
          (source.retainedSourcePath !== undefined && retainedPath(message) !== undefined && source.retainedSourcePath !== retainedPath(message))) {
        decisions.set(key, blocked("canonical_source_provenance_mismatch", candidate)); continue;
      }
    }
    const timestampRepair = !mapped.length && codexTextDigest(candidate.narrative) === messageDigest(message) &&
      matchesLegacyUtcTimestamp(candidate, message) ? "restore_legacy_utc" as const : undefined;
    const legacyTurnMatch = !mapped.length && Date.parse(candidate.timestamp) - Date.parse(message.timestamp) > 5000 &&
      codexTextDigest(candidate.narrative) === messageDigest(message) && matchesLegacyFinalTurn(candidate, message);
    const legacyUserItemMatch = !mapped.length && Math.abs(Date.parse(candidate.timestamp) - Date.parse(message.timestamp)) > 5000 &&
      codexTextDigest(candidate.narrative) === messageDigest(message) && matchesLegacyUserItem(candidate, message);
    decisions.set(key, { sourceKey: key, observationId: candidate.id, action: mapped.length && (!retainedPath(message) || candidate.codexSource?.retainedSourcePath) ? "present" : "adopt",
      ...(repair ? { contentRepair: repair } : {}), ...(timestampRepair ? { timestampRepair } : {}),
      ...(legacyTurnMatch ? { legacyTurnMatch: true } : {}), ...(legacyUserItemMatch ? { legacyUserItemMatch: true } : {}) });
  }
  const exclusions = (scope.exclusions ?? []).map(validateCodexExclusion).filter(row => row.sessionId === scope.sessionId);
  if (exclusions.some(row => row.project !== scope.project)) throw Error("Codex exclusion belongs to a different project");
  for (const exclusion of exclusions) {
    const match = exclusion.match;
    const candidates = [...sources.values()].filter(message => match.kind === "source" ? message.key === match.sourceKey
      : match.kind === "legacy" ? message.kind === match.messageKind && Math.abs(Date.parse(message.timestamp) - Date.parse(match.timestamp)) <= 5000
      : match.kind === "session" ? Date.parse(message.timestamp) <= Date.parse(exclusion.forgottenAt) : true);
    const uniqueLegacy = match.kind === "legacy" && scope.completeNativeInventory && candidates.length === 1 && messageDigest(candidates[0]!) === match.textDigest;
    for (const message of candidates) {
      const stored = observations.find(row => row.id === exclusion.observationId || row.codexSource?.key === message.key);
      const ambiguous = match.kind === "unresolved" || (match.kind === "legacy" && !uniqueLegacy);
      const previous = decisions.get(message.key)!;
      if (previous.action === "blocked") continue;
      decisions.set(message.key, {
        sourceKey: message.key, observationId: stored?.id ?? exclusion.observationId ?? null,
        action: stored || ambiguous ? "blocked" : "excluded",
        reason: ambiguous ? "unresolved_forgotten_capture" : stored ? "forgotten_capture_still_present" : "intentionally_forgotten_capture",
      });
    }
  }
  const emitted = new Set<string>();
  return messages.map(message => {
    const decision = decisions.get(message.key)!;
    if (emitted.has(message.key) && decision.action !== "blocked" && decision.action !== "excluded") return { ...decision, action: "duplicate" };
    emitted.add(message.key);
    return decision;
  });
}
