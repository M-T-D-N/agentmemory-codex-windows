import assert from 'node:assert/strict';
import { lstat, readdir, readFile, writeFile, realpath, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const O = 'node_modules/onnxruntime-web';
const H = 'node_modules/@huggingface/transformers';
const G = 'node_modules/guid-typescript';
const MAP = 'node_modules/.package-map.json';
const carriers = [
  'ort.all.js', 'ort.all.mjs', 'ort.all.min.js', 'ort.all.min.mjs', 'ort.all.bundle.min.mjs',
  'ort.webgl.js', 'ort.webgl.mjs', 'ort.webgl.min.js', 'ort.webgl.min.mjs',
  'ort.all.min.js.map', 'ort.all.min.mjs.map', 'ort.all.bundle.min.mjs.map',
  'ort.webgl.min.js.map', 'ort.webgl.min.mjs.map',
].map(name => O + '/dist/' + name);
const trees = [O + '/lib', G];
const isRemoved = path => carriers.includes(path) || trees.some(tree => path.startsWith(tree + '/'));
const textFile = path => /\.(?:[cm]?js|ts|map|json)$/i.test(path);
const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
export const PINNED_WINDOWS_NODE_INPUTS = {
  "hashes": {
    "node_modules/.package-map.json": "700d126ffcb95b4500cd936303e3a3136b375607c460f5c4c8298974adad7d0d",
    "node_modules/@huggingface/transformers/dist/transformers.node.mjs": "af55cea9ad097b6aaef7e8c8ba8fd3aa6ae383e47584bfa5162e240859b232c3",
    "node_modules/@huggingface/transformers/package.json": "301ae33e44c5ef32b8bd649b880637d4927dbaf248568f7a533e3e2ff831fb0e",
    "node_modules/guid-typescript/package.json": "ed86856ee95fe87eadd8552b6803a85b7fb4f6cce08603bf9c8385972b5badb6",
    "node_modules/onnxruntime-web/package.json": "ce2ce78732a15ddcaf52fe5f26c801a05ff149abda4e875dc2837d8a99e455b2",
    "node_modules/onnxruntime-web/types.d.ts": "630dc5c23ad8641470983465197c7d02ba8b7e80a7fcb61e8a66a0782bc5dad9"
  },
  "removedDigest": "296fa284cd6a170cc8f5833ab648cef327431769ba9ba20ea9f446b3047dee9e",
  "afterHashes": {
    "node_modules/.package-map.json": "58b93d9e90f921440b98b61021c4a4339e56edcc254787cee518e2527b46be0b",
    "node_modules/onnxruntime-web/package.json": "212463ed336dc02b7f9c1815cbab66f815ac5a91ec21fd79f0d523ee1f158a38",
    "node_modules/onnxruntime-web/types.d.ts": "c67d4b9751cf300fcfc027cc13766d7b268d7d29867a9eb30f7386001b0f7352"
  }
};

async function physical(path) {
  path = resolve(path);
  for (let p = path; ; p = dirname(p)) {
    assert(!(await lstat(p)).isSymbolicLink(), 'Redirected Windows payload path');
    if (p === dirname(p)) break;
  }
  assert.equal((await realpath(path)).toLowerCase(), path.toLowerCase(), 'Physical payload path mismatch');
  return path;
}
async function absent(path) {
  try { await lstat(path); } catch (e) { if (e.code === 'ENOENT') return true; throw e; }
  return false;
}
async function inventory(root) {
  const rows = {};
  async function walk(dir) {
    for (const name of await readdir(dir)) {
      const path = join(dir, name), info = await lstat(path);
      assert(!info.isSymbolicLink(), 'Redirected Windows payload entry');
      if (info.isDirectory()) await walk(path);
      else {
        assert(info.isFile(), 'Nonregular Windows payload entry');
        const key = relative(root, path).split(sep).join('/');
        rows[key] = { sha256: hash(await readFile(path)), bytes: info.size };
      }
    }
  }
  await walk(root);
  return rows;
}
async function fileTarget(root, packagePath, target) {
  assert(typeof target === 'string' && !isAbsolute(target), 'Invalid retained target');
  const path = resolve(root, packagePath, target), within = relative(join(root, packagePath), path);
  assert(within && within !== '..' && !within.startsWith('..' + sep) && !isAbsolute(within), 'Retained target escapes package');
  await physical(path);
  const info = await lstat(path);
  assert(info.isFile() && info.size > 0, 'Missing or empty retained target');
}
async function targets(root, packagePath, value) {
  if (typeof value === 'string') await fileTarget(root, packagePath, value);
  else {
    assert(value && typeof value === 'object' && !Array.isArray(value), 'Invalid retained exports');
    for (const child of Object.values(value)) await targets(root, packagePath, child);
  }
}
async function retainedPaths(root, ort, hf, removed) {
  const next = structuredClone(ort.exports);
  if (!removed) { delete next['./all']; delete next['./webgl']; }
  for (const key of ['.', './wasm', './webgpu', './jspi']) assert(next[key], 'Missing retained export branch');
  await targets(root, O, next);
  for (const key of ['main', 'browser', 'types', 'unpkg', 'jsdelivr']) await fileTarget(root, O, ort[key]);
  await targets(root, H, hf.exports);
  for (const key of ['main', 'types', 'unpkg', 'jsdelivr']) await fileTarget(root, H, hf[key]);
  for (const suffix of ['', '.jsep', '.jspi', '.asyncify'])
    for (const ext of ['mjs', 'wasm']) await fileTarget(root, O, './dist/ort-wasm-simd-threaded' + suffix + '.' + ext);
  for (const packagePath of [O, H]) {
    for (const name of await readdir(join(root, packagePath, 'dist'))) {
      const rel = packagePath + '/dist/' + name;
      if (!/\.[cm]?js$/.test(name) || (!removed && isRemoved(rel))) continue;
      const text = decode(await readFile(join(root, rel)));
      for (const match of text.matchAll(/^\s*\/\/[#@]\s*sourceMappingURL=(\S+)\s*$/gm)) {
        if (match[1].startsWith('data:')) continue;
        await fileTarget(root, packagePath, './dist/' + match[1]);
      }
    }
  }
  for (const packagePath of ['node_modules/onnxruntime-node', 'node_modules/onnxruntime-common', 'node_modules/sharp']) {
    const meta = JSON.parse(await readFile(join(root, packagePath, 'package.json'), 'utf8'));
    if (meta.exports) await targets(root, packagePath, meta.exports);
    else await fileTarget(root, packagePath, meta.main);
  }
}
async function noUnexpectedGuid(root, rows, before) {
  const allowedMetadata = new Set([MAP, O + '/package.json']);
  for (const name of Object.keys(rows)) {
    if (!textFile(name) || (before && (isRemoved(name) || allowedMetadata.has(name)))) continue;
    assert(!decode(await readFile(join(root, name))).includes('guid-typescript'), 'Unexpected GUID reference: ' + name);
  }
}
// The builder exclusively owns a fresh staging root. This is not a hostile-writer lock.
export async function prepareWindowsNodePayload(root, releaseRoot, profile = PINNED_WINDOWS_NODE_INPUTS) {
  assert.equal(process.env.AGENTMEMORY_INTEGRATION, '0');
  assert.equal(process.env.AGENTMEMORY_CURATE, '0');
  root = await physical(root); releaseRoot = await physical(releaseRoot);
  const within = relative(releaseRoot, root).split(sep).join('/');
  assert(/^payload\/runtime\/[^/]+\/agentmemory$/.test(within), 'Not a fresh runtime staging path');
  assert(await absent(join(releaseRoot, 'release-manifest.json')), 'Immutable candidate cannot be pruned');
  assert(await absent(join(root, '.git')), 'Source checkout cannot be pruned');
  const before = await inventory(root);
  for (const [name, expected] of Object.entries(profile.hashes))
    assert.equal(before[name]?.sha256, expected, 'Pinned input differs: ' + name);
  const ort = JSON.parse(await readFile(join(root, O, 'package.json'), 'utf8'));
  const hf = JSON.parse(await readFile(join(root, H, 'package.json'), 'utf8'));
  const guid = JSON.parse(await readFile(join(root, G, 'package.json'), 'utf8'));
  assert.equal(ort.version, '1.31.0-dev.20260914-8d85527a0'); assert.equal(hf.version, '4.3.1'); assert.equal(guid.version, '1.0.9');
  for (const name of carriers) assert(before[name], 'Missing expected carrier: ' + name);
  for (const name of trees) assert((await lstat(join(root, name))).isDirectory());
  const removed = Object.keys(before).filter(isRemoved).sort();
  assert.equal(hash(JSON.stringify(removed.map(name => [name, before[name].sha256]))), profile.removedDigest, 'Pinned removal set differs');
  await retainedPaths(root, ort, hf, false);
  await noUnexpectedGuid(root, before, true);
  const types = decode(await readFile(join(root, O, 'types.d.ts'))).replaceAll('\r\n', '\n');
  let nextTypes = types;
  for (const name of ['all', 'webgl']) {
    const block = "declare module 'onnxruntime-web/" + name + "' {\n  export * from 'onnxruntime-web';\n}\n";
    assert.equal(nextTypes.split(block).length, 2, 'Expected type block differs');
    nextTypes = nextTypes.replace(block, '');
    assert(ort.exports['./' + name]); delete ort.exports['./' + name];
  }
  assert.equal(ort.dependencies['guid-typescript'], '^1.0.9'); delete ort.dependencies['guid-typescript'];
  const map = JSON.parse(await readFile(join(root, MAP), 'utf8'));
  assert.equal(map.packages['.'].dependencies['guid-typescript'], 'guid-typescript');
  assert.equal(map.packages['onnxruntime-web'].dependencies['guid-typescript'], 'guid-typescript');
  assert.deepEqual(map.packages['guid-typescript'], { url: './guid-typescript', dependencies: { 'guid-typescript': 'guid-typescript' } });
  delete map.packages['.'].dependencies['guid-typescript'];
  delete map.packages['onnxruntime-web'].dependencies['guid-typescript'];
  delete map.packages['guid-typescript'];
  const outputs = { [MAP]: JSON.stringify(map) + '\n', [O + '/package.json']: JSON.stringify(ort, null, 2) + '\n', [O + '/types.d.ts']: nextTypes };
  for (const [name, bytes] of Object.entries(outputs)) {
    assert.equal(hash(bytes), profile.afterHashes[name], 'Unexpected transformed metadata');
    assert(await absent(join(root, name + '.windows-node.tmp')), 'Preserved partial transform exists');
  }
  // Replace each inode: pnpm can hardlink deployed metadata to its shared store.
  for (const [name, bytes] of Object.entries(outputs)) {
    const path = join(root, name), temp = path + '.windows-node.tmp';
    await writeFile(temp, bytes, { flag: 'wx' }); await rename(temp, path);
  }
  for (const name of [...carriers, ...trees]) await rm(join(root, name), { recursive: trees.includes(name) });
  const after = await inventory(root);
  assert.deepEqual(Object.keys(before).filter(name => !after[name]).sort(), removed);
  for (const [name, row] of Object.entries(after))
    assert.equal(row.sha256, profile.afterHashes[name] ?? before[name]?.sha256, 'Retained payload changed: ' + name);
  await verifyWindowsNodePayload(root, profile, after);
  return { scope: 'Windows Node shipping profile; no pretrained/GPU or operating qualification', removedFiles: removed.length,
    removedBytes: removed.reduce((n, name) => n + before[name].bytes, 0), changedMetadata: Object.keys(outputs),
    retainedByteIdentical: Object.keys(after).length - Object.keys(outputs).length };
}
export async function verifyWindowsNodePayload(root, profile = PINNED_WINDOWS_NODE_INPUTS, rows) {
  root = await physical(root); rows ??= await inventory(root);
  for (const name of [...carriers, ...trees]) assert(await absent(join(root, name)), 'Excluded GUID carrier reintroduced');
  for (const [name, expected] of Object.entries({ ...profile.hashes, ...profile.afterHashes })) {
    if (name.startsWith(G + '/')) continue;
    assert.equal(rows[name]?.sha256, expected, 'Windows payload profile differs: ' + name);
  }
  const ort = JSON.parse(await readFile(join(root, O, 'package.json'), 'utf8'));
  const hf = JSON.parse(await readFile(join(root, H, 'package.json'), 'utf8'));
  assert(!ort.exports['./all'] && !ort.exports['./webgl'] && !ort.dependencies['guid-typescript']);
  await retainedPaths(root, ort, hf, true);
  await noUnexpectedGuid(root, rows, false);
  return { success: true, scope: 'Pinned metadata and retained references, not WASM/WebGPU/GPU execution' };
}
export async function nativeBindingEvidence(root, loadedPaths) {
  root = await physical(root);
  const bindings = [];
  for (const path of loadedPaths) {
    const actual = await physical(path), within = relative(root, actual);
    assert(within && within !== '..' && !within.startsWith('..' + sep) && !isAbsolute(within), 'Module loaded outside payload');
    if (actual.endsWith('.node')) bindings.push({ path: within.split(sep).join('/'), sha256: hash(await readFile(actual)) });
  }
  for (const expected of [
    'node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime_binding.node',
    'node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64-0.35.5.node',
  ]) assert(bindings.some(binding => binding.path === expected), 'Expected native binding missing: ' + expected);
  return bindings;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await prepareWindowsNodePayload(...process.argv.slice(2)))); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}
