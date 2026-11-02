import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { writeSyntheticWindowsEvidence } from '../verification/windows-evidence-collector.mjs';
import { hash, verifySyntheticWindowsScenarioEvidence, verifyWindowsScenarioEvidence } from '../verification/distribution-qualification.mjs';
import { fixture } from './fixtures/windows-evidence-synthetic.mjs';

function input() {
  const x=fixture(),markers={evidence_kind:'synthetic_contract',synthetic:true,production_qualified:false};
  return {
    unitId:'unit',
    plan:{schema_version:1,...markers,execution_id:x.result.execution_id,
      source_commit:x.result.source_commit,source_input_digest:x.result.source_input_digest,
      manifest_sha256:x.result.manifest_sha256,release_root:x.context.releaseRoot,
      windows_e2e:structuredClone(x.qualification.windows_e2e)},
    manifestBytes:Buffer.from(x.context.manifestBytes),result:{...structuredClone(x.result),...markers},
    records:[...x.files].map(([logical_path,bytes],i)=>({id:'record-'+i,logical_path,bytes:Buffer.from(bytes),sha256:hash(bytes)}))
  };
}
function changeRecord(x,ref,change) {
  const row=x.records.find(r=>r.logical_path===ref.path);assert(row);
  const value=JSON.parse(row.bytes);change(value);row.bytes=Buffer.from(JSON.stringify(value));row.sha256=hash(row.bytes);ref.sha256=row.sha256;
}
async function scoped(action) {
  assert.equal(process.env.AGENTMEMORY_INTEGRATION,'0');assert.equal(process.env.AGENTMEMORY_CURATE,'0');
  assert(process.env.AGENTMEMORY_SYNTHETIC_TEST_ROOT);
  const root=await mkdtemp(join(process.env.AGENTMEMORY_SYNTHETIC_TEST_ROOT,'assembler-'));
  try {return await action(root);} finally {await rm(root,{recursive:true,force:true});}
}

test('synthetic assembler preserves supplied bytes/times and its disk artifacts satisfy the real synthetic verifier',async()=>scoped(async root=>{
  const supplied=input(),original=structuredClone(supplied.result);
  const output=await writeSyntheticWindowsEvidence({...supplied,scratchRoot:root});
  assert.equal(output.production_qualified,false);assert.equal(output.evidence_kind,'synthetic_contract');assert.equal(output.synthetic,true);
  assert.deepEqual(output.result,original);
  for(const row of output.inventory) {
    const expected=supplied.records.find(x=>x.id===row.id);
    const bytes=await readFile(join(output.root,row.relative_path));
    assert.deepEqual(bytes,expected.bytes);assert.equal(hash(bytes),expected.sha256);
  }
  const complete=JSON.parse(await readFile(join(output.root,'assembly-complete.json'),'utf8'));
  assert.equal(complete.production_qualified,false);assert.equal(complete.status,'complete');
  const checked=await verifySyntheticWindowsScenarioEvidence(output.result,output.qualification,output.context);
  assert.equal(checked.success,true);assert.equal(checked.production_qualified,false);
  await assert.rejects(verifyWindowsScenarioEvidence(output.result,output.qualification,output.context),/Synthetic or legacy/);
}));

test('synthetic assembler rejects incomplete/foreign inputs before creating an artifact',async t=>{
  const bad={
    traversal:x=>{x.unitId='../escape';},
    nestedId:x=>{x.unitId='nested/path';},
    windowsReservedId:x=>{x.unitId='CON';},
    trailingDotId:x=>{x.unitId='unit.';},
    reservedRawId:x=>{x.records[0].id='NUL.bin';},
    rawIdTraversal:x=>{x.records[0].id='../escape';},
    logicalTraversal:x=>{x.records[0].logical_path='../outside';},
    duplicateId:x=>{x.records[1].id=x.records[0].id;},
    duplicateCaseId:x=>{x.records[1].id=x.records[0].id.toUpperCase();},
    duplicateLogical:x=>{x.records[1].logical_path=x.records[0].logical_path;},
    wrongRawHash:x=>{x.records[0].sha256='0'.repeat(64);},
    changedRawBytes:x=>{x.records[0].bytes=Buffer.from('changed supplied bytes');},
    wrongManifestHash:x=>{x.plan.manifest_sha256='0'.repeat(64);},
    wrongExecution:x=>{x.plan.execution_id='22222222-2222-4222-8222-222222222222';},
    wrongCandidate:x=>{x.plan.source_commit='c'.repeat(40);},
    foreignTarget:x=>{x.plan.windows_e2e.installations.a.root='D:\\foreign-install';},
    missingPhase:x=>{x.result.scenarios.restart.steps.pop();},
    missingBytes:x=>{const path=x.result.scenarios.restart.steps[0].process.path;x.records=x.records.filter(r=>r.logical_path!==path);},
    staleSearch:x=>changeRecord(x,x.result.scenarios.restart.memory.search,r=>{r.observed_at_utc='2026-01-01T00:01:41Z';}),
    duplicateCapture:x=>{
      const source=JSON.parse(x.records.find(r=>r.logical_path===x.result.scenarios.restart.memory.search.path).bytes);
      changeRecord(x,x.result.scenarios.restart.memory.detail,r=>{r.capture_id=source.capture_id;});
    },
    nullExit:x=>changeRecord(x,x.result.scenarios.restart.steps[0].process,r=>{r.exit_code=null;}),
    productionPlan:x=>{x.plan.evidence_kind='windows_execution';x.plan.synthetic=false;},
    productionResult:x=>{x.result.production_qualified=true;},
    missingSyntheticMarker:x=>{delete x.result.synthetic;},
    productionManifest:x=>{
      const manifest=JSON.parse(x.manifestBytes);manifest.evidence_kind='windows_execution';manifest.synthetic=false;
      x.manifestBytes=Buffer.from(JSON.stringify(manifest));x.plan.manifest_sha256=hash(x.manifestBytes);x.result.manifest_sha256=x.plan.manifest_sha256;
    }
  };
  for(const [name,change] of Object.entries(bad))await t.test(name,async()=>scoped(async root=>{
    const supplied=input();change(supplied);
    await assert.rejects(writeSyntheticWindowsEvidence({...supplied,scratchRoot:root}));
    assert.deepEqual(await readdir(root),[]);
  }));
});

test('create-new rejects an existing unit without overwriting any file',async()=>scoped(async root=>{
  await mkdir(join(root,'unit'));await writeFile(join(root,'unit/result.json'),'existing sentinel');
  await assert.rejects(writeSyntheticWindowsEvidence({...input(),scratchRoot:root}),{code:'EEXIST'});
  assert.equal(await readFile(join(root,'unit/result.json'),'utf8'),'existing sentinel');
}));
test('stored bytes changing after assembly are rejected on verification',async()=>scoped(async root=>{
  const output=await writeSyntheticWindowsEvidence({...input(),scratchRoot:root});
  const logical=output.result.scenarios.restart.memory.detail.path;
  const row=output.inventory.find(x=>x.logical_path===logical);
  await writeFile(join(output.root,row.relative_path),'tampered artifact');
  await assert.rejects(verifySyntheticWindowsScenarioEvidence(output.result,output.qualification,output.context),/Stored raw evidence changed/);
}));
test('redirected scratch directories are refused without writing through the link',async()=>scoped(async root=>{
  const target=join(root,'physical'),link=join(root,'redirect');await mkdir(target);await symlink(target,link,'junction');
  await assert.rejects(writeSyntheticWindowsEvidence({...input(),scratchRoot:link}),/redirect/);
  assert.deepEqual(await readdir(target),[]);
}));
test('module import is inert and does not create an artifact',async()=>scoped(async root=>{
  const before=await readdir(root);
  await import(new URL('../verification/windows-evidence-collector.mjs?import-safety',import.meta.url));
  assert.deepEqual(await readdir(root),before);
}));
