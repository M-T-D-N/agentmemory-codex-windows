import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm, readdir } from 'node:fs/promises';
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

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'am-fresh-test-'));
  const release = path.join(dir, 'release'), workspace = path.join(dir, 'workspace'), root = path.join(dir, 'install space');
  await mkdir(path.join(release, 'payload/config'), { recursive: true });
  await mkdir(workspace);
  await writeFile(path.join(workspace, 'projects.json'), '{"schema_version":2,"projects":[]}');
  for (const name of ['Install-WindowsCodex.ps1', 'Initialize-WindowsCodex.ps1']) await copyFile(path.join(packaging, name), path.join(release, name));
  for (const name of ['hook-spec.json', 'mcp-launcher-environment.json']) await copyFile(path.join(packaging, 'config', name), path.join(release, 'payload/config', name));
  const manifest = { schema_version: 1, product: 'AgentMemory for Codex on Windows', product_id: 'agentmemory-codex-windows',
    downstream_version: '0.1.0-preview.4', agentmemory_version: '0.9.29', release_revision: 'r84', source_commit: 'a'.repeat(40),
    package_relative_path: 'runtime/0.9.29-codex-r84/agentmemory', release_files: [], immutable_files: [] };
  for (const name of ['Install-WindowsCodex.ps1', 'Initialize-WindowsCodex.ps1']) manifest.release_files.push({ path: name, sha256: await sha256(path.join(release, name)) });
  for (const name of ['hook-spec.json', 'mcp-launcher-environment.json']) manifest.immutable_files.push({ path: `config/${name}`, sha256: await sha256(path.join(release, 'payload/config', name)) });
  await writeFile(path.join(release, 'release-manifest.json'), JSON.stringify(manifest));
  return { dir, release, workspace, root };
}

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
