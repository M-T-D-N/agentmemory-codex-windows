import assert from 'node:assert/strict';
import test from 'node:test';
import {win32} from 'node:path';
import {hash,verifySyntheticWindowsScenarioEvidence,verifyWindowsScenarioEvidence} from '../verification/distribution-qualification.mjs';

import {fixture} from './fixtures/windows-evidence-synthetic.mjs';

const synthetic=x=>verifySyntheticWindowsScenarioEvidence(x.result,x.qualification,x.context);
test('fixed failure proof rejects changed private fixtures and unrelated failures',async t=>{
  const bad={
    changedBytes:x=>mutateRun(x,r=>{const bytes=Buffer.concat([x.files.get(r.script.path),Buffer.from('\n# unreviewed')]);x.files.set(r.script.path,bytes);r.script.sha256=hash(bytes);},'failure_recovery'),
    changedBase:x=>mutateRun(x,r=>{r.qualification_fixture.base_installer.sha256='f'.repeat(64);},'failure_recovery'),
    missingFixture:x=>mutateRun(x,r=>{delete r.qualification_fixture;},'failure_recovery'),
    fixtureForSuccess:x=>mutateRun(x,r=>{r.qualification_fixture={kind:'fixed-io-error'};},'managed_update'),
    wrongError:x=>{const s=x.result.scenarios.failure_recovery;s.failure=x.revise(s.failure,f=>{f.original_error_hresult=-2147024891;});},
    falseSummary:x=>{const s=x.result.scenarios.failure_recovery;s.failure=x.revise(s.failure,f=>{f.original_error='unrelated';});},
    stopUnconfirmed:x=>{const s=x.result.scenarios.failure_recovery;s.failure=x.revise(s.failure,f=>{f.runtime_stopped=false;});}
  };
  for(const [name,change] of Object.entries(bad))await t.test(name,async()=>{const x=fixture();change(x);await assert.rejects(synthetic(x));});
});

test('automatic restoration needs a fresh active predecessor snapshot; withheld and failed outcomes stay distinct',async t=>{
  for(const outcome of ['automatic_rollback','rollback_withheld','rollback_failed'])await t.test(outcome,async()=>{
    const x=fixture(false,null,outcome);assert.equal((await synthetic(x)).success,true);
    const failure=x.read(x.result.scenarios.failure_recovery.failure);
    assert.equal(failure.outcome,outcome);assert.equal(!!failure.restore_error,outcome==='rollback_failed');
  });
  const bad={
    missingState:f=>{delete f.restored_state;},
    notReady:f=>{f.runtime_ready=false;},
    stale:(f,x)=>{f.restored_state=x.revise(f.restored_state,a=>{a.runtime=x.revise(a.runtime,r=>{r.worker.creation_date='2025-01-01T00:00:00Z';});});},
    wrongVersion:(f,x)=>{f.restored_state=x.revise(f.restored_state,a=>{a.manifest=x.revise(a.manifest,m=>{m.release_manifest_sha256='f'.repeat(64);});});},
    changedManifest:(f,x)=>{f.restored_state=x.revise(f.restored_state,a=>{a.manifest=x.revise(a.manifest,m=>{m.release_revision='unrelated';});});},
  };
  for(const [name,change] of Object.entries(bad))await t.test(name,async()=>{
    const x=fixture(false,null,'automatic_rollback'),s=x.result.scenarios.failure_recovery;
    s.failure=x.revise(s.failure,f=>change(f,x));await assert.rejects(synthetic(x));
  });
});
const step=(x,scenario='restart',at=0)=>x.result.scenarios[scenario].steps[at];
const mutateRun=(x,change,scenario='restart',at=0)=>{const s=step(x,scenario,at);s.process=x.revise(s.process,change);};
const mutateCapture=(x,kind,change,scenario='restart')=>{const row=x.result.scenarios[scenario].memory;row[kind]=x.revise(row[kind],change);};

test('new Windows evidence contract is explicitly synthetic and cannot confer acceptance',async()=>{
  const x=fixture(),checked=await synthetic(x);
  assert.equal(checked.acceptance,'synthetic_contract');assert.equal(checked.production_qualified,false);
  await assert.rejects(verifyWindowsScenarioEvidence(x.result,x.qualification,x.context),/Synthetic or legacy/);
});
test('Windows contract rejects unrelated action, target, identity and observation evidence',async t=>{
  const bad={
    legacy:x=>{delete x.result.schema_version;},
    noOp:x=>mutateRun(x,r=>{r.command=[r.command[0],'-Command','exit 0'];}),
    missingExecute:x=>mutateRun(x,r=>{r.command=r.command.filter(s=>s!=='-Execute');},'managed_update'),
    wrongCandidate:x=>mutateRun(x,r=>{r.command[r.command.indexOf('-ReleaseRoot')+1]='D:\\foreign-candidate';},'managed_update'),
    foreignTarget:x=>mutateRun(x,r=>{r.command[r.command.indexOf('-Root')+1]='D:\\foreign-install';}),
    wrongNonce:x=>{const s=step(x);s.after=x.revise(s.after,a=>{a.manifest=x.revise(a.manifest,m=>{m.install_nonce='foreign';});});},
    wrongScript:x=>mutateRun(x,r=>{r.script.sha256='f'.repeat(64);}),
    scriptBytesChanged:x=>{x.files.set(x.read(step(x).process).script.path,Buffer.from('changed'));},
    sourceMismatch:x=>{x.result.source_input_digest='f'.repeat(64);},
    phaseReversal:x=>{x.result.scenarios.restart.steps.reverse();},
    timeReversal:x=>mutateRun(x,r=>{r.end_utc='2025-12-31T00:00:00Z';}),
    staleInstalled:x=>{const s=step(x);s.after=x.revise(s.after,a=>{a.observed_at_utc='2025-12-31T00:00:00Z';});},
    staleSearch:x=>mutateCapture(x,'search',c=>{c.observed_at_utc='2026-01-01T00:01:41Z';}),
    reusedObservation:x=>{const row=x.result.scenarios.restart.memory;row.detail=x.revise(row.detail,c=>{c.capture_id=x.read(row.search).capture_id;});},
    foreignApi:x=>mutateCapture(x,'search',c=>{c.request.url='http://127.0.0.1:12199/agentmemory/search';}),
    foreignProject:x=>mutateCapture(x,'search',c=>{c.request.project='*';}),
    badDetailRequest:x=>mutateCapture(x,'detail',c=>{c.request.url=c.request.url.replace('/synthetic-restart?','/other?');}),
    staleCreated:x=>mutateCapture(x,'created',c=>{c.observed_at_utc='2026-01-01T00:02:20Z';}),
    unchangedRun:x=>{const s=step(x,'restart',1);s.after=x.revise(s.after,a=>{a.runtime=x.revise(a.runtime,r=>{r.run_id='old-run';});});},
    noActualStop:x=>mutateRun(x,r=>{r.stdout={...x.raw('{}'),encoding:'utf-8'};}),
    noActualInstall:x=>mutateRun(x,r=>{r.stdout={...x.raw('{"success":true}'),encoding:'utf-8'};},'managed_update'),
    samePredecessor:x=>{x.qualification.windows_e2e.installations.b.predecessor_manifest_sha256=x.result.manifest_sha256;},
    nullExit:x=>mutateRun(x,r=>{r.exit_code=null;}),
    missingStream:x=>mutateRun(x,r=>{delete r.stderr;}),
    changedStream:x=>{const run=x.read(step(x).process);x.files.set(run.stderr.path,Buffer.from('tampered'));},
    failedRecovery:x=>mutateRun(x,r=>{r.exit_code=9;},'failure_recovery',1),
    hiddenError:x=>{const s=x.result.scenarios.failure_recovery;s.failure=x.revise(s.failure,f=>{delete f.original_error;});},
    missingRestore:x=>{const s=x.result.scenarios.failure_recovery;s.failure=x.revise(s.failure,f=>{delete f.restore_error;});},
    foreignFailureStream:x=>{const s=x.result.scenarios.failure_recovery;s.failure=x.revise(s.failure,f=>{f.stderr=x.raw('unrelated');});},
    wrongMemoryId:x=>mutateCapture(x,'detail',c=>{c.response=x.revise(c.response,r=>{r.memory.id='foreign';});}),
    wrongMemoryContent:x=>mutateCapture(x,'detail',c=>{c.response=x.revise(c.response,r=>{r.memory.content='foreign';});}),
    wrongMemoryOrigin:x=>mutateCapture(x,'detail',c=>{c.response=x.revise(c.response,r=>{r.memory.origin.channel='foreign';});}),
    missingOrigin:x=>mutateCapture(x,'created',c=>{c.response=x.revise(c.response,r=>{delete r.memory.origin;});}),
    searchStringOnly:x=>mutateCapture(x,'search',c=>{c.response=x.revise(c.response,r=>{r.results[0].observation.id='foreign';});}),
    staleRuntime:x=>{const s=step(x,'restart',1);s.after=x.revise(s.after,a=>{a.runtime=x.revise(a.runtime,r=>{r.worker.creation_date='2026-01-01T00:01:41Z';});});},
    stateBeforeStop:x=>{const s=step(x,'restart',1);s.before=x.revise(s.before,a=>{a.observed_at_utc='2026-01-01T00:01:41Z';});},
    wrongManifestBytes:x=>{x.context.manifestBytes=Buffer.from('{}');},
    duplicateParameter:x=>mutateRun(x,r=>{r.command.push('-Root','D:\\\\synthetic-install-a');}),
    unactivatedState:x=>{const s=step(x);s.after=x.revise(s.after,a=>{a.manifest=x.revise(a.manifest,m=>{m.installation_status='prepared';});});},
    rawHashMismatch:x=>{x.files.set(x.result.scenarios.restart.memory.detail.path,Buffer.from('{}'));},
  };
  for(const [name,change] of Object.entries(bad))await t.test(name,async()=>{
    const x=fixture();
    change(x);await assert.rejects(synthetic(x));
  });
});

test('relabelled synthetic records cannot inject a test loader into production acceptance',async()=>{
  const x=fixture();x.result.evidence_kind='windows_execution';x.result.synthetic=false;
  await assert.rejects(verifyWindowsScenarioEvidence(x.result,x.qualification,x.context),/ENOENT|Invalid qualification/);
});

function preservedLauncherFixture(scenario='managed_update') {
  const x=fixture(),s=step(x,scenario,scenario==='failure_recovery'?1:0),target=x.qualification.windows_e2e.installations.b;
  if(scenario==='failure_recovery')s.before=step(x,'failure_recovery').after;
  const before=x.read(s.before),after=x.read(s.after),prior=x.read(before.manifest);
  const binary='bin\\agentmemory-hidden-launcher.exe',source='src\\AgentMemoryHiddenLauncher.cs';
  const oldBinary=x.raw('inert previous compiler output'),oldSource=x.raw('class Launcher {}\r\n');
  prior.source_hashes[binary]=oldBinary.sha256;prior.source_hashes[source]=oldSource.sha256;
  before.manifest=x.bind(prior);s.before=x.bind(before);
  const updated=x.read(after.manifest);updated.source_hashes[binary]=oldBinary.sha256;updated.preserved_existing_hidden_launcher=true;
  after.manifest=x.bind(updated);
  const run=x.read(s.process);const output=JSON.parse(x.files.get(run.stdout.path));output.preserve_existing_hidden_launcher=true;
  run.stdout={...x.raw(JSON.stringify(output)),encoding:'utf-8'};s.process=x.bind(run);
  const capture=(relative,content,at)=>({original_path:win32.join(target.root,relative),observed_at_utc:at,content});
  const candidateSource=x.context.manifestBytes&&JSON.parse(x.context.manifestBytes).immutable_files.find(f=>f.path==='src/AgentMemoryHiddenLauncher.cs');
  const candidatePath=win32.join(x.context.releaseRoot,'payload','src/AgentMemoryHiddenLauncher.cs');
  after.launcher_preservation=x.bind({execution_id:x.result.execution_id,installation_id:'b',install_root:target.root,
    action_process:s.process,
    before_binary:capture(binary,oldBinary,before.observed_at_utc),before_source:capture(source,oldSource,before.observed_at_utc),
    after_binary:capture(binary,oldBinary,after.observed_at_utc),candidate_source:{path:candidatePath,sha256:candidateSource.sha256}});
  s.after=x.bind(after);
  return x;
}
const changePreservation=(x,change)=>{const s=step(x,'managed_update');s.after=x.revise(s.after,a=>{a.launcher_preservation=x.revise(a.launcher_preservation,change);});};

test('updater may preserve only its hash-verified launcher with identical normalized source',async()=>{
  assert.equal((await synthetic(preservedLauncherFixture())).production_qualified,false);
  assert.equal((await synthetic(preservedLauncherFixture('failure_recovery'))).production_qualified,false);
});
test('launcher preservation rejects incomplete or unrelated evidence',async t=>{
  const cases={
    declarationOnly:x=>{const s=step(x,'managed_update');s.after=x.revise(s.after,a=>{delete a.launcher_preservation;});},
    outputNotPreserved:x=>mutateRun(x,r=>{const o=JSON.parse(x.files.get(r.stdout.path));o.preserve_existing_hidden_launcher=false;r.stdout={...x.raw(JSON.stringify(o)),encoding:'utf-8'};},'managed_update'),
    sourceDiffers:x=>{
      const changed=x.raw('class Foreign {}\r\n');
      changePreservation(x,e=>{e.before_source.content=changed;});
      const s=step(x,'managed_update');s.before=x.revise(s.before,b=>{b.manifest=x.revise(b.manifest,m=>{m.source_hashes['src\\AgentMemoryHiddenLauncher.cs']=changed.sha256;});});
    },
    candidateSourceChanged:x=>{const s=step(x,'managed_update'),a=x.read(s.after),e=x.read(a.launcher_preservation);x.files.set(e.candidate_source.path,Buffer.from('class Foreign {}'));},
    binaryChanged:x=>changePreservation(x,e=>{e.after_binary.content=x.raw('inert changed binary');}),
    wrongPriorHash:x=>{const s=step(x,'managed_update');s.before=x.revise(s.before,b=>{b.manifest=x.revise(b.manifest,m=>{m.source_hashes['bin\\agentmemory-hidden-launcher.exe']='f'.repeat(64);});});},
    wrongCapturePath:x=>changePreservation(x,e=>{e.before_binary.original_path='D:\\foreign\\launcher.exe';}),
    beforeCapturedTooLate:x=>changePreservation(x,e=>{e.before_binary.observed_at_utc='2026-01-01T00:03:32Z';}),
    staleAfterCapture:x=>changePreservation(x,e=>{e.after_binary.observed_at_utc='2026-01-01T00:03:29Z';}),
    foreignAction:x=>changePreservation(x,e=>{e.action_process=x.result.scenarios.failure_recovery.steps[1].process;}),
    arbitraryFileException:x=>{const s=step(x,'managed_update');s.after=x.revise(s.after,a=>{a.manifest=x.revise(a.manifest,m=>{m.source_hashes['scripts\\agentmemory-stop.ps1']='f'.repeat(64);});});},
    absentInstalledResult:x=>{const s=step(x,'managed_update');s.after=x.revise(s.after,a=>{a.manifest=x.revise(a.manifest,m=>{delete m.preserved_existing_hidden_launcher;});});},
  };
  for(const [name,change] of Object.entries(cases))await t.test(name,async()=>{
    const x=preservedLauncherFixture();change(x);
    const expected={sourceDiffers:/Preserved launcher source differs/,arbitraryFileException:/Installed source identity mismatch/,outputNotPreserved:/Missing verified launcher preservation action/};
    await assert.rejects(synthetic(x),expected[name]);
  });
});
test('restore diagnostics and runtime creation have causal bounds',async t=>{
  await t.test('unrelated nonempty restore stream is rejected',async()=>{
    const x=fixture(),s=x.result.scenarios.failure_recovery;
    s.failure=x.revise(s.failure,f=>{f.restore_stderr=x.raw('unrelated nonempty failure');});
    await assert.rejects(synthetic(x),/Restoration stream/);
  });
  await t.test('future process creation is rejected',async()=>{
    const x=fixture(),s=step(x,'restart',1);
    s.after=x.revise(s.after,a=>{a.runtime=x.revise(a.runtime,r=>{r.engine.creation_date='2026-01-01T00:02:13Z';});});
    await assert.rejects(synthetic(x),/creation postdates/);
  });
  await t.test('runtime update after snapshot is rejected',async()=>{
    const x=fixture(),s=step(x,'restart',1);
    s.after=x.revise(s.after,a=>{a.runtime=x.revise(a.runtime,r=>{r.updated_at_utc='2026-01-01T00:02:13Z';});});
    await assert.rejects(synthetic(x));
  });
});
test('structured stdout requires explicit valid UTF-8 and preserves Korean paths',async t=>{
  await t.test('UTF-8 Korean installation paths pass',async()=>{assert.equal((await synthetic(fixture(true))).production_qualified,false);});
  await t.test('UTF-8 BOM is accepted without changing original bytes',async()=>{
    const x=fixture();mutateRun(x,r=>{r.stdout={...x.raw(Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),x.files.get(r.stdout.path)])),encoding:'utf-8'};},'managed_update');
    assert.equal((await synthetic(x)).success,true);
  });
  await t.test('missing encoding declaration is rejected',async()=>{
    const x=fixture();mutateRun(x,r=>{delete r.stdout.encoding;});await assert.rejects(synthetic(x),/UTF-8/);
  });
  await t.test('CP949 bytes cannot be silently decoded as UTF-8',async()=>{
    const x=fixture();mutateRun(x,r=>{r.stdout={...x.raw(Buffer.concat([Buffer.from('{"install_root":"'),Buffer.from([0xb0,0xa1]),Buffer.from('"}')])),encoding:'utf-8'};},'managed_update');
    await assert.rejects(synthetic(x),/UTF-8/);
  });
});


test('partial fresh/restart reuses full semantic checks without minting full acceptance',async t=>{
  const {verifySyntheticPartialWindowsScenarioEvidence,verifyPartialWindowsScenarioEvidence}=await import('../verification/distribution-qualification.mjs');
  for(const mode of ['valid','noop','wrong-content','wrong-origin','stale-search','wrong-target','hash','reversed','missing-fresh','promoted'])await t.test(mode,async()=>{
    const x=fixture();delete x.result.scenarios.managed_update;delete x.result.scenarios.failure_recovery;
    if(mode==='noop')mutateRun(x,r=>{r.command=[r.command[0],'-Command','exit 0'];});
    if(mode==='wrong-content'||mode==='wrong-origin')mutateCapture(x,'detail',c=>{c.response=x.revise(c.response,r=>{if(mode==='wrong-content')r.memory.content='wrong';else r.memory.origin.channel='wrong';});});
    if(mode==='stale-search')mutateCapture(x,'search',c=>{c.observed_at_utc='2025-01-01T00:00:00Z';});
    if(mode==='wrong-target')mutateRun(x,r=>{r.command[r.command.indexOf('-Root')+1]='D:\\foreign';});
    if(mode==='hash')x.files.set(x.result.scenarios.restart.memory.detail.path,Buffer.from('{}'));
    if(mode==='reversed')x.result.scenarios.restart.start_utc='2025-01-01T00:00:00Z';
    if(mode==='missing-fresh')delete x.result.scenarios.fresh_install;
    if(mode==='promoted')x.result.production_qualified=true;
    if(mode==='valid'){
      const result=await verifySyntheticPartialWindowsScenarioEvidence(x.result,x.qualification,x.context);assert.equal(result.production_qualified,false);assert.equal(result.acceptance,'synthetic_partial_contract');
      await assert.rejects(verifySyntheticWindowsScenarioEvidence(x.result,x.qualification,x.context));
      await assert.rejects(verifyPartialWindowsScenarioEvidence(x.result,x.qualification,x.context));
    }else await assert.rejects(verifySyntheticPartialWindowsScenarioEvidence(x.result,x.qualification,x.context));
  });
});
