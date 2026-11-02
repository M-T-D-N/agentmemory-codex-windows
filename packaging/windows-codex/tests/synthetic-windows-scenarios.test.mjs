import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join,win32} from 'node:path';
import {coordinateSyntheticWindowsEvidence} from '../verification/windows-evidence-scenarios.mjs';
import {hash} from '../verification/distribution-qualification.mjs';
import {fixture} from './fixtures/windows-evidence-synthetic.mjs';

async function scoped(action){
  assert.equal(process.env.AGENTMEMORY_INTEGRATION,'0');assert.equal(process.env.AGENTMEMORY_CURATE,'0');
  const root=await mkdtemp(join(process.env.AGENTMEMORY_SYNTHETIC_TEST_ROOT,'coordinator-'));
  try{const result=await action(root);await rm(root,{recursive:true,force:true});return result;}
  catch(error){console.error('Retained synthetic coordinator fixture: '+root);throw error;}
}
function setup(root,{fault,captureLauncher=false}={}){
  const x=fixture(false,'D:\\coordinator-contract'),read=x.read,manifest=JSON.parse(x.context.manifestBytes);
  if(fault==='predecessor'){
    const step=x.result.scenarios.managed_update.steps[0],before=read(step.before);
    before.manifest=x.revise(before.manifest,v=>{v.release_manifest_sha256='f'.repeat(64);});step.before=x.bind(before);
  }
  const node='C:\\synthetic-tools\\node.exe';x.files.set(node,Buffer.from('inert synthetic Node'));
  const plan={execution_id:x.result.execution_id,evidence_kind:'synthetic_contract',synthetic:true,production_qualified:false,
    source_commit:manifest.source_commit,source_input_digest:manifest.source_input_digest,manifest_sha256:hash(x.context.manifestBytes),
    release_root:x.context.releaseRoot,isolation_root:'D:\\coordinator-contract',node_path:node,node_sha256:hash(x.files.get(node)),windows_e2e:structuredClone(x.qualification.windows_e2e)};
  for(const [id,t] of Object.entries(plan.windows_e2e.installations)){
    Object.assign(t,{workspace_root:win32.join(plan.isolation_root,'workspace-'+id),project_registry:win32.join(plan.isolation_root,'workspace-'+id,'registry.json'),requirements_path:win32.join(plan.isolation_root,'requirements-'+id+'.toml')});
    for(const [path,text] of [['bin/agentmemory-hidden-launcher.exe','inert candidate compiler output'],['src/AgentMemoryHiddenLauncher.cs','class Launcher {}\n']])x.files.set(win32.join(t.root,path),Buffer.from(text));
  }
  const queues=new Map(),clocks=[],requests=[],specs={},calls=[];
  const enqueue=(path,bytes)=>{if(!queues.has(path))queues.set(path,[]);queues.get(path).push(Buffer.from(bytes));};
  const snapshot=(ref,t,runtime)=>{
    const state=read(ref);enqueue(win32.join(t.root,'config/install-manifest.json'),x.files.get(state.manifest.path));
    if(runtime){assert(state.runtime);enqueue(win32.join(t.root,'data/runtime-state.json'),x.files.get(state.runtime.path));}
    clocks.push(state.observed_at_utc);return state;
  };
  let runCount=0,requestCount=0;
  for(const [name,source] of Object.entries(x.result.scenarios)){
    const t=plan.windows_e2e.installations[source.installation_id];
    specs[name]={installationId:source.installation_id,remember:{project:t.project,content:'synthetic evidence only'},search:{project:t.project,query:'synthetic evidence only'},memoryId:'synthetic-'+name,
      ...(name==='managed_update' && captureLauncher?{captureLauncher:true}:{}),...(source.failure?{failure:{...read(source.failure)}}:{})};
    if(specs[name].failure){delete specs[name].failure.stderr;delete specs[name].failure.restore_stderr;}
    clocks.push(source.start_utc);
    const memory=kind=>{const v=read(source.memory[kind]);requests.push({name,kind,value:v});clocks.push(fault==='stale' && name==='restart' && kind==='search'?source.start_utc:v.observed_at_utc);};
    if(name!=='fresh_install')memory('created');
    let prior;
    for(const step of source.steps){
      let before;
      if(['start','update','recover'].includes(step.phase))before=snapshot(step.before??prior,t,step.phase==='start');
      if(step.phase==='update' && captureLauncher)clocks.push(before.observed_at_utc,before.observed_at_utc);
      const after=read(step.after);
      if(step.phase==='update' && captureLauncher)clocks.push(after.observed_at_utc,after.observed_at_utc);
      snapshot(step.after,t,!['prepare','inject'].includes(step.phase));prior=step.after;
    }
    if(name==='fresh_install')memory('created');memory('search');memory('detail');clocks.push(source.end_utc);
  }
  const effects={
    now:()=>{assert(clocks.length,'No fallback clock');return clocks.shift();},
    digest:async path=>{assert(x.files.has(path));return hash(x.files.get(path));},
    read:async path=>{
      if(fault==='state-read' && runCount===1 && path.endsWith('install-manifest.json'))throw new Error('synthetic state capture failed');
      if(queues.has(path)){const q=queues.get(path);assert(q.length,'No unplanned state replay');return q.shift();}
      assert(x.files.has(path),'No real read fallback');return Buffer.from(x.files.get(path));
    },
    run:async options=>{
      runCount++;calls.push(options.scenario+'/'+options.phase);const source=x.result.scenarios[options.scenario].steps.find(s=>s.phase===options.phase),v=read(source.process);
      if(fault==='storage' && runCount===1)await writeFile(join(options.outputDirectory,'raw-4.bin'),'synthetic occupied stdout slot',{flag:'wx'});
      return {pid:v.pid,parent_pid:v.parent_pid,launched_at_utc:v.created_at_utc,end_utc:v.end_utc,exit_code:fault==='null-exit' && runCount===1?null:fault==='nonzero' && runCount===1?7:v.exit_code,pending:fault==='null-exit' && runCount===1,
        stdout:Buffer.from(x.files.get(v.stdout.path)),stderr:Buffer.from(x.files.get(v.stderr.path)),identityBytes:Buffer.from(JSON.stringify({pid:v.pid,created_at_utc:v.created_at_utc,creation_filetime:v.creation_filetime,started_at_utc:v.start_utc,executable:v.executable.path}))};
    },
    request:async options=>{
      requestCount++;const q=requests.shift();assert(q,'No unplanned API response replay');assert.equal(options.url,q.value.request.url);assert.equal(options.method,q.value.request.method);
      return {status_code:fault==='api' && requestCount===1?503:q.value.status_code,bytes:Buffer.from(x.files.get(q.value.response.path))};
    }
  };
  const options={plan,manifestBytes:x.context.manifestBytes,outputDirectory:join(root,'captures'),effects,scenarios:specs,authorization:'synthetic-auth-marker-only'};
  return {options,x,calls,clocks,requests,queues,counts:()=>({runCount,requestCount})};
}

test('coordinator runs fixed independent synthetic cases and delegates final acceptance',async()=>scoped(async root=>{
  const f=setup(root),result=await coordinateSyntheticWindowsEvidence(f.options);
  assert.deepEqual(f.calls,['fresh_install/prepare','fresh_install/activate','restart/stop','restart/start','managed_update/update','failure_recovery/inject','failure_recovery/recover']);
  assert.equal(result.synthetic,true);assert.equal(result.production_qualified,false);assert.equal(result.verification.acceptance,'synthetic_contract');
  assert.equal(f.clocks.length,0);assert.equal(f.requests.length,0);for(const q of f.queues.values())assert.equal(q.length,0);
  assert(result.coordinator_trace.every(x=>x.status==='captured'));
  const failure=JSON.parse(await readFile(result.result.scenarios.failure_recovery.failure.path,'utf8'));
  assert.equal(failure.original_error,'synthetic original copy error');assert.equal(failure.restore_error,'synthetic restore failure');assert.notEqual(failure.original_error,failure.restore_error);assert.deepEqual(failure.stderr,failure.restore_stderr);
  console.log(JSON.stringify({synthetic:true,production_qualified:false,action_trace:f.calls,verification:result.verification.acceptance}));
}));

test('coordinator refuses production, missing effects, injected adapters and phase overrides before dispatch',async t=>{
  for(const name of ['production','effects','adapter','missing','duplicate','target'])await t.test(name,async()=>scoped(async root=>{
    const f=setup(root),o=f.options;
    if(name==='production')o.plan.synthetic=false;
    if(name==='effects')o.effects={read:o.effects.read};
    if(name==='adapter')o.adapter={action:()=>assert.fail('Must not invoke injected adapter')};
    if(name==='missing')o.scenarios.fresh_install.steps=['prepare'];
    if(name==='duplicate')o.scenarios.restart.phases=['stop','stop'];
    if(name==='target')o.scenarios.managed_update.installationId='foreign';
    await assert.rejects(coordinateSyntheticWindowsEvidence(o));assert.equal(f.counts().runCount,0);
  }));
});

test('coordinator stops immediately on original action/state/storage failure',async t=>{
  for(const fault of ['null-exit','nonzero','state-read','storage'])await t.test(fault,async()=>scoped(async root=>{
    const f=setup(root,{fault});let error;try{await coordinateSyntheticWindowsEvidence(f.options);}catch(e){error=e;}
    assert(error?.cause);assert.equal(f.counts().runCount,1);assert.equal(f.counts().requestCount,0);assert.equal(error.coordinator_trace.at(-1).status,'failed');
    if(fault==='storage')assert.equal(error.cause.code,'EEXIST');
    if(fault==='state-read')assert.equal(error.cause.message,'synthetic state capture failed');
    if(fault==='null-exit')assert(error.cause.receipt);
  }));
});

test('coordinator refuses a failed API before advancing to the next contract case',async()=>scoped(async root=>{
  const f=setup(root,{fault:'api'});let error;try{await coordinateSyntheticWindowsEvidence(f.options);}catch(e){error=e;}
  assert.equal(f.counts().runCount,2);assert.equal(f.counts().requestCount,1);assert.equal(error.cause.message,'Synthetic API returned 503');assert(error.cause.receipt);
}));

test('coordinator does not turn stale, wrong predecessor or incomplete rollback into acceptance',async t=>{
  for(const fault of ['stale','predecessor','restore'])await t.test(fault,async()=>scoped(async root=>{
    const f=setup(root,{fault});if(fault==='restore')f.options.scenarios.failure_recovery.failure.restore_error='';
    let error;try{await coordinateSyntheticWindowsEvidence(f.options);}catch(e){error=e;}
    assert(error?.cause);assert.equal(error.coordinator_trace.at(-1).operation,'assemble');assert.equal(error.coordinator_trace.at(-1).status,'failed');
  }));
});

test('coordinator connects existing optional launcher captures to updater evidence',async()=>scoped(async root=>{
  const f=setup(root,{captureLauncher:true}),result=await coordinateSyntheticWindowsEvidence(f.options);
  assert.equal(result.verification.acceptance,'synthetic_contract');
  assert.deepEqual(result.coordinator_trace.filter(x=>x.operation.startsWith('launcher.')).map(x=>x.operation),['launcher.before','launcher.after','launcher.proof']);
  const state=JSON.parse(await readFile(result.result.scenarios.managed_update.steps[0].after.path,'utf8'));assert(state.launcher_preservation);
}));
