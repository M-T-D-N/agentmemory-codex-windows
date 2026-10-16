import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { saveUnconfirmedEvidence, confirmNativeEvidence, consumeNativeEvidence } from "../verification/native-evidence-store.mjs";
import { runNativeCaptureE2e } from "../verification/native-capture-e2e.mjs";
const roots=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(){const base=resolve(".tmp/native-evidence-tests");await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,"run-"));roots.push(root);return{root,id:randomUUID()};}
const record=id=>({executionId:id,success:false,verificationPassed:true,exitCode:null,workerIdentity:"2026-01-01T00:00:00Z"});
const hash=value=>createHash("sha256").update(value).digest("hex");
test("stored bytes stay unconfirmed until a matching normal process outcome is confirmed",async()=>{
 const{root,id}=await fixture();const ack=await saveUnconfirmedEvidence(root,record(id));
 const bytes=JSON.parse(await readFile(join(root,id,"result.json"),"utf8"));assert.equal(bytes.state,"unconfirmed");assert.equal(bytes.record.success,false);
 await assert.rejects(consumeNativeEvidence(root,{...ack,exitCode:0}));
 await confirmNativeEvidence(root,{...ack,exitCode:0});const accepted=await consumeNativeEvidence(root,{...ack,exitCode:0});assert.equal(accepted.success,true);assert.equal(accepted.storageState,"confirmed");
 await assert.rejects(consumeNativeEvidence(root,{...ack,exitCode:1}));
});
for(const mode of ["throw-after-write","serialize-failure","partial-write","interrupt-before-confirm"])test(`actual subprocess failure and persisted bytes cannot certify ${mode}`,async()=>{
 const{root,id}=await fixture();const url=new URL("../verification/native-evidence-store.mjs",import.meta.url).href;
 const code=`import{saveUnconfirmedEvidence}from${JSON.stringify(url)};import{mkdir,writeFile}from'node:fs/promises';import{join}from'node:path';const[root,id]=process.argv.slice(1);const record={executionId:id,success:false,verificationPassed:true,exitCode:null};if(${JSON.stringify(mode)}==='partial-write'){await mkdir(join(root,id));await writeFile(join(root,id,'result.json'),'{"executionId":');process.exit(23);}await saveUnconfirmedEvidence(root,record);if(${JSON.stringify(mode)}==='interrupt-before-confirm')process.exit(23);if(${JSON.stringify(mode)}==='serialize-failure')JSON.stringify({big:1n});throw Error('intentional failure after serialized bytes');`;
 const child=spawnSync(process.execPath,["--input-type=module","-e",code,root,id],{encoding:"utf8"});assert.notEqual(child.status,0);
 const bytes=await readFile(join(root,id,"result.json"));if(mode!=="partial-write")assert.equal(JSON.parse(bytes).record.success,false);
 const outcome={executionId:id,resultHash:hash(bytes),exitCode:child.status};await assert.rejects(consumeNativeEvidence(root,outcome));
 await assert.rejects(consumeNativeEvidence(root,{...outcome,exitCode:0}));
 if(mode==="partial-write")await assert.rejects(confirmNativeEvidence(root,{...outcome,exitCode:0}));
});
test("a prior successful run and a legacy success JSON never certify another execution",async()=>{
 const{root,id}=await fixture();const old=await saveUnconfirmedEvidence(root,record(id));await confirmNativeEvidence(root,{...old,exitCode:0});
 await writeFile(join(root,"old-success.json"),JSON.stringify({success:true}));const current=randomUUID();
 await assert.rejects(consumeNativeEvidence(root,{executionId:current,resultHash:old.resultHash,exitCode:0}));
});
function options(root,id,save){const observation={id:"o",project:"p",sessionId:"s",narrative:"new",codexSource:{key:"k"}};return{executionId:id,target:{project:"p",sessionId:"s",observationId:"o",sourceKey:"k",query:"new",narrativeDigest:hash(JSON.stringify("new"))},identity:{sourceCommit:"fixture",runtime:"isolated",runtimeHash:"fixture"},deadlineMs:100,save,
 trigger:async name=>name.endsWith("capture")?{sessionId:"s",status:"caught_up",bytesReadThrough:10,snapshotBytes:10,issue:null,sourceHoldCount:0,unresolvedCaptureCount:0,indexPending:false,inserted:1,captured:1}:name.endsWith("discover")?{unknown:0,failures:[],reconcileRequired:0,reconciliation:[],cycleComplete:true}:{unknown:0,failures:[],captureUnknown:0,requiresReconciliation:0,graphFailures:0,discovery:{unknown:0,reconcileRequired:0},captureCycleComplete:true},
 request:async route=>({status:200,body:route==="search"?{results:[{project:"p",sessionId:"s",observation}]}:{problems:[],nativeCapture:{issueCount:0,batch:{workerStartedAt:"2026-01-01T00:00:00Z",freshness:"current",cycleComplete:false,observedAt:new Date().toISOString()}}}})};}
for(const mode of ["normal","write-then-throw","no-response","late-write"])test(`real serialized writer ${mode} requires committed consumer evidence`,async()=>{
 const{root,id}=await fixture();let late;
 const save=async(value,context)=>{
  if(mode==="no-response")return new Promise(()=>{});
  if(mode==="late-write"){late=new Promise(resolve=>setTimeout(resolve,150)).then(()=>saveUnconfirmedEvidence(root,value));return late;}
  const result=await saveUnconfirmedEvidence(root,value,context);if(mode==="write-then-throw")throw Error("after write");return result;
 };
 if(mode==="normal"){const passed=await runNativeCaptureE2e(options(root,id,save));assert.equal(passed.success,true);await assert.rejects(consumeNativeEvidence(root,{...passed.storage,exitCode:0}));await confirmNativeEvidence(root,{...passed.storage,exitCode:0});assert.equal((await consumeNativeEvidence(root,{...passed.storage,exitCode:0})).success,true);}
 else{await assert.rejects(runNativeCaptureE2e(options(root,id,save)));if(late)await late;
 let bytes;try{bytes=await readFile(join(root,id,"result.json"));}catch(error){assert.equal(error.code,"ENOENT");}if(bytes)assert.equal(JSON.parse(bytes).record.success,false);
 await assert.rejects(consumeNativeEvidence(root,{executionId:id,resultHash:bytes?hash(bytes):"a".repeat(64),exitCode:1}));
 await assert.rejects(consumeNativeEvidence(root,{executionId:id,resultHash:bytes?hash(bytes):"a".repeat(64),exitCode:0}));}
});
test("modified persisted result cannot match its receipt",async()=>{
 const{root,id}=await fixture();const ack=await saveUnconfirmedEvidence(root,record(id));await confirmNativeEvidence(root,{...ack,exitCode:0});await writeFile(join(root,id,"result.json"),JSON.stringify({success:true}));await assert.rejects(consumeNativeEvidence(root,{...ack,exitCode:0}));
});
