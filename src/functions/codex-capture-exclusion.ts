import { createHash } from "node:crypto";
import { assertCompleteCodexDuplicateForget } from "../replay/codex-duplicate-match.js";
import type { CodexCaptureExclusion, CompressedObservation, ExportData, Session, SessionSummary } from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { recordAudit } from "./audit.js";
import { codexSessionForTransfer } from "../replay/codex-capture-state.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const exact = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512 && value === value.trim() && value !== "*";
export const codexExclusionId = (sessionId: string, observationId?: string) =>
  hash(JSON.stringify(["codex-forget-v1", sessionId, observationId ?? null]));

export function validateCodexExclusion(value: unknown): CodexCaptureExclusion {
  const row = value as CodexCaptureExclusion | null;
  if (!row || typeof row !== "object" || row.version !== 1 || !exact(row.sessionId) || !exact(row.project) ||
      typeof row.forgottenAt !== "string" || !Number.isFinite(Date.parse(row.forgottenAt)) || (row.observationId !== undefined && !exact(row.observationId)) ||
      row.id !== codexExclusionId(row.sessionId, row.observationId) || !row.match ||
      Object.keys(row).some(key => !["version", "id", "sessionId", "project", "forgottenAt", "observationId", "match"].includes(key))) {
    throw Error("Invalid Codex capture exclusion");
  }
  const match = row.match;
  const keys = Object.keys(match).sort().join(",");
  if (match.kind === "session" ? keys !== "kind" || row.observationId !== undefined
    : !row.observationId || (match.kind === "source" ? keys !== "kind,sourceKey" || !/^[a-f0-9]{64}$/.test(match.sourceKey)
    : match.kind === "legacy" ? keys !== "kind,messageKind,textDigest,timestamp" || !["user", "assistant_final"].includes(match.messageKind) ||
      typeof match.timestamp !== "string" || !Number.isFinite(Date.parse(match.timestamp)) || !/^[a-f0-9]{64}$/.test(match.textDigest)
    : match.kind !== "unresolved" || keys !== "kind")) throw Error("Invalid Codex capture exclusion match");
  return structuredClone(row);
}

const identity = (row: CodexCaptureExclusion) => JSON.stringify([row.sessionId, row.project, row.observationId ?? null,
  row.match.kind, row.match.kind === "source" ? row.match.sourceKey : row.match.kind === "legacy"
    ? [row.match.messageKind, row.match.timestamp, row.match.textDigest] : null]);

export function assertCodexExclusionContent(data: ExportData, exclusions: Iterable<CodexCaptureExclusion>) {
  for (const row of exclusions) {
    const session = data.sessions.find(session => session.id === row.sessionId);
    const observations = data.observations[row.sessionId] ?? [];
    if (session && session.project !== row.project) throw Error("Data session conflicts with Codex exclusion project");
    let resumed = false;
    if (row.match.kind === "session" && session?.codexNativeCapture?.capturedAfter && !session.firstPrompt && !session.summary) {
      const normalized = codexSessionForTransfer(session);
      resumed = Date.parse(normalized.codexNativeCapture!.capturedAfter!) >= Date.parse(row.forgottenAt);
    }
    const oldObservations = observations.some(observation => observation.sessionId !== row.sessionId ||
      (observation.project !== undefined && observation.project !== row.project) ||
      !Number.isFinite(Date.parse(observation.codexSource?.timestamp ?? observation.timestamp)) ||
      Date.parse(observation.codexSource?.timestamp ?? observation.timestamp) <= Date.parse(row.forgottenAt));
    if (row.match.kind === "session" ? (Boolean(session) || observations.length > 0) && (!resumed || oldObservations) ||
      data.summaries.some(summary => summary.sessionId === row.sessionId)
      : observations.some(observation => observation.id === row.observationId ||
        (row.match.kind === "source" && observation.codexSource?.key === row.match.sourceKey))) {
      throw Error("Data would restore forgotten Codex capture; explicit source lifecycle recovery is required");
    }
  }
}

export async function prepareCodexExclusionImport(kv: StateKV, data: ExportData) {
  if (data.codexCaptureExclusions !== undefined && (!Array.isArray(data.codexCaptureExclusions) || data.codexCaptureExclusions.length > 100_000)) {
    throw Error("codexCaptureExclusions must be an array of at most 100000 entries");
  }
  const existing = (await kv.list<CodexCaptureExclusion>(KV.codexCaptureExclusions)).map(validateCodexExclusion);
  const incoming = (data.codexCaptureExclusions ?? []).map(validateCodexExclusion);
  const merged = new Map(existing.map(row => [row.id, row]));
  const pending: CodexCaptureExclusion[] = [];
  for (const row of incoming) {
    const previous = merged.get(row.id);
    if (previous && identity(previous) !== identity(row)) throw Error("Conflicting imported Codex capture exclusion");
    if (!previous || (row.match.kind === "session" && Date.parse(row.forgottenAt) > Date.parse(previous.forgottenAt))) {
      merged.set(row.id, row); pending.push(row);
    }
  }
  const validationSessions = new Map(data.sessions.map(session => [session.id, session]));
  for (const row of merged.values()) if (row.match.kind === "session" && data.observations[row.sessionId]?.length && !validationSessions.has(row.sessionId)) {
    const current = await kv.get<Session>(KV.sessions, row.sessionId);
    if (current) validationSessions.set(current.id, current);
  }
  assertCodexExclusionContent({ ...data, sessions: [...validationSessions.values()] }, merged.values());
  const checked = new Map<string, CompressedObservation[]>();
  for (const row of pending) {
    const current = await kv.get<Session>(KV.sessions, row.sessionId);
    if (current && current.project !== row.project) throw Error("Imported exclusion conflicts with a surviving canonical session");
    let observations = checked.get(row.sessionId);
    if (!observations) {
      observations = await kv.list(KV.observations(row.sessionId), { includeDeleted: true });
      checked.set(row.sessionId, observations);
    }
    if (row.match.kind === "session") {
      const summary = await kv.get<SessionSummary>(KV.summaries, row.sessionId);
      try { assertCodexExclusionContent({ ...data, sessions: current ? [current] : [],
        observations: { [row.sessionId]: observations }, summaries: summary ? [summary] : [] }, [row]); }
      catch { throw Error("Imported exclusion conflicts with a surviving canonical session or observations"); }
    } else if (observations.some(observation =>
      observation.id === row.observationId || (row.match.kind === "source" && observation.codexSource?.key === row.match.sourceKey))) {
      throw Error("Imported exclusion conflicts with surviving canonical observations");
    }
  }
  return pending;
}

export async function retainCodexForgetExclusions(
  kv: StateKV, session: Session, observations: Array<{ id: string; [key: string]: unknown }>, wholeSession: boolean,
) {
  if (!wholeSession && session.codexNativeCapture?.unresolvedCaptures?.some(item => observations.some(row => row.id === item.observationId))) {
    throw Error("Unresolved legacy capture must be reconciled before individual forget");
  }
  const managed = Boolean(session.codexNativeCapture) || Boolean(process.env.AGENTMEMORY_CODEX_SOURCE_ROOT) || Boolean(session.codexAgentReconciliation) ||
    observations.some(row => row.codexSource !== undefined);
  if (!managed) return;
  if (!exact(session.id) || !exact(session.project)) throw Error("Codex forget requires canonical session and project identities");
  if (!wholeSession) assertCompleteCodexDuplicateForget(await kv.list(KV.observations(session.id)), new Set(observations.map(row => row.id)));
  const forgottenAt = new Date().toISOString();
  const exclusions: CodexCaptureExclusion[] = [];
  if (wholeSession) exclusions.push({ version: 1, id: codexExclusionId(session.id), sessionId: session.id,
    project: session.project, forgottenAt, match: { kind: "session" } });
  for (const row of observations) {
    const origin = row.origin as { channel?: string; detail?: string } | undefined;
    const messageKind = row.title === "prompt_submit" || row.hookType === "prompt_submit" || (row.type === "conversation" && origin?.channel === "user") ? "user"
      : row.title === "assistant_response" || row.toolName === "assistant_response" || origin?.detail === "assistant_response" ? "assistant_final" : null;
    const source = row.codexSource as { key?: unknown } | undefined;
    if (!source && !messageKind) continue;
    if (!exact(row.id) || row.sessionId !== session.id) throw Error("Codex forget observation scope does not match");
    const text = row.narrative ?? (messageKind === "user" ? row.userPrompt : row.assistantResponse);
    const match: CodexCaptureExclusion["match"] = source && typeof source.key === "string" && /^[a-f0-9]{64}$/.test(source.key)
      ? { kind: "source", sourceKey: source.key }
      : messageKind && typeof text === "string" && typeof row.timestamp === "string" && Number.isFinite(Date.parse(row.timestamp))
        ? { kind: "legacy", messageKind, timestamp: row.timestamp, textDigest: hash(text) }
        : { kind: "unresolved" };
    exclusions.push({ version: 1, id: codexExclusionId(session.id, row.id), sessionId: session.id,
      project: session.project, observationId: row.id, forgottenAt, match });
  }
  const writes: CodexCaptureExclusion[] = [];
  for (const row of exclusions) {
    const existing = await kv.get<CodexCaptureExclusion>(KV.codexCaptureExclusions, row.id);
    if (existing) {
      const prior = validateCodexExclusion(existing);
      if (identity(prior) !== identity(row)) throw Error("Conflicting Codex forget source identity");
      if (row.match.kind === "session" && Date.parse(row.forgottenAt) > Date.parse(prior.forgottenAt)) {
        writes.push(row);
      }
    } else writes.push(row);
  }
  if (!writes.length) return;
  await recordAudit(kv, "forget", "mem::forget", writes.map(row => row.observationId ?? row.sessionId), {
    phase: "retain-capture-exclusions", sessionId: session.id, project: session.project, wholeSession,
  });
  for (const row of writes) await kv.set(KV.codexCaptureExclusions, row.id, row);
}
