import type { CompressedObservation } from "../types.js";
import type { CodexNativeMessage } from "./codex-record.js";
import type { CodexMatchDecision, CodexMatchScope, CodexMessageReference } from "./codex-match.js";

type Matcher = (messages: Array<CodexNativeMessage | CodexMessageReference>, observations: CompressedObservation[], scope: CodexMatchScope) => CodexMatchDecision[];
type Unmatched = (observations: CompressedObservation[], decisions: CodexMatchDecision[]) => Array<{ observationId: string }>;
const accepted = (decision: CodexMatchDecision) => decision.action === "adopt" || decision.action === "present";

export function matchCodexDuplicateCaptures(messages: Array<CodexNativeMessage | CodexMessageReference>, observations: CompressedObservation[],
  scope: CodexMatchScope, match: Matcher, unmatched: Unmatched): CodexMatchDecision[] {
  if (scope.reconcileDuplicates !== undefined && typeof scope.reconcileDuplicates !== "boolean") throw Error("reconcileDuplicates must be a boolean");
  if (scope.reconcileDuplicates && !scope.completeNativeInventory) throw Error("Duplicate capture reconciliation requires a complete native inventory");
  let decisions = match(messages, observations, scope);
  const aliases = observations.filter(row => row.codexSource?.duplicateOfObservationId !== undefined);
  if (!aliases.length && !scope.reconcileDuplicates) return decisions;
  const byId = new Map(observations.map(row => [row.id, row]));
  const aliasIds = new Set(aliases.map(row => row.id));
  if (aliases.length) {
    for (const row of aliases) {
      const source = row.codexSource!;
      const id = source.duplicateOfObservationId;
      const original = typeof id === "string" ? byId.get(id) : undefined;
      const canonical = original?.codexSource;
      if (!id || id === row.id || !canonical || canonical.duplicateOfObservationId !== undefined ||
        source.version !== 1 || canonical.version !== 1 || !/^[a-f0-9]{64}$/.test(source.key) ||
        ["key", "nativeMessageId", "kind", "timestamp", "textDigest", "legacyExcludedReason"].some(field => source[field as keyof typeof source] !== canonical[field as keyof typeof canonical]) ||
        (source.retainedSourcePath && canonical.retainedSourcePath && source.retainedSourcePath !== canonical.retainedSourcePath) ||
        typeof row.narrative !== "string" || row.narrative !== original!.narrative || row.agentId !== scope.agentId ||
        original!.agentId !== scope.agentId || row.emptyDeletion !== undefined || original!.emptyDeletion !== undefined) {
        throw Error("Invalid, orphaned or conflicting native duplicate capture provenance");
      }
    }
    decisions = match(messages, observations.filter(row => !aliasIds.has(row.id)), scope);
    const keys = new Set(messages.map(message => message.key));
    for (const row of aliases) {
      if (!keys.has(row.codexSource!.key)) continue;
      const proof = match(messages, [row], scope).find(decision => decision.sourceKey === row.codexSource!.key);
      const canonical = decisions.find(decision => decision.sourceKey === row.codexSource!.key && decision.observationId === row.codexSource!.duplicateOfObservationId);
      decisions.push(proof && accepted(proof) && canonical && accepted(canonical)
        ? { ...proof, duplicateOfObservationId: row.codexSource!.duplicateOfObservationId }
        : { sourceKey: row.codexSource!.key, observationId: row.id, action: "blocked", reason: "duplicate_capture_provenance_unverified" });
    }
  }
  if (!scope.reconcileDuplicates) return decisions;
  const unresolved = new Set(unmatched(observations, decisions).map(row => row.observationId));
  const groups = new Map<string, Array<{ row: CompressedObservation; decision: CodexMatchDecision }>>();
  for (const row of observations.filter(row => unresolved.has(row.id) && !aliasIds.has(row.id))) {
    const proof = match(messages, [row], scope).filter(accepted);
    if (proof.length !== 1) continue;
    const entries = groups.get(proof[0]!.sourceKey) ?? [];
    entries.push({ row, decision: proof[0]! }); groups.set(proof[0]!.sourceKey, entries);
  }
  for (const [key, entries] of groups) {
    const prior = decisions.find(decision => decision.sourceKey === key && !decision.duplicateOfObservationId && accepted(decision));
    if (prior && !entries.some(entry => entry.row.id === prior.observationId)) entries.push({ row: byId.get(prior.observationId!)!, decision: prior });
    if (entries.length < 2 || (!prior && !decisions.some(decision => decision.sourceKey === key && decision.action === "blocked" &&
      ["ambiguous_legacy_correspondence", "duplicate_canonical_source_identity"].includes(decision.reason ?? "")))) continue;
    entries.sort((a, b) => a.row.id.localeCompare(b.row.id));
    const bound = entries.filter(entry => entry.row.codexSource !== undefined);
    const canonical = prior ? entries.find(entry => entry.row.id === prior.observationId)! : bound.length === 1 ? bound[0]! : entries[0]!;
    const existingAliases = decisions.filter(decision => decision.sourceKey === key && decision.duplicateOfObservationId);
    decisions = decisions.filter(decision => decision.sourceKey !== key);
    decisions.push(canonical.decision, ...entries.filter(entry => entry !== canonical).map(entry => ({ ...entry.decision,
      action: "adopt" as const, duplicateOfObservationId: canonical.row.id })), ...existingAliases);
  }
  return decisions;
}

export function assertCompleteCodexDuplicateForget(rows: Array<{ id: string; [key: string]: unknown }>, selected: Set<string>): void {
  const groups = new Map<string, { ids: string[]; linked: boolean }>();
  for (const row of rows) {
    const source = row.codexSource as { key?: unknown; duplicateOfObservationId?: unknown } | undefined;
    if (!source || typeof source.key !== "string") continue;
    const group = groups.get(source.key) ?? { ids: [], linked: false };
    group.ids.push(row.id); group.linked ||= source.duplicateOfObservationId !== undefined; groups.set(source.key, group);
  }
  for (const group of groups.values()) if (group.linked && group.ids.some(id => selected.has(id)) && group.ids.some(id => !selected.has(id))) {
    throw Error("Forget must include all captures linked to the same native message; archive an individual duplicate instead");
  }
}
