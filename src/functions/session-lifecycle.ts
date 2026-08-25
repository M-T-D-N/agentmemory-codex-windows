import type { Session } from "../types.js";

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
