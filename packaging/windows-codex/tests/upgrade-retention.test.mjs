import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const windows = process.platform === 'win32';
const q = s => "'" + s.replaceAll("'", "''") + "'";
const installer = fileURLToPath(new URL('../Install-WindowsCodex.ps1', import.meta.url));
const helper = fileURLToPath(new URL('../powershell/agentmemory-upgrade-retention.ps1', import.meta.url));
const recycle = fileURLToPath(new URL('../powershell/Complete-ReleaseBackupReview.ps1', import.meta.url));
async function run(script) {
  const temp = await mkdtemp(path.join(tmpdir(), 'am-upgrade-retention-'));
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    const name = key.toUpperCase();
    if (name in env && env[name] !== value) throw Error('Conflicting environment names');
    env[name] = value;
  }
  env.TEMP = temp; env.TMP = temp; env.TMPDIR = temp;
  env.PSMODULEPATH = path.join(env.SYSTEMROOT, 'System32/WindowsPowerShell/v1.0/Modules');
  const prefix = `$ErrorActionPreference='Stop';Set-StrictMode -Version Latest;
. ${q(helper)};. ${q(recycle)};
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile(${q(installer)},[ref]$tokens,[ref]$errors);
if($errors.Count){throw 'Installer parse failed'};
$fn=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Compress-CompletedReleaseBackup'},$true);Invoke-Expression $fn.Extent.Text;
$root=Join-Path ${q(temp)} 'install';
foreach($name in @('config','data','home','scripts','bin','runtime','backups/releases')){[void][IO.Directory]::CreateDirectory((Join-Path $root $name))};
[IO.File]::WriteAllBytes((Join-Path $root 'config/secret.dpapi'),[byte[]]@(0,255,128,42));
[IO.File]::WriteAllText((Join-Path $root '.agentmemory-install-owner.json'),' {"install_nonce":"fixture-owner"}');
[IO.File]::WriteAllBytes((Join-Path $root 'data/state.bin'),[byte[]]@(1,0,255,9));
[IO.File]::WriteAllText((Join-Path $root 'home/auth.json'),'fixture auth');
function Set-Revision([int]$Revision){
 $relative='runtime/0.9.30-codex-r'+$Revision+'/agentmemory';$package=Join-Path $root $relative;[void][IO.Directory]::CreateDirectory($package);
 [IO.File]::WriteAllText((Join-Path $package 'package.json'),'revision '+$Revision);
 $hashes=[ordered]@{};$hashes[$relative+'/package.json']=(Get-FileHash -LiteralPath (Join-Path $package 'package.json') -Algorithm SHA256).Hash;
 $manifest=[pscustomobject]@{install_nonce='fixture-owner';install_root=$root;release_revision='r'+$Revision;data_contract_version=5;package_relative_path=$relative;source_hashes=[pscustomobject]$hashes};
 [IO.File]::WriteAllText((Join-Path $root 'config/install-manifest.json'),($manifest|ConvertTo-Json -Depth 8));return $manifest;
};
function Snapshot($Manifest,[int]$Index){
 $backup=Join-Path $root ('backups/releases/20261016T00000000'+$Index+'Z');[void][IO.Directory]::CreateDirectory($backup);
 $lock=[IO.File]::Open((Join-Path $root 'data/startup.lock'),'OpenOrCreate','ReadWrite','None');
 try {New-AgentMemoryColdRecovery -InstallRoot $root -BackupRoot $backup -PreviousManifest $Manifest -IncludeData}finally{$lock.Dispose()};
 return (Compress-CompletedReleaseBackup -InstallRoot $root -BackupRoot $backup -CreationTicks (Get-Item -LiteralPath $backup).CreationTimeUtc.Ticks).archive;
};
function Get-CimInstance { return @() };function Get-ScheduledTask { return @() };
`;
  try {
    const r = spawnSync(path.join(env.SYSTEMROOT, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', prefix + script],
      { env, encoding: 'utf8', timeout: 60000, windowsHide: true });
    assert.equal(r.status, 0, r.stderr + '\n' + r.stdout);
    return JSON.parse(r.stdout.trim());
  } finally {
    assert.equal(path.dirname(temp), path.resolve(tmpdir()));
    assert.match(path.basename(temp), /^am-upgrade-retention-/);
    await rm(temp, { recursive: true, force: true });
  }
}
const history = `$old=Set-Revision 216;$oldArchive=Snapshot $old 1;
$previous=Set-Revision 217;$archive=Snapshot $previous 2;
$current=Set-Revision 218;
$current|Add-Member upgrade_retention ([pscustomobject]@{schema_version=1;immediate_predecessor=$previous;recovery_archive=$archive;recovery_sha256=(Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash});
[IO.File]::WriteAllText((Join-Path $root 'config/install-manifest.json'),($current|ConvertTo-Json -Depth 12));
`;

test('cold snapshot under the startup lock restores data, secret and home bytes', {skip:!windows}, async()=>{
  const result=await run(`$previous=Set-Revision 217;$archive=Snapshot $previous 1;
$verified=Read-AgentMemoryRecoveryArchive -Path $archive -Nonce 'fixture-owner' -RequireComplete;
$restore=Join-Path (Split-Path -Parent $root) 'restored';[IO.Compression.ZipFile]::ExtractToDirectory($archive,$restore);
@{revision=$verified.release_revision;data=[Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $restore 'data/state.bin')));secret=[Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $restore 'config/secret.dpapi')));home=[IO.File]::ReadAllText((Join-Path $restore 'home/auth.json'));startup_lock=Test-Path -LiteralPath (Join-Path $restore 'data/startup.lock')}|ConvertTo-Json -Compress`);
  assert.deepEqual(result,{revision:'r217',data:Buffer.from([1,0,255,9]).toString('base64'),secret:Buffer.from([0,255,128,42]).toString('base64'),home:'fixture auth',startup_lock:false});
});

test('successive managed revisions retire only r216 and preserve r217 recovery on reinstall', {skip:!windows}, async()=>{
  const result=await run(history+`
$result=Complete-AgentMemoryAutomaticRetention -InstallRoot $root -CurrentManifest $current;
if($result.status -ne 'disposed'){throw ($result|ConvertTo-Json -Depth 8)};
$hash=(Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash;
$transient=Join-Path $root 'backups/releases/20261016T000000003Z';[void][IO.Directory]::CreateDirectory($transient);
New-AgentMemoryColdRecovery -InstallRoot $root -BackupRoot $transient -PreviousManifest $current;
$again=Complete-AgentMemoryAutomaticRetention -InstallRoot $root -CurrentManifest $current -TransientBackup $transient;
@{first=$result.status;first_recycled=$result.recycled.Count;second=$again.status;second_recycled=$again.recycled.Count;runtimes=@(Get-ChildItem -LiteralPath (Join-Path $root 'runtime')|ForEach-Object Name);backups=@(Get-ChildItem -LiteralPath (Join-Path $root 'backups/releases')|ForEach-Object Name);predecessor=$current.upgrade_retention.immediate_predecessor.release_revision;unchanged=((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -eq $hash)}|ConvertTo-Json -Depth 8 -Compress`);
  assert.equal(result.first,'disposed');assert.equal(result.first_recycled,2);
  assert.equal(result.second,'disposed');assert.equal(result.second_recycled,1);
  assert.deepEqual(result.runtimes,['0.9.30-codex-r217','0.9.30-codex-r218']);
  assert.deepEqual(result.backups,['20261016T000000002Z.zip']);
  assert.equal(result.predecessor,'r217');assert.equal(result.unchanged,true);
});

for(const failure of ['changed-recovery','foreign-backup','consumer-pin','changed-runtime']){
 test('retention preserves every set on '+failure,{skip:!windows},async()=>{
  const mutation={
   'changed-recovery':"[IO.File]::AppendAllText($archive,'changed')",
   'foreign-backup':"$foreign=Join-Path $root 'backups/releases/foreign.zip';[IO.File]::WriteAllText($foreign,'unknown')",
   'consumer-pin':"[IO.File]::WriteAllText((Join-Path $root 'config/pins.json'),(Join-Path $root 'runtime/0.9.30-codex-r216'))",
   'changed-runtime':"[IO.File]::AppendAllText((Join-Path $root 'runtime/0.9.30-codex-r216/agentmemory/package.json'),'changed')",
  }[failure];
  const result=await run(history+mutation+`; $result=Complete-AgentMemoryAutomaticRetention -InstallRoot $root -CurrentManifest $current;
@{status=$result.status;recycled=$result.recycled.Count;old_runtime=Test-Path -LiteralPath (Join-Path $root 'runtime/0.9.30-codex-r216');old_archive=Test-Path -LiteralPath $oldArchive;required_archive=Test-Path -LiteralPath $archive}|ConvertTo-Json -Compress`);
  assert.equal(result.status,'incomplete');assert.equal(result.recycled,0);
  assert.equal(result.old_runtime,true);assert.equal(result.old_archive,true);assert.equal(result.required_archive,true);
 });
}
for (const ownerLayout of ['listed','standalone','standalone-extra','standalone-foreign','listed-changed']) {
test('internal junctions and legacy cold descriptor owner layout: '+ownerLayout, {skip:!windows}, async()=>{
  const withJunction=history.replace('$oldArchive=Snapshot $old 1;', `
$package=Join-Path $root $old.package_relative_path;
[void][IO.Directory]::CreateDirectory((Join-Path $package 'store/dependency'));
[IO.File]::WriteAllText((Join-Path $package 'store/dependency/index.js'),'fixture');
[void](New-Item -ItemType Junction -Path (Join-Path $package 'dependency') -Target (Join-Path $package 'store/dependency'));
$old.source_hashes|Add-Member ($old.package_relative_path+'/store/dependency/index.js') ((Get-FileHash -LiteralPath (Join-Path $package 'store/dependency/index.js') -Algorithm SHA256).Hash);
[IO.File]::WriteAllText((Join-Path $root 'config/install-manifest.json'),($old|ConvertTo-Json -Depth 12));
$oldArchive=Snapshot $old 1;
$legacy=Join-Path $root 'backups/legacy-cold';[void][IO.Directory]::CreateDirectory($legacy);
foreach($name in @('config','data','.agentmemory-install-owner.json')){Copy-Item -LiteralPath (Join-Path $root $name) -Destination (Join-Path $legacy $name) -Recurse};
$legacyFiles=@(Get-ChildItem -LiteralPath $legacy -Recurse -File|ForEach-Object { [pscustomobject]@{path=$_.FullName.Substring($legacy.Length+1);bytes=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash} });
${ownerLayout.startsWith('standalone') ? "$legacyFiles=@($legacyFiles|Where-Object path -ne '.agentmemory-install-owner.json');" : ''}
[IO.File]::WriteAllText((Join-Path $legacy 'recovery-set.json'),([pscustomobject]@{schema=1;consistent_after_normal_stop=$true;readback_hash_verified=$true;code_revision='r216';files=$legacyFiles}|ConvertTo-Json -Depth 8));
${ownerLayout==='standalone-extra' ? "[IO.File]::WriteAllText((Join-Path $legacy 'unrecorded.bin'),'must remain protected');" : ''}
${ownerLayout==='standalone-foreign' ? "[IO.File]::WriteAllText((Join-Path $legacy '.agentmemory-install-owner.json'),'{\"install_nonce\":\"foreign-owner\"}');" : ''}
${ownerLayout==='listed-changed' ? "[IO.File]::AppendAllText((Join-Path $legacy '.agentmemory-install-owner.json'),' ');" : ''}
`);
  const result=await run(withJunction+`$result=Complete-AgentMemoryAutomaticRetention -InstallRoot $root -CurrentManifest $current;$result|ConvertTo-Json -Depth 8 -Compress`);
  if (['standalone-extra','standalone-foreign','listed-changed'].includes(ownerLayout)) {
    assert.equal(result.status,'incomplete',JSON.stringify(result));assert.equal(result.recycled.length,0);
    assert.equal(result.unresolved.length,1);
    assert.match(result.unresolved[0].reason,ownerLayout==='standalone-extra' ? /Unrecorded legacy recovery files/ : ownerLayout==='standalone-foreign' ? /Foreign or mismatched legacy recovery/ : /Legacy recovery byte mismatch/);
  } else {
    assert.equal(result.status,'disposed',JSON.stringify(result));assert.equal(result.recycled.length,3);
    assert.equal(result.recycled.every(item=>item.verified),true);
  }
});
}

test('recycle uncertainty stops the next deletion and reports its actual attempt', {skip:!windows}, async()=>{
  const result=await run(history+`
$script:originalRecycle=(Get-Item function:Send-CompletedBackupToRecycleBin).ScriptBlock;$script:calls=0;
function Send-CompletedBackupToRecycleBin {param([string]$Path) $script:calls++; if($script:calls -eq 2){throw 'fixture recycle refusal'}; & $script:originalRecycle -Path $Path};
$result=Complete-AgentMemoryAutomaticRetention -InstallRoot $root -CurrentManifest $current;
@{status=$result.status;recycled=$result.recycled.Count;attempted=$result.attempted.Count;last_original=$result.attempted[-1].original_present;old_archive=Test-Path -LiteralPath $oldArchive;required=Test-Path -LiteralPath $archive}|ConvertTo-Json -Compress`);
  assert.deepEqual(result,{status:'incomplete',recycled:1,attempted:2,last_original:true,old_archive:true,required:true});
});

test('installer snapshots after owned stop and only retires after candidate health',async()=>{
 const {readFile}=await import('node:fs/promises');const source=await readFile(installer,'utf8');
 assert.ok(source.indexOf('Stop-OwnedRuntimeForCutover -Root $root -Registrations $taskRegistrations')<source.indexOf('New-AgentMemoryColdRecovery -InstallRoot'));
 assert.ok(source.indexOf('New-AgentMemoryColdRecovery -InstallRoot')<source.indexOf("$cutoverTouched = $true"));
 assert.ok(source.indexOf("$summary.healthy = $true")<source.indexOf('Complete-AgentMemoryAutomaticRetention -InstallRoot'));
 assert.ok(source.indexOf('Invoke-FreshInstallation -Activate -Execute')<source.indexOf('$previousReleaseManifest ='));
 assert.match(source,/IncludeData:\(\$distinctRevision -and -not \$resumeUpgrade\)/);
 assert.match(source,/if \(\$distinctRevision\) \{\s*\$compaction = Compress-CompletedReleaseBackup/);
 assert.match(source,/if \(\$summary\.release_backup_closeout\.status -eq 'disposed'\) \{[\s\S]*?Get-ReleaseBackupRetentionReview[^\r\n]*-RecoveryPackagePins \$reviewPins -RecoveryPinsReviewed/);
});
for(const consumer of ['forward-slash-process','forward-slash-task']){
 test('normalized '+consumer+' pins preserve all older sets',{skip:!windows},async()=>{
  const override=consumer==='forward-slash-process' ?
   "function Get-CimInstance { [pscustomobject]@{CommandLine=('node '+(Join-Path $root 'runtime/0.9.30-codex-r216/agentmemory/dist/index.js').Replace('\\','/'))} }" :
   "function Get-ScheduledTask { [pscustomobject]@{Actions=@([pscustomobject]@{Execute='node';Arguments=(Join-Path $root 'runtime/0.9.30-codex-r216/agentmemory/dist/index.js').Replace('\\','/');WorkingDirectory=$root})} }";
  const result=await run(history+override+`; $result=Complete-AgentMemoryAutomaticRetention -InstallRoot $root -CurrentManifest $current;@{status=$result.status;recycled=$result.recycled.Count;old=Test-Path -LiteralPath $oldArchive}|ConvertTo-Json -Compress`);
  assert.deepEqual(result,{status:'incomplete',recycled:0,old:true});
 });
}

test('empty reserved rejected directory remains while normal automatic retention converges',{skip:!windows},async()=>{
 const result=await run(history+`[void][IO.Directory]::CreateDirectory((Join-Path $root 'backups/rejected'));
$result=Complete-AgentMemoryAutomaticRetention -InstallRoot $root -CurrentManifest $current;
@{status=$result.status;recycled=$result.recycled.Count;reserved=Test-Path -LiteralPath (Join-Path $root 'backups/rejected')}|ConvertTo-Json -Compress`);
 assert.deepEqual(result,{status:'disposed',recycled:2,reserved:true});
});

test('manifest paths outside managed direct runtime children cannot become protected roots',{skip:!windows},async()=>{
 const result=await run(history+`$current.package_relative_path='../external/agentmemory';[IO.File]::WriteAllText((Join-Path $root 'config/install-manifest.json'),($current|ConvertTo-Json -Depth 12));
$result=Complete-AgentMemoryAutomaticRetention -InstallRoot $root -CurrentManifest $current;@{status=$result.status;recycled=$result.recycled.Count;old=Test-Path -LiteralPath $oldArchive}|ConvertTo-Json -Compress`);
 assert.deepEqual(result,{status:'incomplete',recycled:0,old:true});
});

test('pending failed-cutover recovery preserves its original predecessor and rejects altered bytes',{skip:!windows},async()=>{
 const result=await run(`$previous=Set-Revision 217;$backup=Join-Path $root 'backups/releases/20261016T000000001Z';[void][IO.Directory]::CreateDirectory($backup);
$requirements=Join-Path (Split-Path -Parent $root) 'requirements.toml';[IO.File]::WriteAllText($requirements,'fixture managed requirements');
New-AgentMemoryColdRecovery -InstallRoot $root -BackupRoot $backup -PreviousManifest $previous -IncludeData -ManagedRequirementsPath $requirements;
$candidate=Set-Revision 218;$original=Read-AgentMemoryColdRecoveryDirectory -Path $backup -Nonce 'fixture-owner';
[IO.File]::AppendAllText((Join-Path $backup 'data/state.bin'),'changed');$rejected=$false;try{[void](Read-AgentMemoryColdRecoveryDirectory -Path $backup -Nonce 'fixture-owner')}catch{$rejected=$true};
@{original_revision=$original.release_revision;current_revision=$candidate.release_revision;tampering_rejected=$rejected}|ConvertTo-Json -Compress`);
 assert.deepEqual(result,{original_revision:'r217',current_revision:'r218',tampering_rejected:true});
});


test('top-level recycle preserves an entire nested package and junction without permitting permanent deletion',{skip:!windows},async()=>{
 const {readFile}=await import('node:fs/promises');const source=await readFile(recycle,'utf8');
 assert.match(source,/SetOperationFlags\(0x80000\|0x100000\|0x1000\|0x400\|0x10\|0x4\)/);
 assert.match(source,/PreDeleteItem\(uint f,IShellItem i\)\{return \(f & 0x80\)!=0 \? 0 : unchecked\(\(int\)0x80004004\);\}/);
 const result=await run(`
$folder=Join-Path $root 'runtime/owned-nested-fixture';
$dependency=Join-Path $folder 'agentmemory/node_modules/.pnpm/fixture@1.0.0/node_modules/fixture';
[void][IO.Directory]::CreateDirectory($dependency);
[IO.File]::WriteAllBytes((Join-Path $dependency 'index.bin'),[byte[]]@(0,255,4,128,13,10));
[void][IO.Directory]::CreateDirectory((Join-Path $folder 'agentmemory/empty'));
$junction=Join-Path $folder 'agentmemory/node_modules/fixture';[void](New-Item -ItemType Junction -Path $junction -Target $dependency);
$protected=@((Join-Path $root 'config'),(Join-Path $root 'data'),(Join-Path $root 'home'));
$recycled=Invoke-AgentMemoryRetentionRecycle -Path $folder -ProtectedPaths $protected -PackageJunctions;
$link=Get-Item -LiteralPath (Join-Path $recycled.recycle_path 'agentmemory/node_modules/fixture') -Force;
@{verified=$recycled.verified;source_absent=(-not (Test-Path -LiteralPath $folder));parent_present=Test-Path -LiteralPath (Split-Path -Parent $folder);receipt_present=Test-Path -LiteralPath $recycled.receipt_path;data=[Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $recycled.recycle_path 'agentmemory/node_modules/.pnpm/fixture@1.0.0/node_modules/fixture/index.bin')));empty_present=Test-Path -LiteralPath (Join-Path $recycled.recycle_path 'agentmemory/empty');junction_type=$link.LinkType;junction_target_preserved=(@($link.Target)[0] -ieq $dependency);protected_survived=(@($protected|Where-Object {-not (Test-Path -LiteralPath $_)}).Count -eq 0)}|ConvertTo-Json -Compress`);
 assert.deepEqual(result,{verified:true,source_absent:true,parent_present:true,receipt_present:true,data:Buffer.from([0,255,4,128,13,10]).toString('base64'),empty_present:true,junction_type:'Junction',junction_target_preserved:true,protected_survived:true});
});
