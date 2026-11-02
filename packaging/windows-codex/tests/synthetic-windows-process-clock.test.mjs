import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {powershellEnvironment} from '../npm/cli.mjs';
test('actual cleanup clock comparator uses exact integer microseconds and retains exact recorded birth',async()=>{
 assert.equal(process.env.AGENTMEMORY_INTEGRATION,'0');assert.equal(process.env.AGENTMEMORY_CURATE,'0');
 const root=await mkdtemp(join(process.env.AGENTMEMORY_SYNTHETIC_TEST_ROOT,'clock-'));
 try{
 const script=String.raw`
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($env:CLOCK_SOURCE,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Source parse failed'}
$matches=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Assert-ProcessCreationIdentity'},$false));if($matches.Count -ne 1){throw 'Missing comparator'}
. ([scriptblock]::Create($matches[0].Extent.Text))
$cases=New-Object 'System.Collections.Generic.List[string]'
function D([long]$Ticks){return [DateTime]::new($Ticks,[DateTimeKind]::Utc)}
function Check([string]$Name,[long]$Current,[long]$Recorded,[long]$Cim,[bool]$Expected){$ok=$true;try{Assert-ProcessCreationIdentity ([DateTimeOffset](D $Current)) ([DateTimeOffset](D $Recorded)) (D $Cim)}catch{$ok=$false};if($ok -ne $Expected){throw ('Unexpected '+$Name)};$cases.Add($Name)}
[long]$base=639288448450768520
Check 'exact equality' $base $base $base $true
for([long]$r=1;$r -le 9;$r++){Check ('same API microsecond remainder '+$r) ($base+$r) ($base+$r) $base $true}
Check 'adjacent later microsecond even one tick apart' ($base+9) ($base+9) ($base+10) $false
Check 'previous microsecond rejected' $base $base ($base-10) $false
Check 'different millisecond rejected' ($base+1) ($base+1) ($base-8520) $false
Check 'nonaligned CIM precision rejected' ($base+1) ($base+1) ($base+1) $false
Check 'PID reuse one tick within same microsecond rejected' ($base+1) ($base+2) $base $false
Check 'PID reuse different microsecond rejected' ($base+1) ($base+11) $base $false
Check 'minimum datetime boundary' 0 0 0 $true
Check 'maximum datetime boundary' ([DateTime]::MaxValue.Ticks) ([DateTime]::MaxValue.Ticks) ([DateTime]::MaxValue.Ticks-9) $true
$now=[DateTimeOffset]::Parse('2026-10-29T04:27:25.0768521Z');$offset=[DateTimeOffset]::Parse('2026-10-29T13:27:25.0768521+09:00');$cim=[DateTime]::Parse('2026-10-29T04:27:25.0768520Z',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind)
Assert-ProcessCreationIdentity $now $offset $cim;$cases.Add('equivalent recorded offset')
$bad=[DateTime]::SpecifyKind($cim,[DateTimeKind]::Unspecified);$failed=$false;try{Assert-ProcessCreationIdentity $now $now $bad}catch{$failed=$true};if(-not $failed){throw 'Unspecified zone accepted'};$cases.Add('unknown CIM zone rejected')
$left=($base+1)/10;$right=$base/10;$legacy=[Math]::Floor($left) -eq [Math]::Floor($right);if($legacy){throw 'Captured legacy false-negative not reproduced'};$cases.Add('legacy mixed Double Int64 false-negative reproduced')
[ordered]@{synthetic=$true;production_qualified=$false;cases=@($cases.ToArray());observed_api_counterexample=@{current_ticks=($base+1).ToString();cim_ticks=$base.ToString();legacy_left_type=$left.GetType().FullName;legacy_right_type=$right.GetType().FullName;legacy_equal=$legacy};os_process_queries=0;backend_top_level_executed=$false}|ConvertTo-Json -Depth 6 -Compress
`;
 const command=join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),args=['-NoProfile','-NonInteractive','-Command',script];
 const child=spawnSync(command,args,{windowsHide:true,timeout:15000,encoding:'utf8',env:powershellEnvironment({...process.env,CLOCK_SOURCE:fileURLToPath(new URL('../verification/windows-evidence-cleanup.ps1',import.meta.url)),TEMP:root,TMP:root,TMPDIR:root})});
 console.log(JSON.stringify({command:[command,...args],pid:child.pid,parent_pid:process.pid,exit_code:child.status,stdout:child.stdout,stderr:child.stderr,scope:'AST pure comparator only, no process or product calls'}));assert.ifError(child.error);assert.equal(child.status,0,child.stderr);const result=JSON.parse(child.stdout);assert.equal(result.cases.length,21);assert.equal(result.os_process_queries,0);assert.equal(result.backend_top_level_executed,false);
 }finally{await rm(root,{recursive:true,force:true});}
});
