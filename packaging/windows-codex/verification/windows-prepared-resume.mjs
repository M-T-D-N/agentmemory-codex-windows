import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstat,readFile,realpath} from 'node:fs/promises';
import {win32} from 'node:path';

const sha=b=>createHash('sha256').update(b).digest('hex');
const parse=b=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b).replace(/^\uFEFF/,''),(k,v,context)=>{if(k==='creation_filetime'&&typeof v==='number'){assert(context&&/^\d+$/.test(context.source),'Lossless FILETIME parser required');return context.source;}return v;});
const key=p=>{assert(typeof p==='string'&&/^[A-Za-z]:[\\/]/.test(p)&&!p.split(/[\\/]/).includes('..')&&!/[\0-\x1f"*?]/.test(p),'Explicit resume path required');return win32.normalize(p).toLowerCase();};
const under=(r,p)=>{const x=win32.relative(key(r),key(p));return x&&x!=='..'&&!x.startsWith('..\\')&&!win32.isAbsolute(x);};
const at=x=>{assert(typeof x==='string'&&/(Z|[+-]\d\d:\d\d)$/.test(x)&&Number.isFinite(Date.parse(x)),'Explicit resume clock required');return Date.parse(x);};
const filetime=s=>{const m=s.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,7}))?(Z|[+-]\d\d:\d\d)$/);assert(m,'Precise process time required');return BigInt(Date.parse(m[1]+m[3]))*10000n+BigInt((m[2]??'').padEnd(7,'0'))+116444736000000000n;};
const pid=x=>assert(Number.isSafeInteger(x)&&x>0,'Closed process PID required');
const frozen=x=>{if(x&&typeof x==='object'){for(const v of Object.values(x))frozen(v);Object.freeze(x);}return x;};
const capabilities=new WeakSet();
export const preparedResumeClaimKey=p=>sha(Buffer.from(JSON.stringify([p.execution_id,p.installation_id,p.install_nonce,p.candidate_manifest_sha256])));
export function assertPreparedResumeProof(proof,plan,synthetic){assert(capabilities.has(proof),'Verified closed preparation capability required');assert.equal(proof.synthetic,synthetic);assert.deepEqual(proof.plan,plan,'Resume plan changed after verification');return proof;}
async function safeRead(path){const s=await lstat(path);assert(s.isFile()&&!s.isSymbolicLink()&&s.size<=32*1024*1024,'Unsafe closed evidence');assert.equal(key(await realpath(path)),key(path),'Closed evidence redirects');return readFile(path);}

// Read-only verifier: it never queries a PID, dispatches a process, reads a key or writes a claim.
export async function verifyPreparedResumeEvidence(spec,{plan,manifestBytes,synthetic=false,load=safeRead}){
  if(!synthetic)load=safeRead;
  assert.equal(plan.synthetic,synthetic);assert.equal(plan.evidence_kind,synthetic?'synthetic_contract':'windows_execution');assert.equal(plan.production_qualified,false);
  const names=['installation_id','prior_output_directory','prior_controller_directory','original_plan','controller','driver','prepared','failure','prepare_process','prepared_snapshot','prepared_ownership_process','configure_contract','configure_identity','configure_receipt','ownership_tool'];
  assert(spec&&Object.keys(spec).length===names.length&&Object.keys(spec).every(k=>names.includes(k)),'Incomplete or unsupported resume proof');
  const id=spec.installation_id,t=plan.windows_e2e.installations[id];assert(t&&Object.keys(plan.windows_e2e.installations).length===1&&t.enroll_fresh===true&&t.install_nonce===null,'Resume requires the original single fresh slot');
  assert(under(win32.join(plan.isolation_root,'evidence'),spec.prior_output_directory),'Previous evidence outside exact isolation');key(spec.prior_controller_directory);
  const oldCapture=win32.join(spec.prior_output_directory,'captures'),refs=new Map();
  async function raw(ref,controller=false){
    assert(ref&&/^[a-f0-9]{64}$/.test(ref.sha256)&&typeof ref.path==='string','Missing pinned original evidence');const p=ref.archive_path??ref.path;
    assert(under(controller?spec.prior_controller_directory:spec.prior_output_directory,p),'Original evidence escapes its fixed directory');
    const b=await load(p);assert(Buffer.isBuffer(b)&&b.length<=32*1024*1024&&sha(b)===ref.sha256,'Original evidence hash mismatch');refs.set(p,{...ref});return b;
  }
  const json=async(ref,controller=false)=>parse(await raw(ref,controller));
  const envelope=await json(spec.original_plan,true),oldPlan=envelope.api_options?.plan;
  assert(envelope.api_options?.execute===true&&oldPlan,'Missing original executed plan');
  const adjusted=structuredClone(plan);adjusted.windows_e2e.preparation_tool=oldPlan.windows_e2e.preparation_tool;
  assert.deepEqual(oldPlan,adjusted,'Candidate, slot or original tool pin changed');
  for(const tool of ['powershell','ownership_tool','preparation_tool'])assert(oldPlan.windows_e2e[tool]?.path&&/^[a-f0-9]{64}$/.test(oldPlan.windows_e2e[tool].sha256),'Missing old tool pin');
  assert(envelope.tool_bindings?.some(x=>key(x.path)===key(oldPlan.windows_e2e.ownership_tool.path)&&x.sha256===oldPlan.windows_e2e.ownership_tool.sha256),'Original ownership tool source pin missing');
  assert.equal(key(spec.ownership_tool.path),key(oldPlan.windows_e2e.ownership_tool.path));assert.equal(sha(await raw(spec.ownership_tool)),oldPlan.windows_e2e.ownership_tool.sha256,'Original ownership tool bytes differ');
  const manifest=parse(manifestBytes);assert.equal(sha(manifestBytes),plan.manifest_sha256);assert.equal(manifest.source_commit,plan.source_commit);assert.equal(manifest.source_input_digest,plan.source_input_digest);
  const controller=await json(spec.controller,true),driver=await json(spec.driver,true);
  assert(controller.state==='held_after_failure_or_unknown'&&controller.product_security_actions_started===true&&driver.state==='held_after_failure_or_unknown','Original execution is not closed on failed configuration');
  assert.deepEqual(driver.candidate,{source_commit:plan.source_commit,source_input_digest:plan.source_input_digest,manifest_sha256:plan.manifest_sha256,release_root:plan.release_root});
  assert.equal(driver.installation_id,id);assert.equal(key(driver.install_root),key(t.root));pid(driver.driver_pid);pid(driver.parent_pid);
  const closed=controller.commands?.filter(x=>x.label==='01-producer');assert.equal(closed?.length,1);const supervisor=closed[0];
  assert(supervisor.pid===driver.driver_pid&&supervisor.parent_pid===driver.parent_pid&&supervisor.state==='completed'&&supervisor.exit_code===1&&/^\d{17,20}$/.test(String(supervisor.creation_filetime)),'Original producer is pending or lacks birth/exit identity');
  assert(BigInt(supervisor.creation_filetime)>=filetime(supervisor.start_utc)&&BigInt(supervisor.creation_filetime)<=filetime(supervisor.end_utc),'Closed producer birth outside recorded execution');
  assert.equal(key(supervisor.command?.[0]),key(plan.node_path));assert.equal(supervisor.command.length,3);assert(under(spec.prior_controller_directory,supervisor.command[1]));assert.equal(key(supervisor.command[2]),key(spec.original_plan.path));
  assert(at(supervisor.start_utc)<=at(driver.start_utc)&&at(driver.end_utc)<=at(supervisor.end_utc),'Closed driver clock mismatch');
  const stages=driver.phases;assert.deepEqual(stages?.map(x=>[x.name,x.state]),[['construct_and_verify_fixed_candidate','completed'],['prepare_fresh','completed'],['configure_isolated_prepared','failed_or_unknown']]);
  assert(driver.current_phase==='configure_isolated_prepared'&&driver.producer_status?.held===true&&driver.producer_status.busy===false&&driver.producer_status.completed.length===0&&driver.producer_status.removed.length===0,'Original producer continued after failure');
  for(let i=0;i<stages.length;i++){assert(at(stages[i].start_utc)<=at(stages[i].end_utc));if(i)assert(at(stages[i-1].end_utc)<=at(stages[i].start_utc));}
  const prepared=await json(spec.prepared),failure=await json(spec.failure),enrollment=await json(prepared.enrollment);
  for(const x of [prepared,failure,enrollment]){assert.equal(x.synthetic,synthetic);assert.equal(x.evidence_kind,plan.evidence_kind);assert.equal(x.production_qualified,false);}
  assert(prepared.phase==='prepared'&&prepared.installation_id===id&&failure.status==='held'&&typeof failure.original_error==='string'&&failure.original_error.length&&failure.original_receipt===null,'Original failed configuration must be retained');
  assert.deepEqual(stages[2].error?.producer_failure,spec.failure,'Failure record changed');
  const bind=x=>{assert(x.execution_id===plan.execution_id&&x.installation_id===id&&key(x.install_root)===key(t.root),'Foreign prepare execution/slot');};bind(enrollment);
  const owner=await json(enrollment.owner),installed=await json(enrollment.manifest),nonce=enrollment.install_nonce;
  assert(/^[a-f0-9]{32}$/.test(nonce)&&owner.install_nonce===nonce&&installed.install_nonce===nonce&&key(owner.intended_root)===key(t.root)&&key(installed.install_root)===key(t.root)&&installed.owner_sid===t.owner_sid,'Original enrollment identity mismatch');
  function assertInstalled(m){assert(m.installation_status==='prepared'&&m.install_nonce===nonce&&m.owner_sid===t.owner_sid&&key(m.install_root)===key(t.root)&&m.release_manifest_sha256.toLowerCase()===plan.manifest_sha256&&m.release_revision===manifest.release_revision&&m.package_relative_path===manifest.package_relative_path,'Original prepared candidate mismatch');for(const f of manifest.immutable_files)assert.equal(m.source_hashes?.[f.path.replaceAll('/','\\')]?.toLowerCase(),f.sha256.toLowerCase(),'Prepared input inventory differs');}
  assertInstalled(installed);
  const process=await json(spec.prepare_process);bind(process);assert.equal(process.scenario,'fresh_install');assert.equal(process.phase,'prepare');assert.equal(process.exit_code,0);pid(process.pid);assert.equal(process.parent_pid,driver.driver_pid);assert(/^\d{17,20}$/.test(process.creation_filetime)&&BigInt(process.creation_filetime)===filetime(process.created_at_utc),'Prepare creation FILETIME missing or inconsistent');
  assert.equal(process.synthetic,synthetic);assert.equal(process.evidence_kind,plan.evidence_kind);assert.equal(process.production_qualified,false);
  const identity=process.command?.at(-1);assert(under(oldCapture,identity)&&/^identity-[a-f0-9-]{36}\.json$/i.test(win32.basename(identity)),'Foreign prepare identity capture');
  const expected=[plan.windows_e2e.powershell.path,'-NoProfile','-NonInteractive','-File',win32.join(plan.release_root,'Install-WindowsCodex.ps1'),'-ReleaseRoot',plan.release_root,'-InstallRoot',t.root,'-WorkspaceRoot',t.workspace_root,'-ProjectRegistry',t.project_registry,'-NodePath',plan.node_path,'-ManagedRequirementsPath',t.requirements_path,'-RestPort',String(new URL(t.rest_origin).port),'-Execute','-Fresh','-EvidenceUtf8','-EvidenceIdentityPath',identity];assert.deepEqual(process.command,expected,'Original command did not execute the exact fresh preparation');
  const executable=await raw(process.executable),script=await raw(process.script);assert(key(process.executable.path)===key(plan.windows_e2e.powershell.path)&&sha(executable)===plan.windows_e2e.powershell.sha256);assert(key(process.script.path)===key(expected[4])&&sha(script)===manifest.release_files.find(x=>x.path==='Install-WindowsCodex.ps1')?.sha256.toLowerCase());
  const originalIdentity=parse(await load(identity));refs.set(identity,{path:identity,sha256:sha(Buffer.from(await load(identity)))});assert(originalIdentity.pid===process.pid&&key(originalIdentity.executable)===key(expected[0])&&originalIdentity.creation_filetime===process.creation_filetime&&originalIdentity.created_at_utc===process.created_at_utc&&originalIdentity.started_at_utc===process.start_utc,'Prepare process identity file differs');
  assert(at(stages[1].start_utc)<=at(process.created_at_utc)&&at(process.created_at_utc)<=at(process.start_utc)&&at(process.start_utc)<=at(process.end_utc)&&at(process.end_utc)<=at(stages[1].end_utc),'Prepare process times differ');
  const output=parse(await raw(process.stdout));await raw(process.stderr);assert.equal(process.stdout.encoding,'utf-8');assert(output.ready===true&&output.execute===true&&output.operation==='prepare-fresh'&&output.prepared===true&&output.service_started===false&&key(output.install_root)===key(t.root),'Missing actual prepare output');
  const after=await json(spec.prepared_snapshot);bind(after);assert(!after.runtime&&at(after.observed_at_utc)>=at(process.end_utc)&&at(after.observed_at_utc)<=at(stages[1].end_utc),'Original snapshot out of order');assertInstalled(await json(after.manifest));assert.equal(after.manifest.sha256,enrollment.manifest.sha256);
  const ownership=await json(spec.prepared_ownership_process);bind(ownership);assert(ownership.operation==='inspect'&&ownership.exit_code===0&&ownership.parent_pid===driver.driver_pid&&at(ownership.start_utc)>=at(after.observed_at_utc)&&at(ownership.end_utc)<=at(stages[1].end_utc),'Original ownership receipt missing or out of order');pid(ownership.pid);
  const contract=await json(ownership.contract);assert(contract.execution_id===plan.execution_id&&contract.installation_id===id&&contract.install_nonce===nonce&&key(contract.install_root)===key(t.root)&&contract.owner_sid===t.owner_sid&&contract.candidate_manifest_sha256===plan.manifest_sha256,'Original ownership contract mismatch');
  assert.deepEqual(ownership.command,[plan.windows_e2e.powershell.path,'-NoProfile','-NonInteractive','-File',plan.windows_e2e.ownership_tool.path,'-ContractPath',ownership.contract.path,'-Operation','inspect','-EvidenceIdentityPath',ownership.command.at(-1)]);assert(under(oldCapture,ownership.command.at(-1)));
  assert(/^\d{17,20}$/.test(ownership.creation_filetime)&&BigInt(ownership.creation_filetime)===filetime(ownership.created_at_utc)&&at(ownership.created_at_utc)<=at(ownership.start_utc)&&at(ownership.start_utc)<=at(ownership.end_utc),'Ownership process birth/order missing');
  const observation=await json(ownership.stdout);await raw(ownership.stderr);bind(observation);assert(at(observation.observed_at_utc)>=at(ownership.created_at_utc)&&at(observation.observed_at_utc)<=at(ownership.end_utc),'Original ownership observation time differs');assert(observation.status==='prepared'&&observation.install_nonce===nonce&&observation.watchdog_active===false&&observation.processes?.length===0&&observation.tasks?.length===2&&observation.tasks.every(x=>x.state==='Absent'&&x.actual_action===null),'Original prepared observation is not empty');
  const c=await json(spec.configure_contract),ci=await json(spec.configure_identity),cr=await json(spec.configure_receipt);
  assert(c.operation==='configure'&&c.execution_id===plan.execution_id&&c.install_nonce===nonce&&c.owner_sid===t.owner_sid&&key(c.install_root)===key(t.root)&&c.candidate_manifest_sha256===plan.manifest_sha256&&key(c.workspace_root)===key(t.workspace_root)&&key(c.project_registry)===key(t.project_registry),'Original configure targeted another slot');
  assert(cr.operation==='configure'&&Number.isSafeInteger(cr.exit_code)&&cr.exit_code!==0&&cr.pending===false&&cr.error_code===null&&cr.parent_pid===driver.driver_pid&&ci.pid===cr.pid&&ci.created_at_utc===cr.created_at_utc&&key(ci.executable)===key(plan.windows_e2e.powershell.path),'Original configure is not conclusively closed');pid(cr.pid);
  assert(at(cr.start_utc)>=at(stages[2].start_utc)&&at(cr.created_at_utc)>=at(cr.start_utc)&&at(cr.created_at_utc)<=at(cr.end_utc)&&at(cr.end_utc)<=at(stages[2].end_utc),'Configure time order invalid');
  const proof=frozen({plan:structuredClone(plan),spec:structuredClone(spec),synthetic,installation_id:id,install_nonce:nonce,candidate_manifest_sha256:plan.manifest_sha256,execution_id:plan.execution_id,original_raw_root:oldCapture,owner,installed,prepared_manifest_sha256:enrollment.manifest.sha256,observation,observation_ref:ownership.stdout,prepare_process:spec.prepare_process,prepared_snapshot:spec.prepared_snapshot,record:{installation_id:id,start_utc:stages[1].start_utc,steps:[{phase:'prepare',process:spec.prepare_process,after:spec.prepared_snapshot}],memory:{}},closed_at_utc:supervisor.end_utc,closed_writer:{pid:driver.driver_pid,creation_filetime:String(supervisor.creation_filetime),executable:plan.node_path},original_refs:[...refs.values()]});capabilities.add(proof);return proof;
}

// A single continuation of the already consumed claim; no general retry/reset API.
export async function verifyPreparedConfigureContinuation(spec,{proof,plan,synthetic=false,load=safeRead}) {
  assertPreparedResumeProof(proof,plan,synthetic);if(!synthetic)load=safeRead;
  const names=['prior_output_directory','prior_controller_directory','plan','controller','driver','admission','admission_contract','admission_identity','admission_receipt','failure','configure_contract','configure_identity','configure_receipt','claim','retained_temp','preparation_tool'];
  assert(spec&&Object.keys(spec).length===names.length&&names.every(k=>Object.hasOwn(spec,k)),'Incomplete closed configure continuation');
  const t=plan.windows_e2e.installations[proof.installation_id];assert(under(win32.join(plan.isolation_root,'evidence'),spec.prior_output_directory));key(spec.prior_controller_directory);
  const refs=[];
  async function raw(ref,controller=false,claim=false,toolArchive=false){assert(ref&&Object.keys(ref).every(k=>['path','sha256','archive_path'].includes(k))&&/^[a-f0-9]{64}$/.test(ref.sha256),'Missing continuation evidence hash');const path=ref.archive_path??ref.path;
    if(claim)assert.equal(key(path),key(win32.join(plan.isolation_root,'evidence/resume-claims',preparedResumeClaimKey(proof)+'.json')));
    else assert(under(toolArchive?win32.dirname(spec.prior_controller_directory):controller?spec.prior_controller_directory:spec.prior_output_directory,path),'Continuation evidence escapes');
    const b=await load(path);assert(Buffer.isBuffer(b)&&b.length<=32*1024*1024&&sha(b)===ref.sha256,'Continuation evidence changed');refs.push({...ref});return b;}
  const json=async(...a)=>parse(await raw(...a));
  const envelope=await json(spec.plan,true),oldPlan=envelope.api_options?.plan,adjusted=structuredClone(plan);assert(oldPlan&&envelope.api_options.execute===true);adjusted.windows_e2e.preparation_tool=oldPlan.windows_e2e.preparation_tool;assert.deepEqual(oldPlan,adjusted,'Continuation changed candidate/slot/tool contract');
  assert.deepEqual(await json({path:envelope.resume_spec_path,sha256:envelope.resume_spec_sha256},true),proof.spec,'Continuation is not linked to original prepare');assert.equal(key(envelope.api_options.outputDirectory),key(spec.prior_output_directory));
  assert(envelope.tool_bindings?.some(v=>key(v.path)===key(oldPlan.windows_e2e.preparation_tool.path)&&v.sha256===oldPlan.windows_e2e.preparation_tool.sha256),'Original resumed tool binding missing');
  assert(key(spec.preparation_tool.path)===key(oldPlan.windows_e2e.preparation_tool.path)&&spec.preparation_tool.sha256===oldPlan.windows_e2e.preparation_tool.sha256);await raw(spec.preparation_tool,true,false,true);
  const controller=await json(spec.controller,true),driver=await json(spec.driver,true);
  assert(controller.state==='completed'&&controller.exit_code===1&&controller.error_code==null&&controller.pid===driver.driver_pid&&controller.parent_pid===driver.parent_pid,'Continuation producer is not conclusively closed');pid(controller.pid);pid(controller.parent_pid);
  assert(/^\d{17,20}$/.test(String(controller.creation_filetime))&&BigInt(controller.creation_filetime)>=filetime(controller.start_utc)&&BigInt(controller.creation_filetime)<=filetime(controller.end_utc),'Missing closed producer birth');
  assert.deepEqual(controller.command,[plan.node_path,controller.command?.[1],spec.plan.path]);assert(under(spec.prior_controller_directory,controller.command[1]));
  assert(controller.plan_sha256===spec.plan.sha256&&/^[a-f0-9]{64}$/.test(controller.driver_sha256),'Closed command source pins missing');
  const driverSource=await raw({path:controller.command[1],sha256:controller.driver_sha256},true);
  for(const name of ['stdout.log','stderr.log'])await raw({path:win32.join(spec.prior_controller_directory,name),sha256:controller[name+'_sha256']},true);
  assert(driverSource.length&&at(controller.start_utc)<=at(driver.start_utc)&&at(driver.end_utc)<=at(controller.end_utc));
  assert(driver.state==='held_after_failure_or_unknown'&&driver.current_phase==='configure_isolated_prepared'&&driver.installation_id===proof.installation_id&&key(driver.install_root)===key(t.root));
  assert.deepEqual(driver.candidate,{source_commit:plan.source_commit,source_input_digest:plan.source_input_digest,manifest_sha256:plan.manifest_sha256,release_root:plan.release_root});
  assert(driver.producer_status?.held===true&&driver.producer_status.busy===false&&driver.producer_status.completed.length===0&&driver.producer_status.removed.length===0,'Closed producer already performed later actions');
  const phases=driver.phases;assert(Array.isArray(phases)&&[3,4].includes(phases.length));
  if(phases.length===4)assert(phases[0].name==='read_only_current_owner_ports_policy'&&phases[0].state==='completed'&&phases[0].result?.observation?.state_mutations===0,'Unexpected earlier resumed phase');
  const tail=phases.slice(-3);assert.deepEqual(tail.map(p=>[p.name,p.state]),[['construct_and_verify_fixed_candidate','completed'],['resume_prepared_admission','completed'],['configure_isolated_prepared','failed_or_unknown']]);
  for(let i=0;i<phases.length;i++){assert(at(phases[i].start_utc)<=at(phases[i].end_utc));if(i)assert(at(phases[i-1].end_utc)<=at(phases[i].start_utc));}
  const admission=await json(spec.admission),failure=await json(spec.failure),claim=await json(spec.claim,false,true),capturedClaim=await json(admission.claim);
  assert.deepEqual(claim,capturedClaim);assert.deepEqual(admission.original,proof.spec);assert(admission.phase==='resumed_prepared'&&admission.installation_id===proof.installation_id);
  for(const v of [admission,failure,claim])assert(v.synthetic===synthetic&&v.production_qualified===false);
  assert(failure.status==='held'&&typeof failure.original_error==='string'&&failure.original_error&&failure.original_receipt===null);assert.deepEqual(tail[2].error.producer_failure,spec.failure);
  assert(claim.execution_id===plan.execution_id&&claim.installation_id===proof.installation_id&&claim.install_nonce===proof.install_nonce&&claim.candidate_manifest_sha256===plan.manifest_sha256&&claim.original_evidence_sha256===sha(Buffer.from(JSON.stringify(proof.spec)))&&/^[a-f0-9-]{36}$/i.test(claim.resume_id)&&key(claim.claim_path)===key(spec.claim.path)&&at(claim.claimed_at_utc)>=at(proof.closed_at_utc));
  const a=admission.admission;assert(a.operation==='inspect-prepared'&&a.prepared===true&&a.unconfigured===true&&a.writer_absent===true&&a.execution_id===plan.execution_id&&a.owner_sid===t.owner_sid&&a.install_nonce===proof.install_nonce&&a.candidate_manifest_sha256===plan.manifest_sha256&&key(a.install_root)===key(t.root)&&a.production_qualified===false);
  assert(at(a.observed_at_utc)>=at(tail[1].start_utc)&&at(a.observed_at_utc)<=at(tail[1].end_utc));
  for(const [ref,name] of [[spec.admission_contract,'contract'],[spec.admission_identity,'identity'],[spec.admission_receipt,'receipt']])assert.equal(key(ref.path),key(win32.join(spec.prior_output_directory,'preparation',name+'-1.json')),'Wrong resumed admission source');
  const ac=await json(spec.admission_contract),ai=await json(spec.admission_identity),ar=await json(spec.admission_receipt);
  assert(ac.operation==='inspect-prepared'&&ac.execution_id===plan.execution_id&&ac.install_nonce===proof.install_nonce&&ac.owner_sid===t.owner_sid&&key(ac.install_root)===key(t.root)&&ac.prepared_manifest_sha256===proof.prepared_manifest_sha256&&ac.candidate_manifest_sha256===plan.manifest_sha256);assert.deepEqual(ac.closed_writer,proof.closed_writer);
  assert(ar.operation==='inspect-prepared'&&ar.exit_code===0&&ar.pending===false&&ar.error_code==null&&ar.parent_pid===driver.driver_pid&&ai.pid===ar.pid&&ai.created_at_utc===ar.created_at_utc&&key(ai.executable)===key(plan.windows_e2e.powershell.path));pid(ar.pid);assert(at(ar.start_utc)>=at(tail[1].start_utc)&&at(ar.created_at_utc)>=at(ar.start_utc)&&at(a.observed_at_utc)>=at(ar.created_at_utc)&&at(a.observed_at_utc)<=at(ar.end_utc)&&at(ar.end_utc)<=at(tail[1].end_utc));
  const c=await json(spec.configure_contract),i=await json(spec.configure_identity),r=await json(spec.configure_receipt);
  assert(key(spec.configure_contract.path)===key(win32.join(spec.prior_output_directory,'preparation/contract-2.json'))&&key(spec.configure_identity.path)===key(win32.join(spec.prior_output_directory,'preparation/identity-2.json'))&&key(spec.configure_receipt.path)===key(win32.join(spec.prior_output_directory,'preparation/receipt-2.json')),'Wrong resumed configure sequence');
  assert(c.operation==='configure'&&c.execution_id===plan.execution_id&&c.install_nonce===proof.install_nonce&&c.owner_sid===t.owner_sid&&key(c.install_root)===key(t.root)&&key(c.workspace_root)===key(t.workspace_root)&&key(c.project_registry)===key(t.project_registry)&&c.candidate_manifest_sha256===plan.manifest_sha256&&c.prepared_manifest_sha256===proof.prepared_manifest_sha256&&c.expected_config_sha256===a.config_sha256);
  assert(r.operation==='configure'&&Number.isSafeInteger(r.exit_code)&&r.exit_code!==0&&r.pending===false&&r.error_code==null&&r.parent_pid===driver.driver_pid&&i.pid===r.pid&&i.created_at_utc===r.created_at_utc&&key(i.executable)===key(plan.windows_e2e.powershell.path));pid(r.pid);
  assert(at(r.start_utc)>=at(tail[2].start_utc)&&at(r.created_at_utc)>=at(r.start_utc)&&at(r.created_at_utc)<=at(r.end_utc)&&at(r.end_utc)<=at(tail[2].end_utc));
  const d=spec.retained_temp;assert(d&&Object.keys(d).length===4&&Object.keys(d).every(k=>['path','bytes','sha256','config_sha256'].includes(k))&&key(win32.dirname(d.path))===key(win32.join(t.root,'config'))&&/^evidence-config-[a-f0-9]{32}\.tmp$/.test(win32.basename(d.path))&&Number.isSafeInteger(d.bytes)&&d.bytes>0&&d.bytes<=1048576&&/^[a-f0-9]{64}$/.test(d.sha256)&&/^[a-f0-9]{64}$/.test(d.config_sha256)&&d.config_sha256===a.config_sha256,'Invalid retained source binding');
  const continuation=frozen({spec:structuredClone(spec),claim,claim_ref:spec.claim,closed_at_utc:controller.end_utc,ordinal:2,ordinal_path:spec.claim.path+'.configure-2.json',retained_temp:d,failed_receipt:spec.configure_receipt,closed_writer:{pid:controller.pid,creation_filetime:String(controller.creation_filetime),executable:plan.node_path}});
  const result=frozen({...proof,original_refs:[...proof.original_refs,...refs],closed_at_utc:controller.end_utc,closed_writer:continuation.closed_writer,continuation});capabilities.add(result);return result;
}

export function assertConfigureContinuationOrdinal(value,proof){
  const c=proof.continuation;assert(c&&value&&Object.keys(value).length===11&&value.schema_version===1&&value.ordinal===2&&value.execution_id===proof.execution_id&&value.installation_id===proof.installation_id&&value.install_nonce===proof.install_nonce&&value.candidate_manifest_sha256===proof.candidate_manifest_sha256&&value.claim_sha256===c.claim_ref.sha256&&value.closed_evidence_sha256===sha(Buffer.from(JSON.stringify(c.spec)))&&value.production_qualified===false&&value.synthetic===proof.synthetic&&at(value.claimed_at_utc)>=at(c.closed_at_utc),'Invalid configure continuation ordinal');return value;
}
