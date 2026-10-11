import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerRememberFunction } from "../src/functions/remember.js";
import {
  getSearchIndex,
  rebuildIndex,
  setVectorIndex,
  setEmbeddingProvider,
  setIndexPersistence,
  vectorIndexAddGuarded,
} from "../src/functions/search.js";
import { logger } from "../src/logger.js";
import { VectorIndex } from "../src/state/vector-index.js";
import { KV } from "../src/state/schema.js";
import type { EmbeddingProvider, Memory } from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    assertRecoveryImportAllowed: () => {},
    hasObservationRecovery: () => false,
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
    trigger: async (input: { function_id: string; payload: unknown }) => {
      const fn = functions.get(input.function_id);
      if (!fn) return null;
      return fn(input.payload);
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type RememberResult = {
  success: boolean;
  memory: Memory;
};

describe("mem::remember lock scope", () => {
  const EMBED_DELAY_MS = 60;
  let vectorIndex: VectorIndex;
  let embedCalls: Array<{ start: number; end: number }>;

  beforeEach(() => {
    getSearchIndex().clear();
    vectorIndex = new VectorIndex();
    setVectorIndex(vectorIndex);
    embedCalls = [];
    const slowEmbedder: EmbeddingProvider = {
      name: "slow-test",
      dimensions: 3,
      embed: async (_text: string) => {
        const start = Date.now();
        await delay(EMBED_DELAY_MS);
        embedCalls.push({ start, end: Date.now() });
        return new Float32Array([0.1, 0.2, 0.3]);
      },
      embedBatch: async (texts: string[]) =>
        texts.map(() => new Float32Array([0.1, 0.2, 0.3])),
    };
    setEmbeddingProvider(slowEmbedder);
  });

  afterEach(() => {
    setVectorIndex(null);
    setEmbeddingProvider(null);
  });

  it("keeps identical memories and near-match hints within their exact project and agent owner", async () => {
    setEmbeddingProvider(null);
    const sdk=mockSdk(), kv=mockKV(); registerRememberFunction(sdk as never,kv as never);
    const save=(agentId:string, content="same deployment pipeline health rollout")=>sdk.trigger({function_id:"mem::remember",payload:{content,project:"p",agentId}}) as Promise<RememberResult>;
    const a=await save("A"), b=await save("B");
    expect(b.memory.parentId).toBeUndefined(); expect(b.memory.version).toBe(1);
    expect(await kv.get(KV.memories,a.memory.id)).toMatchObject({isLatest:true,agentId:"A"});
    const next=await save("A"); expect(next.memory.parentId).toBe(a.memory.id);
    expect(await kv.get(KV.memories,b.memory.id)).toMatchObject({isLatest:true,agentId:"B"});
  });
  it("does not let foreign index hits consume the replacement candidate limit", async () => {
    setEmbeddingProvider(null);
    const sdk=mockSdk(), kv=mockKV(); registerRememberFunction(sdk as never,kv as never);
    const base: Memory={id:"mem_own",project:"p",agentId:"A",content:"same deployment pipeline health rollout",title:"same deployment pipeline health rollout",createdAt:"2026-10-01T00:00:00Z",updatedAt:"2026-10-01T00:00:00Z",type:"fact",concepts:[],files:[],sessionIds:[],strength:7,version:1,isLatest:true};
    for(let i=0;i<60;i++)await kv.set(KV.memories,"mem_foreign"+i,{...base,id:"mem_foreign"+i,agentId:"B"});
    await kv.set(KV.memories,base.id,base);await rebuildIndex(kv as never);
    const result=await sdk.trigger({function_id:"mem::remember",payload:{content:base.content,project:"p",agentId:"A"}}) as RememberResult;
    expect(result.memory.parentId).toBe(base.id);
    expect((await kv.list<Memory>(KV.memories)).filter(row=>row.agentId==="B" && row.isLatest)).toHaveLength(60);
  });

  it("leaves the prior canonical head and its index intact when successor persistence fails", async () => {
    setEmbeddingProvider(null);
    const sdk=mockSdk(), kv=mockKV(); registerRememberFunction(sdk as never,kv as never);
    const payload={content:"same deployment pipeline health rollout",project:"p",agentId:"A"};
    const first=await sdk.trigger({function_id:"mem::remember",payload}) as RememberResult;
    const original=structuredClone(first.memory), set=kv.set;
    kv.set=async (scope,key,value)=>{if(scope===KV.memories && key!==first.memory.id)throw Error("successor failed");return set(scope,key,value);};
    await expect(sdk.trigger({function_id:"mem::remember",payload})).rejects.toThrow("successor failed");
    expect(await kv.get(KV.memories,first.memory.id)).toEqual(original);
    expect(getSearchIndex().has(first.memory.id)).toBe(true);
  });
  it("serializes forget with replacement, so forgetting a loaded head cannot be undone by a stale save", async () => {
    setEmbeddingProvider(null);
    const sdk=mockSdk(), kv=mockKV(); registerRememberFunction(sdk as never,kv as never);
    const payload={content:"same deployment pipeline health rollout",project:"p",agentId:"A"};
    const first=await sdk.trigger({function_id:"mem::remember",payload}) as RememberResult;
    const set=kv.set; let release!:()=>void, started!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;}), entered=new Promise<void>(resolve=>{started=resolve;});
    kv.set=async (scope,key,value)=>{if(scope===KV.memories && key!==first.memory.id){started();await gate;}return set(scope,key,value);};
    const replacement=sdk.trigger({function_id:"mem::remember",payload}); await entered;
    let forgotten=false;
    const forget=sdk.trigger({function_id:"mem::forget",payload:{memoryId:first.memory.id,project:"p"}}).then(result=>{forgotten=true;return result;});
    try {await delay(10); expect(forgotten).toBe(false);} finally {release();}
    await replacement; await forget;
    expect(await kv.get(KV.memories,first.memory.id)).toBeNull();
  });
  it("rebuild after a successor ACK loss selects the persisted successor without reviving its ancestor", async () => {
    setEmbeddingProvider(null);
    const sdk=mockSdk(), kv=mockKV(); registerRememberFunction(sdk as never,kv as never);
    const payload={content:"same deployment pipeline health rollout",project:"p",agentId:"A"};
    const first=await sdk.trigger({function_id:"mem::remember",payload}) as RememberResult;
    const set=kv.set; let successorId="";
    kv.set=async (scope,key,value)=>{const result=await set(scope,key,value);if(scope===KV.memories && key!==first.memory.id){successorId=key;throw Error("ACK lost");}return result;};
    await expect(sdk.trigger({function_id:"mem::remember",payload})).rejects.toThrow("ACK lost");
    expect(await kv.get(KV.memories,first.memory.id)).toMatchObject({isLatest:true});
    expect(await kv.get(KV.memories,successorId)).toMatchObject({isLatest:true,parentId:first.memory.id});
    getSearchIndex().clear(); await rebuildIndex(kv as never);
    expect(getSearchIndex().has(successorId)).toBe(true); expect(getSearchIndex().has(first.memory.id)).toBe(false);
    kv.set = set;
    await sdk.trigger({function_id:"mem::forget",payload:{memoryId:successorId,project:"p"}});
    expect(await kv.get(KV.memories,first.memory.id)).toMatchObject({isLatest:false});
    getSearchIndex().clear(); await rebuildIndex(kv as never);
    expect(getSearchIndex().size).toBe(0);
  });

  it("overlaps embedding time across concurrent saves instead of serializing behind the mem:remember lock", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerRememberFunction(sdk as never, kv as never);

    await Promise.all([
      sdk.trigger({
        function_id: "mem::remember",
        payload: {
          content: "alpha content about the deploy pipeline rollout gates",
          type: "fact",
        },
      }),
      sdk.trigger({
        function_id: "mem::remember",
        payload: {
          content: "bravo content about a completely unrelated caching layer",
          type: "fact",
        },
      }),
    ]);

    expect(embedCalls).toHaveLength(2);
    const [a, b] = embedCalls;
    expect(a.start).toBeLessThan(b.end);
    expect(b.start).toBeLessThan(a.end);
  });

  it("still dedups two identical saves fired concurrently, even with a slow embedder", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerRememberFunction(sdk as never, kv as never);

    const content =
      "the deploy pipeline uses blue green rollout with health gates";
    const [first, second] = (await Promise.all([
      sdk.trigger({
        function_id: "mem::remember",
        payload: { content, type: "architecture" },
      }),
      sdk.trigger({
        function_id: "mem::remember",
        payload: { content, type: "architecture" },
      }),
    ])) as RememberResult[];

    expect(first.memory.version).toBe(1);
    expect(second.memory.version).toBe(2);
    expect(second.memory.supersedes).toContain(first.memory.id);
    expect(second.memory.parentId).toBe(first.memory.id);

    const stored = await kv.get<Memory>(KV.memories, first.memory.id);
    expect(stored?.isLatest).toBe(false);
  });

  it("keeps a superseded memory out of the vector index even when its embedding finishes after the second save removes it", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerRememberFunction(sdk as never, kv as never);

    const content =
      "the deploy pipeline uses blue green rollout with health gates";
    const [first, second] = (await Promise.all([
      sdk.trigger({
        function_id: "mem::remember",
        payload: { content, type: "architecture" },
      }),
      sdk.trigger({
        function_id: "mem::remember",
        payload: { content, type: "architecture" },
      }),
    ])) as RememberResult[];

    const results = vectorIndex.search(new Float32Array([0.1, 0.2, 0.3]), 10);
    const indexedIds = results.map((r) => r.obsId);
    expect(indexedIds).not.toContain(first.memory.id);
    expect(indexedIds).toContain(second.memory.id);
    expect(vectorIndex.size).toBe(1);
  });

  it("schedules an index save after the deferred vector-index commit lands", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerRememberFunction(sdk as never, kv as never);
    const scheduleSave = vi.fn();
    setIndexPersistence({ scheduleSave, save: vi.fn(async () => {}) });

    try {
      await sdk.trigger({
        function_id: "mem::remember",
        payload: {
          content: "schedule an index save after the vector commit lands",
          type: "fact",
        },
      });

      expect(scheduleSave.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      setIndexPersistence(null);
    }
  });

  it("logs a vector-index commit failure distinctly from an embed failure", async () => {
    const failingCommit = vi.fn(async () => {
      throw new Error("kv unavailable");
    });

    const result = await vectorIndexAddGuarded(
      "mem_commit_fail",
      "memory",
      "some memory text",
      { kind: "memory", logId: "mem_commit_fail" },
      failingCommit,
    );

    expect(result).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      "vector-index add: commit failed — skipping",
      expect.objectContaining({ id: "mem_commit_fail" }),
    );
    expect(logger.warn).not.toHaveBeenCalledWith(
      "vector-index add: embed failed — skipping",
      expect.anything(),
    );
  });
});


describe("remember and source forget ordering", () => {
  it.each([false, true])("keeps source deletion behind a validated save (whole session: %s)", async whole => {
    setEmbeddingProvider(null);
    const sdk = mockSdk(), kv = mockKV(); registerRememberFunction(sdk as never, kv as never);
    const session = { id: "source_session", project: "p", cwd: "/fixture", status: "active", startedAt: "2026-10-10T00:00:00Z", observationCount: 1 };
    const obs = { id: "source_observation", sessionId: session.id, timestamp: session.startedAt, title: "original", type: "decision", narrative: "proof", concepts: [], files: [] };
    await kv.set(KV.sessions, session.id, session); await kv.set(KV.observations(session.id), obs.id, obs);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { entered = r; });
    const set = kv.set;
    kv.set = async (scope, id, value) => { if (scope === KV.memories) { entered(); await gate; } return set(scope, id, value); };
    const payload = { content: "new provenance decision", project: "p", sources: [{ sessionId: session.id, observationIds: [obs.id] }] };
    const saved = sdk.trigger({ function_id: "mem::remember", payload }); await started;
    let deleted = false;
    const forgetting = sdk.trigger({ function_id: "mem::forget", payload: { sessionId: session.id, project: "p", ...(whole ? {} : { observationIds: [obs.id] }) } }).then(r => { deleted = true; return r; });
    try { await delay(10); expect(deleted).toBe(false); expect(await kv.get(KV.observations(session.id), obs.id)).toEqual(obs); } finally { release(); }
    expect(await saved).toMatchObject({ success: true }); await forgetting;
    const count = (await kv.list(KV.memories)).length;
    expect(await sdk.trigger({ function_id: "mem::remember", payload })).toMatchObject({ success: false });
    expect(await kv.list(KV.memories)).toHaveLength(count);
  });
  it("rejects a save queued behind a source deletion", async () => {
    setEmbeddingProvider(null);
    const sdk = mockSdk(), kv = mockKV(); registerRememberFunction(sdk as never, kv as never);
    const session = { id: "source_session", project: "p", cwd: "/fixture", status: "active", startedAt: "2026-10-10T00:00:00Z", observationCount: 1 };
    const obs = { id: "source_observation", sessionId: session.id, timestamp: session.startedAt, title: "original", type: "decision", narrative: "proof", concepts: [], files: [] };
    await kv.set(KV.sessions, session.id, session); await kv.set(KV.observations(session.id), obs.id, obs);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { entered = r; });
    const remove = kv.delete;
    kv.delete = async (scope, id) => { if (scope === KV.observations(session.id)) { entered(); await gate; } return remove(scope, id); };
    const forgetting = sdk.trigger({ function_id: "mem::forget", payload: { sessionId: session.id, observationIds: [obs.id], project: "p" } }); await started;
    let finished = false;
    const saving = sdk.trigger({ function_id: "mem::remember", payload: { content: "must not commit removed source", project: "p", sources: [{ sessionId: session.id, observationIds: [obs.id] }] } }).then(r => { finished = true; return r; });
    try { await delay(10); expect(finished).toBe(false); } finally { release(); }
    await forgetting; expect(await saving).toMatchObject({ success: false }); expect(await kv.list(KV.memories)).toHaveLength(0);
  });
});
