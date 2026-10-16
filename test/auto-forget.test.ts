import { withKeyedLock } from "../src/state/keyed-mutex.js";
import { registerArchiveFunctions } from "../src/functions/archive-tools.js";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mockKV as createMockKV } from "./helpers/mocks.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerAutoForgetFunction } from "../src/functions/auto-forget.js";
import {
  getSearchIndex,
  setIndexPersistence,
} from "../src/functions/search.js";
import { memoryToObservation } from "../src/state/memory-utils.js";
import type { Memory, CompressedObservation, Session } from "../src/types.js";

function mockKV() {
  return {
    ...createMockKV(),
    assertRecoveryImportAllowed: () => {},
    hasObservationRecovery: () => false,
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

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "mem_1",
    project: "project",
    agentId: "owner",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    type: "pattern",
    title: "Test memory",
    content: "This is a test memory with enough words for comparison",
    concepts: ["test"],
    files: [],
    sessionIds: ["ses_1"],
    strength: 5,
    version: 1,
    isLatest: true,
    ...overrides,
  };
}

describe("Auto-Forget Function", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    registerAutoForgetFunction(sdk as never, kv as never);
  });

  it("detects and deletes TTL-expired memories", async () => {
    const expired = makeMemory({
      id: "mem_expired",
      forgetAfter: "2020-01-01T00:00:00Z",
    });
    await kv.set("mem:memories", "mem_expired", expired);

    const result = (await sdk.trigger("mem::auto-forget", {})) as {
      ttlExpired: string[];
    };

    expect(result.ttlExpired).toContain("mem_expired");
    const deleted = await kv.get("mem:memories", "mem_expired");
    expect(deleted).toBeNull();
  });

  it("detects contradiction between very similar memories", async () => {
    const mem1 = makeMemory({
      id: "mem_1",
      content: "Use React hooks for state management in all components",
      createdAt: "2026-01-01T00:00:00Z",
    });
    const mem2 = makeMemory({
      id: "mem_2",
      content: "Use React hooks for state management in all components",
      createdAt: "2026-02-01T00:00:00Z",
    });
    await kv.set("mem:memories", "mem_1", mem1);
    await kv.set("mem:memories", "mem_2", mem2);

    const result = (await sdk.trigger("mem::auto-forget", {})) as {
      contradictions: Array<{
        memoryA: string;
        memoryB: string;
        similarity: number;
      }>;
    };

    expect(result.contradictions.length).toBe(1);
    const older = await kv.get<Memory>("mem:memories", "mem_1");
    expect(older!.isLatest).toBe(false);
  });

  it("evicts low-value old observations", async () => {
    const session: Session = {
      id: "ses_1",
      project: "my-project",
      cwd: "/tmp",
      startedAt: "2025-01-01T00:00:00Z",
      status: "completed",
      observationCount: 1,
    };
    await kv.set("mem:sessions", "ses_1", session);

    const oldLowObs: CompressedObservation = {
      id: "obs_old",
      sessionId: "ses_1",
      timestamp: "2025-01-01T00:00:00Z",
      type: "other",
      title: "trivial event",
      facts: [],
      narrative: "nothing important",
      concepts: [],
      files: [],
      importance: 1,
    };
    await kv.set("mem:obs:ses_1", "obs_old", oldLowObs);

    const result = (await sdk.trigger("mem::auto-forget", {})) as {
      lowValueObs: string[];
    };

    expect(result.lowValueObs).toContain("obs_old");
  });

  it("dryRun mode identifies but does not delete anything", async () => {
    const expired = makeMemory({
      id: "mem_expired",
      forgetAfter: "2020-01-01T00:00:00Z",
    });
    await kv.set("mem:memories", "mem_expired", expired);

    const result = (await sdk.trigger("mem::auto-forget", { dryRun: true })) as {
      ttlExpired: string[];
      dryRun: boolean;
    };

    expect(result.dryRun).toBe(true);
    expect(result.ttlExpired).toContain("mem_expired");

    const stillExists = await kv.get("mem:memories", "mem_expired");
    expect(stillExists).not.toBeNull();
  });

  describe("search-index cleanup", () => {
    beforeEach(() => {
      getSearchIndex().clear();
      setIndexPersistence(null);
    });

    afterEach(() => {
      setIndexPersistence(null);
    });

    it("removes TTL-expired memories from the BM25 index and flushes persistence", async () => {
      const persistence = { scheduleSave: vi.fn(), save: vi.fn(async () => {}) };
      setIndexPersistence(persistence);

      const expired = makeMemory({
        id: "mem_expired",
        forgetAfter: "2020-01-01T00:00:00Z",
      });
      await kv.set("mem:memories", "mem_expired", expired);
      getSearchIndex().add(memoryToObservation(expired));
      expect(getSearchIndex().has("mem_expired")).toBe(true);

      await sdk.trigger("mem::auto-forget", {});

      expect(getSearchIndex().has("mem_expired")).toBe(false);
      expect(persistence.save).toHaveBeenCalled();
    });

    it("removes evicted low-value observations from the BM25 index", async () => {
      const session: Session = {
        id: "ses_1",
        project: "my-project",
        cwd: "/tmp",
        startedAt: "2025-01-01T00:00:00Z",
        status: "completed",
        observationCount: 1,
      };
      await kv.set("mem:sessions", "ses_1", session);

      const oldLowObs: CompressedObservation = {
        id: "obs_old",
        sessionId: "ses_1",
        timestamp: "2025-01-01T00:00:00Z",
        type: "other",
        title: "trivial event",
        facts: [],
        narrative: "nothing important",
        concepts: [],
        files: [],
        importance: 1,
      };
      await kv.set("mem:obs:ses_1", "obs_old", oldLowObs);
      getSearchIndex().add(oldLowObs);
      expect(getSearchIndex().has("obs_old")).toBe(true);

      await sdk.trigger("mem::auto-forget", {});

      expect(getSearchIndex().has("obs_old")).toBe(false);
    });

    it("does not flush persistence on dryRun", async () => {
      const persistence = { scheduleSave: vi.fn(), save: vi.fn(async () => {}) };
      setIndexPersistence(persistence);

      const expired = makeMemory({
        id: "mem_expired",
        forgetAfter: "2020-01-01T00:00:00Z",
      });
      await kv.set("mem:memories", "mem_expired", expired);
      getSearchIndex().add(memoryToObservation(expired));

      await sdk.trigger("mem::auto-forget", { dryRun: true });

      // dryRun must not mutate the index or write to disk.
      expect(getSearchIndex().has("mem_expired")).toBe(true);
      expect(persistence.save).not.toHaveBeenCalled();
    });
  });

  it("does not flag non-similar memories as contradictions", async () => {
    const mem1 = makeMemory({
      id: "mem_1",
      content: "We use TypeScript with strict mode enabled for all backend services",
    });
    const mem2 = makeMemory({
      id: "mem_2",
      content: "The deployment pipeline runs integration tests before merging to main",
    });
    await kv.set("mem:memories", "mem_1", mem1);
    await kv.set("mem:memories", "mem_2", mem2);

    const result = (await sdk.trigger("mem::auto-forget", {})) as {
      contradictions: unknown[];
    };

    expect(result.contradictions.length).toBe(0);
  });
});


describe("dot F1 auto-forget owner boundaries", () => {
 it.each([
  ["different project", {project:"other",agentId:"owner"}],
  ["different agent", {project:"project",agentId:"other"}],
  ["missing project", {project:undefined,agentId:"owner"}],
  ["missing owner", {project:"project",agentId:undefined}],
  ["unknown legacy ownership", {project:undefined,agentId:undefined}],
 ])("preserves older memory for %s",async(_,scope)=>{
  const sdk=mockSdk(),kv=mockKV();registerAutoForgetFunction(sdk as never,kv as never);
  const older=makeMemory({id:"old-scope",project:"project",agentId:"owner",createdAt:"2026-01-01T00:00:00Z"});
  const newer=makeMemory({id:"new-scope",...scope,createdAt:"2026-02-01T00:00:00Z"});
  await kv.set("mem:memories",older.id,older);await kv.set("mem:memories",newer.id,newer);
  getSearchIndex().add(memoryToObservation(older));
  const result=await sdk.trigger("mem::auto-forget",{});
  expect(result.contradictions).toEqual([]);
  expect((await kv.get<Memory>("mem:memories",older.id))?.isLatest).toBe(true);
  expect(getSearchIndex().has(older.id)).toBe(true);
  getSearchIndex().remove(older.id);
 });
});


describe("dot F1 canonical and lock revalidation",()=>{
 const pair=async()=>{const sdk=mockSdk(),kv=mockKV();registerAutoForgetFunction(sdk as never,kv as never);const old=makeMemory({id:"canonical-old",createdAt:"2026-01-01T00:00:00Z"}),newer=makeMemory({id:"canonical-new",createdAt:"2026-02-01T00:00:00Z"});await kv.set("mem:memories",old.id,old);await kv.set("mem:memories",newer.id,newer);return{sdk,kv,old,newer};};
 it("reports same-owner candidates in dry run without changing head or index",async()=>{
  const f=await pair();getSearchIndex().add(memoryToObservation(f.old));const result=await f.sdk.trigger("mem::auto-forget",{dryRun:true});expect(result.contradictions).toHaveLength(1);expect(await f.kv.get("mem:memories",f.old.id)).toEqual(f.old);expect(getSearchIndex().has(f.old.id)).toBe(true);getSearchIndex().remove(f.old.id);
 });
 it("rechecks canonical owner after comparison selection",async()=>{
  const f=await pair(),get=f.kv.get.bind(f.kv);let changed=false;
  vi.spyOn(f.kv,"get").mockImplementation(async(scope,key)=>{if(!changed&&scope==="mem:memories"&&key===f.old.id){changed=true;await f.kv.set(scope,key,{...f.old,agentId:"new-owner"});}return get(scope,key);});
  const result=await f.sdk.trigger("mem::auto-forget",{});expect(changed).toBe(true);expect(result.contradictions).toEqual([]);expect(await f.kv.get("mem:memories",f.old.id)).toMatchObject({isLatest:true,agentId:"new-owner"});
 });
 it("waits for the remember lock and uses the changed canonical scope",async()=>{
  const f=await pair();let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);let finished=false;
  const remembering=withKeyedLock("mem:remember",async()=>{entered();await gate;await f.kv.set("mem:memories",f.old.id,{...f.old,project:"other-project"});});await ready;
  const forgetting=f.sdk.trigger("mem::auto-forget",{}).then(r=>{finished=true;return r;});await new Promise(r=>setTimeout(r,10));expect(finished).toBe(false);release();await remembering;
  expect((await forgetting).contradictions).toEqual([]);expect(await f.kv.get("mem:memories",f.old.id)).toMatchObject({isLatest:true,project:"other-project"});
 });
 it("preserves an officially archived same-owner duplicate",async()=>{
  const f=await pair();registerArchiveFunctions(f.sdk as never,f.kv as never);const target={kind:"memory",id:f.old.id};const preview=await f.sdk.trigger("mem::archive",{project:"project",target,action:"archive"});
  await f.sdk.trigger("mem::archive",{project:"project",target,action:"archive",dryRun:false,expectedRevision:preview.expectedRevision,expectedDigest:preview.expectedDigest,reason:"keep evidence"});
  expect((await f.sdk.trigger("mem::auto-forget",{})).contradictions).toEqual([]);expect(await f.kv.get("mem:memories",f.old.id)).toEqual(f.old);
 });
});
