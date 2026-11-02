import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join,win32} from 'node:path';
import {createHash} from 'node:crypto';
import {windowsOwnershipToolPath} from '../../verification/windows-evidence-host.mjs';
import {hash} from '../../verification/distribution-qualification.mjs';
import {fixedCopyFailure} from '../../verification/windows-fixed-copy-failure.mjs';
export function fixture(root,{failureFixture=true,isolationRoot='D:\\production-contract',rollbackOutcome='rollback_failed',activationStartsRuntime=true}={}){
  let tick=0,pid=5000,run=0,memory=0;const now=()=>new Date(Date.UTC(2026,0,1)+tick++*10).toISOString();const files=new Map(),calls=[],states=new Map(),rows=new Map();let hook=null,ownershipFault=null,afterStop=null;
  const source='class Launcher {}\n',shell='C:\\synthetic-tools\\powershell.exe',node='C:\\synthetic-tools\\node.exe',release=win32.join(isolationRoot,'candidate'),priorRoot=win32.join(isolationRoot,'prior'),sid='S-1-5-21-1001';
  const immutable=['scripts/agentmemory-stop.ps1','scripts/agentmemory-mcp.ps1','scripts/agentmemory-evidence.ps1','scripts/agentmemory-lifecycle.ps1','scripts/agentmemory-watch-stop.ps1','bin/agentmemory-hidden-launcher.exe','src/AgentMemoryHiddenLauncher.cs'].map(path=>{const bytes=Buffer.from(path.endsWith('.cs')?source:'inert '+path);files.set(win32.join(release,'payload',path),bytes);return {path,sha256:hash(bytes)};});
  files.set(win32.join(release,'Install-WindowsCodex.ps1'),Buffer.from("# inert synthetic fixture; never execute\n# Join-Path $PSScriptRoot 'payload\\scripts\\agentmemory-evidence.ps1'\n    $cutoverPhase = 'copy-adapter'\n"));files.set(shell,Buffer.from('inert shell'));files.set(node,Buffer.from('inert node'));files.set(windowsOwnershipToolPath,Buffer.from('inert ownership helper'));
  const m={synthetic:true,evidence_kind:'synthetic_contract',production_qualified:false,product_id:'agentmemory-codex-windows',source_commit:'a'.repeat(40),source_input_digest:'b'.repeat(64),release_revision:'r-current',package_relative_path:'runtime/r-current/agentmemory',adapter_source_hashes:{hidden_launcher:hash(Buffer.from(source)),hidden_launcher_normalized:hash(Buffer.from(source))},release_files:[{path:'Install-WindowsCodex.ps1',sha256:hash(files.get(win32.join(release,'Install-WindowsCodex.ps1')))}],immutable_files:immutable};
  const bytes=Buffer.from(JSON.stringify(m)),manifestHash=hash(bytes);files.set(win32.join(release,'release-manifest.json'),bytes);
  const prior={...m,release_revision:'r-prior'},priorBytes=Buffer.from(JSON.stringify(prior)),priorHash=hash(priorBytes);files.set(win32.join(priorRoot,'release-manifest.json'),priorBytes);
  const installations={a:{root:win32.join(isolationRoot,'a'),owner_sid:sid,install_nonce:null,enroll_fresh:true,allow_root_removal:true,project:'project-a',rest_origin:'http://127.0.0.1:12131'},b:{root:win32.join(isolationRoot,'b'),owner_sid:sid,install_nonce:'b'.repeat(32),project:'project-b',rest_origin:'http://127.0.0.1:12141',predecessor_manifest_sha256:priorHash,predecessor_release_root:priorRoot},f:{root:win32.join(isolationRoot,'f'),owner_sid:sid,install_nonce:'c'.repeat(32),project:'project-f',rest_origin:'http://127.0.0.1:12151',predecessor_manifest_sha256:priorHash,predecessor_release_root:priorRoot}};
  for(const [id,t] of Object.entries(installations))Object.assign(t,{workspace_root:win32.join(isolationRoot,'workspace-'+id),project_registry:win32.join(isolationRoot,'registry-'+id+'.json'),requirements_path:win32.join(isolationRoot,'requirements-'+id+'.json')});
  const plan={execution_id:'11111111-1111-4111-8111-111111111111',synthetic:true,evidence_kind:'synthetic_contract',production_qualified:false,source_commit:m.source_commit,source_input_digest:m.source_input_digest,manifest_sha256:manifestHash,release_root:release,isolation_root:isolationRoot,node_path:node,node_sha256:hash(files.get(node)),windows_e2e:{powershell:{path:shell,sha256:hash(files.get(shell))},ownership_tool:{path:windowsOwnershipToolPath,sha256:hash(files.get(windowsOwnershipToolPath))},installations}};
  if(failureFixture)plan.windows_e2e.failure_fixture={...fixedCopyFailure};
  function installed(id,candidate,status='activated') {const t=installations[id];return {install_root:t.root,install_nonce:t.install_nonce,owner_sid:sid,release_manifest_sha256:candidate?manifestHash:priorHash,release_revision:candidate?m.release_revision:prior.release_revision,package_relative_path:m.package_relative_path,installation_status:status,source_hashes:Object.fromEntries(immutable.map(x=>[x.path.replaceAll('/','\\'),x.sha256]))};}
  function start(s){s.status='active';s.runtime={root:s.t.root,status:'active',run_id:'run-'+(++run),updated_at_utc:now(),...Object.fromEntries(['daemon','worker','engine'].map((role,i)=>[role,{pid:++pid,parent_pid:999,creation_date:now(),executable_path:i?node:shell,command_line:'inert '+role}]))};s.runtime.updated_at_utc=now();}
  for(const id of ['a','b','f']){const t=installations[id];const s={id,t,exists:id!=='a',closed:false,watch:false,watchRecord:null,status:'prepared',activated:id!=='a',installed:id==='a'?null:installed(id,false)};if(id!=='a'){start(s);s.closed=true;}states.set(id,s);}
  function observation(s,operation){
    if(operation==='preflight')return {execution_id:plan.execution_id,installation_id:s.id,install_root:s.t.root,owner_sid:sid,operation,status:s.exists?'prepared':'absent',observed_at_utc:now()};
    const suffix=createHash('sha256').update(sid).digest('hex').slice(0,12)+'-'+new URL(s.t.rest_origin).port;
    const tasks=['daemon','watchdog'].map(kind=>{const name='AgentMemoryCodex-'+(kind==='daemon'?'Daemon':'Watchdog')+'-'+suffix,r={task_name:name,task_path:'\\',owner_sid:sid,install_nonce:s.installed.install_nonce,execute:win32.join(s.t.root,'bin/agentmemory-hidden-launcher.exe'),arguments:kind==='daemon'?'task':'watch',working_directory:s.t.root};return {kind,name,path:'\\',state:!s.activated?'Absent':kind==='daemon'&&s.status==='active'||kind==='watchdog'&&s.watch?'Running':'Ready',registration:r,actual_action:!s.activated?null:{...r},identity_sha256:hash(Buffer.from(JSON.stringify(r)))};});
    const processes=s.runtime?['daemon','worker','engine'].filter(role=>s.runtime[role]).map(role=>({...s.runtime[role],role,state:s.status==='active'?'present':'absent',command_sha256:hash(Buffer.from(s.runtime[role].command_line))})):[];
    if(s.watchRecord)processes.push({...s.watchRecord,state:s.watch?'present':'absent'});
    const o={execution_id:plan.execution_id,installation_id:s.id,install_root:s.t.root,owner_sid:sid,install_nonce:s.installed.install_nonce,operation,observed_at_utc:now(),status:s.status,model_origin:s.closed?'http://127.0.0.1:1/v1':'other',watchdog_active:s.watch,tasks,processes};
    if(operation.startsWith('cleanup-'))Object.assign(o,{status:'retired',root_removed:operation==='cleanup-remove',auth_retained:operation!=='cleanup-remove',tasks_removed:tasks.map(t=>t.name)});
    return o;
  }
  const effects={now,
    read:async path=>{for(const s of states.values()){
      if(path===win32.join(s.t.root,'.agentmemory-install-owner.json')){assert(s.exists);return Buffer.from(JSON.stringify({install_nonce:s.installed.install_nonce,intended_root:s.t.root}));}
      if(path===win32.join(s.t.root,'config/install-manifest.json')){assert(s.exists);return Buffer.from(JSON.stringify(s.installed));}
      if(path===win32.join(s.t.root,'data/runtime-state.json')){assert(s.runtime);return Buffer.from(JSON.stringify(s.runtime));}
      for(const x of immutable)if(path===win32.join(s.t.root,x.path))return Buffer.from(files.get(win32.join(release,'payload',x.path)));
    }assert(files.has(path),'No real read fallback: '+path);return Buffer.from(files.get(path));},
    digest:async path=>hash(await effects.read(path)),
    request:async({url,method,body})=>{calls.push({api:method,url});const u=new URL(url),s=[...states.values()].find(x=>x.t.rest_origin===u.origin);assert(s&&s.status==='active');let result;
      if(u.pathname.endsWith('/remember')){const row={id:'memory-'+(++memory),content:body.content,project:body.project,origin:{channel:'synthetic-contract',capturedAt:now()}};rows.set(row.id,row);result={memory:row};}
      else if(u.pathname.endsWith('/search'))result={results:[...rows.values()].filter(x=>x.project===body.project).map(x=>({observation:{id:x.id,narrative:x.content},project:x.project}))};
      else result={memory:rows.get(decodeURIComponent(u.pathname.split('/').at(-1)))};
      return {status_code:200,bytes:Buffer.from(JSON.stringify(result))};},
    run:async o=>{calls.push({operation:o.operation,scenario:o.scenario,phase:o.phase});if(hook)await hook(o);const launched=now(),created=now(),started=now();let stdout,exit=0;
      if(o.operation){const i=o.command.indexOf('-ContractPath'),contract=JSON.parse(await readFile(o.command[i+1],'utf8')),s=states.get(o.installationId);assert.equal(contract.install_root,s.t.root);assert.equal(contract.owner_sid,sid);
        if(o.operation==='stop-watchdog')s.watch=false;
        if(o.operation.startsWith('cleanup-'))s.status='retired';
        const v=observation(s,o.operation);if(ownershipFault)ownershipFault(v,o,contract);stdout=Buffer.from(JSON.stringify(v));
      } else {const ix=o.command.indexOf('-InstallRoot'),root=ix>=0?o.command[ix+1]:o.command[o.command.indexOf('-Root')+1],s=[...states.values()].find(x=>x.t.root===root);assert(s);let out={};
        if(o.phase==='prepare'){s.exists=true;s.t.install_nonce='a'.repeat(32);s.installed=installed(s.id,true,'prepared');s.status='prepared';out={ready:true,execute:true,install_root:root,operation:'prepare-fresh',prepared:true,service_started:false};}
        else if(o.phase==='activate'){s.activated=true;s.installed.installation_status='activated';if(activationStartsRuntime){start(s);s.watch=true;s.watchRecord={role:'watchdog',pid:++pid,parent_pid:999,creation_date:now(),executable_path:shell,command_sha256:hash(Buffer.from('inert watcher'))};}out={ready:true,execute:true,install_root:root,operation:'activate-prepared',activated:true,service_started:false};}
        else if(o.phase==='stop'){s.status='inactive';s.runtime.status='inactive';s.runtime.terminal_reason='authenticated_external_stop';s.runtime.updated_at_utc=now();out={stopped:true};if(afterStop)afterStop(s);}
        else if(o.phase==='start'){start(s);}
        else if(o.phase==='inject'){
          exit=1;s.status='failed';s.runtime.status='failed';s.installed.installation_status=rollbackOutcome==='rollback_failed'?'rollback_failed':'cutover_failed';
          if(rollbackOutcome==='automatic_rollback'){s.installed=installed(s.id,false);start(s);}
          s.installed.cutover_failure={outcome:rollbackOutcome,phase:'copy-adapter',original_error:'synthetic copy failure',original_error_id:'System.IO.IOException,Microsoft.PowerShell.Commands.CopyItemCommand',original_error_hresult:-2147024864,restoration_completed:rollbackOutcome==='automatic_rollback',runtime_ready:rollbackOutcome==='automatic_rollback',runtime_stopped:rollbackOutcome!=='automatic_rollback',...(rollbackOutcome==='rollback_failed'?{restore_error:'synthetic restore failure'}:{})};
        }
        else {s.installed=installed(s.id,true);start(s);out={ready:true,execute:true,healthy:true,install_root:root,data_action:'preserve',canonical_data:win32.join(root,'data')};}
        stdout=Buffer.from(JSON.stringify(out));
      }
      const id=++pid;return {pid:id,parent_pid:999,launched_at_utc:launched,end_utc:now(),exit_code:exit,pending:false,stdout,stderr:Buffer.from(exit?'synthetic copy failure; synthetic restore failure':''),identityBytes:Buffer.from(JSON.stringify({pid:id,executable:shell,created_at_utc:created,started_at_utc:started,creation_filetime:String(id)}))};}
  };
  const options={plan,manifestBytes:bytes,outputDirectory:join(root,'recording'),execute:true};
  const spec=(scenario,id)=>({scenario,installationId:id,authorization:'synthetic-marker-only',remember:{project:installations[id].project,content:'synthetic memory '+scenario},search:{project:installations[id].project,query:'synthetic memory '+scenario}});
  return {options,effects,calls,states,files,spec,observation,setHook:f=>{hook=f;},setOwnershipFault:f=>{ownershipFault=f;},setAfterStop:f=>{afterStop=f;}};
}
