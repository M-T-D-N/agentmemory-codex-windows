import type { StateKV } from "../state/kv.js";
import { isDeletedObservation } from "../state/kv.js";
import { withObservationRecovery } from "../state/observation-write.js";
import { KV } from "../state/schema.js";
import type { CompressedObservation, Session } from "../types.js";
import { observationContentFields, previewSessionForget } from "./forget-preview.js";
import { orderedSessionObservations } from "./semantic-graph-backlog.js";
import { recordAudit } from "./audit.js";
import { getSearchIndex, vectorIndexRemove, flushIndexSave } from "./search.js";

export interface EmptyObservationRequest {
  action?: string;
  project?: string;
  sessionId?: string;
  observationIds?: string[];
  memoryId?: string;
  expectedVersion?: number;
  reason?: string;
  dryRun?: boolean;
}

export async function changeEmptyObservation(kv: StateKV, data: EmptyObservationRequest) {
  let committed = false;
  let commitAttempted = false;
  try {
    if (!['delete-empty', 'restore-empty'].includes(data.action ?? '') || data.memoryId !== undefined ||
        typeof data.project !== 'string' || !data.project.trim() || data.project.trim() === '*' || data.project.length > 512 ||
        typeof data.sessionId !== 'string' || !data.sessionId.trim() ||
        !Array.isArray(data.observationIds) || data.observationIds.length !== 1 ||
        typeof data.observationIds[0] !== 'string' || !data.observationIds[0].trim()) {
      throw new Error('Empty observation recovery requires one exact project, sessionId and observation ID');
    }
    if (data.dryRun !== undefined && typeof data.dryRun !== 'boolean') throw new Error('dryRun must be a boolean');
    if (!data.dryRun && (!Number.isSafeInteger(data.expectedVersion) || data.expectedVersion! < 0 ||
        typeof data.reason !== 'string' || !data.reason.trim() || data.reason.length > 1000)) {
      throw new Error('Apply requires the preview expectedVersion and a non-empty reason of at most 1000 characters');
    }
    const result = await withObservationRecovery(async () => {
      await kv.initializeObservationRecovery();
      const project = data.project!.trim();
      const sessionId = data.sessionId!.trim();
      const id = data.observationIds![0];
      const session = await kv.get<Session>(KV.sessions, sessionId);
      const row = await kv.get<CompressedObservation>(KV.observations(sessionId), id, { includeDeleted: true });
      if (!session || session.project !== project || !row || row.id !== id || row.sessionId !== sessionId) throw new Error('Exact observation ownership could not be verified');
      const contentFields = observationContentFields(row as unknown as Record<string, unknown>);
      if (contentFields.length) throw new Error('Observation has content: ' + contentFields.join(', '));
      const deleted = isDeletedObservation(row);
      const version = row.emptyDeletion?.version ?? 0;
      const desired = data.action === 'delete-empty' ? 'deleted' : 'restored';
      const sameState = row.emptyDeletion?.state === desired;
      if (data.action === 'restore-empty' && !row.emptyDeletion) throw new Error('Observation has never been recoverably deleted');
      if ((session.semanticGraphBootstrapSkipped ?? 0) !== 0 || session.semanticGraphBackfillThroughObservationId) throw new Error('Bootstrap or backfill sessions are not supported by empty observation recovery');
      const all = await kv.list<CompressedObservation>(KV.observations(sessionId), { includeDeleted: true });
      const ordered = orderedSessionObservations(sessionId, all.map(o => ({ ...o, emptyDeletion: undefined })));
      const anchor = ordered.findIndex(o => o.id === session.semanticGraphThroughObservationId);
      const target = ordered.findIndex(o => o.id === id);
      if (target < 0 || anchor <= target) throw new Error('Only processed observations before a valid forward cursor can be recovered');
      if (data.action === 'delete-empty' && !sameState && (session.status !== 'completed' || session.semanticGraphStatus !== 'complete')) {
        throw new Error('Deletion requires a completed session with completed graph processing');
      }
      const preview = await previewSessionForget(kv, { project, sessionId, observationIds: [id] }, true);
      if (!preview.referenceInventoryComplete || preview.referenceCount !== 0) throw new Error('Observation references must be completely inventoried and empty');
      if (data.dryRun) return { ...preview, action: data.action, permanentDeletion: false, recoverable: true,
        expectedVersion: version, currentState: deleted ? 'deleted' : 'active', eligible: true,
        semanticGraphThroughObservationId: session.semanticGraphThroughObservationId };
      if (data.expectedVersion !== version && !(sameState && data.expectedVersion === version - 1)) throw new Error('Observation version changed; preview again');
      committed = sameState;
      let current = row;
      if (!sameState) {
        const audit = await recordAudit(kv, 'forget', 'mem::forget', [id], {
          action: data.action, project, sessionId, recoverable: true, expectedVersion: version, reason: data.reason!.trim(), phase: 'intent',
        });
        current = { ...row, emptyDeletion: { state: desired, version: version + 1,
          changedAt: audit.timestamp, reason: data.reason!.trim(), auditId: audit.id } };
        commitAttempted = true;
        await kv.writeEmptyObservation(current);
        committed = true;
      }
      if (desired === 'deleted') {
        getSearchIndex().remove(id);
        vectorIndexRemove(id);
      } else {
        getSearchIndex().add(current);
      }
      const count = (await kv.list(KV.observations(sessionId))).length;
      await kv.update(KV.sessions, sessionId, [{ type: 'set', path: 'observationCount', value: count }]);
      return { success: true, action: data.action, recoverable: true, changed: sameState ? 0 : 1,
        id, project, sessionId, state: desired, version: current.emptyDeletion!.version,
        auditId: current.emptyDeletion!.auditId, actualObservationCount: count,
        semanticGraphThroughObservationId: session.semanticGraphThroughObservationId,
        indexPersistence: 'best-effort; all observation reads revalidate canonical visibility' };
    });
    if (!data.dryRun) await flushIndexSave();
    return result;
  } catch (error) {
    return { success: false, action: data.action, dryRun: data.dryRun ?? false, committed,
      commitState: committed ? "committed" : commitAttempted ? "unknown" : "not-started",
      error: error instanceof Error ? error.message : String(error),
      ...(committed ? { recovery: 'Verify the engine outcome and restart the worker, then preview and retry the same action to repair count and search side effects' } : {}) };
  }
}
