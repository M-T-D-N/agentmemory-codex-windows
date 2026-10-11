import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { registerContextFunction } from "../src/functions/context.js";
import { registerApiTriggers } from "../src/triggers/api.js";
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

type ContextHandler = (data: {
  sessionId: string;
  project: string;
  budget?: number;
}) => Promise<{ context: string; blocks: number; tokens: number }>;

function wireContext(kv: ReturnType<typeof mockKV>) {
  let handler: ContextHandler | undefined;
  const sdk = {
    registerFunction: vi.fn((id: string, cb: ContextHandler) => {
      if (id === "mem::context") handler = cb;
    }),
  } as unknown as import("iii-sdk").IIIClient;
  registerContextFunction(sdk, kv as never, 2000);
  if (!handler) throw new Error("mem::context not registered");
  return handler;
}

async function seedPinnedSlot(
  kv: ReturnType<typeof mockKV>,
  label: string,
  content: string,
  scope: "project" | "global" = "global",
) {
  const target = scope === "global" ? KV.globalSlots : KV.slots;
  await kv.set(target, scope === "project" ? JSON.stringify(["/tmp/proj", label]) : label, {
    label,
    content,
    description: "",
    sizeLimit: 2000,
    pinned: true,
    readOnly: false,
    scope,
    ...(scope === "project" ? { project: "/tmp/proj" } : {}),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

describe("mem::context — pinned slot injection", () => {
  const ORIGINAL_SLOTS_ENV = process.env["AGENTMEMORY_SLOTS"];

  afterEach(() => {
    if (ORIGINAL_SLOTS_ENV === undefined) {
      delete process.env["AGENTMEMORY_SLOTS"];
    } else {
      process.env["AGENTMEMORY_SLOTS"] = ORIGINAL_SLOTS_ENV;
    }
  });

  describe("when AGENTMEMORY_SLOTS=true", () => {
    let kv: ReturnType<typeof mockKV>;
    let handler: ContextHandler;

    beforeEach(() => {
      process.env["AGENTMEMORY_SLOTS"] = "true";
      kv = mockKV();
      handler = wireContext(kv);
    });

    it("includes pinned global slot content in returned context", async () => {
      await seedPinnedSlot(kv, "tool_guidelines", "rule-alpha", "global");

      const result = await handler({
        sessionId: "ses_a",
        project: "/tmp/proj",
      });

      expect(result.context).toContain("tool_guidelines");
      expect(result.context).toContain("rule-alpha");
      expect(result.blocks).toBeGreaterThan(0);
    });

    it("renders multiple pinned slots, sorted by label", async () => {
      await seedPinnedSlot(kv, "user_preferences", "pref-alpha", "global");
      await seedPinnedSlot(kv, "tool_guidelines", "rule-alpha", "global");

      const result = await handler({
        sessionId: "ses_b",
        project: "/tmp/proj",
      });

      const guidelinesIdx = result.context.indexOf("tool_guidelines");
      const prefsIdx = result.context.indexOf("user_preferences");
      expect(guidelinesIdx).toBeGreaterThan(-1);
      expect(prefsIdx).toBeGreaterThan(-1);
      expect(guidelinesIdx).toBeLessThan(prefsIdx);
    });

    it("skips unpinned slots even when they have content", async () => {
      await kv.set(KV.globalSlots, "self_notes", {
        label: "self_notes",
        content: "unpinned-content-alpha",
        description: "",
        sizeLimit: 1500,
        pinned: false,
        readOnly: false,
        scope: "global",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const result = await handler({
        sessionId: "ses_c",
        project: "/tmp/proj",
      });

      expect(result.context).not.toContain("unpinned-content-alpha");
    });

    it("skips empty pinned slots (the seeded defaults)", async () => {
      await seedPinnedSlot(kv, "persona", "", "global");

      const result = await handler({
        sessionId: "ses_d",
        project: "/tmp/proj",
      });

      expect(result.context).not.toContain("persona");
    });

    it("project-scoped slot shadows global slot with the same label", async () => {
      await seedPinnedSlot(kv, "tool_guidelines", "global-value", "global");
      await seedPinnedSlot(kv, "tool_guidelines", "project-value", "project");

      const result = await handler({
        sessionId: "ses_e",
        project: "/tmp/proj",
      });

      expect(result.context).toContain("project-value");
      expect(result.context).not.toContain("global-value");
    });
  });

  describe("when AGENTMEMORY_SLOTS is off", () => {
    it("does not include any slot content", async () => {
      delete process.env["AGENTMEMORY_SLOTS"];
      const kv = mockKV();
      const handler = wireContext(kv);

      await seedPinnedSlot(kv, "tool_guidelines", "rule-alpha", "global");

      const result = await handler({
        sessionId: "ses_f",
        project: "/tmp/proj",
      });

      expect(result.context).not.toContain("tool_guidelines");
      expect(result.context).not.toContain("rule-alpha");
    });
  });
});


describe('session start project slot isolation',()=>{
  it('injects only the exact project slots plus globals through the registered session/start entry',async()=>{
    vi.stubEnv('AGENTMEMORY_SLOTS','true');
    try {
      const kv=mockKV(); const readContext=wireContext(kv);
      await seedPinnedSlot(kv,'shared','global context','global');
      await seedPinnedSlot(kv,'shared','project A context','project');
      await kv.set(KV.slots,'legacy',{label:'legacy',content:'unknown legacy context',scope:'project',pinned:true});
      const handlers=new Map<string,(data:unknown)=>Promise<any>>();
      const sdk={registerFunction:(id:string,fn:(data:unknown)=>Promise<any>)=>handlers.set(id,fn),registerTrigger:()=>{},on:()=>{},trigger:async()=>({})};
      registerApiTriggers(sdk as never,kv as never,readContext);
      const start=handlers.get('api::session::start')!;
      const a=await start({headers:{},body:{sessionId:'a',project:'/tmp/proj',cwd:'/tmp/proj'}});
      expect(a.status_code).toBe(200); expect(a.body.context).toContain('project A context'); expect(a.body.context).not.toContain('global context');
      const b=await start({headers:{},body:{sessionId:'b',project:'B',cwd:'/tmp/B'}});
      expect(b.status_code).toBe(200); expect(b.body.context).toContain('global context'); expect(b.body.context).not.toContain('project A context'); expect(b.body.context).not.toContain('unknown legacy context');
    }finally{vi.unstubAllEnvs();}
  });
});
