import {fixture} from './fixtures/windows-production-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join,win32} from 'node:path';
import {spawnSync} from 'node:child_process';
import {powershellEnvironment} from '../npm/cli.mjs';
import {createHash} from 'node:crypto';
import {createWindowsScenarioProducer,createSyntheticWindowsProducerHarness,verifyWindowsOwnershipObservation} from '../verification/windows-evidence-production.mjs';
import {windowsOwnershipToolPath} from '../verification/windows-evidence-host.mjs';
import {hash,verifySyntheticPartialWindowsScenarioEvidence} from '../verification/distribution-qualification.mjs';
const clone=structuredClone;
test('public registration-only activation starts through the pinned MCP entry before runtime and memory proofs',()=>scoped(async root=>{
  const f=fixture(root,{activationStartsRuntime:false}),p=await createSyntheticWindowsProducerHarness(f.options,f.effects);
  await p.prepareFresh({installationId:'a'});f.states.get('a').closed=true;
  const record=await p.runScenario(f.spec('fresh_install','a'));
  assert.deepEqual(record.steps.map(x=>x.phase),['prepare','activate','start']);
  const activation=JSON.parse(await readFile(record.steps[1].after.path,'utf8'));
  assert.equal(activation.runtime,undefined);
  const firstApi=f.calls.findIndex(x=>x.api),start=f.calls.findIndex(x=>x.scenario==='fresh_install'&&x.phase==='start');
  assert(start>=0&&firstApi>start);
  const assembled=await p.verifyPartial();assert.equal(assembled.verification.acceptance,'synthetic_partial_contract');
  const context={manifestBytes:f.options.manifestBytes,releaseRoot:f.options.plan.release_root,load:readFile};
  for(const mutation of ['missing-start','wrong-order','missing-runtime']){
    const bad=clone(assembled.result),steps=bad.scenarios.fresh_install.steps;
    if(mutation==='missing-start')steps.pop();
    if(mutation==='wrong-order')[steps[1],steps[2]]=[steps[2],steps[1]];
    if(mutation==='missing-runtime')steps[2].after=record.steps[1].after;
    await assert.rejects(verifySyntheticPartialWindowsScenarioEvidence(bad,assembled.qualification,context),mutation);
  }
}));

test('fresh startup failure or unknown outcome holds without API access, retry or cleanup',async t=>{
  for(const mode of ['exit','unknown'])await t.test(mode,()=>scoped(async root=>{
    const f=fixture(root,{activationStartsRuntime:false}),run=f.effects.run;
    f.effects.run=async o=>{const result=await run(o);if(o.scenario==='fresh_install'&&o.phase==='start'){result.exit_code=mode==='exit'?1:null;result.pending=mode==='unknown';}return result;};
    const p=await createSyntheticWindowsProducerHarness(f.options,f.effects);
    await p.prepareFresh({installationId:'a'});f.states.get('a').closed=true;
    await assert.rejects(p.runScenario(f.spec('fresh_install','a')));
    assert.equal(p.status().held,true);assert(!f.calls.some(x=>x.api));
    const count=f.calls.length;
    await assert.rejects(p.runScenario(f.spec('fresh_install','a')));
    await assert.rejects(p.cleanup({installationId:'a'}));assert.equal(f.calls.length,count);
    assert.equal(f.calls.filter(x=>x.scenario==='fresh_install'&&x.phase==='start').length,1);
  }));
});

test('changed activation identity prevents the first startup',async t=>{
  for(const field of ['owner_sid','install_root','install_nonce','release_manifest_sha256'])await t.test(field,()=>scoped(async root=>{
    const f=fixture(root,{activationStartsRuntime:false}),run=f.effects.run;
    f.effects.run=async o=>{const result=await run(o);if(o.phase==='activate')f.states.get('a').installed[field]=field==='install_root'?'D:\\foreign':'foreign';return result;};
    const p=await createSyntheticWindowsProducerHarness(f.options,f.effects);
    await p.prepareFresh({installationId:'a'});f.states.get('a').closed=true;
    await assert.rejects(p.runScenario(f.spec('fresh_install','a')));assert.equal(p.status().held,true);
    assert(!f.calls.some(x=>x.phase==='start'||x.api));
  }));
});
test('producer records automatic rollback, failed restoration and withheld rollback without inventing a restore error',async t=>{
  for(const outcome of ['automatic_rollback','rollback_failed','rollback_withheld'])await t.test(outcome,()=>scoped(async root=>{
    const f=fixture(root,{rollbackOutcome:outcome}),p=await createSyntheticWindowsProducerHarness(f.options,f.effects);
    await p.prepareFresh({installationId:'a'});f.states.get('a').closed=true;
    await p.runScenario(f.spec('fresh_install','a'));await p.runScenario(f.spec('restart','a'));await p.runScenario(f.spec('managed_update','b'));
    const record=await p.runScenario(f.spec('failure_recovery','f')),details=JSON.parse(await readFile(record.failure.path,'utf8'));
    assert.equal(details.outcome,outcome);assert.equal(!!details.restored_state,outcome==='automatic_rollback');assert.equal(!!details.restore_error,outcome==='rollback_failed');
    assert.equal((await p.assemble()).verification.acceptance,'synthetic_contract');
    assert.deepEqual(f.calls.filter(x=>x.scenario==='failure_recovery').map(x=>x.phase),['inject','recover']);
  }));
});

test('unconfirmed stop or unrelated failure holds before recovery dispatch',async t=>{
  for(const mode of ['stop-unconfirmed','wrong-phase','wrong-error','not-ready','wrong-predecessor'])await t.test(mode,()=>scoped(async root=>{
    const automatic=['not-ready','wrong-predecessor'].includes(mode);
    const f=fixture(root,{rollbackOutcome:automatic?'automatic_rollback':'rollback_failed'}),run=f.effects.run;
    f.effects.run=async o=>{
      const result=await run(o);
      if(o.phase==='inject'){
        const s=f.states.get('f'),d=s.installed.cutover_failure;
        if(mode==='stop-unconfirmed')d.runtime_stopped=false;
        if(mode==='wrong-phase')d.phase='copy-package';
        if(mode==='wrong-error')d.original_error_hresult=-2147024891;
        if(mode==='not-ready')d.runtime_ready=false;
        if(mode==='wrong-predecessor')s.installed.release_manifest_sha256='f'.repeat(64);
      }return result;
    };
    const p=await createSyntheticWindowsProducerHarness(f.options,f.effects);
    await assert.rejects(p.runScenario(f.spec('failure_recovery','f')));
    assert.equal(p.status().held,true);assert(!f.calls.some(x=>x.phase==='recover'));
  }));
});
async function scoped(action){assert.equal(process.env.AGENTMEMORY_INTEGRATION,'0');assert.equal(process.env.AGENTMEMORY_CURATE,'0');const root=await mkdtemp(join(process.env.AGENTMEMORY_SYNTHETIC_TEST_ROOT,'production-contract-'));try{return await action(root);}finally{await rm(root,{recursive:true,force:true});}}

test('production boundary rejects synthetic promotion and missing/changed candidate before dispatch',async t=>{
  for(const mode of ['production','missing','changed','disabled'])await t.test(mode,()=>scoped(async root=>{
    const f=fixture(root);let operation;
    if(mode==='production')operation=createWindowsScenarioProducer(f.options);
    else {if(mode==='missing')f.files.delete(win32.join(f.options.plan.release_root,'release-manifest.json'));if(mode==='changed')f.options.plan.source_input_digest='c'.repeat(64);if(mode==='disabled')f.options.execute=false;
      operation=createSyntheticWindowsProducerHarness(f.options,f.effects).then(p=>{f.options.execute=true;return p.prepareFresh({installationId:'a'});});}
    await assert.rejects(operation);assert.equal(f.calls.length,0);
  }));
});

test('actual producer sequencing and cleanup execute only supplied fake effects and remain synthetic',()=>scoped(async root=>{
  const f=fixture(root),p=await createSyntheticWindowsProducerHarness(f.options,f.effects);
  const fresh=await p.prepareFresh({installationId:'a'});assert.equal(fresh.install_nonce,'a'.repeat(32));f.states.get('a').closed=true;
  await p.runScenario(f.spec('fresh_install','a'));await p.runScenario(f.spec('restart','a'));await p.runScenario(f.spec('managed_update','b'));await p.runScenario(f.spec('failure_recovery','f'));
  const result=await p.assemble();assert.equal(result.verification.acceptance,'synthetic_contract');assert.equal(result.production_qualified,false);
  const cleanup=await p.cleanup({installationId:'a',removeRoot:true});assert.equal(cleanup.root_removed,true);assert.equal(cleanup.auth_retained,false);assert.equal(p.status().held,false);
  assert.deepEqual(f.calls.filter(x=>x.phase).map(x=>x.phase),['prepare','activate','start','stop','start','update','inject','recover','stop']);
  assert.deepEqual(f.calls.filter(x=>x.operation&&x.operation!=='inspect'&&x.operation!=='preflight').map(x=>x.operation),['stop-watchdog','cleanup-remove']);
  console.log(JSON.stringify({synthetic:true,production_qualified:false,fake_only:true,actions:f.calls.filter(x=>x.phase).map(x=>x.phase),ownership_operations:f.calls.filter(x=>x.operation).length}));
}));

test('fresh activation cannot silently supply configuration and failed observation latches all followups',async t=>{
  for(const fault of ['unconfigured','root','nonce','task','unknown','pending'])await t.test(fault,()=>scoped(async root=>{
    const f=fixture(root),p=await createSyntheticWindowsProducerHarness(f.options,f.effects);await p.prepareFresh({installationId:'a'});
    if(fault!=='unconfigured')f.states.get('a').closed=true;
    if(fault==='pending')f.setHook(o=>{if(o.operation==='inspect')throw Object.assign(new Error('synthetic access denied'),{code:'EACCES'});});
    else if(fault!=='unconfigured')f.setOwnershipFault(v=>{if(fault==='root')v.install_root='D:\\foreign';if(fault==='nonce')v.install_nonce='foreign';if(fault==='task')v.tasks[0].actual_action.arguments='foreign';if(fault==='unknown')v.processes.push({role:'unknown'});});
    await assert.rejects(p.runScenario(f.spec('fresh_install','a')));const count=f.calls.length;assert.equal(p.status().held,true);await assert.rejects(p.cleanup({installationId:'a'}));await assert.rejects(p.runScenario(f.spec('restart','a')));assert.equal(f.calls.length,count);
  }));
});

test('in-flight and repeated phases cannot dispatch duplicate operations',()=>scoped(async root=>{
  const f=fixture(root);let release,entered;const started=new Promise(r=>{entered=r;});const wait=new Promise(r=>{release=r;});f.setHook(async o=>{if(o.operation==='preflight'){entered();await wait;}});
  const p=await createSyntheticWindowsProducerHarness(f.options,f.effects),first=p.prepareFresh({installationId:'a'});await started;await assert.rejects(p.prepareFresh({installationId:'a'}),/in flight/);release();await first;
  const count=f.calls.length;await assert.rejects(p.prepareFresh({installationId:'a'}));assert.equal(p.status().held,true);assert.equal(f.calls.length,count);
}));

test('default installer is never treated as a failure injector and root removal requires explicit scope',async t=>{
  await t.test('no fixture',()=>scoped(async root=>{const f=fixture(root,{failureFixture:false}),p=await createSyntheticWindowsProducerHarness(f.options,f.effects);await assert.rejects(p.runScenario(f.spec('failure_recovery','f')),/qualification fixture/);assert.equal(f.calls.length,0);}));
  await t.test('no removal grant',()=>scoped(async root=>{const f=fixture(root);f.options.plan.windows_e2e.installations.a.allow_root_removal=false;const p=await createSyntheticWindowsProducerHarness(f.options,f.effects);await p.prepareFresh({installationId:'a'});f.states.get('a').closed=true;await p.runScenario(f.spec('fresh_install','a'));const count=f.calls.length;await assert.rejects(p.cleanup({installationId:'a',removeRoot:true}),/not explicitly scoped/);assert.equal(f.calls.length,count);}));
});

test('ownership protocol rejects substituted task/process/time identity rather than trusting labels',async t=>{
  for(const mutation of ['task-name','task-root','task-owner','task-args','pid','birth','parent','command','unknown-state','future','missing-role','absent-active-role','all-absent-active','task-removal'])await t.test(mutation,()=>scoped(async root=>{
    const f=fixture(root),s=f.states.get('b'),previous=f.observation(s,'inspect'),value=clone(previous),target=f.options.plan.windows_e2e.installations.b;
    if(mutation==='task-name')value.tasks[0].name='foreign';if(mutation==='task-root')value.tasks[0].registration.working_directory='D:\\foreign';if(mutation==='task-owner')value.tasks[0].actual_action.owner_sid='S-1-5-18';if(mutation==='task-args')value.tasks[0].actual_action.arguments='other';
    if(mutation==='pid')value.processes[0].pid++;if(mutation==='birth')value.processes[0].creation_date=new Date(0).toISOString();if(mutation==='parent')value.processes[0].parent_pid++;if(mutation==='command')value.processes[0].command_sha256='f'.repeat(64);if(mutation==='unknown-state')value.processes[0].state='unknown';if(mutation==='future')value.processes[0].creation_date=new Date(Date.parse(value.observed_at_utc)+1000).toISOString();if(mutation==='missing-role')value.processes.shift();
    if(mutation==='absent-active-role')value.processes[0].state='absent';if(mutation==='all-absent-active')value.processes.forEach(p=>p.state='absent');
    let operation='inspect';if(mutation==='task-removal'){operation='cleanup-retain';value.operation=operation;value.status='retired';value.tasks_removed=['foreign'];value.root_removed=false;value.auth_retained=true;}
    assert.throws(()=>verifyWindowsOwnershipObservation(value,{plan:f.options.plan,target,operation,previous}));
  }));
});

test('prepared cleanup preserves truly absent tasks and cannot invent activated task absence',async t=>{
  await t.test('retain prepared root',()=>scoped(async root=>{
    const f=fixture(root),p=await createSyntheticWindowsProducerHarness(f.options,f.effects);
    await p.prepareFresh({installationId:'a'});
    const result=await p.cleanup({installationId:'a'});
    assert.equal(result.status,'retired');assert.equal(result.auth_retained,true);
    assert(result.tasks.every(t=>t.state==='Absent'&&t.actual_action===null));
    assert(!f.calls.some(x=>x.phase==='activate'));
  }));
  await t.test('activated disappearance rejected',()=>scoped(async root=>{
    const f=fixture(root),s=f.states.get('b'),previous=f.observation(s,'inspect'),v=clone(previous);
    v.status='retired';v.operation='cleanup-retain';v.tasks.forEach(t=>{t.state='Absent';t.actual_action=null;});
    Object.assign(v,{root_removed:false,auth_retained:true,tasks_removed:v.tasks.map(t=>t.name)});
    assert.throws(()=>verifyWindowsOwnershipObservation(v,{plan:f.options.plan,target:s.t,operation:'cleanup-retain',previous}),/Activated task missing/);
  }));
});

test('real PowerShell ownership functions re-observe prior roles using fake probes only',()=>scoped(async root=>{
  const script=String.raw`
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:SYNTHETIC_OWNERSHIP_SOURCE,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Source parse failed'}
$selected=@('Observe-RecordedProcesses','Assert-Previous','Assert-InactiveObservation')
foreach($name in $selected){$match=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$false));if($match.Count -ne 1){throw 'Missing pure function'};. ([scriptblock]::Create($match[0].Extent.Text))}
$script:queries=@();$script:probeState='absent'
function Get-RecordedProcess($Record,$Role,$C){$script:queries+=@([pscustomobject]@{role=$Role;pid=$Record.pid});if($script:probeState -eq 'identity_changed'){throw 'Recorded PID was reused'};if($script:probeState -eq 'unknown'){throw 'Synthetic probe denied'};return [pscustomobject]@{role=$Role;pid=$Record.pid;creation_date=$Record.creation_date;state=$script:probeState;parent_pid=3;command_sha256=('a'*64);executable_path='D:\synthetic\node.exe'}}
function Same-Path($A,$B){return $A -ceq $B}
function Must-Fail([scriptblock]$Action){$failed=$false;try{& $Action}catch{$failed=$true};if(-not $failed){throw 'Expected fail-closed rejection'}}
$old=[pscustomobject]@{role='worker';pid=42;creation_date='2026-01-01T00:00:00Z';state='present';parent_pid=3;command_sha256=('a'*64);executable_path='D:\synthetic\node.exe'}
$previous=[pscustomobject]@{execution_id='x';installation_id='a';install_nonce='n';install_root='D:\synthetic';tasks=@();processes=@($old)}
$out=@(Observe-RecordedProcesses @() $previous $null)
if($out.Count -ne 1 -or $out[0].state -ne 'absent' -or $script:queries.Count -ne 1 -or $script:queries[0].pid -ne 42){throw 'Dropped role was not explicitly observed'}
$current=[pscustomobject]@{execution_id='x';installation_id='a';install_nonce='n';install_root='D:\synthetic';tasks=@();processes=$out}
Assert-Previous $previous $current;Assert-InactiveObservation $current
$cases=@('dropped role explicitly absent')
$script:probeState='present';$current.processes=@(Observe-RecordedProcesses @() $previous $null);Must-Fail {Assert-InactiveObservation $current};$cases+=@('dropped role still present blocks cleanup')
foreach($mode in @('identity_changed','unknown')){$script:probeState=$mode;Must-Fail {Observe-RecordedProcesses @() $previous $null};$cases+=@($mode+' blocks cleanup')}
$script:probeState='absent';$different=[pscustomobject]@{role='worker';record=[pscustomobject]@{pid=43;creation_date=$old.creation_date}};Must-Fail {Observe-RecordedProcesses @($different) $previous $null};$cases+=@('substituted runtime PID rejected after prior probe')
$current.processes=@();Must-Fail {Assert-Previous $previous $current};$cases+=@('omitted prior role rejected')
$current.processes=@($old,$old);Must-Fail {Assert-Previous $previous $current};$cases+=@('duplicate role rejected')
$current.processes=@([pscustomobject]@{role='worker';pid=42;creation_date=$old.creation_date;state='unknown'});Must-Fail {Assert-Previous $previous $current};$cases+=@('unknown outcome rejected')
[ordered]@{synthetic=$true;production_qualified=$false;cases=$cases;queries=$script:queries;source=$env:SYNTHETIC_OWNERSHIP_SOURCE;runtime_actions=0}|ConvertTo-Json -Depth 5 -Compress
`;
  const command=join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),args=['-NoProfile','-NonInteractive','-Command',script],started=new Date().toISOString();
  const child=spawnSync(command,args,{windowsHide:true,timeout:15000,encoding:'utf8',env:powershellEnvironment({...process.env,TEMP:root,TMP:root,TMPDIR:root,SYNTHETIC_OWNERSHIP_SOURCE:windowsOwnershipToolPath})});
  console.log(JSON.stringify({scope:'AST allowlisted pure functions; fake probes; no helper top-level or OS process/task actions',command:[command,...args],pid:child.pid,parent_pid:process.pid,started,completed:new Date().toISOString(),exit_code:child.status,stdout:child.stdout,stderr:child.stderr}));
  assert.ifError(child.error);assert.equal(child.status,0,child.stderr);const result=JSON.parse(child.stdout);assert.equal(result.cases.length,8);assert.equal(result.runtime_actions,0);
}));

test('post-stop inspect keeps pre-stop PIDs until each explicit absence is proven',async t=>{
  for(const mode of ['missing','orphan','identity-changed','unknown','absent'])await t.test(mode,()=>scoped(async root=>{
    const f=fixture(root),p=await createSyntheticWindowsProducerHarness(f.options,f.effects);
    await p.prepareFresh({installationId:'a'});f.states.get('a').closed=true;await p.runScenario(f.spec('fresh_install','a'));
    let stopped=false,prior,seen=false;
    f.setAfterStop(s=>{stopped=true;delete s.runtime.worker;delete s.runtime.engine;});
    f.setOwnershipFault((value,o,contract)=>{
      if(!stopped)return;
      assert(contract.previous,'Post-stop backend did not receive pre-stop proof');
      assert(contract.previous.processes.some(p=>p.role==='worker'));
      assert(contract.previous.processes.some(p=>p.role==='engine'));
      seen=true;prior=contract.previous;
      if(mode==='identity-changed')throw new Error('Recorded PID was reused');
      if(mode==='unknown')throw new Error('Synthetic process observation denied');
      if(mode==='missing')return;
      for(const old of contract.previous.processes)if(!value.processes.some(p=>p.role===old.role))value.processes.push({...old,state:mode==='orphan'&&old.role==='worker'?'present':'absent'});
    });
    if(mode==='absent'){
      const result=await p.cleanup({installationId:'a'});assert.equal(result.status,'retired');assert(result.processes.every(p=>p.state==='absent'));assert(prior.processes.length>=3);
    }else{
      await assert.rejects(p.cleanup({installationId:'a'}));assert.equal(p.status().held,true);
      assert(!f.calls.some(x=>x.operation?.startsWith('cleanup-')));
      const count=f.calls.length;await assert.rejects(p.cleanup({installationId:'a'}));assert.equal(f.calls.length,count);
    }
    assert(seen,'Post-stop observation not exercised');
  }));
});


test('scoped preparation feeds one-shot fake credentials into real producer and partial verifier',async t=>{
  for(const mode of ['valid','wrong-detail','legacy-secret'])await t.test(mode,()=>scoped(async root=>{
    const {windowsPreparationToolPath}=await import('../verification/windows-execution-preparation.mjs');
    const f=fixture(root),settings=f.options.plan.windows_e2e,s=settings.installations.a;
    f.options.plan.isolation_root=root;
    s.root=join(root,'slot-a');s.workspace_root=join(root,'workspace');s.project_registry=join(s.workspace_root,'registry.json');s.requirements_path=join(s.workspace_root,'managed-requirements.toml');
    settings.installations={a:s};f.options.outputDirectory=join(root,'evidence','attempt-01');
    const tool=Buffer.from('inert preparation tool');f.files.set(windowsPreparationToolPath,tool);settings.preparation_tool={path:windowsPreparationToolPath,sha256:hash(tool)};
    let tokenReads=0,configured=0;const token=Buffer.alloc(32,73).toString('base64'),buffers=[];
    f.effects.preparation={read:f.effects.read,support:async()=>({synthetic:true,created:true}),run:async({operation,contract})=>{
      assert.equal(contract.install_root,s.root);assert.equal(contract.install_nonce,'a'.repeat(32));assert.equal(contract.owner_sid,s.owner_sid);
      if(operation==='configure'){assert.equal(f.states.get('a').installed.installation_status,'prepared');f.states.get('a').closed=true;configured++;}
      else {assert.equal(f.states.get('a').installed.installation_status,'activated');tokenReads++;}
      const bytes=operation==='configure'?Buffer.from(JSON.stringify({configured:true,install_root:s.root,install_nonce:contract.install_nonce,candidate_manifest_sha256:f.options.plan.manifest_sha256,config_sha256:'d'.repeat(64)})):Buffer.from(token);buffers.push(bytes);
      return {bytes,receipt:{operation,pid:777,parent_pid:778,start_utc:'2026-01-01T00:00:00.000Z',end_utc:'2026-01-01T00:00:00.001Z',created_at_utc:'2026-01-01T00:00:00.000Z',exit_code:0,pending:false}};
    }};
    const request=f.effects.request;f.effects.request=async o=>{assert.equal(o.authorization,token);const result=await request(o);if(mode==='wrong-detail'&&new URL(o.url).pathname.includes('/memories/')){const body=JSON.parse(result.bytes);body.memory.origin.channel='wrong';result.bytes=Buffer.from(JSON.stringify(body));}return result;};
    const producer=await createSyntheticWindowsProducerHarness(f.options,f.effects);
    await producer.prepareFresh({installationId:'a'});await producer.configurePrepared({installationId:'a'});
    const spec=(name)=>{const v=f.spec(name,'a');if(mode!=='legacy-secret')delete v.authorization;return v;};
    if(mode==='valid'){
      await producer.runScenario(spec('fresh_install'));await producer.runScenario(spec('restart'));
      const partial=await producer.verifyPartial();assert.equal(partial.verification.acceptance,'synthetic_partial_contract');assert.equal(partial.verification.production_qualified,false);assert.deepEqual(partial.verification.remaining_scenarios,['managed_update','failure_recovery']);
      assert.equal(tokenReads,6);assert.equal(configured,1);
    }else {await assert.rejects(producer.runScenario(spec('fresh_install')));assert(producer.status().held);}
    assert(buffers.every(b=>b.every(v=>v===0)),'Provider buffers must be cleared even on failure');
    const {readdir}=await import('node:fs/promises');
    async function inspect(path){for(const entry of await readdir(path,{withFileTypes:true})){const next=join(path,entry.name);if(entry.isDirectory())await inspect(next);else assert(!(await readFile(next)).includes(Buffer.from(token)),'Credential leaked into artifact');}}
    await inspect(f.options.outputDirectory);
  }));
});


test('existing slots require read-only scoped admission before update and recovery, then refresh credential binding',async t=>{
 for(const mode of ['valid','missing-admission','wrong-manifest','wrong-nonce','stale'])await t.test(mode,()=>scoped(async root=>{
  const {windowsPreparationToolPath}=await import('../verification/windows-execution-preparation.mjs');
  const f=fixture(root,{isolationRoot:root}),settings=f.options.plan.windows_e2e;
  settings.installations={b:settings.installations.b,f:settings.installations.f};f.options.outputDirectory=join(root,'evidence','attempt');
  const tool=Buffer.from('inert existing configuration reader');f.files.set(windowsPreparationToolPath,tool);settings.preparation_tool={path:windowsPreparationToolPath,sha256:hash(tool)};
  const token=Buffer.alloc(32,74).toString('base64'),buffers=[],reads=[];
  f.effects.preparation={read:f.effects.read,support:async()=>{throw new Error('Existing support must not be rewritten');},run:async({operation,contract:c})=>{
   assert(['inspect-existing','credential'].includes(operation),'Existing config must not be rewritten');reads.push(operation);
   const s=[...f.states.values()].find(s=>s.t.root===c.install_root);assert(s);assert.equal(c.install_nonce,s.installed.install_nonce);assert.equal(c.expected_installed_manifest_sha256,s.installed.release_manifest_sha256);
   const start=f.effects.now(),at=f.effects.now();
   const value={operation,active:true,execution_id:c.execution_id,install_root:c.install_root,owner_sid:c.owner_sid,install_nonce:c.install_nonce,candidate_manifest_sha256:c.candidate_manifest_sha256,installed_manifest_sha256:c.expected_installed_manifest_sha256,config_sha256:'d'.repeat(64),observed_at_utc:at,production_qualified:false};
   if(operation==='inspect-existing'){if(mode==='wrong-manifest')value.installed_manifest_sha256='0'.repeat(64);if(mode==='wrong-nonce')value.install_nonce='0'.repeat(32);if(mode==='stale')value.observed_at_utc='2000-01-01T00:00:00.000Z';}
   else assert.equal(c.expected_config_sha256,'d'.repeat(64));
   const bytes=operation==='credential'?Buffer.from(token):Buffer.from(JSON.stringify(value));buffers.push(bytes);
   return {bytes,receipt:{operation,pid:777,parent_pid:778,start_utc:start,end_utc:f.effects.now(),created_at_utc:start,exit_code:0,pending:false}};
  }};
  const request=f.effects.request;f.effects.request=async o=>{assert.equal(o.authorization,token);return request(o);};
  const p=await createSyntheticWindowsProducerHarness(f.options,f.effects);
  const spec=(name,id)=>{const s=f.spec(name,id);delete s.authorization;return s;};
  if(mode==='missing-admission'){await assert.rejects(p.runScenario(spec('managed_update','b')),/Scoped configuration/);assert.equal(reads.length,0);}
  else if(mode!=='valid'){await assert.rejects(p.admitExisting({installationId:'b'}));assert.equal(f.calls.filter(x=>x.phase||x.api).length,0);}
  else for(const [name,id] of [['managed_update','b'],['failure_recovery','f']]){
   await p.admitExisting({installationId:id});await p.runScenario(spec(name,id));
  }
  assert(buffers.every(b=>b.every(x=>x===0)));
  if(mode==='valid'){assert.equal(reads.filter(x=>x==='inspect-existing').length,4);assert.equal(reads.filter(x=>x==='credential').length,6);assert.equal(p.status().held,false);}
 }));
});

test('managed argv path casing uses identical files while options values PID and extra tokens remain exact',()=>scoped(async root=>{
 const {mkdir,writeFile}=await import('node:fs/promises');const {spawnSync}=await import('node:child_process');const {powershellEnvironment}=await import('../npm/cli.mjs');
 await mkdir(join(root,'scripts'));await writeFile(join(root,'shell.exe'),'inert synthetic bytes');await writeFile(join(root,'scripts/agentmemory-task.ps1'),'inert task');await writeFile(join(root,'scripts/agentmemory-watch.ps1'),'inert watchdog');
 const script=String.raw`
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($env:SYNTHETIC_OWNERSHIP_SOURCE,[ref]$tokens,[ref]$errors);if($errors.Count){throw 'Backend parse failed'}
foreach($name in @('Same-Path','Assert-PhysicalPath','Assert-SameManagedPathIdentity','Assert-ManagedProcessArguments')){$m=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$false));if($m.Count -ne 1){throw 'Function missing'};. ([scriptblock]::Create($m[0].Extent.Text))}
function Must-Fail([scriptblock]$Action){$failed=$false;try{&$Action}catch{$failed=$true};if(-not $failed){throw 'Expected refusal'}}
$root=$env:SYNTHETIC_ARGV_ROOT;$c=[pscustomobject]@{powershell_path=(Join-Path $root 'shell.exe');install_root=$root};$record=[pscustomobject]@{parent_pid=12345}
$base=@($c.powershell_path,'-NoLogo','-NoProfile','-NonInteractive','-WindowStyle','Hidden','-File',(Join-Path $root 'scripts\agentmemory-task.ps1'),'-Root',$root,'-HiddenLauncherPid','12345')
Assert-ManagedProcessArguments $base daemon $record $c;$cases=@('exact daemon')
$copy=$base.Clone();$copy[0]=$copy[0].ToUpperInvariant();Assert-ManagedProcessArguments $copy daemon $record $c;$cases+='same executable different case actual file ID'
$copy=$base.Clone();$copy[7]=$copy[7].ToUpperInvariant();$copy[9]=$copy[9].ToUpperInvariant();Assert-ManagedProcessArguments $copy daemon $record $c;$cases+='same script and root different case actual file ID'
$watch=@($base[0..9]);$watch[7]=Join-Path $root 'scripts\agentmemory-watch.ps1';Assert-ManagedProcessArguments $watch watchdog $record $c;$cases+='exact watchdog'
foreach($index in @(0,7,9)){$copy=$base.Clone();$copy[$index]=Join-Path $root 'foreign';Must-Fail {Assert-ManagedProcessArguments $copy daemon $record $c};$cases+=('different path '+$index+' rejected')}
$copy=$base.Clone();$copy[1]='-nologo';Must-Fail {Assert-ManagedProcessArguments $copy daemon $record $c};$cases+='option spelling remains exact'
$copy=$base.Clone();$copy[5]='Visible';Must-Fail {Assert-ManagedProcessArguments $copy daemon $record $c};$cases+='option value remains exact'
$copy=$base.Clone();$copy[11]='54321';Must-Fail {Assert-ManagedProcessArguments $copy daemon $record $c};$cases+='parent PID value remains exact'
Must-Fail {Assert-ManagedProcessArguments ($base+@('-unexpected','unknown-input-not-echoed')) daemon $record $c};$cases+='additional tokens rejected'
$copy=$base.Clone();$copy[0]='shell.exe';Must-Fail {Assert-ManagedProcessArguments $copy daemon $record $c};$cases+='relative path rejected'
$copy=$base.Clone();$copy[7]=Join-Path $root 'scripts\..\scripts\agentmemory-task.ps1';Must-Fail {Assert-ManagedProcessArguments $copy daemon $record $c};$cases+='parent traversal rejected'
[ordered]@{synthetic=$true;production_qualified=$false;cases=$cases;runtime_actions=0;process_queries=0;backend_top_level_executed=$false;native_file_metadata_only=$true}|ConvertTo-Json -Depth 4 -Compress
`;
 const command=join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),args=['-NoProfile','-NonInteractive','-Command',script],started=new Date().toISOString();
 const child=spawnSync(command,args,{windowsHide:true,timeout:15000,encoding:'utf8',env:powershellEnvironment({...process.env,TEMP:root,TMP:root,TMPDIR:root,SYNTHETIC_ARGV_ROOT:root,SYNTHETIC_OWNERSHIP_SOURCE:windowsOwnershipToolPath})});
 console.log(JSON.stringify({command:[command,...args],pid:child.pid,parent_pid:process.pid,started,end_utc:new Date().toISOString(),exit_code:child.status,stdout:child.stdout,stderr:child.stderr,scope:'allowlisted argv functions and Windows file-ID API on inert owned fixture only; no process/task/credential/backend actions'}));
 assert.ifError(child.error);assert.equal(child.status,0,child.stderr);const result=JSON.parse(child.stdout);assert.equal(result.cases.length,13);assert.equal(result.runtime_actions,0);assert.equal(result.process_queries,0);assert.equal(result.backend_top_level_executed,false);
}));
