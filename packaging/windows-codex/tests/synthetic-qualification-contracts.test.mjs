import assert from 'node:assert/strict';
import test from 'node:test';
import { hash, payloadDigest, parseSuiteLog, verifyQualificationRecordContract, verifyQualificationRecords, sourceInputDigest, verifyUserLibraryRecords, verifyMemoryPreservation, verifyWindowsScenarioEvidence } from '../verification/distribution-qualification.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

test('captured native layout bytes are independently hash bound', () => {
  const layout=JSON.parse(readFileSync(new URL('./fixtures/sharp-win32-x64-0.35.5-layout.json',import.meta.url),'utf8'));
  for (const field of ['package_json','index_cjs']) assert.equal(hash(Buffer.from(layout[field].text)),layout[field].sha256);
  assert.equal(layout.index_cjs.sha256,'6ecbd583f45e914233410fe83a614e4f5ff1a6875a7eb828b03b7258e8ba6944');
  assert.equal(layout.manifest_sha256,'86625a2bd94361b806c1e567a0da0831ad5521609c84d05932fc47c9baa82d73');
});

test('default manifests require neither custom fields nor provenance files', () => {
  assert.deepEqual(verifyUserLibraryRecords({immutable_files:[]},{}),[]);
  assert.throws(() => verifyUserLibraryRecords({immutable_files:[]},{library_input_digest:'a'.repeat(64)}));
});

function syntheticRecords() {
  const manifest = { build_kind: 'release_candidate', tests_skipped: false, source_commit: 'a'.repeat(40),
    source_input_digest: 'b'.repeat(64), release_revision: 'synthetic-only',
    immutable_files: [{ path: 'synthetic.txt', sha256: hash('synthetic'), size_bytes: 9 }] };
  const manifestHash = hash(JSON.stringify(manifest));
  const qualification = { schema_version: 1, tests_skipped: false, source_commit: manifest.source_commit,
    source_input_digest: manifest.source_input_digest, manifest_sha256: manifestHash,
    payload_digest: payloadDigest(manifest), environment: { node: 'synthetic', pnpm: 'synthetic', platform: 'synthetic', powershell: 'synthetic' },
    suites: Object.fromEntries(['source', 'adapter', 'packaging'].map(name => [name,
      { status: 'passed', passed: 1, failed: 0, cancelled: 0, skipped: 0, total: 1 }])),
    windows_e2e: { source_commit: manifest.source_commit, manifest_sha256: manifestHash,
      fresh_install: 'passed', managed_update: 'passed', restart: 'passed', failure_recovery: 'passed' } };
  const native = { success: true, identity: { sourceCommit: manifest.source_commit, releaseManifestHash: manifestHash,
    runtime: manifest.release_revision, activationAt: '2026-01-01T00:00:00Z' },
    target: { observationId: 'synthetic-observation', sourceKey: 'synthetic-source' },
    stages: Object.fromEntries(['worker-start', 'capture', 'discovery', 'drain', 'search', 'status', 'qualification'].map(name => [name, { status: 'passed' }])) };
  native.stages.qualification.result = { freshGraph: { sourceId: native.target.observationId,
    sourceKey: native.target.sourceKey, nodes: ['synthetic-node'], extraction: { completedAt: '2026-01-01T00:00:01Z' } } };
  return { manifest, manifestHash, inputDigest: manifest.source_input_digest, qualification, native };
}

test('qualification binding refuses incomplete or substituted synthetic records', async t => {
  assert.equal(verifyQualificationRecordContract(syntheticRecords()).success, true);
  const mutations = {
    diagnostic: x => { x.manifest.build_kind = 'diagnostic'; },
    skipped: x => { x.qualification.tests_skipped = true; },
    source: x => { x.qualification.source_commit = 'c'.repeat(40); },
    inputs: x => { x.inputDigest = 'c'.repeat(64); },
    manifest: x => { x.manifestHash = 'c'.repeat(64); },
    payload: x => { x.manifest.immutable_files[0].sha256 = 'c'.repeat(64); },
    suite: x => { delete x.qualification.suites.packaging; },
    failure: x => { x.qualification.suites.adapter.failed = 1; },
    accounting: x => { x.qualification.suites.source.total = 2; },
    packagingSkip: x => { Object.assign(x.qualification.suites.packaging, { skipped: 1, total: 2, skip_reason: 'synthetic skip' }); },
    unconfirmed: x => { x.native.success = false; },
    runtime: x => { x.native.identity.runtime = 'foreign-synthetic'; },
    stage: x => { x.native.stages.search.status = 'not-run'; },
    sourceLink: x => { x.native.stages.qualification.result.freshGraph.sourceKey = 'wrong'; },
    emptyGraph: x => { x.native.stages.qualification.result.freshGraph.nodes = []; },
    staleGraph: x => { x.native.stages.qualification.result.freshGraph.extraction.completedAt = '2025-12-31T23:59:59Z'; },
  };
  for (const scenario of ['fresh_install', 'managed_update', 'restart', 'failure_recovery'])
    mutations[`missing ${scenario}`] = x => { x.qualification.windows_e2e[scenario] = 'not-run'; };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, () => {
    const value = syntheticRecords(); mutate(value); assert.throws(() => verifyQualificationRecordContract(value));
  });
});

test('qualification log parser refuses failed ambiguous and unaccounted summaries', () => {
  const tap = '# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
  assert.equal(parseSuiteLog('packaging', tap).passed, 1);
  for (const invalid of [tap + tap, tap.replace('# fail 0', '# fail 1'), tap.replace('# tests 1', '# tests 2'), ''])
    assert.throws(() => parseSuiteLog('packaging', invalid));
});

test('explicit synthetic inventory rejects escape and duplicate files and binds changed bytes', async () => {
  assert.ok(process.env.AGENTMEMORY_SYNTHETIC_TEST_ROOT);
  const root = await mkdtemp(join(process.env.AGENTMEMORY_SYNTHETIC_TEST_ROOT, 'qualification-'));
  try {
    await writeFile(join(root, 'synthetic.txt'), 'synthetic-first');
    const first = await sourceInputDigest(root, ['synthetic.txt']);
    await writeFile(join(root, 'synthetic.txt'), 'synthetic-other');
    assert.notEqual((await sourceInputDigest(root, ['synthetic.txt'])).sha256, first.sha256);
    await assert.rejects(sourceInputDigest(root, ['../outside.txt']));
    await assert.rejects(sourceInputDigest(root, ['synthetic.txt', 'synthetic.txt']));
  } finally { await rm(root, { recursive: true, force: true }); }
});

function windowsProof() {
  const files=new Map();let next=0;
  const bind=value=>{const path='synthetic-'+next++;const bytes=Buffer.from(JSON.stringify(value));files.set(path,bytes);return {path,sha256:hash(bytes)};};
  const memory={id:'synthetic-id',content:'explicitly synthetic content',project:'synthetic-project',origin:{channel:'agent',capturedAt:'2026-01-01T00:00:00Z'}};
  const row={created:bind({memory}),search:bind({results:[{observation:{id:memory.id,narrative:memory.content},project:memory.project}]}),detail:bind({memory})};
  const qualification={source_commit:'a'.repeat(40),source_input_digest:'b'.repeat(64),manifest_sha256:'c'.repeat(64)};
  const result={...qualification,scenarios:{}};
  for(const [name,phases] of Object.entries({fresh_install:['prepare','activate'],restart:['stop','start'],managed_update:['update'],failure_recovery:['inject','recover']}))
    result.scenarios[name]={success:true,memory:structuredClone(row),steps:phases.map(phase=>({phase,process:bind({pid:123,parent_pid:122,command:['synthetic-command',phase],creation_filetime:1,start_utc:'2026-01-01T00:00:00Z',end_utc:'2026-01-01T00:00:01Z',exit_code:phase==='inject'?1:0,stdout:bind('synthetic stdout'),stderr:bind('synthetic stderr')})}))};
  result.scenarios.failure_recovery.failure=bind({outcome:'rollback_failed',phase:'copy-adapter',original_error:'synthetic copy error',restore_error:'synthetic restore error'});
  return {result,qualification,load:async path=>{assert(files.has(path));return files.get(path);},files,bind,memory};
}

test('legacy Windows phase fixtures cannot confer execution acceptance', async () => {
  const old=windowsProof();
  await assert.rejects(verifyWindowsScenarioEvidence(old.result,old.qualification,old.load),/Synthetic or legacy/);
});
test('synthetic record contracts and forged Windows labels cannot qualify distribution', () => {
  const value=syntheticRecords();
  const contract=verifyQualificationRecordContract(value);
  assert.equal(contract.production_qualified,false);
  for(const windowsEvidence of [undefined,contract,{success:true,acceptance:'windows_execution'}])
    assert.throws(()=>verifyQualificationRecords({...value,windowsEvidence}),/Live Windows verification/);
});
