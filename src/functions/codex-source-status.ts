import type { ArchiveState, CompressedObservation, Session } from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { readArchiveVisibility } from "./archive.js";
import { isExcludedCodexAmbientSession } from "./observation-visibility.js";
import { validateCodexSourceHolds } from "../replay/codex-source-hold.js";
import { unresolvedCodexCapture } from "../replay/codex-unresolved-capture.js";

const reasons = new Set(["native_source_missing", "native_source_read_failed", "native_source_cursor_invalid", "native_source_correspondence_changed",
  "observation_too_large", "record_exceeds_supported_size", "invalid_jsonl_record",
  "fork_record_precedes_or_lacks_own_history_timestamp", "native_capture_rpc_failed", "returned_source_requires_reconciliation", "returned_source_identity_changed"]);
const exact = (value: unknown): value is string => typeof value === "string" && value.length > 0 &&
  value.length <= 512 && value === value.trim() && value !== "*";
const publicId = (value: unknown): string | null => exact(value) && /^[\w.-]+$/.test(value) ? value : null;
export interface NativeCaptureIssue {
  sessionId: string | null; project: string | null; observationId?: string | null;
  category: "capture_unknown" | "requires_reconciliation" | "capture_failed" | "legacy_review";
  reason: string; observedAt: string | null;
}
export interface NativeCaptureReport {
  readOnly: true; readAt: string; status: "checking" | "attention" | "unavailable" | "disabled";
  complete: boolean; components: { unknownSessions: number; reconciliationSessions: number; failureSessions: number } | null;
  uniqueSessionCount: number | null; uniqueEventCount: number | null; issueCount: number | null;
  issues: NativeCaptureIssue[]; limit: number; offset: number; nextOffset: number | null;
  verificationFailure?: string;
  pipeline?: { scope: "server_discovery_and_graph"; discoveryIssues: number; schedulerFailures: number; graphFailures: number;
    observedAt: string | null; discoveryCycleCompletedAt: string | null; discoveryIssueCount: number; discoveryTargetCount: number;
    discoveryDetailsComplete: boolean; discoveryRecords: Array<{ sessionId: string | null; category: string; reason: string; observedAt: string }>;
    nextOffset: number | null };

  batch?: { workerStartedAt?: string | null; lastCycleCompletedAt?: string | null; observedAt: string | null; cycleComplete: boolean | null; freshness: string;
    scope: "latest_drain"; counting: "non_unique_component_sum";
    components: { unknownSessions: number; reconciliationSessions: number; batchFailureEvents: number } | null };
  history?: { archivedUnavailableSessions: number; approvedSourceHolds: number;
    reviewedLegacyTotal?: number; nextOffset?: number | null;
    reviewedLegacy: Array<{ sessionId: string | null; observationId: string | null; fingerprint: string; auditId: string | null; archivedAt: string; revision: number; disposition: "archived_reviewed_original" }> };
}

// Read canonical state only: no discovery, drain, source writes, provider calls or repair.
export async function readCodexSourceStatus(kv: StateKV, owner: string, options: {
  project?: string; limit?: number; offset?: number; includeHistory?: boolean;
} = {}): Promise<NativeCaptureReport> {
  const limit = options.limit ?? 10, offset = options.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 ||
      options.project !== undefined && !exact(options.project) ||
      options.includeHistory !== undefined && typeof options.includeHistory !== "boolean") throw Error("Invalid capture status selection");
  const base = { readOnly: true as const, readAt: new Date().toISOString(), limit, offset, nextOffset: null,
    components: null, uniqueSessionCount: null, uniqueEventCount: null, issueCount: null, issues: [] };
  if (!owner) return { ...base, status: "disabled", complete: true };
  try {
    const archiveRows = await kv.list<ArchiveState>(KV.archiveStates);
    const archived = await readArchiveVisibility({ list: async <T>() => archiveRows as T[] });
    const sessions = (await kv.list<Session>(KV.sessions)).filter(row => row.agentId === owner &&
      row.codexNativeCapture && !isExcludedCodexAmbientSession(row) && (!options.project || row.project === options.project));
    const projects = new Set(sessions.map(row => row.project));
    if (archiveRows.some(row => projects.has(row.project) && row.importPendingDigest)) throw Error("archive_verification_pending");
    const issues: NativeCaptureIssue[] = [];
    const affected = new Set<string>();
    const components = { unknownSessions: 0, reconciliationSessions: 0, failureSessions: 0 };
    const history: NonNullable<NativeCaptureReport["history"]> = {
      archivedUnavailableSessions: 0, approvedSourceHolds: 0, reviewedLegacy: [],
    };
    let legacyChecks = 0;
    const add = (row: Session, category: NativeCaptureIssue["category"], reason: string, observationId?: string) => {
      affected.add(row.id);
      issues.push({ sessionId: publicId(row.id), project: publicId(row.project), category, reason,
        observedAt: category === "capture_failed" && row.codexNativeCapture?.lastFailure
          ? row.codexNativeCapture.lastFailure.observedAt
          : typeof row.codexNativeCapture?.checkedAt === "string" && Number.isFinite(Date.parse(row.codexNativeCapture.checkedAt))
            ? row.codexNativeCapture.checkedAt : null, ...(observationId ? { observationId: publicId(observationId) } : {}) });
    };
    for (const row of sessions) {
      const state = row.codexNativeCapture!;
      const holds = validateCodexSourceHolds(state.sourceHolds, row.id);
      if (state.lastFailure && (typeof state.lastFailure !== "object" ||
          Object.keys(state.lastFailure).sort().join(",") !== "observedAt,reason" ||
          state.lastFailure.reason !== "native_capture_rpc_failed" ||
          typeof state.lastFailure.observedAt !== "string" || !Number.isFinite(Date.parse(state.lastFailure.observedAt)))) {
        throw Error("invalid_capture_failure_metadata");
      }
      if (state.status === "unknown" && state.issue === "native_source_missing" && archived({ kind: "session", id: row.id })) {
        const evidence = archiveRows.find(item => item.target.kind === "session" && item.target.id === row.id);
        if (!evidence || evidence.project !== row.project) throw Error("archive_owner_unverified");
        history.archivedUnavailableSessions++; continue;
      }
      if (state.status === "unknown") {
        components.unknownSessions++;
        add(row, "capture_unknown", reasons.has(state.issue ?? "") ? state.issue! : "capture_issue_unclassified");
      }
      if (!exact(row.id) || !exact(row.project) || ![1, 2].includes(state.version) || (state.version === 2) !== (holds.length > 0) || !state.cursor ||
          !["pending", "caught_up", "caught_up_with_holds", "unknown"].includes(state.status) ||
          state.checkedAt !== undefined && !Number.isFinite(Date.parse(state.checkedAt))) {
        components.reconciliationSessions++;
        add(row, "requires_reconciliation", reasons.has(state.issue ?? "") ? state.issue! : "canonical_capture_state_requires_reconciliation");
      }
      if (state.lastFailure || state.issue === "native_capture_rpc_failed" && state.status === "unknown") {
        components.failureSessions++;
        add(row, "capture_failed", "native_capture_rpc_failed");
      }
      history.approvedSourceHolds += holds.length;
      for (const retained of state.unresolvedCaptures ?? []) {
        if (++legacyChecks > 1000) throw Error("legacy_check_budget_exceeded");
        const original = await kv.get<CompressedObservation>(KV.observations(row.id), retained.observationId, { includeDeleted: true });
        let matches = false;
        if (original) {
          try { matches = unresolvedCodexCapture(original, { sessionId: row.id, project: row.project, agentId: owner }).fingerprint === retained.fingerprint; }
          catch { /* Invalid or changed correspondence stays actionable. */ }
        }
        if (matches && archived({ kind: "observation", sessionId: row.id, id: retained.observationId })) {
          const evidence = archiveRows.find(item => item.target.kind === "observation" && item.target.sessionId === row.id && item.target.id === retained.observationId);
          if (!evidence || evidence.project !== row.project) throw Error("archive_owner_unverified");
          history.reviewedLegacy.push({ sessionId: publicId(row.id), observationId: publicId(retained.observationId),
            fingerprint: retained.fingerprint, auditId: publicId(evidence.auditId), archivedAt: evidence.changedAt,
            revision: evidence.revision, disposition: "archived_reviewed_original" });
        } else add(row, "legacy_review", !matches ? "unresolved_capture_correspondence_changed" : "unresolved_capture_requires_review", retained.observationId);
      }
    }
    issues.sort((a, b) => JSON.stringify([a.project, a.sessionId, a.category, a.observationId]).localeCompare(JSON.stringify([b.project, b.sessionId, b.category, b.observationId])));
    const uniqueEventCount = issues.some(issue => issue.observedAt === null) ? null : new Set(issues.map(issue => JSON.stringify([
      issue.project, issue.sessionId, issue.observationId ?? null, issue.observedAt,
    ]))).size;
    const page = issues.slice(offset, offset + limit);
    return { ...base, status: issues.length ? "attention" : "checking", complete: true,
      components, uniqueSessionCount: affected.size, uniqueEventCount, issueCount: issues.length, issues: page,
      nextOffset: offset + page.length < issues.length ? offset + page.length : null,
      ...(options.includeHistory ? { history: { ...history, reviewedLegacyTotal: history.reviewedLegacy.length,
        reviewedLegacy: history.reviewedLegacy.slice(offset, offset + limit),
        nextOffset: offset + limit < history.reviewedLegacy.length ? offset + limit : null } } : {}) };
  } catch {
    return { ...base, status: "unavailable", complete: false, verificationFailure: "capture_state_verification_failed" };
  }
}

export function attachCodexCaptureBatch(report: NativeCaptureReport, scheduler: unknown): NativeCaptureReport {
  const snapshot = (scheduler as { captureSnapshot?: Record<string, unknown> } | null)?.captureSnapshot;
  const raw = snapshot?.components as Record<string, unknown> | undefined;
  const components = raw && [raw.unknownSessions, raw.reconciliationSessions, raw.batchFailureEvents]
    .every(value => Number.isSafeInteger(value) && Number(value) >= 0)
    ? { unknownSessions: Number(raw.unknownSessions), reconciliationSessions: Number(raw.reconciliationSessions),
      batchFailureEvents: Number(raw.batchFailureEvents) } : null;
  const rawPipeline = (scheduler as { pipeline?: NativeCaptureReport["pipeline"] } | null)?.pipeline;
  let pipeline: NativeCaptureReport["pipeline"];
  if (rawPipeline) {
    const counters = [rawPipeline.discoveryIssues, rawPipeline.schedulerFailures, rawPipeline.graphFailures,
      rawPipeline.discoveryIssueCount, rawPipeline.discoveryTargetCount];
    if (!counters.every(value => Number.isSafeInteger(value) && value >= 0) || !Array.isArray(rawPipeline.discoveryRecords)) {
      return { ...report, status: "unavailable", complete: false, verificationFailure: "pipeline_state_verification_failed" };
    }
    pipeline = { scope: "server_discovery_and_graph", discoveryIssues: rawPipeline.discoveryIssues,
      schedulerFailures: rawPipeline.schedulerFailures, graphFailures: rawPipeline.graphFailures,
      observedAt: typeof rawPipeline.observedAt === "string" && Number.isFinite(Date.parse(rawPipeline.observedAt)) ? rawPipeline.observedAt : null,
      discoveryCycleCompletedAt: typeof rawPipeline.discoveryCycleCompletedAt === "string" && Number.isFinite(Date.parse(rawPipeline.discoveryCycleCompletedAt)) ? rawPipeline.discoveryCycleCompletedAt : null,
      discoveryIssueCount: rawPipeline.discoveryIssueCount, discoveryTargetCount: rawPipeline.discoveryTargetCount,
      discoveryDetailsComplete: rawPipeline.discoveryDetailsComplete === true,
      discoveryRecords: rawPipeline.discoveryRecords.map(row => ({ sessionId: publicId(row.sessionId),
        category: ["discovery_unknown", "discovery_reconciliation"].includes(row.category) ? row.category : "discovery_unknown",
        reason: typeof row.reason === "string" && /^[a-z_]{1,100}$/.test(row.reason) ? row.reason : "discovery_issue_unclassified",
        observedAt: typeof row.observedAt === "string" && Number.isFinite(Date.parse(row.observedAt)) ? row.observedAt : "unknown" })),
      nextOffset: Number.isSafeInteger(rawPipeline.nextOffset) && Number(rawPipeline.nextOffset) >= 0 ? rawPipeline.nextOffset : null,
    };
  }
  return { ...report, ...(pipeline ? { pipeline } : {}), batch: {
    observedAt: typeof snapshot?.observedAt === "string" && Number.isFinite(Date.parse(snapshot.observedAt)) ? snapshot.observedAt : null,
    workerStartedAt: typeof snapshot?.workerStartedAt === "string" && Number.isFinite(Date.parse(snapshot.workerStartedAt)) ? snapshot.workerStartedAt : null,
    lastCycleCompletedAt: typeof snapshot?.lastCycleCompletedAt === "string" && Number.isFinite(Date.parse(snapshot.lastCycleCompletedAt)) ? snapshot.lastCycleCompletedAt : null,
    cycleComplete: typeof snapshot?.cycleComplete === "boolean" ? snapshot.cycleComplete : null,
    freshness: ["current", "stale", "unobserved"].includes(String(snapshot?.freshness)) ? String(snapshot?.freshness) : "unobserved",
    scope: "latest_drain", counting: "non_unique_component_sum", components,
  } };
}
