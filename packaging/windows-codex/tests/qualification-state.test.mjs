import test from 'node:test';
import assert from 'node:assert/strict';
import {graphObservation,createOwnedSlot,cleanupOwnedSlots,measureGraph,rememberOwned,cleanupOwnedMemories,cleanupStages,createRecordWriter} from '../../../scripts/live-qualification.mjs';
const target={project:'isolated-owned-project',scope:'project',label:'qa_unique_run',content:'qa unique ownership nonce'};
function server(fault={}){
 let row=null,deletes=0;
 const request=async(route,body,options={})=>{
  if(route==='slot'){row={...body};if(fault.ack)throw Error('lost creation ACK');return {success:true,slot:row};}
  if(options.method==='DELETE'){deletes++;row=null;return {success:true};}
  return row?{status:200,data:{slot:row}}:{status:404,data:{error:'absent'}};
 };
 return {request,get row(){return row},get deletes(){return deletes}};
}
const completedProof=entry=>({state:'completed',runId:entry.runId,requestIds:entry.requestIds,functionName:entry.functionName,noFurtherCanonicalWrites:true});
const journal=()=>({slots:[],runId:'test-run',save:async()=>{}});
test('actual singular warning and fallback provenance are preserved',()=>{
 const result=graphObservation({nodes:[],edges:[],warning:'exact index unavailable',fromSnapshot:true,totalsExact:false,edgeInventoryExact:false},{elapsedMs:19});
 assert.equal(result.warning,'exact index unavailable');assert.equal(result.fromSnapshot,true);assert.equal(result.totalsExact,false);assert.equal(result.exactIndex,false);
});
test('server stored slot with lost ACK remains owned and is cleaned',async()=>{
 const wire=server({ack:true}),owned=journal();owned.verifyCompletion=completedProof;await assert.rejects(createOwnedSlot(owned,wire.request,target),/ACK/);
 assert.equal(owned.slots.length,1);assert.equal(owned.slots[0].state,'unknown');
 assert((await cleanupOwnedSlots(owned,wire.request)).success);assert.equal(wire.row,null);assert.equal(wire.deletes,1);assert.equal(owned.slots[0].state,'removed_verified');
});
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
const exact={nodes:[{id:'n'}],edges:[],fromIndex:true,fromSnapshot:false,totalsExact:true,edgeInventoryExact:true,edgeInventoryRevision:'rev1'};
test('indexed readability and explicit exact inventory are separate',()=>{const r=graphObservation(exact,{elapsedMs:3,expectedRevision:'rev1',edgeInventoryRequested:true});assert.equal(r.readable,true);assert.equal(r.indexedPath,true);assert.equal(r.exactIndex,true);assert.equal(r.elapsedMs,3);});
test('empty snapshot is readable but never proves empty exact graph',()=>{const r=graphObservation({nodes:[],edges:[],warning:'partial',fromSnapshot:true,totalsExact:false});assert.equal(r.nodes,0);assert.equal(r.exactIndex,false);assert.equal(r.warning,'partial');});
test('changed manifest revision invalidates exact inventory',()=>{const r=graphObservation(exact,{expectedRevision:'rev2'});assert.equal(r.revisionMatches,false);assert.equal(r.exactIndex,false);});
test('absent optional fields remain unknown',()=>{const r=graphObservation({nodes:[],edges:[]});for(const field of ['fromIndex','fromSnapshot','totalsExact','edgeInventoryExact','edgeInventoryRevision','warning','exactIndex'])assert.equal(r[field],null);});
for(const malformed of [null,{nodes:'wrong',edges:[]},{nodes:[null],edges:[]},{nodes:[],edges:[],warning:[]},{nodes:[],edges:[],fromIndex:'true'},{nodes:[],edges:[],totalNodes:'0'}])test('invalid graph type '+JSON.stringify(malformed),()=>assert.throws(()=>graphObservation(malformed),/Invalid graph/));
test('timeout records failed client observation and unknown server completion',async()=>{const r=await measureGraph(async()=>{throw new DOMException('client deadline','TimeoutError')});assert.equal(r.readable,false);assert.equal(r.outcome,'timeout');assert.equal(r.serverCompletion,'unknown');assert.equal(r.clientAbortObserved,true);assert(r.elapsedMs>=0);});
test('prewrite journal failure prevents any slot write',async()=>{const wire=server(),j=journal();j.save=async()=>{throw Error('journal unavailable')};await assert.rejects(createOwnedSlot(j,wire.request,target),/journal/);assert.equal(wire.row,null);assert.equal(j.slots[0].state,'not_created');});
test('failure saving confirmed receipt leaves unknown slot eligible for cleanup',async()=>{const wire=server(),j=journal();let saves=0;j.save=async()=>{if(++saves===2)throw Error('receipt save failure')};await assert.rejects(createOwnedSlot(j,wire.request,target),/save failure/);assert.equal(j.slots[0].state,'unknown');assert((await cleanupOwnedSlots(j,wire.request)).success);assert.equal(wire.row,null);});
test('preflight failure does not overwrite preexisting slot',async()=>{const wire=server();await wire.request('slot',target);const j=journal();await assert.rejects(createOwnedSlot(j,wire.request,target),/not proven absent/);assert.equal(j.slots.length,0);assert.equal(wire.deletes,0);});
test('ownership changed after create prevents deletion',async()=>{const wire=server(),j=journal();await createOwnedSlot(j,wire.request,target);await wire.request('slot',{...target,content:'another user value'});const result=await cleanupOwnedSlots(j,wire.request);assert.equal(result.success,false);assert.equal(wire.deletes,0);assert.equal(j.slots[0].state,'ownership_conflict');});
test('delete ACK loss is reconciled by exact absence read',async()=>{const wire=server(),j=journal();const request=async(...args)=>{const response=await wire.request(...args);if(args[2]?.method==='DELETE')throw Error('lost delete ACK');return response};await createOwnedSlot(j,request,target);assert((await cleanupOwnedSlots(j,request)).success);assert.equal(wire.row,null);assert.equal(j.slots[0].state,'removed_verified');assert.match(j.slots[0].deleteAckError,/ACK/);});
test('cleanup read failure stays unknown',async()=>{const wire=server(),j=journal();await createOwnedSlot(j,wire.request,target);const result=await cleanupOwnedSlots(j,async()=>{throw Error('read offline')});assert.equal(result.success,false);assert.equal(j.slots[0].state,'unknown');assert(wire.row);assert.equal(wire.deletes,0);});
test('one slot failure does not skip next independently owned slot',async()=>{const rows=new Map(),j=journal();let deleted=0;const req=async(route,body,opt={})=>{const label=body?.label??new URLSearchParams(route.split('?')[1]).get('label');if(route==='slot'){rows.set(label,body);return {success:true}}if(opt.method==='DELETE'){deleted++;rows.delete(label);return {success:true}}if(label==='first'&&rows.has(label))throw Error('first read failed');return rows.has(label)?{status:200,data:{slot:rows.get(label)}}:{status:404,data:{}}};j.slots.push({...target,label:'first',state:'unknown'});rows.set('first',{...target,label:'first'});await createOwnedSlot(j,req,{...target,label:'second'});assert.equal((await cleanupOwnedSlots(j,req)).success,false);assert(rows.has('first'));assert(!rows.has('second'));assert.equal(deleted,1);});
test('cleanup stage failure still executes session memory and observation stages',async()=>{const seen=[];const result=await cleanupStages([['slots',async()=>{throw Error('slot error')}],...['session','memory','observation'].map(name=>[name,async()=>{seen.push(name);return {success:true}}])]);assert.equal(result.success,false);assert.deepEqual(seen,['session','memory','observation']);});
test('remember server-issued ID ACK loss is discovered by exact ownership',async()=>{const j={runId:'test-run',verifyCompletion:completedProof,memoryIntents:[],save:async()=>{}},targetMemory={project:'P',agentId:'A',content:'qa nonce exact content'};let row;await assert.rejects(rememberOwned(j,async(_route,body)=>{row={id:'server-id',...body};throw Error('remember ACK lost')},targetMemory),/ACK/);assert.equal(j.memoryIntents[0].state,'unknown');const result=await cleanupOwnedMemories(j,{discover:async()=>({rows:row?[row]:[],complete:true}),read:async()=>row?{status:200,data:{memory:row}}:{status:404},remove:async()=>{row=null}});assert(result.success);assert.equal(row,null);assert.equal(j.memoryIntents[0].state,'removed_verified');});
test('remember known ID ownership conflict is retained',async()=>{const j={memoryIntents:[{id:'known',project:'P',agentId:'A',content:'owned nonce',state:'confirmed',receiptCompleted:true}],save:async()=>{}};let removed=0;const result=await cleanupOwnedMemories(j,{discover:async()=>({rows:[],complete:true}),read:async()=>({status:200,data:{memory:{id:'known',project:'P',agentId:'other',content:'owned nonce'}}}),remove:async()=>{removed++}});assert.equal(result.success,false);assert.equal(removed,0);assert.equal(j.memoryIntents[0].state,'unknown');});
test('ranked/incomplete memory inventory cannot prove cleanup success',async()=>{const j={memoryIntents:[{project:'P',agentId:'A',content:'owned',state:'unknown'}],save:async()=>{}};const result=await cleanupOwnedMemories(j,{discover:async()=>({rows:[],complete:false}),read:async()=>({status:404}),remove:async()=>{}});assert.equal(result.success,false);assert.equal(j.memoryIntents[0].state,'unknown');});
test('serialized record writes retain all concurrent ownership entries',async()=>{const dir=await mkdtemp(path.join(process.env.TEMP,'qualification-'));try{const data={owned:[]},file=path.join(dir,'record.json'),save=createRecordWriter(file,data);await Promise.all([1,2,3,4].map(async id=>{data.owned.push(id);await save()}));assert.deepEqual(JSON.parse(await readFile(file,'utf8')).owned,[1,2,3,4]);}finally{await rm(dir,{recursive:true});}});

test('session never created remains not_created rather than reported as deleted',async()=>{const result=await cleanupStages([['session',async()=>({success:true,state:'not_created'})]]);assert.equal(result.success,true);assert.equal(result.results[0].state,'not_created');});

import {createRequest,completionFromDiagnostics,ensureOwnedWriteFinished,startOwnedSession,observeOwned,importOwnedObservation,cleanupOwnedSession} from '../../../scripts/live-qualification.mjs';
function deferred(){let resolve;return {promise:new Promise(r=>{resolve=r}),resolve:()=>resolve()};}
for(const kind of ['slot','memory'])for(const boundary of ['before-store','during-store','after-store-ack-loss','late-commit-during-cleanup'])test(`${kind} ${boundary} never cleans before actual server completion`,async()=>{
 const gate=deferred(),entered=deferred(),j={slots:[],memoryIntents:[],runId:'run-owned',save:async()=>{}};let row,deletes=0,finished=false,pending;
 j.verifyCompletion=entry=>finished?completedProof(entry):{state:'unknown'};
 const owned={project:'P',agentId:'A',scope:'project',label:'owned_nonce',content:'exact owned nonce'};
 const request=async(route,body,opt={})=>{
  if(body){pending=(async()=>{if(boundary==='during-store')row={...body,id:'issued'};entered.resolve();await gate.promise;if(boundary!=='during-store')row={...body,id:'issued'};finished=true;})();await entered.promise;if(boundary==='after-store-ack-loss'){gate.resolve();await pending;}throw new DOMException('deadline before ACK','TimeoutError');}
  if(opt.method==='DELETE'){deletes++;row=null;return {success:true};}return row?{status:200,data:{slot:row}}:{status:404};
 };
 const memoryIo={discover:async()=>({rows:row?[row]:[],complete:true}),read:async()=>row?{status:200,data:{memory:row}}:{status:404},remove:async()=>{deletes++;row=null;}};
 const create=()=>kind==='slot'?createOwnedSlot(j,request,owned):rememberOwned(j,request,owned),clean=()=>kind==='slot'?cleanupOwnedSlots(j,request):cleanupOwnedMemories(j,memoryIo);
 await assert.rejects(create(),/deadline/);
 if(boundary!=='after-store-ack-loss'){
  const before=await clean();assert.equal(before.success,false);assert.equal(deletes,0);assert.equal((kind==='slot'?j.slots:j.memoryIntents)[0].state,'unknown');
  gate.resolve();await pending;
 }
 assert.equal((await clean()).success,true);assert.equal(deletes,1);assert.equal(row,null);
});
for(const kind of ['slot','memory'])for(const missing of ['missing','diagnostic-loss','outer-api-only','changed-run','wrong-request','pending-child'])test(`${kind} ${missing} completion proof stays UNKNOWN and deletes zero`,async()=>{
 const j={slots:[],memoryIntents:[],runId:'run-owned',save:async()=>{}};let row,deletes=0;
 const request=async(route,body)=>{if(body){row={...body,id:'issued'};throw Error('lost ACK');}return {status:404};};
 await assert.rejects(kind==='slot'?createOwnedSlot(j,request,target):rememberOwned(j,request,{project:'P',agentId:'A',content:'nonce'}));
 const entry=(kind==='slot'?j.slots:j.memoryIntents)[0];
 const name=missing==='outer-api-only'?'api::remember':entry.functionName;
 const snapshot={runId:missing==='changed-run'?'other':entry.runId,requests:['missing','diagnostic-loss','pending-child'].includes(missing)?[]:[{requestId:missing==='wrong-request'?'other':entry.requestIds[0],name,serverCompleted:true}]};
 j.verifyCompletion=e=>completionFromDiagnostics(snapshot,e);
 const result=kind==='slot'?await cleanupOwnedSlots(j,()=>{deletes++;return {status:404}}):await cleanupOwnedMemories(j,{discover:async()=>({rows:[],complete:true}),read:async()=>({status:404}),remove:async()=>{deletes++;}});
 assert.equal(result.success,false);assert.equal(entry.state,'unknown');assert.equal(deletes,0);assert(row);
});
for(const kind of ['slot','memory'])test(`${kind} exact definitive cancellation permits absence verification`,async()=>{
 const j={slots:[],memoryIntents:[],runId:'run-owned',save:async()=>{}};
 const request=async(route,body)=>{if(body)throw Error('cancelled before store');return {status:404};};
 await assert.rejects(kind==='slot'?createOwnedSlot(j,request,target):rememberOwned(j,request,{project:'P',agentId:'A',content:'nonce'}));
 j.verifyCompletion=e=>({...completedProof(e),state:'cancelled'});
 const result=kind==='slot'?await cleanupOwnedSlots(j,request):await cleanupOwnedMemories(j,{discover:async()=>({rows:[],complete:true}),read:async()=>({status:404}),remove:async()=>{throw Error('no deletion expected')}});
 assert.equal(result.success,true);
});
for(const [name,fetchImpl,outcome] of [
 ['headers timeout',async()=>{throw new DOMException('deadline','TimeoutError')},'client_abort'],
 ['body timeout',async()=>({status:200,ok:true,text:async()=>{await new Promise(r=>setTimeout(r,8));throw new DOMException('body deadline','AbortError')}}),'body_abort'],
 ['body socket termination',async()=>({status:200,ok:true,text:async()=>{throw Error('terminated socket')}}),'body_transport_error'],
 ['invalid JSON',async()=>({status:200,ok:true,text:async()=>'{broken'}),'parse_error'],
 ['valid JSON',async()=>({status:200,ok:true,text:async()=>'{}'}),'http_response'],
 ['expected 422',async()=>({status:422,ok:false,text:async()=>'{}'}),'http_error'],
 ['expected 500',async()=>({status:500,ok:false,text:async()=>'{}'}),'http_error'],
])test('request trace '+name,async()=>{
 const records=[],req=createRequest({base:'http://127.0.0.1/',requestRecords:records,fetchImpl});
 if(outcome.startsWith('http_'))assert.equal((await req('fixture',{}, {raw:true})).status,records[0].status);
 else {const result=await measureGraph(()=>req('fixture',{}));assert.equal(result.readable,false);assert.equal(result.serverCompletion,'unknown');}
 const trace=records[0];assert.equal(trace.outcome,outcome);assert.equal(trace.serverCompletion,'unknown');assert(trace.elapsedMs>=0);
 if(name==='body timeout'){assert.equal(trace.status,200);assert.equal(trace.bodyComplete,false);assert(trace.elapsedMs>=trace.headerElapsedMs+5);}
 if(name==='invalid JSON'){assert.equal(trace.bodyComplete,true);assert.equal(trace.responseComplete,undefined);}
});
function sessionFixture(){
 const j={runId:'run-owned',sessionIntents:[],observationIntents:[],save:async()=>{},verifyCompletion:completedProof};let session,rows=[],deletes=0,failObserve=0,observeCalls=0,failImport=false,failQuery=false;
 const request=async(route,body)=>{
  if(route.startsWith('sessions?'))return {sessions:session?[session]:[],total:session?1:0};
  if(route==='session/start'){session={id:body.sessionId,project:body.project,agentId:body.agentId,cwd:body.cwd,observationCount:0};return {session};}
  if(route.startsWith('observations?')){if(failQuery){failQuery=false;throw Error('final query unavailable');}return {observations:rows,total:rows.length,nextOffset:null};}
  if(route==='observe'){const intent=j.observationIntents.at(-1);rows.push({...intent});session.observationCount=rows.length;if(++observeCalls===failObserve)throw Error('observe ACK lost');return {status:'accepted',state:'completed',observationId:intent.id};}
  if(route==='import'){rows.push(body.exportData.observations.s[0]);session.observationCount=rows.length;if(failImport)throw Error('import ACK lost');return {observations:1};}
  throw Error('unexpected route '+route);
 };
 const clean=()=>cleanupOwnedSession(j,{sessions:()=>request('sessions?'),observations:()=>request('observations?'),remove:async()=>{deletes++;session=null;rows=[];return {success:true}},handoff:async()=>({status:session?200:404})});
 return {j,request,clean,get deletes(){return deletes},get rows(){return rows},loseObserve:n=>failObserve=n,loseImport:()=>failImport=true,loseQuery:()=>failQuery=true,foreign:()=>{rows.push({id:'foreign'});session.observationCount=rows.length}};
}
const sessionTarget={project:'P',sessionId:'s',agentId:'A',cwd:'D:/owned'};
const observationTarget=i=>({...sessionTarget,eventId:'owned-event-'+i,timestamp:new Date(1791760000000+i).toISOString(),hookType:'prompt_submit',data:{prompt:'exact nonce source '+i}});
for(const boundary of ['first-observe-ack','second-observe-ack','final-query','import-ack','post-write-journal','foreign-row'])test('session ownership recovery '+boundary,async()=>{
 const f=sessionFixture();await startOwnedSession(f.j,f.request,sessionTarget);
 f.loseObserve(boundary==='first-observe-ack'?1:boundary==='second-observe-ack'?2:0);
 for(let i=0;i<2;i++){try{await observeOwned(f.j,f.request,observationTarget(i));}catch(error){assert.match(String(error),/ACK/);break;}}
 if(boundary==='import-ack'){
  const observation={id:'known-import',sessionId:'s',project:'P',agentId:'A',timestamp:new Date().toISOString(),title:'owned title',type:'other',narrative:'import nonce',facts:[],concepts:[],files:[],importance:5};f.loseImport();await assert.rejects(importOwnedObservation(f.j,f.request,{observation,exportData:{observations:{s:[observation]}},strategy:'skip'}),/ACK/);
 }
 if(boundary==='final-query'){f.loseQuery();await assert.rejects(f.request('observations?'),/final query/);}
 if(boundary==='post-write-journal'){let saves=0;f.j.save=async()=>{if(++saves===2)throw Error('receipt journal failed');};await assert.rejects(observeOwned(f.j,f.request,observationTarget(3)),/journal/);}
 if(boundary==='foreign-row')f.foreign();
 const result=await f.clean();assert.equal(result.success,boundary!=='foreign-row');assert.equal(f.deletes,boundary==='foreign-row'?0:1);
 if(boundary!=='foreign-row')assert(f.j.observationIntents.every(row=>row.canonicalVerified===true));
});
test('prewrite observation/import journal failure makes zero writes',async()=>{
 const f=sessionFixture();await startOwnedSession(f.j,f.request,sessionTarget);f.j.save=async()=>{throw Error('journal unavailable')};
 await assert.rejects(observeOwned(f.j,f.request,observationTarget(1)),/journal/);assert.equal(f.rows.length,0);
 const observation={id:'never',sessionId:'s',project:'P'};await assert.rejects(importOwnedObservation(f.j,f.request,{observation,exportData:{},strategy:'skip'}),/journal/);assert.equal(f.rows.length,0);
});
test('delayed session/start is retained even when session inventory is temporarily empty',async()=>{
 const j={sessionIntents:[],observationIntents:[],runId:'run-owned',save:async()=>{}};let finished=false,session,deletes=0;
 const req=async(route,body)=>{if(route.startsWith('sessions?'))return {sessions:session?[session]:[],total:session?1:0};throw Error('lost start ACK');};
 await assert.rejects(startOwnedSession(j,req,sessionTarget));j.verifyCompletion=e=>finished?completedProof(e):{state:'unknown'};
 const clean=()=>cleanupOwnedSession(j,{sessions:()=>req('sessions?'),observations:async()=>({observations:[],total:0,nextOffset:null}),remove:async()=>{deletes++;session=null;return {success:true}},handoff:async()=>({status:session?200:404})});
 assert.equal((await clean()).success,false);assert.equal(deletes,0);
 session={id:'s',project:'P',agentId:'A',cwd:'D:/owned',observationCount:0};finished=true;
 assert.equal((await clean()).success,true);assert.equal(deletes,1);
});
test('capture handler completion with pending retry or compressor is not terminal proof',()=>{
 const e={runId:'run',functionName:'mem::capture',requestIds:['owned-id']};
 for(const counts of [{},{noFurtherCanonicalWrites:0},{noFurtherCanonicalWrites:1}]){
  const proof=completionFromDiagnostics({runId:'run',requests:[{name:e.functionName,requestId:'owned-id',serverCompleted:true,phases:{'capture.terminal':{counts}}}]},e);
  assert.equal(proof.state,counts.noFurtherCanonicalWrites===1?'completed':'unknown');
 }
});
test('import intent refuses a preexisting matching observation before any write',async()=>{
 const j={save:async()=>{throw Error('should not journal')}};let writes=0;
 await assert.rejects(importOwnedObservation(j,async(route)=>{if(route==='import')writes++;return {observations:[{id:'existing'}],total:1,nextOffset:null}},{observation:{id:'existing',project:'P',sessionId:'s'},exportData:{},strategy:'skip'}),/not proven absent/);assert.equal(writes,0);
});

import {importOwnedNoChanges} from '../../../scripts/live-qualification.mjs';
test('still-running existing-row skip import holds session and memory cleanup independently of temporary absence',async()=>{
 const f=sessionFixture();await startOwnedSession(f.j,f.request,sessionTarget);let finished=false;
 f.j.memoryIntents=[{project:'P',agentId:'A',content:'nonce',receiptCompleted:true}];
 await assert.rejects(importOwnedNoChanges(f.j,async()=>{throw Error('skip ACK timeout')},{project:'P',sessionId:'s',exportData:{memories:[{id:'known'}],observations:{}}}));
 f.j.verifyCompletion=e=>e.functionName==='mem::import'&&!finished?{state:'unknown'}:completedProof(e);
 assert.equal((await f.clean()).success,false);assert.equal(f.deletes,0);
 let inspected=0;const io={discover:async()=>{inspected++;return {rows:[],complete:true}},read:async()=>({status:404}),remove:async()=>{throw Error('no removal')}};
 assert.equal((await cleanupOwnedMemories(f.j,io)).success,false);assert.equal(inspected,0);
 finished=true;assert.equal((await f.clean()).success,true);assert.equal((await cleanupOwnedMemories(f.j,io)).success,true);
});
test('existing-row skip import has exact IDs journaled before dispatch and completed ACK enables cleanup',async()=>{
 const j={runId:'run',save:async()=>{}},data={memories:[{id:'memory-owned'}],observations:{s:[{id:'obs-owned'}]}};
 await importOwnedNoChanges(j,async()=>{assert.deepEqual(j.importIntents[0].memoryIds,['memory-owned']);assert.deepEqual(j.importIntents[0].observationIds,['obs-owned']);return {sessions:0,memories:0,observations:0}},{project:'P',sessionId:'s',exportData:data});
 assert.equal(j.importIntents[0].receiptCompleted,true);
});

test('retry attempt IDs are journaled before dispatch and earlier completion never proves a later aborted write',async()=>{
 const records=[],j={runId:'run',save:async()=>{}},seen=[];
 const req=createRequest({base:'http://127.0.0.1/',requestRecords:records,fetchImpl:async(_url,options)=>{
  const id=options.headers['x-agentmemory-request-id'];assert(j.importIntents[0].requestIds.includes(id));seen.push(id);
  return seen.length===1?{status:500,ok:false,text:async()=>JSON.stringify({error:'recovery made no changes'})}:{status:200,ok:true,text:async()=>{throw new DOMException('second body aborted','AbortError')}};
 }});
 await assert.rejects(importOwnedNoChanges(j,req,{project:'P',sessionId:'s',exportData:{memories:[],observations:{}}}),/aborted/);
 assert.equal(new Set(seen).size,2);assert.deepEqual(j.importIntents[0].requestIds,seen);
 const done=id=>({name:'mem::import',requestId:id,serverCompleted:true});
 assert.equal(completionFromDiagnostics({runId:'run',requests:[done(seen[0])]},j.importIntents[0]).state,'unknown');
 assert.equal(completionFromDiagnostics({runId:'run',requests:seen.map(done)},j.importIntents[0]).state,'completed');
 assert.equal(records[1].outcome,'body_abort');
});
