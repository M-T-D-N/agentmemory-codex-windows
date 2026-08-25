import { describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/state/keyed-mutex.js", () => ({
  withKeyedLock: <T>(_key: string, fn: () => Promise<T>) => fn(),
}));

vi.mock("iii-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("iii-sdk")>();
  return {
    ...actual,
    TriggerAction: {
      ...actual.TriggerAction,
      Void: vi.fn(() => ({ type: "void" })),
    },
  };
});

import { vi } from "vitest";
import { registerRememberFunction } from "../src/functions/remember.js";
import { getSearchIndex, setIndexPersistence } from "../src/functions/search.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
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
    registerFunction: (id: string, handler: Function) => {
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (input: { function_id: string; payload: unknown; action?: unknown }) => {
      const fn = functions.get(input.function_id);
      if (!fn) return {};
      return fn(input.payload);
    },
  };
}

describe("mem::remember — project field stamping", () => {
  beforeEach(() => {
    getSearchIndex().clear();
    setIndexPersistence(null);
  });

  afterEach(() => {
    setIndexPersistence(null);
  });

  it("persists project on the saved memory when provided", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerRememberFunction(sdk as never, kv as never);

    const result = await sdk.trigger({
      function_id: "mem::remember",
      payload: {
        content: "express-jwt requires trimmed Bearer token",
        type: "bug",
        files: ["src/middleware/auth.ts"],
        project: "api",
      },
    }) as { success: boolean; memory: { id: string; project?: string } };

    expect(result.success).toBe(true);
    expect(result.memory.project).toBe("api");

    const stored = await kv.get<{ project?: string }>("mem:memories", result.memory.id);
    expect(stored?.project).toBe("api");
  });

  it("leaves project undefined when not provided (backward-compat)", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerRememberFunction(sdk as never, kv as never);

    const result = await sdk.trigger({
      function_id: "mem::remember",
      payload: { content: "some unscoped memory" },
    }) as { success: boolean; memory: { id: string; project?: string } };

    expect(result.success).toBe(true);
    expect(result.memory.project).toBeUndefined();
  });

  it("trims whitespace from the project value", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerRememberFunction(sdk as never, kv as never);

    const result = await sdk.trigger({
      function_id: "mem::remember",
      payload: { content: "padded project name", project: "  api  " },
    }) as { success: boolean; memory: { project?: string } };

    expect(result.memory.project).toBe("api");
  });

  it("treats a blank project string the same as no project", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerRememberFunction(sdk as never, kv as never);

    const result = await sdk.trigger({
      function_id: "mem::remember",
      payload: { content: "blank project string", project: "   " },
    }) as { success: boolean; memory: { project?: string } };

    expect(result.memory.project).toBeUndefined();
  });
});

describe("mem::remember — cross-project dedup isolation", () => {
  beforeEach(() => {
    getSearchIndex().clear();
    setIndexPersistence(null);
  });

  afterEach(() => {
    setIndexPersistence(null);
  });

  it("does not supersede a memory from a different project even when content is similar", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerRememberFunction(sdk as never, kv as never);

    // Save a memory in project "api"
    const first = await sdk.trigger({
      function_id: "mem::remember",
      payload: {
        content: "always use express-jwt middleware for token validation in this project",
        type: "pattern",
        project: "api",
      },
    }) as { memory: { id: string; isLatest: boolean; project?: string } };

    // Save a near-identical memory in project "web" — should NOT supersede the api one
    const second = await sdk.trigger({
      function_id: "mem::remember",
      payload: {
        content: "always use express-jwt middleware for token validation in this project",
        type: "pattern",
        project: "web",
      },
    }) as { memory: { id: string; supersedes: string[]; project?: string } };

    expect(second.memory.project).toBe("web");
    expect(second.memory.supersedes).toHaveLength(0);

    // The api memory must still be isLatest
    const apiMemory = await kv.get<{ isLatest: boolean }>("mem:memories", first.memory.id);
    expect(apiMemory?.isLatest).toBe(true);
  });

  it("still supersedes within the same project when content is similar", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerRememberFunction(sdk as never, kv as never);

    const first = await sdk.trigger({
      function_id: "mem::remember",
      payload: {
        content: "always use express-jwt middleware for token validation in this project",
        type: "pattern",
        project: "api",
      },
    }) as { memory: { id: string } };

    const second = await sdk.trigger({
      function_id: "mem::remember",
      payload: {
        content: "always use express-jwt middleware for token validation in this project",
        type: "pattern",
        project: "api",
      },
    }) as { memory: { id: string; supersedes: string[] } };

    expect(second.memory.supersedes).toContain(first.memory.id);

    const original = await kv.get<{ isLatest: boolean }>("mem:memories", first.memory.id);
    expect(original?.isLatest).toBe(false);
    const indexHits = getSearchIndex().search("express-jwt middleware", 20);
    expect(indexHits.some((hit) => hit.obsId === first.memory.id)).toBe(false);
    expect(indexHits.some((hit) => hit.obsId === second.memory.id)).toBe(true);
  });

  it("does not supersede an unscoped memory with a scoped memory", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerRememberFunction(sdk as never, kv as never);

    // Existing legacy memory with no project
    const legacy = await sdk.trigger({
      function_id: "mem::remember",
      payload: {
        content: "always use express-jwt middleware for token validation in this project",
        type: "pattern",
      },
    }) as { memory: { id: string } };

    // Exact project identity keeps the legacy row separate.
    const scoped = await sdk.trigger({
      function_id: "mem::remember",
      payload: {
        content: "always use express-jwt middleware for token validation in this project",
        type: "pattern",
        project: "api",
      },
    }) as { memory: { supersedes: string[] } };

    expect(scoped.memory.supersedes).not.toContain(legacy.memory.id);
    expect(
      (await kv.get<{ isLatest: boolean }>("mem:memories", legacy.memory.id))
        ?.isLatest,
    ).toBe(true);
  });

  it("does not supersede a scoped memory with an unscoped memory", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerRememberFunction(sdk as never, kv as never);

    const scoped = await sdk.trigger({
      function_id: "mem::remember",
      payload: {
        content: "always use express-jwt middleware for token validation in this project",
        type: "pattern",
        project: "api",
      },
    }) as { memory: { id: string } };

    // Unscoped writes stay in their own identity domain.
    const unscoped = await sdk.trigger({
      function_id: "mem::remember",
      payload: {
        content: "always use express-jwt middleware for token validation in this project",
        type: "pattern",
      },
    }) as { memory: { supersedes: string[] } };

    expect(unscoped.memory.supersedes).not.toContain(scoped.memory.id);
    expect(
      (await kv.get<{ isLatest: boolean }>("mem:memories", scoped.memory.id))
        ?.isLatest,
    ).toBe(true);
  });

  it("unions source observations across a same-project supersession", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerRememberFunction(sdk as never, kv as never);

    await kv.set("mem:sessions", "ses_provenance", {
      id: "ses_provenance",
      project: "api",
      cwd: "/srv/api",
      startedAt: "2026-01-01T00:00:00Z",
      status: "completed",
      observationCount: 2,
    });
    for (const id of ["obs_old", "obs_new"]) {
      await kv.set("mem:obs:ses_provenance", id, {
        id,
        sessionId: "ses_provenance",
        timestamp: "2026-01-01T00:00:00Z",
        type: "decision",
        title: id,
        facts: [],
        narrative: `source ${id}`,
        concepts: [],
        files: [],
        importance: 8,
      });
    }

    const first = (await sdk.trigger({
      function_id: "mem::remember",
      payload: {
        content: "preserve provenance when a project memory is revised",
        project: "api",
        sourceObservationIds: ["obs_old"],
      },
    })) as { memory: { id: string } };
    const second = (await sdk.trigger({
      function_id: "mem::remember",
      payload: {
        content: "preserve provenance when a project memory is revised",
        project: "api",
        sourceObservationIds: ["obs_new"],
      },
    })) as {
      memory: { supersedes: string[]; sourceObservationIds: string[] };
    };

    expect(second.memory.supersedes).toContain(first.memory.id);
    expect(second.memory.sourceObservationIds).toEqual([
      "obs_old",
      "obs_new",
    ]);
  });

  it("rejects unknown or cross-project source observations without writing", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerRememberFunction(sdk as never, kv as never);
    await kv.set("mem:sessions", "ses_other", {
      id: "ses_other",
      project: "other",
      cwd: "/srv/other",
      startedAt: "2026-01-01T00:00:00Z",
      status: "completed",
      observationCount: 1,
    });
    await kv.set("mem:obs:ses_other", "obs_other", {
      id: "obs_other",
      sessionId: "ses_other",
      timestamp: "2026-01-01T00:00:00Z",
      type: "decision",
      title: "other",
      facts: [],
      narrative: "foreign source",
      concepts: [],
      files: [],
      importance: 8,
    });

    const result = await sdk.trigger({
      function_id: "mem::remember",
      payload: {
        content: "must not cross project boundaries",
        project: "api",
        sourceObservationIds: ["obs_other"],
      },
    }) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("unknown or cross-project");
    expect(await kv.list("mem:memories")).toEqual([]);
  });
});

describe("mem::remember — CJK dedup", () => {
  beforeEach(() => {
    getSearchIndex().clear();
    setIndexPersistence(null);
  });

  afterEach(() => {
    setIndexPersistence(null);
  });

  it("dedups two near-identical CJK memories (new one supersedes old)", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerRememberFunction(sdk as never, kv as never);

    const first = await sdk.trigger({
      function_id: "mem::remember",
      payload: {
        content: "用户认证中间件必须先去除请求头里的 Bearer 前缀然后再校验令牌",
        type: "pattern",
      },
    }) as { memory: { id: string } };

    const second = await sdk.trigger({
      function_id: "mem::remember",
      payload: {
        content: "用户认证中间件必须先去除请求头里的 Bearer 前缀然后校验令牌",
        type: "pattern",
      },
    }) as { memory: { supersedes: string[] } };

    expect(second.memory.supersedes).toContain(first.memory.id);

    const original = await kv.get<{ isLatest: boolean }>("mem:memories", first.memory.id);
    expect(original?.isLatest).toBe(false);
  });

  it("does NOT supersede two unrelated short CJK memories (北京 vs 上海)", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerRememberFunction(sdk as never, kv as never);

    const beijing = await sdk.trigger({
      function_id: "mem::remember",
      payload: { content: "北京", type: "fact" },
    }) as { memory: { id: string } };

    const shanghai = await sdk.trigger({
      function_id: "mem::remember",
      payload: { content: "上海", type: "fact" },
    }) as { memory: { supersedes: string[] } };

    // The old empty-set shortcut returned similarity 1 here and falsely
    // chained "上海" as a new version of "北京".
    expect(shanghai.memory.supersedes).toHaveLength(0);

    const original = await kv.get<{ isLatest: boolean }>("mem:memories", beijing.memory.id);
    expect(original?.isLatest).toBe(true);
  });

  it("preserves a trailing astral character in the title (no lone surrogate)", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerRememberFunction(sdk as never, kv as never);

    // 80th UTF-16 code unit falls inside a surrogate pair; the title must
    // not end on a lone high surrogate.
    const content = "x".repeat(79) + "😀 trailing";
    const result = await sdk.trigger({
      function_id: "mem::remember",
      payload: { content, type: "fact" },
    }) as { memory: { title: string } };

    expect(/[\uD800-\uDBFF]$/.test(result.memory.title)).toBe(false);
    expect(result.memory.title.length).toBe(79);
  });
});
