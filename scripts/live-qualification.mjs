import {readFile,writeFile,rename} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
export function createRecordWriter(file,record){
 let previous=Promise.resolve();
 return ()=>{const write=previous.catch(()=>{}).then(async()=>{const temporary=file+'.tmp-'+randomUUID();await writeFile(temporary,JSON.stringify(record,null,2));await rename(temporary,file);});previous=write;return write;};
}
export function graphObservation(graph,{elapsedMs,expectedRevision,edgeInventoryRequested=false}={}){
 if(!graph||typeof graph!=='object'||!Array.isArray(graph.nodes)||!Array.isArray(graph.edges)||[...graph.nodes,...graph.edges].some(row=>!row||typeof row!=='object'||typeof row.id!=='string'))throw TypeError('Invalid graph response rows');
 for(const field of ['fromIndex','fromSnapshot','totalsExact','edgeInventoryExact'])if(graph[field]!==undefined&&typeof graph[field]!=='boolean')throw TypeError('Invalid graph '+field);
 if(graph.warning!==undefined&&typeof graph.warning!=='string')throw TypeError('Invalid graph warning');
 if(graph.edgeInventoryRevision!==undefined&&typeof graph.edgeInventoryRevision!=='string')throw TypeError('Invalid graph revision');
 for(const field of ['totalNodes','totalEdges'])if(graph[field]!==undefined&&(!Number.isFinite(graph[field])||graph[field]<0))throw TypeError('Invalid graph '+field);
 const revisionMatches=expectedRevision===undefined||graph.edgeInventoryRevision===undefined?null:expectedRevision===graph.edgeInventoryRevision;
 const inexact=graph.fromSnapshot===true||graph.fromIndex===false||graph.totalsExact===false||graph.edgeInventoryExact===false||revisionMatches===false||Boolean(graph.warning);
 const exact=inexact?false:graph.fromIndex===true&&graph.totalsExact===true&&(!edgeInventoryRequested||graph.edgeInventoryExact===true)&&revisionMatches===true?true:null;
 return {readable:true,indexedPath:graph.fromIndex===undefined?null:graph.fromIndex===true&&graph.fromSnapshot!==true,exactIndex:exact,nodes:graph.nodes.length,edges:graph.edges.length,warning:graph.warning??null,fromIndex:graph.fromIndex??null,fromSnapshot:graph.fromSnapshot??null,totalsExact:graph.totalsExact??null,edgeInventoryExact:graph.edgeInventoryExact??null,edgeInventoryRevision:graph.edgeInventoryRevision??null,revisionMatches,totalNodes:graph.totalNodes??null,totalEdges:graph.totalEdges??null,elapsedMs};
}
export async function measureGraph(request,options={}){
 const started=performance.now();
 try{return {...graphObservation(await request(),{...options,elapsedMs:performance.now()-started}),outcome:'ok'};}
 catch(error){return {readable:false,exactIndex:null,outcome:error?.name==='TimeoutError'||error?.name==='AbortError'?'timeout':'error',elapsedMs:performance.now()-started,error:String(error),clientAbortObserved:error?.name==='TimeoutError'||error?.name==='AbortError',serverCompletion:'unknown'};}
}
export function createRequest({base,secret,requestRecords=[],transientRetries=[],fetchImpl=fetch,deadlineMs=30000}){
 return async function request(route,body,{raw=false,auth=true,method,attempt=0,requestId=randomUUID(),onDispatch}={}){
  const started=performance.now(),trace={requestId,route:route.split('?')[0],attempt,deadlineMs,startedAt:new Date().toISOString(),headersReceived:false,bodyComplete:false,serverCompletion:'unknown'};requestRecords.push(trace);
  let stage='dispatch',res,data;
  try{
   await onDispatch?.(requestId);stage='headers';
   res=await fetchImpl(base+route,{method:method??(body===undefined?'GET':'POST'),headers:{...(auth?{authorization:'Bearer '+secret}:{}),'content-type':'application/json','x-agentmemory-request-id':requestId},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(deadlineMs)});
   trace.headersReceived=true;trace.headerElapsedMs=performance.now()-started;trace.status=res.status;stage='body';
   const bodyText=await res.text();trace.bodyComplete=true;stage='parse';data=JSON.parse(bodyText);trace.outcome=res.ok?'http_response':'http_error';trace.responseComplete=true;
  }catch(error){const aborted=['TimeoutError','AbortError'].includes(error?.name);trace.outcome=stage==='body'?(aborted?'body_abort':'body_transport_error'):stage==='parse'?'parse_error':stage==='dispatch'?'dispatch_error':aborted?'client_abort':'transport_error';trace.error=String(error);throw error;}
  finally{trace.elapsedMs=performance.now()-started;}
  if(['archive','import','forget'].includes(route)&&!res.ok&&JSON.stringify(data).includes('recovery made no changes')&&attempt<30){
   trace.noChangesAcknowledged=true;transientRetries.push({route,attempt:attempt+1,status:res.status,reason:'explicit writer-busy rejection; no changes made'});
   await new Promise(resolve=>setTimeout(resolve,397+(attempt%7)*61));return request(route,body,{raw,auth,method,attempt:attempt+1,onDispatch});
  }
  if(raw)return {status:res.status,data};
  if(!res.ok)throw Error(route+': '+res.status+' '+JSON.stringify(data).slice(0,700));return data;
 };
}
export function completionFromDiagnostics(snapshot,entry){
 if(!entry.runId||snapshot?.runId!==entry.runId||!entry.requestIds?.length)return {state:'unknown',reason:'Missing or changed server/request identity'};
 const records=snapshot.requests??[];
 const done=entry.requestIds.every(id=>{
  const row=records.find(row=>row.requestId===id&&row.name===entry.functionName&&row.serverCompleted===true);
  if(!row)return false;
  return entry.functionName!=='mem::capture'||row.phases?.['capture.terminal']?.counts?.noFurtherCanonicalWrites===1;
 });
 return done?{state:'completed',runId:entry.runId,requestIds:[...entry.requestIds],functionName:entry.functionName,noFurtherCanonicalWrites:true}:{state:'unknown',reason:'Server operation still active or positive completion evidence unavailable'};
}
export function createCompletionVerifier({file,runId,waitMs=5000}){
 return async entry=>{
  if(entry.runId!==runId)return {state:'unknown',reason:'Server run identity changed'};
  const until=performance.now()+waitMs;let proof;
  do{try{proof=completionFromDiagnostics(JSON.parse((await readFile(file,'utf8')).replace(/^\uFEFF/,'')),entry);}catch(error){proof={state:'unknown',reason:String(error)};}if(proof.state==='completed')return proof;if(performance.now()>=until)return proof;await new Promise(resolve=>setTimeout(resolve,200));}while(true);
 };
}
async function persist(journal){await journal.save();}
export async function ensureOwnedWriteFinished(journal,entry){
 if(entry.state==='not_created')return;
 if(entry.receiptCompleted===true)return;
 const proof=entry.completionProof??await journal.verifyCompletion?.(entry);
 if(!proof||!['completed','cancelled'].includes(proof.state)||proof.noFurtherCanonicalWrites!==true||proof.runId!==entry.runId||proof.functionName!==entry.functionName||!entry.requestIds?.length||entry.requestIds.some(id=>!proof.requestIds?.includes(id)))throw Error('Server write completion unknown; retained until completion or definite cancellation is proven');
 entry.completionProof=proof;await persist(journal);
}
async function ownedWrite(journal,collection,target,functionName,operation,terminal=()=>true){
 const requestId=randomUUID(),entry={...target,functionName,runId:journal.runId,requestIds:[requestId],state:'pending',writeAttempted:false};(journal[collection]??=[]).push(entry);
 try{await persist(journal);}catch(error){entry.state='not_created';throw error;}
 const options={requestId,onDispatch:async id=>{if(!entry.requestIds.includes(id)){entry.requestIds.push(id);await persist(journal);}}};
 entry.writeAttempted=true;
 try{const result=await operation(options,entry);entry.receiptCompleted=terminal(result)===true;entry.state='confirmed';if(result.memory?.id)entry.id=result.memory.id;if(result.observationId)entry.id=result.observationId;await persist(journal);return result;}
 catch(error){entry.state='unknown';entry.error=String(error);try{await persist(journal);}catch(saveError){entry.journalError=String(saveError);throw new AggregateError([error,saveError],String(error)+'; ownership journal failed');}throw error;}
}
export async function createOwnedSlot(journal,request,target){
 const route='slot?'+new URLSearchParams({label:target.label,project:target.project,scope:target.scope});
 const before=await request(route,undefined,{raw:true});if(before.status!==404)throw Error('Slot target is not proven absent; no write attempted');
 return ownedWrite(journal,'slots',target,'mem::slot-create',async options=>{const made=await request('slot',{...target,pinned:true},options);if(made.success!==true)throw Error('Slot creation not acknowledged');return made;});
}
export async function rememberOwned(journal,request,target){
 return ownedWrite(journal,'memoryIntents',target,'mem::remember',async options=>{const made=await request('remember',{project:target.project,agentId:target.agentId,content:target.content},options);if(!made.memory?.id)throw Error('Remember not acknowledged');return made;});
}
export async function startOwnedSession(journal,request,target){
 const before=await request('sessions?'+new URLSearchParams({project:target.project,sessionId:target.sessionId}));if(before.sessions?.length!==0||before.total!==0)throw Error('Session target is not proven absent; no write attempted');
 return ownedWrite(journal,'sessionIntents',target,'api::session::start',async options=>{const made=await request('session/start',target,options);if(made.session?.id!==target.sessionId)throw Error('Session creation not acknowledged');return made;});
}
export async function observeOwned(journal,request,target){
 const captureKey='cap_'+createHash('sha256').update(`${target.project}\0${target.sessionId}\0${target.eventId}`).digest('hex').slice(0,40);
 const stamp=Date.parse(target.timestamp);if(!Number.isFinite(stamp)||stamp<Date.UTC(2020,0,1)||stamp>=Date.UTC(2100,0,1))throw Error('Owned capture requires a valid timestamp');
 const intent={project:target.project,sessionId:target.sessionId,agentId:target.agentId,eventId:target.eventId,timestamp:target.timestamp,captureKey,id:`obs_${stamp.toString(36)}_${captureKey.slice(4,16)}`,narrative:target.data.prompt};
 let ownedEntry;const result=await ownedWrite(journal,'observationIntents',intent,'mem::capture',async (options,entry)=>{ownedEntry=entry;const {agentId,...payload}=target;const made=await request('observe',payload,options);if(made.state!=='completed'||!['accepted','duplicate'].includes(made.status)||made.observationId!==intent.id)throw Error('Capture not completed or identity mismatched');return made;},()=>false);
 await ensureOwnedWriteFinished(journal,ownedEntry);return result;
}
export async function importOwnedObservation(journal,request,{observation,exportData,strategy}){
 const before=await request('observations?'+new URLSearchParams({project:observation.project,sessionId:observation.sessionId,limit:'500'}));
 if(!Array.isArray(before.observations)||before.nextOffset!==null||before.total!==before.observations.length||before.observations.some(row=>row.id===observation.id))throw Error('Imported observation target is not proven absent; no write attempted');
 return ownedWrite(journal,'observationIntents',{...observation,kind:'import'},'mem::import',async options=>{const made=await request('import',{exportData,strategy},options);if(made.observations!==1)throw Error('Owned observation import not acknowledged');return made;});
}
export async function importOwnedNoChanges(journal,request,{project,sessionId,exportData}){
 return ownedWrite(journal,'importIntents',{project,sessionId,memoryIds:(exportData.memories??[]).map(row=>row.id),observationIds:Object.values(exportData.observations??{}).flat().map(row=>row.id)},'mem::import',async options=>{
  const made=await request('import',{exportData,strategy:'skip'},options);
  if(made.memories!==0||made.observations!==0||made.sessions!==0)throw Error('No-change import not acknowledged');return made;
 });
}
export async function cleanupOwnedSlots(journal,request){
 const errors=[];
 for(const target of journal.slots){
  if(target.state==='not_created')continue;
  try{
   await ensureOwnedWriteFinished(journal,target);
   const route='slot?'+new URLSearchParams({label:target.label,project:target.project,scope:target.scope});const read=await request(route,undefined,{raw:true});
   if(read.status===404){target.state='removed_verified';await persist(journal);continue;}
   if(read.status!==200)throw Error('Slot read failed');const row=read.data?.slot;
   if(!row||row.label!==target.label||row.project!==target.project||row.scope!==target.scope||row.content!==target.content){target.state='ownership_conflict';throw Error('Slot ownership conflict; retained');}
   try{const removed=await request(route,undefined,{method:'DELETE'});if(removed.success!==true)throw Error('Delete not acknowledged');}catch(error){target.deleteAckError=String(error);}
   const absent=await request(route,undefined,{raw:true});if(absent.status!==404)throw Error('Slot absence not verified');target.state='removed_verified';await persist(journal);
  }catch(error){if(target.state!=='ownership_conflict')target.state='unknown';target.cleanupError=String(error);errors.push({target:target.label,state:target.state,error:String(error)});try{await persist(journal);}catch(saveError){errors.push({target:target.label,error:String(saveError)});}}
 }
 return {success:errors.length===0&&journal.slots.every(row=>['not_created','removed_verified'].includes(row.state)),errors};
}
export async function cleanupOwnedMemories(journal,{discover,read,remove}){
 const errors=[],active=(journal.memoryIntents??[]).filter(row=>row.state!=='not_created'),ready=[];
 for(const operation of journal.importIntents??[]){if(operation.state==='not_created'||!active.some(row=>row.project===operation.project))continue;try{await ensureOwnedWriteFinished(journal,operation);}catch(error){return {success:false,errors:[{error:String(error)}]};}}
 for(const target of active){try{await ensureOwnedWriteFinished(journal,target);ready.push(target);}catch(error){target.state='unknown';errors.push({error:String(error)});}}
 if(!ready.length)return {success:!errors.length,errors};
 let discovery;try{discovery=await discover();if(!Array.isArray(discovery.rows)||discovery.complete!==true)throw Error('Incomplete canonical memory inventory');}catch(error){for(const row of ready)row.state='unknown';return {success:false,errors:[...errors,{error:String(error)}]};}
 const matches=(row,target)=>row&&row.project===target.project&&row.agentId===target.agentId&&row.content===target.content;
 for(const target of ready){
  const local=[];const ids=new Set([...(target.id?[target.id]:[]),...discovery.rows.filter(row=>matches(row,target)).map(row=>row.id)]);
  for(const id of ids){try{const current=await read(id);if(current.status===404)continue;if(current.status!==200||!matches(current.data?.memory,target))throw Error('Memory ownership conflict/read failure; retained');try{await remove(id);}catch{}if((await read(id)).status!==404)throw Error('Memory absence not verified');}catch(error){local.push({id,error:String(error)});}}
  try{const after=await discover();if(after.complete!==true||!Array.isArray(after.rows)||after.rows.some(row=>matches(row,target)))throw Error('Owned memory absence/inventory completeness not verified');}catch(error){local.push({error:String(error)});}
  target.state=local.length?'unknown':'removed_verified';errors.push(...local);
 }
 try{await persist(journal);}catch(error){errors.push({error:String(error)});}return {success:errors.length===0,errors};
}
function ownedObservation(row,intent){
 if(row.id!==intent.id||row.sessionId!==intent.sessionId||row.agentId!==intent.agentId||row.timestamp!==intent.timestamp||row.narrative!==intent.narrative)return false;
 if(row.project!==undefined&&row.project!==intent.project)return false;
 if(intent.kind!=='import')return row.captureKey===intent.captureKey;
 return ['title','type','importance'].every(key=>row[key]===intent[key])&&['facts','concepts','files'].every(key=>JSON.stringify(row[key])===JSON.stringify(intent[key]));
}
export async function cleanupOwnedSession(journal,{sessions,observations,remove,handoff}){
 const starts=journal.sessionIntents??[],intents=(journal.observationIntents??[]).filter(row=>row.state!=='not_created');
 if(!starts.length||starts.every(row=>row.state==='not_created'))return {success:true,state:'not_created'};
 try{
  for(const entry of [...starts.filter(row=>row.state!=='not_created'),...intents,...(journal.importIntents??[]).filter(row=>row.state!=='not_created'&&starts.some(start=>start.sessionId===row.sessionId))])await ensureOwnedWriteFinished(journal,entry);
  if(starts.length!==1)throw Error('Ambiguous session ownership');const target=starts[0],inventory=await sessions();
  if(inventory.total===0&&inventory.sessions?.length===0){if((await handoff()).status!==404)throw Error('Session handoff absence not verified');target.state='removed_verified';await persist(journal);return {success:true,state:'removed_verified'};}
  const row=inventory.sessions?.[0];if(inventory.total!==1||inventory.sessions.length!==1||!row||row.id!==target.sessionId||row.project!==target.project||row.agentId!==target.agentId||row.cwd!==target.cwd)throw Error('Session ownership conflict; retained');
  const sources=await observations();if(!Array.isArray(sources.observations)||sources.nextOffset!==null||sources.total!==sources.observations.length||sources.total!==row.observationCount)throw Error('Incomplete/unfiltered canonical session inventory; retained');
  if(sources.observations.some(source=>!intents.some(intent=>ownedObservation(source,intent))))throw Error('Session contains an unowned source; retained');
  for(const source of sources.observations){const intent=intents.find(intent=>ownedObservation(source,intent));intent.id=source.id;intent.canonicalVerified=true;}await persist(journal);
  try{const result=await remove();if(result.success!==true||result.cleanupFailed)throw Error('Session cleanup not acknowledged');}catch(error){target.deleteAckError=String(error);}
  const after=await sessions();if(after.total!==0||after.sessions?.length!==0||(await handoff()).status!==404)throw Error('Session absence not verified');
  target.state='removed_verified';for(const entry of intents)entry.state='removed_verified';await persist(journal);return {success:true,state:'removed_verified'};
 }catch(error){for(const entry of starts)if(entry.state!=='not_created')entry.state='unknown';return {success:false,state:'unknown',error:String(error)};}
}
export async function cleanupStages(stages){
 const results=[];for(const [name,work] of stages){try{const result=await work();results.push({name,state:result?.success===true?(result.state??'removed_verified'):(result?.state??'failed'),result});}catch(error){results.push({name,state:'failed',error:String(error)});}}return {success:results.every(row=>['removed_verified','not_created'].includes(row.state)),results};
}