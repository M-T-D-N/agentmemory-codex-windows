import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { recordAudit, queryAudit } from "../src/functions/audit.js";

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

describe("Audit Functions", () => {
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    kv = mockKV();
  });

  it("recordAudit creates an entry with proper fields", async () => {
    const entry = await recordAudit(
      kv as never,
      "observe",
      "mem::compress",
      ["obs_1", "obs_2"],
      { count: 2 },
      0.85,
      "user-1",
    );

    expect(entry.id).toMatch(/^aud_/);
    expect(entry.timestamp).toBeDefined();
    expect(entry.operation).toBe("observe");
    expect(entry.functionId).toBe("mem::compress");
    expect(entry.targetIds).toEqual(["obs_1", "obs_2"]);
    expect(entry.details).toEqual({ count: 2 });
    expect(entry.qualityScore).toBe(0.85);
    expect(entry.userId).toBe("user-1");
  });

  it("queryAudit returns entries sorted by timestamp desc", async () => {
    await recordAudit(kv as never, "observe", "fn1", ["a"], {});
    await new Promise((r) => setTimeout(r, 10));
    await recordAudit(kv as never, "delete", "fn2", ["b"], {});

    const { entries } = await queryAudit(kv as never);
    expect(entries.length).toBe(2);
    expect(
      new Date(entries[0].timestamp).getTime(),
    ).toBeGreaterThanOrEqual(new Date(entries[1].timestamp).getTime());
  });

  it("queryAudit filters by operation", async () => {
    await recordAudit(kv as never, "observe", "fn1", [], {});
    await recordAudit(kv as never, "delete", "fn2", [], {});
    await recordAudit(kv as never, "observe", "fn3", [], {});

    const { entries } = await queryAudit(kv as never, { operation: "observe" });
    expect(entries.length).toBe(2);
    expect(entries.every((e) => e.operation === "observe")).toBe(true);
  });

  it("queryAudit filters by dateFrom/dateTo", async () => {
    const early = await recordAudit(kv as never, "observe", "fn1", [], {});
    await new Promise((r) => setTimeout(r, 20));
    const late = await recordAudit(kv as never, "delete", "fn2", [], {});

    const { entries } = await queryAudit(kv as never, {
      dateFrom: late.timestamp,
    });
    expect(entries.length).toBe(1);
    expect(entries[0].operation).toBe("delete");

    const { entries: entriesBefore } = await queryAudit(kv as never, {
      dateTo: early.timestamp,
    });
    expect(entriesBefore.length).toBe(1);
    expect(entriesBefore[0].operation).toBe("observe");
  });

  it("queryAudit filters by target id or function text", async () => {
    await recordAudit(kv as never, "forget", "mem::forget", ["mem_abc", "ses_1"]);
    await recordAudit(kv as never, "observe", "mem::observe", ["obs_9"]);
    await recordAudit(kv as never, "lesson_save", "mem::lesson-save", ["lsn_1"]);

    expect((await queryAudit(kv as never, { query: "MEM_AB" })).entries.map((e) => e.targetIds[0])).toEqual(["mem_abc"]);
    expect((await queryAudit(kv as never, { query: "lesson-save" })).entries.map((e) => e.targetIds[0])).toEqual(["lsn_1"]);
    expect((await queryAudit(kv as never, { query: "nothing" })).entries).toEqual([]);
  });

  it("queryAudit respects limit", async () => {
    for (let i = 0; i < 10; i++) {
      await recordAudit(kv as never, "observe", `fn${i}`, [], {});
    }

    const { entries } = await queryAudit(kv as never, { limit: 3 });
    expect(entries.length).toBe(3);
  });
});


describe("managed audit paging", () => {
  it("keeps exact newest filtered results across pages without a whole-scope RPC", async () => {
    const rows = Array.from({ length: 300 }, (_, index) => ({
      id: `aud_${index}`, timestamp: new Date(1700000000000 + (index % 91) * 1000).toISOString(),
      operation: index % 2 ? "delete" : "observe", functionId: "test", targetIds: [], details: {},
    }));
    const managed = {
      usesManagedState: true,
      get: vi.fn(async () => null),
      list: vi.fn(() => { throw Error("Whole audit scope read is forbidden"); }),
      listPage: vi.fn(async (_scope: string, offset: number) => ({
        entries: rows.slice(offset, offset + 128).map(value => ({ key: value.id, value })),
        total: rows.length, next_offset: offset + 128 < rows.length ? offset + 128 : null,
      })),
    };
    const filter = { operation: "delete" as const, limit: 7,
      dateFrom: new Date(1700000030000).toISOString(), dateTo: new Date(1700000080000).toISOString() };
    const expected = rows.filter(row => row.operation === filter.operation && row.timestamp >= filter.dateFrom && row.timestamp <= filter.dateTo)
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)).slice(0, filter.limit);
    expect((await queryAudit(managed as never, filter)).entries).toEqual(expected);
    expect(managed.list).not.toHaveBeenCalled();
    expect(managed.listPage.mock.calls.map(call => call[1])).toEqual([0, 128, 256]);
  });
});
