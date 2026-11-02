import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {join,win32} from 'node:path';
import {closedConfigureFixture,birth} from './fixtures/windows-resume-fixture.mjs';
import {hash} from '../verification/distribution-qualification.mjs';
import {createSyntheticWindowsActiveTimeoutHarness,createSyntheticWindowsActiveAdmissionContinuationHarness} from '../verification/windows-evidence-production.mjs';

async function scoped(fn){assert.equal(process.env.AGENTMEMORY_INTEGRATION,'0');assert.equal(process.env.AGENTMEMORY_CURATE,'0');const root=await mkdtemp(join(process.env.AGENTMEMORY_SYNTHETIC_TEST_ROOT,'active-timeout-'));try{await fn(root);}finally{await rm(root,{recursive:true,force:true});}}
async function activeFixture(root){
 const x=await closedConfigureFixture(root),{f}=x,plan=structuredClone(f.options.plan),t=plan.windows_e2e.installations.a,oldRoot=f.options.outputDirectory,controllerRoot=join(root,'closed-timeout-controller');await mkdir(controllerRoot);
 const configHash=x.continuation.retained_temp.sha256,prepRun=f.effects.preparation.run;let admissionFault=null;
 f.effects.preparation.run=async o=>{
  if(o.operation==='inspect-active'){
   x.preparationCalls.push(o.operation);const start=f.effects.now(),created=f.effects.now(),end=f.effects.now();const value={operation:o.operation,active:true,execution_id:plan.execution_id,install_root:t.root,owner_sid:t.owner_sid,install_nonce:'a'.repeat(32),candidate_manifest_sha256:plan.manifest_sha256,config_sha256:configHash,closed_writers:o.contract.closed_writers.map(w=>({pid:w.pid,creation_filetime:w.creation_filetime,state:'absent'})),observed_at_utc:created,production_qualified:false};if(admissionFault)admissionFault(value);
   return {bytes:Buffer.from(JSON.stringify(value)),receipt:{operation:o.operation,pid:8888,parent_pid:999,start_utc:start,created_at_utc:created,end_utc:end,exit_code:0,pending:false,error_code:null}};
  }
  const r=await prepRun(o);if(o.operation==='configure-retained'){const v=JSON.parse(r.bytes);v.config_sha256=configHash;r.bytes=Buffer.from(JSON.stringify(v));}return r;
 };
 const run=f.effects.run;f.effects.run=async o=>{const r=await run(o);if(o.phase==='activate'){const identity=JSON.parse(r.identityBytes);identity.creation_filetime=birth(identity.created_at_utc);r.identityBytes=Buffer.from(JSON.stringify(identity));await writeFile(o.identityPath,r.identityBytes);Object.assign(r,{exit_code:null,error_code:'TIMEOUT',pending:true,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)});}return r;};
 const start=f.effects.now(),preStart=f.effects.now(),preEnd=f.effects.now(),constructStart=f.effects.now(),p=await x.makeContinuation(),constructEnd=f.effects.now(),admitStart=f.effects.now();await p.resumePrepared();const admitEnd=f.effects.now(),configStart=f.effects.now();await p.configurePrepared({installationId:'a'});const configEnd=f.effects.now(),activateStart=f.effects.now();let error;try{const s=f.spec('fresh_install','a');delete s.authorization;await p.runScenario(s);}catch(e){error=e;}assert(error?.receipt&&p.status().held);const activateEnd=f.effects.now(),end=f.effects.now();
 const planPath=join(controllerRoot,'PLAN.json'),sourcePath=join(controllerRoot,'driver.mjs'),driverPath=join(controllerRoot,'driver.execution.json'),controllerPath=join(controllerRoot,'execution.json');await writeFile(sourcePath,'// synthetic driver never executed');await writeFile(planPath,JSON.stringify({api_options:{execute:true,plan,outputDirectory:oldRoot}}));
 const driver={state:'held_after_failure_or_unknown',driver_pid:999,parent_pid:333,start_utc:start,end_utc:end,candidate:{source_commit:plan.source_commit,source_input_digest:plan.source_input_digest,manifest_sha256:plan.manifest_sha256,release_root:plan.release_root},installation_id:'a',install_root:t.root,current_phase:'fresh_install',producer_status:p.status(),phases:[{name:'read_only_current_owner_ports_policy',state:'completed',start_utc:preStart,end_utc:preEnd},{name:'construct_and_verify_fixed_candidate',state:'completed',start_utc:constructStart,end_utc:constructEnd},{name:'resume_prepared_admission',state:'completed',start_utc:admitStart,end_utc:admitEnd},{name:'configure_isolated_prepared',state:'completed',start_utc:configStart,end_utc:configEnd,result:{config_sha256:configHash}},{name:'fresh_install',state:'failed_or_unknown',start_utc:activateStart,end_utc:activateEnd,error:{receipt:error.receipt,producer_failure:error.producer_failure}}]};await writeFile(driverPath,JSON.stringify(driver));
 for(const n of ['stdout.log','stderr.log'])await writeFile(join(controllerRoot,n),'');
 const controller={command:[plan.node_path,sourcePath,planPath,'--execute-reviewed'],state:'completed',pid:999,parent_pid:333,creation_filetime:birth(start),start_utc:start,end_utc:f.effects.now(),exit_code:1,plan_sha256:hash(await readFile(planPath)),driver_sha256:hash(await readFile(sourcePath)),'stdout.log_sha256':hash(Buffer.alloc(0)),'stderr.log_sha256':hash(Buffer.alloc(0))};await writeFile(controllerPath,JSON.stringify(controller));
 const timeout=JSON.parse(await readFile(error.receipt.path)),ref=x.ref,anchorPath=join(controllerRoot,'active-anchor.json'),state=f.states.get('a'),observed=f.effects.now();
 const anchor={supported_readonly_projection:{observed_at_utc:observed,current_owner_sid:t.owner_sid,manifest:{...state.installed,status:'active'},runtime:state.runtime},live_owned_role_observations:['daemon','worker','engine'].map(role=>{const r=state.runtime[role];return {role,pid:r.pid,parent_pid:r.parent_pid,state:'present',recorded_creation:r.creation_date,process_start_utc:r.creation_date,process_creation_filetime:birth(r.creation_date),executable_path:r.executable_path,command_sha256:hash(Buffer.from(r.command_line)),command_contains_exact_slot:true,observed_at_utc:f.effects.now()};})};await writeFile(anchorPath,JSON.stringify(anchor));
 const active={prior_output_directory:oldRoot,prior_controller_directory:controllerRoot,plan:await ref(planPath),controller:await ref(controllerPath),driver:await ref(driverPath),claim:x.continuation.claim,ordinal:await ref(x.continuation.claim.path+'.configure-2.json'),configured:await ref(join(oldRoot,'producer-2.json')),configure_contract:await ref(join(oldRoot,'preparation/contract-2.json')),configure_identity:await ref(join(oldRoot,'preparation/identity-2.json')),configure_receipt:await ref(join(oldRoot,'preparation/receipt-2.json')),timeout:error.receipt,activation_identity:await ref(timeout.command.at(-1)),failure:error.producer_failure,active_anchor:await ref(anchorPath)};
 f.options.outputDirectory=join(root,'evidence','attempt-active-admission');
 return {...x,active,oldProducer:p,setActiveFault:fault=>{admissionFault=fault;},makeActive:()=>createSyntheticWindowsActiveTimeoutHarness(f.options,x.spec,x.continuation,active,f.effects)};
}

test('same active slot is admitted without reactivation; new runtime restart never qualifies fresh',()=>scoped(async root=>{
 const x=await activeFixture(root),before=await readFile(x.active.timeout.path),claim=await readFile(x.active.claim.path),ordinal=await readFile(x.active.ordinal.path),activateCount=x.f.calls.filter(c=>c.phase==='activate').length;
 const p=await x.makeActive();assert.equal(p.prepareFresh,undefined);assert.equal(p.runScenario,undefined);assert.equal(p.assemble,undefined);assert.equal(p.verifyPartial,undefined);await p.admitActiveAfterTimeout();
 const spec=x.f.spec('restart','a');delete spec.authorization;const result=await p.runRuntimeRestart(spec);assert.equal(result.acceptance,'owned_runtime_restart_after_timeout');assert.equal(result.production_qualified,false);assert.equal(result.original_activation_exit,'unknown');assert.equal(result.record.success,true);
 assert.equal(x.f.calls.filter(c=>c.phase==='activate').length,activateCount);assert.deepEqual(await readFile(x.active.timeout.path),before);assert.deepEqual(await readFile(x.active.claim.path),claim);assert.deepEqual(await readFile(x.active.ordinal.path),ordinal);assert(x.oldProducer.status().held);
 await p.cleanup({installationId:'a',removeRoot:true});assert.deepEqual(p.status().removed,['a']);
}));
test('malformed or changed active history is refused before new effects',async t=>{
 for(const mode of ['hash','timeout-to-success','pending-driver','different-slot','different-nonce','ordinal','missing-config','config-hash','old-anchor','different-birth','wrong-command','synthetic-promotion'])await t.test(mode,()=>scoped(async root=>{
  const x=await activeFixture(root),n=x.f.calls.length,m=x.preparationCalls.length;
  if(mode==='hash')await writeFile(x.active.timeout.path,'modified');
  if(mode==='timeout-to-success')await x.rewrite(x.active.timeout,v=>{v.exit_code=0;v.pending=false;});
  if(mode==='pending-driver')await x.rewrite(x.active.controller,v=>{v.state='pending';});
  if(mode==='different-slot')x.f.options.plan.windows_e2e.installations.a.root=join(root,'foreign');
  if(mode==='different-nonce')await x.rewrite(x.active.configure_contract,v=>{v.install_nonce='f'.repeat(32);});
  if(mode==='ordinal')await x.rewrite(x.active.ordinal,v=>{v.ordinal=3;});
  if(mode==='missing-config')delete x.active.configured;
  if(mode==='config-hash')await x.rewrite(x.active.configured,v=>{v.config_sha256='f'.repeat(64);});
  if(mode==='old-anchor')await x.rewrite(x.active.active_anchor,v=>{v.supported_readonly_projection.observed_at_utc='2025-01-01T00:00:00Z';});
  if(mode==='different-birth')await x.rewrite(x.active.active_anchor,v=>{v.live_owned_role_observations[0].process_creation_filetime='134377326109647806';});
  if(mode==='wrong-command')await x.rewrite(x.active.timeout,v=>{v.command=['powershell.exe','exit 0'];});
  if(mode==='synthetic-promotion')x.f.options.plan.synthetic=false;
  await assert.rejects(x.makeActive());assert.equal(x.f.calls.length,n);assert.equal(x.preparationCalls.length,m);
 }));
});
test('current ownership/admission mismatch holds before API or restart',async t=>{
 for(const mode of ['writer-live','config','nonce','runtime-pid','runtime-command','task','stale'])await t.test(mode,()=>scoped(async root=>{
  const x=await activeFixture(root);if(mode==='writer-live')x.setActiveFault(v=>{v.closed_writers[1].state='present';});if(mode==='config')x.setActiveFault(v=>{v.config_sha256='f'.repeat(64);});if(mode==='nonce')x.setActiveFault(v=>{v.install_nonce='f'.repeat(32);});if(mode==='stale')x.setActiveFault(v=>{v.observed_at_utc='2025-01-01T00:00:00Z';});
  if(mode==='runtime-pid')x.f.states.get('a').runtime.worker.pid++;if(mode==='runtime-command')x.f.states.get('a').runtime.worker.command_line='foreign';if(mode==='task')x.f.setOwnershipFault(v=>{v.tasks[0].actual_action.arguments='other';});
  const p=await x.makeActive(),n=x.f.calls.filter(c=>c.phase==='activate').length;await assert.rejects(p.admitActiveAfterTimeout());assert(p.status().held);const count=x.f.calls.length;await assert.rejects(p.runRuntimeRestart({installationId:'a'}));assert.equal(x.f.calls.length,count);assert.equal(x.f.calls.filter(c=>c.phase==='activate').length,n);assert.equal(x.f.calls.filter(c=>c.api).length,0);
 }));
});
test('unique active handoff claim prevents competing continuation without resetting old claim',()=>scoped(async root=>{
 const x=await activeFixture(root),a=await x.makeActive();x.f.options.outputDirectory=join(root,'evidence','competing-active');const b=await x.makeActive();await a.admitActiveAfterTimeout();const n=x.f.calls.length;await assert.rejects(b.admitActiveAfterTimeout(),/EEXIST/);assert(b.status().held);assert.equal(x.f.calls.length,n);await assert.rejects(a.admitActiveAfterTimeout());assert(a.status().held);assert(x.oldProducer.status().held);
}));

test('changed original timeout or consumed handoff claim holds after admission',async t=>{
 for(const mode of ['original','claim'])await t.test(mode,()=>scoped(async root=>{
  const x=await activeFixture(root),p=await x.makeActive();await p.admitActiveAfterTimeout();const n=x.f.calls.length;
  await writeFile(mode==='original'?x.active.timeout.path:x.active.claim.path+'.active-after-timeout.json','changed');
  const spec=x.f.spec('restart','a');delete spec.authorization;await assert.rejects(p.runRuntimeRestart(spec));assert(p.status().held);assert.equal(x.f.calls.length,n);
 }));
});


async function closedAdmissionFixture(root){
 const x=await activeFixture(root),{f}=x,oldPlan=structuredClone(f.options.plan),prior=f.options.outputDirectory,controllerRoot=join(root,'closed-active-controller');await mkdir(controllerRoot);
 let failInspect=true,terminalPath;const priorRun=f.effects.run;
 f.effects.run=async o=>{const r=await priorRun(o);if(failInspect&&o.operation==='inspect'){
  const identity=JSON.parse(r.identityBytes);identity.creation_filetime=birth(identity.created_at_utc);r.identityBytes=Buffer.from(JSON.stringify(identity));await writeFile(o.identityPath,r.identityBytes);
  const stdout=join(o.outputDirectory,'terminal-closed.stdout.bin'),stderr=join(o.outputDirectory,'terminal-closed.stderr.bin');terminalPath=join(o.outputDirectory,'terminal-closed.json');await writeFile(stdout,'');await writeFile(stderr,'');
  const exit=f.effects.now(),close=f.effects.now();const terminal={evidence_kind:'owned_child_terminal',pid:r.pid,parent_pid:999,creation_filetime:identity.creation_filetime,identity_sha256:hash(r.identityBytes),primary_reason:'CLOSE',spawn_error:null,identity_error:null,automatic_resume:false,command:o.command,command_sha256:hash(Buffer.from(JSON.stringify(o.command))),launched_at_utc:r.launched_at_utc,exit:{exit_code:1,signal:null,observed_at_utc:exit},close:{exit_code:1,signal:null,observed_at_utc:close},late_stdout:{path:stdout,sha256:hash(Buffer.alloc(0)),bytes:0},late_stderr:{path:stderr,sha256:hash(Buffer.alloc(0)),bytes:0},late_output_truncated:false};await writeFile(terminalPath,JSON.stringify(terminal));
  Object.assign(r,{exit_code:1,pending:false,stdout:Buffer.alloc(0),stderr:Buffer.from('Managed process argv differs.'),end_utc:close,terminal_evidence:{receipt:terminalPath,stdout,stderr}});
 }return r;};
 const start=f.effects.now(),started=f.effects.now(),p=await x.makeActive();let error;try{await p.admitActiveAfterTimeout();}catch(e){error=e;}assert(error?.receipt&&p.status().held);const end=f.effects.now();
 const ref=x.ref,planPath=join(controllerRoot,'PLAN.json'),driverPath=join(controllerRoot,'driver.mjs'),controllerPath=join(controllerRoot,'controller.execution.json'),startedPath=join(controllerRoot,'execution.started'),finalPath=join(controllerRoot,'execution.final.json');await writeFile(driverPath,'// forced synthetic driver, never executed');await writeFile(planPath,JSON.stringify({api_options:{execute:true,plan:oldPlan,outputDirectory:prior},tool_bindings:[oldPlan.windows_e2e.ownership_tool]}));
 const startedRecord={pid:999,parent_pid:333,started_at_utc:started,plan_sha256:hash(await readFile(planPath)),original_activation_exit:'unknown'};await writeFile(startedPath,JSON.stringify(startedRecord));
 const final={state:'held',phase:'admit_active',original_activation_exit:'unknown',production_qualified:false,status:p.status(),ended_at_utc:end,error:{receipt:error.receipt}};await writeFile(finalPath,JSON.stringify(final));for(const n of ['active.stdout.log','active.stderr.log'])await writeFile(join(controllerRoot,n),'');
 const controller={state:'completed',exit_code:1,pid:999,parent_pid:333,creation_filetime:birth(start),start_utc:start,end_utc:f.effects.now(),command:[oldPlan.node_path,driverPath,planPath,'--execute-reviewed'],plan_sha256:hash(await readFile(planPath)),driver_sha256:hash(await readFile(driverPath)),'active.stdout.log_sha256':hash(Buffer.alloc(0)),'active.stderr.log_sha256':hash(Buffer.alloc(0))};await writeFile(controllerPath,JSON.stringify(controller));
 const capture=join(prior,'captures'),objects=[];for(const n of await readdir(capture)){try{objects.push({path:join(capture,n),value:JSON.parse(await readFile(join(capture,n),'utf8'))});}catch{}}
 const find=fn=>{const q=objects.filter(x=>fn(x.value));assert.equal(q.length,1);return q[0].path;};const inspect=JSON.parse(await readFile(error.receipt.path));const oldToolCopies=[];for(const n of await readdir(capture)){const path=join(capture,n);if(hash(await readFile(path))===oldPlan.windows_e2e.ownership_tool.sha256)oldToolCopies.push(path);}assert.equal(oldToolCopies.length,1);
 const closed={prior_output_directory:prior,prior_controller_directory:controllerRoot,plan:await ref(planPath),controller:await ref(controllerPath),driver_started:await ref(startedPath),driver_final:await ref(finalPath),failure:error.producer_failure,active_claim:await ref(x.active.claim.path+'.active-after-timeout.json'),adoption:await ref(find(v=>v.phase==='active_after_timeout')),inspect_failure:error.receipt,inspect_contract:await ref(find(v=>v.candidate_hashes&&v.raw_root)),inspect_identity:await ref(inspect.command.at(-1)),inspect_terminal:await ref(terminalPath),ownership_tool:{path:oldPlan.windows_e2e.ownership_tool.path,sha256:oldPlan.windows_e2e.ownership_tool.sha256,archive_path:oldToolCopies[0]}};
 failInspect=false;f.options.plan=structuredClone(oldPlan);f.options.plan.windows_e2e.ownership_tool.sha256=hash(Buffer.from('new ownership case-fix tool'));f.files.set(oldPlan.windows_e2e.ownership_tool.path,Buffer.from('new ownership case-fix tool'));f.options.outputDirectory=join(root,'evidence','attempt-fixed-admission');
 return {...x,closed,failedAdmission:p,makeFixed:()=>createSyntheticWindowsActiveAdmissionContinuationHarness(f.options,x.spec,x.continuation,x.active,closed,f.effects)};
}
test('closed read-only argv failure continues once under new tool pin without changing old claims or held producer',()=>scoped(async root=>{
 const x=await closedAdmissionFixture(root),claim=await readFile(x.closed.active_claim.path),failure=await readFile(x.closed.failure.path),oldTool=await readFile(x.closed.ownership_tool.archive_path);const p=await x.makeFixed();await p.admitActiveAfterTimeout();
 assert.equal(x.failedAdmission.status().held,true);assert.deepEqual(await readFile(x.closed.active_claim.path),claim);assert.deepEqual(await readFile(x.closed.failure.path),failure);assert.deepEqual(await readFile(x.closed.ownership_tool.archive_path),oldTool);
 const next=JSON.parse(await readFile(x.closed.active_claim.path+'.argv-case-fix.json'));assert.equal(next.continuation_kind,'argv-case-fix-once');assert.deepEqual(next.previous_active_claim,x.closed.active_claim);assert.deepEqual(next.closed_inspect_failure,x.closed.inspect_failure);assert.equal(next.production_qualified,false);
 const n=x.f.calls.length;await assert.rejects(x.failedAdmission.admitActiveAfterTimeout());assert.equal(x.f.calls.length,n);
 const spec=x.f.spec('restart','a');delete spec.authorization;const result=await p.runRuntimeRestart(spec);assert.equal(result.original_activation_exit,'unknown');assert.equal(result.production_qualified,false);await p.cleanup({installationId:'a',removeRoot:true});
}));
test('closed admission continuation refuses altered non-closed or effectful history before dispatch',async t=>{
 for(const mode of ['missing','hash','pending-driver','success-driver','later-phase','later-action','claim','inspect-operation','inspect-success','inspect-pending','terminal-parent','terminal-birth','terminal-timeout','terminal-signal','nonempty-late','different-slot','different-owner','different-config','current-tool-bytes','original-tool-bytes','wrong-terminal-ref'])await t.test(mode,()=>scoped(async root=>{
  const x=await closedAdmissionFixture(root),c=x.closed,n=x.f.calls.length,m=x.preparationCalls.length;
  if(mode==='missing')delete c.inspect_terminal;if(mode==='hash')await writeFile(c.inspect_failure.path,'modified');
  if(mode==='pending-driver')await x.rewrite(c.controller,v=>{v.state='running';v.exit_code=null;});if(mode==='success-driver')await x.rewrite(c.controller,v=>{v.exit_code=0;});if(mode==='later-phase')await x.rewrite(c.driver_final,v=>{v.phase='runtime_restart';});if(mode==='later-action')await x.rewrite(c.driver_final,v=>{v.status.completed=['restart'];});if(mode==='claim')await x.rewrite(c.active_claim,v=>{v.install_nonce='f'.repeat(32);});
  if(mode==='inspect-operation')await x.rewrite(c.inspect_failure,v=>{v.operation='cleanup-remove';});if(mode==='inspect-success')await x.rewrite(c.inspect_failure,v=>{v.exit_code=0;});if(mode==='inspect-pending')await x.rewrite(c.inspect_failure,v=>{v.pending=true;});
  if(mode==='terminal-parent')await x.rewrite(c.inspect_terminal,v=>{v.parent_pid=555;});if(mode==='terminal-birth')await x.rewrite(c.inspect_terminal,v=>{v.creation_filetime='134377326109647806';});if(mode==='terminal-timeout')await x.rewrite(c.inspect_terminal,v=>{v.primary_reason='TIMEOUT';});if(mode==='terminal-signal')await x.rewrite(c.inspect_terminal,v=>{v.close.signal='SIGTERM';});if(mode==='nonempty-late')await x.rewrite(c.inspect_terminal,v=>{v.late_stderr.bytes=1;});
  if(mode==='different-slot')x.f.options.plan.windows_e2e.installations.a.root=join(root,'other');if(mode==='different-owner')x.f.options.plan.windows_e2e.installations.a.owner_sid='S-1-5-21-999';if(mode==='different-config')await x.rewrite(x.active.configured,v=>{v.config_sha256='f'.repeat(64);});
  if(mode==='current-tool-bytes')x.f.files.set(x.f.options.plan.windows_e2e.ownership_tool.path,Buffer.from('wrong current tool'));if(mode==='original-tool-bytes')await writeFile(c.ownership_tool.archive_path,'changed old tool');if(mode==='wrong-terminal-ref')await x.rewrite(c.inspect_failure,v=>{v.terminal_evidence.receipt=join(root,'other.json');});
  if(['inspect-operation','inspect-success','inspect-pending','wrong-terminal-ref'].includes(mode)){await x.rewrite(c.driver_final,v=>{v.error.receipt=structuredClone(c.inspect_failure);});await x.rewrite(c.failure,v=>{v.original_receipt=structuredClone(c.inspect_failure);});}
  await assert.rejects(x.makeFixed());assert.equal(x.f.calls.length,n);assert.equal(x.preparationCalls.length,m);
 }));
});
test('one fixed admission continuation claim rejects concurrent or repeated dispatch',()=>scoped(async root=>{
 const x=await closedAdmissionFixture(root),a=await x.makeFixed();x.f.options.outputDirectory=join(root,'evidence','competing-fixed-admission');const b=await x.makeFixed();await a.admitActiveAfterTimeout();const n=x.f.calls.length;await assert.rejects(b.admitActiveAfterTimeout(),/EEXIST/);assert.equal(x.f.calls.length,n);assert(b.status().held);await assert.rejects(a.admitActiveAfterTimeout());assert(a.status().held);assert(x.failedAdmission.status().held);
}));
