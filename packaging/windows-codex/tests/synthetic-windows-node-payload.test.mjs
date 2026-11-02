import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, link, symlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { prepareWindowsNodePayload, verifyWindowsNodePayload, nativeBindingEvidence } from '../build/windows-node-payload.mjs';

const O = 'node_modules/onnxruntime-web', H = 'node_modules/@huggingface/transformers';
const G = 'node_modules/guid-typescript', M = 'node_modules/.package-map.json';
const hash = b => createHash('sha256').update(b).digest('hex');
async function put(root, path, bytes) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), bytes); }
async function snapshot(root, prefix = '') {
  const result = {};
  for (const e of await readdir(join(root, prefix), { withFileTypes: true })) {
    const name = prefix ? prefix + '/' + e.name : e.name;
    if (e.isDirectory()) Object.assign(result, await snapshot(root, name));
    else result[name] = hash(await readFile(join(root, name)));
  }
  return result;
}
async function fixture() {
  assert(process.env.AGENTMEMORY_SYNTHETIC_TEST_ROOT);
  const release = await mkdtemp(join(process.env.AGENTMEMORY_SYNTHETIC_TEST_ROOT, 'node-profile-'));
  const root = join(release, 'payload/runtime/synthetic/agentmemory');
  await mkdir(root, { recursive: true });
  const exports = { '.': { types: './types.d.ts', node: { import: './dist/root.mjs', require: './dist/root.cjs' }, import: { 'onnxruntime-web-use-extern-wasm': './dist/extern.mjs', default: './dist/browser.mjs' } } };
  for (const n of ['all', 'webgl', 'wasm', 'webgpu', 'jspi']) exports['./' + n] = { types: './types.d.ts', import: './dist/' + n + '.mjs' };
  const ort = { name: 'onnxruntime-web', version: '1.31.0-dev.20260914-8d85527a0', dependencies: { 'guid-typescript': '^1.0.9' }, exports, main: 'dist/root.cjs', browser: 'dist/browser.mjs', types: 'types.d.ts', unpkg: 'dist/browser.mjs', jsdelivr: 'dist/browser.mjs' };
  const hf = { name: '@huggingface/transformers', version: '4.3.1', main: 'dist/transformers.node.cjs', types: 'types/transformers.d.ts', unpkg: 'dist/transformers.min.js', jsdelivr: 'dist/transformers.min.js', exports: { node: { import: { types: './types/transformers.d.ts', default: './dist/transformers.node.mjs' }, require: './dist/transformers.node.cjs' }, default: './dist/transformers.min.js' } };
  const types = ["declare module 'onnxruntime-web' {\n  export * from 'onnxruntime-common';\n}\n", ...['all', 'wasm', 'webgl', 'webgpu', 'jspi'].map(n => "declare module 'onnxruntime-web/" + n + "' {\n  export * from 'onnxruntime-web';\n}\n")].join('\n');
  const map = { packages: { '.': { dependencies: { 'guid-typescript': 'guid-typescript', sharp: 'sharp' } }, 'onnxruntime-web': { dependencies: { 'guid-typescript': 'guid-typescript' } }, 'guid-typescript': { url: './guid-typescript', dependencies: { 'guid-typescript': 'guid-typescript' } } } };
  const files = { [O + '/package.json']: JSON.stringify(ort), [O + '/types.d.ts']: types, [H + '/package.json']: JSON.stringify(hf), [G + '/package.json']: '{"version":"1.0.9"}', [G + '/index.js']: 'guid-typescript', [M]: JSON.stringify(map), [O + '/lib/index.ts']: 'guid-typescript', [O + '/LICENSE']: 'MIT sentinel preserved', 'unrelated.txt': 'preserve me' };
  for (const name of ['ort.all.js','ort.all.mjs','ort.all.min.js','ort.all.min.mjs','ort.all.bundle.min.mjs','ort.webgl.js','ort.webgl.mjs','ort.webgl.min.js','ort.webgl.min.mjs','ort.all.min.js.map','ort.all.min.mjs.map','ort.all.bundle.min.mjs.map','ort.webgl.min.js.map','ort.webgl.min.mjs.map']) files[O + '/dist/' + name] = 'guid-typescript';
  for (const name of ['root.mjs','root.cjs','extern.mjs','browser.mjs','wasm.mjs','webgpu.mjs','jspi.mjs']) files[O + '/dist/' + name] = 'export {};\n//# sourceMappingURL=retained.map\n';
  files[O + '/dist/retained.map'] = '{}';
  for (const suffix of ['', '.jsep', '.jspi', '.asyncify']) for (const ext of ['mjs', 'wasm']) {
    const name = 'ort-wasm-simd-threaded' + suffix + '.' + ext;
    files[O + '/dist/' + name] = 'synthetic bytes'; ort.exports['./' + name] = './dist/' + name;
  }
  files[O + '/package.json'] = JSON.stringify(ort);
  for (const name of ['dist/transformers.node.mjs','dist/transformers.node.cjs','dist/transformers.min.js','types/transformers.d.ts']) files[H + '/' + name] = 'export {};';
  for (const name of ['onnxruntime-node','onnxruntime-common','sharp']) {
    files['node_modules/' + name + '/package.json'] = '{"main":"index.js"}';
    files['node_modules/' + name + '/index.js'] = 'export {};';
  }
  for (const [name, bytes] of Object.entries(files)) await put(root, name, bytes);
  const removed = Object.keys(files).filter(k => k.startsWith(G + '/') || k.startsWith(O + '/lib/') || /\/ort\.(?:all|webgl)/.test(k)).sort();
  const afterOrt = structuredClone(ort); delete afterOrt.exports['./all']; delete afterOrt.exports['./webgl']; delete afterOrt.dependencies['guid-typescript'];
  const afterMap = { packages: { '.': { dependencies: { sharp: 'sharp' } }, 'onnxruntime-web': { dependencies: {} } } };
  const afterTypes = types.replace("declare module 'onnxruntime-web/all' {\n  export * from 'onnxruntime-web';\n}\n",'').replace("declare module 'onnxruntime-web/webgl' {\n  export * from 'onnxruntime-web';\n}\n",'');
  const changed = { [M]: JSON.stringify(afterMap) + '\n', [O + '/package.json']: JSON.stringify(afterOrt,null,2) + '\n', [O + '/types.d.ts']: afterTypes };
  const profile = { hashes: Object.fromEntries([M,O + '/package.json',O + '/types.d.ts',G + '/package.json',H + '/package.json',H + '/dist/transformers.node.mjs'].map(k => [k,hash(files[k])])), removedDigest: hash(JSON.stringify(removed.map(k => [k,hash(files[k])]))), afterHashes: Object.fromEntries(Object.entries(changed).map(([k,v]) => [k,hash(v)])) };
  return { release, root, profile, files, removed, changed };
}
async function usingFixture(fn) {
  const f = await fixture();
  try { await fn(f); } finally { await rm(f.release, { recursive: true, force: true }); }
}
test('only the reviewed set changes; hardlinked metadata and licenses are preserved', async () => usingFixture(async f => {
  const shared = join(f.release, 'shared-original.json');
  await link(join(f.root, O, 'package.json'), shared);
  const original = await readFile(shared);
  const result = await prepareWindowsNodePayload(f.root, f.release, f.profile);
  const after = await snapshot(f.root);
  assert.deepEqual(Object.keys(f.files).filter(k => !(k in after)).sort(), f.removed);
  assert.deepEqual(Object.keys(after).filter(k => after[k] !== hash(f.files[k])).sort(), Object.keys(f.changed).sort());
  assert.deepEqual(await readFile(shared), original);
  assert.equal(result.removedFiles, f.removed.length);
  assert.equal(after[O + '/LICENSE'], hash('MIT sentinel preserved'));
  await verifyWindowsNodePayload(f.root, f.profile);
}));
for (const kind of ['version', 'metadata', 'new-guid-reference', 'unexpected-removal-file', 'missing-type-block', 'export-escape', 'fixed-candidate', 'root-escape']) {
  test('preflight rejects ' + kind + ' without mutation', async () => usingFixture(async f => {
    if (kind === 'version' || kind === 'export-escape') {
      const p = O + '/package.json', meta = JSON.parse(await readFile(join(f.root, p),'utf8'));
      if (kind === 'version') meta.version = '9.0.0'; else meta.exports['./wasm'].import = '../../outside.mjs';
      const bytes = JSON.stringify(meta); await put(f.root,p,bytes); f.profile.hashes[p] = hash(bytes);
    } else if (kind === 'metadata') await put(f.root,M,'{}');
    else if (kind === 'new-guid-reference') await put(f.root,'unexpected.js','guid-typescript');
    else if (kind === 'unexpected-removal-file') await put(f.root,O + '/lib/new.ts','new');
    else if (kind === 'missing-type-block') {
      const p = O + '/types.d.ts', bytes = f.files[p].replace("module 'onnxruntime-web/all'", "module 'onnxruntime-web/changed'");
      await put(f.root,p,bytes); f.profile.hashes[p] = hash(bytes);
    } else if (kind === 'fixed-candidate') await put(f.release,'release-manifest.json','{}');
    const before = await snapshot(f.root);
    await assert.rejects(prepareWindowsNodePayload(f.root, kind === 'root-escape' ? dirname(f.release) : f.release, f.profile));
    assert.deepEqual(await snapshot(f.root), before);
  }));
}
for (const target of ['dist/ort-wasm-simd-threaded.asyncify.wasm','dist/ort-wasm-simd-threaded.jspi.mjs','dist/extern.mjs','dist/retained.map']) {
  test('retained path cannot disappear: ' + target, async () => usingFixture(async f => {
    await prepareWindowsNodePayload(f.root, f.release, f.profile);
    await rm(join(f.root,O,target));
    await assert.rejects(verifyWindowsNodePayload(f.root, f.profile));
  }));
}
test('reintroduced GUID carrier or excluded ambient type fails final verification', async () => usingFixture(async f => {
  await prepareWindowsNodePayload(f.root, f.release, f.profile);
  await put(f.root,O + '/dist/ort.webgl.mjs','guid-typescript');
  await assert.rejects(verifyWindowsNodePayload(f.root, f.profile));
  await rm(join(f.root,O,'dist/ort.webgl.mjs'));
  await put(f.root,O + '/types.d.ts',f.files[O + '/types.d.ts']);
  await assert.rejects(verifyWindowsNodePayload(f.root, f.profile));
}));
test('junction or symlink escape is rejected before mutation', async () => usingFixture(async f => {
  const outside = join(f.release,'outside'); await mkdir(outside); await put(outside,'protected.txt','keep');
  await symlink(outside,join(f.root,'redirect'),process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepareWindowsNodePayload(f.root,f.release,f.profile),/Redirected/);
  assert.equal(await readFile(join(outside,'protected.txt'),'utf8'),'keep');
}));

test('native evidence requires both copied bindings and refuses external modules', async () => usingFixture(async f => {
  const names = [
    'node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime_binding.node',
    'node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64-0.35.5.node',
  ];
  for (const name of names) await put(f.root, name, 'synthetic native bytes, never loaded');
  const paths = names.map(name => join(f.root,name));
  assert.equal((await nativeBindingEvidence(f.root,paths)).length,2);
  await assert.rejects(nativeBindingEvidence(f.root,paths.slice(0,1)),/Expected native binding missing/);
  await put(f.release,'outside.node','synthetic outside bytes');
  await assert.rejects(nativeBindingEvidence(f.root,[...paths,join(f.release,'outside.node')]),/outside payload/);
  await put(f.release,'outside.js','synthetic outside code');
  await assert.rejects(nativeBindingEvidence(f.root,[...paths,join(f.release,'outside.js')]),/outside payload/);
}));
