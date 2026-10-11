import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const windows = process.platform === 'win32';
const builder = fileURLToPath(new URL('../Build-WindowsCodex.ps1', import.meta.url));
const quote = value => "'" + value.replaceAll("'", "''") + "'";
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'am-validation-'));
  const source = path.join(root, 'source'), bin = path.join(root, 'bin'), scratch = path.join(root, 'scratch');
  const script = path.join(source, 'packaging/windows-codex/Build-WindowsCodex.ps1');
  await mkdir(path.dirname(script), { recursive: true }); await mkdir(bin);
  await mkdir(scratch);
  await writeFile(path.join(scratch, 'caller.txt'), 'caller-owned');
  await copyFile(builder, script);
  await writeFile(path.join(source, 'package.json'), JSON.stringify({ version:'0.9.30', agentmemoryDownstream:{version:'0.1.0-preview.15',dataContractVersion:5} }));
  for (const name of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'upstream-source.json']) await writeFile(path.join(source, name), '{}');
  await writeFile(path.join(bin, 'git.cmd'), '@echo off\r\nif "%~3"=="rev-parse" goto rev\r\nif "%~3"=="status" goto status\r\nexit /b 4\r\n:rev\r\necho aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\r\nexit /b 0\r\n:status\r\necho M source.ts\r\nexit /b 0\r\n');
  // These stubs exercise builder lifecycle only; they do not validate the package.
  await writeFile(path.join(bin, 'pnpm.cmd'), '@echo off\r\necho %*>>"%AM_VALIDATION_TRACE%"\r\necho SCRATCH=%TEMP%>>"%AM_VALIDATION_TRACE%"\r\nif not exist "%NODE_COMPILE_CACHE%" mkdir "%NODE_COMPILE_CACHE%"\r\necho synthetic fixture>"%TEMP%\\fixture.tmp"\r\necho synthetic cache>"%NODE_COMPILE_CACHE%\\cache.tmp"\r\nif "%AM_VALIDATION_FAIL%"=="1" if "%~2"=="typecheck" exit /b 9\r\nif not "%AM_VALIDATION_LINK_TARGET%"=="" if "%~2"=="build" mklink /J "%TEMP%\\escape" "%AM_VALIDATION_LINK_TARGET%">nul\r\nexit /b 0\r\n');
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    const name = key.toUpperCase();
    if (name in env && env[name] !== value) throw Error('Conflicting environment names');
    env[name] = value;
  }
  env.PATH = bin + path.delimiter + env.PATH;
  env.PSMODULEPATH = path.join(env.SYSTEMROOT, 'System32/WindowsPowerShell/v1.0/Modules');
  env.AM_VALIDATION_TRACE = path.join(root, 'trace.txt');
  return { root, source, bin, script, scratch, env };
}
function run(f, args, env = f.env, explicitScratch = true) {
  const scratchArg = explicitScratch ? `-ScratchDirectory ${quote(f.scratch)}` : '';
  const command = `$env:CI='before'; $env:NODE_OPTIONS='--no-warnings'; $before=@{}; $names=@('CI','NODE_OPTIONS','TEMP','TMP','TMPDIR','NODE_COMPILE_CACHE'); foreach($name in $names){$before[$name]=[Environment]::GetEnvironmentVariable($name,'Process')}; try { & ${quote(f.script)} ${args} ${scratchArg} -NodePath ${quote(process.execPath)} } finally { foreach($name in $names){if([Environment]::GetEnvironmentVariable($name,'Process') -cne $before[$name]){throw "Environment leaked: $name"}} }`;
  return spawnSync(path.join(env.SYSTEMROOT, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',command], { env, encoding:'utf8', timeout:30000, windowsHide:true });
}
test('validation can repeat on dirty source without output arguments or deploy', { skip:!windows }, async () => {
  const f=await fixture();
  try {
    for(let i=0;i<2;i++) { const r=run(f,'-ValidationOnly -SkipTests'); assert.equal(r.status,0,r.stderr); const out=JSON.parse(r.stdout); assert.equal(out.validation_only,true); assert.equal(out.release_created,false); assert.equal(out.source_dirty,true); assert.deepEqual(await readdir(f.scratch),['caller.txt']); }
    const trace=await readFile(f.env.AM_VALIDATION_TRACE,'utf8');
    assert.equal((trace.match(/run build/g)||[]).length,2);
    assert.equal((trace.match(/--frozen-lockfile/g)||[]).length,2);
    assert.doesNotMatch(trace,/deploy/);
    assert.equal(await readFile(path.join(f.scratch,'caller.txt'),'utf8'),'caller-owned');
    const units = [...new Set([...trace.matchAll(/^SCRATCH=(.+)\r?$/gm)].map(match => match[1].trim()))];
    assert.equal(units.length,2);
    for (const unit of units) assert.equal(path.dirname(unit),f.scratch);
    assert.deepEqual((await readdir(f.root)).sort(),['bin','scratch','source','trace.txt']);
  } finally { await rm(f.root,{recursive:true,force:true}); }
});
test('validation failure remains a failure and restores environment', { skip:!windows }, async () => {
  const f=await fixture();
  try {
    const env={...f.env,AM_VALIDATION_FAIL:'1'}; delete env.TMPDIR; delete env.NODE_COMPILE_CACHE;
    const r=run(f,'-ValidationOnly -SkipTests',env);
    assert.notEqual(r.status,0); assert.match(r.stderr,/typecheck failed with exit code 9/); assert.doesNotMatch(r.stderr,/Environment leaked/);
    assert.doesNotMatch(await readFile(f.env.AM_VALIDATION_TRACE,'utf8'),/deploy|run build/);
    const units=(await readdir(f.scratch)).filter(name=>name.startsWith('agentmemory-build-'));
    assert.equal(units.length,1);
    const retained=path.join(f.scratch,units[0]);
    assert.ok(r.stderr.includes(retained),'failure reports exact retained scratch');
    assert.match(await readFile(path.join(retained,'fixture.tmp'),'utf8'),/synthetic fixture/);
    assert.match(await readFile(path.join(retained,'node-compile-cache/cache.tmp'),'utf8'),/synthetic cache/);
  }
  finally { await rm(f.root,{recursive:true,force:true}); }
});

test('workspace task root is preferred over inherited temporary directory', { skip:!windows }, async () => {
  const f=await fixture();
  try {
    const env={...f.env,WORKSPACE_TASK_ROOT:f.scratch};
    const r=run(f,'-ValidationOnly -SkipTests',env,false);
    assert.equal(r.status,0,r.stderr);
    const trace=await readFile(f.env.AM_VALIDATION_TRACE,'utf8');
    const unit=trace.match(/^SCRATCH=(.+)\r?$/m)[1].trim();
    assert.equal(path.dirname(unit),f.scratch);
    assert.deepEqual(await readdir(f.scratch),['caller.txt']);
  } finally { await rm(f.root,{recursive:true,force:true}); }
});

test('portable invocation uses inherited temporary parent when no task root is provided', { skip:!windows }, async () => {
  const f=await fixture();
  try {
    const env={...f.env,TEMP:f.scratch,TMP:f.scratch}; delete env.WORKSPACE_TASK_ROOT;
    const r=run(f,'-ValidationOnly -SkipTests',env,false);
    assert.equal(r.status,0,r.stderr);
    const unit=(await readFile(f.env.AM_VALIDATION_TRACE,'utf8')).match(/^SCRATCH=(.+)\r?$/m)[1].trim();
    assert.equal(path.dirname(unit),f.scratch);
    assert.deepEqual(await readdir(f.scratch),['caller.txt']);
  } finally { await rm(f.root,{recursive:true,force:true}); }
});

test('cleanup refuses an introduced junction and preserves its target', { skip:!windows }, async () => {
  const f=await fixture();
  let link;
  try {
    const r=run(f,'-ValidationOnly -SkipTests',{...f.env,AM_VALIDATION_LINK_TARGET:f.source});
    assert.notEqual(r.status,0);
    assert.match(r.stderr,/Build scratch cleanup failed/); assert.match(r.stderr,/reparse point/);
    assert.doesNotMatch(r.stderr,/Environment leaked/); assert.doesNotMatch(r.stdout,/"success"\s*:\s*true/);
    const units=(await readdir(f.scratch)).filter(name=>name.startsWith('agentmemory-build-'));
    assert.equal(units.length,1); link=path.join(f.scratch,units[0],'escape');
    assert.ok(r.stderr.includes(path.dirname(link)));
    assert.equal(JSON.parse(await readFile(path.join(f.source,'package.json'),'utf8')).version,'0.9.30');
    await rm(link); link=undefined;
  } finally { if(link) await rm(link); await rm(f.root,{recursive:true,force:true}); }
});

test('scratch parent junction is rejected before subprocess work', { skip:!windows }, async () => {
  const f=await fixture();
  const link=path.join(f.root,'scratch-link');
  const { symlink }=await import('node:fs/promises');
  try {
    await symlink(f.scratch,link,'junction');
    const r=run({...f,scratch:link},'-ValidationOnly -SkipTests');
    assert.notEqual(r.status,0); assert.match(r.stderr,/not a physical directory/);
    await assert.rejects(readFile(f.env.AM_VALIDATION_TRACE),{code:'ENOENT'});
    assert.deepEqual(await readdir(f.scratch),['caller.txt']);
    await rm(link);
  } finally { await rm(link,{force:true}); await rm(f.root,{recursive:true,force:true}); }
});
test('release mode still rejects dirty source before producing output', { skip:!windows }, async () => {
  const f=await fixture();
  try { const out=path.join(f.root,'release');const r=run(f,`-OutputDirectory ${quote(out)} -IiiEnginePath ${quote(process.execPath)}`);assert.notEqual(r.status,0);assert.match(r.stderr,/clean source checkout/);await assert.rejects(readdir(out),{code:'ENOENT'}); }
  finally { await rm(f.root,{recursive:true,force:true}); }
});

// Synthetic package commands exercise diagnostic materialization and lifecycle;
// they do not qualify the real AgentMemory build, engine, installer or service.
async function diagnosticFixture(callback) {
  const f = await fixture();
  const packaging = path.dirname(f.script);
  const digest = text => createHash('sha256').update(text).digest('hex');
  const engine = path.join(f.root, 'synthetic-engine.bin');
  const patch = 'synthetic engine patch\n', license = 'synthetic engine license';
  await writeFile(engine, 'synthetic engine bytes');
  await writeFile(path.join(f.source, 'upstream-source.json'), JSON.stringify({ tag:'synthetic', commit:'b'.repeat(40), tree:'c'.repeat(40), npm_artifact:{sha256:'d'.repeat(64)} }));
  for (const directory of ['node_modules', 'dist', 'source-cache']) {
    await mkdir(path.join(f.source, directory));
    await writeFile(path.join(f.source, directory, 'caller.txt'), 'source-owned');
  }
  for (const directory of ['config', 'patches', 'licenses', 'powershell', 'hooks', 'node', 'launcher', 'tests']) {
    await mkdir(path.join(packaging, directory), { recursive: true });
  }
  await writeFile(path.join(packaging, 'patches/state.patch'), patch);
  await writeFile(path.join(packaging, 'config/third-party-inputs.json'), JSON.stringify({ iii_engine: {
    state_durability:'file-flush-v1', patch:'patches/state.patch', source_commit:'b'.repeat(40),
    patch_sha256:digest(patch), build_profile:'release', sha256:digest('synthetic engine bytes'),
    license_sha256:digest(license), version:'synthetic-engine',
  } }));
  for (const name of ['iii-LICENSE_ELv2', 'iii-NOTICE', 'iii-PATENTS', 'THIRD-PARTY-NOTICES.md']) {
    await writeFile(path.join(packaging, 'licenses', name), license);
  }
  for (const name of ['LICENSE', 'NOTICE']) await writeFile(path.join(f.source, name), 'synthetic license');
  for (const name of ['iii-config.yaml', 'hook-spec.json', 'mcp-launcher-environment.json']) {
    await writeFile(path.join(packaging, 'config', name), '{}');
  }
  for (const name of ['codex-turn.mjs', 'codex-visibility.mjs', 'codex-project.mjs', 'codex-recall-evidence.mjs']) {
    await writeFile(path.join(packaging, 'hooks', name), '// synthetic hook\n');
  }
  for (const name of ['Install-WindowsCodex.ps1', 'Initialize-WindowsCodex.ps1', 'Adopt-WindowsCodex.ps1']) {
    await writeFile(path.join(packaging, name), '# synthetic installer; never invoked\n');
  }
  await writeFile(path.join(packaging, 'powershell/fixture.ps1'), '# synthetic package script\n');
  await writeFile(path.join(packaging, 'node/agentmemory-worker.mjs'), '// synthetic worker; never invoked\n');
  await writeFile(path.join(packaging, 'launcher/AgentMemoryHiddenLauncher.cs'), 'class Fixture { static void Main() {} }');
  await writeFile(path.join(packaging, 'tests/release-smoke.mjs'), `import { existsSync } from 'node:fs'; import assert from 'node:assert/strict'; import path from 'node:path'; assert.ok(existsSync(path.join(process.argv[2], 'dist/index.mjs')));`);
  const deployStub=path.join(f.bin,'synthetic-deploy.mjs');
  await writeFile(deployStub, `import { mkdir, writeFile } from 'node:fs/promises'; import path from 'node:path'; const root=process.argv[2]; await mkdir(path.join(root,'node_modules'),{recursive:true}); await mkdir(path.join(root,'dist'),{recursive:true}); await writeFile(path.join(root,'dist/index.mjs'),'synthetic module');`);
  f.env.AM_VALIDATION_NODE=process.execPath;
  f.env.AM_VALIDATION_DEPLOY=deployStub;
  await writeFile(path.join(f.bin, 'pnpm.cmd'), '@echo off\r\nif "%~1"=="--version" goto version\r\necho %*>>"%AM_VALIDATION_TRACE%"\r\necho SCRATCH=%TEMP%>>"%AM_VALIDATION_TRACE%"\r\nif not exist "%NODE_COMPILE_CACHE%" mkdir "%NODE_COMPILE_CACHE%"\r\necho synthetic fixture>"%TEMP%\\fixture.tmp"\r\nif "%AM_VALIDATION_FAIL%"=="1" if "%~2"=="typecheck" exit /b 9\r\nset AM_DEPLOY_SELECTED=\r\n:args\r\nif "%~1"=="" goto done\r\nif "%~1"=="deploy" set AM_DEPLOY_SELECTED=1\r\nset "AM_DEPLOY_TARGET=%~1"\r\nshift\r\ngoto args\r\n:done\r\nif not defined AM_DEPLOY_SELECTED exit /b 0\r\n"%AM_VALIDATION_NODE%" "%AM_VALIDATION_DEPLOY%" "%AM_DEPLOY_TARGET%"\r\nexit /b %errorlevel%\r\n:version\r\necho synthetic-pnpm\r\nexit /b 0\r\n');
  const qualification = path.join(f.root, 'qualification.ps1');
  await writeFile(qualification, 'param($ReleaseRoot,$ScratchRoot)\n$ErrorActionPreference="Stop"\n' + callback);
  return { ...f, engine, qualification };
}
const diagnosticArgs = f => `-DiagnosticOnly -SkipTests -IiiEnginePath ${quote(f.engine)} -QualificationScript ${quote(f.qualification)}`;

test('diagnostic qualification sees one scratch-owned package and success removes the whole unit', { skip:!windows }, async () => {
  const f = await diagnosticFixture(`if([IO.Path]::GetDirectoryName($ReleaseRoot) -ne $ScratchRoot){throw 'Release escaped unit'}
if($env:TEMP -ne $ScratchRoot){throw 'Temporary environment escaped unit'}
if(-not(Test-Path (Join-Path $ReleaseRoot 'release-manifest.json'))){throw 'Manifest missing'}
[void][IO.Directory]::CreateDirectory((Join-Path $ScratchRoot 'synthetic-install/runtime'))
[IO.File]::WriteAllText((Join-Path $ScratchRoot 'synthetic-install/runtime/consumer.txt'),'synchronously consumed')
`);
  try {
    const r = run(f, diagnosticArgs(f));
    assert.equal(r.status,0,r.stderr+'\n'+r.stdout+'\n'+await readFile(f.env.AM_VALIDATION_TRACE,'utf8'));
    const result=JSON.parse(r.stdout);
    assert.equal(result.diagnostic_only,true); assert.equal(result.source_dirty,true);
    assert.equal(result.qualification_completed,true); assert.equal(result.release_retained,false);
    assert.deepEqual(await readdir(f.scratch),['caller.txt']);
    const trace=await readFile(f.env.AM_VALIDATION_TRACE,'utf8');
    assert.equal((trace.match(/deploy --prod/g)||[]).length,1);
    assert.equal(new Set([...trace.matchAll(/^SCRATCH=(.+)\r?$/gm)].map(match=>match[1].trim())).size,1);
    assert.equal(await readFile(path.join(f.scratch,'caller.txt'),'utf8'),'caller-owned');
    assert.ok((await readFile(path.join(f.source,'package.json'),'utf8')).includes('0.9.30'));
    for (const directory of ['node_modules', 'dist', 'source-cache']) {
      assert.equal(await readFile(path.join(f.source,directory,'caller.txt'),'utf8'),'source-owned');
    }
  } finally { await rm(f.root,{recursive:true,force:true}); }
});

for (const callback of ["throw 'qualification fixture failure'", 'exit 23']) {
  test(`diagnostic preserves its package after qualification failure: ${callback}`, { skip:!windows }, async () => {
    const f=await diagnosticFixture(callback);
    try {
      const r=run(f,diagnosticArgs(f));
      assert.notEqual(r.status,0); assert.doesNotMatch(r.stdout,/"success"\s*:\s*true/);
      assert.match(r.stderr,/retained after failure/);
      const units=(await readdir(f.scratch)).filter(name=>name.startsWith('agentmemory-build-'));
      assert.equal(units.length,1);
      const release=path.join(f.scratch,units[0],'agentmemory-codex-windows-0.1.0-preview.15');
      assert.equal(JSON.parse(await readFile(path.join(release,'release-manifest.json'),'utf8')).release_revision,'r32');
      assert.ok(r.stderr.includes(path.dirname(release)));
    } finally { await rm(f.root,{recursive:true,force:true}); }
  });
}

test('diagnostic build failure preserves the unit without calling qualification', { skip:!windows }, async () => {
  const f=await diagnosticFixture("throw 'qualification must not run'");
  try {
    const r=run(f,diagnosticArgs(f),{...f.env,AM_VALIDATION_FAIL:'1'});
    assert.notEqual(r.status,0); assert.match(r.stderr,/typecheck failed/);
    assert.doesNotMatch(r.stderr,/qualification must not run/);
    assert.doesNotMatch(r.stdout,/"success"\s*:\s*true/);
    assert.equal((await readdir(f.scratch)).filter(name=>name.startsWith('agentmemory-build-')).length,1);
  } finally { await rm(f.root,{recursive:true,force:true}); }
});

test('diagnostic does not accept a persistent output directory', { skip:!windows }, async () => {
  const f=await fixture();
  try {
    const out=path.join(f.root,'forbidden-output');
    const r=run(f,`-DiagnosticOnly -QualificationScript ${quote(f.script)} -IiiEnginePath ${quote(process.execPath)} -OutputDirectory ${quote(out)}`);
    assert.notEqual(r.status,0); await assert.rejects(readdir(out),{code:'ENOENT'});
    await assert.rejects(readFile(f.env.AM_VALIDATION_TRACE),{code:'ENOENT'});
  } finally { await rm(f.root,{recursive:true,force:true}); }
});

for (const host of ['powershell.exe', 'pwsh.exe']) {
  test(`watchdog stop preserves JSON timestamp identity and rejects tampering in ${host}`, { skip: !windows }, async t => {
    const executable = host === 'powershell.exe'
      ? path.join(process.env.SYSTEMROOT, 'System32/WindowsPowerShell/v1.0/powershell.exe') : host;
    const available = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    if (available.error?.code === 'ENOENT') { t.skip('PowerShell 7 is not installed'); return; }
    assert.equal(available.status, 0, available.stderr);
    const root = await mkdtemp(path.join(tmpdir(), 'am-watch-auth-'));
    try {
      const scripts = fileURLToPath(new URL('../powershell/', import.meta.url));
      const command = `$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest;
$watchStopPath=${quote(path.join(root, 'request.json'))};
$watchdogStartedAtUtc='2026-10-07T06:33:01.3231629Z';
$env:AGENTMEMORY_SECRET='synthetic-watchdog-test-only';
$state='{"watcher_started_at_utc":"2026-10-07T06:33:01.3231629Z","watcher_process_started_at_utc":"2026-10-07T06:33:00.9136157Z"}'|ConvertFrom-Json;
$tokens=$null;$errors=$null;
$ast=[Management.Automation.Language.Parser]::ParseFile(${quote(path.join(scripts, 'agentmemory-watch-stop.ps1'))},[ref]$tokens,[ref]$errors);
if($errors.Count){throw 'Stop script syntax error'};
$normalize=$ast.Find({param($n) $n -is [Management.Automation.Language.ForEachStatementAst] -and $n.Extent.Text -match '\\$state\\.\\$field'},$true);
if($normalize){Invoke-Expression $normalize.Extent.Text};
if([string]$state.watcher_started_at_utc -cne $watchdogStartedAtUtc -or [string]$state.watcher_process_started_at_utc -cne '2026-10-07T06:33:00.9136157Z'){throw 'JSON timestamp identity changed'};
$ast=[Management.Automation.Language.Parser]::ParseFile(${quote(path.join(scripts, 'agentmemory-watch.ps1'))},[ref]$tokens,[ref]$errors);
if($errors.Count){throw 'Watch script syntax error'};
$fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Test-WatchdogStopRequest'},$true);
Invoke-Expression $fn.Extent.Text;
$key=[Text.Encoding]::UTF8.GetBytes($env:AGENTMEMORY_SECRET);$hmac=New-Object Security.Cryptography.HMACSHA256(,$key);
try{$token=[Convert]::ToBase64String($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes("Codex.AgentMemory.WatchdogStop.v1|$PID|2026-10-07T06:33:01.3231629Z")))}finally{$hmac.Dispose()};
$request=[ordered]@{watcher_pid=$PID;watcher_started_at_utc=[string]$state.watcher_started_at_utc;token=$token};
function Save-TestRequest { [IO.File]::WriteAllText($watchStopPath,($request|ConvertTo-Json)) };
Save-TestRequest;if(-not(Test-WatchdogStopRequest)){throw 'Authentic request rejected'};
$request.watcher_pid=$PID+1;Save-TestRequest;if(Test-WatchdogStopRequest){throw 'Changed PID accepted'};
$request.watcher_pid=$PID;$request.watcher_started_at_utc='2026-10-07T06:33:02.3231629Z';Save-TestRequest;if(Test-WatchdogStopRequest){throw 'Changed timestamp accepted'};
$request.watcher_started_at_utc=$watchdogStartedAtUtc;$request.token='invalid';Save-TestRequest;if(Test-WatchdogStopRequest){throw 'Invalid token accepted'};
'PASS'`;
      const r = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
      assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /PASS/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
