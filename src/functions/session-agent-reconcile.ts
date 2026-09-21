import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Session } from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { withObservationRecovery } from "../state/observation-write.js";
import { sessionLifecycleLockKey } from "./session-lifecycle.js";
import { isExcludedCodexAmbientSession } from "./observation-visibility.js";
import { recordAudit } from "./audit.js";
import { canonicalCodexCwd, type CodexSourceIdentity } from "./codex-source-identity.js";
import type { CodexThreadIndexEntry } from "./codex-source-index.js";

export interface SessionAgentReconcileInput {
  project: string;
  sessionId: string;
  sourcePath: string;
  dryRun: boolean;
  expectedVersion?: string;
  reason?: string;
}

interface OwnedObservation {
  id: string;
  sessionId: string;
  project?: string;
  agentId?: string;
  emptyDeletion?: unknown;
}

function owner(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 512 || value.trim() === "*") {
    throw new Error("Malformed existing agent identity; no automatic reassignment is allowed");
  }
  return value.trim();
}

export async function reconcileCodexSessionAgent(
  kv: StateKV,
  input: SessionAgentReconcileInput,
  targetAgentId: string,
  readSource: (sourcePath: string, sessionId: string) => Promise<CodexSourceIdentity>,
  readIndexedSource?: (sessionId: string) => Promise<CodexThreadIndexEntry | undefined>,
  readCurrentCwd?: (sourcePath: string, sessionId: string) => Promise<{
    source: CodexSourceIdentity; complete: boolean; cwd?: string;
  }>,
) {
  if (!input || typeof input.project !== "string" || !input.project.trim() ||
      input.project === "*" || input.project !== input.project.trim() || input.project.length > 512 ||
      typeof input.sessionId !== "string" || !input.sessionId.trim() || input.sessionId !== input.sessionId.trim() || input.sessionId.length > 512 ||
      typeof input.sourcePath !== "string" || !input.sourcePath || typeof input.dryRun !== "boolean") {
    throw new Error("An exact project, sessionId, sourcePath and explicit dryRun are required");
  }
  const target = owner(targetAgentId);
  if (!target) throw new Error("A configured capture agent is required");
  if (!input.dryRun && (typeof input.expectedVersion !== "string" ||
      !/^[a-f0-9]{64}$/.test(input.expectedVersion) || typeof input.reason !== "string" ||
      !input.reason.trim() || input.reason.length > 512)) {
    throw new Error("Apply requires the preview expectedVersion and a non-empty reason of at most 512 characters");
  }

  return withKeyedLock(sessionLifecycleLockKey(input.sessionId), async () => {
    const work = async () => {
      const session = await kv.get<Session>(KV.sessions, input.sessionId);
      if (!session || session.id !== input.sessionId || session.project !== input.project ||
          typeof session.cwd !== "string" || isExcludedCodexAmbientSession(session)) {
        throw new Error("Session identity, project or capture policy does not permit owner reconciliation");
      }
      const source = await readSource(input.sourcePath, input.sessionId);
      const sourceCwd = canonicalCodexCwd(source.cwd);
      let sessionCwd: string;
      let cwdToUpdate = false;
      try { sessionCwd = canonicalCodexCwd(session.cwd); }
      catch (error) {
        if (session.cwd !== session.project || !readIndexedSource) throw error;
        const indexed = await readIndexedSource(session.id);
        if (indexed?.status !== "candidate" || indexed.sessionId !== session.id ||
            indexed.sourcePath !== source.relativePath || indexed.cwd !== sourceCwd || indexed.source !== source.source) {
          throw new Error("Legacy cwd correction requires matching native header and thread index");
        }
        sessionCwd = sourceCwd;
        cwdToUpdate = true;
      }
      if (source.sessionId !== session.id) throw new Error("Native source does not match the canonical session");
      let verifiedCurrentCwd: string | undefined;
      if (sourceCwd !== sessionCwd) {
        if (!readIndexedSource || !readCurrentCwd) throw new Error("Native source does not match the canonical session");
        const indexed = await readIndexedSource(session.id);
        if (indexed?.status !== "candidate" || indexed.sessionId !== session.id || indexed.sourcePath !== source.relativePath ||
            indexed.source !== source.source || indexed.cwd !== sessionCwd) throw new Error("Native cwd transition requires matching canonical session and thread index");
        const current = await readCurrentCwd(input.sourcePath, session.id);
        if (!current.complete || current.cwd !== sessionCwd || !isDeepStrictEqual(current.source, source)) {
          throw new Error("Native cwd transition requires a complete matching source inventory");
        }
        verifiedCurrentCwd = sessionCwd;
      }
      const sessionOwner = owner(session.agentId);
      if (sessionOwner && sessionOwner !== target) throw new Error("An existing session owner cannot be reassigned");
      const observations = await kv.list<OwnedObservation>(KV.observations(session.id), { includeDeleted: true });
      const seen = new Set<string>();
      for (const row of observations) {
        if (!row || typeof row.id !== "string" || !row.id || seen.has(row.id) ||
            row.sessionId !== session.id || (row.project !== undefined && row.project !== session.project)) {
          throw new Error("Invalid or cross-project observation identity");
        }
        seen.add(row.id);
        const observationOwner = owner(row.agentId);
        if (observationOwner && observationOwner !== target) throw new Error("An existing observation owner cannot be reassigned");
        if (row.emptyDeletion !== undefined && observationOwner !== target) {
          throw new Error("Recovery-protected observations require their existing lifecycle");
        }
      }
      const pending = observations.filter(row => owner(row.agentId) !== target);
      const proof = { ...source, cwd: sourceCwd };
      const previous = session.codexAgentReconciliation;
      if (previous && (previous.version !== 1 || previous.agentId !== target ||
          !["pending", "complete"].includes(previous.state) || !previous.source ||
          typeof previous.auditId !== "string" || !previous.auditId ||
          !Number.isFinite(Date.parse(previous.startedAt)) || !Number.isFinite(Date.parse(previous.updatedAt)) ||
          previous.source.sessionId !== source.sessionId || previous.source.cwd !== proof.cwd ||
          previous.source.createdAt !== proof.createdAt || previous.source.source !== proof.source ||
          previous.source.fork?.parentSessionId !== proof.fork?.parentSessionId ||
          previous.source.fork?.endOrdinalExclusive !== proof.fork?.endOrdinalExclusive ||
          previous.source.fork?.endByteOffset !== proof.fork?.endByteOffset ||
          previous.source.continuation?.endByteOffset !== proof.continuation?.endByteOffset ||
          previous.source.continuation?.endOrdinalExclusive !== proof.continuation?.endOrdinalExclusive ||
          previous.source.continuation?.sourcePath !== proof.continuation?.sourcePath)) {
        throw new Error("Existing owner reconciliation provenance conflicts with the native source");
      }
      const expectedVersion = createHash("sha256").update(JSON.stringify({
        id: session.id, project: session.project, cwd: session.cwd, canonicalCwd: sessionCwd,
        owner: sessionOwner ?? null, source: proof,
        verifiedCurrentCwd,
        observations: observations.map(row => [row.id, owner(row.agentId) ?? null]).sort((a, b) => a[0]!.localeCompare(b[0]!)),
      })).digest("hex");
      const plan = { sessionId: session.id, project: session.project, targetAgentId: target,
        previousAgentId: sessionOwner ?? null, observationCount: observations.length,
        observationsToUpdate: pending.length, cwdToUpdate, previousCwd: session.cwd, expectedVersion, source: proof,
        ...(verifiedCurrentCwd ? { verifiedCurrentCwd } : {}) };
      if (input.dryRun) return { success: true, dryRun: true, ...plan };
      if (input.expectedVersion !== expectedVersion) throw new Error("Reconciliation preview is stale; no changes were made");
      if (sessionOwner === target && pending.length === 0 && !cwdToUpdate && previous?.state !== "pending") {
        return { success: true, dryRun: false, changed: false, ...plan };
      }

      const audit = await recordAudit(kv, "session_agent_reconcile", "mem::session-owner-reconcile", [session.id], {
        state: "started", project: session.project, targetAgentId: target,
        observationIds: pending.map(row => row.id), source: proof, reason: input.reason!.trim(),
        ...(verifiedCurrentCwd ? { verifiedCurrentCwd } : {}),
        ...(cwdToUpdate ? { previousCwd: session.cwd, correctedCwd: source.cwd } : {}),
      });
      const reconciliation = { version: 1 as const, state: "pending" as const, agentId: target,
        source: proof, startedAt: previous?.startedAt ?? audit.timestamp,
        updatedAt: audit.timestamp, auditId: audit.id };
      await kv.update(KV.sessions, session.id, [
        { type: "set", path: "agentId", value: target },
        { type: "set", path: "codexAgentReconciliation", value: reconciliation },
        ...(cwdToUpdate ? [{ type: "set" as const, path: "cwd", value: source.cwd }] : []),
      ]);
      for (const row of pending) {
        await kv.update(KV.observations(session.id), row.id, [{ type: "set", path: "agentId", value: target }]);
      }
      const finishedAt = new Date().toISOString();
      await kv.update(KV.audit, audit.id, [{ type: "set", path: "details", value: {
        ...audit.details, state: "applied", completedAt: finishedAt,
      } }]);
      await kv.update(KV.sessions, session.id, [{ type: "set", path: "codexAgentReconciliation",
        value: { ...reconciliation, state: "complete", updatedAt: finishedAt } }]);
      return { success: true, dryRun: false, changed: true, ...plan, auditId: audit.id };
    };
    return input.dryRun ? work() : withObservationRecovery(work);
  });
}
