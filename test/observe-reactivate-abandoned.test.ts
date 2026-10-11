import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    store,
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    update: async (
      scope: string,
      key: string,
      updates: Array<{ type: string; path: string; value?: unknown }>,
    ): Promise<void> => {
      const m = store.get(scope);
      if (!m) return;
      const v = (m.get(key) as Record<string, unknown>) ?? {};
      for (const u of updates) {
        if (u.type === "remove") delete v[u.path];
        else v[u.path] = u.value;
      }
      m.set(key, v);
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const m = store.get(scope);
      return m ? (Array.from(m.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const fns = new Map<string, Function>();
  return {
    fns,
    registerFunction: (idOrOpts: string | { id: string }, fn: Function) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      fns.set(id, fn);
    },
    registerTrigger: () => {},
    trigger: async (
      idOrInput: string | { function_id: string; payload: unknown; action?: unknown },
      data?: unknown,
    ) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = fns.get(id);
      if (fn) return fn(payload);
      return null;
    },
  };
}

function seedSession(store: Map<string, Map<string, unknown>>, id: string, status: string) {
  if (!store.has("mem:sessions")) store.set("mem:sessions", new Map());
  store.get("mem:sessions")!.set(id, {
    id,
    project: "/home/user/myrepo",
    cwd: "/home/user/myrepo",
    startedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    status,
    observationCount: 3,
    ...(status === "abandoned" ? { endedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() } : {}),
  });
}

describe("observe reactivates abandoned sessions", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("sets an abandoned session back to active and clears endedAt on new activity", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const sdk = mockSdk();
    const kv = mockKV();
    seedSession(kv.store, "ses_reactivated", "abandoned");
    registerObserveFunction(sdk as never, kv as never);

    await sdk.trigger("mem::observe", {
      sessionId: "ses_reactivated",
      project: "/home/user/myrepo",
      cwd: "/home/user/myrepo",
      hookType: "post_tool_use",
      timestamp: new Date().toISOString(),
      data: { tool_name: "Read", tool_input: { file_path: "x.ts" } },
    });

    const session = kv.store.get("mem:sessions")!.get("ses_reactivated") as Record<string, unknown>;
    expect(session.status).toBe("active");
    expect("endedAt" in session).toBe(false);
    expect(session.observationCount).toBe(4);
  });

  it("does not touch the status of an active session", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const sdk = mockSdk();
    const kv = mockKV();
    seedSession(kv.store, "ses_active", "active");
    registerObserveFunction(sdk as never, kv as never);

    await sdk.trigger("mem::observe", {
      sessionId: "ses_active",
      project: "/home/user/myrepo",
      cwd: "/home/user/myrepo",
      hookType: "post_tool_use",
      timestamp: new Date().toISOString(),
      data: { tool_name: "Read", tool_input: { file_path: "y.ts" } },
    });

    const session = kv.store.get("mem:sessions")!.get("ses_active") as Record<string, unknown>;
    expect(session.status).toBe("active");
    expect(session.endedAt).toBeUndefined();
    expect(session.observationCount).toBe(4);
  });
});


describe('native managed observe activity',()=>{
  it.each(['live','backfill','future','ambient','assistant'])('handles %s hook activity without storing duplicate original bodies',async(kind)=>{
    const {registerObserveFunction}=await import('../src/functions/observe.js');
    const sdk=mockSdk();const kv=mockKV();seedSession(kv.store,'native','abandoned');
    const prior=kv.store.get('mem:sessions')!.get('native') as Record<string,unknown>;
    const lastActivityAt=new Date(Date.now()-48*60*60*1000).toISOString();
    kv.store.get('mem:sessions')!.set('native',{...prior,lastActivityAt,codexNativeCapture:{version:1}});
    registerObserveFunction(sdk as never,kv as never);
    const timestamp=new Date(Date.now()+(kind==='future'?60*60*1000:-1000)).toISOString();
    const data=kind==='assistant'?{tool_name:'assistant_response',tool_output:'late final',codex_turn_id:'turn-live'}:{prompt:kind==='ambient'?'<subagent_notification>internal</subagent_notification>':'new user request',codex_turn_id:'turn-live',...(kind==='backfill'?{backfill:true}:{})};
    await sdk.trigger('mem::observe',{sessionId:'native',project:'/home/user/myrepo',cwd:'/home/user/myrepo',hookType:kind==='assistant'?'post_tool_use':'prompt_submit',timestamp,data});
    const updated=await kv.get<Record<string,unknown>>('mem:sessions','native');
    expect(updated!.status).toBe(kind==='live'?'active':'abandoned');
    expect(updated!.lastActivityAt).toBe(kind==='live'?timestamp:lastActivityAt);
    expect(await kv.list('mem:obs:native')).toEqual([]);
    if(kind==='live')expect(updated).not.toHaveProperty('endedAt');
  });
});
