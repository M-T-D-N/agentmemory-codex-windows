import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createWindowsHostAdapter, createSyntheticWindowsHostAdapter, windowsEvidenceEnvironment, windowsHostActionBudget, windowsHostOwnershipBudget } from '../verification/windows-evidence-host.mjs';
import { hash, verifySyntheticWindowsScenarioEvidence } from '../verification/distribution-qualification.mjs';
import { fixture } from './fixtures/windows-evidence-synthetic.mjs';

const product=fileURLToPath(new URL('../',import.meta.url));
async function scoped(action) {
  assert.equal(process.env.AGENTMEMORY_INTEGRATION,'0');assert.equal(process.env.AGENTMEMORY_CURATE,'0');
  const root=await mkdtemp(join(process.env.AGENTMEMORY_SYNTHETIC_TEST_ROOT,'host-'));
  try{const result=await action(root);await rm(root,{recursive:true,force:true});return result;}catch(error){console.error('Retained failing synthetic capture: '+root);throw error;}
}
function setup(root) {
  const x=fixture(false,'D:\\synthetic-unit'),isolation='D:\\synthetic-unit';
  const node='C:\\synthetic-tools\\node.exe',nodeBytes=Buffer.from('inert synthetic Node');
  x.files.set(node,nodeBytes);
  const plan={execution_id:x.result.execution_id,evidence_kind:'synthetic_contract',synthetic:true,production_qualified:false,
    source_commit:x.result.source_commit,source_input_digest:x.result.source_input_digest,manifest_sha256:x.result.manifest_sha256,
    release_root:x.context.releaseRoot,isolation_root:isolation,node_path:node,node_sha256:hash(nodeBytes),windows_e2e:structuredClone(x.qualification.windows_e2e)};
  for(const [id,t] of Object.entries(plan.windows_e2e.installations))Object.assign(t,{workspace_root:win32.join(isolation,'workspace-'+id),
    project_registry:win32.join(isolation,'workspace-'+id,'registry.json'),requirements_path:win32.join(isolation,'requirements-'+id+'.toml')});
  const state={snapshot:null,memory:null,time:null,runChange:null,requestChange:null,runCount:0,requestCount:0,budgets:[]};
  const read=ref=>JSON.parse(x.files.get(ref.path));
  const effects={
    now:()=>{assert(state.time,'Synthetic clock must be explicitly set');return state.time;},
    digest:async path=>hash(x.files.get(path)),
    read:async path=>{
      if(x.files.has(path))return Buffer.from(x.files.get(path));
      assert(state.snapshot,'Snapshot bytes not supplied');
      if(path.endsWith('config\\install-manifest.json'))return Buffer.from(x.files.get(state.snapshot.manifest.path));
      if(path.endsWith('data\\runtime-state.json'))return Buffer.from(x.files.get(state.snapshot.runtime.path));
      assert.fail('Unplanned synthetic file read');
    },
    run:async options=>{
      state.runCount++;state.budgets.push([options.scenario,options.phase,options.timeoutMs]);const s=x.result.scenarios[options.scenario].steps.find(s=>s.phase===options.phase),r=read(s.process);
      let value={pid:r.pid,parent_pid:r.parent_pid,launched_at_utc:r.created_at_utc,end_utc:r.end_utc,exit_code:r.exit_code,pending:false,
        stdout:Buffer.from(x.files.get(r.stdout.path)),stderr:Buffer.from(x.files.get(r.stderr.path)),
        identityBytes:Buffer.from(JSON.stringify({pid:r.pid,created_at_utc:r.created_at_utc,creation_filetime:r.creation_filetime,started_at_utc:r.start_utc,executable:r.executable.path}))};
      if(state.runChange)value=state.runChange(value);return value;
    },
    request:async()=>{state.requestCount++;assert(state.memory);let value={status_code:state.memory.status_code,bytes:Buffer.from(x.files.get(state.memory.response.path))};if(state.requestChange)value=state.requestChange(value);return value;}
  };
  const options={plan,manifestBytes:x.context.manifestBytes,outputDirectory:join(root,'captures'),execute:true};
  const adapter=createSyntheticWindowsHostAdapter(options,effects);
  return {x,plan,state,effects,options,adapter,read};
}
async function golden(root) {
  const f=setup(root),scenarios={},authorization='synthetic-auth-not-a-real-token';
  for(const [name,source] of Object.entries(f.x.result.scenarios)) {
    const id=source.installation_id,record={success:true,installation_id:id,start_utc:source.start_utc,end_utc:source.end_utc,steps:[],memory:{}};
    const memory=async kind=>{
      f.state.memory=f.read(source.memory[kind]);f.state.time=f.state.memory.observed_at_utc;
      const body=kind==='detail'?undefined:{project:f.plan.windows_e2e.installations[id].project};
      record.memory[kind]=await f.adapter.memory({installationId:id,kind,body,id:'synthetic-'+name,authorization});
    };
    if(name!=='fresh_install')await memory('created');
    let failedAction;
    for(const step of source.steps) {
      let before;
      if(step.before){f.state.snapshot=f.read(step.before);f.state.time=f.state.snapshot.observed_at_utc;before=await f.adapter.snapshot({installationId:id,runtime:!!f.state.snapshot.runtime});}
      const process=await f.adapter.action({scenario:name,phase:step.phase,installationId:id});
      f.state.snapshot=f.read(step.after);f.state.time=f.state.snapshot.observed_at_utc;
      const after=await f.adapter.snapshot({installationId:id,runtime:!!f.state.snapshot.runtime});
      record.steps.push({phase:step.phase,process,after,...(before?{before}:{})});if(step.phase==='inject')failedAction=process;
    }
    if(name==='fresh_install')await memory('created');
    await memory('search');await memory('detail');
    if(failedAction){const details=f.read(source.failure);record.failure=await f.adapter.failure({installationId:id,failedAction,
      details:Object.fromEntries(['original_error','original_error_id','original_error_hresult','restore_error','phase','outcome','restoration_completed','runtime_ready','runtime_stopped'].filter(k=>Object.hasOwn(details,k)).map(k=>[k,details[k]]))});}
    scenarios[name]=record;
  }
  return {...f,scenarios,authorization};
}
test('synthetic host effects produce archived receipts accepted only by the synthetic contract',async()=>scoped(async root=>{
  const f=await golden(root),result=await f.adapter.assemble(f.scenarios);
  assert.equal(result.synthetic,true);assert.equal(result.production_qualified,false);assert.equal(result.verification.acceptance,'synthetic_contract');
  assert.equal(f.state.runCount,7);assert.equal(f.state.requestCount,12);assert.deepEqual(f.state.budgets,[['fresh_install','prepare',300000],['fresh_install','activate',900000],['restart','stop',60000],['restart','start',180000],['managed_update','update',1800000],['failure_recovery','inject',1800000],['failure_recovery','recover',1800000]]);
  const context={manifestBytes:f.options.manifestBytes,releaseRoot:f.plan.release_root,load:readFile};
  assert.equal((await verifySyntheticWindowsScenarioEvidence(result.result,result.qualification,context)).success,true);
  const serialized=await readFile(result.evidence.path,'utf8');assert(!serialized.includes(f.authorization));
  await assert.rejects(f.adapter.assemble({...f.scenarios,restart:{...f.scenarios.restart,steps:[]}}));
}));
test('real adapter is disabled by default and cannot receive synthetic effect injection',async()=>scoped(async root=>{
  const f=setup(root),manifest=JSON.parse(f.options.manifestBytes);
  delete manifest.synthetic;delete manifest.evidence_kind;delete manifest.production_qualified;
  const bytes=Buffer.from(JSON.stringify(manifest));
  const options={plan:{...f.plan,synthetic:false,evidence_kind:'windows_execution',manifest_sha256:hash(bytes)},manifestBytes:bytes,outputDirectory:join(root,'real-disabled')};
  const real=createWindowsHostAdapter(options);
  await assert.rejects(real.action({scenario:'fresh_install',phase:'prepare',installationId:'a'}),/disabled/);
  assert(!(await readdir(root)).includes('real-disabled'));
  assert.throws(()=>createWindowsHostAdapter({...options,effects:f.effects}),/Unknown/);
  assert.throws(()=>createWindowsHostAdapter({...f.options,plan:{...f.plan,synthetic:false,evidence_kind:'windows_execution'}}),/Synthetic manifest/);
  assert.throws(()=>createSyntheticWindowsHostAdapter(f.options,{read:f.effects.read}),/no real fallback/);
}));
test('host preflight refuses unplanned phase, pinned-byte changes and foreign targets before spawning',async t=>{
  for(const name of ['phase','pinned','target'])await t.test(name,async()=>scoped(async root=>{
    const f=setup(root);
    if(name==='pinned')f.x.files.set(f.plan.windows_e2e.powershell.path,Buffer.from('changed tool'));
    if(name==='target'){const o={...f.options,plan:structuredClone(f.plan)};o.plan.windows_e2e.installations.a.root='D:\\foreign-install';f.adapter=createSyntheticWindowsHostAdapter(o,f.effects);}
    await assert.rejects(f.adapter.action({scenario:'fresh_install',phase:name==='phase'?'arbitrary':'prepare',installationId:'a'}));
    assert.equal(f.state.runCount,0);
  }));
});
test('unknown child identity and null exit retain raw failure receipts and block subsequent actions',async t=>{
  for(const name of ['identity','pending','failed'])await t.test(name,async()=>scoped(async root=>{
    const f=setup(root);
    f.state.runChange=value=>name==='identity'?{...value,identityBytes:Buffer.from('{"pid":1}')}:name==='pending'?{...value,exit_code:null,pending:true}:{...value,exit_code:7,stderr:Buffer.from('synthetic child failure')};
    let failure;
    try{await f.adapter.action({scenario:'fresh_install',phase:'prepare',installationId:'a'});}catch(error){failure=error;}
    assert(failure?.receipt);const receipt=JSON.parse(await readFile(failure.receipt.path));
    assert.equal(receipt.exit_code,name==='pending'?null:name==='failed'?7:0);
    assert(await readFile(receipt.stderr.path));
    await assert.rejects(f.adapter.action({scenario:'fresh_install',phase:'activate',installationId:'a'}),/incomplete|prior/);
    assert.equal(f.state.runCount,1);
  }));
});
test('one recorder cannot start overlapping actions or hide a rejected transport',async()=>scoped(async root=>{
  const f=setup(root);let release,entered;
  const started=new Promise(resolve=>{entered=resolve;});
  const barrier=new Promise(resolve=>{release=resolve;});
  const run=f.effects.run;f.effects.run=async options=>{entered();await barrier;return run(options);};
  const first=f.adapter.action({scenario:'fresh_install',phase:'prepare',installationId:'a'});
  await started;
  await assert.rejects(f.adapter.action({scenario:'fresh_install',phase:'activate',installationId:'a'}),/in flight/);
  await assert.rejects(f.adapter.snapshot({installationId:'a'}),/in flight/);
  release();await first;assert.equal(f.state.runCount,1);
  f.effects.run=async()=>{throw new Error('synthetic transport interrupted');};
  let failure;try{await f.adapter.action({scenario:'fresh_install',phase:'activate',installationId:'a'});}catch(error){failure=error;}
  assert(failure?.receipt);const receipt=JSON.parse(await readFile(failure.receipt.path));
  assert.equal(receipt.exit_code,null);assert.equal(receipt.pending,null);assert.equal(receipt.error_code,'RUN_TRANSPORT_ERROR');
  assert.equal(receipt.original_error,'synthetic transport interrupted');assert.equal(receipt.stdout,undefined);
  await assert.rejects(f.adapter.action({scenario:'fresh_install',phase:'activate',installationId:'a'}),/prior/);
}));

test('launcher captures use fixed paths and only this recorder updater can assemble preservation',async()=>scoped(async root=>{
  const f=setup(root),t=f.plan.windows_e2e.installations.b;
  const binary=win32.join(t.root,'bin/agentmemory-hidden-launcher.exe'),source=win32.join(t.root,'src/AgentMemoryHiddenLauncher.cs');
  f.x.files.set(binary,Buffer.from('inert preserved launcher'));f.x.files.set(source,Buffer.from('class Launcher {}\n'));
  f.state.time='2026-01-01T00:00:03Z';const before=await f.adapter.captureLauncher({installationId:'b'});
  const actionProcess=await f.adapter.action({scenario:'managed_update',phase:'update',installationId:'b'});
  f.state.time='2026-01-01T00:00:09Z';const after=await f.adapter.captureLauncher({installationId:'b'});
  const ref=await f.adapter.launcherPreservation({installationId:'b',actionProcess,before,after});
  const proof=JSON.parse(await readFile(ref.path));assert.equal(proof.before_binary.original_path,binary);assert.equal(proof.after_binary.content.sha256,hash(f.x.files.get(binary)));
  assert.equal(proof.candidate_source.path,win32.join(f.plan.release_root,'payload/src/AgentMemoryHiddenLauncher.cs'));
  await assert.rejects(f.adapter.launcherPreservation({installationId:'b',actionProcess,before:{...before},after}),/captures/);
  await assert.rejects(f.adapter.launcherPreservation({installationId:'a',actionProcess,before,after}),/updater/);
  const afterState=f.x.read(f.x.result.scenarios.managed_update.steps[0].after);f.state.snapshot=afterState;
  const snapshot=JSON.parse(await readFile((await f.adapter.snapshot({installationId:'b',launcherPreservation:ref})).path));
  assert.deepEqual(snapshot.launcher_preservation,ref);
}));

test('API capture refuses wrong projects and credential reflection without storing credentials',async()=>scoped(async root=>{
  const f=setup(root),authorization='synthetic-only-credential-marker';
  await assert.rejects(f.adapter.memory({installationId:'a',kind:'search',body:{project:'*'},authorization}),/project/);
  assert.equal(f.state.requestCount,0);
  f.state.memory={status_code:200,response:{path:'credential-echo'}};f.x.files.set('credential-echo',Buffer.from(authorization));
  await assert.rejects(f.adapter.memory({installationId:'a',kind:'search',body:{project:f.plan.windows_e2e.installations.a.project},authorization}),/credential/);
  assert(!(await readdir(root)).includes('captures'));
}));
test('archived references cannot escape the expected capture root',async()=>scoped(async root=>{
  const f=await golden(root),result=await f.adapter.assemble(f.scenarios);
  const step=result.result.scenarios.restart.steps[0],raw=JSON.parse(await readFile(step.process.path));
  raw.script.archive_path=join(root,'outside.bin');
  const bytes=Buffer.from(JSON.stringify(raw)),path=join(root,'tampered.json');await writeFile(path,bytes);step.process={path,sha256:hash(bytes)};
  await assert.rejects(verifySyntheticWindowsScenarioEvidence(result.result,result.qualification,{manifestBytes:f.options.manifestBytes,releaseRoot:f.plan.release_root,load:readFile}),/Archive escapes/);
}));
test('PowerShell bootstrap captures only itself with UTF-8; product scripts are parsed only',async()=>scoped(async root=>{
  const script=join(root,'bootstrap.ps1'),identity=join(root,'identity.json');
  const helper=join(product,'powershell/agentmemory-evidence.ps1');
  const source=[
    'param([string]$IdentityPath)',"Set-StrictMode -Version Latest","$ErrorActionPreference='Stop'",
    ". '"+helper.replaceAll("'","''")+"'",
    '$before=[Console]::OutputEncoding.CodePage','Initialize-AgentMemoryEvidenceCapture',
    "if([Console]::OutputEncoding.CodePage -ne $before){throw 'Default changed encoding'}",
    'Initialize-AgentMemoryEvidenceCapture -Utf8 -IdentityPath $IdentityPath',
    ...['Install-WindowsCodex.ps1','powershell/agentmemory-stop.ps1','powershell/agentmemory-mcp.ps1'].map(file=>"$t=$null;$e=$null;$a=[Management.Automation.Language.Parser]::ParseFile('"+join(product,file).replaceAll("'","''")+"',[ref]$t,[ref]$e);if($e.Count){throw 'Product parse error'}"),
    "([ordered]@{pid=$PID;text=([string][char]0xAC00+[string][char]0xB098);encoding=[Console]::OutputEncoding.CodePage}|ConvertTo-Json -Compress)"
  ].join('\r\n');
  await writeFile(script,source);
  const exe=join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),args=['-NoProfile','-NonInteractive','-File',script,'-IdentityPath',identity];
  const started=new Date().toISOString(),child=spawnSync(exe,args,{windowsHide:true,timeout:15000});
  console.log(JSON.stringify({command:[exe,...args],pid:child.pid,parent_pid:process.pid,start_utc:started,end_utc:new Date().toISOString(),exit_code:child.status,scope:'Own identity/encoding fixture only; installer/stop/mcp parsed, never executed'}));
  assert.ifError(child.error);assert.equal(child.status,0,child.stderr?.toString());
  const body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(child.stdout)),self=JSON.parse(await readFile(identity,'utf8'));
  assert.equal(body.text,'\uAC00\uB098');assert.equal(body.encoding,65001);assert.equal(self.pid,child.pid);assert.equal(body.pid,child.pid);
  assert(Date.parse(self.created_at_utc)<=Date.parse(self.started_at_utc));
}));

// These regressions exercise only pure environment objects, fake dispatches and
// task-owned exclusive-file collisions. They never change execution policy.
test('child environment preserves inherited Process policy without mutating its input',()=>{
  for(const policy of ['Restricted','AllSigned','RemoteSigned']) {
    const base={SystemRoot:'C:\\Windows',Path:'C:\\synthetic-tools',PsExecutionPolicyPreference:policy,NODE_OPTIONS:'inert override',AGENTMEMORY_SECRET:'synthetic-marker'};
    const prior=structuredClone(base),env=windowsEvidenceEnvironment('D:\\synthetic-capture',base);
    assert.equal(env.PSEXECUTIONPOLICYPREFERENCE,policy);assert.deepEqual(base,prior);
    assert.equal(env.NODE_OPTIONS,undefined);assert.equal(env.AGENTMEMORY_SECRET,undefined);
    assert.equal(env.AGENTMEMORY_INTEGRATION,'0');assert.equal(env.AGENTMEMORY_CURATE,'0');
  }
  assert.equal(windowsEvidenceEnvironment('D:\\synthetic-capture',{}).PSEXECUTIONPOLICYPREFERENCE,undefined);
});

test('capture-first operations exclude actions for the entire awaited capture',async t=>{
  for(const kind of ['snapshot','memory','captureLauncher'])await t.test(kind,async()=>scoped(async root=>{
    const f=setup(root),t=f.plan.windows_e2e.installations.a;
    f.state.snapshot=f.read(f.x.result.scenarios.fresh_install.steps[1].after);f.state.time=f.state.snapshot.observed_at_utc;
    f.state.memory=f.read(f.x.result.scenarios.fresh_install.memory.search);
    f.x.files.set(win32.join(t.root,'bin/agentmemory-hidden-launcher.exe'),Buffer.from('inert launcher'));
    f.x.files.set(win32.join(t.root,'src/AgentMemoryHiddenLauncher.cs'),Buffer.from('class Launcher {}'));
    let release,entered;const started=new Promise(resolve=>{entered=resolve;}),barrier=new Promise(resolve=>{release=resolve;});
    const effect=kind==='memory'?'request':'read',original=f.effects[effect];let deferred=false;
    f.effects[effect]=async(...args)=>{if(!deferred){deferred=true;entered();await barrier;}return original(...args);};
    const capture=kind==='snapshot'?f.adapter.snapshot({installationId:'a'}):kind==='captureLauncher'?f.adapter.captureLauncher({installationId:'a'}):f.adapter.memory({installationId:'a',kind:'search',body:{project:t.project},authorization:'synthetic-only-marker'});
    await started;
    try {
      await assert.rejects(f.adapter.action({scenario:'fresh_install',phase:'prepare',installationId:'a'}),/in flight/);
      assert.equal(f.state.runCount,0);
    }finally{release();await capture;}
  }));
});

test('assembly-first and action-first share the same exclusion guard',async()=>scoped(async root=>{
  const f=await golden(root),count=f.state.runCount;
  const assembly=f.adapter.assemble(f.scenarios);
  try {await assert.rejects(f.adapter.action({scenario:'fresh_install',phase:'prepare',installationId:'a'}),/in flight/);assert.equal(f.state.runCount,count);}
  finally{await assembly;}
  let release,entered;const started=new Promise(resolve=>{entered=resolve;}),barrier=new Promise(resolve=>{release=resolve;});
  const run=f.effects.run;f.effects.run=async options=>{entered();await barrier;return run(options);};
  const action=f.adapter.action({scenario:'fresh_install',phase:'prepare',installationId:'a'});await started;
  try {
    for(const capture of [()=>f.adapter.snapshot({installationId:'a'}),()=>f.adapter.captureLauncher({installationId:'a'}),()=>f.adapter.memory({installationId:'a'}),()=>f.adapter.assemble(f.scenarios)])await assert.rejects(capture(),/in flight/);
  }finally{release();await action;}
}));

test('every post-dispatch archive failure latches the recorder and preserves its storage error',async t=>{
  for(const [name,index] of [['stdout',4],['stderr',5],['receipt',6]])await t.test(name,async()=>scoped(async root=>{
    const f=setup(root),run=f.effects.run;
    f.effects.run=async options=>{const value=await run(options);await writeFile(join(options.outputDirectory,'raw-'+index+'.bin'),'occupied synthetic archive slot',{flag:'wx'});return value;};
    let error;try{await f.adapter.action({scenario:'fresh_install',phase:'prepare',installationId:'a'});}catch(value){error=value;}
    assert.equal(error?.code,'EEXIST');
    assert.equal(await readFile(join(f.options.outputDirectory,'raw-'+index+'.bin'),'utf8'),'occupied synthetic archive slot');
    await assert.rejects(f.adapter.action({scenario:'fresh_install',phase:'activate',installationId:'a'}),/prior/);
    assert.equal(f.state.runCount,1);
  }));
});

test('failed transport and identity retain their original cause even when error receipt storage fails',async t=>{
  for(const kind of ['transport','identity'])await t.test(kind,async()=>scoped(async root=>{
    const f=setup(root),run=f.effects.run,original=new Error('synthetic original dispatch error');
    f.effects.run=async options=>{
      const value=await run(options);await writeFile(join(options.outputDirectory,'raw-'+(kind==='transport'?4:6)+'.bin'),'occupied error receipt',{flag:'wx'});
      if(kind==='transport')throw original;
      return {...value,identityBytes:Buffer.from('{')};
    };
    let error;try{await f.adapter.action({scenario:'fresh_install',phase:'prepare',installationId:'a'});}catch(value){error=value;}
    assert.equal(error?.evidence_storage_error?.code,'EEXIST');
    if(kind==='transport')assert.equal(error.cause,original);else assert(error.cause instanceof SyntaxError);
    await assert.rejects(f.adapter.action({scenario:'fresh_install',phase:'activate',installationId:'a'}),/prior/);assert.equal(f.state.runCount,1);
  }));
});

test('phase budgets cover supported lifecycle waits without expanding unused installer budgets',async()=>{
 assert.equal(windowsHostActionBudget({scenario:'restart',phase:'start'}),180000);assert.equal(windowsHostActionBudget({scenario:'restart',phase:'stop'}),60000);
 assert.equal(windowsHostActionBudget({scenario:'fresh_install',phase:'prepare'}),300000);
 assert.equal(windowsHostActionBudget({scenario:'fresh_install',phase:'activate'}),900000);
 assert.deepEqual(['preflight','inspect','stop-watchdog','cleanup-retain','cleanup-remove'].map(windowsHostOwnershipBudget),[45000,45000,60000,60000,120000]);
 assert.throws(()=>windowsHostOwnershipBudget('other'));assert.throws(()=>windowsHostActionBudget({scenario:'restart',phase:'activate'}));
 const mcp=await readFile(new URL('../powershell/agentmemory-mcp.ps1',import.meta.url),'utf8'),stop=await readFile(new URL('../powershell/agentmemory-stop.ps1',import.meta.url),'utf8'),watch=await readFile(new URL('../powershell/agentmemory-watch-stop.ps1',import.meta.url),'utf8'),env=await readFile(new URL('../powershell/agentmemory-env.ps1',import.meta.url),'utf8');
 for(const marker of ['Wait-CodexConsumerPresent -TimeoutSeconds 10','UtcNow.AddSeconds(60)','UtcNow.AddSeconds(3)','Wait-ServiceReady -TimeoutSeconds 45','if ($ValidateOnly)'])assert(mcp.includes(marker));
 assert(stop.includes('[int]$TimeoutSeconds = 30'));assert(stop.includes('-TimeoutSec 2'));assert(watch.includes('[int]$TimeoutSeconds = 15'));assert(mcp.includes('-TimeoutSec 2'));assert(env.includes('-TimeoutSec 2'));
 const declaredStartWaitsMs=(10+60+3+45)*1000;const boundedHttpOvershootAllowanceMs=8*4000;assert.equal(declaredStartWaitsMs+boundedHttpOvershootAllowanceMs,150000);assert(180000>declaredStartWaitsMs+boundedHttpOvershootAllowanceMs);
 assert(60000>(30+2)*1000);assert(60000>15*1000);
});
