import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { lstat } from "node:fs/promises";
import type { CodexCaptureExclusion, Session } from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { withObservationWrite } from "../state/observation-write.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { prepareSessionStart, sessionLifecycleLockKey } from "./session-lifecycle.js";
import { canonicalCodexCwd } from "./codex-source-identity.js";
import { isExcludedCodexAmbientSession } from "./observation-visibility.js";
import { recordAudit } from "./audit.js";
import { readCodexWindow } from "../replay/codex-window.js";
import { initialCodexParseState } from "../replay/codex-record.js";
import type { CodexThreadCandidate } from "./codex-source-index.js";
import { initializeCodexSourceCapture } from "./codex-source-capture.js";

const exact = (value: unknown): value is string => typeof value === "string" && value.length > 0 &&
  value.length <= 512 && value.trim() === value && value !== "*";

export function existingCodexDiscoveryStatus(session: Session, candidate: CodexThreadCandidate, agentId: string) {
  if (isExcludedCodexAmbientSession(session)) return "excluded" as const;
  if (session.id !== candidate.sessionId || session.agentId !== agentId || !exact(session.project) || typeof session.cwd !== "string") return "reconcile_required" as const;
  try { if (canonicalCodexCwd(session.cwd) !== candidate.cwd) return "reconcile_required" as const; }
  catch { return "reconcile_required" as const; }
  if (!session.codexNativeCapture) return "inspect" as const;
  return session.semanticGraphCompletionVersion === 1 &&
    [1, 2].includes(session.codexNativeCapture?.version ?? 0) && session.codexNativeCapture.cursor &&
    ["pending", "caught_up", "caught_up_with_holds", "unknown"].includes(session.codexNativeCapture.status)
    ? session.codexNativeCapture.source.relativePath === candidate.sourcePath ? "managed" as const : "relocate" as const
    : "reconcile_required" as const;
}

async function relocateCodexSource(kv: StateKV, candidate: CodexThreadCandidate,
  managed: { sourceRoot: string; agentId: string },
) {
  return withObservationWrite(() => withKeyedLock(sessionLifecycleLockKey(candidate.sessionId), async () => {
    const session = await kv.get<Session>(KV.sessions, candidate.sessionId);
    if (!session) return { status: "reconcile_required" as const };
    const status = existingCodexDiscoveryStatus(session, candidate, managed.agentId);
    if (status !== "relocate") return { status: status === "inspect" ? "reconcile_required" as const : status };
    const state = session.codexNativeCapture!;
    const verified = await readCodexWindow({ sourceRoot: managed.sourceRoot, sourcePath: candidate.sourcePath,
      sessionId: session.id, cursor: state.cursor, sourceHolds: state.sourceHolds, maxBytes: 1, maxMessages: 1 });
    if (verified.source.source !== candidate.source ||
        (state.captureCwd !== undefined && typeof state.captureCwd !== "string") ||
        canonicalCodexCwd(state.captureCwd ?? verified.source.cwd) !== candidate.cwd ||
        !isDeepStrictEqual({ ...state.source, relativePath: verified.source.relativePath }, verified.source)) {
      return { status: "reconcile_required" as const, reason: "relocated_source_identity_changed" };
    }
    await recordAudit(kv, "observe", "mem::codex-source-discover", [session.id], { phase: "source-relocation", project: session.project });
    await kv.set(KV.sessions, session.id, { ...session, codexNativeCapture: {
      ...state, source: verified.source, status: "pending", issue: undefined,
    } });
    return { status: "relocated" as const, project: session.project };
  }));
}

export async function discoverCodexSession(kv: StateKV, candidate: CodexThreadCandidate,
  managed: { sourceRoot: string; agentId: string; projectForCwd: (cwd: string) => string },
) {
  if (candidate.status !== "candidate" || !exact(candidate.sessionId) || !exact(managed.agentId)) throw Error("Exact native discovery identity is required");
  const existing = await kv.get<Session>(KV.sessions, candidate.sessionId);
  if (existing) {
    const status = existingCodexDiscoveryStatus(existing, candidate, managed.agentId);
    if (status === "relocate") return relocateCodexSource(kv, candidate, managed);
    if (status !== "inspect") return { status };
  }
  const first = await readCodexWindow({ sourceRoot: managed.sourceRoot, sourcePath: candidate.sourcePath,
    sessionId: candidate.sessionId, maxBytes: 16 * 1024 * 1024, maxMessages: 1 });
  if (first.source.source !== candidate.source || (!existing && canonicalCodexCwd(first.source.cwd) !== candidate.cwd)) {
    return { status: "reconcile_required" as const, reason: "indexed_source_identity_changed" };
  }
  if (first.issue) return { status: "unknown" as const, reason: first.issue.reason };
  if (!first.messages.length) return { status: "pending" as const, reason: first.caughtUp ? "no_conversation_messages" : "first_message_not_yet_verified" };
  const discoveryCwd = existing?.cwd ?? first.source.cwd;
  const directory = await lstat(discoveryCwd).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (directory ? !directory.isDirectory() || directory.isSymbolicLink() : !existing) {
    return { status: "unknown" as const, reason: "project_directory_unavailable" };
  }
  const project = directory ? managed.projectForCwd(discoveryCwd) : existing!.project;
  if (!exact(project)) throw Error("Native discovery requires an exact project");
  if (existing) {
    if (existing.project !== project) return { status: "reconcile_required" as const, reason: "existing_project_does_not_match_source" };
    const scope = { sessionId: candidate.sessionId, project, sourcePath: candidate.sourcePath };
    const bounded = { sourceRoot: managed.sourceRoot, agentId: managed.agentId, maxInventoryWindows: 4 };
    const preview = await initializeCodexSourceCapture(kv, { ...scope, dryRun: true }, bounded);
    if (!("expectedVersion" in preview)) throw Error("Native initialization did not produce a correspondence preview");
    await initializeCodexSourceCapture(kv, { ...scope, dryRun: false, expectedVersion: preview.expectedVersion,
      reason: "Automatic native transition after exact existing observation correspondence" }, bounded);
    return { status: "initialized" as const, project };
  }
  return withObservationWrite(() => withKeyedLock(sessionLifecycleLockKey(candidate.sessionId), async () => {
    const current = await kv.get<Session>(KV.sessions, candidate.sessionId);
    if (current) {
      const status = existingCodexDiscoveryStatus(current, candidate, managed.agentId);
      return { status: status === "inspect" || status === "relocate" ? "reconcile_required" as const : status };
    }
    const exclusions = await kv.list<CodexCaptureExclusion>(KV.codexCaptureExclusions);
    if (exclusions.some(row => row.sessionId === candidate.sessionId) ||
        (await kv.list(KV.observations(candidate.sessionId), { includeDeleted: true })).length ||
        await kv.get(KV.summaries, candidate.sessionId)) {
      return { status: "reconcile_required" as const, reason: "prior_source_lifecycle_exists" };
    }
    const now = new Date().toISOString();
    const prepared = prepareSessionStart(null, { sessionId: candidate.sessionId, project,
      cwd: first.source.cwd, agentId: managed.agentId }, first.source.createdAt);
    if (!prepared.success) throw Error(prepared.error);
    const session: Session = { ...prepared.session, status: candidate.archived ? "completed" : "active", updatedAt: now,
      semanticGraphCompletionVersion: 1, semanticGraphStatus: "pending", codexNativeCapture: {
        version: 1, source: first.source, initializedAt: now, status: "pending", snapshotBytes: first.snapshotBytes,
        cursor: { ...first.cursor, byteOffset: 0, ordinal: 0,
          anchor: createHash("sha256").update("").digest("hex"), parser: initialCodexParseState(Boolean(first.source.fork)) },
      } };
    await recordAudit(kv, "observe", "mem::codex-source-discover", [session.id], { phase: "new-source", project });
    await kv.set(KV.sessions, session.id, session);
    return { status: "created" as const, project };
  }));
}
