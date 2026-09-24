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
  const source = path.join(root, 'source'), bin = path.join(root, 'bin');
  const script = path.join(source, 'packaging/windows-codex/Build-WindowsCodex.ps1');
  await mkdir(path.dirname(script), { recursive: true }); await mkdir(bin);
  await copyFile(builder, script);
  await writeFile(path.join(source, 'package.json'), JSON.stringify({ version:'0.9.29', agentmemoryDownstream:{version:'0.1.0-preview.10',dataContractVersion:4} }));
  for (const name of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'upstream-source.json']) await writeFile(path.join(source, name), '{}');
  await writeFile(path.join(bin, 'git.cmd'), '@echo off\r\nif "%~3"=="rev-parse" goto rev\r\nif "%~3"=="status" goto status\r\nexit /b 4\r\n:rev\r\necho aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\r\nexit /b 0\r\n:status\r\necho M source.ts\r\nexit /b 0\r\n');
  await writeFile(path.join(bin, 'pnpm.cmd'), '@echo off\r\necho %*>>"%AM_VALIDATION_TRACE%"\r\nif "%AM_VALIDATION_FAIL%"=="1" if "%~2"=="typecheck" exit /b 9\r\nexit /b 0\r\n');
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    const name = key.toUpperCase();
    if (name in env && env[name] !== value) throw Error('Conflicting environment names');
    env[name] = value;
  }
  env.PATH = bin + path.delimiter + env.PATH;
  env.PSMODULEPATH = path.join(env.SYSTEMROOT, 'System32/WindowsPowerShell/v1.0/Modules');
  env.AM_VALIDATION_TRACE = path.join(root, 'trace.txt');
  return { root, source, script, env };
}
function run(f, args, env = f.env) {
  const command = `$env:CI='before'; $env:NODE_OPTIONS='--no-warnings'; try { & ${quote(f.script)} ${args} -NodePath ${quote(process.execPath)} } finally { if ($env:CI -ne 'before' -or $env:NODE_OPTIONS -ne '--no-warnings') { throw 'Environment leaked' } }`;
  return spawnSync(path.join(env.SYSTEMROOT, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',command], { env, encoding:'utf8', timeout:30000, windowsHide:true });
}
test('validation can repeat on dirty source without output arguments or deploy', { skip:!windows }, async () => {
  const f=await fixture();
  try {
    for(let i=0;i<2;i++) { const r=run(f,'-ValidationOnly -SkipTests'); assert.equal(r.status,0,r.stderr); const out=JSON.parse(r.stdout); assert.equal(out.validation_only,true); assert.equal(out.release_created,false); assert.equal(out.source_dirty,true); }
    const trace=await readFile(f.env.AM_VALIDATION_TRACE,'utf8');
    assert.equal((trace.match(/run build/g)||[]).length,2);
    assert.equal((trace.match(/--frozen-lockfile/g)||[]).length,2);
    assert.doesNotMatch(trace,/deploy/);
    assert.deepEqual((await readdir(f.root)).sort(),['bin','source','trace.txt']);
  } finally { await rm(f.root,{recursive:true,force:true}); }
});
test('validation failure remains a failure and restores environment', { skip:!windows }, async () => {
  const f=await fixture();
  try { const r=run(f,'-ValidationOnly -SkipTests',{...f.env,AM_VALIDATION_FAIL:'1'}); assert.notEqual(r.status,0);assert.match(r.stderr,/typecheck failed/);assert.doesNotMatch(r.stderr,/Environment leaked/);assert.doesNotMatch(await readFile(f.env.AM_VALIDATION_TRACE,'utf8'),/deploy|run build/); }
  finally { await rm(f.root,{recursive:true,force:true}); }
});
test('release mode still rejects dirty source before producing output', { skip:!windows }, async () => {
  const f=await fixture();
  try { const out=path.join(f.root,'release');const r=run(f,`-OutputDirectory ${quote(out)} -IiiEnginePath ${quote(process.execPath)}`);assert.notEqual(r.status,0);assert.match(r.stderr,/clean source checkout/);await assert.rejects(readdir(out),{code:'ENOENT'}); }
  finally { await rm(f.root,{recursive:true,force:true}); }
});
