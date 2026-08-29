import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerApiTriggers } from "../src/triggers/api.js";
import { mockKV } from "./helpers/mocks.js";

type Handler = (data: unknown) => Promise<unknown>;
const readContext = vi.fn(async () => ({ context: "", blocks: 0, tokens: 0 }));

function apiSdk() {
  const functions = new Map<string, Handler>();
  const downstream: Array<{ functionId: string; payload: unknown }> = [];
  return {
    downstream,
    registerFunction: (idOrOpts: string | { id: string }, handler: Handler) => {
      functions.set(typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id, handler);
    },
    registerTrigger: vi.fn(),
    trigger: async (
      idOrInput: string | { function_id: string; payload: unknown },
      data?: unknown,
    ) => {
      const functionId =
        typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload =
        typeof idOrInput === "string" ? data : idOrInput.payload;
      const handler = functions.get(functionId);
      if (handler) return handler(payload);
      downstream.push({ functionId, payload });
      return { success: true };
    },
  };
}

describe("REST exact-project and provenance boundaries", () => {
  let sdk: ReturnType<typeof apiSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = apiSdk();
    kv = mockKV();
    readContext.mockClear();
    registerApiTriggers(sdk as never, kv as never, readContext);
  });

  it("calls context directly for REST context and session start", async () => {
    const context = (await sdk.trigger("api::context", {
      body: { sessionId: "session-context", project: "project-a" },
    })) as { status_code: number };
    const start = (await sdk.trigger("api::session::start", {
      body: {
        sessionId: "session-start",
        project: "project-a",
        cwd: "/project-a",
      },
    })) as { status_code: number };

    expect(context.status_code).toBe(200);
    expect(start.status_code).toBe(200);
    expect(readContext).toHaveBeenNthCalledWith(1, {
      sessionId: "session-context",
      project: "project-a",
    });
    expect(readContext).toHaveBeenNthCalledWith(2, {
      sessionId: "session-start",
      project: "project-a",
    });
    expect(sdk.downstream.map(({ functionId }) => functionId)).not.toContain(
      "mem::context",
    );
  });

  it.each([
    ["api::search", { body: { query: "memory" } }],
    ["api::smart-search", { body: { query: "memory" } }],
    ["api::lesson-list", { query_params: {} }],
    ["api::lesson-search", { body: { query: "lesson" } }],
  ])("rejects missing project at %s", async (functionId, request) => {
    const response = (await sdk.trigger(functionId, request)) as {
      status_code: number;
    };
    expect(response.status_code).toBe(400);
    expect(sdk.downstream).toEqual([]);
  });

  it("forwards exact project and deliberate wildcard reads", async () => {
    await sdk.trigger("api::search", {
      body: { query: "memory", project: "project-a" },
    });
    await sdk.trigger("api::lesson-search", {
      body: { query: "lesson", project: "*", limit: 3 },
    });
    expect(sdk.downstream).toEqual([
      expect.objectContaining({
        functionId: "mem::search",
        payload: expect.objectContaining({ project: "project-a" }),
      }),
      expect.objectContaining({
        functionId: "mem::lesson-recall",
        payload: expect.objectContaining({ project: "*", limit: 3 }),
      }),
    ]);
  });

  it("forwards only the exact physical graph purge contract", async () => {
    const response = (await sdk.trigger("api::graph-project-purge", {
      body: {
        project: "project-a",
        nodeIds: ["gn_a"],
        edgeIds: ["ge_a"],
        reason: "replace stale graph",
        force: true,
      },
      headers: {},
    })) as { status_code: number };

    expect(response.status_code).toBe(200);
    expect(sdk.downstream).toEqual([
      {
        functionId: "mem::graph-project-purge",
        payload: {
          project: "project-a",
          nodeIds: ["gn_a"],
          edgeIds: ["ge_a"],
          reason: "replace stale graph",
        },
      },
    ]);
  });

  it("rejects incomplete or unauthenticated physical graph purge requests", async () => {
    const incomplete = (await sdk.trigger("api::graph-project-purge", {
      body: { project: "project-a", reason: "missing inventories" },
      headers: {},
    })) as { status_code: number };
    expect(incomplete.status_code).toBe(400);
    expect(sdk.downstream).toEqual([]);

    const protectedSdk = apiSdk();
    registerApiTriggers(
      protectedSdk as never,
      mockKV() as never,
      readContext,
      "test-secret",
    );
    const unauthorized = (await protectedSdk.trigger("api::graph-project-purge", {
      body: {
        project: "project-a",
        nodeIds: [],
        edgeIds: [],
        reason: "replace stale graph",
      },
      headers: {},
    })) as { status_code: number };
    expect(unauthorized.status_code).toBe(401);
    expect(protectedSdk.downstream).toEqual([]);
  });

  it.each([
    { sourceIds: "obs_1" },
    { sources: { sessionId: "ses_1", observationIds: ["obs_1"] } },
  ])("rejects malformed lesson provenance without dispatch", async (malformed) => {
    const response = (await sdk.trigger("api::lesson-save", {
      body: { content: "verified lesson", project: "project-a", ...malformed },
    })) as { status_code: number };
    expect(response.status_code).toBe(400);
    expect(sdk.downstream).toEqual([]);
  });

  it("paginates exact-project visible sessions and observations", async () => {
    await kv.set("mem:sessions", "s1", {
      id: "s1",
      project: "project-a",
      cwd: "/a",
      startedAt: "2026-01-01T00:00:00Z",
      status: "completed",
      observationCount: 2,
    });
    await kv.set("mem:sessions", "s2", {
      id: "s2",
      project: "project-b",
      cwd: "/b",
      startedAt: "2026-01-02T00:00:00Z",
      status: "completed",
      observationCount: 0,
    });
    await kv.set("mem:sessions", "s3", {
      id: "s3",
      project: "project-a",
      cwd: "/a",
      startedAt: "2026-01-03T00:00:00Z",
      status: "completed",
      observationCount: 0,
      captureExcluded: true,
    });
    await kv.set("mem:obs:s1", "o1", {
      id: "o1",
      sessionId: "s1",
      timestamp: "2026-01-01T00:01:00Z",
      type: "conversation",
      title: "prompt_submit",
      facts: [],
      narrative: "normal user prompt",
      concepts: [],
      files: [],
      importance: 5,
    });
    await kv.set("mem:obs:s1", "o2", {
      id: "o2",
      sessionId: "s1",
      timestamp: "2026-01-01T00:02:00Z",
      type: "other",
      title: "assistant_response",
      facts: [],
      narrative: '<x source="ambient-ui-state">internal</x>',
      concepts: [],
      files: [],
      importance: 1,
    });

    const sessions = (await sdk.trigger("api::sessions", {
      query_params: { project: "project-a", limit: "1", offset: "0" },
    })) as { status_code: number; body: { sessions: Array<{ id: string }>; total: number } };
    expect(sessions.status_code).toBe(200);
    expect(sessions.body.total).toBe(1);
    expect(sessions.body.sessions.map((session) => session.id)).toEqual(["s1"]);

    const sessionsWithExcluded = (await sdk.trigger("api::sessions", {
      query_params: {
        project: "project-a",
        sessionId: "s3",
        includeExcluded: "true",
        limit: "1",
      },
    })) as {
      status_code: number;
      body: { sessions: Array<{ id: string }>; total: number };
    };
    expect(sessionsWithExcluded.status_code).toBe(200);
    expect(sessionsWithExcluded.body.total).toBe(1);
    expect(sessionsWithExcluded.body.sessions.map((session) => session.id)).toEqual([
      "s3",
    ]);

    const wildcardWithExcluded = (await sdk.trigger("api::sessions", {
      query_params: { project: "*", includeExcluded: "true" },
    })) as { status_code: number };
    expect(wildcardWithExcluded.status_code).toBe(400);

    const missingSessionIdWithExcluded = (await sdk.trigger("api::sessions", {
      query_params: { project: "project-a", includeExcluded: "true" },
    })) as { status_code: number };
    expect(missingSessionIdWithExcluded.status_code).toBe(400);

    const observations = (await sdk.trigger("api::observations", {
      query_params: { sessionId: "s1", project: "project-a", limit: "10" },
    })) as { status_code: number; body: { observations: Array<{ id: string }>; total: number } };
    expect(observations.status_code).toBe(200);
    expect(observations.body.total).toBe(1);
    expect(observations.body.observations.map((observation) => observation.id)).toEqual(["o1"]);
  });

  it("keeps legacy rows with missing sort timestamps readable", async () => {
    await kv.set("mem:sessions", "legacy-session", {
      id: "legacy-session",
      project: "project-a",
      cwd: "/a",
      status: "completed",
      observationCount: 1,
    } as never);
    await kv.set("mem:obs:legacy-session", "legacy-observation", {
      id: "legacy-observation",
      sessionId: "legacy-session",
      type: "conversation",
      title: "prompt_submit",
      facts: [],
      narrative: "legacy normal user prompt",
      concepts: [],
      files: [],
      importance: 5,
    } as never);

    const sessions = (await sdk.trigger("api::sessions", {
      query_params: { project: "project-a" },
    })) as { status_code: number; body: { sessions: Array<{ id: string }> } };
    const observations = (await sdk.trigger("api::observations", {
      query_params: { sessionId: "legacy-session", project: "project-a" },
    })) as { status_code: number; body: { observations: Array<{ id: string }> } };

    expect(sessions.status_code).toBe(200);
    expect(sessions.body.sessions.map((session) => session.id)).toEqual(["legacy-session"]);
    expect(observations.status_code).toBe(200);
    expect(observations.body.observations.map((observation) => observation.id)).toEqual([
      "legacy-observation",
    ]);
  });

  it("keeps excluded sessions out of commit views and graph derivation", async () => {
    const baseSession = {
      project: "project-a",
      cwd: "/a",
      startedAt: "2026-01-01T00:00:00Z",
      status: "completed",
      observationCount: 1,
    };
    await kv.set("mem:sessions", "visible-session", {
      ...baseSession,
      id: "visible-session",
    });
    await kv.set("mem:sessions", "internal-session", {
      ...baseSession,
      id: "internal-session",
      captureExcluded: true,
    });
    await kv.set("mem:commits", "abc123", {
      sha: "abc123",
      sessionIds: ["visible-session", "internal-session"],
      linkedAt: "2026-01-01T00:10:00Z",
    });
    const baseObservation = {
      timestamp: "2026-01-01T00:01:00Z",
      type: "discovery",
      facts: [],
      concepts: [],
      files: [],
      importance: 5,
    };
    await kv.set("mem:obs:visible-session", "visible-observation", {
      ...baseObservation,
      id: "visible-observation",
      sessionId: "visible-session",
      title: "visible observation",
      narrative: "visible",
    });
    await kv.set("mem:obs:internal-session", "internal-observation", {
      ...baseObservation,
      id: "internal-observation",
      sessionId: "internal-session",
      title: "internal observation",
      narrative: "internal",
    });

    const lookup = (await sdk.trigger("api::session::by-commit", {
      query_params: { sha: "abc123" },
    })) as {
      body: {
        commit: { sessionIds: string[] };
        sessions: Array<{ id: string }>;
      };
    };
    const commits = (await sdk.trigger("api::commits", {
      query_params: {},
    })) as { body: { commits: Array<{ sessionIds: string[] }> } };
    const graphBuild = (await sdk.trigger("api::graph-build", {
      body: { batchSize: 25 },
    })) as { body: { sessions: number; batches: number } };

    expect(lookup.body.commit.sessionIds).toEqual(["visible-session"]);
    expect(lookup.body.sessions.map((session) => session.id)).toEqual([
      "visible-session",
    ]);
    expect(commits.body.commits[0].sessionIds).toEqual(["visible-session"]);
    expect(graphBuild.body.sessions).toBe(1);
    expect(graphBuild.body.batches).toBe(1);
    expect(sdk.downstream).toEqual([
      {
        functionId: "mem::graph-extract",
        payload: {
          project: "project-a",
          sessionId: "visible-session",
          observations: [expect.objectContaining({ id: "visible-observation" })],
        },
      },
    ]);
  });

  it("does not let an internal prompt exclude a session that already has normal capture", async () => {
    await kv.set("mem:sessions", "session-excluded", {
      id: "session-excluded",
      project: "project-a",
      cwd: "/a",
      startedAt: "2026-01-01T00:00:00Z",
      status: "active",
      observationCount: 7,
    });

    const response = (await sdk.trigger("api::session::exclude", {
      body: {
        sessionId: "session-excluded",
        project: "project-a",
        cwd: "/a",
        reason: `codex_internal_${"x".repeat(200)}`,
      },
    })) as { status_code: number; body: { success: boolean } };
    const session = await kv.get<Record<string, unknown>>(
      "mem:sessions",
      "session-excluded",
    );
    const auditRows = await kv.list<Record<string, unknown>>("mem:audit");

    expect(response.status_code).toBe(200);
    expect(response.body.success).toBe(true);
    expect(session).toMatchObject({
      status: "active",
      observationCount: 7,
    });
    expect(session?.captureExcluded).toBeUndefined();
    expect(auditRows).toEqual([]);
    expect(response.body).toMatchObject({
      captureExcluded: false,
      preservedActiveSession: true,
    });
  });

  it("excludes an exact owned session before any normal capture", async () => {
    await kv.set("mem:sessions", "session-internal-only", {
      id: "session-internal-only",
      project: "project-a",
      cwd: "/a",
      startedAt: "2026-01-01T00:00:00Z",
      status: "active",
      observationCount: 0,
    });

    const response = (await sdk.trigger("api::session::exclude", {
      body: {
        sessionId: "session-internal-only",
        project: "project-a",
        cwd: "/a",
        reason: `codex_internal_${"x".repeat(200)}`,
      },
    })) as { status_code: number; body: { success: boolean } };
    const session = await kv.get<Record<string, unknown>>(
      "mem:sessions",
      "session-internal-only",
    );
    const auditRows = await kv.list<Record<string, unknown>>("mem:audit");

    expect(response.status_code).toBe(200);
    expect(response.body.success).toBe(true);
    expect(session).toMatchObject({ captureExcluded: true });
    expect(String(session?.captureExclusionReason)).toHaveLength(128);
    expect(auditRows).toEqual([
      expect.objectContaining({
        operation: "session_exclude",
        functionId: "api::session::exclude",
        targetIds: ["session-internal-only"],
      }),
    ]);
  });

  it("rejects unauthenticated session exclusion when an API secret is configured", async () => {
    const protectedSdk = apiSdk();
    const protectedKv = mockKV();
    registerApiTriggers(
      protectedSdk as never,
      protectedKv as never,
      readContext,
      "test-secret",
    );
    await protectedKv.set("mem:sessions", "session-protected", {
      id: "session-protected",
      project: "project-a",
      cwd: "/a",
      startedAt: "2026-01-01T00:00:00Z",
      status: "active",
      observationCount: 0,
    });

    const middlewareResponse = (await protectedSdk.trigger(
      "middleware::api-auth",
      { request: { headers: {} } },
    )) as { action: string; response: { status_code: number } };
    const session = await protectedKv.get<Record<string, unknown>>(
      "mem:sessions",
      "session-protected",
    );
    const excludeTrigger = protectedSdk.registerTrigger.mock.calls
      .map(([trigger]) => trigger as {
        function_id?: string;
        config?: { middleware_function_ids?: string[] };
      })
      .find((trigger) => trigger.function_id === "api::session::exclude");

    expect(middlewareResponse).toMatchObject({
      action: "respond",
      response: { status_code: 401 },
    });
    expect(excludeTrigger?.config?.middleware_function_ids).toEqual([
      "middleware::api-auth",
    ]);
    expect(session?.captureExcluded).toBeUndefined();
  });

  it.each([
    ["missing", { sessionId: "unknown", project: "project-a", cwd: "/a", reason: "internal" }, 404],
    ["project mismatch", { sessionId: "session-owned", project: "project-b", cwd: "/a", reason: "internal" }, 409],
    ["cwd mismatch", { sessionId: "session-owned", project: "project-a", cwd: "/b", reason: "internal" }, 409],
  ])("rejects session exclusion for %s", async (_case, body, statusCode) => {
    await kv.set("mem:sessions", "session-owned", {
      id: "session-owned",
      project: "project-a",
      cwd: "/a",
      startedAt: "2026-01-01T00:00:00Z",
      status: "active",
      observationCount: 0,
    });

    const response = (await sdk.trigger("api::session::exclude", { body })) as {
      status_code: number;
    };
    const session = await kv.get<Record<string, unknown>>("mem:sessions", "session-owned");

    expect(response.status_code).toBe(statusCode);
    expect(session?.captureExcluded).toBeUndefined();
  });
});
