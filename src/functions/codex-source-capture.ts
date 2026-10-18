import { createHash } from "node:crypto";
import { validateCodexSourceHolds } from "../replay/codex-source-hold.js";
import { unresolvedCodexCapture, validateUnresolvedCodexCaptures } from "../replay/codex-unresolved-capture.js";
import { isDeepStrictEqual } from "node:util";
import type { CodexCaptureExclusion, CompressedObservation, RawObservation, Session } from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { withObservationWrite } from "../state/observation-write.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { checkPayloadFrameSize } from "../state/frame-guard.js";
import { advanceSessionActivity, seedSourceSessionActivity, sessionLifecycleLockKey } from "./session-lifecycle.js";
import { canonicalCodexCwd, withReadOnlyCodexSource } from "./codex-source-identity.js";
import { isExcludedCodexAmbientSession, isCodexApprovalReviewText } from "./observation-visibility.js";
import { buildSyntheticCompression } from "./compress-synthetic.js";
import { recordAudit } from "./audit.js";
import { codexInventoryWindowBound, readCodexInventory } from "../replay/codex-inventory.js";
import { CodexCursorValidationError, readCodexWindow, readCodexWindowFromFile } from "../replay/codex-window.js";
import { CodexReadBudget, CodexReadBudgetError } from "../replay/codex-read-budget.js";
import { readCodexRetainedSources } from "./codex-retained-source.js";
import { initialCodexParseState } from "../replay/codex-record.js";
import { codexLegacyPromptDigests, codexLegacySyntheticDigest, codexMessageReference, codexTextDigest, matchCodexMessages, unmatchedCodexCaptures, type CodexMessageReference } from "../replay/codex-match.js";

type ManagedSource = { sourceRoot: string; agentId: string; maxInventoryWindows?: number; readBudget?: CodexReadBudget };
type Scope = { sessionId: string; project: string };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sourceMetadata = (message: CodexMessageReference, duplicateOfObservationId?: string): NonNullable<CompressedObservation["codexSource"]> => ({
  version: 1, key: message.key, nativeMessageId: message.nativeMessageId, kind: message.kind,
  timestamp: message.timestamp, ordinal: message.ordinal, byteOffset: message.byteOffset, textDigest: message.textDigest,
  ...(message.legacyExcludedReason ? { legacyExcludedReason: message.legacyExcludedReason } : {}),
  ...(message.retainedSourcePath ? { retainedSourcePath: message.retainedSourcePath } : {}),
  ...(duplicateOfObservationId ? { duplicateOfObservationId } : {}),
});
const RAW_OBSERVATION_KEYS = new Set([
  "id", "sessionId", "timestamp", "hookType", "toolName", "toolInput", "toolOutput", "userPrompt",
  "raw", "modality", "imageData", "agentId", "origin", "project",
]);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const validTimestamp = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const validOrigin = (value: unknown): boolean => {
  if (!isRecord(value) || !["user", "agent", "tool", "import", "shared"].includes(String(value.channel)) ||
      !validTimestamp(value.capturedAt)) return false;
  return value.detail === undefined || typeof value.detail === "string";
};

function normalizeRawCapture(
  row: CompressedObservation,
  session: Session,
  agentId: string,
): CompressedObservation | null {
  if (!isRecord(row)) return null;
  const raw = row;
  const prompt = raw.hookType === "prompt_submit";
  const assistant = raw.toolName === "assistant_response";
  if (!prompt && !assistant) return null;
  const id = raw.id;
  if (typeof id !== "string" || !id.trim() || id !== id.trim() || raw.sessionId !== session.id ||
      !validTimestamp(raw.timestamp) || raw.agentId !== agentId || !Object.hasOwn(raw, "raw") ||
      (raw.project !== undefined && raw.project !== session.project) ||
      (raw.modality !== undefined && !["text", "image", "mixed"].includes(String(raw.modality))) ||
      (raw.imageData !== undefined && typeof raw.imageData !== "string")) {
    throw Error(`Unfinished raw capture has an invalid canonical shape: ${String(id)}`);
  }
  if (Object.keys(raw).some(key => !RAW_OBSERVATION_KEYS.has(key))) {
    throw Error(`Unfinished raw capture has existing derived metadata: ${id}`);
  }
  if (raw.origin !== undefined && !validOrigin(raw.origin)) {
    throw Error(`Unfinished raw capture has invalid provenance: ${id}`);
  }

  if (prompt) {
    if (raw.toolName !== undefined || raw.toolInput !== undefined || raw.toolOutput !== undefined ||
        raw.assistantResponse !== undefined || typeof raw.userPrompt !== "string") {
      throw Error(`Unfinished raw prompt has an invalid canonical shape: ${id}`);
    }
  } else {
    if (raw.hookType !== "post_tool_use" || raw.userPrompt !== undefined || raw.toolOutput === undefined) {
      throw Error(`Unfinished raw assistant response has an invalid canonical shape: ${id}`);
    }
  }
  const synthetic = buildSyntheticCompression(raw as unknown as RawObservation);
  return { ...synthetic, project: session.project };
}

function normalizedObservationView(
  observations: CompressedObservation[],
  session: Session,
  agentId: string,
): { observations: CompressedObservation[]; recovered: Map<string, CompressedObservation> } {
  const recovered = new Map<string, CompressedObservation>();
  const normalized = observations.map(row => {
    const synthetic = normalizeRawCapture(row, session, agentId);
    if (!synthetic) return row;
    recovered.set(row.id, synthetic);
    return synthetic;
  });
  return { observations: normalized, recovered };
}
async function scopedSession(kv: StateKV, scope: Scope, managed: ManagedSource, allowApprovalPreviewRecovery = false) {
  if (![scope.sessionId, scope.project, managed.agentId].every(value => typeof value === "string" && value.length > 0 &&
    value.length <= 512 && value === value.trim() && value !== "*") || !managed.sourceRoot) throw Error("Exact managed Codex capture scope is required");
  const session = await kv.get<Session>(KV.sessions, scope.sessionId);
  const approvalPreviewRecovery = allowApprovalPreviewRecovery && session?.captureExcluded !== true &&
    session?.codexNativeCapture?.source.sessionId === scope.sessionId && isCodexApprovalReviewText(session?.firstPrompt);
  if (!session || session.id !== scope.sessionId || session.project !== scope.project || session.agentId !== managed.agentId ||
      (isExcludedCodexAmbientSession(session) && !approvalPreviewRecovery)) throw Error("Native capture requires a proven canonical session owner");
  return session;
}

export async function initializeCodexSourceCapture(kv: StateKV,
  input: Scope & { sourcePath: string; dryRun: boolean; expectedVersion?: string; reason?: string; reconcileDuplicates?: boolean; retainUnmatched?: boolean; reviewSourceHolds?: boolean; reconcileSourceCwd?: boolean; readTimeoutMilliseconds?: number },
  managed: ManagedSource, readWindow: typeof readCodexWindow = readCodexWindow,
) {
  if (input.readTimeoutMilliseconds !== undefined && (!Number.isSafeInteger(input.readTimeoutMilliseconds) ||
      input.readTimeoutMilliseconds < 30_000 || input.readTimeoutMilliseconds > 90_000)) throw Error("Invalid capture initialization read timeout");
  if ((input.reconcileSourceCwd !== undefined && typeof input.reconcileSourceCwd !== "boolean") || (input.reviewSourceHolds !== undefined && typeof input.reviewSourceHolds !== "boolean") || (input.retainUnmatched !== undefined && typeof input.retainUnmatched !== "boolean") || (input.reconcileDuplicates !== undefined && typeof input.reconcileDuplicates !== "boolean") || typeof input.dryRun !== "boolean" || (!input.dryRun && (!/^[a-f0-9]{64}$/.test(input.expectedVersion ?? "") ||
    typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 512))) throw Error("Capture initialization requires an explicit preview or its expectedVersion and reason");
  codexInventoryWindowBound({ maxWindows: managed.maxInventoryWindows });
  if (readWindow !== readCodexWindow) return initializeCodexSourceCaptureWithReader(kv, input, managed, readWindow);
  const budget = managed.readBudget ?? new CodexReadBudget({ maxMilliseconds: input.readTimeoutMilliseconds ?? 30_000 });
  return withReadOnlyCodexSource(managed.sourceRoot, input.sourcePath, input.sessionId,
    (source, file) => initializeCodexSourceCaptureWithReader(kv, input, { ...managed, readBudget: budget },
      options => options.sourcePath === input.sourcePath && options.sessionId === input.sessionId
        ? readCodexWindowFromFile(options, source, file)
        : withReadOnlyCodexSource(managed.sourceRoot, options.sourcePath, options.sessionId,
          (retainedSource, retainedFile) => readCodexWindowFromFile(options, retainedSource, retainedFile), budget),
      readCodexWindow), budget);
}

async function initializeCodexSourceCaptureWithReader(kv: StateKV,
  input: Scope & { sourcePath: string; dryRun: boolean; expectedVersion?: string; reason?: string; reconcileDuplicates?: boolean; retainUnmatched?: boolean; reviewSourceHolds?: boolean; reconcileSourceCwd?: boolean; readTimeoutMilliseconds?: number },
  managed: ManagedSource, readWindow: typeof readCodexWindow = readCodexWindow,
  retainedReader: typeof readCodexWindow = readWindow,
) {
  return withObservationWrite(() => withKeyedLock(sessionLifecycleLockKey(input.sessionId), async () => {
    const session = await scopedSession(kv, input, managed, true);
    const observations = await kv.list<CompressedObservation>(KV.observations(session.id), { includeDeleted: true });
    const normalized = normalizedObservationView(observations, session, managed.agentId);
    const legacyDigests = new Set(normalized.observations.filter(row => row && row.codexSource === undefined && row.emptyDeletion === undefined &&
      ((row.title === "assistant_response" && row.type === "other") || (row.title === "prompt_submit" && row.type === "conversation")) && row.confidence === 0.3 &&
      typeof row.narrative === "string" && row.narrative.length <= 400)
      .map(row => codexTextDigest(row.narrative)));
    const recoveryTexts = new Map<string, string>();
    let firstSourcePrompt: { key: string; preview: string } | undefined;
    const imageDigests = new Set(normalized.observations.filter(row => row && row.codexSource === undefined && row.emptyDeletion === undefined &&
      row.title === "prompt_submit" && row.type === "conversation" && typeof row.narrative === "string")
      .map(row => codexTextDigest(row.narrative)));
    const { messages: normalMessages, legacyMessages, last, sourceHolds } = await readCodexInventory({ sourceRoot: managed.sourceRoot,
      sourcePath: input.sourcePath, sessionId: input.sessionId, includeExcludedMessages: true,
      sourceHolds: session.codexNativeCapture?.sourceHolds, discoverSourceHolds: input.reviewSourceHolds === true }, async options => {
        const window = await readWindow(options);
        if (!firstSourcePrompt) {
          const firstUser = window.messages.find(message => message.kind === "user" && message.text.trim());
          if (firstUser) firstSourcePrompt = { key: firstUser.key, preview: firstUser.text.replace(/\s+/g, " ").trim().slice(0, 200) };
        }
        for (const message of [...window.messages, ...(window.legacyMessages ?? [])]) {
          const digest = codexLegacySyntheticDigest(message);
          const prompt = codexLegacyPromptDigests(message);
          if ((digest && legacyDigests.has(digest)) || (message.legacyImageWrappedDigest && imageDigests.has(message.legacyImageWrappedDigest)) ||
            (message.imageReadFailureDisplay && imageDigests.has(message.imageReadFailureDisplay.digest)) ||
            (message.legacyRecovery && imageDigests.has(message.legacyRecovery.textDigest)) ||
            (prompt && (imageDigests.has(prompt.textDigest) || (prompt.syntheticDigest && imageDigests.has(prompt.syntheticDigest))))) {
            const oversized = checkPayloadFrameSize(message.text, "recovered observation exceeds the supported state frame");
            if (oversized) throw Error(oversized.error);
            recoveryTexts.set(message.key, message.text);
          }
        }
        return window;
      }, { maxWindows: managed.maxInventoryWindows });
    let messages = [...normalMessages, ...legacyMessages];
    if (!last.caughtUp) throw Error("A complete supported native inventory is required before capture initialization");
    if (isCodexApprovalReviewText(session.firstPrompt) && !firstSourcePrompt) throw Error("Approval preview recovery requires a normal user source message");
    const canonicalCwd = canonicalCodexCwd(session.cwd);
    const previousSource = session.codexNativeCapture?.source;
    const currentSourceCwd = last.cursor.parser.cwd ?? canonicalCodexCwd(last.source.cwd);
    const reconcileSourceCwd = input.reconcileSourceCwd === true && currentSourceCwd !== canonicalCwd;
    if (reconcileSourceCwd && (!previousSource || canonicalCodexCwd(session.codexNativeCapture?.captureCwd ?? previousSource.cwd) !== canonicalCwd ||
        !isDeepStrictEqual({ ...previousSource, cwd: last.source.cwd, relativePath: last.source.relativePath }, last.source))) {
      throw Error("Source cwd reconciliation requires the same source identity and complete matching current cwd");
    }
    const targetCwd = reconcileSourceCwd ? currentSourceCwd : canonicalCwd;
    const captureCwd = canonicalCodexCwd(last.source.cwd) !== targetCwd ? targetCwd : undefined;
    if (captureCwd && last.cursor.parser.cwd !== captureCwd) throw Error("Native capture cwd does not match the canonical session");
    const exclusions = (await kv.list<CodexCaptureExclusion>(KV.codexCaptureExclusions)).filter(row => row.sessionId === session.id);
    let decisions = matchCodexMessages(messages, normalized.observations, { ...input, agentId: managed.agentId, completeNativeInventory: true, exclusions });
    const unmatched = new Set(unmatchedCodexCaptures(normalized.observations, decisions).map(row => row.observationId));
    const retained = await readCodexRetainedSources({ sourceRoot: managed.sourceRoot, sourcePath: input.sourcePath, sessionId: input.sessionId },
      messages, normalized.observations.filter(row => unmatched.has(row.id)), retainedReader,
      { readBudget: managed.readBudget, maxInventoryWindows: managed.maxInventoryWindows });
    messages = [...messages, ...retained.messages];
    decisions = matchCodexMessages(messages, normalized.observations, { ...input, agentId: managed.agentId,
      completeNativeInventory: true, exclusions, singlePhysicalSource: retained.singlePhysicalSource, sourceCreatedAt: last.source.createdAt });
    const proven = new Set(decisions.filter(row => row.action === "adopt" || row.action === "present").map(row => row.observationId));
    const previousUnresolved = validateUnresolvedCodexCaptures(session.codexNativeCapture?.unresolvedCaptures?.filter(row => !proven.has(row.observationId)),
      observations, { ...input, agentId: managed.agentId });
    const unresolved = unmatchedCodexCaptures(normalized.observations, decisions);
    const unresolvedCaptures = unresolved.length && (input.retainUnmatched === true || unresolved.every(row => previousUnresolved.has(row.observationId)))
      ? unresolved.map(item => {
        if (normalized.recovered.has(item.observationId)) throw Error("Unfinished raw capture cannot be retained without native correspondence");
        return unresolvedCodexCapture(observations.find(row => row.id === item.observationId)!, { ...input, agentId: managed.agentId });
      }).sort((a, b) => a.observationId.localeCompare(b.observationId)) : [];
    const unresolvedIds = new Set(unresolvedCaptures.map(row => row.observationId));
    if (unresolvedCaptures.length) decisions = matchCodexMessages(messages, normalized.observations, { ...input, agentId: managed.agentId,
      completeNativeInventory: true, exclusions, unresolvedCaptures, singlePhysicalSource: retained.singlePhysicalSource, sourceCreatedAt: last.source.createdAt });
    const adopted = new Set(decisions.filter(row => row.action === "adopt").map(row => row.observationId));
    if (decisions.some(row => row.action === "blocked") || unmatchedCodexCaptures(normalized.observations, decisions).some(row => !unresolvedIds.has(row.observationId)) ||
      [...normalized.recovered.keys()].some(id => !adopted.has(id)) ||
      exclusions.some(row => row.match.kind === "legacy" || row.match.kind === "unresolved")) {
      throw Error("Unresolved capture correspondence or legacy forget provenance prevents initialization");
    }
    const capturedAfter = exclusions.filter(row => row.match.kind === "session").map(row => row.forgottenAt)
      .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
    if (capturedAfter && await kv.get(KV.summaries, session.id)) throw Error("A surviving forgotten summary requires lifecycle reconciliation");
    const expectedVersion = hash([last.source, last.cursor, sourceHolds, input.readTimeoutMilliseconds ?? 30_000, input.reviewSourceHolds === true, captureCwd, retained.sources, input.reconcileSourceCwd === true, input.reconcileDuplicates === true, input.retainUnmatched === true, messages, observations.slice().sort((a, b) => a.id.localeCompare(b.id)),
      exclusions.slice().sort((a, b) => a.id.localeCompare(b.id)), session]);
    const byId = new Map(observations.map(row => [row.id, row]));
    const byKey = new Map(messages.map(message => [message.key, message]));
    const prepared = new Map<string, CompressedObservation>();
    for (const decision of decisions) {
      if (decision.action !== "adopt" || (!normalized.recovered.has(decision.observationId!) && !decision.contentRepair && !decision.timestampRepair)) continue;
      const message = byKey.get(decision.sourceKey);
      const row = normalized.recovered.get(decision.observationId!) ?? byId.get(decision.observationId!)!;
      if (!message) throw Error(`Missing native source for capture recovery: ${decision.observationId}`);
      const narrative = decision.contentRepair === "restore_legacy_synthetic" || decision.contentRepair === "restore_legacy_image_text" ||
        decision.contentRepair === "restore_legacy_recovery_parts" || decision.contentRepair === "restore_legacy_prompt_whitespace" || decision.contentRepair === "restore_image_read_diagnostic" ? recoveryTexts.get(message.key)
        : decision.contentRepair === "restore_terminal_lf" ? row.narrative + "\n" : row.narrative;
      if (typeof narrative !== "string" || codexTextDigest(narrative) !== message.textDigest) throw Error("Recovered capture does not match its full native source");
      const next = { ...row, narrative, ...(decision.timestampRepair ? { timestamp: message.timestamp } : {}), codexSource: sourceMetadata(message, decision.duplicateOfObservationId) };
      const oversized = checkPayloadFrameSize(next, "recovered observation exceeds the supported state frame");
      if (oversized) throw Error(oversized.error);
      prepared.set(decision.observationId!, next);
    }
    const duplicateCaptures = decisions.filter(row => row.duplicateOfObservationId && (row.action === "adopt" || row.action === "present"))
      .map(row => ({ observationId: row.observationId!, duplicateOfObservationId: row.duplicateOfObservationId!, sourceKey: row.sourceKey }));
    const repairApprovalPreview = !capturedAfter && firstSourcePrompt && isCodexApprovalReviewText(session.firstPrompt);
    const counts = { ...(repairApprovalPreview ? { restoredFirstPromptSourceKey: firstSourcePrompt!.key, previousFirstPromptDigest: codexTextDigest(session.firstPrompt!) } : {}), ...(reconcileSourceCwd ? { previousCwd: session.cwd, reconciledSourceCwd: currentSourceCwd } : {}), sourceHoldCount: sourceHolds.length, sourceHolds, unresolvedCaptureCount: unresolvedCaptures.length, unresolvedCaptures: unresolvedCaptures.map(row => ({ observationId: row.observationId })), linkDuplicateCaptures: decisions.filter(row => row.action === "adopt" && row.duplicateOfObservationId).length, duplicateCaptures, adopt: decisions.filter(row => row.action === "adopt").length,
      ...(captureCwd ? { verifiedCurrentCwd: captureCwd } : {}),
      missing: decisions.filter(row => row.action === "insert").length, excluded: decisions.filter(row => row.action === "excluded").length,
      historicalPrivacyPreserved: decisions.filter(row => row.historicalPrivacyPreserved).map(row => ({
        observationId: row.observationId, sourceKey: row.sourceKey, ...row.historicalPrivacyPreserved })),
      recoverRaw: normalized.recovered.size,
      restoreTerminalLf: decisions.filter(row => row.action === "adopt" && row.contentRepair === "restore_terminal_lf").length,
      retainedSourceMessageCount: retained.messages.length,
      adoptRetainedSource: decisions.filter(row => row.action === "adopt" && byKey.get(row.sourceKey)?.retainedSourcePath).length,
      restoreLegacyPromptWhitespace: decisions.filter(row => row.action === "adopt" && row.contentRepair === "restore_legacy_prompt_whitespace").length,
      restoreLegacySynthetic: decisions.filter(row => row.action === "adopt" && row.contentRepair === "restore_legacy_synthetic").length,
      adoptExcludedFinal: decisions.filter(row => row.action === "adopt" && byKey.get(row.sourceKey)?.legacyExcludedReason).length,
      restoreLegacyTimestamp: decisions.filter(row => row.action === "adopt" && row.timestampRepair).length,
      adoptDelayedFinal: decisions.filter(row => row.action === "adopt" && row.legacyTurnMatch).length,
      adoptImportedUserItem: decisions.filter(row => row.action === "adopt" && row.legacyUserItemMatch).length,
      adoptDelayedHook: decisions.filter(row => row.action === "adopt" && row.legacyDelayedHookMatch).length,
      restoreImageReadDiagnostic: decisions.filter(row => row.action === "adopt" && row.contentRepair === "restore_image_read_diagnostic").length,
      restoreLegacyRecoveryParts: decisions.filter(row => row.action === "adopt" && row.contentRepair === "restore_legacy_recovery_parts").length,
      restoreLegacyImageText: decisions.filter(row => row.action === "adopt" && row.contentRepair === "restore_legacy_image_text").length };
    if (input.dryRun) return { dryRun: true, expectedVersion, sessionId: session.id, ...counts };
    if (input.expectedVersion !== expectedVersion) throw Error("Capture initialization preview is stale; no changes were made");
    await recordAudit(kv, "observe", "mem::codex-source-initialize", [session.id], { phase: "initialize", project: session.project, reason: input.reason,
      ...counts, recoverRawObservationIds: [...normalized.recovered.keys()],
      adoptExcludedFinalObservationIds: decisions.filter(row => row.action === "adopt" && byKey.get(row.sourceKey)?.legacyExcludedReason).map(row => row.observationId),
      restoreLegacyTimestampObservationIds: decisions.filter(row => row.action === "adopt" && row.timestampRepair).map(row => row.observationId),
      adoptDelayedFinalObservationIds: decisions.filter(row => row.action === "adopt" && row.legacyTurnMatch).map(row => row.observationId),
      adoptImportedUserItemObservationIds: decisions.filter(row => row.action === "adopt" && row.legacyUserItemMatch).map(row => row.observationId),
      adoptDelayedHookObservationIds: decisions.filter(row => row.action === "adopt" && row.legacyDelayedHookMatch).map(row => row.observationId),
      restoreImageReadDiagnosticObservationIds: decisions.filter(row => row.action === "adopt" && row.contentRepair === "restore_image_read_diagnostic").map(row => row.observationId),
      restoreLegacyRecoveryPartsObservationIds: decisions.filter(row => row.action === "adopt" && row.contentRepair === "restore_legacy_recovery_parts").map(row => row.observationId),
      restoreTerminalLfObservationIds: decisions.filter(row => row.action === "adopt" && row.contentRepair === "restore_terminal_lf").map(row => row.observationId),
      retainedSourceObservations: decisions.filter(row => row.action === "adopt" && byKey.get(row.sourceKey)?.retainedSourcePath).map(row => ({ observationId: row.observationId, sourcePath: byKey.get(row.sourceKey)!.retainedSourcePath, sourceKey: row.sourceKey })),
      restoreLegacyPromptWhitespaceObservationIds: decisions.filter(row => row.action === "adopt" && row.contentRepair === "restore_legacy_prompt_whitespace").map(row => row.observationId),
      restoreLegacySyntheticObservationIds: decisions.filter(row => row.action === "adopt" && row.contentRepair === "restore_legacy_synthetic").map(row => row.observationId),
      restoreLegacyImageTextObservationIds: decisions.filter(row => row.action === "adopt" && row.contentRepair === "restore_legacy_image_text").map(row => row.observationId) });
    for (const decision of decisions) {
      if (decision.action !== "adopt") continue;
      const current = byId.get(decision.observationId!)!;
      await kv.set(KV.observations(session.id), current.id, prepared.get(current.id) ?? { ...current, codexSource: sourceMetadata(byKey.get(decision.sourceKey)!, decision.duplicateOfObservationId) });
    }
    const initializedAt = new Date().toISOString();
    const indexPending = prepared.size > 0 || counts.linkDuplicateCaptures > 0 || decisions.some(row => row.action === "adopt" && byKey.get(row.sourceKey)?.retainedSourcePath) || session.codexNativeCapture?.indexPending === true;
    const activitySession = seedSourceSessionActivity(session, messages.filter(message => !message.legacyExcludedReason).map(message => message.timestamp), last.source.createdAt, initializedAt);
    const oldCursor = session.codexNativeCapture?.cursor;
    const fullyCapturedInventory = last.caughtUp && counts.missing === 0 && counts.adopt === 0 && counts.recoverRaw === 0 &&
      unresolvedCaptures.length === 0 && sourceHolds.length === 0 && !captureCwd && !reconcileSourceCwd && !repairApprovalPreview;
    const unchangedCompressedTail = oldCursor && counts.missing === 0 && last.caughtUp &&
      (last.cursor.fileIdentity.startsWith("zstd:") !== oldCursor.fileIdentity.startsWith("zstd:")) && isDeepStrictEqual(last.source, session.codexNativeCapture?.source) &&
      oldCursor.byteOffset === last.cursor.byteOffset && oldCursor.ordinal === last.cursor.ordinal &&
      oldCursor.anchor === last.cursor.anchor && oldCursor.sourceIdentity === last.cursor.sourceIdentity &&
      isDeepStrictEqual(oldCursor.parser, last.cursor.parser);
    const next: Session = { ...activitySession, ...(repairApprovalPreview ? { firstPrompt: firstSourcePrompt!.preview } : {}), ...(reconcileSourceCwd ? { cwd: currentSourceCwd } : {}), semanticGraphCompletionVersion: 1, semanticGraphStatus: "pending", codexNativeCapture: {
      version: sourceHolds.length ? 2 : 1, ...(sourceHolds.length ? { sourceHolds } : {}), source: last.source, initializedAt, status: "pending", ...(capturedAfter ? { capturedAfter } : {}),
      ...(captureCwd ? { captureCwd } : {}),
      ...(unresolvedCaptures.length ? { unresolvedCaptures } : {}),
      ...(indexPending ? { indexPending: true } : {}),
      cursor: fullyCapturedInventory || unchangedCompressedTail ? last.cursor : { ...last.cursor, version: sourceHolds.length ? 2 : 1, byteOffset: 0, ordinal: 0,
        anchor: createHash("sha256").update("").digest("hex"), parser: initialCodexParseState(Boolean(last.source.fork)) },
    }, updatedAt: initializedAt };
    if (capturedAfter) { delete next.firstPrompt; delete next.summary; }
    await kv.set(KV.sessions, session.id, next);
    return { dryRun: false, initialized: true, sessionId: session.id, ...counts };
  }));
}

export async function captureCodexSourceWindow(kv: StateKV, input: Scope, managed: ManagedSource,
  options: { readWindow?: typeof readCodexWindow; publish?: (indexRows: CompressedObservation[], eventRows: CompressedObservation[]) => Promise<void>; rebuildIndex?: boolean } = {},
) {
  return withObservationWrite(() => withKeyedLock(sessionLifecycleLockKey(input.sessionId), async () => {
    const session = await scopedSession(kv, input, managed);
    const state = session.codexNativeCapture;
    if (!state || ![1, 2].includes(state.version) || !state.cursor || state.status === "reconcile_required") throw Error("Native source requires capture initialization");
    const sourceHolds = validateCodexSourceHolds(state.sourceHolds, session.id);
    if ((state.version === 2) !== (sourceHolds.length > 0) || state.cursor.version !== state.version) throw Error("Native source hold state requires reconciliation");
    const markUnknown = async (issue: string) => kv.set(KV.sessions, session.id, { ...session,
      codexNativeCapture: { ...state, status: "unknown", issue, recordDiagnostic: undefined, checkedAt: new Date().toISOString() },
    });
    let window: Awaited<ReturnType<typeof readCodexWindow>>;
    try {
      window = await (options.readWindow ?? readCodexWindow)({ ...managed, sourcePath: state.source.relativePath,
        sessionId: session.id, cursor: state.cursor, sourceHolds });
      if (!isDeepStrictEqual(window.source, state.source) ||
          (state.captureCwd !== undefined && typeof state.captureCwd !== "string") ||
          canonicalCodexCwd(state.captureCwd ?? window.source.cwd) !== canonicalCodexCwd(session.cwd)) throw Error("Native capture source identity changed");
    } catch (error) {
      const missing = error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
      const invalidCursor = error instanceof Error && error.message === "Codex source cursor is invalid, replaced or truncated; reconciliation is required";
      if (invalidCursor) await kv.set(KV.sessions, session.id, { ...session, codexNativeCapture: { ...state,
        status: "reconcile_required", issue: "native_source_cursor_invalid", recordDiagnostic: undefined,
        cursorDiagnostic: error instanceof CodexCursorValidationError ? error.diagnostic : undefined,
        checkedAt: new Date().toISOString() } });
      else if (error instanceof CodexReadBudgetError) await kv.set(KV.sessions, session.id, { ...session,
        codexNativeCapture: { ...state, status: "unknown", issue: "native_source_read_budget_exceeded", recordDiagnostic: undefined,
          readBudget: error.usage, checkedAt: new Date().toISOString() } });
      else await markUnknown(missing ? "native_source_missing" : "native_source_read_failed");
      throw error;
    }
    const observations = await kv.list<CompressedObservation>(KV.observations(session.id), { includeDeleted: true });
    const exclusions = await kv.list<CodexCaptureExclusion>(KV.codexCaptureExclusions);
    let decisions: ReturnType<typeof matchCodexMessages>;
    try {
      decisions = matchCodexMessages(window.messages, observations, { ...input, agentId: managed.agentId,
        completeNativeInventory: false, exclusions, unresolvedCaptures: state.unresolvedCaptures });
      if (decisions.some(row => row.action === "blocked" || row.action === "adopt")) throw Error("Native capture correspondence changed; reconciliation is required");
    } catch (error) { await markUnknown("native_capture_correspondence_changed"); throw error; }
    const capturedAt = new Date().toISOString();
    const rows: CompressedObservation[] = [];
    const existing = new Map(observations.map(row => [row.id, row]));
    for (let index = 0; index < decisions.length; index++) {
      const decision = decisions[index]!; const message = window.messages[index]!;
      if (decision.action === "excluded" || decision.action === "duplicate") continue;
      if (decision.action === "present") { rows.push(existing.get(decision.observationId!)!); continue; }
      const user = message.kind === "user";
      const row = { ...buildSyntheticCompression({ id: decision.observationId!, sessionId: session.id, timestamp: message.timestamp,
        hookType: user ? "prompt_submit" : "post_tool_use", ...(user ? { userPrompt: message.text } : { toolName: "assistant_response", toolOutput: message.text }),
        agentId: managed.agentId, raw: null, origin: { channel: user ? "user" : "agent", detail: user ? "codex_native" : "assistant_response", capturedAt } }),
        project: session.project, codexSource: sourceMetadata(codexMessageReference(message)) };
      const oversized = checkPayloadFrameSize(row, "native observation exceeds the supported state frame");
      if (oversized) { await markUnknown("native_observation_too_large"); throw Error(oversized.error); }
      rows.push(row);
    }
    const inserts = rows.filter(row => !existing.has(row.id));
    if (inserts.length) await recordAudit(kv, "observe", "mem::codex-source-capture", inserts.map(row => row.id), {
      phase: "capture-window", project: session.project, sessionId: session.id,
    });
    if (inserts.length) await kv.set(KV.sessions, session.id, { ...session,
      codexNativeCapture: { ...state, status: "pending", checkedAt: capturedAt, snapshotBytes: window.snapshotBytes },
    });
    for (const row of inserts) { await kv.set(KV.observations(session.id), row.id, row); existing.set(row.id, row); }
    const status = window.issue ? "unknown" as const : window.caughtUp ? (sourceHolds.length ? "caught_up_with_holds" as const : "caught_up" as const) : "pending" as const;
    const indexRows = state.indexPending || options.rebuildIndex ? [...existing.values()].filter(row => row.emptyDeletion?.state !== "deleted") : rows;
    let indexPending = indexRows.length > 0;
    let activitySession = session.lastActivityAt === undefined
      ? seedSourceSessionActivity(session, observations.filter(row => row.codexSource && !row.codexSource.duplicateOfObservationId && !row.codexSource.legacyExcludedReason).map(row => row.codexSource!.timestamp), state.source.createdAt, capturedAt)
      : session;
    const currentMessages = new Map(window.messages.map(message => [message.key, message]));
    for (const decision of decisions) {
      if (decision.action !== "insert" && decision.action !== "present") continue;
      const message = currentMessages.get(decision.sourceKey);
      if (message) activitySession = advanceSessionActivity(activitySession, message.timestamp, message.kind === "user", capturedAt);
    }
    const next: Session = { ...activitySession,
      observationCount: [...existing.values()].filter(row => row.emptyDeletion?.state !== "deleted").length,
      updatedAt: capturedAt, ...(rows.length ? { semanticGraphStatus: "pending" } : {}),
      codexNativeCapture: { ...state, cursor: window.cursor, checkedAt: capturedAt, status, issue: window.issue?.reason, recordDiagnostic: window.issue ? { ordinal: window.issue.ordinal, byteOffset: window.issue.byteOffset, recordType: window.issue.recordType, payloadType: window.issue.payloadType, itemType: window.issue.itemType } : undefined, cursorDiagnostic: undefined, readBudget: undefined, lastFailure: undefined, indexPending, snapshotBytes: window.snapshotBytes },
    };
    const unchangedCheckpoint = isDeepStrictEqual(activitySession, session) && rows.length === 0 && !state.lastFailure && !indexPending && state.indexPending === false &&
      next.observationCount === session.observationCount && status === state.status &&
      window.issue?.reason === state.issue && window.snapshotBytes === state.snapshotBytes &&
      isDeepStrictEqual(window.cursor, state.cursor) && isDeepStrictEqual(next.codexNativeCapture!.recordDiagnostic, state.recordDiagnostic);
    if (!unchangedCheckpoint) await kv.set(KV.sessions, session.id, next);
    if (options.publish && indexPending) {
      try { await options.publish(indexRows, state.indexPending ? indexRows : rows); indexPending = false; } catch { /* Retry publication from canonical rows, without rewinding capture. */ }
      if (!indexPending) await kv.set(KV.sessions, session.id, { ...next, codexNativeCapture: { ...next.codexNativeCapture!, indexPending: false } });
    }
    return { sessionId: session.id, captured: rows.length, inserted: inserts.length, excluded: decisions.filter(row => row.action === "excluded").length,
      sourceHoldCount: sourceHolds.length, unresolvedCaptureCount: state.unresolvedCaptures?.length ?? 0,
      status, issue: window.issue, bytesReadThrough: window.cursor.byteOffset, snapshotBytes: window.snapshotBytes, indexPending };
  }));
}
