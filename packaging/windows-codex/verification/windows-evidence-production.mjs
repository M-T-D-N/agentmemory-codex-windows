import {verifyActiveTimeoutEvidence,preciseFiletime,activeTimeoutHistoryPlan,verifyClosedActiveAdmission} from './windows-active-timeout.mjs';
import assert from 'node:assert/strict';
import {readFile,lstat,realpath,mkdir,open} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,dirname,join,win32,isAbsolute} from 'node:path';
import {createWindowsHostAdapter,createSyntheticWindowsHostAdapter} from './windows-evidence-host.mjs';
import {randomUUID} from 'node:crypto';
import {fixedCopyFailure,verifyFixedCopyFailureOutcome} from './windows-fixed-copy-failure.mjs';
import {verifyPreparedResumeEvidence,preparedResumeClaimKey,verifyPreparedConfigureContinuation,assertConfigureContinuationOrdinal} from './windows-prepared-resume.mjs';
import {hash,verifyMemoryPreservation} from './distribution-qualification.mjs';
import {ensureWindowsEvidenceParents,assertWindowsLauncherPolicyInheritance,createWindowsExecutionPreparation,createSyntheticWindowsExecutionPreparation} from './windows-execution-preparation.mjs';

const phases={restart:['stop','start'],managed_update:['update'],failure_recovery:['inject','recover']};
const parse=b=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b));
const inside=(root,path)=>{const r=win32.relative(root,path);return r && r!=='..' && !r.startsWith('..\\') && !win32.isAbsolute(r);};
const fixedKeys=(x,keys)=>assert(x && Object.keys(x).every(k=>keys.includes(k)),'Unsupported producer argument');
async function realDigest(path){const s=await lstat(path);assert(s.isFile() && !s.isSymbolicLink(),'Unsafe candidate file');const h=createHash('sha256');for await(const b of createReadStream(path))h.update(b);return h.digest('hex');}
const realIO={read:readFile,digest:realDigest,now:()=>new Date().toISOString()};

export function verifyWindowsOwnershipObservation(value,{plan,target,operation,previous,allowTransition=false}) {
  assert(value && value.execution_id===plan.execution_id && value.install_root===target.root && value.owner_sid===target.owner_sid && value.operation===operation,'Ownership observation binding mismatch');
  assert(Number.isFinite(Date.parse(value.observed_at_utc)),'Missing ownership observation time');
  if(operation==='preflight'){assert.equal(value.status,'absent');return value;}
  assert.equal(value.install_nonce,target.install_nonce,'Ownership nonce mismatch');
  assert(['prepared','active','inactive','failed','retired'].includes(value.status),'Unknown ownership state');
  assert.equal(typeof value.watchdog_active,'boolean');
  assert(Array.isArray(value.tasks)&&value.tasks.length===2 && Array.isArray(value.processes),'Incomplete owned task/process observation');
  const suffix=createHash('sha256').update(target.owner_sid).digest('hex').slice(0,12)+(new URL(target.rest_origin).port==='3111'?'':'-'+new URL(target.rest_origin).port);
  const seen=new Set();
  for(const task of value.tasks){
    assert(['daemon','watchdog'].includes(task.kind)&&!seen.has(task.kind),'Unknown/duplicate owned task');seen.add(task.kind);
    const kind=task.kind==='daemon'?'Daemon':'Watchdog',r=task.registration,execute=win32.join(target.root,'bin/agentmemory-hidden-launcher.exe'),arg=task.kind==='daemon'?'task':'watch';
    assert(task.name===`AgentMemoryCodex-${kind}-${suffix}` && task.path==='\\' && /^[a-f0-9]{64}$/.test(task.identity_sha256),'Task identity/name mismatch');
    assert(r && r.task_name===task.name && r.task_path===task.path && r.owner_sid===target.owner_sid && r.install_nonce===target.install_nonce && win32.normalize(r.execute).toLowerCase()===win32.normalize(execute).toLowerCase() && r.arguments===arg && win32.normalize(r.working_directory).toLowerCase()===win32.normalize(target.root).toLowerCase(),'Task action/root/owner mismatch');
    assert(['Absent','Ready','Running','Disabled'].includes(task.state),'Unknown or queued task state');
    if(task.state==='Absent'){assert(value.status==='prepared'||(operation.startsWith('cleanup-')&&value.status==='retired'&&previous?.status==='prepared'&&previous.tasks.find(x=>x.kind===task.kind)?.state==='Absent'),'Activated task missing');assert.equal(task.actual_action,null,'Absent task has an action');}
    else {const a=task.actual_action;assert(a && a.owner_sid===r.owner_sid && a.arguments===r.arguments && win32.normalize(a.execute).toLowerCase()===win32.normalize(r.execute).toLowerCase() && win32.normalize(a.working_directory).toLowerCase()===win32.normalize(r.working_directory).toLowerCase(),'Observed task action differs');}
    if(previous){const old=previous.tasks.find(x=>x.kind===task.kind);assert(old && old.identity_sha256===task.identity_sha256,'Protected task registration changed');}
  }
  const roles=new Set();
  for(const proc of value.processes){
    assert(['daemon','engine','worker','watchdog'].includes(proc.role)&&!roles.has(proc.role),'Unknown/duplicate recorded process');roles.add(proc.role);
    assert(Number.isSafeInteger(proc.pid)&&proc.pid>0 && ['absent','present'].includes(proc.state) && Number.isFinite(Date.parse(proc.creation_date)) && Date.parse(proc.creation_date)<=Date.parse(value.observed_at_utc),'Unknown or malformed process identity');
    if(proc.state==='present')assert(Number.isSafeInteger(proc.parent_pid)&&proc.parent_pid>0 && /^[a-f0-9]{64}$/.test(proc.command_sha256) && (inside(target.root,proc.executable_path)||win32.normalize(proc.executable_path).toLowerCase()===win32.normalize(plan.node_path).toLowerCase()||win32.normalize(proc.executable_path).toLowerCase()===win32.normalize(plan.windows_e2e.powershell.path).toLowerCase()),'Process command/parent/executable mismatch');
    if(previous&&(!allowTransition||operation.startsWith('cleanup-'))){const old=previous.processes.find(x=>x.role===proc.role);assert(old&&old.pid===proc.pid&&old.creation_date===proc.creation_date,'PID/run identity changed without an owned action');if(proc.state==='present')assert(old.state==='present'&&old.parent_pid===proc.parent_pid&&old.command_sha256===proc.command_sha256&&old.executable_path===proc.executable_path,'Process command/parent binding changed');}
  }
  if(previous&&(!allowTransition||operation.startsWith('cleanup-')))assert(previous.processes.every(x=>roles.has(x.role)),'Recorded process identity disappeared from observation');
  if(value.status==='active')assert(['daemon','worker','engine'].every(role=>value.processes.some(x=>x.role===role&&x.state==='present')),'Active runtime process evidence missing or absent');
  if(operation.startsWith('cleanup-')){assert.equal(value.status,'retired');assert.deepEqual([...value.tasks_removed].sort(),value.tasks.map(t=>t.name).sort(),'Owned task removal proof missing');assert.equal(value.root_removed,operation==='cleanup-remove');assert.equal(value.auth_retained,!value.root_removed);}
  return value;
}

async function create(options,io,synthetic,makeHost,makePreparation,resumeSpec,continuationSpec,activeSpec,closedAdmissionSpec){
  fixedKeys(options,['plan','manifestBytes','outputDirectory','execute']);
  const execute=options.execute===true;
  const plan=structuredClone(options.plan),manifestBytes=Buffer.from(options.manifestBytes??[]),manifest=parse(manifestBytes);
  assert(plan.synthetic===synthetic && plan.evidence_kind===(synthetic?'synthetic_contract':'windows_execution') && plan.production_qualified===false,'Wrong producer boundary');
  assert(manifest.synthetic===true?synthetic:true,'Synthetic candidate cannot enter production');
  assert(/^[a-f0-9]{40}$/i.test(plan.source_commit) && /^[a-f0-9]{64}$/i.test(plan.source_input_digest),'Fixed source identity required');
  assert.equal(manifest.source_commit,plan.source_commit);assert.equal(manifest.source_input_digest,plan.source_input_digest);assert.equal(hash(manifestBytes),plan.manifest_sha256);
  assert(isAbsolute(options.outputDirectory),'Absolute task-owned output required');
  if(!synthetic){const physical=await realpath(plan.release_root);assert.equal(physical.toLowerCase(),win32.normalize(plan.release_root).toLowerCase(),'Candidate root redirects');}
  const root=resolve(options.outputDirectory),targets=plan.windows_e2e?.installations;assert(targets && Object.keys(targets).length,'Missing fixed targets');
  for(const t of Object.values(targets)){
    assert(inside(plan.isolation_root,t.root) && /^S-1-/.test(t.owner_sid),'Target root/owner required');
    assert(t.enroll_fresh===true?t.install_nonce===null:typeof t.install_nonce==='string'&&t.install_nonce.length>0,'Explicit enrollment or nonce required');
  }
  // Validate the actual fixed candidate before constructing any execution object.
  assert.equal(hash(await io.read(win32.join(plan.release_root,'release-manifest.json'))),plan.manifest_sha256,'Fixed candidate is absent or changed');
  for(const [list,base] of [[manifest.release_files,plan.release_root],[manifest.immutable_files,win32.join(plan.release_root,'payload')]]){
    assert(Array.isArray(list)&&list.length,'Missing candidate inventory');const seen=new Set();
    for(const f of list){assert(typeof f.path==='string'&&!win32.isAbsolute(f.path)&&!f.path.split(/[\\/]/).includes('..'),'Candidate inventory escape');const path=win32.join(base,f.path);assert(inside(base,path)&&!seen.has(path.toLowerCase()),'Candidate alias');seen.add(path.toLowerCase());if(!synthetic)assert(inside(plan.release_root,await realpath(path)),'Candidate file redirects outside release');assert.equal(await io.digest(path),f.sha256.toLowerCase(),'Candidate input hash mismatch');}
  }
  if(!synthetic){const launcherPath=win32.join(plan.release_root,'payload/src/AgentMemoryHiddenLauncher.cs');const entry=manifest.immutable_files.find(x=>x.path==='src/AgentMemoryHiddenLauncher.cs');assert(entry,'Candidate launcher source missing');const launcherBytes=await io.read(launcherPath);assert.equal(hash(launcherBytes),entry.sha256.toLowerCase(),'Candidate launcher changed');assertWindowsLauncherPolicyInheritance(launcherBytes);}
  const historyPlan=closedAdmissionSpec?await activeTimeoutHistoryPlan(activeSpec,{plan,synthetic,load:synthetic?io.read:undefined}):plan;
  let resumeProof=resumeSpec?await verifyPreparedResumeEvidence(resumeSpec,{plan:historyPlan,manifestBytes,synthetic,load:synthetic?io.read:undefined}):null;
  if(continuationSpec)resumeProof=await verifyPreparedConfigureContinuation(continuationSpec,{proof:resumeProof,plan:historyPlan,synthetic,load:synthetic?io.read:undefined});
  let activeProof=activeSpec?await verifyActiveTimeoutEvidence(activeSpec,{preparedProof:resumeProof,plan:historyPlan,synthetic,load:synthetic?io.read:undefined}):null;
  if(closedAdmissionSpec)activeProof=await verifyClosedActiveAdmission(closedAdmissionSpec,{proof:activeProof,plan,synthetic,load:synthetic?io.read:undefined});
  const host=makeHost({plan,manifestBytes,outputDirectory:join(root,'captures'),execute:execute});
  assert(synthetic||plan.windows_e2e.preparation_tool,'Production requires a pinned scoped preparation backend');
  const preparation=plan.windows_e2e.preparation_tool?makePreparation({plan,outputDirectory:join(root,'preparation'),execute}):null;
  const configured=new Set();
  let started=false,busy=false,fault=null,seq=0,continuationOrdinalRef=null,activeClaimRef=null;const entered=new Set(),records={},prepared=new Map(),nonces=new Map(Object.entries(targets).map(([k,v])=>[k,v.install_nonce])),observations=new Map(),removed=new Set();
  const flags={synthetic,evidence_kind:plan.evidence_kind,production_qualified:false};
  async function init(){if(started)return;assert(execute,'Producer execution is disabled');if(preparation)await ensureWindowsEvidenceParents(plan,root);for(let p=dirname(root);;p=dirname(p)){const s=await lstat(p);assert(s.isDirectory()&&!s.isSymbolicLink(),'Output parent redirects');if(dirname(p)===p)break;}await mkdir(root);assert.equal((await realpath(root)).toLowerCase(),root.toLowerCase());started=true;}
  async function save(value){await init();const path=join(root,'producer-'+(++seq)+'.json'),b=Buffer.from(JSON.stringify(value,null,2));const f=await open(path,'wx');try{await f.writeFile(b);await f.sync();}finally{await f.close();}return {path,sha256:hash(b)};}
  async function load(ref){const relative=win32.relative(root,ref.path);assert(relative&&!relative.startsWith('..')&&!win32.isAbsolute(relative),'Foreign capture');const b=await readFile(ref.path);assert.equal(hash(b),ref.sha256,'Capture changed');return parse(b);}
  const target=id=>{assert(targets[id]&&!removed.has(id),'Unknown or retired target');return {...targets[id],install_nonce:nonces.get(id)};};
  async function probe(id,operation='inspect',expected,allowTransition=false,requireStopped=false){const prior=expected?.value??observations.get(id)?.value;const receipt=await host.ownership({installationId:id,operation,...(expected?{expected:expected.ref.observation}:{} )});const value=await load(receipt.observation);verifyWindowsOwnershipObservation(value,{plan,target:target(id),operation,previous:prior?.status==='absent'?undefined:prior,allowTransition});if(requireStopped){assert(expected&&prior,'Stop must retain its pre-action ownership proof');assert(value.processes.every(p=>(requireStopped==='runtime'&&p.role==='watchdog')||p.state==='absent'),'Stopped PID remains present or absence is unconfirmed');assert(prior.processes.every(old=>value.processes.some(p=>p.role===old.role&&p.pid===old.pid&&p.creation_date===old.creation_date&&((requireStopped==='runtime'&&p.role==='watchdog')?p.state===old.state:p.state==='absent'))),'Pre-stop PID absence is unconfirmed');}observations.set(id,{ref:receipt,value});return value;}
  async function guard(action){assert(!busy,'Producer operation in flight');assert(!fault,'Producer is held after prior failure or unknown outcome');assert(execute,'Producer execution disabled');busy=true;try{if(activeProof){for(const ref of activeProof.original_refs)assert.equal(hash(await io.read(ref.archive_path??ref.path)),ref.sha256,'Original active-timeout evidence changed');if(activeClaimRef)assert.equal(hash(await io.read(activeClaimRef.path)),activeClaimRef.sha256,'Active admission claim changed');}await init();return await action();}catch(error){fault=error;try{error.producer_failure=await save({...flags,status:'held',original_error:String(error.message),original_receipt:error.receipt??null});}catch(storage){error.producer_storage_error=storage;}throw error;}finally{busy=false;}}
  async function memory(id,spec,kind,memoryId){const invoke=authorization=>host.memory({installationId:id,kind,authorization,...(kind==='created'?{body:spec.remember}:kind==='search'?{body:spec.search}:{id:memoryId})});const ref=preparation?await preparation.withCredential({installationId:id,installNonce:nonces.get(id)},invoke):await invoke(spec.authorization);const v=await load(ref);assert(v.status_code>=200&&v.status_code<300,'Actual memory API failed');const body=await load(v.response);return {ref,body};}
  function specCheck(spec){fixedKeys(spec,preparation?['scenario','installationId','remember','search']:['scenario','installationId','authorization','remember','search']);const t=target(spec.installationId);if(preparation)assert(configured.has(spec.installationId),'Scoped configuration is required before activation');else assert(typeof spec.authorization==='string'&&spec.authorization&&!/[\r\n]/.test(spec.authorization),'Explicit synthetic credential injection required');assert(spec.remember?.project===t.project&&spec.search?.project===t.project,'Wrong memory project');}
  async function state(id,runtime){const ref=await host.snapshot({installationId:id,runtime});const v=await load(ref),m=await load(v.manifest);assert.equal(m.install_nonce,nonces.get(id),'Snapshot nonce mismatch');assert.equal(m.owner_sid,target(id).owner_sid,'Snapshot owner mismatch');assert.equal(win32.normalize(m.install_root).toLowerCase(),win32.normalize(target(id).root).toLowerCase(),'Snapshot root mismatch');return {ref,value:v,installed:m};}
  const inputGuard=(value,action)=>{const snapshot=structuredClone(value);return guard(()=>action(snapshot));};
  const api={...flags,
    status:()=>({started,busy,held:!!fault,completed:Object.keys(records),entered:[...entered],removed:[...removed]}),
    admitExisting:({installationId:id})=>guard(async()=>{
      const t=target(id);assert(preparation&&t.enroll_fresh!==true&&!configured.has(id),'Unused existing target admission required');
      assert(/^[a-f0-9]{64}$/.test(t.predecessor_manifest_sha256)&&t.predecessor_manifest_sha256!==plan.manifest_sha256,'Pinned distinct predecessor required');
      const current=await probe(id);assert.equal(current.status,'active');assert.equal(current.model_origin,'http://127.0.0.1:1/v1');
      const admission=await preparation.inspectExisting({installationId:id,installNonce:nonces.get(id),installedManifestSha256:t.predecessor_manifest_sha256});
      assert(Date.parse(admission.observed_at_utc)>=Date.parse(current.observed_at_utc),'Existing configuration observation predates ownership');
      configured.add(id);await save({...flags,phase:'existing_target_admitted',installation_id:id,admission,ownership:observations.get(id).ref});return admission;
    }),
    ...(activeProof?{admitActiveAfterTimeout:()=>guard(async()=>{
      assert(!entered.size&&!observations.size,'Active handoff already entered');const id=activeProof.installation_id;entered.add('active_runtime_after_timeout');
      for(const ref of activeProof.original_refs)assert.equal(hash(await io.read(ref.archive_path??ref.path)),ref.sha256,'Original active history changed');
      const claim={schema_version:1,acceptance:'owned_active_runtime_after_timeout',execution_id:plan.execution_id,installation_id:id,install_nonce:activeProof.install_nonce,manifest_sha256:plan.manifest_sha256,original_claim:activeProof.claim_ref,configure_2:activeProof.ordinal_ref,original_timeout:activeProof.timeout_ref,original_activation_exit:'unknown',...(activeProof.admission_continuation?{continuation_kind:'argv-case-fix-once',previous_active_claim:activeProof.admission_continuation.active_claim,closed_inspect_failure:activeProof.admission_continuation.closed_failure,ownership_sha256:activeProof.admission_continuation.new_ownership_sha256}:{}),claimed_at_utc:io.now(),synthetic,production_qualified:false};
      const claimBytes=Buffer.from(JSON.stringify(claim,null,2)),file=await open(activeProof.claim_path,'wx');try{await file.writeFile(claimBytes);await file.sync();}finally{await file.close();}activeClaimRef={path:activeProof.claim_path,sha256:hash(claimBytes)};
      await host.adoptActiveAfterTimeout({proof:activeProof,claim});nonces.set(id,activeProof.install_nonce);
      const current=await probe(id);assert.equal(current.status,'active');assert.equal(current.model_origin,'http://127.0.0.1:1/v1');assert(Date.parse(current.observed_at_utc)>=Date.parse(claim.claimed_at_utc)&&Date.parse(current.observed_at_utc)>=Date.parse(activeProof.admitted_after_utc),'Stale active observation');
      for(const old of activeProof.process_anchor){const p=current.processes.find(x=>x.role===old.role);assert(p&&p.state==='present'&&p.pid===old.pid&&p.parent_pid===old.parent_pid&&preciseFiletime(p.creation_date)===preciseFiletime(old.creation_date)&&p.command_sha256===old.command_sha256&&win32.normalize(p.executable_path).toLowerCase()===win32.normalize(old.executable_path).toLowerCase(),'Active runtime changed since pinned anchor; HOLD');}
      const admission=await preparation.inspectActiveAfterTimeout({proof:activeProof});assert(Date.parse(admission.observed_at_utc)>=Date.parse(current.observed_at_utc),'Configuration observation predates ownership');configured.add(id);
      await save({...flags,phase:'active_runtime_admitted',claim,admission,ownership:observations.get(id).ref,original_activation_exit:'unknown'});return {...flags,acceptance:'owned_active_runtime_after_timeout',original_activation_exit:'unknown',installation_id:id};
    }),runRuntimeRestart:input=>api.runScenario({...structuredClone(input),scenario:'restart'}).then(record=>({...flags,acceptance:'owned_runtime_restart_after_timeout',original_activation_exit:'unknown',record}))}:{}),
    ...(resumeProof&&!activeProof?{resumePrepared:()=>guard(async()=>{
      assert(!entered.size&&!prepared.size,'Resume already entered');const id=resumeProof.installation_id;entered.add('fresh_install');
      const claimRoot=join(plan.isolation_root,'evidence','resume-claims');
      try{await mkdir(claimRoot);}catch(error){if(error.code!=='EEXIST')throw error;}
      const cs=await lstat(claimRoot);assert(cs.isDirectory()&&!cs.isSymbolicLink()&&(await realpath(claimRoot)).toLowerCase()===resolve(claimRoot).toLowerCase(),'Resume claim directory redirects');
      let claim,ordinalRef;
      if(resumeProof.continuation){
        const c=resumeProof.continuation;claim=c.claim;
        // Recheck closed sources before the one create-new ordinal; never alter the lifecycle claim.
        for(const ref of resumeProof.original_refs)assert.equal(hash(await io.read(ref.archive_path??ref.path)),ref.sha256,'Closed continuation evidence changed');
        const ordinal={schema_version:1,ordinal:2,execution_id:plan.execution_id,installation_id:id,install_nonce:resumeProof.install_nonce,candidate_manifest_sha256:plan.manifest_sha256,claim_sha256:c.claim_ref.sha256,closed_evidence_sha256:hash(Buffer.from(JSON.stringify(c.spec))),claimed_at_utc:io.now(),synthetic,production_qualified:false};assertConfigureContinuationOrdinal(ordinal,resumeProof);
        const bytes=Buffer.from(JSON.stringify(ordinal,null,2)),file=await open(c.ordinal_path,'wx');try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}ordinalRef={path:c.ordinal_path,sha256:hash(bytes)};continuationOrdinalRef=ordinalRef;
      }else{
        claim={schema_version:1,resume_id:randomUUID(),execution_id:plan.execution_id,installation_id:id,install_nonce:resumeProof.install_nonce,candidate_manifest_sha256:plan.manifest_sha256,original_evidence_sha256:hash(Buffer.from(JSON.stringify(resumeProof.spec))),claimed_at_utc:io.now(),synthetic,production_qualified:false};
        assert(Date.parse(claim.claimed_at_utc)>=Date.parse(resumeProof.closed_at_utc),'Resume predates the closed original execution');
        const claimPath=join(claimRoot,preparedResumeClaimKey(resumeProof)+'.json');claim.claim_path=claimPath;const f=await open(claimPath,'wx');try{await f.writeFile(JSON.stringify(claim,null,2));await f.sync();}finally{await f.close();}
      }
      const claimRef=await host.adoptPrepared({proof:resumeProof,claim,ordinal:ordinalRef});nonces.set(id,resumeProof.install_nonce);
      verifyWindowsOwnershipObservation(resumeProof.observation,{plan,target:target(id),operation:'inspect'});
      observations.set(id,{value:resumeProof.observation,ref:{observation:resumeProof.observation_ref}});
      const current=await probe(id,'inspect',observations.get(id));assert(current.status==='prepared'&&!current.watchdog_active&&current.processes.length===0&&current.tasks.every(x=>x.state==='Absent'&&x.actual_action===null),'Current slot is no longer empty prepared state');
      assert(Date.parse(current.observed_at_utc)>=Date.parse(resumeProof.continuation?parse(await io.read(ordinalRef.path)).claimed_at_utc:claim.claimed_at_utc),'Resume reused a stale current observation');
      const admission=await preparation.inspectPrepared({installationId:id,installNonce:resumeProof.install_nonce,closedWriter:resumeProof.closed_writer,preparedManifestSha256:resumeProof.prepared_manifest_sha256,...(resumeProof.continuation?{retainedTemp:resumeProof.continuation.retained_temp}:{})});
      assert(Date.parse(admission.observed_at_utc)>=Date.parse(current.observed_at_utc),'Preparation admission predates ownership recheck');
      prepared.set(id,structuredClone(resumeProof.record));await save({...flags,phase:'resumed_prepared',installation_id:id,claim:claimRef,original:resumeProof.spec,admission});
      return {...flags,installation_id:id,install_nonce:resumeProof.install_nonce,resume_id:claim.resume_id,status:'prepared_resume_requires_explicit_configuration'};
    })}:{}),
    prepareFresh:({installationId:id})=>guard(async()=>{
      assert(!resumeProof,'A resumed producer cannot repeat prepare');
      const t=target(id);assert(t.enroll_fresh===true&&t.install_nonce===null&&!entered.has('fresh_install'),'Fresh preparation already entered or not approved');entered.add('fresh_install');
      const record={installation_id:id,start_utc:io.now(),steps:[],memory:{}};const before=await probe(id,'preflight');assert.equal(before.status,'absent','Fresh root must be absent');
      if(preparation)await preparation.prepareSupport({installationId:id});
      const process=await host.action({scenario:'fresh_install',phase:'prepare',installationId:id});
      const enrollment=await host.enrollPrepared({installationId:id}),identity=await load(enrollment);nonces.set(id,identity.install_nonce);
      const after=await state(id,false);assert.equal(after.installed.installation_status,'prepared');assert.equal(after.installed.release_manifest_sha256.toLowerCase(),plan.manifest_sha256);
      record.steps.push({phase:'prepare',process,after:after.ref});prepared.set(id,record);await probe(id,'inspect',undefined,true);await save({...flags,phase:'prepared',installation_id:id,enrollment});
      return {...flags,installation_id:id,install_nonce:identity.install_nonce,status:'prepared_requires_explicit_activation'};
    }),
    configurePrepared:({installationId:id})=>guard(async()=>{assert(preparation&&prepared.has(id)&&!configured.has(id),'Exact prepared slot and unused configuration required');if(resumeProof?.continuation){for(const ref of resumeProof.original_refs)assert.equal(hash(await io.read(ref.archive_path??ref.path)),ref.sha256,'Closed continuation evidence changed');const ordinalBytes=await io.read(resumeProof.continuation.ordinal_path);assert.equal(hash(ordinalBytes),continuationOrdinalRef.sha256,'Continuation ordinal changed');assertConfigureContinuationOrdinal(parse(ordinalBytes),resumeProof);}const result=await preparation.configure({installationId:id,installNonce:nonces.get(id)});configured.add(id);await save({...flags,phase:'isolated_configuration',installation_id:id,...result});return result;}),
    runScenario:input=>inputGuard(input,async spec=>{
      specCheck(spec);const {scenario:name,installationId:id}=spec;assert(name==='fresh_install'||Object.hasOwn(phases,name),'Unsupported production scenario');assert(!records[name],'Scenario already completed');
      if(name!=='fresh_install'){assert(!entered.has(name),'Scenario already entered');entered.add(name);}
      const t=target(id);let record=name==='fresh_install'?prepared.get(id):{installation_id:id,start_utc:io.now(),steps:[],memory:{}};assert(record,'Missing owned fresh preparation');
      if(name==='failure_recovery'){
        assert.deepEqual(plan.windows_e2e.failure_fixture,fixedCopyFailure,'No reviewed fixed qualification fixture; default installer is not a failure injector');
      }
      const admission=await probe(id);assert.equal(admission.model_origin,'http://127.0.0.1:1/v1','Explicit closed model endpoint required; producer never writes config');
      let memoryId;
      if(name!=='fresh_install'){const created=await memory(id,spec,'created');record.memory.created=created.ref;memoryId=(created.body.result?.memory??created.body.memory)?.id;assert(typeof memoryId==='string'&&memoryId,'Missing actual created ID');}
      for(const phase of name==='fresh_install'?['activate','start']:phases[name]){
        const freshStart=name==='fresh_install'&&phase==='start',activationOnly=name==='fresh_install'&&phase==='activate';
        let before,launcherBefore;
        if(['start','update','recover'].includes(phase)){before=await state(id,phase==='start'&&!freshStart);if(freshStart){assert.equal(before.installed.installation_status,'activated');assert.equal(before.installed.release_manifest_sha256.toLowerCase(),plan.manifest_sha256);}if(phase==='update'){assert.equal(before.installed.release_manifest_sha256.toLowerCase(),t.predecessor_manifest_sha256,'Wrong actual predecessor');assert.notEqual(t.predecessor_manifest_sha256,plan.manifest_sha256);}if(['update','recover'].includes(phase))launcherBefore=await host.captureLauncher({installationId:id});}
        // Public activation registers tasks only. The pinned MCP entry point validates
        // ownership and starts them before a runtime/PID ownership proof can exist.
        if(!freshStart)await probe(id);const beforeAction=observations.get(id);const process=await host.action({scenario:name,phase,installationId:id});if(phase==='stop')await probe(id,'inspect',beforeAction,false,'runtime');let preservation;
        if(launcherBefore){const after=await host.captureLauncher({installationId:id});preservation=await host.launcherPreservation({installationId:id,actionProcess:process,before:launcherBefore,after});}
        const afterRef=await host.snapshot({installationId:id,runtime:phase!=='inject'&&!activationOnly,...(preservation?{launcherPreservation:preservation}:{})});const after=await load(afterRef),installed=await load(after.manifest);
        assert.equal(installed.install_nonce,nonces.get(id));
        if(phase!=='inject'){assert.equal(installed.release_manifest_sha256.toLowerCase(),plan.manifest_sha256,'Actual candidate not installed');if(after.runtime){const runtime=await load(after.runtime);assert.equal(runtime.status,phase==='stop'?'inactive':'active','Unexpected observed runtime');}}
        record.steps.push({phase,process,after:afterRef,...(before?{before:before.ref}:{})});
        if(phase==='inject'){
          const details=installed.cutover_failure;assert(details&&['automatic_rollback','rollback_failed','rollback_withheld'].includes(details.outcome)&&details.original_error,'Missing actual structured cutover failure');
          verifyFixedCopyFailureOutcome(details);
          assert(details.outcome==='automatic_rollback'||details.runtime_stopped===true,'Runtime stop is unconfirmed; recovery withheld');
          if(details.outcome==='rollback_failed')assert(details.restore_error,'Missing actual restoration error');
          let restoredState;
          if(details.outcome==='automatic_rollback'){
            assert(details.restoration_completed===true&&details.runtime_ready===true&&installed.release_manifest_sha256.toLowerCase()===t.predecessor_manifest_sha256,'Automatic rollback lacks restored predecessor/readiness');
            restoredState=(await state(id,true)).ref;
          }
          const fields=['original_error','original_error_id','original_error_hresult','restore_error','phase','outcome','restoration_completed','runtime_ready','runtime_stopped'];
          record.failure=await host.failure({installationId:id,failedAction:process,details:Object.fromEntries(fields.filter(k=>Object.hasOwn(details,k)).map(k=>[k,details[k]])),...(restoredState?{restoredState}:{})});
        }
        if(phase!=='stop'&&!activationOnly)await probe(id,'inspect',undefined,true);
      }
      if(preparation&&t.enroll_fresh!==true)await preparation.inspectExisting({installationId:id,installNonce:nonces.get(id),installedManifestSha256:plan.manifest_sha256});
      if(name==='fresh_install'){const created=await memory(id,spec,'created');record.memory.created=created.ref;memoryId=(created.body.result?.memory??created.body.memory)?.id;assert(typeof memoryId==='string'&&memoryId);}
      const search=await memory(id,spec,'search'),detail=await memory(id,spec,'detail',memoryId);record.memory.search=search.ref;record.memory.detail=detail.ref;
      const created=await load((await load(record.memory.created)).response);verifyMemoryPreservation(created,search.body,detail.body);
      record.end_utc=io.now();record.success=true;records[name]=record;await save({...flags,status:'scenario_captured',scenario:name,record});return structuredClone(record);
    }),
    verifyPartial:()=>guard(async()=>{assert(Object.keys(records).length&&Object.keys(records).every(n=>['fresh_install','restart'].includes(n)),'Partial path supports fresh/restart only');return host.assemble(records,true);}),
    assemble:()=>guard(async()=>{assert(['fresh_install','restart','managed_update','failure_recovery'].every(x=>records[x]),'Actual scenarios incomplete');return host.assemble(records);}),
    cleanup:({installationId:id,removeRoot=false})=>guard(async()=>{
      assert(typeof removeRoot==='boolean','Explicit cleanup mode required');assert(!removeRoot||target(id).allow_root_removal===true,'Root removal was not explicitly scoped');target(id);assert(observations.has(id),'No admitted ownership observation');
      let current=await probe(id);const previous=observations.get(id);
      if(current.watchdog_active){await probe(id,'stop-watchdog',previous,true);current=await probe(id);}
      if(current.status==='active'){const beforeStop=observations.get(id);await host.action({scenario:'restart',phase:'stop',installationId:id});current=await probe(id,'inspect',beforeStop,false,true);}
      assert(current.processes.every(p=>p.state==='absent')&&current.tasks.every(t=>['Ready','Disabled','Absent'].includes(t.state)),'Cleanup processes/tasks still active or unknown');
      assert(!removeRoot||target(id).allow_root_removal===true,'Root removal was not explicitly scoped');
      const receipt=await probe(id,removeRoot?'cleanup-remove':'cleanup-retain',observations.get(id),true);removed.add(id);await save({...flags,status:'cleanup_complete',installation_id:id,remove_root:removeRoot,receipt});return receipt;
    })
  };
  return Object.freeze(activeProof?Object.fromEntries(['status','admitActiveAfterTimeout','runRuntimeRestart','cleanup'].map(k=>[k,api[k]])):api);
}

// Real execution can only be reached through this separate factory and explicit execute.
export function createWindowsPreparedResumeProducer(options,resume){assert(resume,'Closed prepare proof required');return create(options,realIO,false,o=>createWindowsHostAdapter(o),o=>createWindowsExecutionPreparation(o),resume);}
export function createSyntheticWindowsPreparedResumeHarness(options,resume,effects){assert(effects&&['read','run','request','now','digest'].every(k=>typeof effects[k]==='function'),'All fake effects required');return create(options,effects,true,o=>createSyntheticWindowsHostAdapter(o,effects),o=>createSyntheticWindowsExecutionPreparation(o,effects.preparation),resume);}
export function createWindowsScenarioProducer(options){return create(options,realIO,false,o=>createWindowsHostAdapter(o),o=>createWindowsExecutionPreparation(o));}
// The same sequencing/cleanup code is exercised with required fake effects; never production acceptance.
export function createSyntheticWindowsProducerHarness(options,effects){assert(effects&&['read','run','request','now','digest'].every(k=>typeof effects[k]==='function'),'All fake effects required');return create(options,effects,true,o=>createSyntheticWindowsHostAdapter(o,effects),o=>createSyntheticWindowsExecutionPreparation(o,effects.preparation));}

export function createWindowsPreparedConfigureContinuationProducer(options,original,continuation){assert(original&&continuation,'Original and closed configure proof required');return create(options,realIO,false,o=>createWindowsHostAdapter(o),o=>createWindowsExecutionPreparation(o),original,continuation);}
export function createSyntheticWindowsPreparedConfigureContinuationHarness(options,original,continuation,effects){assert(effects&&['read','run','request','now','digest'].every(k=>typeof effects[k]==='function'),'All fake effects required');return create(options,effects,true,o=>createSyntheticWindowsHostAdapter(o,effects),o=>createSyntheticWindowsExecutionPreparation(o,effects.preparation),original,continuation);}

export function createWindowsActiveTimeoutProducer(options,original,continuation,active){assert(original&&continuation&&active,'Complete original timeout history required');return create(options,realIO,false,o=>createWindowsHostAdapter(o),o=>createWindowsExecutionPreparation(o),original,continuation,active);}
export function createSyntheticWindowsActiveTimeoutHarness(options,original,continuation,active,effects){assert(effects&&['read','run','request','now','digest'].every(k=>typeof effects[k]==='function'));return create(options,effects,true,o=>createSyntheticWindowsHostAdapter(o,effects),o=>createSyntheticWindowsExecutionPreparation(o,effects.preparation),original,continuation,active);}

export function createWindowsActiveAdmissionContinuationProducer(options,original,continuation,active,closed){assert(original&&continuation&&active&&closed,'Closed read-only admission history required');return create(options,realIO,false,o=>createWindowsHostAdapter(o),o=>createWindowsExecutionPreparation(o),original,continuation,active,closed);}
export function createSyntheticWindowsActiveAdmissionContinuationHarness(options,original,continuation,active,closed,effects){assert(effects&&['read','run','request','now','digest'].every(k=>typeof effects[k]==='function'));return create(options,effects,true,o=>createSyntheticWindowsHostAdapter(o,effects),o=>createSyntheticWindowsExecutionPreparation(o,effects.preparation),original,continuation,active,closed);}
