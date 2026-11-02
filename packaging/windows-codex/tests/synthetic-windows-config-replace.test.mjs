import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {powershellEnvironment} from '../npm/cli.mjs';

test('actual Windows replacement preserves locks and distinguishes null binding from a held duplicate',async()=>{
 assert.equal(process.env.AGENTMEMORY_INTEGRATION,'0');assert.equal(process.env.AGENTMEMORY_CURATE,'0');
 const root=await mkdtemp(join(process.env.AGENTMEMORY_REPLACE_FIXTURE_ROOT,'replace-'));
 const source=new URL('../verification/windows-evidence-preparation.ps1',import.meta.url);
 const script=String.raw`
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$source=Get-Content -LiteralPath $env:PREPARATION_SOURCE -Raw -Encoding UTF8
$native=[regex]::Match($source,"(?s)Add-Type -TypeDefinition @'\r?\n(.*?)\r?\n'@").Groups[1].Value
if(-not $native){throw 'Native source missing'};Add-Type -TypeDefinition $native
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($env:PREPARATION_SOURCE,[ref]$tokens,[ref]$errors);if($errors.Count){throw 'Backend parse error'}
foreach($name in @('Full','EqualPath','Under','LockParents','Assert-PreparationFileSize','ReadLocked','Sha')){$fn=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$false));if($fn.Count -ne 1){throw 'Source function missing'};. ([scriptblock]::Create($fn[0].Extent.Text))}
$function=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Replace-PreparedConfiguration'},$false))
if($function.Count -eq 1){$body=$function[0].Body.Extent.Text;$body=$body.Substring(1,$body.Length-2)}
else{$start=$source.IndexOf('        # No in-place write:');$end=$source.IndexOf('        [Console]::Out.Write', $start);if($start -lt 0 -or $end -le $start){throw 'Current replacement sequence missing'};$body=$source.Substring($start,$end-$start)}
$body=$body -replace 'param\([^\r\n]*\)\r?\n',''
$body=$body -replace '\breturn ,\$actual\b','$null=$actual'
$results=@();$modes=@('source-exact','null-unlocked','typed-unlocked','null-locked','typed-locked','typed-duplicate-one','typed-duplicate-all')
foreach($mode in $modes){
 $case=Join-Path $env:REPLACE_FIXTURE_ROOT ([string]($results.Count+1));$configDir=Join-Path $case 'config';$raw=Join-Path $case 'evidence';[IO.Directory]::CreateDirectory($configDir)|Out-Null;[IO.Directory]::CreateDirectory($raw)|Out-Null
 $configPath=Join-Path $configDir 'codex-workspace.json';$owner=Join-Path $case 'owner.json';$manifest=Join-Path $configDir 'install-manifest.json';$contract=Join-Path $raw 'contract.json';$identity=Join-Path $raw 'identity.json'
 [byte[]]$configBytes=([Text.UTF8Encoding]::new($false)).GetBytes(('{}'+(' '*589)));[byte[]]$bytes=([Text.UTF8Encoding]::new($false)).GetBytes(('{}'+(' '*846)))
 [IO.File]::WriteAllBytes($configPath,$configBytes);[IO.File]::WriteAllText($owner,'{}');[IO.File]::WriteAllText($manifest,('{}'+(' '*2492253)));[IO.File]::WriteAllText($contract,'{}')
 $locks=New-Object 'System.Collections.Generic.List[System.IDisposable]';$temp=$null;$stage='setup';$ok=$false;$exception=$null;$hresult=$null;$released=0
 try{
  if($mode -notlike '*unlocked'){$stage='read-locks';$null=ReadLocked $contract;LockParents $identity;$null=ReadLocked $owner;$null=ReadLocked $manifest 33554432;$null=ReadLocked $configPath;if($mode -like '*duplicate*'){$null=ReadLocked $configPath}}
  $sequence=$body
  if($mode -like 'null-*'){$sequence=$sequence.Replace('[NullString]::Value','$null')}
  elseif($mode -like 'typed-*'){$sequence=$sequence.Replace('[IO.File]::Replace($temp,$configPath,$null)','[IO.File]::Replace($temp,$configPath,[NullString]::Value)')}
  if($mode -like '*duplicate-all'){$sequence=$sequence.Replace('break}}','}}')}
  $sequence=$sequence.Replace('$f=[IO.File]::Open','$stage=''temp-write'';$f=[IO.File]::Open').Replace('for($i=$locks.Count-1','$stage=''release-config'';for($i=$locks.Count-1').Replace('if((Sha ([IO.File]::ReadAllBytes','$stage=''compare-original'';if((Sha ([IO.File]::ReadAllBytes').Replace('[IO.File]::Replace($temp','$stage=''replace'';[IO.File]::Replace($temp').Replace('$actual=ReadLocked','$stage=''verify'';$actual=ReadLocked')
  Invoke-Expression $sequence
  if((Sha ([IO.File]::ReadAllBytes($configPath))) -cne (Sha $bytes)){throw 'Replacement bytes differ'};$ok=$true;$stage='complete'
 }catch{$exception=$_.Exception.GetBaseException().GetType().FullName;$hresult=$_.Exception.GetBaseException().HResult.ToString('X8')}
 finally{for($i=$locks.Count-1;$i -ge 0;$i--){$locks[$i].Dispose()}}
 $results+=@([ordered]@{mode=$mode;success=$ok;stage=$stage;exception_type=$exception;hresult=$hresult;config_is_original=((Sha ([IO.File]::ReadAllBytes($configPath))) -ceq (Sha $configBytes));config_is_new=((Sha ([IO.File]::ReadAllBytes($configPath))) -ceq (Sha $bytes));temp_retained=($null -ne $temp -and [IO.File]::Exists($temp));config_path_length=$configPath.Length;manifest_bytes=2492255})
}
[ordered]@{synthetic=$true;production_qualified=$false;source_sha256=(Get-FileHash -LiteralPath $env:PREPARATION_SOURCE -Algorithm SHA256).Hash;effective_policy=[string](Get-ExecutionPolicy);process_policy=[Environment]::GetEnvironmentVariable('PSExecutionPolicyPreference','Process');process_id=$PID;observed_at_utc=[DateTime]::UtcNow.ToString('o');real_file_API=$true;credential_calls=0;ACL_changes=0;task_operations=0;cases=$results}|ConvertTo-Json -Depth 5 -Compress
`;
 try{
  const command=join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),args=['-NoProfile','-NonInteractive','-Command',script],started=new Date().toISOString();
  const child=spawnSync(command,args,{encoding:'utf8',windowsHide:true,timeout:30000,env:powershellEnvironment({...process.env,PREPARATION_SOURCE:source.pathname.replace(/^\//,'').replaceAll('/','\\'),REPLACE_FIXTURE_ROOT:root,TEMP:root,TMP:root,TMPDIR:root})});
  console.log(JSON.stringify({command:[command,...args],pid:child.pid,parent_pid:process.pid,start_utc:started,end_utc:new Date().toISOString(),exit_code:child.status,stdout:child.stdout,stderr:child.stderr,scope:'real Windows filesystem APIs on task-owned synthetic files; backend top-level/DPAPI/ACL/tasks not invoked'}));
  assert.ifError(child.error);assert.equal(child.status,0,child.stderr);const result=JSON.parse(child.stdout),by=Object.fromEntries(result.cases.map(x=>[x.mode,x]));
  assert.equal(by['source-exact'].success,true);assert.equal(by['null-unlocked'].success,false);assert.equal(by['null-unlocked'].exception_type,'System.ArgumentException');assert.equal(by['typed-unlocked'].success,true);assert.equal(by['null-locked'].success,false);assert.equal(by['typed-locked'].success,true);assert.equal(by['typed-duplicate-one'].success,false);assert.equal(by['typed-duplicate-all'].success,true);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('actual configure backend emits only fixed diagnostics for sharing failure and succeeds after handle release',async()=>{
 assert.equal(process.env.AGENTMEMORY_INTEGRATION,'0');assert.equal(process.env.AGENTMEMORY_CURATE,'0');
 const {parseWindowsPreparationDiagnostic}=await import('../verification/windows-execution-preparation.mjs');
 const root=await mkdtemp(join(process.env.AGENTMEMORY_REPLACE_FIXTURE_ROOT,'backend-'));
 const source=new URL('../verification/windows-evidence-preparation.ps1',import.meta.url).pathname.replace(/^\//,'').replaceAll('/','\\');
 const script=String.raw`
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$base=$env:REPLACE_FIXTURE_ROOT;$root=Join-Path $base 'fixture';$raw=Join-Path $base 'evidence';$workspace=Join-Path $base 'workspace'
foreach($d in @((Join-Path $root 'config'),$raw,$workspace)){[IO.Directory]::CreateDirectory($d)|Out-Null}
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$nonce='a'*32;$manifest='b'*64
function WriteJson($Path,$Value){[IO.File]::WriteAllText($Path,($Value|ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))}
WriteJson (Join-Path $root 'owner-unused.json') @{}
WriteJson (Join-Path $root '.agentmemory-install-owner.json') @{intended_root=$root;install_nonce=$nonce}
WriteJson (Join-Path $root 'config\install-manifest.json') @{install_root=$root;install_nonce=$nonce;owner_sid=$sid;release_manifest_sha256=$manifest;installation_status='prepared'}
$config=Join-Path $root 'config\codex-workspace.json'
WriteJson $config @{schema_version=1;workspace_root=$workspace;project_registry=(Join-Path $workspace 'registry.json');service_ports=@{rest=12261;stream=12262;viewer=12263;mcp=12264;engine=58284}}
$contract=Join-Path $raw 'contract.json';$identity=Join-Path $raw 'identity.json'
WriteJson $contract @{schema_version=1;operation='configure';execution_id='11111111-1111-4111-8111-111111111111';install_nonce=$nonce;candidate_manifest_sha256=$manifest;owner_sid=$sid;install_root=$root;isolation_root=$base;raw_root=$raw;workspace_root=$workspace;project_registry=(Join-Path $workspace 'registry.json');expected_rest_port=12261}
$hash=(Get-FileHash -LiteralPath $contract -Algorithm SHA256).Hash.ToLowerInvariant();$hold=$null;$global:LASTEXITCODE=0
try{if($env:REPLACE_HOLD -eq '1'){$hold=[IO.File]::Open($config,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)};& $env:PREPARATION_SOURCE -ContractPath $contract -ContractSha256 $hash -IdentityPath $identity -Operation configure -Execute;$code=$LASTEXITCODE}
finally{if($hold){$hold.Dispose()}}
exit $code
`;
 try{
  for(const hold of ['1','0']){
   const path=join(root,'case-'+hold);await mkdir(path);const command=join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),args=['-NoProfile','-NonInteractive','-Command',script],start=new Date().toISOString();
   const child=spawnSync(command,args,{encoding:'buffer',windowsHide:true,timeout:30000,env:powershellEnvironment({...process.env,PREPARATION_SOURCE:source,REPLACE_FIXTURE_ROOT:path,REPLACE_HOLD:hold,TEMP:path,TMP:path,TMPDIR:path})});
   console.log(JSON.stringify({synthetic:true,production_qualified:false,command:[command,...args],pid:child.pid,parent_pid:process.pid,start_utc:start,end_utc:new Date().toISOString(),exit_code:child.status,hold_duplicate:hold==='1',stdout:child.stdout?.toString('utf8'),stderr:child.stderr?.toString('utf8'),scope:'actual configure backend in synthetic files only; no DPAPI/ACL/task/live slot effects'}));assert.ifError(child.error);
   if(hold==='1'){assert.equal(child.status,1);assert.deepEqual(parseWindowsPreparationDiagnostic(child.stderr),{schema_version:1,stage:'configure-replace',exception_type:'System.IO.IOException',hresult:'80070020'});assert.equal(child.stdout.length,0);}
   else {assert.equal(child.status,0);assert.equal(child.stderr.length,0);assert.equal(JSON.parse(child.stdout).configured,true);}
  }
 }finally{await rm(root,{recursive:true,force:true});}
});

test('retained source atomic handle replacement preserves source identity and rejects both-side sharing or mutation',async()=>{
 assert.equal(process.env.AGENTMEMORY_INTEGRATION,'0');assert.equal(process.env.AGENTMEMORY_CURATE,'0');
 const root=await mkdtemp(join(process.env.AGENTMEMORY_REPLACE_FIXTURE_ROOT,'retained-'));
 const source=new URL('../verification/windows-evidence-preparation.ps1',import.meta.url).pathname.replace(/^\//,'').replaceAll('/','\\');
 const script=String.raw`$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$source=Get-Content -LiteralPath $env:PREPARATION_SOURCE -Raw -Encoding UTF8
$native=[regex]::Match($source,"(?s)Add-Type -TypeDefinition @'\r?\n(.*?)\r?\n'@").Groups[1].Value;Add-Type -TypeDefinition $native
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($env:PREPARATION_SOURCE,[ref]$tokens,[ref]$errors);if($errors.Count){throw ($errors|Out-String)}
foreach($name in @('Full','EqualPath','Under','LockParents','Assert-PreparationFileSize','ReadLocked','Sha','Read-StreamBytes','Replace-RetainedConfiguration')){$fn=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$false));if($fn.Count -ne 1){throw 'Function missing'};. ([scriptblock]::Create($fn[0].Extent.Text))}
$results=@()
foreach($mode in @('valid','held-source','held-destination','changed-source','changed-destination','source-swap-locked')) {
 $base=Join-Path $env:REPLACE_FIXTURE_ROOT $mode;$configDir=Join-Path $base 'config';[IO.Directory]::CreateDirectory($configDir)|Out-Null
 $configPath=Join-Path $configDir 'codex-workspace.json';$temp=Join-Path $configDir 'evidence-config-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.tmp';$owner=Join-Path $base 'owner.json';$manifest=Join-Path $configDir 'install-manifest.json'
 $configBytes=[Text.Encoding]::UTF8.GetBytes('baseline configuration');$bytes=[Text.Encoding]::UTF8.GetBytes('retained exact configuration')
 [IO.File]::WriteAllBytes($configPath,$configBytes);[IO.File]::WriteAllBytes($temp,$bytes);[IO.File]::WriteAllText($owner,'{}');[IO.File]::WriteAllText($manifest,'{}')
 $locks=New-Object 'System.Collections.Generic.List[System.IDisposable]';$extra=$null;$held=$null;$ok=$false;$type=$null;$hr=$null;$swapBlocked=$null;$writeBlocked=$null;$nativeError=$null
 try {
  $null=ReadLocked $owner;$null=ReadLocked $manifest
  if($mode -eq 'changed-destination'){[IO.File]::WriteAllText($configPath,'changed by other writer')}
  $null=ReadLocked $configPath
  if($mode -eq 'held-source'){$extra=[IO.File]::Open($temp,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)}
  if($mode -eq 'held-destination'){$extra=[IO.File]::Open($configPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)}
  if($mode -eq 'changed-source'){[IO.File]::WriteAllText($temp,'changed source')}
  if($mode -eq 'source-swap-locked') {
   $held=[EvidencePreparationHandles]::ReplacementFile($temp,$true);$id=[EvidencePreparationHandles]::Id($held.SafeFileHandle)
   $swapBlocked=$false;try{[IO.File]::Move($temp,$temp+'.foreign')}catch{$swapBlocked=$true}
   $writeBlocked=$false;try{[IO.File]::WriteAllText($temp,'attack')}catch{$writeBlocked=$true}
   if(-not $swapBlocked -or -not $writeBlocked -or [EvidencePreparationHandles]::Id($held.SafeFileHandle) -cne $id -or (Sha (Read-StreamBytes $held)) -cne (Sha $bytes)){throw 'Source lock did not prevent swap/write'}
   $ok=$true
  }else {$actual=Replace-RetainedConfiguration $configPath $temp $configBytes $bytes;if((Sha $actual) -cne (Sha $bytes)){throw 'Result mismatch'};$ok=$true}
 } catch {$errorBase=$_.Exception.GetBaseException();$type=$errorBase.GetType().FullName;$hr=$errorBase.HResult.ToString('X8');if($errorBase -is [ComponentModel.Win32Exception]){$nativeError=$errorBase.NativeErrorCode}}
 finally {if($held){$held.Dispose()};if($extra){$extra.Dispose()};for($i=$locks.Count-1;$i -ge 0;$i--){$locks[$i].Dispose()}}
 $results+=@([ordered]@{mode=$mode;success=$ok;exception_type=$type;hresult=$hr;temp_exists=[IO.File]::Exists($temp);config_is_baseline=((Sha ([IO.File]::ReadAllBytes($configPath))) -ceq (Sha $configBytes));config_is_new=((Sha ([IO.File]::ReadAllBytes($configPath))) -ceq (Sha $bytes));source_swap_blocked=$swapBlocked;source_write_blocked=$writeBlocked;native_error=$nativeError})
}
[ordered]@{synthetic=$true;production_qualified=$false;pid=$PID;observed_at_utc=[DateTime]::UtcNow.ToString('o');cases=$results;actual_slot_accesses=0;credential_calls=0;task_operations=0;ACL_changes=0}|ConvertTo-Json -Depth 5 -Compress
`;
 try{
  const command=join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),args=['-NoProfile','-NonInteractive','-Command',script],start=new Date().toISOString();
  const child=spawnSync(command,args,{encoding:'utf8',windowsHide:true,timeout:30000,env:powershellEnvironment({...process.env,PREPARATION_SOURCE:source,REPLACE_FIXTURE_ROOT:root,TEMP:root,TMP:root,TMPDIR:root})});
  console.log(JSON.stringify({command:[command,...args],pid:child.pid,parent_pid:process.pid,start_utc:start,end_utc:new Date().toISOString(),exit_code:child.status,stdout:child.stdout,stderr:child.stderr,scope:'retained source/destination actual Windows file API on generated files only'}));
  assert.ifError(child.error);assert.equal(child.status,0,child.stderr);const cases=Object.fromEntries(JSON.parse(child.stdout).cases.map(x=>[x.mode,x]));
  assert.equal(cases.valid.success,true);assert.equal(cases.valid.temp_exists,false);assert.equal(cases.valid.config_is_new,true);
  for(const name of ['held-source','held-destination','changed-source','changed-destination']){assert.equal(cases[name].success,false,JSON.stringify(cases[name]));assert.equal(cases[name].temp_exists,true);assert.equal(cases[name].config_is_new,false);}
  assert.equal(cases['held-source'].native_error,32);assert.equal(cases['held-destination'].native_error,5);
  assert.equal(cases['source-swap-locked'].success,true);assert.equal(cases['source-swap-locked'].source_swap_blocked,true);assert.equal(cases['source-swap-locked'].source_write_blocked,true);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('retained configure backend validates exact transformation and consumes the existing temp without a new temp',async()=>{
 assert.equal(process.env.AGENTMEMORY_INTEGRATION,'0');assert.equal(process.env.AGENTMEMORY_CURATE,'0');
 const {parseWindowsPreparationDiagnostic}=await import('../verification/windows-execution-preparation.mjs');
 const root=await mkdtemp(join(process.env.AGENTMEMORY_REPLACE_FIXTURE_ROOT,'retained-backend-'));
 const source=new URL('../verification/windows-evidence-preparation.ps1',import.meta.url).pathname.replace(/^\//,'').replaceAll('/','\\');
 const script=String.raw`$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$base=$env:REPLACE_FIXTURE_ROOT;$root=Join-Path $base 'fixture';$raw=Join-Path $base 'evidence';$workspace=Join-Path $base 'workspace'
foreach($d in @((Join-Path $root 'config'),$raw,$workspace)){[IO.Directory]::CreateDirectory($d)|Out-Null}
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($env:PREPARATION_SOURCE,[ref]$tokens,[ref]$errors);if($errors.Count){throw 'Backend parse error'}
foreach($name in @('Full','EqualPath','Assert-ConfigBinding','New-IsolatedConfiguration')){$fn=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$false));. ([scriptblock]::Create($fn[0].Extent.Text))}
function WriteJson($Path,$Value){[IO.File]::WriteAllText($Path,($Value|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))}
function HashBytes([byte[]]$B){$h=[Security.Cryptography.SHA256]::Create();try{return [BitConverter]::ToString($h.ComputeHash($B)).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}}
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$nonce='a'*32;$manifest='b'*64
$installed=[pscustomobject][ordered]@{install_root=$root;install_nonce=$nonce;owner_sid=$sid;release_manifest_sha256=$manifest;installation_status='prepared'}
WriteJson (Join-Path $root '.agentmemory-install-owner.json') ([ordered]@{intended_root=$root;install_nonce=$nonce})
WriteJson (Join-Path $root 'config\install-manifest.json') $installed
$config=Join-Path $root 'config\codex-workspace.json';$retained=Join-Path $root 'config\evidence-config-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.tmp'
$cfg=[pscustomobject][ordered]@{schema_version=1;workspace_root=$workspace;project_registry=(Join-Path $workspace 'registry.json');service_ports=[pscustomobject][ordered]@{rest=12261;stream=12262;viewer=12263;mcp=12264;engine=58284}}
WriteJson $config $cfg
$c=[pscustomobject][ordered]@{schema_version=1;operation='configure-retained';execution_id='11111111-1111-4111-8111-111111111111';install_nonce=$nonce;candidate_manifest_sha256=$manifest;owner_sid=$sid;install_root=$root;isolation_root=$base;raw_root=$raw;workspace_root=$workspace;project_registry=$cfg.project_registry;expected_rest_port=12261;expected_config_sha256=(HashBytes ([IO.File]::ReadAllBytes($config)))}
$desired=([Text.UTF8Encoding]::new($false)).GetBytes(((New-IsolatedConfiguration $c $installed $cfg)|ConvertTo-Json -Depth 8));[IO.File]::WriteAllBytes($retained,$desired)
$c|Add-Member -NotePropertyName retained_temp -NotePropertyValue ([ordered]@{path=$retained;bytes=$desired.Length;sha256=(HashBytes $desired)})
if($env:RETAINED_MODE -eq 'changed-source'){[IO.File]::WriteAllText($retained,'changed')}
if($env:RETAINED_MODE -eq 'extra-temp'){[IO.File]::WriteAllText((Join-Path $root 'config\evidence-config-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.tmp'),'extra')}
if($env:RETAINED_MODE -eq 'changed-baseline'){$c.expected_config_sha256='f'*64}
$contract=Join-Path $raw 'contract.json';WriteJson $contract $c;$hash=HashBytes ([IO.File]::ReadAllBytes($contract));$identity=Join-Path $raw 'identity.json';$held=$null;$global:LASTEXITCODE=0
try{
 if($env:RETAINED_MODE -eq 'held-source'){$held=[IO.File]::Open($retained,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)}
 if($env:RETAINED_MODE -eq 'held-destination'){$held=[IO.File]::Open($config,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)}
 & $env:PREPARATION_SOURCE -ContractPath $contract -ContractSha256 $hash -IdentityPath $identity -Operation configure-retained -Execute
 $code=$LASTEXITCODE
}finally{if($held){$held.Dispose()}}
exit $code
`;
 try{
  for(const mode of ['valid','held-source','held-destination','changed-source','changed-baseline','extra-temp']){
   const path=join(root,mode);await mkdir(path);const command=join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),args=['-NoProfile','-NonInteractive','-Command',script],start=new Date().toISOString();
   const child=spawnSync(command,args,{encoding:'buffer',windowsHide:true,timeout:30000,env:powershellEnvironment({...process.env,PREPARATION_SOURCE:source,REPLACE_FIXTURE_ROOT:path,RETAINED_MODE:mode,TEMP:path,TMP:path,TMPDIR:path})});
   console.log(JSON.stringify({command:[command,...args],pid:child.pid,parent_pid:process.pid,start_utc:start,end_utc:new Date().toISOString(),exit_code:child.status,mode,stdout:child.stdout?.toString('utf8'),stderr:child.stderr?.toString('utf8'),scope:'retained configure actual backend on generated metadata only; no real slot/DPAPI/ACL/tasks'}));
   assert.ifError(child.error);
   const config=join(path,'fixture/config/codex-workspace.json'),temp=join(path,'fixture/config/evidence-config-'+('a'.repeat(32))+'.tmp');
   if(mode==='valid'){assert.equal(child.status,0,child.stderr?.toString());assert.equal(child.stderr.length,0);assert.equal(JSON.parse(child.stdout).configured,true);await assert.rejects(readFile(temp),{code:'ENOENT'});const v=JSON.parse(await readFile(config));assert.equal(v.local_qwen.base_url,'http://127.0.0.1:1/v1');}
   else {assert.equal(child.status,1);assert.equal(child.stdout.length,0);assert(parseWindowsPreparationDiagnostic(child.stderr));assert(!Object.hasOwn(JSON.parse(await readFile(config)),'local_qwen'));assert((await readFile(temp)).length>0);}
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
