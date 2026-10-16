import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { mockKV, mockSdk } from "./helpers/mocks.js";
import { KV } from "../src/state/schema.js";
import { registerObserveFunction } from "../src/functions/observe.js";
import { getSearchIndex, setIndexPersistence } from "../src/functions/search.js";
import { lookupObservationSession } from "../src/state/obs-index.js";
import { buildSyntheticCompression } from "../src/functions/compress-synthetic.js";
import { saveImageToDisk, deleteImage } from "../src/utils/image-store.js";
import { DedupMap } from "../src/functions/dedup.js";
vi.mock("../src/logger.js",()=>({logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn()}}));
vi.mock("../src/config.js",async original=>({...await original<typeof import("../src/config.js")>(),isAutoCompressEnabled:()=>false,isGraphExtractionEnabled:()=>true}));
vi.mock("../src/functions/compress-synthetic.js",async original=>{const module=await original<typeof import("../src/functions/compress-synthetic.js")>();return{...module,buildSyntheticCompression:vi.fn(module.buildSyntheticCompression)};});
vi.mock("../src/utils/image-store.js",()=>({saveImageToDisk:vi.fn(async()=>({filePath:"f7-fixture-image",bytesWritten:4})),touchImage:vi.fn(async()=>{}),deleteImage:vi.fn(async()=>({deletedBytes:0}))}));
beforeEach(()=>{getSearchIndex().clear();setIndexPersistence(null);vi.clearAllMocks();});
afterEach(()=>{vi.restoreAllMocks();getSearchIndex().clear();setIndexPersistence(null);});
async function fixture(mode:string){
 const kv=mockKV(),sdk=mockSdk({looseTrigger:true});let fired=false;
 const payload={sessionId:"f7-fixture-session",project:"f7-fixture",cwd:"/fixture",observationId:"obs_f7_durable_00000001",hookType:"prompt_submit",timestamp:new Date().toISOString(),data:{prompt:"fixture durable retry original",image_data:"data:image/png;base64,AA=="}};
 await kv.set(KV.sessions,payload.sessionId,{id:payload.sessionId,project:payload.project,cwd:payload.cwd,status:"active",agentId:"fixture-owner",startedAt:payload.timestamp,observationCount:0});
 const set=kv.set.bind(kv),update=kv.update.bind(kv);const obsIndexScopes=new Set(Array.from({length:64},(_,n)=>KV.obsSessionIndex(n)));
 vi.spyOn(kv,"set").mockImplementation(async(scope,key,value)=>{
  const row=value as Record<string,unknown>;const raw=scope===KV.observations(payload.sessionId)&&key===payload.observationId&&!row.title;
  const synthetic=scope===KV.observations(payload.sessionId)&&key===payload.observationId&&typeof row.title==="string";
  const target=(mode.startsWith("raw-")&&raw)||(mode.startsWith("synthetic-")&&synthetic)||(mode==="ledger-before"&&scope===KV.capturePrompts)||(mode==="observation-index"&&obsIndexScopes.has(scope));
  if(!fired&&target){fired=true;if(mode.endsWith("after"))await set(scope,key,value);throw Error("injected "+mode);}
  return set(scope,key,value);
 });
 vi.spyOn(kv,"update").mockImplementation(async(scope,key,ops)=>{if(!fired&&mode.startsWith("session-")&&scope===KV.sessions){fired=true;if(mode.endsWith("after"))await update(scope,key,ops);throw Error("injected "+mode);}return update(scope,key,ops);});
 for(const id of ["stream::send","stream::set"])sdk.registerFunction(id,async()=>{if(!fired&&mode===id){fired=true;throw Error("injected "+mode);}return null;});
 if(mode.startsWith("search-index")){const add=getSearchIndex().add.bind(getSearchIndex());vi.spyOn(getSearchIndex(),"add").mockImplementationOnce(row=>{fired=true;if(mode.endsWith("after"))add(row);throw Error("injected "+mode);});}
 registerObserveFunction(sdk as never,kv as never,new DedupMap());
 return{kv,sdk,payload,fired:()=>fired};
}
for(const mode of ["raw-before","raw-after","ledger-before","session-before","session-after","synthetic-before","synthetic-after","observation-index","search-index-before","search-index-after","stream::send","stream::set"])it(`dot F7 retries required capture completion after ${mode}`,async()=>{
 const f=await fixture(mode);const first=await f.sdk.trigger("mem::observe",f.payload).catch(error=>error);
 expect(f.fired()).toBe(true);if(!mode.startsWith("stream::"))expect(first).toBeInstanceOf(Error);else expect(first).toMatchObject({observationId:f.payload.observationId});
 const retry=await f.sdk.trigger("mem::observe",f.payload);expect(retry.observationId).toBe(f.payload.observationId);
 const row=await f.kv.get<Record<string,unknown>>(KV.observations(f.payload.sessionId),f.payload.observationId);
 expect(row).toMatchObject({id:f.payload.observationId,sessionId:f.payload.sessionId,agentId:"fixture-owner",narrative:f.payload.data.prompt,imageData:"f7-fixture-image",source:{userPrompt:f.payload.data.prompt}});
 expect(typeof row?.title).toBe("string");expect(await f.kv.list(KV.observations(f.payload.sessionId))).toHaveLength(1);
 expect(await f.kv.get(KV.sessions,f.payload.sessionId)).toMatchObject({project:f.payload.project,agentId:"fixture-owner",observationCount:1});
 expect(getSearchIndex().has(f.payload.observationId)).toBe(true);expect(await lookupObservationSession(f.kv as never,f.payload.observationId)).toBe(f.payload.sessionId);
 expect(await f.kv.get(KV.imageRefs,"f7-fixture-image")).toBe(1);expect(vi.mocked(buildSyntheticCompression).mock.calls.length).toBeGreaterThan(0);
 if(mode!=="raw-before")expect(saveImageToDisk).toHaveBeenCalledTimes(1);
 if(mode!=="raw-before")expect(deleteImage).not.toHaveBeenCalled();
 const again=await f.sdk.trigger("mem::observe",f.payload);expect(again).toMatchObject({existing:true,deduplicated:true});expect(await f.kv.get(KV.sessions,f.payload.sessionId)).toMatchObject({observationCount:1});expect(await f.kv.get(KV.imageRefs,"f7-fixture-image")).toBe(1);
});

it("resumes canonical raw after handler restart without adopting a changed retry payload", async () => {
  const f = await fixture("synthetic-before");
  await expect(f.sdk.trigger("mem::observe", f.payload)).rejects.toThrow("injected synthetic-before");
  registerObserveFunction(f.sdk as never, f.kv as never, new DedupMap(), 1);
  const changed = { ...f.payload, timestamp: new Date(Date.now() + 100000).toISOString(), data: { prompt: "different retry content", image_data: "data:image/png;base64,BB==" } };
  await f.sdk.trigger("mem::observe", changed);
  expect(await f.kv.get(KV.observations(f.payload.sessionId), f.payload.observationId)).toMatchObject({ narrative: f.payload.data.prompt, timestamp: f.payload.timestamp, imageData: "f7-fixture-image", agentId: "fixture-owner" });
  expect(await f.kv.get(KV.sessions, f.payload.sessionId)).toMatchObject({ observationCount: 1, lastActivityAt: f.payload.timestamp });
  expect(await f.kv.list(KV.capturePrompts)).toHaveLength(1);
  expect(saveImageToDisk).toHaveBeenCalledTimes(1);
});

it("serializes concurrent durable retries and preserves one image reference", async () => {
  const f = await fixture("session-after");
  await expect(f.sdk.trigger("mem::observe", f.payload)).rejects.toThrow("injected session-after");
  await Promise.all([f.sdk.trigger("mem::observe", f.payload), f.sdk.trigger("mem::observe", f.payload)]);
  expect(await f.kv.list(KV.observations(f.payload.sessionId))).toHaveLength(1);
  expect(await f.kv.get(KV.sessions, f.payload.sessionId)).toMatchObject({ observationCount: 1 });
  expect(await f.kv.get(KV.imageRefs, "f7-fixture-image")).toBe(1);
  expect(saveImageToDisk).toHaveBeenCalledTimes(1);
  expect(deleteImage).not.toHaveBeenCalled();
});

it("keeps native-managed capture separate from general retry reconciliation", async () => {
  const f = await fixture("raw-before");
  await f.kv.update(KV.sessions, f.payload.sessionId, [{ type: "set", path: "codexNativeCapture", value: { version: 1 } }]);
  const result = await f.sdk.trigger("mem::observe", { ...f.payload, data: { ...f.payload.data, codex_turn_id: "native-managed-turn" } });
  expect(result).toMatchObject({ nativeSourceManaged: true, skipped: true });
  expect(f.fired()).toBe(false);
  expect(await f.kv.list(KV.observations(f.payload.sessionId))).toHaveLength(0);
  expect(saveImageToDisk).not.toHaveBeenCalled();
});

it("surfaces implicit project-index failure and repairs it after restart", async () => {
  const f = await fixture("none");
  await f.kv.delete(KV.sessions, f.payload.sessionId);
  const set = vi.mocked(f.kv.set).getMockImplementation()!;
  let fail = true;
  vi.spyOn(f.kv, "set").mockImplementation(async (scope, key, value) => {
    if (fail && scope === KV.projectSessionsIndex) { fail = false; throw Error("project index unavailable"); }
    return set(scope, key, value);
  });
  await expect(f.sdk.trigger("mem::observe", f.payload)).rejects.toThrow("project index unavailable");
  registerObserveFunction(f.sdk as never, f.kv as never, new DedupMap());
  await f.sdk.trigger("mem::observe", f.payload);
  expect(await f.kv.get(KV.projectSessionsIndex, f.payload.project)).toEqual(expect.arrayContaining([expect.objectContaining({ id: f.payload.sessionId })]));
  expect(await f.kv.get(KV.sessions, f.payload.sessionId)).toMatchObject({ observationCount: 1 });
  expect(getSearchIndex().has(f.payload.observationId)).toBe(true);
  expect(saveImageToDisk).toHaveBeenCalledTimes(1);
});

it("resumes pre-native Codex capture and retains its turn source", async () => {
  const f = await fixture("ledger-before");
  const payload = { ...f.payload, data: { ...f.payload.data, codex_turn_id: "pre-native-turn" } };
  await expect(f.sdk.trigger("mem::observe", payload)).rejects.toThrow("injected ledger-before");
  registerObserveFunction(f.sdk as never, f.kv as never, new DedupMap());
  await f.sdk.trigger("mem::observe", payload);
  expect(await f.kv.get(KV.sessions, payload.sessionId)).toMatchObject({ observationCount: 1, codexCaptureTurnId: "pre-native-turn", semanticGraphStatus: "pending" });
  expect(getSearchIndex().has(payload.observationId)).toBe(true);
  expect(await f.kv.get(KV.imageRefs, "f7-fixture-image")).toBe(1);
});
