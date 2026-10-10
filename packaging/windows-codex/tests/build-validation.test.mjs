import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
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
  return { root, source, script, scratch, env };
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
