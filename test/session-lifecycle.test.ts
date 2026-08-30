import { describe, expect, it } from "vitest";
import type { Session } from "../src/types.js";
import {
  completeExistingSession,
  prepareSessionStart,
  sessionLifecycleLockKey,
} from "../src/functions/session-lifecycle.js";
import { mockKV } from "./helpers/mocks.js";
import { withKeyedLock } from "../src/state/keyed-mutex.js";

const existing: Session = {
  id: "ses_1",
  project: "project-a",
  cwd: "C:/worktree/a",
  startedAt: "2026-01-01T00:00:00.000Z",
  endedAt: "2026-01-01T01:00:00.000Z",
  status: "completed",
  observationCount: 9,
  firstPrompt: "original prompt",
  captureExcluded: true,
  captureExclusionReason: "codex_internal",
  agentId: "agent-original",
};

describe("prepareSessionStart", () => {
  it("rejects reuse of a session id by another project", () => {
    expect(
      prepareSessionStart(existing, {
        sessionId: "ses_1",
        project: "project-b",
        cwd: "C:/worktree/b",
        agentId: "agent-other",
      }),
    ).toEqual({
      success: false,
      error: "Session project mismatch: project-a != project-b",
    });
  });

  it("resumes the same project without resetting data or capture policy", () => {
    const result = prepareSessionStart(
      existing,
      {
        sessionId: "ses_1",
        project: "project-a",
        cwd: "C:/different-linked-worktree",
        title: "replacement title",
        agentId: "agent-other",
      },
      "2026-01-02T00:00:00.000Z",
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.reused).toBe(true);
    expect(result.session).toMatchObject({
      project: "project-a",
      cwd: "C:/worktree/a",
      status: "active",
      observationCount: 9,
      firstPrompt: "original prompt",
      captureExcluded: true,
      captureExclusionReason: "codex_internal",
      agentId: "agent-original",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(result.session.endedAt).toBeUndefined();
  });

  it("creates a new scoped session with bounded title metadata", () => {
    const title = "x".repeat(300);
    const result = prepareSessionStart(
      null,
      {
        sessionId: "ses_new",
        project: "project-a",
        cwd: "C:/worktree/a",
        title,
        agentId: "agent-a",
      },
      "2026-01-02T00:00:00.000Z",
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.reused).toBe(false);
    expect(result.session.observationCount).toBe(0);
    expect(result.session.firstPrompt).toHaveLength(200);
    expect(result.session.summary).toHaveLength(200);
  });
});

describe("completeExistingSession", () => {
  it("does not materialize a row for an unknown session", async () => {
    const kv = mockKV();

    await expect(
      completeExistingSession(kv as never, "missing", "2026-01-02T00:00:00.000Z"),
    ).resolves.toEqual({ success: false, error: "session_not_found" });
    await expect(kv.get("mem:sessions", "missing")).resolves.toBeNull();
  });

  it("rejects the exact two-field legacy stub without changing it", async () => {
    const kv = mockKV();
    const stub = {
      endedAt: "2026-01-01T01:00:00.000Z",
      status: "completed",
    };
    await kv.set("mem:sessions", "legacy", stub);

    await expect(
      completeExistingSession(kv as never, "legacy", "2026-01-02T00:00:00.000Z"),
    ).resolves.toEqual({ success: false, error: "session_invalid" });
    await expect(kv.get("mem:sessions", "legacy")).resolves.toEqual(stub);
  });

  it("completes an existing session while preserving accumulated fields", async () => {
    const kv = mockKV();
    await kv.set("mem:sessions", existing.id, existing);

    const result = await completeExistingSession(
      kv as never,
      existing.id,
      "2026-01-02T00:00:00.000Z",
    );

    expect(result).toEqual({
      success: true,
      session: {
        ...existing,
        endedAt: "2026-01-02T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        status: "completed",
      },
    });
  });

  it("cannot recreate a session deleted by the same lifecycle lock", async () => {
    const kv = mockKV();
    await kv.set("mem:sessions", existing.id, existing);
    let releaseDelete!: () => void;
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const deletion = withKeyedLock(
      sessionLifecycleLockKey(existing.id),
      async () => {
        await deleteGate;
        await kv.delete("mem:sessions", existing.id);
      },
    );
    const completion = completeExistingSession(
      kv as never,
      existing.id,
      "2026-01-02T00:00:00.000Z",
    );

    releaseDelete();
    await deletion;
    await expect(completion).resolves.toEqual({
      success: false,
      error: "session_not_found",
    });
    await expect(kv.get("mem:sessions", existing.id)).resolves.toBeNull();
  });
});
