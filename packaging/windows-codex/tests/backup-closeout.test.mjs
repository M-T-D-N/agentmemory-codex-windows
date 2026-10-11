import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const windows = process.platform === 'win32';
const installer = fileURLToPath(new URL('../Install-WindowsCodex.ps1', import.meta.url));
const helper = fileURLToPath(new URL('../powershell/Complete-ReleaseBackupReview.ps1', import.meta.url));
const q = s => "'" + s.replaceAll("'", "''") + "'";
const identity = revision => ({release_revision:revision,data_contract_version:5,source_package:'runtime/'+revision+'/agentmemory'});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function run(f, script) {
  const env={};
  for(const [key,value] of Object.entries(process.env)) {
    const name=key.toUpperCase();
    if(name in env && env[name]!==value) throw Error('Conflicting environment names');
    env[name]=value;
  }
  env.TEMP=f.temp; env.TMP=f.temp; env.TMPDIR=f.temp;
  env.PSMODULEPATH=path.join(env.SYSTEMROOT,'System32/WindowsPowerShell/v1.0/Modules');
  const prefix=`$ErrorActionPreference='Stop';Set-StrictMode -Version Latest;
. ${q(helper)};
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile(${q(installer)},[ref]$tokens,[ref]$errors);
if($errors.Count){throw 'Installer syntax error'};
$fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-ReleaseBackupRetentionReview'},$true);Invoke-Expression $fn.Extent.Text;
$root=${q(f.root)};$planPath=${q(f.planPath)};
$current=${q(JSON.stringify({...identity('r5'),package_relative_path:identity('r5').source_package}))}|ConvertFrom-Json;$previous=${q(JSON.stringify({...identity('r4'),package_relative_path:identity('r4').source_package}))}|ConvertFrom-Json;
`;
  return spawnSync(path.join(env.SYSTEMROOT,'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',prefix+script],
    {env,encoding:'utf8',timeout:60000,windowsHide:true});
}
async function fixture() {
  const temp=await mkdtemp(path.join(tmpdir(),'am-backup-closeout-'));
  const root=path.join(temp,'install'),releases=path.join(root,'backups/releases'),planPath=path.join(temp,'decisions.json');
  for(const folder of ['config','data','backups/releases']) await mkdir(path.join(root,folder),{recursive:true});
  await writeFile(path.join(root,'config/install-manifest.json'),JSON.stringify({release_revision:'r5',data_contract_version:5,package_relative_path:identity('r5').source_package}));
  await writeFile(path.join(root,'data/protected.bin'),'canonical fixture');
  const f={temp,root,releases,planPath,paths:[]};
  try {
  for(const [index,revision] of ['r4','r3','r2'].entries()) {
    const source=path.join(temp,'input-'+index);
    await mkdir(path.join(source,'config'),{recursive:true});
    await writeFile(path.join(source,'config/install-manifest.json'),JSON.stringify({release_revision:revision,data_contract_version:5,package_relative_path:identity(revision).source_package}));
    await writeFile(path.join(source,'payload.bin'),Buffer.from([0,index,255]));
    const zip=path.join(releases,`20260101T00000000${index}Z.zip`);
    const r=run(f,`Add-Type -AssemblyName System.IO.Compression;Add-Type -AssemblyName System.IO.Compression.FileSystem;
$source=${q(source)};$archive=[IO.Compression.ZipFile]::Open(${q(zip)},[IO.Compression.ZipArchiveMode]::Create);
try {foreach($file in Get-ChildItem -File -Recurse -LiteralPath $source){
  $name=$file.FullName.Substring($source.Length+1).Replace('\\','/');$entry=$archive.CreateEntry($name);
  $input=[IO.File]::OpenRead($file.FullName);$output=$entry.Open();try{$input.CopyTo($output)}finally{$input.Dispose();$output.Dispose()}
}}finally{$archive.Dispose()}`);
    assert.equal(r.status,0,r.stderr);
    f.paths.push(zip);
  }
  f.plan={schema_version:1,current_release:identity('r5'),immediate_predecessor:identity('r4'),
    code_data_recovery:{completed:true,evidence:'controlled fixture: no live data backup',protected_paths:[]},
    consumers_and_publication:{completed:true,evidence:'controlled fixture: no published or active consumers',protected_paths:[]},
    decisions:await Promise.all(f.paths.slice(1).map(async p=>({path:p,action:'recycle',reason:'own finished controlled fixture',sha256:hash(await readFile(p))})))};
  return f;
  } catch(error) {await cleanup(f);throw error;}
}
async function invoke(f, before='', execute=true) {
  await writeFile(f.planPath,JSON.stringify(f.plan));
  const r=run(f,`$review=Get-ReleaseBackupRetentionReview -InstallRoot $root -CurrentManifest $current -PreviousManifest $previous;
if(@($review.entries|Where-Object disposition -eq 'older_distinct_maintenance_candidate').Count -ne 2){throw ($review|ConvertTo-Json -Depth 8)};
${before}
$result=Complete-ReleaseBackupReview -InstallRoot $root -Review $review -DecisionPath $planPath ${execute?'-Execute':''};$result|ConvertTo-Json -Depth 8 -Compress`);
  assert.equal(r.status,0,r.stderr);
  return JSON.parse(r.stdout.trim());
}
async function cleanup(f) {
  assert.equal(path.dirname(f.temp),path.resolve(tmpdir()));
  assert.match(path.basename(f.temp),/^am-backup-closeout-/);
  await rm(f.temp,{recursive:true,force:true});
}

test('real recycle-only closeout twice leaves no older approved ZIPs and protects predecessor/data', {skip:!windows}, async()=>{
  for(let cycle=0;cycle<2;cycle++) {
    const f=await fixture();
    try {
      const originals=await Promise.all(f.paths.map(p=>readFile(p)));
      const result=await invoke(f);
      assert.equal(result.status,'disposed',JSON.stringify(result));
      assert.equal(result.recycled.length,2);
      for(const [index,item] of result.recycled.entries()) {
        assert.equal(item.verified,true);
        assert.deepEqual(await readFile(item.recycle_path),originals[index+1]);
        assert.ok((await readFile(item.receipt_path)).length>28);
        await assert.rejects(readFile(item.path),{code:'ENOENT'});
      }
      assert.deepEqual(await readFile(f.paths[0]),originals[0]);
      assert.equal(await readFile(path.join(f.root,'data/protected.bin'),'utf8'),'canonical fixture');
    } finally {await cleanup(f);}
  }
});

for(const scenario of ['later-changed-bytes','recovery-pin','publication-pin','unknown-predecessor','missing-review','missing-decision','protect-current','changed-install','data-reparse','config-reparse']) {
  test('preflight preserves every ZIP: '+scenario,{skip:!windows},async()=>{
    const f=await fixture();
    try {
      let before='';
      if(scenario==='later-changed-bytes') f.plan.decisions[1].sha256='0'.repeat(64);
      if(scenario==='recovery-pin') f.plan.code_data_recovery.protected_paths=[f.paths[1]];
      if(scenario==='publication-pin') f.plan.consumers_and_publication.protected_paths=[f.paths[2]];
      if(scenario==='unknown-predecessor') before='$review.predecessor_known=$false;';
      if(scenario==='missing-review') f.plan.code_data_recovery.completed=false;
      if(scenario==='missing-decision') f.plan.decisions.pop();
      if(scenario==='protect-current') f.plan.decisions[0].path=f.paths[0];
      if(scenario.endsWith('-reparse')) {
        const folder=scenario.split('-')[0];
        before=`Rename-Item -LiteralPath (Join-Path $root '${folder}') -NewName 'owned-${folder}';New-Item -ItemType Junction -Path (Join-Path $root '${folder}') -Target (Join-Path $root 'owned-${folder}')|Out-Null;`;
      }
      if(scenario==='changed-install') await writeFile(path.join(f.root,'config/install-manifest.json'),JSON.stringify({release_revision:'r6',data_contract_version:5,package_relative_path:'runtime/r6/agentmemory'}));
      const originals=await Promise.all(f.paths.map(p=>readFile(p)));
      const result=await invoke(f,before);
      assert.equal(result.status,'incomplete',JSON.stringify(result));
      const errors={
        'later-changed-bytes':/Approved backup bytes changed/,
        'recovery-pin':/pinned by code_data_recovery/,
        'publication-pin':/pinned by consumers_and_publication/,
        'unknown-predecessor':/actual predecessor/,
        'missing-review':/Missing completed code_data_recovery/,
        'missing-decision':/All reviewed older candidates/,
        'protect-current':/not an older reviewed candidate/,
        'changed-install':/Installation changed/,
        'data-reparse':/Reparse path is protected/,
        'config-reparse':/Reparse path is protected/,
      };
      assert.match(result.error,errors[scenario]);
      assert.equal(result.attempted.length,0);
      assert.equal(result.recycled.length,0);
      for(const [index,p] of f.paths.entries()) assert.deepEqual(await readFile(p),originals[index]);
    } finally {await cleanup(f);}
  });
}

test('explicit retain and dry-run do not recycle files',{skip:!windows},async()=>{
  const f=await fixture();
  try {
    f.plan.decisions[0].action='retain';
    const result=await invoke(f,'',false);
    assert.equal(result.status,'planned');assert.equal(result.recycled.length,0);
    assert.ok(result.retained.some(entry=>entry.path===f.paths[1]));
    for(const p of f.paths) assert.ok((await readFile(p)).length>0);
  } finally {await cleanup(f);}
});

test('unknown backup identity remains unresolved after reviewed scope disposal',{skip:!windows},async()=>{
  const f=await fixture();
  try {
    const unknown=path.join(f.releases,'unidentified.zip');
    await writeFile(unknown,'unknown fixture');
    const result=await invoke(f);
    assert.equal(result.status,'disposed_reviewed_scope_identity_pending');
    assert.deepEqual(result.unresolved,[unknown]);
    assert.equal(await readFile(unknown,'utf8'),'unknown fixture');
  } finally {await cleanup(f);}
});

test('absent plan does not label unknown identity as completed retention',{skip:!windows},async()=>{
  const f=await fixture();
  try {
    const unknown=path.join(f.releases,'unidentified.zip');
    await writeFile(unknown,'unknown fixture');
    const r=run(f,`$review=Get-ReleaseBackupRetentionReview -InstallRoot $root -CurrentManifest $current -PreviousManifest $previous;Complete-ReleaseBackupReview -InstallRoot $root -Review $review|ConvertTo-Json -Depth 8 -Compress`);
    assert.equal(r.status,0,r.stderr);
    const result=JSON.parse(r.stdout.trim());
    assert.equal(result.status,'needs_identity_review');
    assert.deepEqual(result.unresolved,[unknown]);
    assert.equal(result.recycled.length,0);
    for(const p of f.paths) assert.ok((await readFile(p)).length>0);
  } finally {await cleanup(f);}
});

test('simulated refusal after first actual recycle records it and preserves second',{skip:!windows},async()=>{
  const f=await fixture();
  try {
    const result=await invoke(f,`$originalRecycle=(Get-Command Send-CompletedBackupToRecycleBin).ScriptBlock;
function Send-CompletedBackupToRecycleBin([string]$Path){if($Path -eq ${q(f.paths[2])}){throw 'controlled refusal'};& $originalRecycle -Path $Path}`);
    assert.equal(result.status,'incomplete');assert.match(result.error,/controlled refusal/);
    assert.equal(result.recycled.length,1);assert.equal(result.recycled[0].verified,true);
    assert.equal(result.attempted.length,2);assert.equal(result.attempted[0].original_present,false);assert.equal(result.attempted[1].original_present,true);
    assert.ok((await readFile(f.paths[2])).length>0);
    assert.ok((await readFile(result.recycled[0].recycle_path)).length>0);
  } finally {await cleanup(f);}
});
