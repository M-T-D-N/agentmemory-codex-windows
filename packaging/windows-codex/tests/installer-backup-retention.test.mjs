import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const windows = process.platform === 'win32';
const installer = fileURLToPath(new URL('../Install-WindowsCodex.ps1', import.meta.url));
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const binary = Buffer.from([0, 255, 42, 13, 10]);
const manifest = (revision, contract = 4) => ({
  release_revision: revision, data_contract_version: contract,
  package_relative_path: 'packages/' + revision, downstream_version: 'same-version',
});
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const temp = await mkdtemp(path.join(tmpdir(), 'am-retention-'));
  const root = path.join(temp, 'install'), releases = path.join(root, 'backups/releases');
  await mkdir(releases, { recursive: true });
  await mkdir(path.join(root, 'data'));
  await writeFile(path.join(root, 'data/protected.bin'), binary);
  return { temp, root, releases };
}
async function backup(f, id, metadata = manifest('old')) {
  const root = path.join(f.releases, '20260101T000000' + String(id).padStart(3, '0') + 'Z');
  await mkdir(path.join(root, 'config'), { recursive: true });
  await mkdir(path.join(root, 'empty'));
  await writeFile(path.join(root, 'config/install-manifest.json'), JSON.stringify(metadata));
  await writeFile(path.join(root, 'config/settings.json'), '{"setting":1}');
  await writeFile(path.join(root, 'data-snapshot.bin'), binary);
  return root;
}
function run(f, script) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    const name = key.toUpperCase();
    if (name in env && env[name] !== value) throw Error('Conflicting environment names');
    env[name] = value;
  }
  env.TEMP = f.temp; env.TMP = f.temp;
  env.PSMODULEPATH = path.join(env.SYSTEMROOT, 'System32/WindowsPowerShell/v1.0/Modules');
  const command = "$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest; " +
    "if($PSVersionTable.PSVersion.Major -ne 5){throw 'Requires Windows PowerShell 5.1'}; " +
    "$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile(" + quote(installer) + ",[ref]$tokens,[ref]$errors); " +
    "if($errors.Count){throw ($errors|Out-String)}; " +
    "foreach($name in @('Compress-CompletedReleaseBackup','Get-ReleaseBackupRetentionReview')){" +
    "$fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true); Invoke-Expression $fn.Extent.Text}; " +
    "Add-Type -AssemblyName System.IO.Compression; Add-Type -AssemblyName System.IO.Compression.FileSystem; " +
    "$root=" + quote(f.root) + "; " + script;
  return spawnSync(path.join(env.SYSTEMROOT, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { env, encoding: 'utf8', timeout: 30000, windowsHide: true });
}
function compact(f, target, before = '') {
  const result = run(f, "$backup=" + quote(target) + "; " + before +
    "$result=Compress-CompletedReleaseBackup -InstallRoot $root -BackupRoot $backup -CreationTicks (Get-Item -LiteralPath $backup).CreationTimeUtc.Ticks; $result|ConvertTo-Json -Compress");
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
async function protectedData(f) { assert.deepEqual(await readFile(path.join(f.root, 'data/protected.bin')), binary); }
async function cleanup(f) {
  const resolved = path.resolve(f.temp);
  assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
  assert.match(path.basename(resolved), /^am-retention-/);
  await rm(resolved, { recursive: true, force: true });
}

test('exact content reuse preserves every byte and creates no second ZIP', { skip: !windows }, async () => {
  const f = await fixture();
  try {
    const first = await backup(f, 1), archived = compact(f, first);
    const bytes = await readFile(archived.archive), originalHash = digest(bytes);
    const second = await backup(f, 2);
    const reused = compact(f, second);
    assert.equal(reused.archive, archived.archive);
    assert.equal(reused.compacted, true);
    assert.equal(reused.reused_archive, true);
    assert.equal(reused.created_archive, false);
    assert.equal(digest(await readFile(archived.archive)), originalHash);
    assert.deepEqual(await readdir(f.releases), [path.basename(archived.archive)]);
    const restored = path.join(f.temp, 'restored');
    const result = run(f, "[IO.Compression.ZipFile]::ExtractToDirectory(" + quote(archived.archive) + "," + quote(restored) + ")");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await readFile(path.join(restored, 'data-snapshot.bin')), binary);
    assert.equal(await readFile(path.join(restored, 'config/settings.json'), 'utf8'), '{"setting":1}');
    assert.deepEqual(await readdir(path.join(restored, 'empty')), []);
    await protectedData(f);
  } finally { await cleanup(f); }
});

for (const difference of ['config', 'data', 'empty-directory']) {
  test('same version with changed ' + difference + ' is not an exact duplicate', { skip: !windows }, async () => {
    const f = await fixture();
    try {
      const first = compact(f, await backup(f, 1));
      const before = digest(await readFile(first.archive));
      const second = await backup(f, 2);
      if (difference === 'config') await writeFile(path.join(second, 'config/settings.json'), '{"setting":2}');
      if (difference === 'data') await writeFile(path.join(second, 'data-snapshot.bin'), Buffer.from([1, 2, 3]));
      if (difference === 'empty-directory') await mkdir(path.join(second, 'another-empty'));
      const created = compact(f, second);
      assert.equal(created.reused_archive, false);
      assert.equal(created.created_archive, true);
      assert.equal(created.archive, second + '.zip');
      assert.equal(digest(await readFile(first.archive)), before);
      assert.equal((await readdir(f.releases)).length, 2);
      await protectedData(f);
    } finally { await cleanup(f); }
  });
}

test('corrupt and unknown ZIPs remain unchanged while a new ZIP is created', { skip: !windows }, async () => {
  const f = await fixture();
  try {
    const corrupt = path.join(f.releases, '20260101T000000001Z.zip');
    const unknown = path.join(f.releases, 'manual-unknown.zip');
    await writeFile(corrupt, 'corrupt preserved'); await writeFile(unknown, 'unknown preserved');
    const created = compact(f, await backup(f, 2));
    assert.equal(created.created_archive, true);
    assert.equal(await readFile(corrupt, 'utf8'), 'corrupt preserved');
    assert.equal(await readFile(unknown, 'utf8'), 'unknown preserved');
    assert.equal((await readdir(f.releases)).length, 3);
    await protectedData(f);
  } finally { await cleanup(f); }
});

test('selected archive cannot be replaced while owned expanded copy is discarded', { skip: !windows }, async () => {
  const f = await fixture();
  try {
    const first = compact(f, await backup(f, 1));
    const archiveHash = digest(await readFile(first.archive));
    const second = await backup(f, 2);
    const before = "function Remove-Item { param($LiteralPath,[switch]$Recurse,[switch]$Force,$ErrorAction) " +
      "$blocked=$false; try { [IO.File]::WriteAllText(" + quote(first.archive) + ",'changed') } catch { $blocked=$true }; " +
      "if(-not $blocked){throw 'Archive was writable'}; Microsoft.PowerShell.Management\\Remove-Item -LiteralPath $LiteralPath -Recurse:$Recurse -Force:$Force }; ";
    const result = compact(f, second, before);
    assert.equal(result.compacted, true);
    assert.equal(result.reused_archive, true);
    assert.equal(digest(await readFile(first.archive)), archiveHash);
    await protectedData(f);
  } finally { await cleanup(f); }
});

test('reparse backup entry and parent are rejected without changing data', { skip: !windows }, async () => {
  const f = await fixture();
  try {
    const target = await backup(f, 1);
    const result = run(f, "New-Item -ItemType Junction -Path " + quote(path.join(target, 'linked')) + " -Target " + quote(path.join(f.root, 'data')) + "|Out-Null; " +
      "$backup=" + quote(target) + "; Compress-CompletedReleaseBackup -InstallRoot $root -BackupRoot $backup -CreationTicks (Get-Item -LiteralPath $backup).CreationTimeUtc.Ticks");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /reparse/);
    await assert.rejects(readFile(target + '.zip'), { code: 'ENOENT' });
    const alias = path.join(f.temp, 'alias');
    const parent = run(f, "New-Item -ItemType Junction -Path " + quote(alias) + " -Target $root|Out-Null; $aliasBackup=" + quote(path.join(alias, 'backups/releases', path.basename(target))) + "; " +
      "Compress-CompletedReleaseBackup -InstallRoot " + quote(alias) + " -BackupRoot $aliasBackup -CreationTicks (Get-Item -LiteralPath $aliasBackup).CreationTimeUtc.Ticks");
    assert.notEqual(parent.status, 0); assert.match(parent.stderr, /reparse/);
    await protectedData(f);
  } finally { await cleanup(f); }
});

test('retention review uses actual predecessor metadata and never deletes any candidate', { skip: !windows }, async () => {
  const f = await fixture();
  try {
    const old = compact(f, await backup(f, 9, manifest('very-old', 2)));
    const predecessor = compact(f, await backup(f, 1, manifest('actual-previous', 3)));
    const current = await backup(f, 2, manifest('current'));
    const unknown = await backup(f, 3, { release_revision: 'missing-contract' });
    const corrupt = path.join(f.releases, '20260101T000000004Z.zip'); await writeFile(corrupt, 'preserve');
    const before = (await readdir(f.releases)).sort();
    const psManifest = value => "('" + JSON.stringify(value) + "'|ConvertFrom-Json)";
    const result = run(f, "$review=Get-ReleaseBackupRetentionReview -InstallRoot $root -CurrentManifest " + psManifest(manifest('current')) + " -PreviousManifest " + psManifest(manifest('actual-previous', 3)) + "; $review|ConvertTo-Json -Depth 8 -Compress");
    assert.equal(result.status, 0, result.stderr);
    const review = JSON.parse(result.stdout);
    assert.equal(review.automatic_delete, false);
    assert.equal(review.predecessor_known, true);
    assert.equal(review.immediate_predecessor.release_revision, 'actual-previous');
    assert.match(review.data_restore, /Code\/config backups alone cannot restore data/);
    const entries = new Map(review.entries.map(entry => [entry.path, entry]));
    assert.equal(entries.get(old.archive).disposition, 'older_distinct_maintenance_candidate');
    assert.equal(entries.get(predecessor.archive).disposition, 'protect_immediate_predecessor');
    assert.equal(entries.get(current).disposition, 'protect_current_release');
    assert.equal(entries.get(unknown).disposition, 'protected_unknown');
    assert.equal(entries.get(corrupt).disposition, 'protected_unknown');
    assert.deepEqual((await readdir(f.releases)).sort(), before);
    const limited = run(f, "$review=Get-ReleaseBackupRetentionReview -InstallRoot $root -CurrentManifest " + psManifest(manifest('current')) + " -PreviousManifest " + psManifest(manifest('current')) + " -Limit 2; $review|ConvertTo-Json -Depth 8 -Compress");
    assert.equal(limited.status, 0, limited.stderr);
    const bounded = JSON.parse(limited.stdout);
    assert.equal(bounded.predecessor_known, false);
    assert.equal(bounded.immediate_predecessor, null);
    assert.equal(bounded.entries.length, 2);
    assert.equal(bounded.omitted_count, 3);
    assert.equal(bounded.omitted_disposition, 'protected_unreviewed');
    assert.equal(bounded.entries.find(entry => entry.metadata?.release_revision === 'very-old').disposition, 'distinct_candidate_predecessor_unknown');
    assert.deepEqual((await readdir(f.releases)).sort(), before);
    await protectedData(f);
  } finally { await cleanup(f); }
});
test('conflicting and future contracts remain protected even when revision names match', { skip: !windows }, async () => {
  const f = await fixture();
  try {
    const conflicting = await backup(f, 1, manifest('current', 3));
    const future = await backup(f, 2, manifest('future', 5));
    const before = (await readdir(f.releases)).sort();
    const current = "('" + JSON.stringify(manifest('current')) + "'|ConvertFrom-Json)";
    const previous = "('" + JSON.stringify(manifest('previous', 3)) + "'|ConvertFrom-Json)";
    const result = run(f, "$review=Get-ReleaseBackupRetentionReview -InstallRoot $root -CurrentManifest " + current + " -PreviousManifest " + previous + "; $review|ConvertTo-Json -Depth 8 -Compress");
    assert.equal(result.status, 0, result.stderr);
    const review = JSON.parse(result.stdout);
    assert.equal(review.entries.length, 2);
    for (const entry of review.entries) {
      assert.equal(entry.disposition, 'protected_unknown');
      assert.match(entry.error, /conflicts/);
      assert.ok([conflicting, future].includes(entry.path));
    }
    assert.deepEqual((await readdir(f.releases)).sort(), before);
    await protectedData(f);
  } finally { await cleanup(f); }
});

test('reviews realistic source-hash manifests while preserving oversized and malformed metadata', { skip: !windows }, async () => {
  const f = await fixture();
  try {
    const hashes = Object.fromEntries(Array.from({ length: 18000 }, (_, i) => ['runtime/r-old/dependency-' + i + '/file.mjs', 'a'.repeat(64)]));
    const old = await backup(f, 1, { ...manifest('old'), source_hashes: hashes });
    assert.ok((await readFile(path.join(old, 'config/install-manifest.json'))).length > 1024 * 1024);
    const archive = compact(f, old).archive;
    const oversized = await backup(f, 2, { ...manifest('oversized'), padding: 'x'.repeat(16 * 1024 * 1024) });
    const malformed = await backup(f, 3, manifest('malformed'));
    await writeFile(path.join(malformed, 'config/install-manifest.json'), '{invalid');
    const before = (await readdir(f.releases)).sort();
    const result = run(f, "$review=Get-ReleaseBackupRetentionReview -InstallRoot $root -CurrentManifest ('" + JSON.stringify(manifest('current')) + "'|ConvertFrom-Json) -PreviousManifest ('" + JSON.stringify(manifest('previous')) + "'|ConvertFrom-Json); $review|ConvertTo-Json -Depth 8 -Compress");
    assert.equal(result.status, 0, result.stderr);
    const review = JSON.parse(result.stdout), entries = new Map(review.entries.map(entry => [entry.path, entry]));
    assert.equal(entries.get(archive).disposition, 'older_distinct_maintenance_candidate');
    assert.equal(entries.get(oversized).disposition, 'protected_unknown');
    assert.equal(entries.get(malformed).disposition, 'protected_unknown');
    assert.equal(review.automatic_delete, false);
    assert.deepEqual((await readdir(f.releases)).sort(), before);
    await protectedData(f);
  } finally { await cleanup(f); }
});

test('pre-engine startup failure is fresh and does not overwrite a live recorded owner', { skip: !windows }, async () => {
  const f = await fixture();
  try {
    const daemon = fileURLToPath(new URL('../powershell/agentmemory-daemon.ps1', import.meta.url));
    const lifecycle = fileURLToPath(new URL('../powershell/agentmemory-lifecycle.ps1', import.meta.url));
    const result = run(f, ". " + quote(lifecycle) + "; " +
      "$ast=[Management.Automation.Language.Parser]::ParseFile(" + quote(daemon) + ",[ref]$tokens,[ref]$errors); if($errors.Count){throw 'Daemon parse error'}; " +
      "$fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Write-RuntimeState'},$true); Invoke-Expression $fn.Extent.Text; " +
      "$statePath=Join-Path $root 'data/runtime-state.json'; $resolvedRoot=$root; $runId='new-run'; $LauncherPid=1; " +
      "$live=Get-Process -Id $PID; $old=@{run_id='live-run'; status='active'; daemon=@{pid=$PID;creation_date=$live.StartTime.ToUniversalTime().ToString('o')}; engine=$null; worker=$null}; " +
      "$old|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $statePath; " +
      "Write-RuntimeState -Status failed -EngineIdentity $null -WorkerIdentity $null -ErrorMessage 'Reserved AgentMemory ports are already in use: 3114'; " +
      "$preserved=(Get-Content -Raw -LiteralPath $statePath|ConvertFrom-Json).run_id -eq 'live-run'; " +
      "$old.daemon.pid=2147483647; $old|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $statePath; " +
      "Write-RuntimeState -Status failed -EngineIdentity $null -WorkerIdentity $null -ErrorMessage 'Reserved AgentMemory ports are already in use: 3114'; " +
      "$state=Get-Content -Raw -LiteralPath $statePath|ConvertFrom-Json; @{preserved=$preserved;state=$state}|ConvertTo-Json -Depth 6 -Compress");
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.preserved, true);
    assert.equal(output.state.run_id, 'new-run');
    assert.equal(output.state.status, 'failed');
    assert.equal(output.state.engine, null);
    assert.equal(output.state.worker, null);
    assert.match(output.state.error_message, /ports are already in use: 3114/);
    await protectedData(f);
  } finally { await cleanup(f); }
});