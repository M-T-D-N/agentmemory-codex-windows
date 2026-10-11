import { describe, it, expect, beforeEach, vi } from "vitest";
import { registerSlotsFunctions, DEFAULT_SLOTS, listPinnedSlots, renderPinnedContext } from "../src/functions/slots.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { registerMcpEndpoints } from "../src/mcp/server.js";
import { KV } from "../src/state/schema.js";

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
      if (!store.has(scope)) return [];
      return Array.from(store.get(scope)!.values()) as T[];
    },
  };
}

function wire() {
  const kv = mockKV();
  const handlers: Record<string, (data: Record<string, unknown>) => Promise<Record<string, unknown>>> = {};
  const sdk = {
    registerFunction: vi.fn((id: string, cb) => {
      handlers[id] = cb;
    }),
  } as unknown as import("iii-sdk").IIIClient;
  registerSlotsFunctions(sdk, kv as never);
  return { kv, handlers };
}

async function waitForSeed(kv: ReturnType<typeof mockKV>) {
  for (let i = 0; i < 20; i++) {
    const p = await kv.list(KV.slots);
    const g = await kv.list(KV.globalSlots);
    if (p.length + g.length >= DEFAULT_SLOTS.length) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("slots — primitive", () => {
  let kv: ReturnType<typeof mockKV>;
  let handlers: Record<string, (d: Record<string, unknown>) => Promise<Record<string, unknown>>>;

  beforeEach(async () => {
    ({ kv, handlers } = wire());
    await handlers["mem::slot-list"]({ project: "fixture-project" });
    await waitForSeed(kv);
  });

  it("seeds default slots into the right scopes on first run", async () => {
    const global = (await kv.list(KV.globalSlots)) as Array<{ label: string }>;
    const project = (await kv.list(KV.slots)) as Array<{ label: string }>;
    expect(global.map((s) => s.label).sort()).toEqual(
      ["persona", "tool_guidelines", "user_preferences"].sort(),
    );
    expect(project.map((s) => s.label).sort().length).toBeGreaterThanOrEqual(5);
  });

  it("rejects labels with bad shape", async () => {
    const res = (await handlers["mem::slot-create"]({ project: "fixture-project", label: "Bad Label!" })) as { success: boolean; error: string };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/label required/);
  });

  it("create then get round-trips a new slot", async () => {
    const created = (await handlers["mem::slot-create"]({ project: "fixture-project",
      label: "notes_todo",
      content: "hello",
      description: "scratchpad",
    })) as { success: boolean; slot: { label: string; content: string } };
    expect(created.success).toBe(true);
    expect(created.slot.content).toBe("hello");

    const fetched = (await handlers["mem::slot-get"]({ project: "fixture-project", label: "notes_todo" })) as {
      success: boolean;
      slot: { content: string };
    };
    expect(fetched.success).toBe(true);
    expect(fetched.slot.content).toBe("hello");
  });

  it("rejects duplicate create", async () => {
    await handlers["mem::slot-create"]({ project: "fixture-project", label: "scratch", content: "a" });
    const dup = (await handlers["mem::slot-create"]({ project: "fixture-project", label: "scratch", content: "b" })) as {
      success: boolean;
      error: string;
    };
    expect(dup.success).toBe(false);
    expect(dup.error).toMatch(/already exists/);
  });

  it("append refuses writes that would blow the sizeLimit", async () => {
    await handlers["mem::slot-create"]({ project: "fixture-project", label: "tight", content: "", sizeLimit: 10 });
    const ok = (await handlers["mem::slot-append"]({ project: "fixture-project", label: "tight", text: "short" })) as { success: boolean };
    expect(ok.success).toBe(true);
    const tooBig = (await handlers["mem::slot-append"]({ project: "fixture-project", label: "tight", text: "way too long for this slot" })) as {
      success: boolean;
      error: string;
    };
    expect(tooBig.success).toBe(false);
    expect(tooBig.error).toMatch(/exceed sizeLimit/);
  });

  it("replace refuses content above sizeLimit", async () => {
    await handlers["mem::slot-create"]({ project: "fixture-project", label: "tiny", content: "", sizeLimit: 5 });
    const res = (await handlers["mem::slot-replace"]({ project: "fixture-project", label: "tiny", content: "exceeds" })) as {
      success: boolean;
      error: string;
    };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/exceeds/);
  });

  it("delete removes the slot", async () => {
    await handlers["mem::slot-create"]({ project: "fixture-project", label: "throwaway", content: "bye" });
    const del = (await handlers["mem::slot-delete"]({ project: "fixture-project", label: "throwaway" })) as { success: boolean };
    expect(del.success).toBe(true);
    const get = (await handlers["mem::slot-get"]({ project: "fixture-project", label: "throwaway" })) as { success: boolean };
    expect(get.success).toBe(false);
  });

  it("project slot shadows global slot of the same label", async () => {
    // Default seed already created a global `persona`. Populate it through
    // the public handler, then create a project-scoped override through the
    // same handler so scope validation + shadowing logic is exercised end
    // to end (no direct kv.set).
    await handlers["mem::slot-replace"]({ project: "fixture-project", label: "persona", content: "global-persona" });
    const createRes = (await handlers["mem::slot-create"]({ project: "fixture-project",
      label: "persona",
      content: "project-override",
      scope: "project",
    })) as { success: boolean };
    expect(createRes.success).toBe(true);

    const res = (await handlers["mem::slot-get"]({ project: "fixture-project", label: "persona" })) as {
      slot: { content: string };
      scope: string;
    };
    expect(res.slot.content).toBe("project-override");
    expect(res.scope).toBe("project");
  });

  it("rejects invalid sizeLimit instead of silently defaulting", async () => {
    const tooBig = (await handlers["mem::slot-create"]({ project: "fixture-project",
      label: "oversize",
      sizeLimit: 99999,
    })) as { success: boolean; error: string };
    expect(tooBig.success).toBe(false);
    expect(tooBig.error).toMatch(/sizeLimit must be/);

    const negative = (await handlers["mem::slot-create"]({ project: "fixture-project",
      label: "negative",
      sizeLimit: -1,
    })) as { success: boolean; error: string };
    expect(negative.success).toBe(false);

    const nonInteger = (await handlers["mem::slot-create"]({ project: "fixture-project",
      label: "fractional",
      sizeLimit: 1.5,
    })) as { success: boolean; error: string };
    expect(nonInteger.success).toBe(false);
  });

  it("rejects unknown scope values", async () => {
    const res = (await handlers["mem::slot-create"]({ project: "fixture-project",
      label: "bad_scope",
      scope: "wrong" as unknown as "project",
    })) as { success: boolean; error: string };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/scope must be/);
  });

  it("listPinnedSlots returns only pinned slots with content", async () => {
    await handlers["mem::slot-append"]({ project: "fixture-project", label: "persona", text: "helpful senior engineer" });
    const pinned = await listPinnedSlots(kv as never);
    expect(pinned.some((s) => s.label === "persona")).toBe(true);
    expect(pinned.every((s) => s.pinned && s.content.trim().length > 0)).toBe(true);
  });

  it("renderPinnedContext serialises slots into markdown", async () => {
    await handlers["mem::slot-append"]({ project: "fixture-project", label: "persona", text: "senior eng" });
    const pinned = await listPinnedSlots(kv as never);
    const rendered = renderPinnedContext(pinned);
    expect(rendered).toContain("## persona");
    expect(rendered).toContain("senior eng");
  });
});

describe("slots — reflect", () => {
  let kv: ReturnType<typeof mockKV>;
  let handlers: Record<string, (d: Record<string, unknown>) => Promise<Record<string, unknown>>>;

  beforeEach(async () => {
    ({ kv, handlers } = wire());
    await handlers["mem::slot-list"]({ project: "fixture-project" });
    await waitForSeed(kv);
  });

  it("no-ops when the session has no observations", async () => {
    const res = (await handlers["mem::slot-reflect"]({ project: "fixture-project", sessionId: "empty-session" })) as {
      success: boolean;
      applied: number;
    };
    expect(res.success).toBe(true);
    expect(res.applied).toBe(0);
  });

  it("moves TODO-flavoured observations into pending_items and counts patterns", async () => {
    const sessionId = "sess_reflect";
    const obsKey = KV.observations(sessionId);
    const base = {
      id: "obs1",
      sessionId,
      timestamp: new Date().toISOString(),
      type: "error" as const,
      title: "TODO: wire up retries",
      subtitle: "",
      facts: [],
      narrative: "agent left a TODO for retries",
      concepts: [],
      files: ["src/retry.ts"],
      importance: 5,
    };
    await kv.set(obsKey, "obs1", base);
    await kv.set(obsKey, "obs2", {
      ...base,
      id: "obs2",
      title: "compile error",
      narrative: "tsc failed",
      files: ["src/other.ts"],
      type: "error",
    });
    const res = (await handlers["mem::slot-reflect"]({ project: "fixture-project", sessionId })) as {
      success: boolean;
      applied: number;
      observationsReviewed: number;
    };
    expect(res.success).toBe(true);
    expect(res.observationsReviewed).toBe(2);
    expect(res.applied).toBeGreaterThan(0);

    const pending = (await handlers["mem::slot-get"]({ project: "fixture-project", label: "pending_items" })) as {
      slot: { content: string };
    };
    expect(pending.slot.content).toContain("TODO: wire up retries");

    const patterns = (await handlers["mem::slot-get"]({ project: "fixture-project", label: "session_patterns" })) as {
      slot: { content: string };
    };
    expect(patterns.slot.content).toMatch(/errors: 2/);
  });
});


describe('exact project slot regressions', () => {
  it('keeps same labels separate across projects and excludes legacy slots from injection', async () => {
    const { kv, handlers } = wire();
    for (const project of ['A', 'B']) expect((await handlers['mem::slot-create']({ label: 'notes', content: project, project })).success).toBe(true);
    expect((await handlers['mem::slot-get']({ label: 'notes', project: 'A' })).slot).toMatchObject({content: 'A', project: 'A'});
    expect((await handlers['mem::slot-get']({ label: 'notes', project: 'B' })).slot).toMatchObject({content: 'B', project: 'B'});
    expect((await handlers['mem::slot-get']({ label: 'notes' })).success).toBe(false);
    await kv.set(KV.slots, 'legacy', { label: 'legacy', content: 'owner unknown', scope: 'project', pinned: true });
    expect((await listPinnedSlots(kv as never, 'A')).map(s => s.content)).toEqual(['A']);
    expect((await listPinnedSlots(kv as never)).map(s => s.content)).toEqual([]);
    expect((await handlers['mem::slot-get']({ label: 'legacy' })).success).toBe(true);
    expect((await handlers['mem::slot-get']({ label: 'legacy', project: 'A' })).success).toBe(false);
  });
  it('requires an exact project for new project slots', async () => {
    const { handlers } = wire();
    for (const project of [undefined, '', '*', 'x'.repeat(513), ' A', 'A ', 'A\0B']) {
      expect((await handlers['mem::slot-create']({ label: 'notes', project })).success).toBe(false);
    }
  });
});


describe('slot project management compatibility', () => {
  it('seeds only explicitly selected projects and preserves unknown legacy ownership', async () => {
    const {kv,handlers}=wire();
    await kv.set(KV.slots,'guidance',{label:'guidance',scope:'project',content:'legacy',pinned:true});
    await handlers['mem::slot-list']({scope:'global'});
    expect(await kv.list(KV.slots)).toHaveLength(1);
    for(const project of ['A','B']) {
      const listed=await handlers['mem::slot-list']({project});
      expect((listed.slots as Array<{scope:string;project?:string}>).filter(s=>s.scope==='project').every(s=>s.project===project)).toBe(true);
      expect(await kv.get(KV.slots,JSON.stringify([project,'guidance']))).toMatchObject({project,content:''});
    }
    expect(await kv.get(KV.slots,'guidance')).toMatchObject({content:'legacy'});
  });
  it('edits only the selected project, permits explicit global management, and reveals global fallback after deletion', async () => {
    const {kv,handlers}=wire();
    await handlers['mem::slot-create']({label:'shared',content:'G',scope:'global',project:'*'});
    for(const project of ['A','B']) await handlers['mem::slot-create']({label:'shared',content:project,project});
    await handlers['mem::slot-append']({label:'shared',text:'plus',project:'A'});
    await handlers['mem::slot-replace']({label:'shared',content:'GG',scope:'global',project:'A'});
    expect((await handlers['mem::slot-get']({label:'shared',project:'A'})).slot).toMatchObject({content:'A\nplus'});
    expect((await handlers['mem::slot-get']({label:'shared',project:'B'})).slot).toMatchObject({content:'B'});
    expect((await handlers['mem::slot-get']({label:'shared'})).slot).toMatchObject({content:'GG',scope:'global'});
    expect((await listPinnedSlots(kv as never,'A')).find(s=>s.label==='shared')?.content).toBe('A\nplus');
    await handlers['mem::slot-delete']({label:'shared',project:'A'});
    expect((await handlers['mem::slot-get']({label:'shared',project:'A'})).slot).toMatchObject({content:'GG',scope:'global'});
    expect((await handlers['mem::slot-get']({label:'shared',project:'B'})).slot).toMatchObject({content:'B'});
  });
  it('forwards project and scope through registered REST and MCP slot handlers', async () => {
    vi.stubEnv('AGENTMEMORY_SLOTS','true');
    try {
      const {kv,handlers}=wire();
      const sdk={registerFunction:(id:string,fn:typeof handlers[string])=>handlers[id]=fn,registerTrigger:()=>{},on:()=>{},trigger:async ({function_id,payload}:{function_id:string;payload:Record<string,unknown>})=>handlers[function_id](payload)};
      registerApiTriggers(sdk as never,kv as never,async()=>({context:'',blocks:0,tokens:0}));
      registerMcpEndpoints(sdk as never,kv as never);
      const request=(body:Record<string,unknown>={},query_params:Record<string,string>={})=>({headers:{},body,query_params});
      const apiCreate=await handlers['api::slot-create'](request({label:'routed',content:'A',project:'A'}));
      expect(apiCreate.status_code).toBe(201);
      const mcpCreate=await handlers['mcp::tools::call'](request({name:'memory_slot_create',arguments:{label:'routed',content:'B',project:'B'}}));
      expect(mcpCreate.status_code).toBe(200);
      for (const operation of ['list','get','append','replace','delete']) {
        const args={label:'routed',project:'B',scope:'project',text:'extra',content:'BB'};
        const response=await handlers['mcp::tools::call'](request({name:'memory_slot_'+operation,arguments:args}));
        expect(JSON.parse((response.body as {content:Array<{text:string}>}).content[0].text).success).toBe(true);
      }
      for (const operation of ['list','get','append','replace','delete']) {
        const response=await handlers['api::slot-'+operation](request({label:'routed',project:'A',scope:'project',text:'extra',content:'AA'},{label:'routed',project:'A',scope:'project'}));
        expect(response.status_code).toBe(200);
        expect((response.body as {success:boolean}).success).toBe(true);
      }
      expect((await handlers['mem::slot-get']({label:'routed',project:'A'})).success).toBe(false);
      expect((await handlers['mem::slot-get']({label:'routed',project:'B'})).success).toBe(false);
    } finally { vi.unstubAllEnvs(); }
  });
});
