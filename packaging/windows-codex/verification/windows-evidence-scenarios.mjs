import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve,relative,isAbsolute } from 'node:path';
import { hash } from './distribution-qualification.mjs';
import { createSyntheticWindowsHostAdapter } from './windows-evidence-host.mjs';

const phases=Object.freeze({fresh_install:['prepare','activate'],restart:['stop','start'],managed_update:['update'],failure_recovery:['inject','recover']});
const names=Object.keys(phases);
const ownKeys=(value,allowed,label)=>assert(value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).every(key=>allowed.includes(key)),label);

// A contract-case coordinator only. There is no real adapter, CLI or fallback.
export async function coordinateSyntheticWindowsEvidence(options) {
  ownKeys(options,['plan','manifestBytes','outputDirectory','effects','scenarios','authorization'],'Unknown synthetic coordinator option');
  const {effects,outputDirectory,authorization}=options;
  assert(Buffer.isBuffer(options.manifestBytes),'Original synthetic manifest bytes required');
  const manifestBytes=Buffer.from(options.manifestBytes);
  const manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(manifestBytes));
  assert(manifest.synthetic===true && manifest.evidence_kind==='synthetic_contract' && manifest.production_qualified===false,'Synthetic manifest required');
  const plan=structuredClone(options.plan),specs=structuredClone(options.scenarios);
  assert(plan?.synthetic===true && plan.evidence_kind==='synthetic_contract' && plan.production_qualified===false,'Synthetic plan required');
  assert(specs && Object.keys(specs).length===names.length && names.every(name=>Object.hasOwn(specs,name)),'Exactly four independent synthetic contract cases required');
  assert(typeof authorization==='string' && authorization.length>0,'Explicit synthetic authorization marker required');
  for(const name of names) {
    const spec=specs[name];ownKeys(spec,['installationId','remember','search','memoryId','captureLauncher','failure'],'Unsupported scenario specification');
    const target=plan.windows_e2e?.installations?.[spec.installationId];assert(target,'Unknown scenario installation');
    assert(typeof spec.memoryId==='string' && spec.memoryId.length>0,'Expected synthetic memory ID required');
    for(const body of [spec.remember,spec.search])assert(body && typeof body==='object' && !Array.isArray(body) && body.project===target.project,'Synthetic request project mismatch');
    assert(spec.captureLauncher===undefined || typeof spec.captureLauncher==='boolean','Invalid launcher capture option');
    assert(!spec.captureLauncher || name==='managed_update','Launcher transition capture belongs to managed update');
    assert(name==='failure_recovery'?spec.failure && typeof spec.failure==='object':spec.failure===undefined,'Failure classification belongs to recovery case');
  }
  const adapter=createSyntheticWindowsHostAdapter({plan,manifestBytes,outputDirectory,execute:true},effects);
  const trace=[],records={};
  const capturedObject=async ref=>{
    const local=relative(resolve(outputDirectory),resolve(ref.path));
    assert(local && !local.startsWith('..') && !isAbsolute(local),'Coordinator capture escapes output');
    const bytes=await readFile(ref.path);assert.equal(hash(bytes),ref.sha256,'Coordinator capture bytes changed');
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  };
  const snapshotTrace=()=>Object.freeze(trace.map(item=>Object.freeze({...item})));
  const capture=async(operation,scope,action)=>{
    const item={operation,...scope,status:'started'};trace.push(item);
    try{const value=await action();item.status='captured';return value;}
    catch(cause){item.status='failed';const error=new Error('Synthetic coordinator stopped during '+operation,{cause});error.coordinator_trace=snapshotTrace();throw error;}
  };
  for(const name of names) {
    const spec=specs[name],installationId=spec.installationId,scope={scenario:name,installationId};
    const record={installation_id:installationId,start_utc:effects.now(),steps:[],memory:{}};
    const memory=kind=>capture('memory.'+kind,scope,async()=>{
      const ref=await adapter.memory({installationId,kind,
        ...(kind==='created'?{body:spec.remember}:kind==='search'?{body:spec.search}:{id:spec.memoryId}),authorization});
      const receipt=await capturedObject(ref);
      if(receipt.status_code<200 || receipt.status_code>=300){const error=new Error('Synthetic API returned '+receipt.status_code);error.receipt=ref;throw error;}
      if(kind==='created') {
        const body=await capturedObject(receipt.response),row=body.result?.memory??body.memory;
        assert.equal(row?.id,spec.memoryId,'Created synthetic memory differs from planned identity');
      }
      return ref;
    });
    if(name!=='fresh_install')record.memory.created=await memory('created');
    for(const phase of phases[name]) {
      const stepScope={...scope,phase};let before,beforeLauncher;
      if(['start','update','recover'].includes(phase))before=await capture('snapshot.before',stepScope,()=>adapter.snapshot({installationId,runtime:phase==='start'}));
      if(phase==='update' && spec.captureLauncher)beforeLauncher=await capture('launcher.before',stepScope,()=>adapter.captureLauncher({installationId}));
      const process=await capture('action',stepScope,()=>adapter.action({scenario:name,phase,installationId}));
      let launcherPreservation;
      if(beforeLauncher) {
        const after=await capture('launcher.after',stepScope,()=>adapter.captureLauncher({installationId}));
        launcherPreservation=await capture('launcher.proof',stepScope,()=>adapter.launcherPreservation({installationId,actionProcess:process,before:beforeLauncher,after}));
      }
      const after=await capture('snapshot.after',stepScope,()=>adapter.snapshot({installationId,runtime:!['prepare','inject'].includes(phase),...(launcherPreservation?{launcherPreservation}:{})}));
      record.steps.push({phase,process,after,...(before?{before}:{})});
      if(phase==='inject')record.failure=await capture('failure',stepScope,()=>adapter.failure({installationId,failedAction:process,details:spec.failure}));
    }
    if(name==='fresh_install')record.memory.created=await memory('created');
    record.memory.search=await memory('search');record.memory.detail=await memory('detail');
    record.end_utc=effects.now();record.success=true;records[name]=record;
  }
  // Local success labels remain internal until the existing semantic verifier accepts.
  const result=await capture('assemble',{},()=>adapter.assemble(records));
  assert(result.synthetic===true && result.production_qualified===false && result.verification.acceptance==='synthetic_contract','Synthetic contract acceptance required');
  return {...result,coordinator_trace:snapshotTrace()};
}
