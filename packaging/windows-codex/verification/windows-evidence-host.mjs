import {assertActiveTimeoutProof} from './windows-active-timeout.mjs';
import {runOwnedProcess} from './windows-owned-process.mjs';
import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFile, open, mkdir, lstat, realpath } from 'node:fs/promises';
import { resolve, dirname, join, isAbsolute, win32 } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
export const windowsOwnershipToolPath=fileURLToPath(new URL('./windows-evidence-cleanup.ps1',import.meta.url));
import { hash, verifySyntheticWindowsScenarioEvidence, verifyWindowsScenarioEvidence, verifyPartialWindowsScenarioEvidence, verifySyntheticPartialWindowsScenarioEvidence } from './distribution-qualification.mjs';
import {assertPreparedResumeProof} from './windows-prepared-resume.mjs';
import { powershellEnvironment } from '../npm/cli.mjs';
import {createPreStartCopyFailureInstaller,fixedCopyFailure} from './windows-fixed-copy-failure.mjs';

const phases={fresh_install:['prepare','activate','start'],restart:['stop','start'],managed_update:['update'],failure_recovery:['inject','recover']};
export function windowsHostActionBudget({scenario,phase}) {
  assert(phases[scenario]?.includes(phase),'Unsupported action budget');
  if(phase==='start')return 180000;
  if(scenario==='restart')return 60000;
  // The installer allows 780s readiness after owned stop, cold backup and copy.
  // A collector timeout remains UNKNOWN/HOLD; it never authorizes a retry.
  if(scenario==='fresh_install')return phase==='prepare'?300000:900000;
  return 1800000;
}
export function windowsHostOwnershipBudget(operation) {
  const values={preflight:45000,inspect:45000,'stop-watchdog':60000,'cleanup-retain':60000,'cleanup-remove':120000};
  assert(Object.hasOwn(values,operation),'Unsupported ownership budget');return values[operation];
}
const digest=/^[a-f0-9]{64}$/;
const pathKey=value=>{
  assert(typeof value==='string' && /^[A-Za-z]:[\\/]/.test(value) && !value.split(/[\\/]/).includes('..') && !/[\0"*?]/.test(value),'Expected explicit local Windows path');
  return win32.normalize(value).toLowerCase();
};
const under=(root,path)=>{const rel=win32.relative(pathKey(root),pathKey(path));return rel && rel!=='..' && !rel.startsWith('..\\') && !win32.isAbsolute(rel);};
const json=bytes=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
const flags=synthetic=>({evidence_kind:synthetic?'synthetic_contract':'windows_execution',synthetic,production_qualified:false});
async function exclusive(path,bytes) {
  const file=await open(path,'wx');
  try {await file.writeFile(bytes);await file.sync();} finally {await file.close();}
}
async function readBounded(path) {
  const stat=await lstat(path);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size<=32*1024*1024,'Unsafe or oversized capture file');
  return readFile(path);
}
async function privateOutput(path) {
  assert(isAbsolute(path) && !path.split(/[\\/]/).includes('..') && !path.startsWith('\\\\'),'Invalid capture output');
  for(let p=dirname(resolve(path));;p=dirname(p)) {
    const stat=await lstat(p);assert(stat.isDirectory() && !stat.isSymbolicLink(),'Capture output parent redirects');
    if(dirname(p)===p)break;
  }
  await mkdir(path);
  assert.equal((await realpath(path)).toLowerCase(),resolve(path).toLowerCase(),'Capture output redirects');
}
export function windowsEvidenceEnvironment(root,base=process.env) {
  const env=powershellEnvironment(base);
  for(const key of Object.keys(env))if(key==='NODE_OPTIONS' || key==='NODE_PATH' || key.startsWith('AGENTMEMORY_') || /(?:_TOKEN|_KEY|_SECRET|PASSWORD|AUTHORIZATION)$/.test(key))delete env[key];
  for(const key of ['HOME','USERPROFILE','CODEX_HOME','APPDATA','LOCALAPPDATA','TEMP','TMP','TMPDIR'])env[key]=root;
  env.AGENTMEMORY_INTEGRATION='0';env.AGENTMEMORY_CURATE='0';env.AGENTMEMORY_URL='http://127.0.0.1:1';
  return env;
}
async function runOwned(options){return runOwnedProcess({...options,environment:windowsEvidenceEnvironment(options.outputDirectory)});}
const realEffects=()=>({
  read:readBounded,run:runOwned,now:()=>new Date().toISOString(),
  digest:async path=>{const stat=await lstat(path);assert(stat.isFile() && !stat.isSymbolicLink() && stat.size<=256*1024*1024,'Unsafe pinned tool');const h=createHash('sha256');for await(const chunk of createReadStream(path))h.update(chunk);return h.digest('hex');},
  request:async({url,method,body,authorization})=>{
    const response=await fetch(url,{method,redirect:'error',signal:AbortSignal.timeout(15000),
      headers:{Authorization:'Bearer '+authorization,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const chunks=[];let total=0;
    if(response.body){const reader=response.body.getReader();try{for(;;){const next=await reader.read();if(next.done)break;total+=next.value.length;if(total>16*1024*1024){await reader.cancel();throw new Error('API response too large');}chunks.push(Buffer.from(next.value));}}finally{reader.releaseLock();}}
    const bytes=Buffer.concat(chunks);
    if(authorization)assert(!bytes.includes(Buffer.from(authorization)),'API response contains a credential; no response stored');
    return {status_code:response.status,bytes};
  }
});
function create(options,effects,synthetic) {
  const {manifestBytes,outputDirectory,execute=false}=options;
  const plan=structuredClone(options.plan);
  const freeze=value=>{if(value && typeof value==='object'){for(const x of Object.values(value))freeze(x);Object.freeze(value);}return value;};
  freeze(plan);
  assert(Object.keys(options).every(k=>['execute','manifestBytes','outputDirectory','plan'].includes(k)),'Unknown host-adapter option');
  assert(Buffer.isBuffer(manifestBytes),'Original manifest bytes required');
  const manifest=json(manifestBytes),settings=plan.windows_e2e;
  assert(/^[a-f0-9-]{36}$/i.test(plan.execution_id) && settings?.installations && settings.powershell && digest.test(settings.powershell.sha256) && digest.test(plan.node_sha256),'Incomplete host plan');
  assert.equal(plan.production_qualified,false,'Host collection alone is never distribution qualification');
  for(const key of ['source_commit','source_input_digest'])assert.equal(manifest[key],plan[key],'Host candidate binding mismatch');
  assert.equal(hash(manifestBytes),plan.manifest_sha256,'Host manifest mismatch');
  assert.equal(plan.synthetic,synthetic,'Wrong plan kind');assert.equal(plan.evidence_kind,flags(synthetic).evidence_kind,'Wrong plan kind');
  if(!synthetic)assert(manifest.synthetic!==true && manifest.evidence_kind!=='synthetic_contract','Synthetic manifest cannot authorize host capture');
  pathKey(plan.release_root);pathKey(plan.isolation_root);pathKey(plan.node_path);
  assert.equal(win32.basename(plan.node_path).toLowerCase(),'node.exe','Expected installed Node executable');
  assert.equal(win32.basename(settings.powershell.path).toLowerCase(),'powershell.exe','Current host profile requires Windows PowerShell');
  assert(pathKey(plan.isolation_root)!==win32.parse(pathKey(plan.isolation_root)).root,'Isolation root cannot be an entire drive');
  assert(isAbsolute(outputDirectory),'Absolute capture output required');
  const enrolled=new Map();
  const bytesByPath=new Map(),runs=new Map(),launcherCaptures=new WeakMap(),preservationRefs=new Map(),ownershipRefs=new Map();let initialized,sequence=0,faulted=false,operationInFlight=false;
  const requireExecute=()=>{assert(execute===true,'Explicit action execution is disabled');assert(!faulted,'A prior host capture is incomplete; no further action may start');};
  const init=()=>initialized??=(async()=>privateOutput(outputDirectory))();
  const raw=async(bytes,originalPath)=>{
    try {
      assert(Buffer.isBuffer(bytes),'Capture did not supply original bytes');await init();
      const path=join(outputDirectory,'raw-'+(++sequence)+'.bin');await exclusive(path,bytes);
      const ref={path:originalPath??path,sha256:hash(bytes),...(originalPath?{archive_path:path}:{})};
      bytesByPath.set(path,ref.sha256);return ref;
    }catch(error){faulted=true;throw error;}
  };
  const object=async value=>raw(Buffer.from(JSON.stringify(value,null,2)));
  const failedCapture=async(message,original,details)=>{
    faulted=true;const failure=new Error(message,{cause:original});
    try{failure.receipt=await object(details);}catch(storageError){failure.evidence_storage_error=storageError;}
    return failure;
  };
  const target=id=>{
    const original=settings.installations[id],t=original && {...original,install_nonce:enrolled.get(id)??original.install_nonce};assert(t && ((typeof t.install_nonce==='string' && t.install_nonce) || (t.enroll_fresh===true && t.install_nonce===null && /^S-1-/.test(t.owner_sid))) && typeof t.project==='string' && t.project && t.project!=='*','Unknown installation');
    assert(under(plan.isolation_root,t.root),'Installation outside explicit isolation root');
    const origin=new URL(t.rest_origin);assert(Number.isInteger(Number(origin.port)) && Number(origin.port)>0 && Number(origin.port)<=19512,'Explicit supported REST port required');assert(origin.protocol==='http:' && ['127.0.0.1','[::1]'].includes(origin.hostname) && t.rest_origin===origin.origin,'Non-loopback capture origin');
    return t;
  };
  const bind=id=>({execution_id:plan.execution_id,installation_id:id,install_root:target(id).root});
  const pinned=async(path,sha)=>{
    const bytes=await effects.read(path);assert(Buffer.isBuffer(bytes) && hash(bytes)===sha.toLowerCase(),'Pinned host input bytes changed');
    return raw(bytes,path);
  };
  let resumed=null;
  const api={
    async adoptPrepared({proof,claim,ordinal}) {
      requireExecute();assert(!resumed && runs.size===0 && enrolled.size===0,'Recorder already entered');assertPreparedResumeProof(proof,plan,synthetic);
      for(const ref of proof.original_refs){const path=ref.archive_path??ref.path;assert.equal(hash(await effects.read(path)),ref.sha256,'Closed prepare evidence changed during import');bytesByPath.set(path,ref.sha256);}
      enrolled.set(proof.installation_id,proof.install_nonce);ownershipRefs.set(proof.observation_ref.path,{installationId:proof.installation_id,sha256:proof.observation_ref.sha256});
      const ref=await object(claim);resumed={spec:proof.spec,plan:proof.plan,claim:ref,...(proof.continuation?{continuation:proof.continuation.spec,ordinal:{...ordinal,archive_path:(await raw(await effects.read(ordinal.path))).path}}:{})};return ref;
    },
    async adoptActiveAfterTimeout({proof,claim}) {
      requireExecute();assert(!resumed&&runs.size===0&&enrolled.size===0,'Recorder already entered');assertActiveTimeoutProof(proof,plan,synthetic);
      for(const ref of proof.original_refs){const path=ref.archive_path??ref.path;assert.equal(hash(await effects.read(path)),ref.sha256,'Original active-timeout evidence changed');bytesByPath.set(path,ref.sha256);}
      enrolled.set(proof.installation_id,proof.install_nonce);
      const ref=await object({...flags(synthetic),phase:'active_after_timeout',claim,original_timeout:proof.timeout_ref,original_activation_exit:'unknown'});return ref;
    },
    raw_root:outputDirectory,...flags(synthetic),
    async action({scenario,phase,installationId}) {
      requireExecute();let dispatched=false;try{assert(phases[scenario]?.includes(phase),'Unsupported phase');
      const t=target(installationId),installer=!['stop','start'].includes(phase);
      assert(t.install_nonce || (scenario==='fresh_install' && phase==='prepare'),'Fresh nonce must be enrolled before any later action');
      const relative=installer?'Install-WindowsCodex.ps1':'scripts/agentmemory-'+(phase==='stop'?'stop':'mcp')+'.ps1';
      let script=win32.join(installer?plan.release_root:t.root,relative);
      const entry=(installer?manifest.release_files:manifest.immutable_files).find(x=>x.path===relative);assert(entry,'Missing candidate script');
      const executable=await pinned(settings.powershell.path,settings.powershell.sha256);let scriptRef=await pinned(script,entry.sha256),qualificationFixture;
      if(phase==='inject'){
        assert.deepEqual(settings.failure_fixture,fixedCopyFailure,'Fixed copy-failure execution must be explicitly scoped');
        const bytes=await effects.read(script);assert.equal(hash(bytes),entry.sha256.toLowerCase(),'Candidate installer changed before fixture derivation');
        const derived=createPreStartCopyFailureInstaller(bytes);await init();
        script=join(outputDirectory,'pre-start-copy-failure.ps1');await exclusive(script,derived);
        qualificationFixture={...fixedCopyFailure,base_installer:scriptRef};scriptRef=await raw(derived,script);
      }
      const helper=manifest.immutable_files.find(x=>x.path==='scripts/agentmemory-evidence.ps1');assert(helper,'Missing evidence bootstrap in candidate');
      await pinned(win32.join(installer?win32.join(plan.release_root,'payload'):t.root,'scripts/agentmemory-evidence.ps1'),helper.sha256);
      await init();const identityPath=join(outputDirectory,'identity-'+randomUUID()+'.json');
      const args=installer?['-ReleaseRoot',plan.release_root,'-InstallRoot',t.root]:['-Root',t.root];
      if(installer) {
        assert.equal(await effects.digest(plan.node_path),plan.node_sha256,'Pinned Node bytes changed');
        for(const path of [t.workspace_root,t.project_registry,t.requirements_path])assert(under(plan.isolation_root,path),'Installer parameter outside isolation root');
        args.push('-WorkspaceRoot',t.workspace_root,'-ProjectRegistry',t.project_registry,'-NodePath',plan.node_path,'-ManagedRequirementsPath',t.requirements_path,'-RestPort',String(new URL(t.rest_origin).port),'-Execute');
        if(phase==='prepare')args.push('-Fresh');if(phase==='activate')args.push('-ActivatePrepared');
      }else if(phase==='start')args.push('-ValidateOnly');
      args.push('-EvidenceUtf8','-EvidenceIdentityPath',identityPath);
      const command=[settings.powershell.path,'-NoProfile','-NonInteractive','-File',script,...args];
      let value;
      try {dispatched=true;value=await effects.run({command,cwd:plan.release_root,identityPath,outputDirectory,timeoutMs:windowsHostActionBudget({scenario,phase}),scenario,phase});}
      catch(error) {
        throw await failedCapture('Host action transport failed; process outcome is unknown',error,
          {...bind(installationId),scenario,phase,...flags(synthetic),command,
          exit_code:null,pending:null,error_code:'RUN_TRANSPORT_ERROR',original_error:String(error?.message??error)});
      }
      const stdout={...await raw(value.stdout),encoding:'utf-8'},stderr=await raw(value.stderr);
      let identity;
      try {
        identity=json(value.identityBytes);assert.equal(identity.pid,value.pid,'Owned child identity mismatch');
        assert(Number.isSafeInteger(value.pid) && value.pid>0 && Number.isSafeInteger(value.parent_pid) && value.parent_pid>0,'Missing owned process identity');
        assert.equal(pathKey(identity.executable),pathKey(settings.powershell.path),'Owned child executable mismatch');
        assert(Number.isSafeInteger(value.exit_code) && !value.pending,'Child exit is unrecorded or pending');
        assert(Date.parse(value.launched_at_utc)<=Date.parse(identity.created_at_utc) && Date.parse(identity.created_at_utc)<=Date.parse(identity.started_at_utc) && Date.parse(identity.started_at_utc)<=Date.parse(value.end_utc),'Invalid child identity times');
      }catch(error) {
        throw await failedCapture('Host action receipt is incomplete',error,
          {...bind(installationId),scenario,phase,...flags(synthetic),pid:value.pid??null,
          parent_pid:value.parent_pid??null,command,exit_code:value.exit_code??null,stdout,stderr,
          pending:value.pending??false,error_code:value.error_code??value.identityError??error.message,...(value.terminal_evidence?{terminal_evidence:value.terminal_evidence}:{})});
      }
      const valueRef=await object({...bind(installationId),scenario,phase,...flags(synthetic),pid:value.pid,parent_pid:value.parent_pid,
        created_at_utc:identity.created_at_utc,creation_filetime:identity.creation_filetime,start_utc:identity.started_at_utc,end_utc:value.end_utc,
        command,executable,script:scriptRef,exit_code:value.exit_code,stdout,stderr,...(qualificationFixture?{qualification_fixture:qualificationFixture}:{})});
      runs.set(valueRef.path,{stdout,stderr,exit_code:value.exit_code,installationId,phase,sha256:valueRef.sha256});
      if(value.exit_code!==0 && phase!=='inject'){faulted=true;const failure=new Error('Windows action failed');failure.receipt=valueRef;throw failure;}return valueRef;
      }catch(error){if(dispatched)faulted=true;throw error;}
    },
    async ownership({installationId,operation='inspect',expected}) {
      requireExecute();let dispatched=false;
      try {
        assert(['preflight','inspect','stop-watchdog','cleanup-retain','cleanup-remove'].includes(operation),'Unsupported ownership operation');
        const t=target(installationId),tool=settings.ownership_tool;
        assert(tool && pathKey(tool.path)===pathKey(windowsOwnershipToolPath) && digest.test(tool.sha256),'Explicit pinned ownership tool required');
        assert(operation==='preflight'?t.enroll_fresh===true && !t.install_nonce:!!t.install_nonce,'Ownership nonce boundary');
        let previous=null;
        if(expected || !['preflight','inspect'].includes(operation)){
          assert(operation!=='preflight','Fresh preflight cannot reuse an existing installation proof');
          const known=ownershipRefs.get(expected?.path);assert(known && known.installationId===installationId && known.sha256===expected.sha256,'Owned observation required');
          const captured=await readFile(expected.path);assert.equal(hash(captured),expected.sha256,'Owned observation changed');previous=json(captured);
        }
        await pinned(tool.path,tool.sha256);await pinned(settings.powershell.path,settings.powershell.sha256);
        const bootstrap=manifest.immutable_files.find(x=>x.path==='scripts/agentmemory-evidence.ps1');assert(bootstrap,'Missing evidence bootstrap');
        const lifecycle=manifest.immutable_files.find(x=>x.path==='scripts/agentmemory-lifecycle.ps1');assert(lifecycle,'Missing lifecycle ownership validator');
        const evidencePath=win32.join(plan.release_root,'payload',bootstrap.path),lifecyclePath=win32.join(plan.release_root,'payload',lifecycle.path);
        await pinned(evidencePath,bootstrap.sha256);await pinned(lifecyclePath,lifecycle.sha256);
        let predecessorHashes=null;
        if(t.predecessor_release_root){pathKey(t.predecessor_release_root);const bytes=await effects.read(win32.join(t.predecessor_release_root,'release-manifest.json'));assert.equal(hash(bytes),t.predecessor_manifest_sha256,'Pinned predecessor manifest mismatch');const old=json(bytes);assert(Array.isArray(old.immutable_files)&&old.immutable_files.length,'Missing predecessor inventory');predecessorHashes=Object.fromEntries(old.immutable_files.map(x=>{assert(typeof x.path==='string'&&!win32.isAbsolute(x.path)&&!x.path.split(/[\\/]/).includes('..'),'Predecessor inventory escape');return [x.path.replaceAll('/','\\'),x.sha256.toLowerCase()];}));}
        const contract={raw_root:outputDirectory,predecessor_hashes:predecessorHashes,schema_version:1,execution_id:plan.execution_id,installation_id:installationId,install_root:t.root,isolation_root:plan.isolation_root,owner_sid:t.owner_sid,
          install_nonce:t.install_nonce,candidate_manifest_sha256:plan.manifest_sha256,predecessor_manifest_sha256:t.predecessor_manifest_sha256??null,
          expected_rest_port:Number(new URL(t.rest_origin).port),node_path:plan.node_path,powershell_path:settings.powershell.path,
          allow_root_removal:t.allow_root_removal===true,evidence_path:evidencePath,evidence_sha256:bootstrap.sha256,lifecycle_path:lifecyclePath,lifecycle_sha256:lifecycle.sha256,
          candidate_hashes:Object.fromEntries(manifest.immutable_files.map(x=>[x.path.replaceAll('/','\\'),x.sha256.toLowerCase()])),previous};
        const c=await object(contract);await init();const identityPath=join(outputDirectory,'ownership-identity-'+randomUUID()+'.json');
        const command=[settings.powershell.path,'-NoProfile','-NonInteractive','-File',tool.path,'-ContractPath',c.path,'-Operation',operation,'-EvidenceIdentityPath',identityPath];
        dispatched=true;const value=await effects.run({command,cwd:plan.release_root,identityPath,outputDirectory,timeoutMs:windowsHostOwnershipBudget(operation),operation,installationId});
        const stdout=await raw(value.stdout),stderr=await raw(value.stderr);
        if(value.exit_code!==0 || value.pending!==false)throw await failedCapture('Ownership operation failed or remains pending',new Error(value.error_code??'OWNERSHIP_OUTCOME'),{...bind(installationId),operation,command,pid:value.pid??null,exit_code:value.exit_code??null,pending:value.pending??null,stdout,stderr,...(value.terminal_evidence?{terminal_evidence:value.terminal_evidence}:{})});const identity=json(value.identityBytes);assert.equal(identity.pid,value.pid);assert(Number.isSafeInteger(value.parent_pid)&&value.parent_pid>0);assert.equal(pathKey(identity.executable),pathKey(settings.powershell.path));
        assert(Date.parse(value.launched_at_utc)<=Date.parse(identity.created_at_utc)&&Date.parse(identity.created_at_utc)<=Date.parse(identity.started_at_utc)&&Date.parse(identity.started_at_utc)<=Date.parse(value.end_utc),'Ownership child time mismatch');
        const observation=json(value.stdout);assert.equal(observation.execution_id,plan.execution_id);assert.equal(observation.installation_id,installationId);assert.equal(pathKey(observation.install_root),pathKey(t.root));assert.equal(observation.owner_sid,t.owner_sid);assert.equal(observation.operation,operation);
        const ref=await raw(value.stdout);ownershipRefs.set(ref.path,{installationId,sha256:ref.sha256});
        const process=await object({...bind(installationId),...flags(synthetic),operation,command,pid:value.pid,parent_pid:value.parent_pid,creation_filetime:identity.creation_filetime,created_at_utc:identity.created_at_utc,start_utc:identity.started_at_utc,end_utc:value.end_utc,exit_code:value.exit_code,stdout,stderr,contract:c});
        return {observation:ref,process};
      }catch(error){if(dispatched)faulted=true;throw error;}
    },
    async enrollPrepared({installationId}) {
      requireExecute();const t=target(installationId);
      assert(t.enroll_fresh===true && t.install_nonce===null && !enrolled.has(installationId),'Fresh enrollment is one-use only');
      assert([...runs.values()].filter(x=>x.installationId===installationId && x.phase==='prepare' && x.exit_code===0).length===1,'Missing owned successful preparation');
      try {
        const ownerRef=await raw(await effects.read(win32.join(t.root,'.agentmemory-install-owner.json')));
        const installedRef=await raw(await effects.read(win32.join(t.root,'config/install-manifest.json')));
        const owner=json(await readFile(ownerRef.path)),installed=json(await readFile(installedRef.path));
        assert(/^[a-f0-9]{32}$/i.test(installed.install_nonce),'Invalid generated nonce');
        assert.equal(owner.install_nonce,installed.install_nonce,'Owner/manifest nonce mismatch');
        assert.equal(pathKey(owner.intended_root),pathKey(t.root),'Owner root mismatch');
        assert.equal(pathKey(installed.install_root),pathKey(t.root),'Prepared root mismatch');
        assert.equal(installed.owner_sid,t.owner_sid,'Prepared user mismatch');
        assert.equal(installed.release_manifest_sha256.toLowerCase(),plan.manifest_sha256,'Prepared candidate mismatch');
        assert.equal(installed.installation_status,'prepared','Expected actual prepared state');
        enrolled.set(installationId,installed.install_nonce);
        return object({...bind(installationId),...flags(synthetic),install_nonce:installed.install_nonce,owner:ownerRef,manifest:installedRef,observed_at_utc:effects.now()});
      }catch(error){faulted=true;throw error;}
    },
    async captureLauncher({installationId}) {
      requireExecute();const t=target(installationId),capture={};
      for(const [key,path] of [['binary','bin/agentmemory-hidden-launcher.exe'],['source','src/AgentMemoryHiddenLauncher.cs']]) {
        const original_path=win32.join(t.root,path),content=await raw(await effects.read(original_path));
        capture[key]=freeze({original_path,observed_at_utc:effects.now(),content});
      }
      freeze(capture);launcherCaptures.set(capture,installationId);return capture;
    },
    async launcherPreservation({installationId,actionProcess,before,after}) {
      requireExecute();const t=target(installationId),run=runs.get(actionProcess?.path);
      assert(run && run.installationId===installationId && run.sha256===actionProcess.sha256 && run.exit_code===0 && ['update','recover'].includes(run.phase),'Missing owned successful updater');
      assert(launcherCaptures.get(before)===installationId && launcherCaptures.get(after)===installationId && before!==after,'Launcher captures must belong to this installation and recorder');
      const source='src/AgentMemoryHiddenLauncher.cs',entry=manifest.immutable_files.find(x=>x.path===source);assert(entry,'Candidate launcher source missing');
      const candidate_source=await pinned(win32.join(plan.release_root,'payload',source),entry.sha256);
      const ref=await object({...bind(installationId),action_process:actionProcess,before_binary:before.binary,before_source:before.source,after_binary:after.binary,candidate_source});
      preservationRefs.set(ref.path,{installationId,sha256:ref.sha256});return ref;
    },
    async snapshot({installationId,runtime=true,launcherPreservation}) {
      requireExecute();const t=target(installationId);assert(t.install_nonce,'Fresh nonce enrollment required');const manifestRef=await raw(await effects.read(win32.join(t.root,'config/install-manifest.json')));
      const state=runtime?await raw(await effects.read(win32.join(t.root,'data/runtime-state.json'))):null;
      if(launcherPreservation) {
        const known=preservationRefs.get(launcherPreservation.path);
        assert(known?.installationId===installationId && known.sha256===launcherPreservation.sha256,'Foreign launcher preservation proof');
      }
      return object({...bind(installationId),observed_at_utc:effects.now(),manifest:manifestRef,...(state?{runtime:state}:{}),...(launcherPreservation?{launcher_preservation:launcherPreservation}:{})});
    },
    async memory({installationId,kind,body,id,authorization}) {
      requireExecute();const t=target(installationId);assert(['created','search','detail'].includes(kind),'Unsupported memory operation');
      assert(typeof authorization==='string' && authorization.length>0 && !/[\r\n]/.test(authorization),'Explicit credential injection required; no credential file reader exists');
      if(kind!=='detail')assert(body?.project===t.project,'Memory project differs from plan');else assert(typeof id==='string' && id.length>0,'Memory ID required');
      const method=kind==='detail'?'GET':'POST';
      const url=t.rest_origin+(kind==='detail'?'/agentmemory/memories/'+encodeURIComponent(id)+'?project='+encodeURIComponent(t.project):kind==='created'?'/agentmemory/remember':'/agentmemory/search');
      const result=await effects.request({url,method,...(kind==='detail'?{}:{body}),authorization});
      assert(Buffer.isBuffer(result.bytes) && Number.isSafeInteger(result.status_code) && result.status_code>=100 && result.status_code<=599,'Original API bytes/status required');
      assert(!result.bytes.includes(Buffer.from(authorization)),'API response contains a credential; no response stored');
      const response=await raw(result.bytes);
      return object({...bind(installationId),...flags(synthetic),capture_id:randomUUID(),observed_at_utc:effects.now(),
        request:{url,method,project:t.project},status_code:result.status_code,response});
    },
    async failure({installationId,failedAction,details,restoredState}) {
      requireExecute();const run=runs.get(failedAction.path);
      assert(run && run.installationId===installationId && Number.isSafeInteger(run.exit_code) && run.exit_code!==0,'Failure must reference this recorder failed child');
      assert(details?.original_error && details.phase && details.outcome,'Missing original failure details');
      assert(Object.keys(details).every(key=>['original_error','original_error_id','original_error_hresult','restore_error','phase','outcome','restoration_completed','runtime_ready','runtime_stopped'].includes(key)),'Unknown failure detail field');
      if(restoredState)assert(bytesByPath.get(restoredState.path)===restoredState.sha256,'Restored state must be captured by this recorder');
      return object({...bind(installationId),...flags(synthetic),...details,stderr:run.stderr,...(details.outcome==='rollback_failed'?{restore_stderr:run.stderr}:{}),...(restoredState?{restored_state:restoredState}:{})});
    },
    async assemble(scenarios, partial=false) {
      requireExecute();
      const checkRefs=value=>{
        if(!value || typeof value!=='object')return;
        if(value.path && value.sha256)assert.equal(bytesByPath.get(value.archive_path??value.path),value.sha256,'Result references bytes not captured by this recorder');
        for(const x of Object.values(value))checkRefs(x);
      };checkRefs(scenarios);
      const result={schema_version:2,...flags(synthetic),execution_id:plan.execution_id,
        source_commit:plan.source_commit,source_input_digest:plan.source_input_digest,manifest_sha256:plan.manifest_sha256,scenarios,...(resumed?{prepared_resume:resumed}:{})};
      const qualification={...flags(synthetic),source_commit:plan.source_commit,source_input_digest:plan.source_input_digest,manifest_sha256:plan.manifest_sha256,
        windows_e2e:{...structuredClone(settings),installations:Object.fromEntries(Object.keys(settings.installations).map(id=>[id,target(id)])),raw_root:outputDirectory}};
      const context={manifestBytes,releaseRoot:plan.release_root,load:readBounded};
      const verify=partial?(synthetic?verifySyntheticPartialWindowsScenarioEvidence:verifyPartialWindowsScenarioEvidence):(synthetic?verifySyntheticWindowsScenarioEvidence:verifyWindowsScenarioEvidence);
      const verification=await verify(result,qualification,context);
      const evidence=await object(result);return {...flags(synthetic),evidence,result,qualification,verification};
    }
  };
  // Set the guard synchronously, before any method reaches its first await.
  // Every public operation uses the same guard in either start order.
  for(const [name,operation] of Object.entries(api))if(typeof operation==='function') {
    api[name]=async(...args)=>{
      requireExecute();assert(!operationInFlight,'An owned operation is still in flight');operationInFlight=true;
      try{return await operation(...args);}finally{operationInFlight=false;}
    };
  }
  return Object.freeze(api);
}
export function createWindowsHostAdapter(options) {return create(options,realEffects(),false);}
export function createSyntheticWindowsHostAdapter(options,effects) {
  assert(effects && ['read','run','request','now','digest'].every(key=>typeof effects[key]==='function'),'All synthetic effects must be supplied; no real fallback');
  return create(options,effects,true);
}
