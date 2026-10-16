import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hash, payloadDigest, sourceInputDigest, verifyQualificationRecords, parseSuiteLog } from '../verification/distribution-qualification.mjs';

function fixture() {
  const manifest = { source_commit:'a'.repeat(40), source_input_digest:'b'.repeat(64), release_revision:'r212', build_kind:'release_candidate', tests_skipped:false,
    immutable_files:[{ path:'runtime/worker.mjs', sha256:'c'.repeat(64), size_bytes:10 }] };
  const suite = { status:'passed', passed:4, failed:0, cancelled:0, skipped:0, total:4 };
  const qualification = { schema_version:1, tests_skipped:false, source_commit:manifest.source_commit, source_input_digest:manifest.source_input_digest,
    manifest_sha256:hash(JSON.stringify(manifest)), payload_digest:payloadDigest(manifest), environment:{node:'24',pnpm:'11',platform:'win32',powershell:'5.1'},
    suites:{source:{...suite},adapter:{...suite},packaging:{...suite}}, windows_e2e:{source_commit:manifest.source_commit,manifest_sha256:hash(JSON.stringify(manifest)),fresh_install:'passed',managed_update:'passed',restart:'passed',failure_recovery:'passed'} };
  const native = { success:true, identity:{sourceCommit:manifest.source_commit,releaseManifestHash:qualification.manifest_sha256,runtime:'r212',activationAt:'2026-10-15T00:00:00Z'},
    target:{observationId:'actual-source-fixture',sourceKey:'native-key-fixture'},stages:Object.fromEntries(['worker-start','capture','discovery','drain','search','status','qualification'].map(name=>[name,{status:'passed'}])) };
  native.stages.qualification.result = {freshGraph:{sourceId:native.target.observationId,sourceKey:native.target.sourceKey,nodes:['linked-node-fixture'],extraction:{completedAt:'2026-10-15T00:01:00Z'}}};
  return {manifest,manifestHash:qualification.manifest_sha256,inputDigest:manifest.source_input_digest,qualification,native};
}
test('matching candidate and full synthetic evidence records qualify', () => assert.equal(verifyQualificationRecords(fixture()).success,true));
test('one summary parser preserves counts and rejects incomplete or contradictory logs', () => {
  assert.equal(parseSuiteLog('source','Tests 42 passed | 3 skipped (45)').skipped,3);
  assert.equal(parseSuiteLog('packaging','# tests 4\n# pass 4\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n').passed,4);
  for(const log of ['Tests 0 passed (0)','Tests 42 passed (43)','Tests 2 failed | 4 passed (6)','Tests 1 passed\nTests 1 passed'])assert.throws(()=>parseSuiteLog('source',log));
  assert.throws(()=>parseSuiteLog('packaging','# tests 4\n# pass 4\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n'));
});
for (const fault of ['missing','failed','skipped','old-commit','source-input','manifest','payload','environment','windows','native','native-stage','old-graph','unexplained-skip']) {
  test(`distribution rejects ${fault} qualification`, () => {
    const f=fixture();
    if(fault==='missing')delete f.qualification.suites;
    if(fault==='failed')f.qualification.suites.source.failed=1;
    if(fault==='skipped')f.qualification.tests_skipped=true;
    if(fault==='old-commit')f.qualification.source_commit='d'.repeat(40);
    if(fault==='source-input')f.inputDigest='d'.repeat(64);
    if(fault==='manifest')f.manifestHash='d'.repeat(64);
    if(fault==='payload')f.manifest.immutable_files[0].sha256='d'.repeat(64);
    if(fault==='environment')delete f.qualification.environment.powershell;
    if(fault==='windows')f.qualification.windows_e2e.failure_recovery='not-run';
    if(fault==='native')f.native.success=false;
    if(fault==='native-stage')delete f.native.stages.discovery;
    if(fault==='old-graph')f.native.stages.qualification.result.freshGraph.extraction.completedAt='2026-10-14T00:00:00Z';
    if(fault==='unexplained-skip'){f.qualification.suites.source.skipped=1;f.qualification.suites.source.total++}
    assert.throws(()=>verifyQualificationRecords(f));
  });
}
test('source digest binds raw file bytes and excludes inventory order', async () => {
  const root=await mkdtemp(join(tmpdir(),'am-qualification-input-'));
  try {
    await writeFile(join(root,'one.ts'),'exact one\n');await writeFile(join(root,'two.ts'),'exact two\n');
    const before=await sourceInputDigest(root,['one.ts','two.ts']);
    assert.deepEqual(await sourceInputDigest(root,['two.ts','one.ts']),before);
    await writeFile(join(root,'two.ts'),'changed\n');assert.notEqual((await sourceInputDigest(root,['one.ts','two.ts'])).sha256,before.sha256);
  }finally{await rm(root,{recursive:true,force:true})}
});
