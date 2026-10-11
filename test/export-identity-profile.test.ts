import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mockKV, mockSdk } from "./helpers/mocks.js";
import { registerExportImportFunction } from "../src/functions/export-import.js";
import { getSearchIndex, rebuildIndex } from "../src/functions/search.js";
import { indexObservationSession } from "../src/state/obs-index.js";
import { profileCacheKey } from "../src/functions/profile.js";
import { KV } from "../src/state/schema.js";
import { SAFE_PAYLOAD_BYTES } from "../src/state/frame-guard.js";
import type { ExportData, Session, CompressedObservation, Memory, ProjectProfile } from "../src/types.js";
vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const at="2026-10-12T00:00:00Z";
const session=(id="sA",project="P",agentId="A"):Session=>({id,project,agentId,cwd:"/fixture",startedAt:at,status:"completed",observationCount:1});
const observation=(sessionId="sA",id="obs_collision",title="alphaneedle"):CompressedObservation=>({id,sessionId,timestamp:at,type:"other",title,narrative:title,facts:[],concepts:[],files:[],importance:5});
const memory=(id="mem_unique"):Memory=>({id,project:"P",agentId:"A",createdAt:at,updatedAt:at,type:"fact",title:"memoryneedle",content:"memoryneedle content",concepts:[],files:[],sessionIds:[],strength:5,version:1,isLatest:true});
const empty=():ExportData=>({version:"0.9.30",exportedAt:at,sessions:[],observations:{},memories:[],summaries:[]});
const profile=(project="P",agentId?:string):ProjectProfile=>({project,...(agentId===undefined?{}:{agentId}),updatedAt:at,topConcepts:[{concept:"typed",frequency:2}],topFiles:[],conventions:["fixture"],commonErrors:[],recentActivity:[],sessionCount:1,totalObservations:1,visibilityRevision:3,sourceDigest:"fixture-source",summary:"profile fixture"});
function fixture(managed=false){
 const kv=Object.assign(mockKV(),{usesManagedState:managed,listGroups:async()=>[...kv.store.keys()],listPage:async<T>(scope:string,offset=0)=>{
  const entries=[...(kv.store.get(scope)?.entries()??[])].slice(offset,offset+2).map(([key,value])=>({key,value:value as T}));
  const total=kv.store.get(scope)?.size??0;return {entries,total,next_offset:offset+entries.length<total?offset+entries.length:null};
 }});
 const sdk=mockSdk();registerExportImportFunction(sdk as never,kv as never);
 const call=(data:ExportData,strategy="merge")=>sdk.trigger("mem::import",{exportData:data,strategy});
 return {kv,sdk,call};
}
async function rejectsBeforeWrites(f:ReturnType<typeof fixture>,data:ExportData,strategy:string,pattern:RegExp=/collision|Duplicate imported/){
 const before=structuredClone(f.kv.store), beforeSearch=getSearchIndex().search("alphaneedle");
 const set=vi.spyOn(f.kv,"set"),remove=vi.spyOn(f.kv,"delete"),update=vi.spyOn(f.kv,"update");
 await expect(f.call(data,strategy)).rejects.toThrow(pattern);
 expect(set).not.toHaveBeenCalled();expect(remove).not.toHaveBeenCalled();expect(update).not.toHaveBeenCalled();
 expect(f.kv.store).toEqual(before);expect(getSearchIndex().search("alphaneedle")).toEqual(beforeSearch);
}
beforeEach(()=>{getSearchIndex().clear();vi.stubEnv("AGENTMEMORY_GRAPH_EXTRACTION","false");});
afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});
describe("registered import preserves global observation/memory search identities",()=>{
 it.each(["merge","skip","replace"])("%s rejects duplicate IDs inside and across buckets",async strategy=>{
  for(const sameBucket of [true,false]){
   const f=fixture();const data={...empty(),sessions:[session(),session("sB")],observations:sameBucket?{sA:[observation(),observation()]}:{sA:[observation()],sB:[observation("sB","obs_collision","betaneedle")]}};
   await rejectsBeforeWrites(f,data,strategy);
  }
 });
 it.each(["merge","skip"])("%s rejects retained canonical collisions for same or different owners and index hints",async strategy=>{
  for(const owner of [session("sB"),session("sB","Q","B")])for(const hint of ["missing","wrong","read-error"]){
   const f=fixture();await f.kv.set(KV.sessions,"sA",session());await f.kv.set(KV.observations("sA"),"obs_collision",observation());getSearchIndex().add(observation());
   if(hint==="wrong")await indexObservationSession(f.kv as never,"obs_collision","sB");
   let hintReads=0;const get=f.kv.get.bind(f.kv);
   vi.spyOn(f.kv,"get").mockImplementation(async(scope,key)=>{if(scope.startsWith("mem:idx:obs:")){hintReads++;if(hint==="read-error")throw Error("auxiliary read failure");}return get(scope,key);});
   await rejectsBeforeWrites(f,{...empty(),sessions:[owner],observations:{sB:[observation("sB","obs_collision","betaneedle")]}},strategy);
   expect(hintReads).toBe(0);
  }
 });
 it.each(["merge","skip","replace"])("%s rejects incoming memory/observation shared IDs",async strategy=>{
  const f=fixture();await rejectsBeforeWrites(f,{...empty(),sessions:[session()],observations:{sA:[observation("sA","mem_shared")]},memories:[memory("mem_shared")]},strategy);
 });
 it.each(["merge","skip"])("%s rejects either retained kind against the other incoming kind",async strategy=>{
  for(const retainedMemory of [false,true]){
   const f=fixture();await f.kv.set(KV.sessions,"sA",session());
   const data={...empty(),sessions:[session()]};
   if(retainedMemory){await f.kv.set(KV.memories,"mem_shared",memory("mem_shared"));data.observations={sA:[observation("sA","mem_shared")]};}
   else{await f.kv.set(KV.observations("sA"),"mem_shared",observation("sA","mem_shared"));data.memories=[memory("mem_shared")];}
   await rejectsBeforeWrites(f,data,strategy);
  }
 });
 it.each(["merge","skip","replace"])("%s supports a valid unique import, immediate search and rebuild",async strategy=>{
  const f=fixture();expect(await f.call({...empty(),sessions:[session()],observations:{sA:[observation()]},memories:[memory()]},strategy)).toMatchObject({success:true,observations:1,memories:1});
  const initial=getSearchIndex().search("alphaneedle").map(x=>[x.obsId,x.sessionId]);expect(initial).toEqual([["obs_collision","sA"]]);
  getSearchIndex().clear();await rebuildIndex(f.kv as never);expect(getSearchIndex().search("alphaneedle").map(x=>[x.obsId,x.sessionId])).toEqual(initial);
 });
 it.each(["merge","skip"])("%s keeps lawful same-address reimport behavior",async strategy=>{
  const f=fixture();await f.call({...empty(),sessions:[session()],observations:{sA:[observation()]}});
  expect(await f.call({...empty(),sessions:[session()],observations:{sA:[observation("sA","obs_collision","betaneedle")]}},strategy)).toMatchObject({success:true,observations:strategy==="skip"?0:1});
  expect((await f.kv.get<CompressedObservation>(KV.observations("sA"),"obs_collision"))?.title).toBe(strategy==="skip"?"alphaneedle":"betaneedle");
 });
 it("replace allows an ID from an address it actually deletes",async()=>{
  const f=fixture();await f.call({...empty(),sessions:[session()],observations:{sA:[observation()]},memories:[memory("mem_shared")]});
  const incoming={...empty(),sessions:[session("sB","Q","B")],observations:{sB:[observation("sB","obs_collision","betaneedle"),observation("sB","mem_shared","memoryreplacementneedle")]}};
  expect(await f.call(incoming,"replace")).toMatchObject({success:true,observations:2});expect(await f.kv.list(KV.observations("sA"))).toEqual([]);expect(await f.kv.get(KV.memories,"mem_shared")).toBeNull();
  expect(getSearchIndex().search("alphaneedle")).toEqual([]);const after=getSearchIndex().search("betaneedle").map(x=>[x.obsId,x.sessionId]);getSearchIndex().clear();await rebuildIndex(f.kv as never);expect(getSearchIndex().search("betaneedle").map(x=>[x.obsId,x.sessionId])).toEqual(after);
 });
 it.each(["merge","skip","replace"])("managed %s detects a retained orphan canonical bucket",async strategy=>{
  const f=fixture(true);await f.kv.set(KV.observations("orphan"),"obs_collision",observation("orphan"));
  await rejectsBeforeWrites(f,{...empty(),sessions:[session()],observations:{sA:[observation()]}},strategy);
 });
 it.each(["merge","skip"])("%s propagates canonical listing failure before writes",async strategy=>{
  const f=fixture();await f.kv.set(KV.sessions,"sA",session());
  const list=f.kv.list.bind(f.kv);vi.spyOn(f.kv,"list").mockImplementation(async scope=>{if(scope===KV.observations("sA"))throw Error("canonical inventory failure");return list(scope);});
  await rejectsBeforeWrites(f,{...empty(),sessions:[session("sB")],observations:{sB:[observation("sB")]}},strategy,/canonical inventory failure/);
 });
 it("managed page failure is not mistaken for absent observations",async()=>{
  const f=fixture(true);await f.kv.set(KV.sessions,"sA",session());for(let i=0;i<3;i++)await f.kv.set(KV.observations("sA"),"old"+i,observation("sA","old"+i));
  const page=f.kv.listPage.bind(f.kv);vi.spyOn(f.kv,"listPage").mockImplementation(async(scope,offset=0)=>{if(scope===KV.observations("sA")&&offset>0)throw Error("page read failure");return page(scope,offset);});
  await rejectsBeforeWrites(f,{...empty(),sessions:[session("sB")],observations:{sB:[observation("sB")]}},"skip",/page read failure/);
 });
 it.each(["merge","skip"])("%s propagates canonical memory lookup failure",async strategy=>{
  const f=fixture();const get=f.kv.get.bind(f.kv);vi.spyOn(f.kv,"get").mockImplementation(async(scope,key)=>{if(scope===KV.memories&&key==="obs_collision")throw Error("canonical memory read failure");return get(scope,key);});
  await rejectsBeforeWrites(f,{...empty(),sessions:[session()],observations:{sA:[observation()]}},strategy,/canonical memory read failure/);
 });
 it.each(["groups","memory-page"])("managed %s read failure precedes all mutations",async failure=>{
  const f=fixture(true);
  if(failure==="groups")vi.spyOn(f.kv,"listGroups").mockRejectedValue(Error("canonical groups failure"));
  else{const page=f.kv.listPage.bind(f.kv);vi.spyOn(f.kv,"listPage").mockImplementation(async(scope,offset)=>{if(scope===KV.memories)throw Error("canonical memory page failure");return page(scope,offset);});}
  await rejectsBeforeWrites(f,{...empty(),sessions:[session()],observations:{sA:[observation()]}},"merge",/canonical (groups|memory page) failure/);
 });
 it("replace allows an observation ID to become a memory after deleting its original address",async()=>{
  const f=fixture();await f.call({...empty(),sessions:[session()],observations:{sA:[observation("sA","mem_shared")]}});
  expect(await f.call({...empty(),memories:[memory("mem_shared")]},"replace")).toMatchObject({success:true,memories:1});
  expect(await f.kv.list(KV.observations("sA"))).toEqual([]);expect(await f.kv.get(KV.memories,"mem_shared")).toMatchObject({content:"memoryneedle content"});
  const immediate=getSearchIndex().search("memoryneedle").map(x=>x.obsId);getSearchIndex().clear();await rebuildIndex(f.kv as never);expect(getSearchIndex().search("memoryneedle").map(x=>x.obsId)).toEqual(immediate);
 });
 it("managed memory collision checks use one paged scan instead of one read per incoming observation",async()=>{
  const f=fixture(true);for(let i=0;i<5;i++)await f.kv.set(KV.memories,"mem_old"+i,memory("mem_old"+i));
  const pages=vi.spyOn(f.kv,"listPage"),get=vi.spyOn(f.kv,"get");
  expect(await f.call({...empty(),sessions:[session()],observations:{sA:Array.from({length:40},(_,i)=>observation("sA","unique"+i))}},"merge")).toMatchObject({success:true,observations:40});
  expect(pages.mock.calls.filter(([scope])=>scope===KV.memories).map(([,offset])=>offset)).toEqual([0,2,4]);expect(get.mock.calls.filter(([scope])=>scope===KV.memories)).toEqual([]);
 });
 it("canonical inventory is scanned once for collision and provenance together",async()=>{
  const f=fixture(true);await f.kv.set(KV.sessions,"sA",session());for(let i=0;i<5;i++)await f.kv.set(KV.observations("sA"),"old"+i,observation("sA","old"+i));
  const pages=vi.spyOn(f.kv,"listPage");const incoming={...empty(),sessions:[session("sB")],observations:{sB:Array.from({length:5},(_,i)=>observation("sB","new"+i))},memories:[{...memory(),sessionIds:["sA"],sourceObservationIds:["old0"]}]};
  expect(await f.call(incoming,"merge")).toMatchObject({success:true});expect(pages.mock.calls.filter(([scope])=>scope===KV.observations("sA")).map(([,offset])=>offset)).toEqual([0,2,4]);
 });
});
describe("registered export preserves profiles in its selected session-project page",()=>{
 it.each([{agents:[]},{agents:["A"]},{agents:["A","B"]},{agents:[undefined,"A"]}])("retains agent keys $agents and round-trips fields and ownership",async ({agents})=>{
  const f=fixture();await f.kv.set(KV.sessions,"sA",session());const profiles=agents.map(agent=>profile("P",agent));if(!profiles.length)profiles.push(profile());
  for(const row of profiles)await f.kv.set(KV.profiles,profileCacheKey(row.project,row.agentId),row);
  const exported=await f.sdk.trigger("mem::export",{}) as ExportData;expect(exported.profiles).toEqual(profiles);
  const destination=fixture();expect(await destination.call(exported)).toMatchObject({success:true});expect((await destination.sdk.trigger("mem::export",{}) as ExportData).profiles).toEqual(profiles);
  for(const row of profiles)expect(await destination.kv.get(KV.profiles,profileCacheKey(row.project,row.agentId))).toEqual(row);
 });
 it.each([false,true])("managed=%s exports all selected-project agents and excludes other page projects",async managed=>{
  const f=fixture(managed);await f.kv.set(KV.sessions,"sA",session());await f.kv.set(KV.sessions,"sB",session("sB","Q","B"));
  const profiles=[profile(),profile("P","A"),profile("P","B"),profile("Q","B"),profile("outside","C")];for(const row of profiles)await f.kv.set(KV.profiles,profileCacheKey(row.project,row.agentId),row);
  expect((await f.sdk.trigger("mem::export",{maxSessions:1,offset:0}) as ExportData).profiles).toEqual(profiles.slice(0,3));
  expect((await f.sdk.trigger("mem::export",{maxSessions:1,offset:1}) as ExportData).profiles).toEqual([profiles[3]]);
 });
 it.each([false,true])("managed=%s propagates profile listing failure",async managed=>{
  const f=fixture(managed);await f.kv.set(KV.sessions,"sA",session());
  if(managed){const page=f.kv.listPage.bind(f.kv);vi.spyOn(f.kv,"listPage").mockImplementation(async(scope,offset)=>{if(scope===KV.profiles)throw Error("profile page failure");return page(scope,offset);});}
  else{const list=f.kv.list.bind(f.kv);vi.spyOn(f.kv,"list").mockImplementation(async scope=>{if(scope===KV.profiles)throw Error("profile list failure");return list(scope);});}
  await expect(f.sdk.trigger("mem::export",{})).rejects.toThrow(/profile (page|list) failure/);
 });
 it("a later profile page failure cannot return a silently truncated export",async()=>{
  const f=fixture(true);await f.kv.set(KV.sessions,"sA",session());for(const agent of ["A","B","C"])await f.kv.set(KV.profiles,profileCacheKey("P",agent),profile("P",agent));
  const page=f.kv.listPage.bind(f.kv);vi.spyOn(f.kv,"listPage").mockImplementation(async(scope,offset=0)=>{if(scope===KV.profiles&&offset>0)throw Error("later profile page failure");return page(scope,offset);});
  await expect(f.sdk.trigger("mem::export",{})).rejects.toThrow("later profile page failure");
 });
 it("counts agent profile content in ExportBudget before later collections",async()=>{
  const f=fixture(true);await f.kv.set(KV.sessions,"sA",session());for(const agent of ["A","B"])await f.kv.set(KV.profiles,profileCacheKey("P",agent),{...profile("P",agent),summary:"x".repeat(Math.ceil(SAFE_PAYLOAD_BYTES/2))});
  const list=vi.spyOn(f.kv,"list");expect(await f.sdk.trigger("mem::export",{})).toMatchObject({success:false,oversized:true,stoppedAt:"profiles"});expect(list.mock.calls.map(([scope])=>scope)).not.toContain(KV.graphNodes);
 });
});
