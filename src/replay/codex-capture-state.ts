import { validateCodexSourceHolds } from "./codex-source-hold.js";
import type { ExportData, Session } from "../types.js";
import { canonicalCodexCwd, validateCodexContinuation, validateCodexFork } from "../functions/codex-source-identity.js";

const timestamp = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

export function codexSessionForTransfer(session: Session): Session {
  if (session.semanticGraphCompletionVersion !== undefined) {
    if (session.semanticGraphCompletionVersion !== 1) throw Error("Unsupported graph completion transfer version");
    session = { ...session, semanticGraphStatus: "pending" };
  }
  const state = session.codexNativeCapture;
  if (state === undefined) return session;
  const source = state?.source;
  const sourceHolds = validateCodexSourceHolds(state?.sourceHolds, session.id);
  if ((state?.version === 2) !== (sourceHolds.length > 0)) throw Error("Invalid native source hold transfer version");
  if (!state || typeof state !== "object" || ![1, 2].includes(state.version) || !source || source.sessionId !== session.id ||
      !["cli", "vscode"].includes(source.source) || !timestamp(source.createdAt) || !timestamp(state.initializedAt) ||
      typeof source.cwd !== "string" || !canonicalCodexCwd(source.cwd) ||
      (state.captureCwd !== undefined && typeof state.captureCwd !== "string") ||
      canonicalCodexCwd(state.captureCwd ?? source.cwd) !== canonicalCodexCwd(session.cwd) ||
      typeof source.relativePath !== "string" || source.relativePath.length > 2048 ||
      !/^(sessions|archived_sessions)[\\/]/.test(source.relativePath) ||
      source.relativePath.split(/[\\/]/).some(part => !part || part === "." || part === ".." || /[:\0]/.test(part)) ||
      (source.fork !== undefined && source.continuation !== undefined) ||
      (state.capturedAfter !== undefined && !timestamp(state.capturedAfter))) throw Error("Invalid native capture session transfer state");
  return { ...session, codexNativeCapture: {
    version: state.version, ...(sourceHolds.length ? { sourceHolds } : {}), source: { sessionId: source.sessionId, cwd: source.cwd, createdAt: source.createdAt,
      source: source.source, relativePath: source.relativePath,
      ...(source.fork !== undefined ? { fork: validateCodexFork(source.fork, session.id) } : {}),
      ...(source.continuation !== undefined ? { continuation: validateCodexContinuation(source.continuation) } : {}) },
    initializedAt: state.initializedAt, status: "reconcile_required", indexPending: true,
    ...(state.captureCwd !== undefined ? { captureCwd: canonicalCodexCwd(state.captureCwd) } : {}),
    ...(state.capturedAfter !== undefined ? { capturedAfter: state.capturedAfter } : {}),
  } };
}

export function hasNativeCaptureState(data: Pick<ExportData, "sessions" | "observations" | "codexCaptureExclusions" | "graphObservationResults">) {
  return Boolean(data.codexCaptureExclusions?.length) || data.graphObservationResults !== undefined || data.sessions.some(session => session.codexNativeCapture !== undefined || session.semanticGraphCompletionVersion !== undefined) ||
    Object.values(data.observations).some(rows => rows.some(row => row.codexSource !== undefined));
}
