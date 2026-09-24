import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs, validateDescriptor, verifyArchive, sha256, powershellArgs, powershellEnvironment } from '../npm/cli.mjs';

const packaging = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const windows = process.platform === 'win32';
const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const input = ['--install-root', 'C:\\Install Space', '--workspace-root', 'D:\\Work', '--project-registry', 'D:\\Work\\projects.json'];

test('strict CLI input keeps paths as literal arguments and requires explicit execution', () => {
  assert.deepEqual(parseArgs(input), { 'install-root': 'C:\\Install Space', 'workspace-root': 'D:\\Work', 'project-registry': 'D:\\Work\\projects.json' });
  for (const suffix of [['--execute', '--execute'], ['--fresh', '--activate-prepared'], ['--wat'], ['--archive', '..\\bad'], ['--archive', '\\\\server\\bad']]) {
    assert.throws(() => parseArgs([...input, ...suffix]));
  }
  assert.throws(() => parseArgs(['--install-root', 'C:\\x"; bad']));
  const args = powershellArgs('C:\\dir space\\install.ps1', { InstallRoot: 'C:\\dir space', Execute: true });
  assert.equal(args.at(-2), 'C:\\dir space');
  assert.equal(args.at(-1), '-Execute');
});

test('descriptor pins the downstream repository, version, source and hashes', () => {
  const d = { schema_version: 1, product_id: 'agentmemory-codex-windows', version: '0.1.0-preview.4', source_commit: 'a'.repeat(40),
    archive_sha256: 'b'.repeat(64), manifest_sha256: 'c'.repeat(64), archive_bytes: 10,
    url: 'https://github.com/M-T-D-N/agentmemory-codex-windows/releases/download/v0.1.0-preview.4/agentmemory-codex-windows-0.1.0-preview.4-win32-x64.zip' };
  assert.equal(validateDescriptor(d), d);
  for (const patch of [{ url: 'https://example.com/runtime.zip' }, { source_commit: 'HEAD' }, { archive_bytes: -1 }, { product_id: '@agentmemory/agentmemory' }, { archive_sha256: '' }]) {
    assert.throws(() => validateDescriptor({ ...d, ...patch }));
  }
});

test('archive verification rejects tampering and truncated downloads', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'am-zip-test-'));
  try {
    const file = path.join(dir, 'runtime.zip');
    await writeFile(file, 'verified bytes');
    const d = { archive_bytes: 14, archive_sha256: await sha256(file) };
    await verifyArchive(file, d);
    await writeFile(file, 'tampered bytes');
    await assert.rejects(verifyArchive(file, d), /integrity/);
    await writeFile(file, 'short');
    await assert.rejects(verifyArchive(file, d), /integrity/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

function runInstaller(release, root, workspace, extra = []) {
  return spawnSync(ps, powershellArgs(path.join(release, 'Install-WindowsCodex.ps1'), {
    ReleaseRoot: release, InstallRoot: root, WorkspaceRoot: workspace, ProjectRegistry: path.join(workspace, 'projects.json'),
    NodePath: process.execPath, ManagedRequirementsPath: path.join(workspace, 'global-requirements.toml'),
  }).concat(extra), { encoding: 'utf8', timeout: 60_000, windowsHide: true, env: powershellEnvironment() });
}

async function fixture(dataContractVersion) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'am-fresh-test-')));
  const release = path.join(dir, 'release'), workspace = path.join(dir, 'workspace'), root = path.join(dir, 'install space');
  await mkdir(path.join(release, 'payload/config'), { recursive: true });
  await mkdir(workspace);
  await writeFile(path.join(workspace, 'projects.json'), '{"schema_version":2,"projects":[]}');
  for (const name of ['Install-WindowsCodex.ps1', 'Initialize-WindowsCodex.ps1']) await copyFile(path.join(packaging, name), path.join(release, name));
  for (const name of ['hook-spec.json', 'mcp-launcher-environment.json']) await copyFile(path.join(packaging, 'config', name), path.join(release, 'payload/config', name));
  const manifest = { schema_version: 1, product: 'AgentMemory for Codex on Windows', product_id: 'agentmemory-codex-windows',
    downstream_version: '0.1.0-preview.4', agentmemory_version: '0.9.29', release_revision: 'r84', source_commit: 'a'.repeat(40),
    package_relative_path: 'runtime/0.9.29-codex-r84/agentmemory', release_files: [], immutable_files: [] };
  if (dataContractVersion !== undefined) manifest.data_contract_version = dataContractVersion;
  for (const name of ['Install-WindowsCodex.ps1', 'Initialize-WindowsCodex.ps1']) manifest.release_files.push({ path: name, sha256: await sha256(path.join(release, name)) });
  for (const name of ['hook-spec.json', 'mcp-launcher-environment.json']) manifest.immutable_files.push({ path: `config/${name}`, sha256: await sha256(path.join(release, 'payload/config', name)) });
  await writeFile(path.join(release, 'release-manifest.json'), JSON.stringify(manifest));
  return { dir, release, workspace, root };
}

for (const floor of [2, 3]) test('data-contract downgrade is rejected before backups, runtime actions or data changes (floor ' + floor + ')', { skip: !windows }, async () => {
  const f = await fixture(floor);
  try {
    const prepared = runInstaller(f.release, f.root, f.workspace, ['-Fresh', '-Execute']);
    assert.equal(prepared.status, 0, prepared.stderr);
    const installedPath = path.join(f.root, 'config/install-manifest.json');
    const installed = JSON.parse(await readFile(installedPath, 'utf8'));
    assert.equal(installed.data_contract_version, floor);
    installed.installation_status = 'activated';
    await writeFile(installedPath, JSON.stringify(installed));
    const before = await readFile(installedPath, 'utf8');
    const dataPath = path.join(f.root, 'data/canonical-fixture');
    await writeFile(dataPath, 'archived original');
    const releasePath = path.join(f.release, 'release-manifest.json');
    const release = JSON.parse(await readFile(releasePath, 'utf8'));
    if (floor === 2) delete release.data_contract_version;
    else release.data_contract_version = 2;
    await writeFile(releasePath, JSON.stringify(release));
    const rejected = runInstaller(f.release, f.root, f.workspace, ['-Execute']);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Runtime downgrade cannot read/);
    assert.equal(await readFile(installedPath, 'utf8'), before);
    assert.equal(await readFile(dataPath, 'utf8'), 'archived original');
    await assert.rejects(readdir(path.join(f.root, 'backups/releases')), { code: 'ENOENT' });
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('managed worker checks data compatibility and failed cutover before importing package code', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'am-worker-contract-'));
  try {
    for (const part of ['bin', 'config', 'runtime/package/dist']) await mkdir(path.join(dir, part), { recursive: true });
    const worker = path.join(dir, 'bin/agentmemory-worker.mjs');
    await copyFile(path.join(packaging, 'node/agentmemory-worker.mjs'), worker);
    const marker = path.join(dir, 'imported');
    await writeFile(path.join(dir, 'runtime/package/dist/cli.mjs'), 'import {writeFileSync} from "node:fs"; writeFileSync(process.env.AM_WORKER_TEST_MARKER,"imported"); throw Error("fixture entry reached");');
    for (const [required, supported, status, allowed] of [[2, 1, 'activated', false], [3, 2, 'activated', false], [3, 3, 'activated', true], [4, 3, 'activated', false], [4, 4, 'activated', true], [2, 2, 'cutover_failed', false],
      ['2', 2, 'activated', false], [null, 2, 'activated', false], [2, null, 'activated', false],
      [2, 2, 'activated', true], [undefined, undefined, undefined, true]]) {
      await rm(marker, { force: true });
      await writeFile(path.join(dir, 'config/install-manifest.json'), JSON.stringify({ package_relative_path: 'runtime/package',
        data_contract_version: required, installation_status: status }));
      await writeFile(path.join(dir, 'runtime/package/package.json'), JSON.stringify({ agentmemoryDownstream: { dataContractVersion: supported } }));
      const result = spawnSync(process.execPath, [worker], { encoding: 'utf8', timeout: 10_000, windowsHide: true,
        env: { ...process.env, AGENTMEMORY_PACKAGE_DIR: '', AGENTMEMORY_STOP_FILE: path.join(dir, 'stop'), AGENTMEMORY_STOP_TOKEN: 'fixture', AM_WORKER_TEST_MARKER: marker } });
      assert.notEqual(result.status, 0);
      if (allowed) {
        assert.match(result.stderr, /fixture entry reached/);
        assert.equal(await readFile(marker, 'utf8'), 'imported');
      } else {
        assert.match(result.stderr, /data contract|cutover requires completion/);
        await assert.rejects(readFile(marker), { code: 'ENOENT' });
      }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const currentContract of [1, 2]) test(`failed candidate start preserves writes and blocks predecessor restart (contract ${currentContract})`, { skip: !windows }, async () => {
  const f = await fixture(2);
  try {
    const manifestPath = path.join(f.release, 'release-manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const files = {
      'src/AgentMemoryHiddenLauncher.cs': 'fixture source', 'src/iii-0.11.2-state-flush.patch': 'candidate patch',
      'bin/agentmemory-hidden-launcher.exe': 'fixture launcher', 'bin/iii.exe': 'fixture engine',
      'scripts/agentmemory-stop.ps1': 'param($Root,$TimeoutSeconds)', 'scripts/agentmemory-watch-stop.ps1': 'param($Root,$TimeoutSeconds)',
      'config/iii-config.yaml': 'fixture: true', 'config/third-party-inputs.json': '{}', 'config/upstream-source.json': '{}',
      [`${manifest.package_relative_path}/package.json`]: '{"name":"fixture"}',
    };
    for (const [name, content] of Object.entries(files)) {
      const target = path.join(f.release, 'payload', name);
      await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, content);
      manifest.immutable_files.push({ path: name, sha256: await sha256(target) });
    }
    manifest.adapter_source_hashes = { hidden_launcher: await sha256(path.join(f.release, 'payload/src/AgentMemoryHiddenLauncher.cs')),
      hidden_launcher_normalized: await sha256(path.join(f.release, 'payload/src/AgentMemoryHiddenLauncher.cs')) };
    await writeFile(manifestPath, JSON.stringify(manifest));
    const prepared = runInstaller(f.release, f.root, f.workspace, ['-Fresh', '-Execute']);
    assert.equal(prepared.status, 0, prepared.stderr);
    const installedPath = path.join(f.root, 'config/install-manifest.json');
    const installed = JSON.parse(await readFile(installedPath, 'utf8'));
    installed.installation_status = 'activated'; installed.data_contract_version = currentContract;
    await writeFile(installedPath, JSON.stringify(installed));
    await writeFile(path.join(f.root, 'src/iii-0.11.2-state-flush.patch'), 'predecessor patch');
    const harness = path.join(f.dir, 'cutover-mocked.ps1');
    await writeFile(harness, `param($Release,$Root,$Workspace,$Node)
$ErrorActionPreference='Stop'
function Import-Module { param($Name,$ErrorAction) }
function Stop-ScheduledTask { param($TaskPath,$TaskName,$ErrorAction) }
function Start-ScheduledTask { param($TaskPath,$TaskName,$ErrorAction)
  $probe=$null
  try { $probe=[IO.File]::Open((Join-Path $Root 'data/startup.lock'),[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None) } catch [IO.IOException] {}
  if ($probe) { $probe.Dispose(); throw 'Installer did not hold the startup lock' }
  Add-Content -LiteralPath (Join-Path $Root 'data/start-attempts') -Value 'candidate'
  Set-Content -LiteralPath (Join-Path $Root 'data/native-after-start') -Value 'new canonical observation'
  throw 'injected candidate startup failure'
}
try {
  & (Join-Path $Release 'Install-WindowsCodex.ps1') -ReleaseRoot $Release -InstallRoot $Root -WorkspaceRoot $Workspace -ProjectRegistry (Join-Path $Workspace 'projects.json') -NodePath $Node -ManagedRequirementsPath (Join-Path $Workspace 'global-requirements.toml') -Execute
} catch {
  $failure=$_
  $probe=[IO.File]::Open((Join-Path $Root 'data/startup.lock'),[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  $probe.Dispose()
  throw $failure
}
`);
    const result = spawnSync(ps, powershellArgs(harness, { Release: f.release, Root: f.root, Workspace: f.workspace, Node: process.execPath }),
      { encoding: 'utf8', timeout: 60_000, windowsHide: true, env: powershellEnvironment() });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Automatic rollback was withheld/);
    assert.match(result.stderr, /injected candidate startup failure/);
    assert.match(await readFile(path.join(f.root, 'data/native-after-start'), 'utf8'), /new canonical observation/);
    assert.deepEqual((await readFile(path.join(f.root, 'data/start-attempts'), 'utf8')).trim().split(/\r?\n/), ['candidate']);
    assert.equal(await readFile(path.join(f.root, 'src/iii-0.11.2-state-flush.patch'), 'utf8'), 'candidate patch');
    const after = JSON.parse(await readFile(installedPath, 'utf8'));
    assert.equal(after.data_contract_version, 2); assert.equal(after.installation_status, 'cutover_failed');
    const backups = await readdir(path.join(f.root, 'backups/releases'));
    assert.equal(backups.length, 1);
    assert.equal(await readFile(path.join(f.root, 'backups/releases', backups[0], 'src/iii-0.11.2-state-flush.patch'), 'utf8'), 'predecessor patch');
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('fresh dry-run writes nothing; execute prepares a protected owned root and refuses overwrite', { skip: !windows }, async () => {
  const f = await fixture();
  try {
    let result = runInstaller(f.release, f.root, f.workspace, ['-Fresh']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).operation, 'prepare-fresh');
    await assert.rejects(readdir(f.root), { code: 'ENOENT' });
    result = runInstaller(f.release, f.root, f.workspace, ['-Fresh', '-Execute']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).prepared, true);
    const installed = JSON.parse(await readFile(path.join(f.root, 'config/install-manifest.json'), 'utf8'));
    const owner = JSON.parse(await readFile(path.join(f.root, '.agentmemory-install-owner.json'), 'utf8'));
    assert.equal(installed.install_nonce, owner.install_nonce);
    assert.equal(installed.installation_status, 'prepared');
    assert.equal((await readFile(path.join(f.root, 'config/secret.dpapi'))).length > 32, true);
    assert.deepEqual(await readdir(path.join(f.root, 'data')), []);
    await assert.rejects(readFile(path.join(f.workspace, 'global-requirements.toml')), { code: 'ENOENT' });
    result = runInstaller(f.release, f.root, f.workspace, ['-Fresh', '-Execute']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /absent or empty/);
    await writeFile(path.join(f.root, 'config/hook-spec.json'), '{}');
    result = runInstaller(f.release, f.root, f.workspace, ['-ActivatePrepared']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Prepared file hash mismatch/);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('update rejects a workspace that loses existing LocalAI before any cutover writes', { skip: !windows }, async () => {
  const f = await fixture();
  try {
    const launcher = path.join(f.workspace, 'projects/local-ai/scripts/Invoke-LocalAI.ps1');
    await mkdir(path.dirname(launcher), { recursive: true });
    await writeFile(launcher, '# existing host fixture');
    const prepared = runInstaller(f.release, f.root, f.workspace, ['-Fresh', '-Execute']);
    assert.equal(prepared.status, 0, prepared.stderr);
    const manifestPath = path.join(f.root, 'config/install-manifest.json');
    const installed = JSON.parse(await readFile(manifestPath, 'utf8'));
    installed.installation_status = 'activated';
    await writeFile(manifestPath, JSON.stringify(installed));
    const configPath = path.join(f.root, 'config/codex-workspace.json');
    const configBefore = await readFile(configPath, 'utf8');
    const manifestBefore = await readFile(manifestPath, 'utf8');
    const wrongRoot = path.join(f.workspace, 'control');
    await mkdir(wrongRoot);
    await copyFile(path.join(f.workspace, 'projects.json'), path.join(wrongRoot, 'projects.json'));
    for (const args of [[], ['-Execute']]) {
      const result = runInstaller(f.release, f.root, wrongRoot, args);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /WorkspaceRoot would disconnect/);
      assert.equal(await readFile(configPath, 'utf8'), configBefore);
      assert.equal(await readFile(manifestPath, 'utf8'), manifestBefore);
      await assert.rejects(readdir(path.join(f.root, 'backups/releases')), { code: 'ENOENT' });
    }
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('installer refuses a tampered release before creating fresh state', { skip: !windows }, async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.release, 'payload/config/hook-spec.json'), '{}');
    const result = runInstaller(f.release, f.root, f.workspace, ['-Fresh', '-Execute']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /hash mismatch/);
    await assert.rejects(readdir(f.root), { code: 'ENOENT' });
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('managed environment resolves native source outside synthetic HOME and rejects ambiguous roots', { skip: !windows }, async () => {
  const f = await fixture();
  try {
    const prepared = runInstaller(f.release, f.root, f.workspace, ['-Fresh', '-Execute']);
    assert.equal(prepared.status, 0, prepared.stderr);
    const configPath = path.join(f.root, 'config/codex-workspace.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    const harness = path.join(f.dir, 'source-environment.ps1');
    await writeFile(harness, `param($Script, $Root)
$ErrorActionPreference = 'Stop'
$expectedDefault = Join-Path ([System.Environment]::GetFolderPath('UserProfile')) '.codex'
$env:AGENTMEMORY_CODEX_SOURCE_ROOT = 'C:\\untrusted-inherited-root'
$env:AGENTMEMORY_STATE_DURABILITY = 'disabled'
. $Script -Root $Root
[ordered]@{ actual = $env:AGENTMEMORY_CODEX_SOURCE_ROOT; expectedDefault = $expectedDefault; syntheticHome = $env:HOME; stateDurability = $env:AGENTMEMORY_STATE_DURABILITY } | ConvertTo-Json
`);
    const run = () => spawnSync(ps, powershellArgs(harness, {
      Script: path.join(packaging, 'powershell/agentmemory-env.ps1'), Root: f.root,
    }), { encoding: 'utf8', timeout: 15_000, windowsHide: true, env: powershellEnvironment() });
    let result = run();
    assert.equal(result.status, 0, result.stderr);
    const first = JSON.parse(result.stdout);
    assert.equal(first.actual, first.expectedDefault);
    assert.equal(first.stateDurability, 'file-flush-v1');
    assert.notEqual(first.actual, path.join(first.syntheticHome, '.codex'));
    const custom = path.join(f.dir, 'custom-native-source');
    await writeFile(configPath, JSON.stringify({ ...config, codex_source_root: custom }));
    result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).actual, custom);
    for (const value of ['C:relative', '\\relative', '', 123]) {
      await writeFile(configPath, JSON.stringify({ ...config, codex_source_root: value }));
      result = run();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /must be an absolute path/);
    }
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('update rejects an invalid custom native root before changing the installation', { skip: !windows }, async () => {
  const f = await fixture();
  try {
    assert.equal(runInstaller(f.release, f.root, f.workspace, ['-Fresh', '-Execute']).status, 0);
    const manifestPath = path.join(f.root, 'config/install-manifest.json');
    const installed = JSON.parse(await readFile(manifestPath, 'utf8'));
    installed.installation_status = 'activated';
    await writeFile(manifestPath, JSON.stringify(installed));
    const configPath = path.join(f.root, 'config/codex-workspace.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    const invalid = JSON.stringify({ ...config, codex_source_root: 'C:relative' });
    await writeFile(configPath, invalid);
    const result = runInstaller(f.release, f.root, f.workspace, ['-Execute']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must be an absolute path/);
    assert.equal(await readFile(configPath, 'utf8'), invalid);
    await assert.rejects(readdir(path.join(f.root, 'backups/releases')), { code: 'ENOENT' });
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('activation uses existing least-privilege task contract; mocks isolate OS registration', { skip: !windows }, async () => {
  const f = await fixture();
  try {
    const init = path.join(f.release, "Initialize-WindowsCodex.ps1");
    await writeFile(init, (await readFile(init, "utf8")) + "\nfunction Get-InstallPortConflicts { return @() }\n");
    const manifestPath = path.join(f.release, "release-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.release_files.find(file => file.path === "Initialize-WindowsCodex.ps1").sha256 = await sha256(init);
    await writeFile(manifestPath, JSON.stringify(manifest));
    const prepared = runInstaller(f.release, f.root, f.workspace, ['-Fresh', '-Execute']);
    assert.equal(prepared.status, 0, prepared.stderr);
    const harness = path.join(f.dir, 'activate-mocked.ps1');
    await writeFile(harness, `param($Release, $Root, $Workspace, $Node)\n
$ErrorActionPreference = 'Stop'
$global:amTestRegistrations = @{}
function Import-Module { param($Name, $ErrorAction) }
function Get-ScheduledTask { param($TaskPath, $TaskName, $ErrorAction) return $global:amTestRegistrations[$TaskName] }
function New-ScheduledTaskPrincipal { param($UserId, $LogonType, $RunLevel)
  if ($LogonType -ne 'Interactive' -or $RunLevel -ne 'Limited') { throw 'Unexpected principal' }
  return [pscustomobject]@{ UserId = $UserId }
}
function New-ScheduledTaskSettingsSet { param($MultipleInstances, $ExecutionTimeLimit, $RestartCount, $RestartInterval, [switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries)
  if ($MultipleInstances -ne 'IgnoreNew' -or $ExecutionTimeLimit -ne [TimeSpan]::Zero -or $RestartCount -ne 3 -or $RestartInterval -ne [TimeSpan]::FromMinutes(1)) { throw 'Unexpected task settings' }
  return [pscustomobject]@{ SettingsVerified = $true }
}
function New-ScheduledTaskAction { param($Execute, $Argument, $WorkingDirectory)
  if ($Execute -ne (Join-Path $Root 'bin\\agentmemory-hidden-launcher.exe') -or $WorkingDirectory -ne $Root -or $Argument -notin @('task', 'watch')) { throw 'Unexpected action' }
  return [pscustomobject]@{ Arguments = $Argument }
}
function New-ScheduledTaskTrigger { param([switch]$AtLogOn, $User) return [pscustomobject]@{ User = $User; AtLogOn = [bool]$AtLogOn } }
function New-ScheduledTask { param($Action, $Principal, $Settings, $Description, $Trigger)
  if (($Action.Arguments -eq 'task' -and $Trigger) -or ($Action.Arguments -eq 'watch' -and -not $Trigger.AtLogOn)) { throw 'Unexpected trigger' }
  return [pscustomobject]@{ Description = $Description; Action = $Action }
}
function Register-ScheduledTask { param($TaskPath, $TaskName, $InputObject, $ErrorAction)
  if ($global:amTestRegistrations.ContainsKey($TaskName)) { throw 'Duplicate registration' }
  $global:amTestRegistrations[$TaskName] = $InputObject
}
function Unregister-ScheduledTask { param($InputObject, $Confirm) throw 'Unexpected rollback' }
& (Join-Path $Release 'Install-WindowsCodex.ps1') -ReleaseRoot $Release -InstallRoot $Root -WorkspaceRoot $Workspace -ProjectRegistry (Join-Path $Workspace 'projects.json') -NodePath $Node -ManagedRequirementsPath (Join-Path $Workspace 'global-requirements.toml') -ActivatePrepared -Execute
if ($global:amTestRegistrations.Count -ne 2) { throw 'Two task registrations required' }
Write-Output 'MOCK_ACTIVATION_OK'
`);
    // Native task registration and TCP inventory are mocked only in this fixture.
    const activated = spawnSync(ps, powershellArgs(harness, { Release: f.release, Root: f.root, Workspace: f.workspace, Node: process.execPath }),
      { encoding: 'utf8', timeout: 60_000, windowsHide: true, env: powershellEnvironment() });
    assert.equal(activated.status, 0, activated.stderr);
    assert.match(activated.stdout, /MOCK_ACTIVATION_OK/);
    assert.equal(JSON.parse(await readFile(path.join(f.root, 'config/install-manifest.json'), 'utf8')).installation_status, 'activated');
    assert.match(await readFile(path.join(f.workspace, 'global-requirements.toml'), 'utf8'), /hooks.SessionStart/);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('ZIP extraction includes hidden entries and rejects traversal without destination writes', { skip: !windows }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'am-extract-test-'));
  try {
    const maker = path.join(dir, 'make.ps1');
    await writeFile(maker, `param([string]$Out, [string]$Name)\nAdd-Type -AssemblyName System.IO.Compression.FileSystem\n$zip = [IO.Compression.ZipFile]::Open($Out, 'Create')\ntry { $entry = $zip.CreateEntry($Name); $s = New-Object IO.StreamWriter($entry.Open()); try { $s.Write('test') } finally { $s.Dispose() } } finally { $zip.Dispose() }\n`);
    for (const [index, name] of ['.hidden/file.txt', Array(4).fill('long-directory-'.repeat(5)).join('/') + '/file.txt', '../escaped.txt', 'CON/file.txt', 'some./file.txt'].entries()) {
      const zip = path.join(dir, `${index}.zip`), output = path.join(dir, `out${index}`);
      const made = spawnSync(ps, powershellArgs(maker, { Out: zip, Name: name }), { encoding: 'utf8', windowsHide: true });
      assert.equal(made.status, 0, made.stderr);
      const result = spawnSync(ps, powershellArgs(path.join(packaging, 'npm/Expand-Release.ps1'), { Archive: zip, Destination: output }), { encoding: 'utf8', windowsHide: true });
      if (index < 2) { assert.equal(result.status, 0, result.stderr); assert.equal(await readFile(path.join(output, name), 'utf8'), 'test'); }
      else { assert.notEqual(result.status, 0); await assert.rejects(readdir(output), { code: 'ENOENT' }); }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const psQuote = s => "'" + s.replaceAll("'", "''") + "'";
for (const scenario of ['roundtrip', 'collision', 'outside', 'junction', 'cleanup-error', 'content-change']) {
  test('completed backup compaction: ' + scenario, { skip: !windows }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'am-backup-'));
    const root = path.join(dir, 'install'), backup = path.join(root, 'backups/releases/20260924T000000001Z');
    try {
      await mkdir(path.join(backup, 'config'), { recursive: true }); await mkdir(path.join(backup, 'empty'));
      await writeFile(path.join(backup, 'config/install-manifest.json'), '{"release_revision":"r115"}');
      await writeFile(path.join(backup, 'payload.bin'), Buffer.from([0,255,42,13,10]));
      await mkdir(path.join(root, 'data')); await writeFile(path.join(root, 'data/protected'), 'canonical');
      if (scenario === 'collision') await writeFile(backup + '.zip', 'existing archive');
      const target = scenario === 'outside' ? path.join(root, 'data') : backup;
      const setup = scenario === 'junction' ? "New-Item -ItemType Junction -Path (Join-Path $backup 'linked') -Target " + psQuote(path.join(root,'data')) + " | Out-Null; " :
        scenario === 'content-change' ? "function Get-FileHash { param($LiteralPath,$Algorithm) $h=Microsoft.PowerShell.Utility\\Get-FileHash -LiteralPath $LiteralPath -Algorithm $Algorithm; if($LiteralPath.EndsWith('payload.bin') -and -not $script:changed) { $script:changed=$true; [IO.File]::WriteAllText($LiteralPath,'changed fixture') }; return $h }; $script:changed=$false; " :
        scenario === 'cleanup-error' ? "function Remove-Item { param($LiteralPath,[switch]$Recurse,[switch]$Force,$ErrorAction) throw 'simulated cleanup lock' }; " : '';
      const command = "$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest; $e=$null;$t=$null;" +
        "$ast=[Management.Automation.Language.Parser]::ParseFile(" + psQuote(path.join(packaging,'Install-WindowsCodex.ps1')) + ",[ref]$t,[ref]$e);" +
        "$fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Compress-CompletedReleaseBackup'},$true);" +
        "Invoke-Expression $fn.Extent.Text; $backup=" + psQuote(target) + ";" + setup +
        "$result=Compress-CompletedReleaseBackup -InstallRoot " + psQuote(root) + " -BackupRoot $backup -CreationTicks (Get-Item -LiteralPath $backup).CreationTimeUtc.Ticks;" +
        (scenario === 'roundtrip' ? "[IO.Compression.ZipFile]::ExtractToDirectory($result.archive," + psQuote(path.join(dir,'restored')) + ");" : '') +
        "$result|ConvertTo-Json -Compress";
      const result = spawnSync(ps, ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',command],
        { env:powershellEnvironment(), encoding:'utf8', timeout:30000, windowsHide:true });
      assert.equal(await readFile(path.join(root,'data/protected'),'utf8'),'canonical');
      if (scenario === 'roundtrip') {
        assert.equal(result.status,0,result.stderr); const output=JSON.parse(result.stdout); assert.equal(output.compacted,true);
        assert.equal(await realpath(output.archive),await realpath(backup+'.zip')); await assert.rejects(readdir(backup),{code:'ENOENT'});
        assert.equal(await readFile(path.join(dir,'restored/config/install-manifest.json'),'utf8'),'{"release_revision":"r115"}');
        assert.deepEqual(await readFile(path.join(dir,'restored/payload.bin')),Buffer.from([0,255,42,13,10]));
        assert.deepEqual(await readdir(path.join(dir,'restored/empty')),[]);
      } else if (scenario === 'cleanup-error') {
        assert.equal(result.status,0,result.stderr); const output=JSON.parse(result.stdout); assert.equal(output.compacted,false);
        assert.equal(await realpath(output.archive),await realpath(backup+'.zip')); assert.match(output.error,/simulated cleanup lock/);
        assert.equal((await readFile(output.archive)).subarray(0,2).toString(),'PK');
        assert.equal(await readFile(path.join(backup,'config/install-manifest.json'),'utf8'),'{"release_revision":"r115"}');
      } else {
        assert.notEqual(result.status,0);
        assert.match(result.stderr,scenario==='collision'?/already exists/:scenario==='outside'?/identity/:scenario==='content-change'?/content mismatch/:/reparse/);
        assert.equal(await readFile(path.join(backup,'config/install-manifest.json'),'utf8'),'{"release_revision":"r115"}');
        if(scenario==='collision') assert.equal(await readFile(backup+'.zip','utf8'),'existing archive');
        else await assert.rejects(readFile(backup+'.zip'),{code:'ENOENT'});
      }
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
}


test('cutover confirms partial starts with absent worker identities and rejects live or untracked runs', { skip: !windows }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'am-partial-start-'));
  try {
    await mkdir(path.join(dir, 'data')); await mkdir(path.join(dir, 'scripts'));
    await writeFile(path.join(dir, 'scripts/agentmemory-stop.ps1'), "param($Root,$TimeoutSeconds)\nthrow 'partial start stop failed'\n");
    const harness = path.join(dir, 'partial-stop.ps1');
    await writeFile(harness, `param($Source,$Root)
$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Source,[ref]$tokens,[ref]$errors)
if ($errors.Count) {throw 'Installer parse failed'}
$function=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Stop-OwnedRuntimeForCutover'},$true)
Invoke-Expression $function.Extent.Text
function Import-Module {param($Name,$ErrorAction)}
function Stop-ScheduledTask {param($TaskPath,$TaskName,$ErrorAction)}
function Get-Process {param($Id,$ErrorAction) if ($script:live) {return [pscustomobject]@{Id=$Id}}}
function Start-Sleep {param($Milliseconds) throw 'recorded process still live'}
$registrations=@([pscustomobject]@{Name='task-registration.json';TaskName='fixture';TaskPath='\\'})
$state=Join-Path $Root 'data/runtime-state.json'
$script:live=$false
foreach ($json in @('{"daemon":{"pid":41},"engine":{"pid":42},"worker":null}','{"daemon":{"pid":41},"engine":{"pid":42}}')) {
  Set-Content -LiteralPath $state -Value $json
  Stop-OwnedRuntimeForCutover -Root $Root -Registrations $registrations
}
$script:live=$true
$rejected=$false
try {Stop-OwnedRuntimeForCutover -Root $Root -Registrations $registrations} catch {
  if ($_.Exception.Message -notmatch 'recorded process still live') {throw}; $rejected=$true
}
if (!$rejected) {throw 'Live recorded process accepted'}
$script:live=$false
foreach ($json in @('{"daemon":null,"engine":null,"worker":null}','{"daemon":{"pid":41},"engine":{}}')) {
  Set-Content -LiteralPath $state -Value $json
  $rejected=$false
  try {Stop-OwnedRuntimeForCutover -Root $Root -Registrations $registrations} catch {
    if ($_.Exception.Message -notmatch 'partial start stop failed') {throw}; $rejected=$true
  }
  if (!$rejected) {throw 'Untracked run accepted'}
}
'PARTIAL_START_STOP_OK'
`);
    const result=spawnSync(ps,powershellArgs(harness,{Source:path.join(packaging,'Install-WindowsCodex.ps1'),Root:dir}),
      {encoding:'utf8',timeout:30_000,windowsHide:true,env:powershellEnvironment()});
    assert.equal(result.status,0,result.stdout+result.stderr);
    assert.match(result.stdout,/PARTIAL_START_STOP_OK/);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('runtime recovery tolerates transient failures and retains owned-stop guards', { skip: !windows }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'am-health-test-'));
  try {
    const harness = path.join(dir, 'health.ps1');
    await writeFile(harness, `param([string]$Source, [string]$Temp)
$ErrorActionPreference='Stop'
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Source,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'Daemon parse failed' }
$liveness=$ast.Find({param($node) $node -is [Management.Automation.Language.IfStatementAst] -and $node.Clauses[0].Item1.Extent.Text.Contains('$body.writeRecoveryRequired')},$true)
if (!$liveness) {throw 'Missing write-recovery liveness check'}
$rejectBody=[ScriptBlock]::Create('param($body) Set-StrictMode -Version Latest; return ('+$liveness.Clauses[0].Item1.Extent.Text+')')
foreach ($json in @('{"status":"ok","service":"agentmemory"}','{"status":"ok","service":"agentmemory","writeRecoveryRequired":false}')) {
  if (& $rejectBody ($json | ConvertFrom-Json)) {throw 'Healthy or compatible liveness rejected'}
}
foreach ($json in @('{"status":"ok","service":"agentmemory","writeRecoveryRequired":true}','{"status":"failed","service":"agentmemory"}','{"status":"ok","service":"other"}')) {
  if (!(& $rejectBody ($json | ConvertFrom-Json))) {throw 'Unhealthy liveness accepted'}
}
foreach ($name in @('Test-RuntimeRecoveryDue','Stop-OwnedProcess')) {
  $function=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
  if (!$function) { throw "Missing runtime function: $name" }
  Invoke-Expression $function.Extent.Text
}
$base=[DateTime]::UtcNow
$state=@{LastProbeUtc=$base;ConsecutiveFailures=0}
$script:probes=0
$fail={ $script:probes++; return $false }
if (Test-RuntimeRecoveryDue $state ($base.AddSeconds(29)) $fail) {throw 'Early recovery'}
if ($script:probes -ne 0) {throw 'Probe ran before its interval'}
foreach ($second in @(30,60)) {
  if (Test-RuntimeRecoveryDue $state ($base.AddSeconds($second)) $fail) {throw 'Transient failure caused recovery'}
}
if (!(Test-RuntimeRecoveryDue $state ($base.AddSeconds(90)) $fail)) {throw 'Persistent stall did not request recovery'}
if ($script:probes -ne 3) {throw 'Unexpected probe count'}
if (Test-RuntimeRecoveryDue $state ($base.AddSeconds(120)) {return $true}) {throw 'Successful recovery check was ignored'}
if ($state.ConsecutiveFailures -ne 0) {throw 'Success did not reset history'}
if (Test-RuntimeRecoveryDue $state ($base.AddSeconds(150)) {throw 'transport timeout'}) {throw 'Single timeout caused recovery'}
if (Test-RuntimeRecoveryDue $state ($base.AddSeconds(180)) {return $true}) {throw 'Recovered transport was rejected'}
if (Test-RuntimeRecoveryDue $state ($base.AddSeconds(210)) $fail) {throw 'Old failures survived a success'}

# Exercise the actual cleanup function without terminating a real process.
$fake=[Diagnostics.Process]::new()
$script:kills=0; $script:waits=@(); $script:checks=0
$fake | Add-Member -MemberType ScriptMethod -Name WaitForExit -Force -Value {param($ms) $script:waits+= $ms; return $false}
$fake | Add-Member -MemberType ScriptMethod -Name Kill -Force -Value {$script:kills++}
function Test-OwnedProcess {param($Process,$Identity) $script:checks++; return $script:checks -eq 1}
$stop=Join-Path $Temp 'owned-stop.json'
Stop-OwnedProcess -Process $fake -Identity @{pid=42} -GracefulStopPath $stop -GracefulStopToken 'fixture-token'
if ($script:kills -ne 0) {throw 'Changed ownership was terminated'}
if ($script:waits.Count -ne 1 -or $script:waits[0] -ne 10000) {throw 'Graceful window changed'}
$request=Get-Content $stop -Raw | ConvertFrom-Json
if ($request.worker_pid -ne 42 -or $request.token -cne 'fixture-token') {throw 'Wrong stop request'}
function Test-OwnedProcess {param($Process,$Identity) return $true}
Stop-OwnedProcess -Process $fake -Identity @{pid=42} -GracefulStopPath $stop -GracefulStopToken 'fixture-token'
if ($script:kills -ne 1) {throw 'Hung owned process did not use bounded cleanup'}
$fake.Dispose()
'RUNTIME_RECOVERY_OK'
`);
    const result = spawnSync(ps, powershellArgs(harness, { Source: path.join(packaging, 'powershell/agentmemory-daemon.ps1'), Temp: dir }),
      { encoding: 'utf8', timeout: 30_000, windowsHide: true, env: powershellEnvironment() });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /RUNTIME_RECOVERY_OK/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('stall evidence is identity-scoped, excludes payloads and survives invalid snapshots', { skip: !windows }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'am-stall-test-'));
  try {
    const harness = path.join(dir, 'stall.ps1');
    await writeFile(harness, `param([string]$Source,[string]$Temp)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Source,[ref]$tokens,[ref]$errors)
if ($errors.Count) {throw 'Daemon parse failed'}
foreach($name in @('Save-RuntimeStallEvidence','Get-StallProcessSample')) {
  $fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
  if(!$fn){throw 'Missing diagnostic function'}
  Invoke-Expression $fn.Extent.Text
}
function Test-OwnedProcess {param($Process,$Identity) return $Process.Id -eq $Identity.pid}
$process=[Diagnostics.Process]::GetCurrentProcess()
$identity=@{pid=$PID}
$run='20260912T010000000Z'
$inputPath=Join-Path $Temp "worker-diagnostics-$run.json"
$raw=@{schema=1;runId=$run;pid=$PID;observedAt=1;heartbeatAt=1;heartbeatAgeMs=2;droppedEvents=0;droppedActive=0;
  memory=@{rss=10;heapUsed=2;heapTotal=3;external=1;secret='PRIVATE_SECRET'};
  active=@(@{id=1;parent=$null;kind='state';name='state::get';startedAt=1;ageMs=2;payload='PRIVATE_PAYLOAD'});
  recent=@(@{id=2;parent=$null;kind='function';name='mcp::tools::call';startedAt=1;durationMs=2;outcome='ok';payload='PRIVATE_MCP_PAYLOAD'});environment='PRIVATE_ENV'}
$raw | ConvertTo-Json -Depth 6 | Set-Content $inputPath
Save-RuntimeStallEvidence $Temp $run $process $identity $process $identity
$output=Join-Path $Temp "stall-$run.json"
$text=Get-Content $output -Raw
if($text -cmatch 'PRIVATE_'){throw 'Sensitive extra fields leaked'}
$saved=$text | ConvertFrom-Json
if($saved.snapshot_status -ne 'available' -or !$saved.worker.available -or $saved.snapshot.active[0].name -ne 'state::get' -or $saved.snapshot.recent[0].name -ne 'mcp::tools::call'){throw 'Missing diagnostic evidence'}
$hash=(Get-FileHash $output).Hash
Save-RuntimeStallEvidence $Temp $run $process $identity $process $identity
if((Get-FileHash $output).Hash -ne $hash){throw 'Existing incident overwritten'}
$next='20260912T010001000Z'
'invalid JSON' | Set-Content (Join-Path $Temp "worker-diagnostics-$next.json")
Save-RuntimeStallEvidence $Temp $next $process $identity $process $identity
$saved=Get-Content (Join-Path $Temp "stall-$next.json") -Raw | ConvertFrom-Json
if($saved.snapshot_status -ne 'invalid' -or !$saved.worker.available){throw 'Invalid snapshot prevented OS evidence'}
$wrong=Get-StallProcessSample $process @{pid=0}
if($wrong.available -or $wrong.reason -ne 'identity_mismatch'){throw 'Wrong process sampled'}
$last='20260912T010002000Z'
$raw.runId=$last; $raw.pid=0
$raw | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $Temp "worker-diagnostics-$last.json")
Save-RuntimeStallEvidence $Temp $last $process $identity $process $identity
$saved=Get-Content (Join-Path $Temp "stall-$last.json") -Raw | ConvertFrom-Json
if($saved.snapshot_status -ne 'identity_mismatch' -or $null -ne $saved.snapshot){throw 'Wrong run snapshot accepted'}
$process.Dispose()
'STALL_EVIDENCE_OK'
`);
    const result = spawnSync(ps, powershellArgs(harness, {Source:path.join(packaging,'powershell/agentmemory-daemon.ps1'),Temp:dir}),
      {encoding:'utf8',timeout:30_000,windowsHide:true,env:powershellEnvironment()});
    assert.equal(result.status,0,result.stdout+result.stderr);
    assert.match(result.stdout,/STALL_EVIDENCE_OK/);
    const source = await readFile(path.join(packaging,'powershell/agentmemory-daemon.ps1'),'utf8');
    assert.ok(source.indexOf('Save-RuntimeStallEvidence -LogsPath') < source.indexOf("$terminalReason = 'runtime_unresponsive'"));
  } finally { await rm(dir,{recursive:true,force:true}); }
});
