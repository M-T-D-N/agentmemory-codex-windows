import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,mkdir,rm,writeFile,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {createSyntheticWindowsExecutionPreparation,createWindowsExecutionPreparation,ensureWindowsEvidenceParents,prepareWindowsIsolatedSupport,windowsPreparationToolPath} from '../verification/windows-execution-preparation.mjs';
import {hash} from '../verification/distribution-qualification.mjs';

async function scoped(fn){assert.equal(process.env.AGENTMEMORY_INTEGRATION,'0');assert.equal(process.env.AGENTMEMORY_CURATE,'0');const root=await mkdtemp(join(process.env.AGENTMEMORY_SYNTHETIC_TEST_ROOT,'preparation-'));try{await fn(root);}finally{await rm(root,{recursive:true,force:true});}}
function fixture(root){
 const shell='C:\\synthetic-tools\\powershell.exe',tool=Buffer.from('inert tool'),exe=Buffer.from('inert host'),slot=join(root,'slot-a'),workspace=join(root,'workspace');
 const plan={synthetic:true,evidence_kind:'synthetic_contract',production_qualified:false,execution_id:'11111111-1111-4111-8111-111111111111',manifest_sha256:'b'.repeat(64),source_commit:'a'.repeat(40),source_input_digest:'c'.repeat(64),isolation_root:root,
 windows_e2e:{powershell:{path:shell,sha256:hash(exe)},preparation_tool:{path:windowsPreparationToolPath,sha256:hash(tool)},installations:{a:{root:slot,enroll_fresh:true,owner_sid:'S-1-5-21-1001',workspace_root:workspace,project_registry:join(workspace,'registry.json'),requirements_path:join(workspace,'managed-requirements.toml'),rest_origin:'http://127.0.0.1:12261'}}}};
 const options={plan,outputDirectory:join(root,'evidence','provider'),execute:true},buffers=[],calls=[];let change=null;
 const secret=Buffer.alloc(32,71).toString('base64');
 const effects={support:async()=>({synthetic:true}),read:async p=>p===shell?exe:tool,run:async o=>{calls.push(o);const bytes=o.operation==='credential'?Buffer.from(secret):Buffer.from(JSON.stringify({configured:true,install_root:slot,install_nonce:'a'.repeat(32),candidate_manifest_sha256:plan.manifest_sha256,config_sha256:'d'.repeat(64)}));buffers.push(bytes);const result={bytes,receipt:{operation:o.operation,pid:31,parent_pid:30,start_utc:'2026-01-01T00:00:00.000Z',end_utc:'2026-01-01T00:00:00.001Z',created_at_utc:'2026-01-01T00:00:00.000Z',exit_code:0,pending:false}};if(change)change(result,o);return result;}};
 return {options,effects,buffers,calls,secret,bound:{installationId:'a',installNonce:'a'.repeat(32)},setChange:fn=>change=fn};
}
test('evidence ancestor creation and isolated support cannot create/overwrite an installation',async t=>{
 for(const mode of ['valid','outside','slot','existing','redirect'])await t.test(mode,()=>scoped(async root=>{
   const isolation=join(root,'isolation'),slot=join(isolation,'slot-a'),workspace=join(isolation,'workspace');const plan={isolation_root:isolation,windows_e2e:{installations:{a:{root:slot,workspace_root:workspace,project_registry:join(workspace,'registry.json'),requirements_path:join(workspace,'managed-requirements.toml')}}}};
   const output=mode==='outside'?join(root,'outside','attempt'):mode==='slot'?join(slot,'evidence','attempt'):join(isolation,'evidence','attempt');
   if(mode==='redirect'){await mkdir(isolation);await import('node:fs/promises').then(fs=>fs.symlink(root,join(isolation,'evidence'),'junction'));}
   if(['outside','slot','redirect'].includes(mode))await assert.rejects(ensureWindowsEvidenceParents(plan,output));
   else {const result=await ensureWindowsEvidenceParents(plan,output);assert.equal(result.installation_roots_created,false);await assert.rejects(lstat(slot),{code:'ENOENT'});await prepareWindowsIsolatedSupport(plan,'a');assert.deepEqual(JSON.parse(await readFile(join(workspace,'registry.json'))),{schema_version:2,projects:[]});await assert.rejects(prepareWindowsIsolatedSupport(plan,'a'));}
   await assert.rejects(lstat(slot),{code:'ENOENT'});
 }));
});
test('one-shot fake provider validates binding, keeps no secret stream and latches all failure outcomes',async t=>{
 for(const mode of ['valid','disabled','foreign','bad-nonce','tampered-tool','pending','nonzero','echo','throw','bad-receipt','bad-birth','provider-throw','storage'])await t.test(mode,()=>scoped(async root=>{
   const f=fixture(root);if(mode==='disabled')f.options.execute=false;
   if(mode==='tampered-tool')f.effects.read=async()=>Buffer.from('changed');
   const api=createSyntheticWindowsExecutionPreparation(f.options,f.effects);
   if(mode==='foreign')f.bound.installationId='foreign';if(mode==='bad-nonce')f.bound.installNonce='wrong';
   if(['disabled','foreign','bad-nonce','tampered-tool'].includes(mode)){await assert.rejects(api.configure(f.bound));assert.equal(f.calls.length,0);return;}
   await api.configure(f.bound);
   if(mode==='pending')f.setChange(r=>{r.receipt.pending=true;});
   if(mode==='nonzero')f.setChange(r=>{r.receipt.exit_code=1;});
   if(mode==='bad-receipt')f.setChange(r=>{r.receipt.error_code=f.secret;});
   if(mode==='bad-birth')f.setChange(r=>{r.receipt.created_at_utc=f.secret;r.receipt.error_code='TIMEOUT';});
   if(mode==='provider-throw')f.setChange(r=>{r.bytes.fill(0);throw new Error(f.secret);});
   if(mode==='storage')await writeFile(join(f.options.outputDirectory,'receipt-2.json'),'preexisting');
   const use=token=>{assert.equal(token,f.secret);if(mode==='throw')throw new Error('do not persist '+token);return mode==='echo'?{echo:token}:{ok:true};};
   if(mode==='valid')assert.deepEqual(await api.withCredential(f.bound,use),{ok:true});
   else {await assert.rejects(api.withCredential(f.bound,use),e=>{assert(!String(e.message).includes(f.secret));return true;});assert(api.status().held);const n=f.calls.length;await assert.rejects(api.withCredential(f.bound,use));assert.equal(f.calls.length,n);}
   assert(f.buffers.every(b=>b.every(x=>x===0)));
   for(const name of await readdir(f.options.outputDirectory))assert(!(await readFile(join(f.options.outputDirectory,name))).includes(Buffer.from(f.secret)));
   assert(f.calls.every(c=>!c.command.includes('-ExecutionPolicy')&&!c.command.join(' ').includes(f.secret)));
 }));
});
test('real preparation factory rejects synthetic promotion before any provider starts',()=>scoped(async root=>{const f=fixture(root);assert.throws(()=>createWindowsExecutionPreparation(f.options));assert.equal(f.calls.length,0);}));
test('launcher and cleanup keep exact argument identity while inheriting Process policy',async()=>{
 const launcher=await readFile(new URL('../launcher/AgentMemoryHiddenLauncher.cs',import.meta.url),'utf8'),cleanup=await readFile(new URL('../verification/windows-evidence-cleanup.ps1',import.meta.url),'utf8');
 for(const name of ['baseArguments','validationArguments']){const body=launcher.match(new RegExp('string\\[\\] '+name+' = new\\[\\] \\{([\\s\\S]*?)\\};'))?.[1];assert(body);assert(!/ExecutionPolicy|Bypass/.test(body));const strings=[...body.matchAll(/"([^"\r\n]*)"/g)].map(m=>m[1]);assert.deepEqual(strings.slice(0,6),['-NoLogo','-NoProfile','-NonInteractive','-WindowStyle','Hidden','-File']);}
 const {assertWindowsLauncherPolicyInheritance}=await import('../verification/windows-execution-preparation.mjs');assertWindowsLauncherPolicyInheritance(Buffer.from(launcher));assert.throws(()=>assertWindowsLauncherPolicyInheritance(Buffer.from(launcher.replace('\"-File\", scriptPath','\"-ExecutionPolicy\", \"Bypass\", \"-File\", scriptPath'))));
 const expected=cleanup.split('\n').find(x=>x.includes('$expected=@('));assert(expected&&!/ExecutionPolicy|Bypass/.test(expected));assert(expected.includes("'-WindowStyle','Hidden','-File'"));
 const {windowsEvidenceEnvironment}=await import('../verification/windows-evidence-host.mjs');assert.equal(windowsEvidenceEnvironment('D:\\synthetic',{SystemRoot:'C:\\Windows',PSExecutionPolicyPreference:'AllSigned'}).PSEXECUTIONPOLICYPREFERENCE,'AllSigned');
});

test('actual preparation backend pure binding/configuration functions reject foreign metadata without DPAPI or filesystem actions',()=>scoped(async root=>{
 const {spawnSync}=await import('node:child_process');const {powershellEnvironment}=await import('../npm/cli.mjs');
 const script=String.raw`
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($env:PREPARATION_SOURCE,[ref]$tokens,[ref]$errors)
if($errors.Count){throw ($errors|Out-String)}
$names=@('Full','EqualPath','Under','Assert-SlotIdentity','Assert-ConfigBinding','New-IsolatedConfiguration','Assert-IsolatedActivatedConfiguration','Assert-ResumeAdmission','Assert-PreparationFileSize','Assert-ActiveWriterAbsence')
foreach($name in $names){$fn=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true));if($fn.Count -ne 1){throw 'Function missing/duplicate'};Invoke-Expression $fn[0].Extent.Text}
function Must-Fail([scriptblock]$Block){$failed=$false;try{&$Block}catch{$failed=$true};if(-not $failed){throw 'Expected refusal'}}
$c=[pscustomobject]@{install_root='D:\synthetic\slot-a';install_nonce=('a'*32);owner_sid='S-1-5-21-1001';candidate_manifest_sha256=('b'*64);workspace_root='D:\synthetic\workspace';project_registry='D:\synthetic\workspace\registry.json';expected_rest_port=12261}
$owner=[pscustomobject]@{intended_root=$c.install_root;install_nonce=$c.install_nonce}
$installed=[pscustomobject]@{install_root=$c.install_root;install_nonce=$c.install_nonce;owner_sid=$c.owner_sid;release_manifest_sha256=$c.candidate_manifest_sha256;installation_status='prepared'}
$cfg=[pscustomobject]@{schema_version=1;workspace_root=$c.workspace_root;project_registry=$c.project_registry;service_ports=[pscustomobject]@{rest=12261;stream=12262;viewer=12263;mcp=12264;engine=58284}}
Assert-SlotIdentity $c $owner $installed
$scoped=New-IsolatedConfiguration $c $installed $cfg
if($scoped.codex_source_root -cne 'D:\synthetic\slot-a\home\.codex' -or $scoped.local_qwen.base_url -cne 'http://127.0.0.1:1/v1' -or $cfg.PSObject.Properties.Name -contains 'local_qwen'){throw 'Config scope or input mutated'}
$cases=@('valid isolated prepared configuration')
$existing=$c|ConvertTo-Json|ConvertFrom-Json;$existing|Add-Member operation 'inspect-existing';$existing|Add-Member expected_installed_manifest_sha256 ('e'*64)
$old=$installed|ConvertTo-Json|ConvertFrom-Json;$old.release_manifest_sha256='e'*64
Assert-SlotIdentity $existing $owner $old;$cases+='exact predecessor admission'
Must-Fail {Assert-SlotIdentity $existing $owner $installed};$cases+='other installed revision rejected'
$existing.operation='configure';Must-Fail {Assert-SlotIdentity $existing $owner $old};$cases+='existing manifest cannot authorize configuration'
$existing.operation='credential';Assert-SlotIdentity $existing $owner $old;$cases+='credential bound to admitted predecessor'
Assert-PreparationFileSize 2492255 33554432;$cases+='actual manifest length fits bounded manifest input'
Must-Fail {Assert-PreparationFileSize 2492255 1048576};$cases+='original manifest length exceeded original default'
Must-Fail {Assert-PreparationFileSize 33554433 33554432};$cases+='oversized manifest rejected'
Must-Fail {Assert-PreparationFileSize 1048577 1048576};$cases+='credential and config default bound retained'
foreach($key in @('install_root','install_nonce','owner_sid','release_manifest_sha256')){$copy=$installed|ConvertTo-Json|ConvertFrom-Json;$copy.$key='foreign';Must-Fail {Assert-SlotIdentity $c $owner $copy};$cases+=('foreign '+$key)}
$upper=$installed|ConvertTo-Json|ConvertFrom-Json;$upper.release_manifest_sha256=$upper.release_manifest_sha256.ToUpperInvariant();Assert-SlotIdentity $c $owner $upper;$cases+='uppercase installed SHA equals lowercase contract'
$changed=$installed|ConvertTo-Json|ConvertFrom-Json;$changed.release_manifest_sha256='c'+$changed.release_manifest_sha256.Substring(1);Must-Fail {Assert-SlotIdentity $c $owner $changed};$cases+='changed SHA digit rejected'
$padded=$installed|ConvertTo-Json|ConvertFrom-Json;$padded.release_manifest_sha256=' '+$padded.release_manifest_sha256;Must-Fail {Assert-SlotIdentity $c $owner $padded};$cases+='padded SHA rejected'
$badContract=$c|ConvertTo-Json|ConvertFrom-Json;$badContract.candidate_manifest_sha256='g'*64;$bad=$installed|ConvertTo-Json|ConvertFrom-Json;$bad.release_manifest_sha256='G'*64;Must-Fail {Assert-SlotIdentity $badContract $owner $bad};$cases+='nonhex equal-fold hashes rejected'
if($installed.PSObject.Properties.Name -contains 'service_ports'){throw 'Actual prepared manifest does not contain config ports'}
Assert-ResumeAdmission $c $installed $cfg @() 'absent';$cases+='unconfigured prepared admission'
foreach($writer in @('present_or_reused','unknown')){Must-Fail {Assert-ResumeAdmission $c $installed $cfg @() $writer};$cases+=('resume '+$writer+' rejected')}
Must-Fail {Assert-ResumeAdmission $c $installed $cfg @('evidence-config-partial.tmp') 'absent'};$cases+='partial temp rejected'
$partial=$cfg|ConvertTo-Json|ConvertFrom-Json;$partial|Add-Member -NotePropertyName local_qwen -NotePropertyValue ([pscustomobject]@{base_url='http://127.0.0.1:1/v1'});Must-Fail {Assert-ResumeAdmission $c $installed $partial @() 'absent'};$cases+='partially configured slot rejected'
$ports=$cfg|ConvertTo-Json|ConvertFrom-Json;$ports.service_ports|Add-Member -NotePropertyName foreign -NotePropertyValue 42;Must-Fail {Assert-ResumeAdmission $c $installed $ports @() 'absent'};$cases+='foreign port rejected'
$ports=$cfg|ConvertTo-Json|ConvertFrom-Json;$ports.service_ports.engine++;Must-Fail {Assert-ResumeAdmission $c $installed $ports @() 'absent'};$cases+='changed engine port rejected'
$installed.installation_status='activated';Must-Fail {New-IsolatedConfiguration $c $installed $cfg};$cases+='already activated rejected for configure'
$scoped=$scoped|ConvertTo-Json -Depth 8|ConvertFrom-Json
Assert-IsolatedActivatedConfiguration $c $installed $scoped;$cases+='valid activated credential scope'
$scoped.local_qwen|Add-Member -NotePropertyName lifecycle_script -NotePropertyValue 'D:\foreign.ps1';Must-Fail {Assert-IsolatedActivatedConfiguration $c $installed $scoped};$cases+='model lifecycle rejected'
$scoped.local_qwen.PSObject.Properties.Remove('lifecycle_script');$scoped.codex_source_root='C:\Users\real\.codex';Must-Fail {Assert-IsolatedActivatedConfiguration $c $installed $scoped};$cases+='real Codex source rejected'
$writers=@([pscustomobject]@{pid=101;creation_filetime='134377326109647806';executable='C:\synthetic\node.exe'},[pscustomobject]@{pid=102;creation_filetime='134377326109647807';executable='C:\synthetic\powershell.exe'})
$observations=@([pscustomobject]@{pid=101;creation_filetime='134377326109647806';state='absent'},[pscustomobject]@{pid=102;creation_filetime='134377326109647807';state='absent'})
Assert-ActiveWriterAbsence $writers $observations;$cases+='active adoption original writers explicitly absent'
foreach($state in @('present','identity_changed','unknown')){$copy=$observations|ConvertTo-Json|ConvertFrom-Json;$copy[1].state=$state;Must-Fail {Assert-ActiveWriterAbsence $writers $copy};$cases+=('active original writer '+$state+' HOLD')}
$copy=$observations|ConvertTo-Json|ConvertFrom-Json;$copy[1].creation_filetime='134377326109647808';Must-Fail {Assert-ActiveWriterAbsence $writers $copy};$cases+='active writer birth mismatch HOLD'
Must-Fail {Assert-ActiveWriterAbsence $writers @($observations[0])};$cases+='active missing original installer observation HOLD'
$cfg.project_registry='D:\foreign.json';Must-Fail {New-IsolatedConfiguration $c ([pscustomobject]@{installation_status='prepared'}) $cfg};$cases+='foreign registry rejected'
[ordered]@{synthetic=$true;production_qualified=$false;cases=$cases;dpapi_calls=0;filesystem_mutations=0;backend_top_level_executed=$false}|ConvertTo-Json -Compress
`;
 const command=join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),args=['-NoProfile','-NonInteractive','-Command',script],started=new Date().toISOString();
 const child=spawnSync(command,args,{windowsHide:true,timeout:15000,encoding:'utf8',env:powershellEnvironment({...process.env,PREPARATION_SOURCE:windowsPreparationToolPath,TEMP:root,TMP:root,TMPDIR:root})});
 console.log(JSON.stringify({command:[command,...args],pid:child.pid,parent_pid:process.pid,started,end_utc:new Date().toISOString(),exit_code:child.status,stdout:child.stdout,stderr:child.stderr,scope:'allowlisted pure AST functions only; backend/Add-Type/DPAPI not executed'}));
 assert.ifError(child.error);assert.equal(child.status,0,child.stderr);const result=JSON.parse(child.stdout);assert.equal(result.cases.length,35);assert.equal(result.dpapi_calls,0);assert.equal(result.backend_top_level_executed,false);
}));

test('one-shot credential guard rejects a second consumer in either in-flight phase',()=>scoped(async root=>{
 const f=fixture(root),api=createSyntheticWindowsExecutionPreparation(f.options,f.effects);await api.configure(f.bound);
 let release,entered;const enteredPromise=new Promise(r=>entered=r),wait=new Promise(r=>release=r);
 const first=api.withCredential(f.bound,async token=>{assert.equal(token,f.secret);entered();await wait;return {ok:true};});
 await enteredPromise;const n=f.calls.length;await assert.rejects(api.withCredential(f.bound,()=>({ok:true})),/in flight/);assert.equal(f.calls.length,n);release();assert.deepEqual(await first,{ok:true});assert.equal(api.status().held,false);
}));

test('preparation diagnostics keep only fixed noncredential fields',async()=>{
 const {parseWindowsPreparationDiagnostic:parse}=await import('../verification/windows-execution-preparation.mjs');
 const good={schema_version:1,stage:'configure-replace',exception_type:'System.ArgumentException',hresult:'80070057'};
 assert.deepEqual(parse(Buffer.from(JSON.stringify(good))),good);
 for(const bad of [{...good,message:'never retain'}, {...good,stage:'credential'}, {...good,stage:'D:\\private'}, {...good,exception_type:'private-token'}, {...good,hresult:'secret'}, {...good,schema_version:2}])assert.equal(parse(Buffer.from(JSON.stringify(bad))),null);
 assert.equal(parse(Buffer.from('arbitrary stderr or stack/path')),null);assert.equal(parse(Buffer.alloc(1025)),null);
});

test('noncredential failure receipt keeps safe diagnostic while credential receipt drops it',()=>scoped(async root=>{
 const d={schema_version:1,stage:'configure-replace',exception_type:'System.IO.IOException',hresult:'80070020'};
 const f=fixture(root),api=createSyntheticWindowsExecutionPreparation(f.options,f.effects);
 f.setChange(r=>{r.receipt.exit_code=1;r.receipt.diagnostic=d;});await assert.rejects(api.configure(f.bound));
 const failed=JSON.parse(await readFile(join(f.options.outputDirectory,'receipt-1.json')));assert.deepEqual(failed.diagnostic,d);assert.equal(failed.exit_code,1);
 const child=join(root,'credential-case');await mkdir(child);const g=fixture(child),second=createSyntheticWindowsExecutionPreparation(g.options,g.effects);await second.configure(g.bound);
 g.setChange(r=>{r.receipt.diagnostic=d;});await second.withCredential(g.bound,()=>({ok:true}));
 const credential=JSON.parse(await readFile(join(g.options.outputDirectory,'receipt-2.json')));assert.equal(Object.hasOwn(credential,'diagnostic'),false);assert.equal(credential.exit_code,0);
}));
