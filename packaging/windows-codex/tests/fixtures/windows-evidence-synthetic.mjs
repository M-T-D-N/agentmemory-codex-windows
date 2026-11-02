import assert from 'node:assert/strict';
import {win32} from 'node:path';
import {hash} from '../../verification/distribution-qualification.mjs';
import {createPreStartCopyFailureInstaller,fixedCopyFailure} from '../../verification/windows-fixed-copy-failure.mjs';

export function fixture(korean=false,isolationRoot=null,rollbackOutcome='rollback_failed') {
  const files=new Map();let index=0,pid=1000;
  const raw=bytes=>{const path='in-memory-'+index++;const data=Buffer.from(bytes);files.set(path,data);return {path,sha256:hash(data)};};
  const bind=value=>raw(JSON.stringify(value));
  const read=ref=>JSON.parse(files.get(ref.path));
  const revise=(ref,change)=>{const x=read(ref);change(x);return bind(x);};
  const tool=raw('inert synthetic tool bytes'),installer=raw("# inert synthetic fixture; never execute\n# Join-Path $PSScriptRoot 'payload\\scripts\\agentmemory-evidence.ps1'\n    $cutoverPhase = 'copy-adapter'\n");
  const stop=raw('inert stop script bytes'),start=raw('inert start script bytes');
  const releaseRoot=isolationRoot?win32.join(isolationRoot,'candidate'):korean?'D:\\synthetic-\uD6C4\uBCF4':'D:\\synthetic-candidate',shell='C:\\synthetic-tools\\powershell.exe';
  const launcher=raw('inert candidate compiler output'),launcherSource=raw('class Launcher {}\n'),bootstrap=raw('inert evidence bootstrap');
  const manifest={evidence_kind:'synthetic_contract',synthetic:true,production_qualified:false,source_commit:'a'.repeat(40),source_input_digest:'b'.repeat(64),release_revision:'r-test',package_relative_path:'runtime/r-test/agentmemory',
    adapter_source_hashes:{hidden_launcher:launcherSource.sha256,hidden_launcher_normalized:launcherSource.sha256},
    release_files:[{path:'Install-WindowsCodex.ps1',sha256:installer.sha256}],
    immutable_files:[{path:'scripts/agentmemory-stop.ps1',sha256:stop.sha256},{path:'scripts/agentmemory-mcp.ps1',sha256:start.sha256},
      {path:'scripts/agentmemory-evidence.ps1',sha256:bootstrap.sha256},{path:'bin/agentmemory-hidden-launcher.exe',sha256:launcher.sha256},{path:'src/AgentMemoryHiddenLauncher.cs',sha256:launcherSource.sha256}]};
  files.set(win32.join(releaseRoot,'payload','src/AgentMemoryHiddenLauncher.cs'),files.get(launcherSource.path));
  const manifestBytes=Buffer.from(JSON.stringify(manifest));
  const identity={source_commit:manifest.source_commit,source_input_digest:manifest.source_input_digest,manifest_sha256:hash(manifestBytes)};
  const targets={
    a:{root:isolationRoot?win32.join(isolationRoot,'a'):korean?'D:\\synthetic-\uC124\uCE58-a':'D:\\synthetic-install-a',install_nonce:'synthetic-a',project:'synthetic-project-a',rest_origin:'http://127.0.0.1:12131',predecessor_manifest_sha256:'d'.repeat(64)},
    b:{root:isolationRoot?win32.join(isolationRoot,'b'):korean?'D:\\synthetic-\uC124\uCE58-b':'D:\\synthetic-install-b',install_nonce:'synthetic-b',project:'synthetic-project-b',rest_origin:'http://127.0.0.1:12141',predecessor_manifest_sha256:'e'.repeat(64)}
  };
  files.set(win32.join(releaseRoot,'payload/scripts/agentmemory-evidence.ps1'),files.get(bootstrap.path));
  for(const t of Object.values(targets))files.set(win32.join(t.root,'scripts/agentmemory-evidence.ps1'),files.get(bootstrap.path));
  const qualification={...identity,windows_e2e:{installations:targets,powershell:{path:shell,sha256:tool.sha256},failure_fixture:{...fixedCopyFailure},raw_root:'D:\\synthetic-captures'}};
  const result={...identity,schema_version:2,evidence_kind:'synthetic_contract',synthetic:true,production_qualified:false,execution_id:'11111111-1111-4111-8111-111111111111',scenarios:{}};
  const time=second=>new Date(Date.UTC(2026,0,1,0,0,second)).toISOString();
  const installed=(target,candidate=true,prepared=false)=>({
    install_root:target.root,install_nonce:target.install_nonce,release_manifest_sha256:candidate?identity.manifest_sha256:target.predecessor_manifest_sha256,
    release_revision:candidate?manifest.release_revision:'predecessor',package_relative_path:manifest.package_relative_path,installation_status:prepared?'prepared':'activated',
    source_hashes:Object.fromEntries(manifest.immutable_files.map(x=>[x.path.replaceAll('/','\\'),x.sha256]))
  });
  const runtime=(target,status,runId,second)=>({root:target.root,status,run_id:runId,updated_at_utc:time(second),terminal_reason:status==='inactive'?'authenticated_external_stop':null,
    ...Object.fromEntries(['daemon','worker','engine'].map(role=>[role,{pid:++pid,creation_date:time(second-1)}]))});
  let caseIndex=0;
  for(const [name,phases] of Object.entries({fresh_install:['prepare','activate'],restart:['stop','start'],managed_update:['update'],failure_recovery:['inject','recover']})) {
    const id=['fresh_install','restart'].includes(name)?'a':'b',target=targets[id],base=caseIndex++*100;
    const common={execution_id:result.execution_id,installation_id:id,install_root:target.root};
    const snapshot=(second,candidate,status,runId='running',prepared=false)=>bind({...common,observed_at_utc:time(second),manifest:bind(installed(target,candidate,prepared)),
      ...(status?{runtime:bind(runtime(target,status,runId,second))}:{})});
    const scenario={success:true,installation_id:id,start_utc:time(base),end_utc:time(base+80),steps:[]};
    let failed;
    const failureDetails={original_error:'synthetic original copy error',original_error_id:'System.IO.IOException,Microsoft.PowerShell.Commands.CopyItemCommand',original_error_hresult:-2147024864,phase:'copy-adapter',outcome:rollbackOutcome,restoration_completed:rollbackOutcome==='automatic_rollback',runtime_ready:rollbackOutcome==='automatic_rollback',runtime_stopped:rollbackOutcome!=='automatic_rollback',...(rollbackOutcome==='rollback_failed'?{restore_error:'synthetic restore failure'}:{})};
    for(let i=0;i<phases.length;i++) {
      const phase=phases[i],at=base+10+i*20,install=!['stop','start'].includes(phase);
      const script=install?'Install-WindowsCodex.ps1':'scripts/agentmemory-'+(phase==='stop'?'stop':'mcp')+'.ps1';
      const scriptRef=install?installer:phase==='stop'?stop:start;
      const command=[shell,'-NoProfile','-NonInteractive','-File',win32.join(install?releaseRoot:target.root,script),
        ...(install?['-ReleaseRoot',releaseRoot,'-InstallRoot',target.root,'-Execute']:['-Root',target.root]),
        ...(phase==='prepare'?['-Fresh']:phase==='activate'?['-ActivatePrepared']:phase==='start'?['-ValidateOnly']:[])];
      const output=phase==='prepare'?{ready:true,execute:true,install_root:target.root,operation:'prepare-fresh',prepared:true,service_started:false}:
        phase==='activate'?{ready:true,execute:true,install_root:target.root,operation:'activate-prepared',activated:true}:
        phase==='stop'?{stopped:true}:
        ['update','recover'].includes(phase)?{ready:true,execute:true,install_root:target.root,healthy:true,data_action:'preserve',canonical_data:win32.join(target.root,'data')}:{};
      const run={...common,scenario:name,phase,pid:++pid,parent_pid:999,created_at_utc:time(at),creation_filetime:String(pid),start_utc:time(at),end_utc:time(at+1),exit_code:phase==='inject'?1:0,command,
        executable:{path:shell,sha256:tool.sha256},script:{path:win32.join(install?releaseRoot:target.root,script),sha256:scriptRef.sha256},
        stdout:{...raw(JSON.stringify(output)),encoding:'utf-8'},stderr:raw(phase==='inject'?'synthetic original copy error and restore failure':'')};
      files.set(shell,files.get(tool.path));files.set(run.script.path,files.get(scriptRef.path));
      if(phase==='inject'){
        run.qualification_fixture={...fixedCopyFailure,base_installer:{...run.script}};
        const bytes=createPreStartCopyFailureInstaller(files.get(installer.path)),path=win32.join(qualification.windows_e2e.raw_root,'pre-start-copy-failure.ps1');files.set(path,bytes);
        run.script={path,sha256:hash(bytes)};command[4]=path;
      }
      const step={phase,process:bind(run),after:snapshot(at+2,phase!=='inject',phase==='prepare'||phase==='inject'?null:phase==='stop'?'inactive':'active',phase==='stop'?'old-run':'new-run',phase==='prepare')};
      if(phase==='inject')step.after=revise(step.after,a=>{a.manifest=revise(a.manifest,m=>{m.cutover_failure=failureDetails;});if(rollbackOutcome==='automatic_rollback')a.runtime=bind(runtime(target,'active','restored-run',at+2));});
      if(phase==='start')step.before=snapshot(at-1,true,'inactive','old-run');
      if(phase==='update')step.before=snapshot(at-1,false,null);
      scenario.steps.push(step);if(phase==='inject')failed=run;
    }
    const last=base+10+(phases.length-1)*20+1;
    const memory={id:'synthetic-'+name,content:'synthetic evidence only',project:target.project,origin:{channel:'synthetic',capturedAt:time(base+1)}};
    const api=(kind,second,body)=>bind({...common,capture_id:'capture-'+index++,observed_at_utc:time(second),status_code:200,
      request:{project:target.project,method:kind==='detail'?'GET':'POST',url:target.rest_origin+(kind==='created'?'/agentmemory/remember':kind==='search'?'/agentmemory/search':'/agentmemory/memories/'+memory.id+'?project='+target.project)},
      response:bind(body)});
    scenario.memory={created:api('created',name==='fresh_install'?last+3:base+1,{memory}),search:api('search',last+4,{results:[{observation:{id:memory.id,narrative:memory.content},project:memory.project}]}),detail:api('detail',last+5,{memory})};
    if(failed)scenario.failure=bind({...failureDetails,stderr:failed.stderr,...(rollbackOutcome==='rollback_failed'?{restore_stderr:failed.stderr}:{}),...(rollbackOutcome==='automatic_rollback'?{restored_state:scenario.steps[0].after}:{})});
    result.scenarios[name]=scenario;
  }
  return {result,qualification,context:{manifestBytes,releaseRoot,load:async path=>{assert(files.has(path),'Unexpected fixture read');return files.get(path);}},files,bind,raw,read,revise};
}
