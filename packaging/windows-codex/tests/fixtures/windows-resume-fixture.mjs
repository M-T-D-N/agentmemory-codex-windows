import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture} from './windows-production-fixture.mjs';
import {hash} from '../../verification/distribution-qualification.mjs';
import {createSyntheticWindowsProducerHarness,createSyntheticWindowsPreparedResumeHarness} from '../../verification/windows-evidence-production.mjs';
import {windowsPreparationToolPath} from '../../verification/windows-execution-preparation.mjs';
const clone=structuredClone;
export const birth=s=>(BigInt(Date.parse(s))*10000n+116444736000000000n).toString();
export async function closedFixture(root){
  const f=fixture(root,{isolationRoot:root}),plan=f.options.plan;plan.windows_e2e.installations={a:plan.windows_e2e.installations.a};
  const t=plan.windows_e2e.installations.a;Object.assign(t,{workspace_root:join(root,'workspace'),project_registry:join(root,'workspace','registry.json'),requirements_path:join(root,'workspace','managed-requirements.toml')});
  plan.windows_e2e.preparation_tool={path:windowsPreparationToolPath,sha256:hash(Buffer.from('old preparation tool'))};f.files.set(windowsPreparationToolPath,Buffer.from('old preparation tool'));
  f.options.outputDirectory=join(root,'evidence','attempt-original');
  const oldPlan=clone(plan),controllerRoot=join(root,'closed-controller');await mkdir(controllerRoot);
  const fakeRun=f.effects.run;f.effects.run=async o=>{const r=await fakeRun(o);if(o.identityPath&&r.identityBytes)await writeFile(o.identityPath,r.identityBytes);return r;};
  let configurationFailure=false;let old=true,admission='valid',prepPid=8000;
  const preparationCalls=[];
  const prep={read:async path=>{assert(f.files.has(path));return Buffer.from(f.files.get(path));},support:async()=>({created:true}),
    run:async o=>{preparationCalls.push(o.operation);const start=f.effects.now(),created=f.effects.now(),pid=++prepPid;
      await writeFile(o.identityPath,JSON.stringify({pid,created_at_utc:created,executable:oldPlan.windows_e2e.powershell.path}));
      const receipt={operation:o.operation,pid,parent_pid:999,start_utc:start,created_at_utc:created,end_utc:f.effects.now(),exit_code:old||configurationFailure?1:0,pending:false,error_code:null};
      let value;
      if(o.operation==='inspect-prepared')value={operation:o.operation,prepared:admission!=='activated',unconfigured:admission!=='partial',writer_absent:admission!=='writer',install_root:t.root,install_nonce:'a'.repeat(32),candidate_manifest_sha256:oldPlan.manifest_sha256,config_sha256:'c'.repeat(64),execution_id:oldPlan.execution_id,owner_sid:t.owner_sid,observed_at_utc:created,production_qualified:false};
      else if(['configure','configure-retained'].includes(o.operation)){f.states.get('a').closed=!old;value={configured:true,install_root:t.root,install_nonce:'a'.repeat(32),candidate_manifest_sha256:oldPlan.manifest_sha256,config_sha256:'d'.repeat(64)};}
      else value='B'.repeat(43)+'=';
      return {receipt,bytes:Buffer.from(old||configurationFailure?'failed':typeof value==='string'?value:JSON.stringify(value))};}
  };f.effects.preparation=prep;
  const start=f.effects.now(),constructStart=f.effects.now(),constructEnd=f.effects.now(),prepStart=f.effects.now();
  const original=await createSyntheticWindowsProducerHarness(f.options,f.effects);await original.prepareFresh({installationId:'a'});const prepEnd=f.effects.now(),configStart=f.effects.now();
  let failed;try{await original.configurePrepared({installationId:'a'});}catch(e){failed=e;}assert(failed?.producer_failure);const configEnd=f.effects.now(),end=f.effects.now();
  const oldRoot=f.options.outputDirectory,capture=join(oldRoot,'captures'),objects=[];
  for(const n of await readdir(capture)){try{objects.push({path:join(capture,n),value:JSON.parse(await readFile(join(capture,n),'utf8'))});}catch{}}
  const find=predicate=>{const q=objects.filter(x=>predicate(x.value));assert.equal(q.length,1);return q[0].path;};
  const ref=async path=>({path,sha256:hash(await readFile(path))});
  const prepareProcess=find(x=>x.scenario==='fresh_install'&&x.phase==='prepare'&&x.command);
  const process=JSON.parse(await readFile(prepareProcess));process.creation_filetime=birth(process.created_at_utc);await writeFile(prepareProcess,JSON.stringify(process));const identityPath=process.command.at(-1),identity=JSON.parse(await readFile(identityPath));identity.creation_filetime=process.creation_filetime;await writeFile(identityPath,JSON.stringify(identity));
  const originalPlan={api_options:{execute:true,plan:oldPlan},tool_bindings:[oldPlan.windows_e2e.ownership_tool]},originalPlanPath=join(controllerRoot,'PLAN.original-approved.json');await writeFile(originalPlanPath,JSON.stringify(originalPlan));
  const driver={state:'held_after_failure_or_unknown',driver_pid:999,parent_pid:333,start_utc:start,end_utc:end,candidate:{source_commit:plan.source_commit,source_input_digest:plan.source_input_digest,manifest_sha256:plan.manifest_sha256,release_root:plan.release_root},installation_id:'a',install_root:t.root,current_phase:'configure_isolated_prepared',producer_status:{held:true,busy:false,completed:[],removed:[]},phases:[{name:'construct_and_verify_fixed_candidate',state:'completed',start_utc:constructStart,end_utc:constructEnd},{name:'prepare_fresh',state:'completed',start_utc:prepStart,end_utc:prepEnd},{name:'configure_isolated_prepared',state:'failed_or_unknown',start_utc:configStart,end_utc:configEnd,error:{producer_failure:failed.producer_failure}}]};
  const controller={state:'held_after_failure_or_unknown',product_security_actions_started:true,commands:[{label:'01-producer',pid:999,parent_pid:333,state:'completed',exit_code:1,creation_filetime:birth(start),start_utc:start,end_utc:end,command:[plan.node_path,join(controllerRoot,'driver.mjs'),originalPlanPath]}]};
  const driverPath=join(controllerRoot,'driver.execution.json'),controllerPath=join(controllerRoot,'process.execution02.json');await writeFile(driverPath,JSON.stringify(driver));await writeFile(controllerPath,JSON.stringify(controller));
  const toolCopies=[];for(const n of await readdir(capture)){const path=join(capture,n);if(hash(await readFile(path))===oldPlan.windows_e2e.ownership_tool.sha256)toolCopies.push(path);}assert(toolCopies.length);
  const inspect=JSON.parse(await readFile(find(x=>x.operation==='inspect'&&x.command)));inspect.creation_filetime=birth(inspect.created_at_utc);await writeFile(find(x=>x.operation==='inspect'&&x.command),JSON.stringify(inspect));
  const spec={ownership_tool:{path:oldPlan.windows_e2e.ownership_tool.path,sha256:oldPlan.windows_e2e.ownership_tool.sha256,archive_path:toolCopies.at(-1)},installation_id:'a',prior_output_directory:oldRoot,prior_controller_directory:controllerRoot,original_plan:await ref(originalPlanPath),controller:await ref(controllerPath),driver:await ref(driverPath),prepared:await ref(join(oldRoot,'producer-1.json')),failure:failed.producer_failure,prepare_process:await ref(prepareProcess),prepared_snapshot:await ref(find(x=>x.observed_at_utc&&x.manifest&&!x.install_nonce&&!x.runtime)),prepared_ownership_process:await ref(find(x=>x.operation==='inspect'&&x.command)),configure_contract:await ref(join(oldRoot,'preparation/contract-1.json')),configure_identity:await ref(join(oldRoot,'preparation/identity-1.json')),configure_receipt:await ref(join(oldRoot,'preparation/receipt-1.json'))};
  old=false;f.options.plan=clone(oldPlan);f.options.plan.windows_e2e.preparation_tool.sha256=hash(Buffer.from('new preparation tool'));f.files.set(windowsPreparationToolPath,Buffer.from('new preparation tool'));f.options.outputDirectory=join(root,'evidence','attempt-new');
  // The original current fixture uses an evidence-specific fake source; no real fallback.
  const fakeRead=f.effects.read;f.effects.read=async path=>{if(path.startsWith(root)&&!f.files.has(path)&&!path.startsWith(t.root))return readFile(path);return fakeRead(path);};
  const rewrite=async(ref,change)=>{const v=JSON.parse(await readFile(ref.path));change(v);await writeFile(ref.path,JSON.stringify(v));ref.sha256=hash(await readFile(ref.path));};
  return {f,spec,prep,preparationCalls,oldRoot,driver,original,ref,rewrite,setAdmission:x=>{admission=x;},setConfigureFailure:x=>{configurationFailure=x;},make:()=>createSyntheticWindowsPreparedResumeHarness(f.options,spec,f.effects)};
}

export async function closedConfigureFixture(root){
 const x=await closedFixture(root),{f}=x,plan=clone(f.options.plan),controllerRoot=join(root,'closed-resumed-controller');await mkdir(controllerRoot);
 const start=f.effects.now(),constructStart=f.effects.now(),constructEnd=f.effects.now(),admitStart=f.effects.now(),p=await x.make();await p.resumePrepared();const admitEnd=f.effects.now(),configureStart=f.effects.now();x.setConfigureFailure(true);
 let error;try{await p.configurePrepared({installationId:'a'});}catch(e){error=e;}assert(error?.producer_failure);const configureEnd=f.effects.now(),end=f.effects.now();
 const prior=f.options.outputDirectory,ref=x.ref,claimCapture=JSON.parse(await readFile(join(prior,'producer-1.json'))).claim,claim=JSON.parse(await readFile(claimCapture.path));
 const envelopePath=join(controllerRoot,'PLAN.json'),specPath=join(controllerRoot,'original.json'),driverPath=join(controllerRoot,'driver.execution.json'),sourcePath=join(controllerRoot,'driver.mjs');
 await writeFile(specPath,JSON.stringify(x.spec));await writeFile(sourcePath,'// inert synthetic driver source, never executed');
 await writeFile(envelopePath,JSON.stringify({api_options:{execute:true,plan,outputDirectory:prior},resume_spec_path:specPath,resume_spec_sha256:hash(await readFile(specPath)),tool_bindings:[plan.windows_e2e.preparation_tool]}));
 const driver={state:'held_after_failure_or_unknown',driver_pid:999,parent_pid:333,start_utc:start,end_utc:end,candidate:{source_commit:plan.source_commit,source_input_digest:plan.source_input_digest,manifest_sha256:plan.manifest_sha256,release_root:plan.release_root},installation_id:'a',install_root:plan.windows_e2e.installations.a.root,current_phase:'configure_isolated_prepared',producer_status:{held:true,busy:false,completed:[],removed:[]},phases:[{name:'construct_and_verify_fixed_candidate',state:'completed',start_utc:constructStart,end_utc:constructEnd},{name:'resume_prepared_admission',state:'completed',start_utc:admitStart,end_utc:admitEnd},{name:'configure_isolated_prepared',state:'failed_or_unknown',start_utc:configureStart,end_utc:configureEnd,error:{producer_failure:error.producer_failure}}]};await writeFile(driverPath,JSON.stringify(driver));
 const toolPath=join(controllerRoot,'old-preparation.ps1');await writeFile(toolPath,f.files.get(windowsPreparationToolPath));
 for(const name of ['stdout.log','stderr.log'])await writeFile(join(controllerRoot,name),'');
 const controller={command:[plan.node_path,sourcePath,envelopePath],state:'completed',pid:999,parent_pid:333,start_utc:start,end_utc:end,creation_filetime:birth(start),exit_code:1,plan_sha256:hash(await readFile(envelopePath)),driver_sha256:hash(await readFile(sourcePath)),'stdout.log_sha256':hash(Buffer.alloc(0)),'stderr.log_sha256':hash(Buffer.alloc(0))};const controllerPath=join(controllerRoot,'execution.json');await writeFile(controllerPath,JSON.stringify(controller));
 const spec={prior_output_directory:prior,prior_controller_directory:controllerRoot,plan:await ref(envelopePath),controller:await ref(controllerPath),driver:await ref(driverPath),admission:await ref(join(prior,'producer-1.json')),admission_contract:await ref(join(prior,'preparation/contract-1.json')),admission_identity:await ref(join(prior,'preparation/identity-1.json')),admission_receipt:await ref(join(prior,'preparation/receipt-1.json')),failure:error.producer_failure,configure_contract:await ref(join(prior,'preparation/contract-2.json')),configure_identity:await ref(join(prior,'preparation/identity-2.json')),configure_receipt:await ref(join(prior,'preparation/receipt-2.json')),claim:await ref(claim.claim_path),retained_temp:{path:join(plan.windows_e2e.installations.a.root,'config','evidence-config-'+('a'.repeat(32))+'.tmp'),bytes:27,sha256:hash(Buffer.from('retained synthetic bytes')),config_sha256:'c'.repeat(64)},preparation_tool:{path:windowsPreparationToolPath,sha256:plan.windows_e2e.preparation_tool.sha256,archive_path:toolPath}};
 x.setConfigureFailure(false);f.options.plan=clone(plan);f.options.plan.windows_e2e.preparation_tool.sha256=hash(Buffer.from('continuation tool'));f.files.set(windowsPreparationToolPath,Buffer.from('continuation tool'));f.options.outputDirectory=join(root,'evidence','attempt-continuation');
 const {createSyntheticWindowsPreparedConfigureContinuationHarness}=await import('../../verification/windows-evidence-production.mjs');
 return {...x,continuation:spec,prior,makeContinuation:()=>createSyntheticWindowsPreparedConfigureContinuationHarness(f.options,x.spec,spec,f.effects)};
}
