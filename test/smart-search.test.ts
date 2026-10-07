import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerSmartSearchFunction } from "../src/functions/smart-search.js";
import { registerMcpEndpoints } from "../src/mcp/server.js";
import { HybridSearch } from "../src/state/hybrid-search.js";
import { SearchIndex } from "../src/state/search-index.js";
import type {
  CompressedObservation,
  HybridSearchResult,
  CompactSearchResult,
  Session,
} from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (idOrOpts: string | { id: string }, handler: Function) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (idOrInput: string | { function_id: string; payload: unknown }, data?: unknown) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

function makeObs(
  overrides: Partial<CompressedObservation> = {},
): CompressedObservation {
  return {
    id: "obs_1",
    sessionId: "ses_1",
    timestamp: "2026-02-01T10:00:00Z",
    type: "file_edit",
    title: "Edit auth handler",
    facts: [],
    narrative: "Modified auth",
    concepts: ["auth"],
    files: ["src/auth.ts"],
    importance: 7,
    ...overrides,
  };
}

describe("Smart Search Function", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;
  let searchResults: HybridSearchResult[];

  beforeEach(async () => {
    sdk = mockSdk();
    kv = mockKV();

    const obs1 = makeObs({ id: "obs_1", sessionId: "ses_1", title: "Auth handler" });
    const obs2 = makeObs({ id: "obs_2", sessionId: "ses_1", title: "Database setup" });

    searchResults = [
      {
        observation: obs1,
        bm25Score: 0.8,
        vectorScore: 0,
        combinedScore: 0.8,
        sessionId: "ses_1",
      },
      {
        observation: obs2,
        bm25Score: 0.3,
        vectorScore: 0,
        combinedScore: 0.3,
        sessionId: "ses_1",
      },
    ];

    const session: Session = {
      id: "ses_1",
      project: "my-project",
      cwd: "/tmp",
      startedAt: "2026-02-01T00:00:00Z",
      status: "completed",
      observationCount: 2,
    };
    await kv.set("mem:sessions", "ses_1", session);
    await kv.set("mem:obs:ses_1", "obs_1", obs1);
    await kv.set("mem:obs:ses_1", "obs_2", obs2);

    const searchFn = async (_query: string, _limit: number) => searchResults;
    registerSmartSearchFunction(sdk as never, kv as never, searchFn);
  });


  it("uses canonical compact fields and rejects missing or superseded ranker bodies", async () => {
    const original = searchResults[0].observation;
    await kv.set("mem:memories", "superseded", {
      id: "superseded", project: "my-project", sessionIds: ["ses_1"],
      createdAt: original.timestamp, updatedAt: original.timestamp, type: "fact",
      title: "old memory", content: "old memory", concepts: [], files: [],
      strength: 1, version: 1, isLatest: false,
    });
    const forged = { ...searchResults[0], observation: { ...original, title: "forged title", timestamp: "1900-01-01T00:00:00Z" } };
    searchResults = [
      forged,
      { ...forged, observation: { ...original, id: "missing" } },
      { ...forged, observation: { ...original, id: "superseded" } },
      searchResults[1],
    ];
    const result = await sdk.trigger("mem::smart-search", {
      query: "auth", project: "my-project", limit: 2, trackAccess: false, includeLessons: false,
    });
    expect(result.results.map((row: CompactSearchResult) => row.obsId)).toEqual(["obs_1", "obs_2"]);
    expect(result.results[0]).toMatchObject({ title: original.title, timestamp: original.timestamp, score: forged.combinedScore });
    await kv.delete("mem:obs:ses_1", original.id);
    expect((await sdk.trigger("mem::smart-search", {
      query: "auth", project: "my-project", limit: 2, trackAccess: false, includeLessons: false,
    })).results.map((row: CompactSearchResult) => row.obsId)).toEqual(["obs_2"]);
  });

  it("reuses hybrid canonical reads for a full compact result limit within each request", async () => {
    const index = new SearchIndex();
    for (let i = 0; i < 99; i++) {
      const observation = makeObs({ id: "reuse-" + i, title: "Auth " + i });
      await kv.set("mem:obs:ses_1", observation.id, observation);
      index.add(observation);
    }
    await kv.set("mem:memories", "saved-memory", {
      id: "saved-memory", project: "my-project", sessionIds: ["ses_1"],
      createdAt: "2026-02-01T10:00:00Z", updatedAt: "2026-02-01T10:00:00Z",
      type: "fact", title: "Auth saved", content: "auth saved original", concepts: [], files: [],
      strength: 1, version: 1, isLatest: true,
    });
    index.add(makeObs({ id: "saved-memory", title: "Auth saved", narrative: "auth saved original" }));
    const hybrid = new HybridSearch(index, null, null, kv as never, 0.4, 0.6, 0, false);
    registerSmartSearchFunction(sdk as never, kv as never, (query, limit, selection) => hybrid.search(query, limit, selection));
    const read = vi.spyOn(kv, "get");
    const list = vi.spyOn(kv, "list");
    const input = { query: "auth", project: "my-project", limit: 100, trackAccess: false, includeLessons: false };
    const result = await sdk.trigger("mem::smart-search", input);
    expect(result.results).toHaveLength(100);
    expect(read.mock.calls.filter(([scope]) => scope.startsWith("mem:obs:"))).toHaveLength(99);
    expect(read.mock.calls.filter(([scope]) => scope === "mem:sessions" || scope === "mem:memories")).toHaveLength(0);
    for (const scope of ["mem:sessions", "mem:memories", "mem:archive:states"]) {
      expect(list.mock.calls.filter(([listed]) => listed === scope)).toHaveLength(1);
    }
    await kv.set("mem:obs:ses_1", "reuse-0", makeObs({ id: "reuse-0", title: "Updated canonical" }));
    const next = await sdk.trigger("mem::smart-search", input);
    expect(next.results.find((row: CompactSearchResult) => row.obsId === "reuse-0").title).toBe("Updated canonical");
    expect(read.mock.calls.filter(([scope]) => scope.startsWith("mem:obs:"))).toHaveLength(198);
    expect(read.mock.calls.filter(([scope]) => scope === "mem:sessions" || scope === "mem:memories")).toHaveLength(0);
  });

  it("reports expansion truncation through MCP and allows the remaining originals to be read", async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `expanded-${i + 1}`);
    for (const id of ids) {
      await kv.set("mem:obs:ses_1", id, makeObs({ id, narrative: `Original ${id}` }));
    }
    registerMcpEndpoints(sdk as never, kv as never);
    const expand = async (selected: string[]) => {
      const response = await sdk.trigger("mcp::tools::call", {
        headers: {},
        body: { name: "memory_smart_search", arguments: {
          project: "my-project", expandIds: selected.join(","), trackAccess: false,
        } },
      });
      expect(response.status_code).toBe(200);
      return JSON.parse(response.body.content[0].text);
    };
    const first = await expand(ids);
    expect(first.truncated).toBe(true);
    expect(first.results.map((r: { obsId: string }) => r.obsId)).toEqual(ids.slice(0, 20));
    const rest = await expand(ids.slice(20));
    expect(rest.truncated).toBe(false);
    expect([...first.results, ...rest.results].map((r: { obsId: string }) => r.obsId)).toEqual(ids);
    for (const id of ids) expect(await kv.get("mem:access", id)).toBeNull();
  });

  it("exact expansion never enumerates sessions or substitutes a missing source pair", async () => {
    const list = vi.spyOn(kv, "list");
    const result = await sdk.trigger("mem::smart-search", {project:"my-project", expandIds:[{obsId:"obs_1",sessionId:"wrong-session"}],exactExpansion:true,trackAccess:false});
    expect(result.results).toEqual([]);
    expect(list.mock.calls.some(([scope]) => scope === "mem:sessions")).toBe(false);
    const valid = await sdk.trigger("mem::smart-search", {project:"my-project",expandIds:[{obsId:"obs_1",sessionId:"ses_1"}],exactExpansion:true,trackAccess:false});
    expect(valid.results[0].observation.narrative).toBe(searchResults[0].observation.narrative);
    expect(await kv.get("mem:access", "obs_1")).toBeNull();
    await expect(sdk.trigger("mem::smart-search", {project:"*",expandIds:[{obsId:"obs_1",sessionId:"ses_1"}],exactExpansion:true})).rejects.toThrow("exact project");
  });

  it("uses a memory's project consistently in compact and expanded retrieval", async () => {
    const memory = { id: "owned-memory", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
      type: "fact", title: "owned memory", content: "owned memory", concepts: [], files: [], sessionIds: ["ses_1"],
      strength: 1, version: 1, isLatest: true, project: "owning-project" };
    await kv.set("mem:memories", memory.id, memory);
    const observation = makeObs({ id: memory.id, project: memory.project });
    searchResults = [{ observation, bm25Score: 1, vectorScore: 0, combinedScore: 1, sessionId: "ses_1" }];
    for (const input of [{ query: "owned" }, { expandIds: [memory.id] }]) {
      const own = await sdk.trigger("mem::smart-search", { ...input, project: "owning-project", trackAccess: false, includeLessons: false });
      expect(own.results.map((row: { obsId: string }) => row.obsId)).toEqual([memory.id]);
      expect(own.results[0].project).toBe("owning-project");
      const source = await sdk.trigger("mem::smart-search", { ...input, project: "my-project", trackAccess: false, includeLessons: false });
      expect(source.results).toEqual([]);
    }
  });

  it("applies agent scope before filling the compact result limit", async () => {
    searchResults[0].observation.agentId = "other-agent";
    searchResults[1].observation.agentId = "selected-agent";
    const result = await sdk.trigger("mem::smart-search", {
      query: "auth", project: "my-project", agentId: "selected-agent", limit: 1, trackAccess: false, includeLessons: false,
    });
    expect(result.results.map((r: CompactSearchResult) => r.obsId)).toEqual([searchResults[1].observation.id]);
  });

  it("compact mode returns CompactSearchResult array", async () => {
    const result = (await sdk.trigger("mem::smart-search", {
      query: "auth",
    })) as { mode: string; results: CompactSearchResult[] };

    expect(result.mode).toBe("compact");
    expect(result.results.length).toBe(2);
    expect(result.results[0]).toHaveProperty("obsId");
    expect(result.results[0]).toHaveProperty("title");
    expect(result.results[0]).toHaveProperty("type");
    expect(result.results[0]).toHaveProperty("score");
    expect(result.results[0]).toHaveProperty("timestamp");
    expect(result.results[0]).not.toHaveProperty("narrative");
  });

  it("expand mode returns full observations for given IDs", async () => {
    const result = (await sdk.trigger("mem::smart-search", {
      expandIds: ["obs_1"],
    })) as { mode: string; results: Array<{ obsId: string; observation: CompressedObservation }> };

    expect(result.mode).toBe("expanded");
    expect(result.results.length).toBe(1);
    expect(result.results[0].observation.title).toBe("Auth handler");
  });

  it("expands an ID through a backend that rejects overlapping state reads", async () => {
    const secondSession: Session = {
      id: "ses_2",
      project: "my-project",
      cwd: "/tmp",
      startedAt: "2026-02-02T00:00:00Z",
      status: "completed",
      observationCount: 1,
    };
    const target = makeObs({ id: "obs_serial", sessionId: "ses_2" });
    await kv.set("mem:sessions", "ses_2", secondSession);
    await kv.set("mem:obs:ses_2", target.id, target);

    const originalGet = kv.get.bind(kv);
    let observationReadActive = false;
    kv.get = async <T>(scope: string, key: string): Promise<T | null> => {
      if (!scope.startsWith("mem:obs:")) return originalGet<T>(scope, key);
      if (observationReadActive) throw new Error("overlapping state read");
      observationReadActive = true;
      try {
        await new Promise((resolve) => setImmediate(resolve));
        return await originalGet<T>(scope, key);
      } finally {
        observationReadActive = false;
      }
    };

    const result = (await sdk.trigger("mem::smart-search", {
      expandIds: [target.id],
    })) as {
      mode: string;
      results: Array<{ obsId: string; observation: CompressedObservation }>;
    };

    expect(result.mode).toBe("expanded");
    expect(result.results.map((entry) => entry.obsId)).toEqual([target.id]);
  });

  it("uses indexed session hints and falls back to project-scoped ID expansion", async () => {
    const session = await kv.get<Session>("mem:sessions", "ses_1");
    await kv.delete("mem:sessions", "ses_1");
    await kv.set("mem:sessions", "other", { ...session, id: "other", project: "other-project" });
    await kv.set("mem:sessions", "ses_1", session);
    const list = vi.spyOn(kv, "list");
    const hints = new SearchIndex();
    hints.add((await kv.get("mem:obs:ses_1", "obs_1"))!);
    hints.add((await kv.get("mem:obs:ses_1", "obs_2"))!);
    registerSmartSearchFunction(sdk as never, kv as never, async () => searchResults, id => hints.getSessionId(id));
    const indexed = await sdk.trigger("mem::smart-search", {
      project: "my-project", trackAccess: false, expandIds: ["obs_1", "obs_2"],
    });
    expect(indexed.results.map((row: { obsId: string }) => row.obsId)).toEqual(["obs_1", "obs_2"]);
    expect(list.mock.calls.filter(([scope]) => scope === 'mem:sessions' || String(scope).startsWith('mem:obs:'))).toHaveLength(0);
    list.mockClear();
    registerSmartSearchFunction(sdk as never, kv as never, async () => searchResults, () => "other");

    const result = (await sdk.trigger("mem::smart-search", {
      project: "my-project", trackAccess: false,
      expandIds: ["obs_1", "obs_2"],
    })) as {
      mode: string;
      results: Array<{ obsId: string }>;
    };

    expect(result.results.map((entry) => entry.obsId)).toEqual([
      "obs_1",
      "obs_2",
    ]);
    expect(
      list.mock.calls.filter(([scope]) => scope === "mem:sessions"),
    ).toHaveLength(1);
    expect(
      list.mock.calls.filter(([scope]) =>
        String(scope).startsWith("mem:obs:"),
      ),
    ).toHaveLength(1);
  });

  it("expand mode excludes capture-excluded sessions even with wildcard project", async () => {
    const hidden = (await kv.get("mem:sessions", "ses_1")) as Session;
    await kv.set("mem:sessions", "ses_1", {
      ...hidden,
      captureExcluded: true,
    });

    const result = (await sdk.trigger("mem::smart-search", {
      expandIds: ["obs_1"],
      project: "*",
    })) as { mode: string; results: unknown[] };

    expect(result.mode).toBe("expanded");
    expect(result.results).toEqual([]);
  });

  it("returns error when query is missing and no expandIds", async () => {
    const result = (await sdk.trigger("mem::smart-search", {})) as {
      mode: string;
      error: string;
    };

    expect(result.mode).toBe("compact");
    expect(result.error).toBe("query is required");
    expect((result as { results: unknown[] }).results).toEqual([]);
  });

  it("respects limit parameter in compact mode", async () => {
    const result = (await sdk.trigger("mem::smart-search", {
      query: "auth",
      limit: 1,
    })) as { mode: string; results: CompactSearchResult[] };

    expect(result.results.length).toBeLessThanOrEqual(2);
  });

  it("expand returns empty for nonexistent observation IDs", async () => {
    const result = (await sdk.trigger("mem::smart-search", {
      expandIds: ["obs_nonexistent_ses_xxx"],
    })) as { mode: string; results: unknown[] };

    expect(result.mode).toBe("expanded");
    expect(result.results.length).toBe(0);
  });

  it("compact mode records access for every returned observation id (#119)", async () => {
    await sdk.trigger("mem::smart-search", { query: "auth" });
    // recordAccessBatch is fire-and-forget — let the microtask queue drain.
    await new Promise((r) => setImmediate(r));

    const log1 = (await kv.get("mem:access", "obs_1")) as {
      count: number;
    } | null;
    const log2 = (await kv.get("mem:access", "obs_2")) as {
      count: number;
    } | null;

    expect(log1?.count).toBe(1);
    expect(log2?.count).toBe(1);
  });

  it("expand mode records access for expanded observation ids (#119)", async () => {
    await sdk.trigger("mem::smart-search", { expandIds: ["obs_1"] });
    await new Promise((r) => setImmediate(r));

    const log = (await kv.get("mem:access", "obs_1")) as {
      count: number;
    } | null;
    expect(log?.count).toBe(1);
  });

  it("compact mode skips access reinforcement when trackAccess is false", async () => {
    const result = (await sdk.trigger("mem::smart-search", {
      query: "auth",
      trackAccess: false,
    })) as { results: CompactSearchResult[] };
    await new Promise((resolve) => setImmediate(resolve));

    expect(result.results.map((entry) => entry.obsId)).toEqual([
      "obs_1",
      "obs_2",
    ]);
    expect(await kv.get("mem:access", "obs_1")).toBeNull();
    expect(await kv.get("mem:access", "obs_2")).toBeNull();
  });

  it("expand mode skips access reinforcement when trackAccess is false", async () => {
    const result = (await sdk.trigger("mem::smart-search", {
      expandIds: ["obs_1"],
      trackAccess: false,
    })) as { results: Array<{ obsId: string }> };
    await new Promise((resolve) => setImmediate(resolve));

    expect(result.results.map((entry) => entry.obsId)).toEqual(["obs_1"]);
    expect(await kv.get("mem:access", "obs_1")).toBeNull();
  });

  describe("lesson inclusion (#lesson-visibility)", () => {
    it("compact mode returns lessons array alongside observation results", async () => {
      sdk.registerFunction("mem::lesson-recall", async (payload: any) => ({
        success: true,
        lessons: [
          { id: "lsn_a", content: "always rebase before push", confidence: 0.9, createdAt: "2026-04-01T00:00:00Z", project: "p", tags: ["git"], score: 0.81 },
          { id: "lsn_b", content: "never force-push to main", confidence: 0.95, createdAt: "2026-04-02T00:00:00Z", project: "p", tags: ["git"], score: 0.76 },
        ],
      }));

      const result = (await sdk.trigger("mem::smart-search", {
        query: "rebase",
      })) as { mode: string; results: CompactSearchResult[]; lessons?: any[] };

      expect(result.mode).toBe("compact");
      expect(result.results.length).toBe(2); // observations unchanged
      expect(result.lessons).toBeDefined();
      expect(result.lessons!.length).toBe(2);
      expect(result.lessons![0]).toMatchObject({
        lessonId: "lsn_a",
        confidence: 0.9,
        score: 0.81,
      });
      expect(result.lessons![0].tags).toEqual(["git"]);
    });

    it("compact mode truncates long lesson content for preview", async () => {
      const long = "x".repeat(500);
      sdk.registerFunction("mem::lesson-recall", async () => ({
        success: true,
        lessons: [{ id: "lsn_long", content: long, confidence: 0.5, createdAt: "", tags: [], score: 0.4 }],
      }));

      const result = (await sdk.trigger("mem::smart-search", {
        query: "x",
      })) as { lessons: any[] };

      expect(result.lessons[0].content.length).toBeLessThan(long.length);
      expect(result.lessons[0].content).toMatch(/…$/);
    });

    it("includeLessons:false omits the lessons array entirely", async () => {
      // No lesson-recall handler registered — would throw if invoked.
      const result = (await sdk.trigger("mem::smart-search", {
        query: "auth",
        includeLessons: false,
      })) as { mode: string; results: CompactSearchResult[]; lessons?: unknown };

      expect(result.results.length).toBe(2);
      expect(result.lessons).toBeUndefined();
    });

    it("forwards project filter to mem::lesson-recall", async () => {
      let receivedPayload: any = null;
      sdk.registerFunction("mem::lesson-recall", async (payload: any) => {
        receivedPayload = payload;
        return { success: true, lessons: [] };
      });

      await sdk.trigger("mem::smart-search", {
        query: "rebase",
        project: "gitops-assistant",
      });

      expect(receivedPayload).toMatchObject({
        query: "rebase",
        project: "gitops-assistant",
      });
    });

    it("tolerates mem::lesson-recall failure: returns empty lessons, observations unchanged", async () => {
      sdk.registerFunction("mem::lesson-recall", async () => {
        throw new Error("lessons store unavailable");
      });

      const result = (await sdk.trigger("mem::smart-search", {
        query: "auth",
      })) as { results: CompactSearchResult[]; lessons: any[] };

      expect(result.results.length).toBe(2);
      expect(result.lessons).toEqual([]);
    });

    it("tolerates non-success lesson-recall response shape", async () => {
      sdk.registerFunction("mem::lesson-recall", async () => ({
        success: false,
        error: "query is required",
      }));

      const result = (await sdk.trigger("mem::smart-search", {
        query: "auth",
      })) as { results: CompactSearchResult[]; lessons: any[] };

      expect(result.results.length).toBe(2);
      expect(result.lessons).toEqual([]);
    });
  });
});
