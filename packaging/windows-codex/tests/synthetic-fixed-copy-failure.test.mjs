import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,mkdir,writeFile,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {powershellEnvironment} from '../npm/cli.mjs';
import {createPreStartCopyFailureInstaller,fixedCopyFailureBlock} from '../verification/windows-fixed-copy-failure.mjs';

const installerPath=new URL('../Install-WindowsCodex.ps1',import.meta.url);
test('fixed fixture derives from current installer and refuses ambiguous or altered boundaries',async t=>{
  const bytes=await readFile(installerPath),original=Buffer.from(bytes),derived=createPreStartCopyFailureInstaller(bytes);
  assert.deepEqual(bytes,original);assert.notDeepEqual(derived,bytes);
  const restored=derived.toString('utf8').replace(fixedCopyFailureBlock,'').replace("Join-Path $ReleaseRoot 'payload\\scripts\\agentmemory-evidence.ps1'","Join-Path $PSScriptRoot 'payload\\scripts\\agentmemory-evidence.ps1'");
  assert.deepEqual(Buffer.from(restored),bytes);
  for(const [name,bad] of Object.entries({
    missing:Buffer.from('no anchor'),duplicate:Buffer.concat([bytes,bytes]),injected:derived,
    invalidUtf8:Buffer.from([0xff])
  }))await t.test(name,()=>assert.throws(()=>createPreStartCopyFailureInstaller(bad)));
});

test('fixed pre-start block causes a real sharing violation then releases only its own scratch file',async()=>{
  assert.equal(process.env.AGENTMEMORY_INTEGRATION,'0');assert.equal(process.env.AGENTMEMORY_CURATE,'0');
  const root=await mkdtemp(join(process.env.AGENTMEMORY_SYNTHETIC_TEST_ROOT,'fixed-copy-'));
  try {
    await mkdir(join(root,'payload','config'),{recursive:true});await mkdir(join(root,'backup'));
    const input=join(root,'payload','config','hook-spec.json'),bytes=Buffer.from('{"synthetic":true}\n');await writeFile(input,bytes);
    const command=[
      "$ErrorActionPreference='Stop';Set-StrictMode -Version Latest",
      "$backupRoot=Join-Path $env:SYNTHETIC_COPY_ROOT 'backup';$payload=Join-Path $env:SYNTHETIC_COPY_ROOT 'payload'",
      'try {',fixedCopyFailureBlock,'}catch{',
      "if($_.Exception.Message -like 'Qualification copy unexpectedly succeeded*'){throw}",
      '[ordered]@{error_id=$_.FullyQualifiedErrorId;exception_type=$_.Exception.GetType().FullName;hresult=$_.Exception.HResult;file_removed=(-not [IO.File]::Exists($qualificationCopyPath))}|ConvertTo-Json -Compress',
      '}'
    ].join('\n');
    const executable=join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),args=['-NoProfile','-NonInteractive','-Command',command],started=new Date().toISOString();
    const child=spawnSync(executable,args,{encoding:'utf8',windowsHide:true,timeout:15000,env:powershellEnvironment({...process.env,TEMP:root,TMP:root,TMPDIR:root,SYNTHETIC_COPY_ROOT:root})});
    console.log(JSON.stringify({scope:'real file API; synthetic payload only; installer top-level never executed',command:[executable,...args],pid:child.pid,parent_pid:process.pid,started,completed:new Date().toISOString(),exit_code:child.status,stdout:child.stdout,stderr:child.stderr}));
    assert.ifError(child.error);assert.equal(child.status,0,child.stderr);
    const result=JSON.parse(child.stdout);assert.equal(result.error_id,'System.IO.IOException,Microsoft.PowerShell.Commands.CopyItemCommand');assert.equal(result.hresult & 0xffff,32);assert.equal(result.file_removed,true);
    assert.deepEqual(await readFile(input),bytes);assert.deepEqual(await readdir(join(root,'backup')),[]);
    await writeFile(join(root,'backup','after-lock.txt'),'synthetic recovery write');
  } finally {await rm(root,{recursive:true,force:true});}
});
