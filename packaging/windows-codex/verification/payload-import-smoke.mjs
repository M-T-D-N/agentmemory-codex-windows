import assert from 'node:assert/strict';
import { readFile, realpath, lstat } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyWindowsNodePayload } from '../build/windows-node-payload.mjs';

export async function smokePayload(root, sourceRoot) {
  assert.equal(process.env.AGENTMEMORY_INTEGRATION, '0');
  assert.equal(process.env.AGENTMEMORY_CURATE, '0');
  root = await realpath(root);
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const source = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'));
  assert.equal(metadata.name, '@agentmemory/agentmemory');
  assert.equal(metadata.version, source.version);
  assert.equal(metadata.agentmemoryDownstream.version, source.agentmemoryDownstream.version);
  const importTarget = name => {
    const entry = metadata.exports?.[name];
    const target = typeof entry === 'string' ? entry : entry?.import;
    assert(typeof target === 'string' && target.startsWith('./'), 'Missing explicit ESM export');
    return resolve(root, target);
  };
  const checked = [];
  for (const name of ['.', './diagnostics', './dist/standalone.mjs']) {
    const path = await realpath(importTarget(name));
    const within = relative(root, path);
    assert(within && !within.startsWith('..') && !isAbsolute(within), 'Export escapes payload');
    assert((await lstat(path)).isFile());
    checked.push(path);
  }
  checked.push(join(root, 'dist/cli.mjs'));
  for (const path of checked) {
    const child = spawnSync(process.execPath, ['--check', path], { windowsHide: true, timeout: 15000, encoding: 'utf8' });
    assert.ifError(child.error);
    assert.equal(child.status, 0, `Payload syntax check failed: ${relative(root, path)}`);
  }
  const diagnostics = await import(pathToFileURL(importTarget('./diagnostics')).href);
  for (const name of ['canonicalCodexCwd', 'parseCodexSourceIdentity', 'readCodexSourceIdentity']) assert.equal(typeof diagnostics[name], 'function');
  assert.equal(diagnostics.canonicalCodexCwd('D:\\Synthetic\\Garden\\'), 'd:\\synthetic\\garden');
  const esm = spawnSync(process.execPath, ['--input-type=module', '--eval',
    "import assert from 'node:assert/strict'; const m = await import('@agentmemory/agentmemory/diagnostics'); assert.equal(typeof m.parseCodexSourceIdentity, 'function');"],
    { cwd: root, windowsHide: true, timeout: 15000 });
  assert.ifError(esm.error);
  assert.equal(esm.status, 0, 'Public ESM diagnostics export cannot be imported from payload');
  const windowsNodeProfile = await verifyWindowsNodePayload(root);
  const inference = spawnSync(process.execPath, [fileURLToPath(new URL('./windows-node-inference-smoke.mjs', import.meta.url)), root],
    { cwd: root, windowsHide: true, timeout: 45000, encoding: 'utf8' });
  assert.ifError(inference.error);
  assert.equal(inference.status, 0, 'Synthetic native Node inference smoke failed: ' + inference.stderr);
  const nativeInference = JSON.parse(inference.stdout);
  return { windowsNodeProfile, nativeInference, success: true, scope: 'Payload exports/syntax, import-safe diagnostics and synthetic CPU MatMul/image path; no pretrained provider/GPU or live readiness qualification', version: metadata.version, downstream: metadata.agentmemoryDownstream.version, checked: checked.map(path => relative(root, path)) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await smokePayload(...process.argv.slice(2)))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
