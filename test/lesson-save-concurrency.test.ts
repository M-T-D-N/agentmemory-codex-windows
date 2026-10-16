import {describe,it,expect,vi,beforeEach} from "vitest";
import {mockKV,mockSdk} from "./helpers/mocks.js";
import {registerLessonsFunctions,resetLessonIndex} from "../src/functions/lessons.js";
import {withObservationRecovery} from "../src/state/observation-write.js";
import {archiveTargetAddress,archiveTargetDigest} from "../src/functions/archive.js";
import {KV} from "../src/state/schema.js";
import type {Lesson} from "../src/types.js";
beforeEach(()=>resetLessonIndex());
async function fixture(){
 const kv=mockKV();const sdk=mockSdk();registerLessonsFunctions(sdk as never,kv as never);
 for(const id of ["A","B"]){await kv.set(KV.sessions,"ses_"+id,{id:"ses_"+id,project:"P",cwd:"P",startedAt:new Date().toISOString(),status:"completed",observationCount:1});await kv.set(KV.observations("ses_"+id),"obs_"+id,{id:"obs_"+id,sessionId:"ses_"+id,timestamp:new Date().toISOString(),type:"note",title:"Fixture source",narrative:"Synthetic original",facts:[],concepts:[],files:[],importance:5});}
 const save=(id:string)=>sdk.trigger("mem::lesson-save",{content:"Same lesson",project:"P",sources:[{sessionId:"ses_"+id,observationIds:["obs_"+id]}]}) as Promise<{success:boolean,action:string,lesson:Lesson}>;
 return{kv,sdk,save};
}
describe("lesson concurrent save provenance",()=>{
 it.each(["new","existing","legacy"])("retains every successful source for %s lesson",async mode=>{
  const f=await fixture();if(mode!=="new"){const first=await f.save("A");if(mode==="legacy"){await f.kv.delete(KV.lessons,first.lesson.id);await f.kv.set(KV.lessons,"legacy-id",{...first.lesson,id:"legacy-id"});}}
  const list=f.kv.list.bind(f.kv);let calls=0;let release!:()=>void;const barrier=new Promise<void>(r=>release=r);
  vi.spyOn(f.kv,"list").mockImplementation(async scope=>{const snapshot=structuredClone(await list(scope));if(scope===KV.lessons&&calls<2){calls++;if(calls===2)release();await barrier;}return snapshot;});
  const responses=await Promise.all([f.save("A"),f.save("B")]);expect(responses.every(r=>r.success)).toBe(true);
  const rows=await f.kv.list<Lesson>(KV.lessons);expect(rows).toHaveLength(1);expect(new Set(rows[0].sourceObservationIds)).toEqual(new Set(["obs_A","obs_B"]));expect(new Set(rows[0].sourceSessionIds)).toEqual(new Set(["ses_A","ses_B"]));expect(rows[0].reinforcements).toBe(mode==="new"?1:2);if(mode==="legacy")expect(rows[0].id).toBe("legacy-id");
 });
});

describe("lesson mutation races",()=>{
 it("save snapshot cannot revive a concurrently deleted live lesson",async()=>{
  const f=await fixture();const initial=await f.save("A");const list=f.kv.list.bind(f.kv);let ready!:()=>void,release!:()=>void;const reached=new Promise<void>(r=>ready=r),gate=new Promise<void>(r=>release=r);let once=false;
  vi.spyOn(f.kv,"list").mockImplementation(async scope=>{const rows=structuredClone(await list(scope));if(scope===KV.lessons&&!once){once=true;ready();await gate;}return rows;});
  const save=f.save("B");await reached;expect(await f.sdk.trigger("mem::lesson-delete",{lessonId:initial.lesson.id,project:"P"})).toMatchObject({success:true});release();expect(await save).toMatchObject({success:false});expect((await f.kv.get<Lesson>(KV.lessons,initial.lesson.id))?.deleted).toBe(true);
 });
 it("save and strengthen preserve both completed reinforcements",async()=>{const f=await fixture();const first=await f.save("A");const replies=await Promise.all([f.save("B"),f.sdk.trigger("mem::lesson-strengthen",{lessonId:first.lesson.id})]);expect(replies).toEqual(expect.arrayContaining([expect.objectContaining({success:true})]));const row=await f.kv.get<Lesson>(KV.lessons,first.lesson.id);expect(row?.reinforcements).toBe(2);expect(new Set(row?.sourceObservationIds)).toEqual(new Set(["obs_A","obs_B"]));});
 it("save participates in recovery writer exclusion",async()=>{
  const f=await fixture();const list=f.kv.list.bind(f.kv);let ready!:()=>void,release!:()=>void;const reached=new Promise<void>(r=>ready=r),gate=new Promise<void>(r=>release=r);let once=false;
  vi.spyOn(f.kv,"list").mockImplementation(async scope=>{if(scope===KV.lessons&&!once){once=true;ready();await gate;}return list(scope);});const save=f.save("A");await reached;await expect(withObservationRecovery(async()=>{},0)).rejects.toThrow(/writers/);release();expect(await save).toMatchObject({success:true});
 });
 it("revalidates original provenance after waiting on lookup",async()=>{
  const f=await fixture();const list=f.kv.list.bind(f.kv);let once=false;vi.spyOn(f.kv,"list").mockImplementation(async scope=>{const rows=await list(scope);if(scope===KV.lessons&&!once){once=true;await f.kv.delete(KV.observations("ses_A"),"obs_A");}return rows;});expect(await f.save("A")).toMatchObject({success:false});expect(await f.kv.list(KV.lessons)).toEqual([]);
 });
});

describe("fresh lesson row on decay and deletion",()=>{
 it.each(["strengthen","delete","save"])("decay stale list preserves completed %s mutation",async mode=>{
  const f=await fixture();const first=await f.save("A");await f.kv.set(KV.lessons,first.lesson.id,{...first.lesson,createdAt:"2020-01-01T00:00:00.000Z",updatedAt:"2020-01-01T00:00:00.000Z",confidence:0.11});
  const list=f.kv.list.bind(f.kv);let once=false;vi.spyOn(f.kv,"list").mockImplementation(async scope=>{const snapshot=structuredClone(await list(scope));if(scope===KV.lessons&&!once){once=true;if(mode==="save")await f.save("B");else await f.sdk.trigger("mem::lesson-"+mode,{lessonId:first.lesson.id,project:"P"});}return snapshot;});
  await f.sdk.trigger("mem::lesson-decay-sweep",{});const row=await f.kv.get<Lesson>(KV.lessons,first.lesson.id);if(mode==="delete")expect(row?.deleted).toBe(true);else{expect(row?.deleted).not.toBe(true);expect(row?.reinforcements).toBe(1);if(mode==="save")expect(row?.sourceObservationIds).toContain("obs_B");}
 });
 it.each(["archived","restored"])("decay preserves %s archive contract while explicit saves union provenance",async state=>{
  const f=await fixture();const first=await f.save("A");const old={...first.lesson,createdAt:"2020-01-01T00:00:00.000Z",updatedAt:"2020-01-01T00:00:00.000Z",confidence:0.11};await f.kv.set(KV.lessons,old.id,old);const target={kind:"lesson" as const,id:old.id};const {key}=archiveTargetAddress(target);await f.kv.set(KV.archiveStates,key,{version:1,id:key,target,project:"P",state,revision:1,auditId:"synthetic-audit",changedAt:new Date().toISOString(),reason:"fixture",targetDigest:archiveTargetDigest(old)});
  await f.sdk.trigger("mem::lesson-decay-sweep",{});expect(await f.kv.get(KV.lessons,old.id)).toEqual(old);expect(await f.save("B")).toMatchObject({success:true});expect((await f.kv.get<Lesson>(KV.lessons,old.id))?.sourceObservationIds).toEqual(["obs_A","obs_B"]);
 });
 it("strengthen cannot revive a completed deletion",async()=>{const f=await fixture();const first=await f.save("A");const replies=await Promise.all([f.sdk.trigger("mem::lesson-delete",{lessonId:first.lesson.id,project:"P"}),f.sdk.trigger("mem::lesson-strengthen",{lessonId:first.lesson.id})]);expect(replies[0]).toMatchObject({success:true});expect(replies[1]).toMatchObject({success:false});expect((await f.kv.get<Lesson>(KV.lessons,first.lesson.id))?.deleted).toBe(true);});
});
