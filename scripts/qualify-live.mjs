import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {createRecordWriter,measureGraph,createOwnedSlot,rememberOwned,cleanupOwnedSlots,cleanupOwnedMemories,cleanupStages,createRequest,createCompletionVerifier,startOwnedSession,observeOwned,importOwnedObservation,cleanupOwnedSession,importOwnedNoChanges} from './live-qualification.mjs';
const [phase,record,installRoot,project,thread,revision,base='http://127.0.0.1:3111/agentmemory/']=process.argv.slice(2);
if(!['before','after'].includes(phase)||![record,installRoot,project,thread,revision].every(x=>typeof x==='string'&&x.length))throw Error('Usage: qualify-live.mjs before|after RECORD INSTALL_ROOT PROJECT HISTORY_SESSION REVISION [LOOPBACK_BASE_URL]');
if(!['127.0.0.1','localhost','[::1]'].includes(new URL(base).hostname))throw Error('Qualification requires a loopback service');
const requestRecords=[];
const reportPath=path.join(record,revision+'-live-e2e.json'), baselinePath=path.join(record,revision+'-live-before.json');
const transientRetries=[];
const hash=o=>createHash('sha256').update(JSON.stringify([o.id,o.title,o.narrative,o.facts,o.project,o.sessionId])).digest('hex');
const req=createRequest({base,secret:process.env.AGENTMEMORY_SECRET,requestRecords,transientRetries});
const original=()=>req('observations?'+new URLSearchParams({project,sessionId:thread,order:'asc',limit:'20'}));
if(phase==='before'){
 const rows=(await original()).observations; assert.equal(rows.length,20);
 const manifest=JSON.parse(await readFile(path.join(installRoot,'config','install-manifest.json'),'utf8'));
 const baseline={kind:'operating-live-before',at:new Date().toISOString(),release:manifest.release_revision,history:rows.map(o=>({id:o.id,hash:hash(o)})),authHash:createHash('sha256').update(await readFile(path.join(installRoot,'config','secret.dpapi'))).digest('hex')};
 await writeFile(baselinePath,JSON.stringify(baseline,null,2)); console.log(JSON.stringify({phase,history:rows.length,release:baseline.release}));
}else{
 const baseline=JSON.parse(await readFile(baselinePath,'utf8'));
 const nonce=revision+'qa'+randomUUID().replaceAll('-',''); const session='e2e-'+revision+'-'+randomUUID();
 const report={kind:'operating-rest-mcp',at:new Date().toISOString(),cases:[],transientRetries,requestRecords,owned:{session,memoryIds:[],observations:[],slots:[]},cleanup:{session:true,memories:false,slots:false},success:false};
 const save=createRecordWriter(reportPath,report);
 const journal={slots:report.owned.slots,memoryIntents:[],sessionIntents:[],observationIntents:[],importIntents:[],save};Object.assign(report.owned,{memoryIntents:journal.memoryIntents,sessionIntents:journal.sessionIntents,observationIntents:journal.observationIntents,importIntents:journal.importIntents});
 const note=(name,evidence={})=>report.cases.push({name,...evidence});
 const observations=()=>req('observations?'+new URLSearchParams({project,sessionId:session,limit:'100'}));
 const memoryPage=latest=>req('memories?'+new URLSearchParams({project,q:nonce,latest:String(latest),limit:'50'}));
 const recent=()=>req('mcp/resources/read',{uri:'agentmemory://project/'+project+'/recent'});
 const handoff=agentId=>req('mcp/prompts/get',{name:'session_handoff',arguments:{session_id:session,...(agentId?{agentId}:{})}},{raw:true});
 try{
  const manifest=JSON.parse(await readFile(path.join(installRoot,'config','install-manifest.json'),'utf8'));
  assert.equal(manifest.release_revision,revision);assert.equal(manifest.installation_status,'activated');
  await req('health');const unauth=await req('memories?project='+project,undefined,{auth:false,raw:true}); assert([401,403].includes(unauth.status));
  const currentAuth=createHash('sha256').update(await readFile(path.join(installRoot,'config','secret.dpapi'))).digest('hex');assert.equal(currentAuth,baseline.authHash);
  note(revision+' selected, REST healthy, authentication preserved and unauthenticated access rejected',{release:manifest.release_revision,dataContract:manifest.data_contract_version,unauthenticatedStatus:unauth.status,authPreserved:true});
  const after=(await original()).observations;assert.deepEqual(after.map(o=>({id:o.id,hash:hash(o)})),baseline.history);
  note('20 actual historical observations survive cutover with identical source text',{count:after.length});
  const graph=await measureGraph(()=>req('graph/query',{project,limit:20,edgeLimit:20,edgeOffset:0}),{edgeInventoryRequested:true});report.graph=graph;await save();assert.equal(graph.readable,true,'Graph read failed: '+JSON.stringify(graph));
  note('operating graph read result; exact-index qualification is separate',graph);
  const runtimeState=JSON.parse((await readFile(path.join(installRoot,'data','runtime-state.json'),'utf8')).replace(/^\uFEFF/,''));
  journal.runId=runtimeState.run_id;
  journal.verifyCompletion=createCompletionVerifier({file:path.join(installRoot,'logs','worker-diagnostics-'+journal.runId+'.json'),runId:journal.runId});
  await startOwnedSession(journal,req,{project,sessionId:session,cwd:installRoot,agentId:'codex-global',title:nonce});
  for(let i=0;i<2;i++){
   await observeOwned(journal,req,{hookType:'prompt_submit',project,sessionId:session,cwd:installRoot,agentId:'codex-global',timestamp:new Date().toISOString(),eventId:nonce+':'+i,data:{prompt:nonce+' source '+i+' operating synthetic capture qualification'}});
  }
  let obs;
  for(let i=0;i<20;i++){obs=await observations();if(obs.observations.length===2)break;await new Promise(r=>setTimeout(r,250));}
  assert.equal(obs.observations.length,2);report.owned.observations=obs.observations.map(x=>x.id);await save();
  const search=await req('search',{project,query:nonce,limit:20,format:'full',trackAccess:false});assert(JSON.stringify(search).includes(session));
  note('official session start and capture persist two observations and search returns the source session',{observationCount:2,searchFound:true});
  const page1=await req('observations?'+new URLSearchParams({project,sessionId:session,limit:'1',order:'asc'}));
  assert.equal(page1.offset,0);assert.equal(page1.nextOffset,1);
  const page2=await req('observations?'+new URLSearchParams({project,sessionId:session,limit:'1',order:'asc',cursor:page1.nextCursor}));
  assert.equal(page2.offset,1);assert.equal(page2.nextOffset,null);assert.equal(page2.nextCursor,null);
  assert.notEqual(page1.observations[0].id,page2.observations[0].id);
  note('observation cursor returns actual offset and terminates without duplicate rows',{offsets:[page1.offset,page2.offset],nextOffset:page2.nextOffset});
  const content=nonce+' synthetic memory qualification alpha beta gamma delta epsilon.';
  const remember=async()=>{const result=await rememberOwned(journal,req,{project,agentId:'codex-global',content});assert(result.memory?.id);report.owned.memoryIds.push(result.memory.id);await save();return result.memory;};
  await remember();await remember();await Promise.all([remember(),remember()]);
  let page=await memoryPage(true);assert.equal(page.memories.length,1);assert.equal(page.memories[0].version,4);const head=page.memories[0];
  note('operating concurrent remember preserves one latest head at version 4',{latestCount:1,version:4,createdCount:4});
  const wrong=await req('forget',{project:'wrong-project-'+nonce,memoryId:head.id},{raw:true});assert(wrong.status>=400||wrong.data.success===false);assert.deepEqual((await memoryPage(true)).memories.map(x=>x.id),[head.id]);
  note('wrong project forget rejected while the owned head is preserved',{status:wrong.status,preserved:true});
  const foreignPage=await req('sessions?'+new URLSearchParams({project,sessionId:session,agentId:'other-'+nonce}));assert.equal(foreignPage.sessions.length,0);
  const foreignHandoff=await handoff('other-'+nonce);assert.equal(foreignHandoff.status,404);assert.equal((await handoff()).status,200);
  assert(!JSON.stringify(await recent()).includes(session));
  note('session, recent and handoff scope filtering works',{foreignSessions:0,foreignHandoffStatus:404,ownHandoffStatus:200,summaryDisabledRecentAbsent:true});
  const target={kind:'session',id:session};
  for(const action of ['archive','restore']){
   const preview=await req('archive',{project,target,action,dryRun:true}); assert(preview.success);
   const applied=await req('archive',{project,target,action,dryRun:false,expectedRevision:preview.expectedRevision,expectedDigest:preview.expectedDigest,reason:revision+' temporary qualification session '+action});assert(applied.success);
   if(action==='archive'){assert.equal((await handoff()).status,404);assert(!JSON.stringify(await recent()).includes(session));}
   else assert.equal((await handoff()).status,200);
  }
  note('official archive hides test session from recent and handoff; restore makes it visible',{archiveHandoffStatus:404,restoreHandoffStatus:200});
  const badExport={version:'0.9.30',exportedAt:new Date().toISOString(),sessions:[null],observations:{},memories:[],summaries:[],profiles:[]};
  const invalid=await req('import',{exportData:badExport,strategy:'merge'},{raw:true});assert(invalid.status>=400||invalid.data.success===false);assert.match(JSON.stringify(invalid.data),/Invalid imported sessions row/);
  assert.equal((await observations()).observations.length,2);assert.deepEqual((await memoryPage(true)).memories.map(x=>x.id),[head.id]);
  note('malformed import rejected before altering the test session and memory',{status:invalid.status,testRowsPreserved:true,strategy:'merge'});
  const emptyExport=()=>({version:'0.9.30',exportedAt:new Date().toISOString(),sessions:[],observations:{},memories:[],summaries:[],profiles:[]});
  const identitySession=nonce+'_other_bucket';
  const identityOwner={id:identitySession,project,agentId:'codex-global',cwd:installRoot,startedAt:new Date().toISOString(),status:'completed',observationCount:0};
  const identityObs={id:nonce+'_identity',sessionId:session,project,agentId:'codex-global',timestamp:new Date().toISOString(),type:'other',title:nonce+' identityneedle',narrative:nonce+' unique identity content',facts:[],concepts:[],files:[],importance:5};
  const identityMemory=id=>({...head,id,sessionIds:[],sourceSessionIds:[],sourceObservationIds:[],supersedes:[]});
  const currentRows=await observations();
  const identityCases=[
   ['cross-bucket incoming ID',{...emptyExport(),sessions:[identityOwner],observations:{[session]:[identityObs],[identitySession]:[{...identityObs,sessionId:identitySession}]}},/search ID collision/],
   ['incoming observation and memory ID',{...emptyExport(),observations:{[session]:[identityObs]},memories:[identityMemory(identityObs.id)]},/search ID collision/],
   ['retained observation in other bucket',{...emptyExport(),sessions:[identityOwner],observations:{[identitySession]:[{...identityObs,id:obs.observations[0].id,sessionId:identitySession}]}},/retained canonical observation/],
   ['retained memory against incoming observation',{...emptyExport(),observations:{[session]:[{...identityObs,id:head.id}]}},/retained canonical memory/],
   ['retained observation against incoming memory',{...emptyExport(),memories:[identityMemory(obs.observations[0].id)]},/retained canonical observation/]
  ];
  for(const strategy of ['merge','skip'])for(const [name,exportData,expected] of identityCases){
   const rejected=await req('import',{exportData,strategy},{raw:true});
   assert(rejected.status>=400||rejected.data.success===false);assert.match(JSON.stringify(rejected.data),expected);
   assert.deepEqual((await observations()).observations,currentRows.observations);
   assert.equal((await req('memories/'+head.id+'?project='+project)).memory.content,head.content);
   assert.equal((await req('sessions?'+new URLSearchParams({project,sessionId:identitySession}))).sessions.length,0);
   const identities=await req('search',{project,query:nonce,format:'full',limit:30,trackAccess:false});
   assert(JSON.stringify(identities).includes(session));assert(!JSON.stringify(identities).includes(identityObs.id));
   note('live import '+name+' rejected before source/search mutation '+strategy,{status:rejected.status,canonicalRowsPreserved:true,searchPreserved:true});
  }
  for(const field of ['concepts','files']){
   const incoming={...head,id:nonce+'_invalid_'+field};delete incoming[field];
   const rejected=await req('import',{exportData:{...emptyExport(),memories:[incoming]},strategy:'merge'},{raw:true});
   assert(rejected.status>=400||rejected.data.success===false);assert.match(JSON.stringify(rejected.data),/concepts.*files|files.*concepts/);
   assert.equal((await req('memories/'+incoming.id+'?project='+project,undefined,{raw:true})).status,404);
  }
  const foreign={...head,id:nonce+'_foreign',project:'foreign-'+nonce,sessionIds:[],sourceSessionIds:[],sourceObservationIds:[obs.observations[0].id]};
  for(const strategy of ['merge','skip']){
   const rejected=await req('import',{exportData:{...emptyExport(),memories:[foreign]},strategy},{raw:true});
   assert(rejected.status>=400||rejected.data.success===false);assert.match(JSON.stringify(rejected.data),/project|owner|scope/i);
   assert.equal((await req('memories/'+foreign.id+'?project='+foreign.project,undefined,{raw:true})).status,404);
  }
  assert.equal((await observations()).observations.length,2);assert.deepEqual((await memoryPage(true)).memories.map(x=>x.id),[head.id]);
  note('required memory arrays and retained foreign observation provenance rejected before writes',{requiredArrays:['concepts','files'],foreignStrategies:['merge','skip'],canonicalRowsPreserved:true});
  const compressed={id:nonce+'_compressed',sessionId:session,project,agentId:'codex-global',timestamp:new Date().toISOString(),type:'other',title:nonce+' importedcompressedneedle',narrative:nonce+' imported compressed content',facts:[],concepts:[],files:[],importance:5};
  for(const field of ['facts','concepts','files'])for(const kind of ['missing','null','string','element']){
   const incoming={...compressed,id:nonce+'_invalid_'+field+'_'+kind};
   if(kind==='missing')delete incoming[field];else incoming[field]=kind==='null'?null:kind==='string'?'bad':[42];
   const rejected=await req('import',{exportData:{...emptyExport(),observations:{[session]:[incoming,{...compressed,id:nonce+'_must_not_store'}]}},strategy:'merge'},{raw:true});
   assert(rejected.status>=400||rejected.data.success===false);assert.match(JSON.stringify(rejected.data),/observations.*(facts|concepts|files)|observations require/);
   assert.equal((await observations()).observations.length,2);
   note('compressed '+field+'/'+kind+' rejected and stored test observations unchanged',{status:rejected.status,storedCount:2});
  }
  const sameHead={...head,title:nonce+' overwritecandidate',content:nonce+' overwritecandidate'};
  const skipped=await importOwnedNoChanges(journal,req,{project,sessionId:session,exportData:{...emptyExport(),memories:[sameHead]}});
  assert.equal(skipped.memories,0);assert.equal((await req('memories/'+head.id+'?project='+project)).memory.content,head.content);
  note('normal skip preserves existing owned memory',{writtenMemories:0});
  const accepted=await importOwnedObservation(journal,req,{observation:compressed,exportData:{...emptyExport(),observations:{[session]:[compressed]}},strategy:'skip'});
  assert.equal(accepted.observations,1);report.owned.observations.push(compressed.id);await save();
  assert(JSON.stringify(await req('search',{project,query:'importedcompressedneedle',limit:10,format:'full',trackAccess:false})).includes(compressed.id));
  note('normal absent observation import accepts empty arrays and is immediately searchable',{writtenObservations:1});
  const repeated=await importOwnedNoChanges(journal,req,{project,sessionId:session,exportData:{...emptyExport(),observations:{[session]:[{...compressed,title:'overwritecandidate'}]}}});
  assert.equal(repeated.observations,0);assert.equal((await observations()).observations.find(o=>o.id===compressed.id).title,compressed.title);
  note('observation skip retains original stored title',{writtenObservations:0});
  const label=nonce.toLowerCase(), slotScopes=[{project,scope:'project'},{project:'agentmemory-'+revision+'-e2e-'+nonce,scope:'project'}];
  // Query context without seeding foreign-project defaults.
  for(let i=0;i<slotScopes.length;i++){
   const target={label,...slotScopes[i]}, content=nonce+' slot '+i;
   const made=await createOwnedSlot(journal,req,{...target,content});assert(made.success);
  }
  for(let i=0;i<slotScopes.length;i++){
   const read=await req('slot?'+new URLSearchParams({label,...slotScopes[i]}));assert.equal(read.slot.content,report.owned.slots[i].content);
   const mcp=await req('mcp/call',{name:'memory_slot_get',arguments:{label,...slotScopes[i]}});assert(JSON.stringify(mcp).includes(report.owned.slots[i].content));assert(!JSON.stringify(mcp).includes(report.owned.slots[1-i].content));
   const context=await req('context',{project:slotScopes[i].project,sessionId:session,agentId:'codex-global',budget:4000});
   assert(JSON.stringify(context).includes(report.owned.slots[i].content));assert(!JSON.stringify(context).includes(report.owned.slots[1-i].content));
  }
  note('identical project-slot label has separate content and context across two exact projects',{projects:slotScopes.map(x=>x.project),scopeIsolation:true});
  const gone=obs.observations[0].id;
  const preview=await req('forget',{project,sessionId:session,observationIds:[gone],dryRun:true});assert(preview.success!==false);
  const partial=await req('forget',{project,sessionId:session,observationIds:[gone],dryRun:false});assert(partial.success!==false);
  const remain=(await observations()).observations;assert.equal(remain.length,2);assert(!remain.some(x=>x.id===gone));
  const sessionRead=await req('sessions?'+new URLSearchParams({project,sessionId:session}));assert.equal(sessionRead.sessions[0].observationCount,2);assert(!sessionRead.sessions[0].summary);assert(!sessionRead.sessions[0].firstPrompt);
  assert.equal((await handoff()).status,200);await recent();
  note('partial forget retains two sources and returns no unproved summary or forgotten first prompt',{remaining:2,summaryAbsent:true,firstPromptAbsent:true});
  await req('session/end',{sessionId:session});
  const ended=await req('sessions?'+new URLSearchParams({project,sessionId:session}));assert.equal(ended.sessions[0].status,'completed');
  note('official session end completes the test session',{status:'completed'});
 }catch(error){report.error=String(error);process.exitCode=1;}
 finally{
  const discovery=async()=>{
   const rows=[];let total;const limit=200;
   for(let offset=0;offset<20000;offset+=limit){
    const page=await req('memories?'+new URLSearchParams({project,agentId:'codex-global',latest:'false',limit:String(limit),offset:String(offset)}));
    if(!Array.isArray(page.memories)||!Number.isSafeInteger(page.total)||page.total<0)throw Error('Invalid canonical memory inventory');
    if(total!==undefined&&total!==page.total)return {rows,complete:false};total=page.total;rows.push(...page.memories);
    if(offset+page.memories.length>=total)return {rows,complete:true};if(!page.memories.length)throw Error('Incomplete memory inventory');
   }return {rows,complete:false};
  };
  const stages=await cleanupStages([
   ['slots',()=>cleanupOwnedSlots(journal,req)],
   ['session',()=>cleanupOwnedSession(journal,{
    sessions:()=>req('sessions?'+new URLSearchParams({project,sessionId:session})),observations,
    remove:async()=>{const preview=await req('forget',{project,sessionId:session,dryRun:true});assert(preview.success!==false);return req('forget',{project,sessionId:session,dryRun:false});},handoff:()=>handoff(),
   })],
   ['memories',()=>cleanupOwnedMemories(journal,{discover:discovery,read:id=>req('memories/'+id+'?project='+project,undefined,{raw:true}),remove:async id=>{const result=await req('forget',{project,memoryId:id,dryRun:false});assert(result.success);assert(!result.cleanupFailed);}})],
  ]);
  report.cleanup=Object.fromEntries(stages.results.map(row=>[row.name,row.state]));report.cleanupDetails=stages;
  report.success=!report.error&&stages.success;
  if(!stages.success)process.exitCode=1;
  await save();console.log(JSON.stringify({success:report.success,cases:report.cases.length,cleanup:report.cleanup,error:report.error,cleanupError:report.cleanupError}));
 }
}




