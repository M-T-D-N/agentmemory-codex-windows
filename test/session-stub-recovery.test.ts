import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/functions/search.js", () => ({
  indexRecords: vi.fn(async () => {}),
}));

import {
  recoverCodexSessionStubs,
  type SessionStubRecoveryCandidate,
} from "../src/functions/session-stub-recovery.js";
import { KV } from "../src/state/schema.js";
import { mockKV } from "./helpers/mocks.js";

const candidate: SessionStubRecoveryCandidate = {
  sessionId: "codex-session-1",
  project: "project-a",
  cwd: "C:/worktree/a",
  startedAt: "2026-01-01T00:00:00.000Z",
  observations: [
    {
      sourceItemId: "user-item-1",
      timestamp: "2026-01-01T00:01:00.000Z",
      kind: "prompt_submit",
      text: "  preserve this exact recovery contract  ",
    },
    {
      sourceItemId: "assistant-item-1",
      timestamp: "2026-01-01T00:02:00.000Z",
      kind: "assistant_response",
      text: "Implemented and verified the recovery contract.",
    },
  ],
};

describe("repair-codex-session-stubs migration", () => {
  let kv: ReturnType<typeof mockKV>;

  beforeEach(async () => {
    kv = mockKV();
    await kv.set(KV.sessions, candidate.sessionId, {
      endedAt: "2026-01-01T00:03:00.000Z",
      status: "completed",
    });
  });

  it("dry-runs an exact stub without writing session or observations", async () => {
    const before = await kv.get(KV.sessions, candidate.sessionId);

    const result = await recoverCodexSessionStubs(
      kv as never,
      [candidate],
      true,
    );

    expect(result).toMatchObject({
      dryRun: true,
      requested: 1,
      wouldRecover: 1,
      recovered: 0,
      conflicts: 0,
      observationsPlanned: 2,
      observationsWritten: 0,
    });
    expect(await kv.get(KV.sessions, candidate.sessionId)).toEqual(before);
    expect(await kv.list(KV.observations(candidate.sessionId))).toEqual([]);
  });

  it("repairs exact metadata and provenance, then becomes idempotent", async () => {
    const applied = await recoverCodexSessionStubs(
      kv as never,
      [candidate],
      false,
    );

    expect(applied).toMatchObject({
      dryRun: false,
      recovered: 1,
      alreadyRecovered: 0,
      observationsWritten: 2,
    });
    expect(await kv.get(KV.sessions, candidate.sessionId)).toEqual({
      id: candidate.sessionId,
      project: candidate.project,
      cwd: candidate.cwd,
      startedAt: candidate.startedAt,
      endedAt: "2026-01-01T00:03:00.000Z",
      status: "completed",
      observationCount: 2,
      tags: ["codex-task-recovery"],
      firstPrompt: "preserve this exact recovery contract",
    });
    const observations = await kv.list<Record<string, unknown>>(
      KV.observations(candidate.sessionId),
    );
    expect(observations).toHaveLength(2);
    expect(observations.map((observation) => observation.id)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^obs_/), expect.stringMatching(/^obs_/)]),
    );
    expect(observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: candidate.sessionId,
          narrative: "  preserve this exact recovery contract  ",
          origin: {
            channel: "import",
            detail: "codex-task-recovery:prompt_submit:user-item-1",
            capturedAt: "2026-01-01T00:01:00.000Z",
          },
        }),
        expect.objectContaining({
          sessionId: candidate.sessionId,
          title: "assistant_response",
          origin: {
            channel: "import",
            detail: "codex-task-recovery:assistant_response:assistant-item-1",
            capturedAt: "2026-01-01T00:02:00.000Z",
          },
        }),
      ]),
    );

    const repeated = await recoverCodexSessionStubs(
      kv as never,
      [candidate],
      false,
    );
    expect(repeated).toMatchObject({
      recovered: 0,
      alreadyRecovered: 1,
      observationsWritten: 0,
    });
    expect(await kv.list(KV.observations(candidate.sessionId))).toHaveLength(2);
  });

  it("leaves non-stub sessions and observation conflicts unchanged", async () => {
    await kv.set(KV.sessions, candidate.sessionId, {
      id: candidate.sessionId,
      project: "other-project",
      cwd: "C:/other",
      startedAt: "2025-12-31T00:00:00.000Z",
      status: "completed",
      observationCount: 7,
    });
    const before = await kv.get(KV.sessions, candidate.sessionId);

    const result = await recoverCodexSessionStubs(
      kv as never,
      [candidate],
      false,
    );

    expect(result).toMatchObject({ recovered: 0, conflicts: 1 });
    expect(await kv.get(KV.sessions, candidate.sessionId)).toEqual(before);
    expect(await kv.list(KV.observations(candidate.sessionId))).toEqual([]);
  });
});
