import {closedFixture,closedConfigureFixture} from './fixtures/windows-resume-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {join,win32} from 'node:path';
import {fixture} from './fixtures/windows-production-fixture.mjs';
import {hash} from '../verification/distribution-qualification.mjs';
import {verifyPreparedResumeEvidence} from '../verification/windows-prepared-resume.mjs';
import {createSyntheticWindowsProducerHarness,createSyntheticWindowsPreparedResumeHarness,createWindowsPreparedResumeProducer} from '../verification/windows-evidence-production.mjs';
import {windowsPreparationToolPath} from '../verification/windows-execution-preparation.mjs';
const clone=structuredClone;
const birth=s=>(BigInt(Date.parse(s))*10000n+116444736000000000n).toString();
async function scoped(fn){assert.equal(process.env.AGENTMEMORY_INTEGRATION,'0');assert.equal(process.env.AGENTMEMORY_CURATE,'0');const root=await mkdtemp(join(process.env.AGENTMEMORY_SYNTHETIC_TEST_ROOT,'prepared-resume-'));try{await fn(root);}finally{await rm(root,{recursive:true,force:true});}}
test('closed prepared resume imports exact original evidence, never prepares twice and preserves failed configure',()=>scoped(async root=>{
  const x=await closedFixture(root),before=await readFile(x.spec.failure.path),oldFiles=await readdir(x.oldRoot);const p=await x.make(),count=x.f.calls.filter(c=>c.phase==='prepare').length;
  const result=await p.resumePrepared();assert.equal(result.status,'prepared_resume_requires_explicit_configuration');assert.equal(result.production_qualified,false);assert.equal(x.f.calls.filter(c=>c.phase==='prepare').length,count);assert.deepEqual(x.preparationCalls,['configure','inspect-prepared']);
  await p.configurePrepared({installationId:'a'});const spec=name=>{const s=x.f.spec(name,'a');delete s.authorization;return s;};
  await p.runScenario(spec('fresh_install'));await p.runScenario(spec('restart'));const partial=await p.verifyPartial();assert.equal(partial.verification.acceptance,'synthetic_partial_contract');assert.equal(partial.production_qualified,false);assert(partial.result.prepared_resume);
  assert.deepEqual(await readFile(x.spec.failure.path),before);assert.deepEqual(await readdir(x.oldRoot),oldFiles);assert.equal(x.f.calls.filter(c=>c.phase==='prepare').length,1);
}));

test('closed evidence rejects missing/tampered/foreign/pending/altered action sources',async t=>{
  for(const mode of ['missing','hash','escape','slot','nonce','candidate','command','birth','pending','driver-live','original-failure','old-snapshot','tool','synthetic-promotion'])await t.test(mode,()=>scoped(async root=>{
    const x=await closedFixture(root),calls=x.f.calls.length;
    if(mode==='missing')delete x.spec.configure_receipt;
    if(mode==='escape')x.spec.configure_contract.path=join(root,'foreign-contract.json');
    if(mode==='birth')await x.rewrite(x.spec.prepare_process,p=>{p.creation_filetime=(BigInt(p.creation_filetime)+1n).toString();});
    if(mode==='hash')await writeFile(x.spec.prepare_process.path,'tampered');
    if(mode==='slot')x.f.options.plan.windows_e2e.installations.a.root=join(root,'new-slot');
    if(mode==='nonce')await x.rewrite(x.spec.configure_contract,c=>{c.install_nonce='f'.repeat(32);});
    if(mode==='candidate')x.f.options.plan.manifest_sha256='f'.repeat(64);
    if(mode==='command')await x.rewrite(x.spec.prepare_process,p=>{p.command=['powershell.exe','-Command','exit 0'];});
    if(mode==='pending')await x.rewrite(x.spec.configure_receipt,p=>{p.exit_code=null;p.pending=true;});
    if(mode==='driver-live')await x.rewrite(x.spec.controller,p=>{p.commands[0].state='running';});
    if(mode==='original-failure')await x.rewrite(x.spec.failure,p=>{p.status='success';});
    if(mode==='old-snapshot')await x.rewrite(x.spec.prepared_snapshot,p=>{p.observed_at_utc='2025-01-01T00:00:00Z';});
    if(mode==='tool')x.f.options.plan.windows_e2e.ownership_tool.sha256='f'.repeat(64);
    const operation=mode==='synthetic-promotion'?createWindowsPreparedResumeProducer(x.f.options,x.spec):x.make();await assert.rejects(operation);assert.equal(x.f.calls.length,calls);
  }));
});

test('durable same-nonce claim prevents simultaneous or repeated resume across producer instances',()=>scoped(async root=>{
  const x=await closedFixture(root),a=await x.make();x.f.options.outputDirectory=join(root,'evidence','attempt-other');const b=await x.make();
  await a.resumePrepared();const count=x.f.calls.length;await assert.rejects(b.resumePrepared(),/EEXIST/);assert(b.status().held);assert.equal(x.f.calls.length,count);
  await assert.rejects(a.resumePrepared(),/already entered/);assert(a.status().held);
}));

test('current activated, partial config, owned writer, stale or contaminated ownership hold before configure',async t=>{
  for(const mode of ['activated','partial','writer','unknown','stale','task','runtime'])await t.test(mode,()=>scoped(async root=>{
    const x=await closedFixture(root);if(['activated','partial','writer'].includes(mode))x.setAdmission(mode);
    else x.f.setOwnershipFault(v=>{if(mode==='unknown')v.status='unknown';if(mode==='stale')v.observed_at_utc='2025-01-01T00:00:00Z';if(mode==='task')v.tasks[0].state='Ready';if(mode==='runtime')v.processes=[{role:'worker',pid:1}];});
    const p=await x.make();await assert.rejects(p.resumePrepared());assert(p.status().held);const n=x.preparationCalls.filter(c=>c==='configure').length;await assert.rejects(p.configurePrepared({installationId:'a'}));assert.equal(x.preparationCalls.filter(c=>c==='configure').length,n);
    const claims=await readdir(join(root,'evidence/resume-claims'));assert.equal(claims.length,1);
  }));
});

test('final partial verifier rechecks original proof and durable claim instead of trusting imported labels',async t=>{
 for(const mode of ['old-bytes','claim'])await t.test(mode,()=>scoped(async root=>{
  const x=await closedFixture(root),p=await x.make();await p.resumePrepared();await p.configurePrepared({installationId:'a'});
  const spec=x.f.spec('fresh_install','a');delete spec.authorization;await p.runScenario(spec);
  if(mode==='old-bytes')await writeFile(x.spec.prepare_process.path,'changed original bytes');
  else {const folder=join(root,'evidence/resume-claims'),names=await readdir(folder);await writeFile(join(folder,names[0]),'changed claim');}
  await assert.rejects(p.verifyPartial());assert(p.status().held);
 }));
});


test('one closed configure continuation preserves claim/failures, consumes only one ordinal and uses retained operation',()=>scoped(async root=>{
 const x=await closedConfigureFixture(root),claim=await readFile(x.continuation.claim.path),failure=await readFile(x.continuation.failure.path),before=x.f.calls.filter(c=>c.phase==='prepare').length;
 const p=await x.makeContinuation();await p.resumePrepared();await p.configurePrepared({installationId:'a'});
 assert.deepEqual(await readFile(x.continuation.claim.path),claim);assert.deepEqual(await readFile(x.continuation.failure.path),failure);assert.equal(x.f.calls.filter(c=>c.phase==='prepare').length,before);
 assert.equal(x.preparationCalls.at(-1),'configure-retained');const ordinal=JSON.parse(await readFile(x.continuation.claim.path+'.configure-2.json'));assert.equal(ordinal.ordinal,2);assert.equal(ordinal.production_qualified,false);
 const spec=name=>{const s=x.f.spec(name,'a');delete s.authorization;return s;};await p.runScenario(spec('fresh_install'));await p.runScenario(spec('restart'));const partial=await p.verifyPartial();assert.equal(partial.production_qualified,false);assert(partial.result.prepared_resume.continuation);assert.equal(partial.verification.acceptance,'synthetic_partial_contract');
}));

test('continuation rejects missing, stale, changed or non-closed inputs before any new dispatch',async t=>{
 for(const mode of ['missing','hash','claim','candidate','nonce','new-slot','pending','later-action','tool','temp-path','temp-hash','stale-admission','wrong-parent','birth','original-spec'])await t.test(mode,()=>scoped(async root=>{
  const x=await closedConfigureFixture(root),c=x.continuation,n=x.f.calls.length,preps=x.preparationCalls.length;
  if(mode==='missing')delete c.configure_receipt;
  if(mode==='hash')await writeFile(c.configure_receipt.path,'changed bytes');
  if(mode==='claim')await x.rewrite(c.claim,v=>{v.install_nonce='f'.repeat(32);});
  if(mode==='candidate')x.f.options.plan.manifest_sha256='f'.repeat(64);
  if(mode==='nonce')await x.rewrite(c.configure_contract,v=>{v.install_nonce='f'.repeat(32);});
  if(mode==='new-slot')x.f.options.plan.windows_e2e.installations.a.root=join(root,'new-slot');
  if(mode==='pending')await x.rewrite(c.configure_receipt,v=>{v.pending=true;v.exit_code=null;});
  if(mode==='later-action')await x.rewrite(c.driver,v=>{v.producer_status.completed=['fresh_install'];});
  if(mode==='tool')c.preparation_tool.sha256='f'.repeat(64);
  if(mode==='temp-path')c.retained_temp.path=join(root,'foreign.tmp');
  if(mode==='temp-hash')c.retained_temp.sha256='wrong';
  if(mode==='stale-admission')await x.rewrite(c.admission,v=>{v.admission.observed_at_utc='2025-01-01T00:00:00Z';});
  if(mode==='wrong-parent')await x.rewrite(c.configure_receipt,v=>{v.parent_pid=555;});
  if(mode==='birth')await x.rewrite(c.controller,v=>{v.creation_filetime='134377200000000000';});
  if(mode==='original-spec')await x.rewrite(c.admission,v=>{v.original.failure.sha256='f'.repeat(64);});
  await assert.rejects(x.makeContinuation());assert.equal(x.f.calls.length,n);assert.equal(x.preparationCalls.length,preps);
 }));
});

test('existing continuation ordinal blocks concurrent instances and held continuation cannot dispatch twice',()=>scoped(async root=>{
 const x=await closedConfigureFixture(root),a=await x.makeContinuation();x.f.options.outputDirectory=join(root,'evidence','attempt-competing');const b=await x.makeContinuation();
 await a.resumePrepared();const n=x.preparationCalls.length;await assert.rejects(b.resumePrepared(),/EEXIST/);assert(b.status().held);assert.equal(x.preparationCalls.length,n);
 x.setConfigureFailure(true);await assert.rejects(a.configurePrepared({installationId:'a'}));const m=x.preparationCalls.length;await assert.rejects(a.configurePrepared({installationId:'a'}));assert.equal(x.preparationCalls.length,m);assert(a.status().held);
 assert.equal(JSON.parse(await readFile(x.continuation.claim.path+'.configure-2.json')).ordinal,2);
}));

test('changed ordinal or prepared state holds continuation without resetting original claim',async t=>{
 for(const mode of ['ordinal','activated','writer','partial','extra-task','original-after-import'])await t.test(mode,()=>scoped(async root=>{
  const x=await closedConfigureFixture(root),p=await x.makeContinuation();
  if(['activated','writer','partial'].includes(mode))x.setAdmission(mode);
  if(mode==='extra-task')x.f.setOwnershipFault(v=>{v.tasks[0].state='Ready';});
  if(['activated','writer','partial','extra-task'].includes(mode)){await assert.rejects(p.resumePrepared());assert(p.status().held);return;}
  await p.resumePrepared();const n=x.preparationCalls.length;
  if(mode==='ordinal')await writeFile(x.continuation.claim.path+'.configure-2.json','{}');else await writeFile(x.continuation.failure.path,'changed original');
  await assert.rejects(p.configurePrepared({installationId:'a'}));assert.equal(x.preparationCalls.length,n);assert(p.status().held);
 }));
});
