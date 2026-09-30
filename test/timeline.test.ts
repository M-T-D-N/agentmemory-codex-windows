import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerTimelineFunction } from "../src/functions/timeline.js";
import type { CompressedObservation, Session, TimelineEntry } from "../src/types.js";

type TimelineResponse = { entries: TimelineEntry[]; anchorIndex: number | null; offset: number; total: number; nextOffset: number | null; truncated: boolean };

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
    usesManagedState: false,
    list: vi.fn(async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    }),
    listPage: vi.fn(async <T>(scope: string, offset = 0): Promise<{
      entries: Array<{ key: string; value: T }>;
      total: number;
      next_offset: number | null;
    }> => {
      const rows = Array.from(store.get(scope)?.entries() ?? []) as Array<[string, T]>;
      const entries = rows.slice(offset, offset + 2).map(([key, value]) => ({ key, value }));
      const next = offset + entries.length;
      return { entries, total: rows.length, next_offset: next < rows.length ? next : null };
    }),
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
  id: string,
  timestamp: string,
  title: string,
): CompressedObservation {
  return {
    id,
    sessionId: "ses_1",
    timestamp,
    type: "file_edit",
    title,
    facts: [],
    narrative: title,
    concepts: [],
    files: [],
    importance: 5,
  };
}

describe("Timeline Function", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(async () => {
    sdk = mockSdk();
    kv = mockKV();
    registerTimelineFunction(sdk as never, kv as never);

    const session: Session = {
      id: "ses_1",
      project: "my-project",
      cwd: "/tmp",
      startedAt: "2026-02-01T00:00:00Z",
      status: "completed",
      observationCount: 5,
    };
    await kv.set("mem:sessions", "ses_1", session);

    await kv.set("mem:obs:ses_1", "obs_1", makeObs("obs_1", "2026-02-01T10:00:00Z", "First edit"));
    await kv.set("mem:obs:ses_1", "obs_2", makeObs("obs_2", "2026-02-01T11:00:00Z", "Second edit"));
    await kv.set("mem:obs:ses_1", "obs_3", makeObs("obs_3", "2026-02-01T12:00:00Z", "Third edit"));
    await kv.set("mem:obs:ses_1", "obs_4", makeObs("obs_4", "2026-02-01T13:00:00Z", "Fourth edit"));
    await kv.set("mem:obs:ses_1", "obs_5", makeObs("obs_5", "2026-02-01T14:00:00Z", "Fifth edit"));
  });

  it("anchors by ISO date and returns surrounding observations", async () => {
    const result = (await sdk.trigger("mem::timeline", {
      anchor: "2026-02-01T12:00:00Z",
      before: 2,
      after: 2,
    })) as { entries: TimelineEntry[] };

    expect(result.entries.length).toBe(5);
    expect(result.entries[0].observation.id).toBe("obs_1");
    expect(result.entries[4].observation.id).toBe("obs_5");
  });

  it("records access by default", async () => {
    await sdk.trigger("mem::timeline", {
      anchor: "2026-02-01T12:00:00Z",
      before: 0,
      after: 0,
    });
    await new Promise((resolve) => setImmediate(resolve));

    const log = await kv.get<{ count: number }>("mem:access", "obs_3");
    expect(log?.count).toBe(1);
  });

  it("returns the timeline without reinforcing access when trackAccess is false", async () => {
    const result = (await sdk.trigger("mem::timeline", {
      anchor: "2026-02-01T12:00:00Z",
      before: 1,
      after: 1,
      trackAccess: false,
    })) as { entries: TimelineEntry[] };
    await new Promise((resolve) => setImmediate(resolve));

    expect(result.entries.map((entry) => entry.observation.id)).toEqual([
      "obs_2",
      "obs_3",
      "obs_4",
    ]);
    for (const id of ["obs_2", "obs_3", "obs_4"]) {
      expect(await kv.get("mem:access", id)).toBeNull();
    }
  });

  it("relativePosition is correct relative to anchor", async () => {
    const result = (await sdk.trigger("mem::timeline", {
      anchor: "2026-02-01T12:00:00Z",
      before: 2,
      after: 2,
    })) as { entries: TimelineEntry[] };

    const positions = result.entries.map((e) => e.relativePosition);
    expect(positions).toEqual([-2, -1, 0, 1, 2]);
  });

  it("respects before and after limits", async () => {
    const result = (await sdk.trigger("mem::timeline", {
      anchor: "2026-02-01T12:00:00Z",
      before: 1,
      after: 1,
    })) as { entries: TimelineEntry[] };

    expect(result.entries.length).toBe(3);
    expect(result.entries[0].observation.id).toBe("obs_2");
    expect(result.entries[2].observation.id).toBe("obs_4");
  });

  it("returns empty entries when no sessions exist for project", async () => {
    const result = (await sdk.trigger("mem::timeline", {
      anchor: "2026-02-01T12:00:00Z",
      project: "nonexistent-project",
    })) as { entries: TimelineEntry[] };

    expect(result.entries.length).toBe(0);
  });

  it("handles keyword anchor by finding matching observation", async () => {
    const result = (await sdk.trigger("mem::timeline", {
      anchor: "Third",
      before: 1,
      after: 1,
    })) as { entries: TimelineEntry[] };

    expect(result.entries.length).toBe(3);
    const titles = result.entries.map((e) => e.observation.title);
    expect(titles).toContain("Third edit");
  });

  it("excludes capture-excluded sessions", async () => {
    const hidden = (await kv.get("mem:sessions", "ses_1")) as Session;
    await kv.set("mem:sessions", "ses_1", {
      ...hidden,
      captureExcluded: true,
    });

    const result = (await sdk.trigger("mem::timeline", {
      anchor: "2026-02-01T12:00:00Z",
      project: "my-project",
    })) as { entries: TimelineEntry[] };

    expect(result.entries).toEqual([]);
  });
  it("accepts zero before and after and validates direct numeric inputs", async () => {
    const result = await sdk.trigger("mem::timeline", {
      anchor: "2026-02-01T12:00:00Z", before: 0, after: 0, trackAccess: false,
    }) as TimelineResponse;
    expect(result.entries.map(entry => entry.observation.id)).toEqual(["obs_3"]);
    expect(result).toMatchObject({ anchorIndex: 0, offset: 0, total: 1, nextOffset: null, truncated: false });
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "0", null]) {
      await expect(sdk.trigger("mem::timeline", { anchor: "Third", before: value }))
        .rejects.toThrow("before must be a non-negative safe integer");
    }
  });

  it("uses the exact latest keyword match when other rows share its timestamp", async () => {
    await kv.set("mem:obs:ses_1", "obs_z", makeObs("obs_z", "2026-02-01T12:00:00Z", "Needle"));
    await kv.set("mem:obs:ses_1", "obs_a", makeObs("obs_a", "2026-02-01T12:00:00Z", "Other"));
    const result = await sdk.trigger("mem::timeline", {
      anchor: "Needle", before: 1, after: 0, trackAccess: false,
    }) as TimelineResponse;
    expect(result.entries.map(entry => [entry.observation.id, entry.relativePosition]))
      .toEqual([["obs_a", -1], ["obs_z", 0]]);
    expect(result.anchorIndex).toBe(1);
  });

  it("walks the full window in count-bounded pages without lost, duplicate, or shortened observations", async () => {
    for (let index = 0; index < 149; index++) {
      const id = "later_" + String(index).padStart(3, "0");
      await kv.set("mem:obs:ses_1", id, makeObs(id,
        new Date(Date.parse("2026-02-02T00:00:00Z") + index * 1000).toISOString(), id));
    }
    kv.usesManagedState = true;
    kv.list.mockImplementation(async () => { throw Error("managed full list forbidden"); });
    const seen: string[] = [];
    let offset = 0;
    do {
      const page = await sdk.trigger("mem::timeline", {
        anchor: "2026-02-01T10:00:00Z", before: 0, after: 153, offset, trackAccess: false,
      }) as TimelineResponse;
      expect(page.total).toBe(154);
      expect(page.offset).toBe(offset);
      expect(page.entries.length).toBeLessThanOrEqual(100);
      expect(page.anchorIndex).toBe(offset === 0 ? 0 : null);
      expect(page.entries.map(entry => entry.relativePosition))
        .toEqual(Array.from({ length: page.entries.length }, (_, index) => offset + index));
      seen.push(...page.entries.map(entry => entry.observation.id));
      if (page.nextOffset === null) break;
      expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset;
    } while (true);
    expect(seen).toHaveLength(154);
    expect(new Set(seen).size).toBe(154);
    expect(seen[0]).toBe("obs_1");
    expect(seen.at(-1)).toBe("later_148");
    expect(kv.list).not.toHaveBeenCalled();
    expect(kv.listPage).toHaveBeenCalled();
  });

  it("keeps UTF-8 and escape-heavy originals within the final serialized MCP response limit", async () => {
    const narrative = "한\"\\\n".repeat(110_000);
    for (let index = 0; index < 4; index++) {
      const id = "large_" + index;
      await kv.set("mem:obs:ses_1", id, {
        ...makeObs(id, new Date(Date.parse("2026-02-03T00:00:00Z") + index * 1000).toISOString(), id),
        narrative,
      });
    }
    let offset = 0;
    const seen: string[] = [];
    do {
      const page = await sdk.trigger("mem::timeline", {
        anchor: "large_0", before: 0, after: 3, offset, trackAccess: false,
      }) as TimelineResponse;
      const serializedMcp = JSON.stringify({
        status_code: 200, body: { content: [{ type: "text", text: JSON.stringify(page, null, 2) }] },
      });
      expect(Buffer.byteLength(serializedMcp, "utf8")).toBeLessThanOrEqual(2 * 1024 * 1024);
      for (const entry of page.entries) {
        seen.push(entry.observation.id);
        expect(entry.observation.narrative).toBe(narrative);
      }
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    } while (true);
    expect(seen).toEqual(["large_0", "large_1", "large_2", "large_3"]);
  });

  it("fails with the exact ID when one original cannot fit a response", async () => {
    await kv.set("mem:obs:ses_1", "oversized", {
      ...makeObs("oversized", "2026-02-03T00:00:00Z", "oversized"),
      narrative: "\"".repeat(600_000),
    });
    await expect(sdk.trigger("mem::timeline", {
      anchor: "oversized", before: 0, after: 0, trackAccess: false,
    })).rejects.toThrow("Timeline entry exceeds the 2 MiB response limit: ses_1/oversized");
  });

  it("does not use a full-list fallback when managed pages fail or their count changes", async () => {
    kv.usesManagedState = true;
    kv.list.mockImplementation(async () => { throw Error("managed full list forbidden"); });
    kv.listPage.mockImplementationOnce(async () => { throw Error("list page unavailable"); });
    await expect(sdk.trigger("mem::timeline", { anchor: "Third", trackAccess: false }))
      .rejects.toThrow("list page unavailable");
    expect(kv.list).not.toHaveBeenCalled();

    const actualPage = kv.listPage;
    kv.listPage = vi.fn(async <T>(scope: string, offset = 0) => {
      const page = await actualPage<T>(scope, offset);
      return scope === "mem:obs:ses_1" && offset > 0
        ? { ...page, total: page.total + 1 }
        : page;
    });
    await expect(sdk.trigger("mem::timeline", { anchor: "Third", trackAccess: false }))
      .rejects.toThrow("Timeline source changed during page read");
    expect(kv.list).not.toHaveBeenCalled();
  });

  it("rejects selected rows changed after enumeration", async () => {
    const originalGet = kv.get;
    kv.get = async <T>(scope: string, key: string): Promise<T | null> => {
      const row = await originalGet<T>(scope, key);
      return scope === "mem:obs:ses_1" && key === "obs_3" && row
        ? { ...(row as object), narrative: "changed" } as T : row;
    };
    await expect(sdk.trigger("mem::timeline", {
      anchor: "Third", before: 0, after: 0, trackAccess: false,
    })).rejects.toThrow("Timeline selected observation changed: ses_1/obs_3");
  });

  it("honors exact trimmed project, explicit all-project scope, and omitted scope", async () => {
    await kv.set("mem:sessions", "ses_2", {
      id: "ses_2", project: "other-project", cwd: "/other", startedAt: "2026-02-01T00:00:00Z",
      status: "completed", observationCount: 1,
    } satisfies Session);
    await kv.set("mem:obs:ses_2", "other", {
      ...makeObs("other", "2026-02-01T15:00:00Z", "Other project"),
      sessionId: "ses_2",
    });
    const query = { anchor: "2026-02-01T12:00:00Z", before: 10, after: 10, trackAccess: false };
    const exact = await sdk.trigger("mem::timeline", { ...query, project: " my-project " }) as TimelineResponse;
    const all = await sdk.trigger("mem::timeline", { ...query, project: "*" }) as TimelineResponse;
    const omitted = await sdk.trigger("mem::timeline", query) as TimelineResponse;
    expect(exact.entries).toHaveLength(5);
    expect(all.entries).toHaveLength(6);
    expect(omitted.entries).toHaveLength(6);
    await expect(sdk.trigger("mem::timeline", { ...query, project: " " }))
      .rejects.toThrow("project must be a non-empty string");
  });

  it.each([false, true])("ignores session-end-only legacy rows without inventing a session (managed=%s)", async managed => {
    kv.usesManagedState = managed;
    await kv.set("mem:sessions", "ended-before-start", { status: "completed", endedAt: "2026-02-01T10:00:00Z" });
    const result = await sdk.trigger("mem::timeline", { project: "my-project", anchor: "Third", before: 0, after: 0, trackAccess: false }) as TimelineResponse;
    expect(result.entries.map(entry => entry.observation.id)).toEqual(["obs_3"]);
    expect(await kv.get("mem:sessions", "ended-before-start")).toEqual({ status: "completed", endedAt: "2026-02-01T10:00:00Z" });
  });

  it("still rejects a managed session row whose declared identity conflicts with its key", async () => {
    kv.usesManagedState = true;
    await kv.set("mem:sessions", "conflicting-key", { id: "other-id", project: "my-project", status: "completed", endedAt: "2026-02-01T10:00:00Z" });
    await expect(sdk.trigger("mem::timeline", { project: "my-project", anchor: "Third", trackAccess: false }))
      .rejects.toThrow("Timeline source has an invalid or duplicate key");
  });
});
