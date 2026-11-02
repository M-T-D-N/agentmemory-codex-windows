import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, open } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { stageNativeSourceEvidence, verifyNativeSourceEvidenceFiles, verifyNativeSourceProfile } from '../verification/native-source-evidence.mjs';

const hash=b=>createHash('sha256').update(b).digest('hex');
const bytes=Buffer.from('synthetic opaque archive input; never source code or an executed ZIP');
const profile={schema_version:1,kind:'partial-native-source-evidence',archive_name:'NATIVE-SOURCE-EVIDENCE.zip',archive_size_bytes:bytes.length,archive_sha256:hash(bytes),coverage:'sources-and-notices-with-selected-and-conditional-rust',unresolved:['guid-typescript-1.0.9-exact-notice','recipient-source-delivery-review'],complete:false};
async function fixture(fn) {
  assert(process.env.AGENTMEMORY_SYNTHETIC_TEST_ROOT);
  const root=await mkdtemp(join(process.env.AGENTMEMORY_SYNTHETIC_TEST_ROOT,'native-sources-'));
  const archive=join(root,'input.zip'),release=join(root,'candidate');
  await writeFile(archive,bytes);await mkdir(release);
  try { return await fn({root,archive,release}); }
  finally { await rm(root,{recursive:true,force:true}); }
}
async function manifest(release,binding) {
  const release_files=[];
  for(const path of await readdir(release)) {
    const b=await readFile(join(release,path));release_files.push({path,size_bytes:b.length,sha256:hash(b)});
  }
  return {native_source_evidence:binding,release_files,immutable_files:[]};
}

test('no archive input keeps the optional/default record absent',()=>fixture(async({release})=>{
  assert.deepEqual(await verifyNativeSourceEvidenceFiles(release,{release_files:[]}),{present:false,complete:false});
  assert.deepEqual(await readdir(release),[]);
}));
test('opaque source bytes and partial descriptor bind to release inventory',()=>fixture(async({archive,release})=>{
  const binding=await stageNativeSourceEvidence(archive,release,profile);
  assert.deepEqual(await readFile(archive),bytes);
  assert.deepEqual(await readFile(join(release,binding.archive_path)),bytes);
  const result=await verifyNativeSourceEvidenceFiles(release,await manifest(release,binding),profile);
  assert.equal(result.present,true);assert.equal(result.complete,false);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(join(release,binding.descriptor_path),'utf8'))).sort(),Object.keys(profile).sort());
}));
test('wrong digest or size creates no candidate file',()=>fixture(async({archive,release})=>{
  for(const bad of [{...profile,archive_sha256:'0'.repeat(64)},{...profile,archive_size_bytes:bytes.length+1}]) {
    await assert.rejects(stageNativeSourceEvidence(archive,release,bad));
    assert.deepEqual(await readdir(release),[]);
  }
}));
test('existing archive or descriptor is never overwritten',()=>fixture(async({root,archive,release})=>{
  const marker=Buffer.from('owned existing marker');
  await writeFile(join(release,profile.archive_name),marker);
  await assert.rejects(stageNativeSourceEvidence(archive,release,profile),{code:'EEXIST'});
  assert.deepEqual(await readFile(join(release,profile.archive_name)),marker);
  const second=join(root,'second');await mkdir(second);await writeFile(join(second,'NATIVE-SOURCE-EVIDENCE.json'),marker);
  await assert.rejects(stageNativeSourceEvidence(archive,second,profile),{code:'EEXIST'});
  assert.deepEqual(await readFile(join(second,'NATIVE-SOURCE-EVIDENCE.json')),marker);
  assert.deepEqual(await readFile(join(second,profile.archive_name)),bytes);
  await assert.rejects(stageNativeSourceEvidence(archive,second,profile),{code:'EEXIST'});
  assert.deepEqual(await readFile(join(second,profile.archive_name)),bytes);
}));
test('promotion, wrong names, coverage and unknown metadata fail closed',()=>{
  for(const bad of [{...profile,complete:true},{...profile,archive_name:'../input.zip'},{...profile,coverage:'selected-windows-graph-complete'},{...profile,license_clearance:true}])
    assert.throws(()=>verifyNativeSourceProfile(bad));
});
test('review items may change without claiming rights clearance',()=>{
  for(const unresolved of [[],['recipient-source-delivery-review'],['new-exact-component-review']]) {
    const revised=verifyNativeSourceProfile({...profile,unresolved});
    assert.deepEqual(revised.unresolved,unresolved);assert.equal(revised.complete,false);
  }
  for(const unresolved of [null,'review',[null],[''],['   '],['review','review']])
    assert.throws(()=>verifyNativeSourceProfile({...profile,unresolved}));
});
test('changed review items require the exact reviewed descriptor',()=>fixture(async({archive,release})=>{
  const reviewed={...profile,unresolved:['recipient-source-delivery-review']};
  const binding=await stageNativeSourceEvidence(archive,release,reviewed),record=await manifest(release,binding);
  assert.equal((await verifyNativeSourceEvidenceFiles(release,record,reviewed)).complete,false);
  await assert.rejects(verifyNativeSourceEvidenceFiles(release,record,profile),/coverage changed/);
}));
test('duplicate/missing inventory, unbound evidence and byte tamper are rejected',()=>fixture(async({archive,release})=>{
  const binding=await stageNativeSourceEvidence(archive,release,profile),good=await manifest(release,binding);
  await assert.rejects(verifyNativeSourceEvidenceFiles(release,{...good,release_files:[...good.release_files,good.release_files[0]]},profile));
  await assert.rejects(verifyNativeSourceEvidenceFiles(release,{...good,release_files:good.release_files.slice(1)},profile));
  await assert.rejects(verifyNativeSourceEvidenceFiles(release,{...good,native_source_evidence:undefined},profile));
  await assert.rejects(verifyNativeSourceEvidenceFiles(release,{release_files:[]},profile));
  await assert.rejects(verifyNativeSourceEvidenceFiles(release,{...good,native_source_evidence:{...binding,archive_path:'../input.zip'}},profile));
  await assert.rejects(verifyNativeSourceEvidenceFiles(release,{...good,native_source_evidence:{...binding,complete:true}},profile));
  await assert.rejects(verifyNativeSourceEvidenceFiles(release,{...good,native_source_evidence:{...binding,license_clearance:true}},profile));
  await writeFile(join(release,binding.archive_path),Buffer.alloc(bytes.length,1));
  await assert.rejects(verifyNativeSourceEvidenceFiles(release,good,profile));
}));
test('tracked default profile is read and mismatched input fails before output',()=>fixture(async({archive,release})=>{
  const tracked=JSON.parse(await readFile(new URL('../licenses/native-source-evidence.json',import.meta.url),'utf8'));
  verifyNativeSourceProfile(tracked);
  assert.equal(tracked.archive_sha256,'feb32a6ee7f17de11c9eb9bb6cbf38ff497d9d55a6cc3927e911ddbfabb7029d');
  assert.equal(tracked.archive_size_bytes,95754646);
  await assert.rejects(stageNativeSourceEvidence(archive,release),/size mismatch/);
  assert.deepEqual(await readdir(release),[]);
}));
test('source within candidate and redirected parents are refused',()=>fixture(async({root,archive,release})=>{
  await writeFile(join(release,'input.zip'),bytes);
  await assert.rejects(stageNativeSourceEvidence(join(release,'input.zip'),release,profile));
  await writeFile(join(release,'..input.zip'),bytes);
  await assert.rejects(stageNativeSourceEvidence(join(release,'..input.zip'),release,profile));
  const alias=join(root,'alias');await symlink(release,alias,process.platform==='win32'?'junction':'dir');
  await assert.rejects(stageNativeSourceEvidence(archive,alias,profile));
}));
test('descriptor cannot silently replace unresolved coverage with success',()=>fixture(async({archive,release})=>{
  const binding=await stageNativeSourceEvidence(archive,release,profile);
  await writeFile(join(release,binding.descriptor_path),JSON.stringify({...profile,complete:true})+'\n');
  const bad=await manifest(release,binding);
  bad.native_source_evidence={...binding,descriptor_sha256:bad.release_files.find(x=>x.path===binding.descriptor_path).sha256};
  await assert.rejects(verifyNativeSourceEvidenceFiles(release,bad,profile));
}));
test('streaming evidence exceeds the old 64 MiB text-reader boundary',()=>fixture(async({archive,release})=>{
  const input=await open(archive,'w'),chunk=Buffer.alloc(1024*1024,65),h=createHash('sha256');
  try {
    for(let i=0;i<65;i++){await input.writeFile(chunk);h.update(chunk);}
    await input.writeFile(Buffer.from([90]));h.update(Buffer.from([90]));
  } finally {await input.close();}
  const large={...profile,archive_size_bytes:65*1024*1024+1,archive_sha256:h.digest('hex')};
  const binding=await stageNativeSourceEvidence(archive,release,large);
  const rows=[{path:binding.archive_path,size_bytes:large.archive_size_bytes,sha256:large.archive_sha256}];
  const descriptor=await readFile(join(release,binding.descriptor_path));
  rows.push({path:binding.descriptor_path,size_bytes:descriptor.length,sha256:hash(descriptor)});
  assert.equal((await verifyNativeSourceEvidenceFiles(release,{native_source_evidence:binding,release_files:rows},large)).complete,false);
}));
