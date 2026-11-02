import assert from 'node:assert/strict';
import { mkdir, lstat, realpath, open, readFile } from 'node:fs/promises';
import { isAbsolute, resolve, join, parse } from 'node:path';
import { hash, verifySyntheticWindowsScenarioEvidence } from './distribution-qualification.mjs';

const markers = Object.freeze({ evidence_kind:'synthetic_contract', synthetic:true, production_qualified:false });
const segment = value => {
  assert(typeof value==='string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value) && !['.','..'].includes(value) && !value.endsWith('.') &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value),'Unsafe artifact identifier');
  return value;
};
const logicalPath = value => {
  assert(typeof value==='string' && value.length>0 && value.length<=2048 && !value.includes('\0') &&
    !value.split(/[\\/]/).includes('..') && !(/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) && !/^[A-Za-z]:[\\/]/.test(value)),'Unsafe logical evidence path');
  return value;
};
function jsonBytes(value) {
  const seen=new Set();
  const check=x=>{
    if(x===null || typeof x==='string' || typeof x==='boolean') return;
    if(typeof x==='number') { assert(Number.isFinite(x),'Non-JSON number');return; }
    assert(typeof x==='object' && (Array.isArray(x) || Object.getPrototypeOf(x)===Object.prototype || Object.getPrototypeOf(x)===null),'Only explicit JSON records are accepted');
    assert(!seen.has(x),'Circular evidence record');seen.add(x);
    for(const v of Object.values(x))check(v);
    seen.delete(x);
  };
  check(value);return Buffer.from(JSON.stringify(value,null,2),'utf8');
}
function syntheticOnly(value) {
  for(const [key,expected] of Object.entries(markers))assert.equal(value?.[key],expected,'Only explicitly synthetic, non-production records are accepted');
}
async function physicalDirectory(path) {
  assert(typeof path==='string' && isAbsolute(path) && !path.startsWith('\\\\') &&
    !path.split(/[\\/]/).includes('..'),'Scratch must be an explicit absolute local path');
  const full=resolve(path);assert(full!==parse(full).root,'Filesystem root is not a scratch unit');
  for(let p=full;;p=resolve(p,'..')) {
    const stat=await lstat(p);assert(stat.isDirectory() && !stat.isSymbolicLink(),'Scratch path contains a redirect or non-directory');
    const parent=resolve(p,'..');if(parent===p)break;
  }
  const actual=await realpath(full);
  assert.equal(actual.toLowerCase(),full.toLowerCase(),'Scratch path redirects');
  return full;
}
async function createFile(path,bytes) {
  const handle=await open(path,'wx');
  try { await handle.writeFile(bytes);await handle.sync(); }
  finally { await handle.close(); }
}

// Synthetic-only assembler: never executes actions or reads caller-supplied paths.
// The caller must supply an already-owned private scratch directory and benign
// synthetic bytes. That directory must not be concurrently modified by others.
export async function writeSyntheticWindowsEvidence({scratchRoot,unitId,plan,manifestBytes,result,records}) {
  segment(unitId);syntheticOnly(plan);syntheticOnly(result);
  const allowed=new Set(['schema_version','evidence_kind','synthetic','production_qualified','execution_id','source_commit','source_input_digest','manifest_sha256','release_root','windows_e2e']);
  assert(Object.keys(plan).every(key=>allowed.has(key)),'Unsupported synthetic plan field');
  assert.equal(plan.schema_version,1,'Synthetic plan schema 1 required');
  const planBytes=jsonBytes(plan),resultBytes=jsonBytes(result);
  const fixedPlan=JSON.parse(planBytes),fixedResult=JSON.parse(resultBytes);
  assert.equal(fixedPlan.execution_id,fixedResult.execution_id,'Plan execution mismatch');
  assert(Buffer.isBuffer(manifestBytes),'Manifest must be supplied original bytes');
  const originalManifest=Buffer.from(manifestBytes);
  assert.equal(hash(originalManifest),fixedPlan.manifest_sha256,'Plan manifest hash mismatch');
  syntheticOnly(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(originalManifest)));
  const qualification={...markers,windows_e2e:fixedPlan.windows_e2e};
  for(const key of ['source_commit','source_input_digest','manifest_sha256']) {
    assert.equal(fixedResult[key],fixedPlan[key],'Plan candidate binding mismatch');qualification[key]=fixedPlan[key];
  }
  assert(Array.isArray(records) && records.length>0 && records.length<=2048,'Missing or excessive supplied records');
  const ids=new Set(),byLogical=new Map();let total=0;
  const captured=records.map(record=>{
    const id=segment(record.id),logical=logicalPath(record.logical_path);
    assert(!ids.has(id.toLowerCase()) && !byLogical.has(logical),'Duplicate supplied record identity');ids.add(id.toLowerCase());
    assert(Buffer.isBuffer(record.bytes),'Raw evidence must be supplied bytes');
    assert(record.bytes.length<=16*1024*1024,'Raw evidence exceeds size bound');
    total+=record.bytes.length;assert(total<=64*1024*1024,'Supplied evidence exceeds total bound');
    const bytes=Buffer.from(record.bytes),sha256=hash(bytes);
    assert.equal(record.sha256,sha256,'Supplied raw evidence hash mismatch');
    const row={id,logical_path:logical,relative_path:'raw/'+id+'.bin',sha256,bytes};
    byLogical.set(logical,row);return row;
  });
  const suppliedLoad=async path=>{
    const row=byLogical.get(path);assert(row,'Missing supplied raw evidence');return row.bytes;
  };
  const context={manifestBytes:originalManifest,releaseRoot:fixedPlan.release_root,load:suppliedLoad};
  // No defaults, timestamps, successful phases or responses are manufactured.
  await verifySyntheticWindowsScenarioEvidence(fixedResult,qualification,context);
  const scratch=await physicalDirectory(scratchRoot),root=join(scratch,unitId);
  await mkdir(root); // EEXIST is fatal; never reuse or replace an existing unit.
  assert.equal((await realpath(root)).toLowerCase(),root.toLowerCase(),'Artifact unit redirects');
  await createFile(join(root,'assembly-started.json'),jsonBytes({...markers,status:'started'}));
  await mkdir(join(root,'raw'));
  await createFile(join(root,'plan.json'),planBytes);
  await createFile(join(root,'manifest.json'),originalManifest);
  await createFile(join(root,'result.json'),resultBytes);
  const qualificationBytes=jsonBytes(qualification);
  await createFile(join(root,'qualification.json'),qualificationBytes);
  for(const row of captured)await createFile(join(root,row.relative_path),row.bytes);
  const inventory=captured.map(({bytes,...row})=>({...row,size_bytes:bytes.length}));
  const inventoryBytes=jsonBytes({ ...markers,records:inventory });
  await createFile(join(root,'inventory.json'),inventoryBytes);
  const storedLoad=async path=>{
    const row=byLogical.get(path);assert(row,'Unknown synthetic artifact reference');
    const bytes=await readFile(join(root,row.relative_path));
    assert.equal(hash(bytes),row.sha256,'Stored raw evidence changed');return bytes;
  };
  const storedResult=JSON.parse(await readFile(join(root,'result.json'),'utf8'));
  const storedPlan=JSON.parse(await readFile(join(root,'plan.json'),'utf8'));
  const storedManifest=await readFile(join(root,'manifest.json'));
  const storedQualificationBytes=await readFile(join(root,'qualification.json'));
  assert.equal(hash(storedQualificationBytes),hash(qualificationBytes),'Stored qualification changed');
  const storedQualification=JSON.parse(storedQualificationBytes);
  assert.equal(hash(storedManifest),hash(originalManifest),'Stored manifest changed');
  assert.equal(hash(Buffer.from(await readFile(join(root,'plan.json')))),hash(planBytes),'Stored plan changed');
  assert.equal(hash(Buffer.from(await readFile(join(root,'result.json')))),hash(resultBytes),'Stored result changed');
  const storedContext={manifestBytes:storedManifest,releaseRoot:storedPlan.release_root,load:storedLoad};
  const verification=await verifySyntheticWindowsScenarioEvidence(storedResult,storedQualification,storedContext);
  await createFile(join(root,'assembly-complete.json'),jsonBytes({...markers,status:'complete',
    plan_sha256:hash(planBytes),manifest_sha256:hash(storedManifest),result_sha256:hash(resultBytes),qualification_sha256:hash(qualificationBytes),inventory_sha256:hash(inventoryBytes)}));
  return {...markers,root,result:storedResult,qualification:storedQualification,context:storedContext,inventory,verification};
}
