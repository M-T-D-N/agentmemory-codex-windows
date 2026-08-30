import type { Session } from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";

export interface SessionStartInput {
  sessionId: string;
  project: string;
  cwd: string;
  title?: string;
  agentId?: string;
}

export type SessionStartResult =
  | { success: true; session: Session; reused: boolean }
  | { success: false; error: string };

export type SessionEndResult =
  | { success: true; session: Session }
  | { success: false; error: "session_not_found" | "session_invalid" };

export function sessionLifecycleLockKey(sessionId: string): string {
  return `mem:session-lifecycle:${sessionId}`;
}

function isCompleteSessionRecord(
  value: Session | null,
  sessionId: string,
): value is Session {
  return Boolean(
    value &&
      value.id === sessionId &&
      typeof value.project === "string" &&
      value.project.trim().length > 0 &&
      typeof value.cwd === "string" &&
      value.cwd.trim().length > 0 &&
      typeof value.startedAt === "string" &&
      value.startedAt.trim().length > 0 &&
      Number.isInteger(value.observationCount) &&
      value.observationCount >= 0 &&
      ["active", "completed", "abandoned"].includes(value.status),
  );
}

/**
 * Complete only an existing, well-formed session. iii's file KV materializes
 * state::update on a missing key, so the read and update must stay inside the
 * same in-process session lock shared with session start.
 */
export function completeExistingSession(
  kv: StateKV,
  sessionId: string,
  now = new Date().toISOString(),
): Promise<SessionEndResult> {
  return withKeyedLock(sessionLifecycleLockKey(sessionId), async () => {
    const existing = await kv.get<Session>(KV.sessions, sessionId);
    if (!existing) return { success: false, error: "session_not_found" };
    if (!isCompleteSessionRecord(existing, sessionId)) {
      return { success: false, error: "session_invalid" };
    }
    const session = await kv.update<Session>(KV.sessions, sessionId, [
      { type: "set", path: "endedAt", value: now },
      { type: "set", path: "updatedAt", value: now },
      { type: "set", path: "status", value: "completed" },
    ]);
    return { success: true, session };
  });
}

/**
 * Create or resume a session without ever changing its project identity.
 * A repeated start is idempotent for accumulated observations and capture
 * policy, while a completed session can become active again.
 */
export function prepareSessionStart(
  existing: Session | null,
  input: SessionStartInput,
  now = new Date().toISOString(),
): SessionStartResult {
  if (existing) {
    if (existing.project !== input.project) {
      return {
        success: false,
        error: `Session project mismatch: ${existing.project} != ${input.project}`,
      };
    }
    const { endedAt: _endedAt, ...resumable } = existing;
    return {
      success: true,
      reused: true,
      session: {
        ...resumable,
        status: "active",
        updatedAt: now,
      },
    };
  }

  const title = input.title?.trim();
  return {
    success: true,
    reused: false,
    session: {
      id: input.sessionId,
      project: input.project,
      cwd: input.cwd,
      startedAt: now,
      updatedAt: now,
      status: "active",
      observationCount: 0,
      ...(title ? { summary: title.slice(0, 200), firstPrompt: title.slice(0, 200) } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
    },
  };
}
