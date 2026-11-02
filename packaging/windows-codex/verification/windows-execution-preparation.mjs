import {assertActiveTimeoutProof} from './windows-active-timeout.mjs';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,lstat,realpath,mkdir,open} from 'node:fs/promises';
import {resolve,dirname,join,relative,isAbsolute,win32} from 'node:path';
import {fileURLToPath} from 'node:url';
import {hash} from './distribution-qualification.mjs';
import {windowsEvidenceEnvironment} from './windows-evidence-host.mjs';

export const windowsPreparationToolPath=fileURLToPath(new URL('./windows-evidence-preparation.ps1',import.meta.url));
const parse=bytes=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
const within=(base,path)=>{const r=relative(resolve(base),resolve(path));return r && r!=='..'&&!r.startsWith('..\\')&&!r.startsWith('../')&&!isAbsolute(r);};
const pathKey=p=>win32.normalize(p).toLowerCase();
const winWithin=(base,path)=>{const r=win32.relative(pathKey(base),pathKey(path));return r&&r!=='..'&&!r.startsWith('..\\')&&!win32.isAbsolute(r);};

export function assertWindowsLauncherPolicyInheritance(bytes) {
  const source=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  for(const name of ['baseArguments','validationArguments']) {
    const body=source.match(new RegExp('string\\[\\] '+name+' = new\\[\\] \\{([\\s\\S]*?)\\};'))?.[1];
    assert(body&&!/ExecutionPolicy|Bypass/.test(body),'Candidate launcher does not inherit the current PowerShell policy; rebuild required');
  }
}

// Only ancestors of this exact evidence directory may be created. Never mkdir a slot.
export async function ensureWindowsEvidenceParents(plan,outputDirectory) {
  const root=resolve(outputDirectory),isolation=resolve(plan.isolation_root),parent=dirname(root);
  assert(within(join(isolation,'evidence'),root),'Evidence must be under the fixed isolation/evidence directory');
  const slots=Object.values(plan.windows_e2e.installations).map(t=>resolve(t.root));
  for(const slot of slots)assert(root!==slot&&!within(slot,root)&&!within(root,slot),'Evidence overlaps an installation');
  const missing=[];
  for(let p=parent;;p=dirname(p)) {
    try {const s=await lstat(p);assert(s.isDirectory()&&!s.isSymbolicLink(),'Evidence ancestor redirects');}
    catch(error){if(error.code!=='ENOENT')throw error;assert(p===isolation||within(isolation,p),'Missing ancestor outside fixed isolation');missing.push(p);}
    if(dirname(p)===p)break;
  }
  for(const p of missing.reverse()) {
    assert(!slots.some(slot=>p===slot||within(slot,p)),'Refusing to create an installation root');
    await mkdir(p);assert.equal((await realpath(p)).toLowerCase(),p.toLowerCase(),'Evidence ancestor redirects');
  }
  return {created:missing,installation_roots_created:false};
}

export async function prepareWindowsIsolatedSupport(plan,installationId) {
  const t=plan.windows_e2e.installations[installationId];assert(t,'Unknown support target');
  const workspace=resolve(t.workspace_root),registry=resolve(t.project_registry);
  assert(within(plan.isolation_root,workspace)&&registry===join(workspace,'registry.json')&&resolve(t.requirements_path)===join(workspace,'managed-requirements.toml'),'Exact isolated workspace/registry/requirements required');
  assert(!Object.values(plan.windows_e2e.installations).some(s=>workspace===resolve(s.root)||within(s.root,workspace)),'Support overlaps an installation');
  await mkdir(workspace);assert.equal((await realpath(workspace)).toLowerCase(),workspace.toLowerCase());
  const file=await open(registry,'wx');try{await file.writeFile(JSON.stringify({schema_version:2,projects:[]}));await file.sync();}finally{await file.close();}
  return {workspace_root:workspace,registry,created:true,production_qualified:false};
}

const diagnosticStages=new Set(['initial','read-contract','validate-contract','write-identity','read-owner','read-installed','validate-identity','read-config','inspect-active','inspect-existing','inspect-prepared','configure-build','configure-temp-write','configure-release','configure-check','configure-replace','configure-verify']);
const diagnosticTypes=new Set(['System.ArgumentException','System.ArgumentNullException','System.IO.IOException','System.IO.FileNotFoundException','System.IO.DirectoryNotFoundException','System.UnauthorizedAccessException','System.Security.SecurityException','System.InvalidOperationException','System.NotSupportedException','System.ComponentModel.Win32Exception','System.FormatException','System.Exception','System.Management.Automation.MethodInvocationException','System.Management.Automation.RuntimeException','System.Management.Automation.PSArgumentException']);
export function parseWindowsPreparationDiagnostic(bytes){
  try{assert(Buffer.isBuffer(bytes)&&bytes.length<=1024);const v=parse(bytes);assert(Object.keys(v).length===4&&Object.keys(v).every(k=>['schema_version','stage','exception_type','hresult'].includes(k))&&v.schema_version===1&&diagnosticStages.has(v.stage)&&diagnosticTypes.has(v.exception_type)&&/^[A-F0-9]{8}$/.test(v.hresult));return Object.freeze({schema_version:1,stage:v.stage,exception_type:v.exception_type,hresult:v.hresult});}catch{return null;}
}

function realRun({command,cwd,operation,identityPath}) {
  return new Promise(resolveRun=>{
    let done=false,size=0,parts=[],diagnosticParts=[],diagnosticSize=0,diagnosticOverflow=false,timer;const start_utc=new Date().toISOString();
    const child=spawn(command[0],command.slice(1),{cwd,shell:false,windowsHide:true,env:windowsEvidenceEnvironment(cwd),stdio:['ignore','pipe','pipe']});
    const finish=async(exit_code,error_code=null,pending=false)=>{
      if(done)return;done=true;clearTimeout(timer);
      const bytes=Buffer.concat(parts);for(const p of parts)p.fill(0);parts=[];
      let identity=null;try{identity=parse(await readFile(identityPath));}catch{error_code??='IDENTITY_UNAVAILABLE';}
      const diagnostic=operation==='credential'||diagnosticOverflow?null:parseWindowsPreparationDiagnostic(Buffer.concat(diagnosticParts));for(const b of diagnosticParts)b.fill(0);diagnosticParts=[];
      if(identity)try{assert(identity.pid===child.pid&&typeof identity.executable==='string'&&pathKey(identity.executable)===pathKey(command[0])&&Number.isFinite(Date.parse(identity.created_at_utc)));}catch{error_code='IDENTITY_MISMATCH';}
      resolveRun({bytes,receipt:{operation,pid:child.pid??null,parent_pid:process.pid,start_utc,end_utc:new Date().toISOString(),created_at_utc:identity?.created_at_utc??null,exit_code,error_code,pending,...(diagnostic?{diagnostic}:{})}});
    };
    child.stdout.on('data',chunk=>{if(done){chunk.fill(0);return;}size+=chunk.length;if(size>(operation==='credential'?64:8192)){chunk.fill(0);finish(null,'OUTPUT_LIMIT',true);return;}parts.push(Buffer.from(chunk));chunk.fill(0);});
    // Only a bounded fixed diagnostic may survive; credential stderr and arbitrary text are discarded.
    child.stderr.on('data',chunk=>{if(operation!=='credential'&&!done){diagnosticSize+=chunk.length;if(diagnosticSize<=1024&&!diagnosticOverflow)diagnosticParts.push(Buffer.from(chunk));else{diagnosticOverflow=true;for(const b of diagnosticParts)b.fill(0);diagnosticParts=[];}}chunk.fill(0);});
    child.once('error',()=>finish(null,'SPAWN_ERROR',false));
    child.once('close',(code,signal)=>finish(code,signal?'SIGNAL':null,false));
    timer=setTimeout(()=>finish(null,'TIMEOUT',true),15000);
    // Unknown/pending does not authorize PID-only termination or another read.
  });
}

function create(options,effects,synthetic) {
  assert(Object.keys(options).every(k=>['plan','outputDirectory','execute'].includes(k)),'Unknown preparation option');
  const plan=structuredClone(options.plan),root=resolve(options.outputDirectory),execute=options.execute===true;
  assert(plan.synthetic===synthetic&&plan.evidence_kind===(synthetic?'synthetic_contract':'windows_execution')&&plan.production_qualified===false,'Wrong preparation boundary');
  const ids=Object.keys(plan.windows_e2e?.installations??{});assert(ids.length>0,'Explicitly scoped slots required');
  const tool=plan.windows_e2e.preparation_tool,shell=plan.windows_e2e.powershell;
  assert(tool?.path===windowsPreparationToolPath&&/^[a-f0-9]{64}$/.test(tool.sha256)&&/^[a-f0-9]{64}$/.test(shell?.sha256),'Pinned preparation tool/host required');
  assert(/^[a-f0-9-]{36}$/i.test(plan.execution_id)&&/^[a-f0-9]{64}$/.test(plan.manifest_sha256),'Fixed execution/candidate required');
  assert(within(join(plan.isolation_root,'evidence'),root),'Preparation output must stay in fixed evidence subtree');
  let initialized=false,busy=false,held=false,sequence=0;const configured=new Set(),resumeAdmissions=new Map(),activeConfigHashes=new Map(),existingManifestHashes=new Map();
  async function init(){if(initialized)return;await ensureWindowsEvidenceParents(plan,root);await mkdir(root);assert.equal((await realpath(root)).toLowerCase(),root.toLowerCase());initialized=true;}
  async function exclusive(name,bytes){await init();const path=join(root,name),f=await open(path,'wx');try{await f.writeFile(bytes);await f.sync();}finally{await f.close();}return path;}
  const target=(id,nonce)=>{
    const t=plan.windows_e2e.installations[id];assert(t&&(t.enroll_fresh===true||t.install_nonce===nonce)&&/^S-1-/.test(t.owner_sid)&&winWithin(plan.isolation_root,t.root),'Foreign preparation target');
    assert(typeof nonce==='string'&&/^[a-f0-9-]{32,36}$/i.test(nonce),'Exact enrolled nonce required');
    for(const path of [t.workspace_root,t.project_registry,t.requirements_path])assert(typeof path==='string'&&winWithin(plan.isolation_root,path)&&!winWithin(t.root,path),'Support path is outside isolation or inside slot');
    const url=new URL(t.rest_origin);assert(url.protocol==='http:'&&url.hostname==='127.0.0.1'&&t.rest_origin===url.origin,'Exact loopback target required');
    return t;
  };
  async function dispatch(operation,id,nonce,closedWriter,preparedManifestSha256,retainedTemp,activeProof,existingManifestSha256){
    const t=target(id,nonce);
    assert.equal(hash(await effects.read(tool.path)),tool.sha256,'Preparation tool changed');
    assert.equal(hash(await effects.read(shell.path)),shell.sha256,'PowerShell changed');
    const contract={schema_version:1,operation,execution_id:plan.execution_id,source_commit:plan.source_commit,source_input_digest:plan.source_input_digest,candidate_manifest_sha256:plan.manifest_sha256,
      isolation_root:plan.isolation_root,install_root:t.root,install_nonce:nonce,owner_sid:t.owner_sid,workspace_root:t.workspace_root,project_registry:t.project_registry,expected_rest_port:Number(new URL(t.rest_origin).port),raw_root:root,...(operation==='credential'&&activeConfigHashes.has(id)?{expected_config_sha256:activeConfigHashes.get(id)}:{}),...(activeProof?{closed_writers:activeProof.closed_writers,expected_config_sha256:activeProof.config_sha256}:{}),...(closedWriter?{closed_writer:closedWriter,prepared_manifest_sha256:preparedManifestSha256,...(retainedTemp?{retained_temp:{path:retainedTemp.path,sha256:retainedTemp.sha256,bytes:retainedTemp.bytes},expected_config_sha256:retainedTemp.config_sha256}:{})}:{}),...(['configure','configure-retained'].includes(operation)&&resumeAdmissions.has(id)?resumeAdmissions.get(id):{})};
    const installedHash=existingManifestSha256??(operation==='credential'?existingManifestHashes.get(id):null);
    if(installedHash)contract.expected_installed_manifest_sha256=installedHash;
    const bytes=Buffer.from(JSON.stringify(contract)),contractPath=await exclusive('contract-'+(++sequence)+'.json',bytes);
    const identityPath=join(root,'identity-'+sequence+'.json');
    const command=[shell.path,'-NoProfile','-NonInteractive','-File',tool.path,'-ContractPath',contractPath,'-ContractSha256',hash(bytes),'-IdentityPath',identityPath,'-Operation',operation,'-Execute'];
    const run=await effects.run({command,cwd:root,operation,contract,identityPath});
    assert(Buffer.isBuffer(run.bytes),'Provider must return original in-memory bytes');
    try{
      const receipt=run.receipt;
      assert(receipt&&Number.isSafeInteger(receipt.pid)&&receipt.pid>0&&Number.isSafeInteger(receipt.parent_pid)&&receipt.parent_pid>0&&receipt.operation===operation,'Missing preparation process receipt');
      for(const k of ['start_utc','end_utc'])assert(typeof receipt[k]==='string'&&/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(receipt[k])&&Number.isFinite(Date.parse(receipt[k])),'Invalid provider clock');
      assert([null,undefined,'OUTPUT_LIMIT','SPAWN_ERROR','SIGNAL','TIMEOUT','IDENTITY_UNAVAILABLE','IDENTITY_MISMATCH'].includes(receipt.error_code)&&[true,false].includes(receipt.pending)&&(receipt.exit_code===null||Number.isSafeInteger(receipt.exit_code)),'Invalid provider outcome');
      if(receipt.created_at_utc!=null)assert(typeof receipt.created_at_utc==='string'&&/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(receipt.created_at_utc)&&Number.isFinite(Date.parse(receipt.created_at_utc))&&Date.parse(receipt.created_at_utc)<=Date.parse(receipt.end_utc),'Invalid provider birth identity');
      if(!receipt.error_code)assert(receipt.created_at_utc,'Missing actual provider birth identity');
      const safe=Object.fromEntries(['operation','pid','parent_pid','start_utc','end_utc','created_at_utc','exit_code','error_code','pending'].map(k=>[k,receipt[k]??null]));
      if(operation!=='credential'&&receipt.diagnostic){const d=parseWindowsPreparationDiagnostic(Buffer.from(JSON.stringify(receipt.diagnostic)));if(d)safe.diagnostic=d;}
      // Allow no arbitrary provider fields, stdout, stderr, credential hashes or values into evidence.
      await exclusive('receipt-'+sequence+'.json',Buffer.from(JSON.stringify(safe)));
      assert(receipt.exit_code===0&&receipt.pending===false&&!receipt.error_code,'Preparation child failed or outcome unknown');
      if(['inspect-prepared','inspect-active','inspect-existing'].includes(operation)){const v=parse(run.bytes);assert(Number.isFinite(Date.parse(v.observed_at_utc))&&Date.parse(v.observed_at_utc)>=Date.parse(receipt.start_utc)&&Date.parse(v.observed_at_utc)<=Date.parse(receipt.end_utc),'Stale prepared admission');}
      return run.bytes;
    }catch(error){run.bytes.fill(0);throw error;}
  }
  async function guard(action){assert(execute,'Preparation execution disabled');assert(!busy&&!held,'Preparation in flight or held');busy=true;try{return await action();}catch(error){held=true;throw error;}finally{busy=false;}}
  return Object.freeze({synthetic,production_qualified:false,status:()=>({busy,held,configured:[...configured]}),
    prepareSupport:({installationId})=>guard(()=>{assert(target(installationId,'0'.repeat(32)).enroll_fresh===true,'Only fresh support may be created');return effects.support(plan,installationId);}),
    inspectExisting:({installationId,installNonce,installedManifestSha256})=>guard(async()=>{
      const t=target(installationId,installNonce);
      assert(t.enroll_fresh!==true&&/^[a-f0-9]{64}$/.test(installedManifestSha256)&&[t.predecessor_manifest_sha256,plan.manifest_sha256].includes(installedManifestSha256),'Existing admission requires the pinned predecessor or candidate');
      const bytes=await dispatch('inspect-existing',installationId,installNonce,null,null,null,null,installedManifestSha256);
      try{
        const v=parse(bytes);
        assert(Object.keys(v).length===11&&Object.keys(v).every(k=>['operation','active','execution_id','install_root','owner_sid','install_nonce','candidate_manifest_sha256','installed_manifest_sha256','config_sha256','observed_at_utc','production_qualified'].includes(k)),'Unexpected existing admission fields');
        assert(v.operation==='inspect-existing'&&v.active===true&&v.execution_id===plan.execution_id&&v.install_root===t.root&&v.owner_sid===t.owner_sid&&v.install_nonce===installNonce&&v.candidate_manifest_sha256===plan.manifest_sha256&&v.installed_manifest_sha256===installedManifestSha256&&/^[a-f0-9]{64}$/.test(v.config_sha256)&&v.production_qualified===false,'Existing configuration admission mismatch');
        configured.add(installationId);activeConfigHashes.set(installationId,v.config_sha256);existingManifestHashes.set(installationId,installedManifestSha256);return v;
      }finally{bytes.fill(0);}
    }),
    inspectPrepared:({installationId,installNonce,closedWriter,preparedManifestSha256,retainedTemp})=>guard(async()=>{
      assert(target(installationId,installNonce).enroll_fresh===true,'Prepared resumption requires a fresh target');
      assert(closedWriter&&Number.isSafeInteger(closedWriter.pid)&&closedWriter.pid>0&&/^\d{17,20}$/.test(closedWriter.creation_filetime)&&pathKey(closedWriter.executable)===pathKey(plan.node_path),'Closed producer identity required');
      assert(/^[a-f0-9]{64}$/.test(preparedManifestSha256),'Pinned original prepared manifest required');
      if(retainedTemp){assert(Object.keys(retainedTemp).length===4&&Object.keys(retainedTemp).every(k=>['path','bytes','sha256','config_sha256'].includes(k))&&pathKey(win32.dirname(retainedTemp.path))===pathKey(win32.join(target(installationId,installNonce).root,'config'))&&/^evidence-config-[a-f0-9]{32}\.tmp$/.test(win32.basename(retainedTemp.path))&&Number.isSafeInteger(retainedTemp.bytes)&&retainedTemp.bytes>0&&retainedTemp.bytes<=1048576&&/^[a-f0-9]{64}$/.test(retainedTemp.sha256)&&/^[a-f0-9]{64}$/.test(retainedTemp.config_sha256),'Invalid retained source descriptor');}
      const bytes=await dispatch('inspect-prepared',installationId,installNonce,closedWriter,preparedManifestSha256,retainedTemp);
      try{const v=parse(bytes),t=target(installationId,installNonce);assert(Object.keys(v).length===12&&Object.keys(v).every(k=>['operation','prepared','unconfigured','writer_absent','install_root','install_nonce','candidate_manifest_sha256','config_sha256','execution_id','owner_sid','observed_at_utc','production_qualified'].includes(k)),'Unexpected admission fields');assert(v.execution_id===plan.execution_id&&v.owner_sid===t.owner_sid&&v.production_qualified===false,'Admission execution/owner mismatch');assert(v.operation==='inspect-prepared'&&v.prepared===true&&v.unconfigured===true&&v.writer_absent===true&&v.install_root===t.root&&v.install_nonce===installNonce&&v.candidate_manifest_sha256===plan.manifest_sha256&&/^[a-f0-9]{64}$/.test(v.config_sha256),'Prepared resumption admission mismatch');if(retainedTemp)assert.equal(v.config_sha256,retainedTemp.config_sha256,'Retained baseline changed');resumeAdmissions.set(installationId,{expected_config_sha256:v.config_sha256,prepared_manifest_sha256:preparedManifestSha256,...(retainedTemp?{retained_temp:{path:retainedTemp.path,bytes:retainedTemp.bytes,sha256:retainedTemp.sha256}}:{})});return v;}finally{bytes.fill(0);}
    }),
    inspectActiveAfterTimeout:({proof})=>guard(async()=>{
      assertActiveTimeoutProof(proof,plan,synthetic);const id=proof.installation_id,t=target(id,proof.install_nonce);
      assert(!configured.has(id)&&!resumeAdmissions.has(id),'Preparation already entered');
      const bytes=await dispatch('inspect-active',id,proof.install_nonce,null,null,null,proof);
      try{const v=parse(bytes);assert(v.operation==='inspect-active'&&v.active===true&&v.execution_id===plan.execution_id&&v.install_root===t.root&&v.owner_sid===t.owner_sid&&v.install_nonce===proof.install_nonce&&v.candidate_manifest_sha256===plan.manifest_sha256&&v.config_sha256===proof.config_sha256&&v.production_qualified===false,'Active configuration admission mismatch');assert(Array.isArray(v.closed_writers)&&v.closed_writers.length===proof.closed_writers.length&&v.closed_writers.every((w,i)=>w.state==='absent'&&w.pid===proof.closed_writers[i].pid&&w.creation_filetime===proof.closed_writers[i].creation_filetime),'Original writer closure is unknown');assert(Date.parse(v.observed_at_utc)>=Date.parse(proof.admitted_after_utc),'Active configuration admission is stale');configured.add(id);activeConfigHashes.set(id,proof.config_sha256);return v;}finally{bytes.fill(0);}
    }),
    configure:({installationId,installNonce})=>guard(async()=>{
      assert(target(installationId,installNonce).enroll_fresh===true,'Existing configuration is read-only');
      assert(!configured.has(installationId),'Configuration already entered');configured.add(installationId);
      const bytes=await dispatch(resumeAdmissions.get(installationId)?.retained_temp?'configure-retained':'configure',installationId,installNonce);
      try{const result=parse(bytes),t=target(installationId,installNonce);assert(result.configured===true&&result.install_root===t.root&&result.install_nonce===installNonce&&result.candidate_manifest_sha256===plan.manifest_sha256&&/^[a-f0-9]{64}$/.test(result.config_sha256),'Configuration result binding mismatch');return {configured:true,config_sha256:result.config_sha256,production_qualified:false};}finally{bytes.fill(0);}
    }),
    withCredential:({installationId,installNonce},use)=>guard(async()=>{
      assert(configured.has(installationId),'Scoped configuration must precede credential use');assert(typeof use==='function');
      let bytes,secret;
      try{
        bytes=await dispatch('credential',installationId,installNonce);
        assert(bytes.length===44&&/^[A-Za-z0-9+/]{43}=$/.test(bytes.toString('ascii')),'Invalid one-shot credential envelope');secret=bytes.toString('ascii');
        const result=await use(secret);
        assert(!JSON.stringify(result??null).includes(secret),'Credential cannot enter returned evidence');return result;
      }catch{throw new Error('One-shot credential operation failed; held; no secret/error stream retained');}
      finally{bytes?.fill(0);secret=undefined;}
    })
  });
}
export function createWindowsExecutionPreparation(options){return create(options,{read:readFile,run:realRun,support:prepareWindowsIsolatedSupport},false);}
export function createSyntheticWindowsExecutionPreparation(options,effects){assert(effects&&['read','run','support'].every(k=>typeof effects[k]==='function'),'Synthetic provider requires all fake effects');return create(options,effects,true);}
