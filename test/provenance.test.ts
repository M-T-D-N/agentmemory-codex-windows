import { describe, expect, it } from "vitest";
import { validateObservationProvenance } from "../src/functions/provenance.js";
import type { CompressedObservation, Session } from "../src/types.js";

function mockKV(sessions: Session[], observations: CompressedObservation[]) {
  const sessionMap = new Map(sessions.map((session) => [session.id, session]));
  const observationMaps = new Map<string, Map<string, CompressedObservation>>();
  for (const observation of observations) {
    const scoped = observationMaps.get(observation.sessionId) ?? new Map();
    scoped.set(observation.id, observation);
    observationMaps.set(observation.sessionId, scoped);
  }
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      if (scope === "mem:sessions") return (sessionMap.get(key) as T) ?? null;
      if (scope.startsWith("mem:obs:")) {
        return (observationMaps.get(scope.slice("mem:obs:".length))?.get(key) as T) ?? null;
      }
      return null;
    },
    list: async <T>(scope: string): Promise<T[]> =>
      scope === "mem:sessions" ? ([...sessionMap.values()] as T[]) : [],
  };
}

function session(id: string, project = "project-a", excluded = false): Session {
  return {
    id,
    project,
    status: "completed",
    startedAt: "2026-08-12T00:00:00Z",
    observationCount: 1,
    filesModified: [],
    toolsUsed: [],
    ...(excluded
      ? { captureExcluded: true, captureExclusionReason: "internal" }
      : {}),
  };
}

function observation(
  id: string,
  sessionId: string,
  narrative = "normal user request",
): CompressedObservation {
  return {
    id,
    sessionId,
    type: "conversation",
    title: "prompt_submit",
    narrative,
    facts: [],
    concepts: [],
    files: [],
    tools: [],
    confidence: 1,
    importance: 0.5,
    timestamp: "2026-08-12T00:00:00Z",
  };
}

describe("official observation provenance", () => {
  it.each(["structured", "flat"])("resolves valid %s provenance", async (mode) => {
    const kv = mockKV([session("s1")], [observation("o1", "s1")]);
    const result = await validateObservationProvenance(kv as never, {
      project: "project-a",
      ...(mode === "structured"
        ? { sources: [{ sessionId: "s1", observationIds: ["o1"] }] }
        : { sourceObservationIds: ["o1"] }),
    });
    expect(result).toEqual({ sourceSessionIds: ["s1"], sourceObservationIds: ["o1"] });
  });

  it.each([
    ["wrong project", [session("s1", "project-b")], [observation("o1", "s1")]],
    ["excluded session", [session("s1", "project-a", true)], [observation("o1", "s1")]],
    [
      "ambient observation",
      [session("s1")],
      [observation("o1", "s1", "<agentmemory-ambient-ui-state>internal</agentmemory-ambient-ui-state>")],
    ],
    ["unknown observation", [session("s1")], []],
  ])("rejects %s for structured and flat provenance", async (_label, sessions, observations) => {
    const kv = mockKV(sessions, observations);
    await expect(
      validateObservationProvenance(kv as never, {
        project: "project-a",
        sources: [{ sessionId: "s1", observationIds: ["o1"] }],
      }),
    ).rejects.toThrow();
    await expect(
      validateObservationProvenance(kv as never, {
        project: "project-a",
        sourceObservationIds: ["o1"],
      }),
    ).rejects.toThrow();
  });

  it("enforces one aggregate observation limit", async () => {
    const ids = Array.from({ length: 501 }, (_, index) => `o${index}`);
    const kv = mockKV([session("s1")], ids.map((id) => observation(id, "s1")));
    await expect(
      validateObservationProvenance(kv as never, {
        project: "project-a",
        sources: [{ sessionId: "s1", observationIds: ids }],
      }),
    ).rejects.toThrow(/at most 500/);
  });
});
