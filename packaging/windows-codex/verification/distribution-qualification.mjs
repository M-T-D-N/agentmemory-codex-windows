import assert from 'node:assert/strict';
import { readFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve, relative, isAbsolute, join, sep, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { consumeNativeEvidence } from './native-evidence-store.mjs';
import { verifyNativeSourceEvidenceFiles } from './native-source-evidence.mjs';
import {createPreStartCopyFailureInstaller,fixedCopyFailure,verifyFixedCopyFailureOutcome} from './windows-fixed-copy-failure.mjs';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const payloadDigest = manifest => hash(JSON.stringify(manifest.immutable_files.map(file => ({
  path: file.path, sha256: file.sha256.toLowerCase(), size_bytes: file.size_bytes ?? null,
})).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));

const userLibraryNames = { 'vips-c': 'libvips-42.dll', 'vips-cpp-msvc': 'libvips-cpp-8.18.7.dll' };
const digestPattern = /^[a-f0-9]{64}$/;
function exactKeys(value, keys) {
  assert(value && !Array.isArray(value) && typeof value === 'object', 'Invalid custom library object');
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), 'Unknown or missing custom library field');
}
function publicSourceUrl(value) {
  assert.equal(typeof value, 'string');
  const url = new URL(value);
  assert(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && !['localhost','127.0.0.1','[::1]'].includes(url.hostname), 'Invalid custom library source URL');
}
export function verifyUserLibraryRecords(manifest, qualification, descriptorBytes, provenanceBytes) {
  const custom = manifest.custom_libraries;
  if (!custom) {
    assert(manifest.distribution_variant === undefined && qualification?.library_input_digest === undefined, 'Missing custom library binding');
    assert(!manifest.immutable_files.some(x => /\/user-libvips-(input|provenance)\.json$/.test(x.path)), 'Unlabelled custom library payload');
    return [];
  }
  assert.equal(manifest.distribution_variant, 'user-libvips');
  exactKeys(custom, ['schema_version','kind','input_digest','descriptor_path','provenance_path','provenance_sha256']);
  assert(custom.schema_version === 1 && custom.kind === 'user-built-libvips' && digestPattern.test(custom.input_digest), 'Invalid custom library binding');
  const base = manifest.package_relative_path;
  assert(/^runtime\/[^/]+\/agentmemory$/.test(base), 'Invalid custom runtime path');
  assert.equal(custom.descriptor_path, base + '/user-libvips-input.json');
  assert.equal(custom.provenance_path, base + '/user-libvips-provenance.json');
  assert.equal(qualification.library_input_digest, custom.input_digest, 'Custom library qualification mismatch');
  assert.equal(hash(descriptorBytes), custom.input_digest, 'Custom descriptor changed');
  assert.equal(hash(provenanceBytes), custom.provenance_sha256, 'Custom provenance changed');
  const descriptor = JSON.parse(descriptorBytes.toString('utf8'));
  const proof = JSON.parse(provenanceBytes.toString('utf8'));
  exactKeys(descriptor, ['schema_version','kind','platform','sharp_version','libvips_version','files','sources']);
  assert(descriptor.schema_version === 1 && descriptor.kind === custom.kind && descriptor.platform === 'win32-x64' && descriptor.sharp_version === '0.35.5' && descriptor.libvips_version === '8.18.7', 'Unsupported custom library profile');
  assert(Array.isArray(descriptor.files) && descriptor.files.length >= 1 && descriptor.files.length <= 2);
  const selected = new Map();
  for (const file of descriptor.files) {
    exactKeys(file, ['component','file','size_bytes','sha256']);
    assert(Object.hasOwn(userLibraryNames,file.component) && file.file === userLibraryNames[file.component] && !selected.has(file.component), 'Invalid or duplicate custom component');
    assert(Number.isSafeInteger(file.size_bytes) && file.size_bytes > 0 && digestPattern.test(file.sha256));
    selected.set(file.component,file);
  }
  assert(Array.isArray(descriptor.sources) && descriptor.sources.length === selected.size);
  const seen = new Set();
  for (const source of descriptor.sources) {
    exactKeys(source, ['component','version','source_url','source_revision','recipe_url','recipe_revision','patches','verification']);
    assert(selected.has(source.component) && !seen.has(source.component) && source.version === '8.18.7' && source.verification === 'declared'); seen.add(source.component);
    publicSourceUrl(source.source_url); publicSourceUrl(source.recipe_url);
    for (const revision of [source.source_revision,source.recipe_revision]) assert(typeof revision === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/@+-]*$/.test(revision));
    assert(Array.isArray(source.patches));
    for (const patch of source.patches) { exactKeys(patch,['url','sha256']); publicSourceUrl(patch.url); assert(digestPattern.test(patch.sha256)); }
  }
  exactKeys(proof, ['schema_version','kind','input_digest','files','baseline','native_api_abi','source_verification']);
  assert(proof.schema_version === 1 && proof.kind === custom.kind && proof.input_digest === custom.input_digest && proof.native_api_abi === 'not-verified' && proof.source_verification === 'declared');
  assert.deepEqual(proof.files, descriptor.files, 'Copied custom library list differs');
  const baselineNames = [...Object.values(userLibraryNames),'sharp-win32-x64-0.35.5.node'];
  assert(Array.isArray(proof.baseline) && proof.baseline.length === 3);
  assert.deepEqual(proof.baseline.map(x => x.file), baselineNames);
  const required = [{path:custom.descriptor_path,sha256:hash(descriptorBytes),size_bytes:descriptorBytes.length}, {path:custom.provenance_path,sha256:hash(provenanceBytes),size_bytes:provenanceBytes.length}];
  for (const original of proof.baseline) {
    exactKeys(original,['file','sha256','size_bytes']);
    assert(digestPattern.test(original.sha256) && Number.isSafeInteger(original.size_bytes) && original.size_bytes > 0);
    const file = [...selected.values()].find(x => x.file === original.file) ?? original;
    required.push({path:base+'/node_modules/@img/sharp-win32-x64/lib/'+file.file,sha256:file.sha256,size_bytes:file.size_bytes});
  }
  for (const file of required) {
    const rows = manifest.immutable_files.filter(x => x.path === file.path);
    assert.equal(rows.length,1,'Missing or duplicate custom payload file');
    assert.equal(rows[0].sha256.toLowerCase(),file.sha256,'Custom payload hash mismatch');
    assert.equal(rows[0].size_bytes,file.size_bytes,'Custom payload size mismatch');
  }
  return required;
}

async function verifyUserLibraryFiles(root, manifest, qualification) {
  const physicalFile = async path => {
    const within = relative(resolve(root),resolve(root,path));
    assert(within && !within.startsWith('..') && !isAbsolute(within),'Custom library path escapes payload');
    let cursor = resolve(root);
    assert(!(await lstat(cursor)).isSymbolicLink(),'Custom library root redirect');
    for (const part of within.split(sep)) {
      cursor = join(cursor,part);
      assert(!(await lstat(cursor)).isSymbolicLink(),'Custom library path redirect');
    }
    return cursor;
  };
  if (!manifest.custom_libraries) return verifyUserLibraryRecords(manifest,qualification);
  const custom = manifest.custom_libraries;
  const descriptor = await boundedRead(await physicalFile(custom.descriptor_path));
  const provenance = await boundedRead(await physicalFile(custom.provenance_path));
  for (const file of verifyUserLibraryRecords(manifest,qualification,descriptor,provenance)) {
    const path = await physicalFile(file.path), sha = createHash('sha256');
    const { open } = await import('node:fs/promises');
    const handle = await open(path,'r');
    let bytes = 0;
    try { for await (const chunk of handle.createReadStream()) { bytes += chunk.length; sha.update(chunk); } }
    finally { await handle.close(); }
    assert.equal(bytes,file.size_bytes,'Custom library file size changed');
    assert.equal(sha.digest('hex'),file.sha256,'Custom library file bytes changed');
  }
}

export function parseSuiteLog(name, raw) {
  assert(['source','adapter','packaging'].includes(name), 'Unknown qualification suite');
  const text = raw.replace(/\x1b\[[0-9;]*m/g, '').replaceAll('\r', '');
  let passed, skipped, total, summary;
  if (name === 'source') {
    const rows = [...text.matchAll(/^\s*Tests\s+([^\n]+)$/gm)];
    assert.equal(rows.length, 1, 'Missing or ambiguous source test summary');
    summary = rows[0][1];
    assert(!/\d+ (failed|cancelled|todo)/.test(summary), 'Incomplete source outcomes');
    const pass = summary.match(/(\d+) passed/);
    assert(pass, 'No source tests passed');
    passed = Number(pass[1]); skipped = Number(summary.match(/(\d+) skipped/)?.[1] ?? 0);
    total = Number(summary.match(/\((\d+)\)/)?.[1] ?? passed + skipped);
  } else {
    const count = key => { const matches = [...text.matchAll(new RegExp('^# '+key+' (\\d+)\\s*$','gm'))]; assert.equal(matches.length,1,'Missing or ambiguous TAP summary'); return Number(matches[0][1]); };
    for (const key of ['fail','cancelled','todo']) assert.equal(count(key),0,'Incomplete TAP outcomes');
    passed = count('pass'); skipped = count('skipped'); total = count('tests');
    summary = `passed=${passed}; skipped=${skipped}`;
  }
  assert(passed > 0 && total === passed + skipped, 'Unaccounted or empty test outcomes');
  return { status:'passed', passed, skipped, total, failed:0, cancelled:0,
    skip_reason: skipped ? 'Explicitly skipped by the existing test suite; not operating E2E evidence. See the complete suite log.' : '', suite_summary:summary };
}

async function boundedRead(path) {
  const stat = await lstat(path);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 64 * 1024 * 1024, 'Invalid qualification evidence file');
  return readFile(path);
}

export function verifyMemoryPreservation(created, search, detail) {
  const expected = created.result?.memory ?? created.memory;
  const actual = detail.memory ?? detail;
  assert(expected && typeof expected.id === 'string' && expected.id, 'Missing created memory identity');
  assert(typeof expected.content==='string' && expected.content.trim() && typeof expected.project==='string' && expected.project.trim(),'Incomplete created memory');
  assert(expected.origin && typeof expected.origin==='object' && !Array.isArray(expected.origin) && typeof expected.origin.channel==='string' && expected.origin.channel && Number.isFinite(Date.parse(expected.origin.capturedAt)),'Missing created memory origin');
  for (const field of ['id','content','project','origin']) {
    assert(expected[field] !== undefined && actual?.[field] !== undefined, 'Missing memory preservation field');
    assert.deepEqual(actual[field],expected[field], 'Memory row changed: '+field);
  }
  assert(Array.isArray(search.results), 'Missing original search response');
  const hits=search.results.filter(row => row.observation?.id === expected.id);
  assert.equal(hits.length,1,'Expected exactly one matching search row');
  const hit=hits[0];
  assert.equal(hit.observation.narrative,expected.content,'Search content changed');
  assert.equal(hit.project ?? hit.observation.project,expected.project,'Search project changed');
  return { id:expected.id, row_sha256:hash(JSON.stringify(actual)), matched:true };
}

import {verifyPreparedResumeEvidence,preparedResumeClaimKey,verifyPreparedConfigureContinuation,assertConfigureContinuationOrdinal} from './windows-prepared-resume.mjs';
const windowsAcceptanceProofs = new WeakSet();
const windowsPhases = { fresh_install:['prepare','activate'], restart:['stop','start'], managed_update:['update'], failure_recovery:['inject','recover'] };
const windowsPath = value => {
  assert(typeof value === 'string' && /^[A-Za-z]:[\\/]/.test(value) && !/[\0"*?]/.test(value), 'Expected an absolute local Windows path');
  const normalized = win32.normalize(value);
  assert(!value.split(/[\\/]/).includes('..'), 'Windows evidence path traversal');
  return normalized.replaceAll('/', '\\').replace(/\\$/, '').toLowerCase();
};
const evidenceTime = value => {
  assert(typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value), 'Missing explicit evidence timezone');
  const time = Date.parse(value); assert(Number.isFinite(time), 'Invalid evidence time'); return time;
};
function scriptArguments(command) {
  assert(Array.isArray(command) && command.every(x=>typeof x==='string' && x.length), 'Missing process command');
  const index = command.findIndex(x=>x.toLowerCase()==='-file');
  assert(index > 0 && command.slice(1,index).every(x=>['-noprofile','-noninteractive'].includes(x.toLowerCase())), 'Unsupported PowerShell invocation');
  assert(command[index+1], 'Missing executed script');
  const parameters = new Map();
  const switches = new Set(['execute','fresh','activateprepared','validateonly','evidenceutf8']);
  for(let i=index+2;i<command.length;i++) {
    assert(/^-[A-Za-z][A-Za-z0-9]*$/.test(command[i]), 'Invalid script parameter');
    const key=command[i].slice(1).toLowerCase();
    assert(!parameters.has(key), 'Duplicate script parameter');
    if(switches.has(key)) parameters.set(key,true);
    else { assert(command[i+1] && !command[i+1].startsWith('-'), 'Missing script argument'); parameters.set(key,command[++i]); }
  }
  return {script:command[index+1], parameters};
}
function decodeUtf8(bytes) {
  try { return new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/,''); }
  catch { assert.fail('Structured evidence requires valid UTF-8 bytes'); }
}
function jsonDocuments(bytes) {
  const text=decodeUtf8(bytes); const documents=[];
  let start=-1,depth=0,string=false,escape=false;
  for(let i=0;i<text.length;i++) {
    const c=text[i];
    if(start<0) { if(c==='{') {start=i;depth=1;} continue; }
    if(string) { if(escape) escape=false; else if(c==='\\') escape=true; else if(c==='"') string=false; }
    else if(c==='"') string=true;
    else if(c==='{') depth++;
    else if(c==='}' && --depth===0) { documents.push(JSON.parse(text.slice(start,i+1)));start=-1; }
  }
  assert(start<0,'Truncated action output');
  return documents;
}
async function windowsScenarioContract(result, qualification, {manifestBytes, releaseRoot, load}, selected = windowsPhases) {
  const manifest=JSON.parse(manifestBytes.toString('utf8').replace(/^\uFEFF/,''));
  assert.equal(result.schema_version,2,'Windows evidence schema 2 required');
  assert(typeof result.execution_id==='string' && /^[a-f0-9-]{36}$/i.test(result.execution_id),'Missing Windows execution identity');
  for(const key of ['source_commit','source_input_digest','manifest_sha256'])
    assert.equal(result[key],qualification[key],'Windows scenario binding mismatch');
  assert.equal(manifest.source_commit,result.source_commit,'Windows candidate source mismatch');
  assert.equal(manifest.source_input_digest,result.source_input_digest,'Windows candidate input mismatch');
  assert.equal(hash(manifestBytes),result.manifest_sha256,'Windows candidate manifest mismatch');
  const settings=qualification.windows_e2e;
  assert(settings?.installations && settings.powershell?.path && digestPattern.test(settings.powershell.sha256),'Missing expected Windows targets or tool identity');
  const release=windowsPath(releaseRoot), usedProcess=new Set(), usedObservation=new Set();
  let importedRoot=null;
  if(result.prepared_resume){
    const r=result.prepared_resume,p=r.plan;
    for(const k of ['source_commit','source_input_digest','manifest_sha256'])assert.equal(p[k],qualification[k],'Resumed qualification candidate mismatch');
    const proof=await verifyPreparedResumeEvidence(r.spec,{plan:p,manifestBytes,synthetic:result.synthetic,load});importedRoot=proof.original_raw_root;
    const expected=structuredClone(settings);delete expected.raw_root;assert.equal(expected.installations[proof.installation_id].install_nonce,proof.install_nonce,'Resumed qualification nonce differs');expected.installations[proof.installation_id].install_nonce=null;assert.deepEqual(p.windows_e2e,expected,'Resumed qualification settings mismatch');
    const b=await load(r.claim.archive_path??r.claim.path);assert.equal(hash(b),r.claim.sha256);const c=JSON.parse(b);assert(c.execution_id===p.execution_id&&c.installation_id===proof.installation_id&&c.install_nonce===proof.install_nonce&&c.candidate_manifest_sha256===p.manifest_sha256&&c.original_evidence_sha256===hash(Buffer.from(JSON.stringify(r.spec)))&&c.synthetic===result.synthetic&&c.production_qualified===false&&/^[a-f0-9-]{36}$/i.test(c.resume_id),'Invalid resume claim chain');assert(evidenceTime(c.claimed_at_utc)>=evidenceTime(proof.closed_at_utc),'Resume claim predates closed execution');assert.equal(windowsPath(c.claim_path),windowsPath(win32.join(p.isolation_root,'evidence','resume-claims',preparedResumeClaimKey(proof)+'.json')),'Claim path is not the single nonce claim');assert.equal(hash(await load(c.claim_path)),r.claim.sha256,'Original durable claim changed or disappeared');
    if(r.continuation){const continued=await verifyPreparedConfigureContinuation(r.continuation,{proof,plan:p,synthetic:result.synthetic,load});assert(r.ordinal&&windowsPath(r.ordinal.path)===windowsPath(continued.continuation.ordinal_path),'Missing exact continuation ordinal');const ordinalBytes=await load(r.ordinal.archive_path??r.ordinal.path);assert.equal(hash(ordinalBytes),r.ordinal.sha256);assert.equal(hash(await load(r.ordinal.path)),r.ordinal.sha256,'Durable continuation ordinal changed');assertConfigureContinuationOrdinal(JSON.parse(ordinalBytes),continued);}

  }
  const inCapture=path=>[settings.raw_root,importedRoot].filter(Boolean).some(root=>{const x=win32.relative(windowsPath(root),windowsPath(path));return x&&x!=='..'&&!x.startsWith('..\\')&&!win32.isAbsolute(x);});
  const bytesCache=new Map();
  const raw=async ref=>{
    assert(ref?.path && digestPattern.test(ref.sha256),'Missing raw Windows evidence');
    const location=ref.archive_path??ref.path;
    if(ref.archive_path) {
      assert(settings.raw_root,'Archived evidence requires an expected capture root');
      const within=win32.relative(windowsPath(settings.raw_root),windowsPath(ref.archive_path));
      assert(inCapture(ref.archive_path),'Archive escapes verified capture roots');
    }
    if(!bytesCache.has(location)) bytesCache.set(location,await load(location));
    const bytes=bytesCache.get(location); assert.equal(hash(bytes),ref.sha256,'Raw Windows evidence changed'); return bytes;
  };
  const proof=async ref=>JSON.parse((await raw(ref)).toString('utf8').replace(/^\uFEFF/,''));
  const bind=(value,target,id)=>{
    assert.equal(value.execution_id,result.execution_id,'Foreign Windows execution');
    assert.equal(value.installation_id,id,'Foreign Windows installation');
    assert.equal(windowsPath(value.install_root),windowsPath(target.root),'Foreign Windows install root');
  };
  const verifiedUpdates=new Map();
  const refKey=ref=>ref?.path+'\0'+ref?.sha256;
  const verifyLauncherPreservation=async(ref,installed,target,id,at,lower)=>{
    const evidence=await proof(ref);bind(evidence,target,id);
    const action=verifiedUpdates.get(refKey(evidence.action_process));
    assert(action && action.id===id && action.preserved && action.before,'Missing verified launcher preservation action');
    assert(installed.preserved_existing_hidden_launcher===true,'Missing installed launcher preservation result');
    const binary='bin\\agentmemory-hidden-launcher.exe',source='src\\AgentMemoryHiddenLauncher.cs';
    const capture=async(value,relativePath,from,to)=>{
      assert.equal(windowsPath(value?.original_path),windowsPath(win32.join(target.root,relativePath)),'Launcher capture path mismatch');
      const observed=evidenceTime(value.observed_at_utc);
      assert(observed>=from && observed<=to,'Launcher capture out of order');
      return raw(value.content);
    };
    const beforeBinary=await capture(evidence.before_binary,binary,action.before.at,action.start);
    const beforeSource=await capture(evidence.before_source,source,action.before.at,action.start);
    const afterBinary=await capture(evidence.after_binary,binary,Math.max(action.end,lower),at);
    const prior=action.before.installed;
    assert.equal(prior.source_hashes?.[binary]?.toLowerCase(),hash(beforeBinary),'Previous launcher manifest/bytes mismatch');
    assert.equal(prior.source_hashes?.[source]?.toLowerCase(),hash(beforeSource),'Previous launcher source/bytes mismatch');
    assert.equal(hash(afterBinary),hash(beforeBinary),'Preserved launcher bytes changed');
    assert.equal(installed.source_hashes?.[binary]?.toLowerCase(),hash(afterBinary),'Installed preserved launcher hash mismatch');
    const candidate=manifest.immutable_files.find(file=>file.path===source.replaceAll('\\','/'));
    assert(candidate && candidate.sha256.toLowerCase()===manifest.adapter_source_hashes?.hidden_launcher?.toLowerCase(),'Candidate launcher source binding missing');
    assert.equal(windowsPath(evidence.candidate_source?.path),windowsPath(win32.join(releaseRoot,'payload',source)),'Candidate launcher source path mismatch');
    assert.equal(evidence.candidate_source.sha256,candidate.sha256.toLowerCase(),'Candidate launcher source hash mismatch');
    const candidateSource=await raw(evidence.candidate_source);
    const normalized=bytes=>hash(decodeUtf8(bytes).replaceAll('\r\n','\n').replaceAll('\r','\n'));
    assert.equal(normalized(candidateSource),manifest.adapter_source_hashes?.hidden_launcher_normalized?.toLowerCase(),'Candidate normalized launcher source mismatch');
    assert.equal(normalized(beforeSource),normalized(candidateSource),'Preserved launcher source differs');
  };
  const snapshot=async(ref,target,id,lower,upper,candidate,runtimeStatus,runtimeSince)=>{
    const x=await proof(ref);bind(x,target,id);
    const at=evidenceTime(x.observed_at_utc); assert(at>=lower && at<=upper,'Installed state observation out of order');
    const installed=await proof(x.manifest);
    assert.equal(windowsPath(installed.install_root),windowsPath(target.root),'Installed manifest root mismatch');
    assert.equal(installed.install_nonce,target.install_nonce,'Installed nonce mismatch');
    if(candidate) {
      assert.equal(installed.release_manifest_sha256?.toLowerCase(),result.manifest_sha256,'Installed candidate mismatch');
      assert.equal(installed.release_revision,manifest.release_revision,'Installed revision mismatch');
      assert.equal(installed.package_relative_path,manifest.package_relative_path,'Installed package mismatch');
      for(const file of manifest.immutable_files) {
        const actual=installed.source_hashes?.[file.path.replaceAll('/','\\')]?.toLowerCase();
        if(actual!==file.sha256.toLowerCase() && file.path==='bin/agentmemory-hidden-launcher.exe')
          await verifyLauncherPreservation(x.launcher_preservation,installed,target,id,at,lower);
        else assert.equal(actual,file.sha256.toLowerCase(),'Installed source identity mismatch');
      }
    }
    let runtime;
    if(runtimeStatus) {
      runtime=await proof(x.runtime);
      assert.equal(windowsPath(runtime.root),windowsPath(target.root),'Runtime root mismatch');
      assert.equal(runtime.status,runtimeStatus,'Unexpected runtime state');
      assert(typeof runtime.run_id==='string' && runtime.run_id,'Missing runtime run identity');
      const updated=evidenceTime(runtime.updated_at_utc);
      assert(updated<=at && (runtimeSince===undefined || updated>=runtimeSince),'Runtime observation predates the action or its state');
      if(runtimeStatus==='active') for(const role of ['daemon','worker','engine']) {
        assert(Number.isSafeInteger(runtime[role]?.pid) && runtime[role].pid>0,'Missing runtime process identity');
        const created=evidenceTime(runtime[role].creation_date);
        assert(runtimeSince===undefined || created>=runtimeSince,'Runtime process predates the action');
        assert(created<=updated,'Runtime process creation postdates its state update');
      }
      else assert(['authenticated_external_stop','codex_desktop_window_absent'].includes(runtime.terminal_reason),'Missing clean stop result');
    }
    return {installed,runtime,at};
  };
  const summaries={};
  for(const [name,legacyPhases] of Object.entries(selected)) {
    const scenario=result.scenarios?.[name], id=scenario?.installation_id, target=settings.installations[id];
    // Historical private runs may already include startup in activation.
    // Their two-phase evidence still has to prove an active runtime there.
    const phases=name==='fresh_install'&&scenario?.steps?.length===3?['prepare','activate','start']:legacyPhases;
    assert.equal(scenario?.success,true,'Missing or failed Windows scenario result');
    assert(target && typeof target.install_nonce==='string' && target.install_nonce && typeof target.project==='string' && target.project && target.project!=='*','Missing expected installation identity');
    windowsPath(target.root);
    const origin=new URL(target.rest_origin);
    assert(origin.protocol==='http:' && ['127.0.0.1','[::1]'].includes(origin.hostname) && !origin.username && !origin.password && origin.href===origin.origin+'/','Expected an isolated loopback API origin');
    const beginning=evidenceTime(scenario.start_utc), ending=evidenceTime(scenario.end_utc);
    assert(ending>=beginning,'Reversed scenario interval');
    assert(Array.isArray(scenario.steps) && scenario.steps.length===phases.length,'Missing or extra Windows phase');
    let previous=beginning,firstStart,lastEnd,lastStateAt,stoppedRun,injectRun,injectState;
    for(let i=0;i<phases.length;i++) {
      const phase=phases[i],step=scenario.steps[i]; assert.equal(step.phase,phase,'Windows phase order mismatch');
      const run=await proof(step.process);bind(run,target,id);
      assert.equal(run.scenario,name,'Process scenario mismatch');assert.equal(run.phase,phase,'Process phase mismatch');
      assert(Number.isSafeInteger(run.pid) && run.pid>0 && Number.isSafeInteger(run.parent_pid) && run.parent_pid>0,'Missing process identity');
      const born=evidenceTime(run.created_at_utc);
      const identity=run.pid+':'+(run.creation_filetime??run.created_at_utc);
      assert(!usedProcess.has(identity),'Reused Windows process receipt');usedProcess.add(identity);
      assert(Number.isSafeInteger(run.exit_code),'Unrecorded child exit code');
      const start=evidenceTime(run.start_utc),end=evidenceTime(run.end_utc);
      assert(start>=previous && end>=start && end<=ending && born>=beginning && born<=start,'Windows process order mismatch');
      firstStart??=start;lastEnd=end;
      assert.equal(windowsPath(run.command?.[0]),windowsPath(settings.powershell.path),'Unexpected execution tool');
      assert.equal(windowsPath(run.executable?.path),windowsPath(settings.powershell.path),'Process executable mismatch');
      assert.equal(run.executable.sha256,settings.powershell.sha256,'Execution tool hash mismatch');await raw(run.executable);
      const {script,parameters:args}=scriptArguments(run.command);
      const installer=!['stop','start'].includes(phase);
      const relativeScript=installer?'Install-WindowsCodex.ps1':'scripts/agentmemory-'+(phase==='stop'?'stop':'mcp')+'.ps1';
      const expectedPath=win32.join(installer?releaseRoot:target.root,relativeScript);
      const inventory=installer?manifest.release_files:manifest.immutable_files;
      const entry=inventory?.find(x=>x.path===relativeScript);
      assert(entry,'Candidate action script missing');
      if(phase==='inject'){
        assert.deepEqual(settings.failure_fixture,fixedCopyFailure,'Failure fixture scope missing');
        const fixture=run.qualification_fixture;
        exactKeys(fixture,['kind','checkpoint','base_installer']);
        assert(fixture.kind===fixedCopyFailure.kind&&fixture.checkpoint===fixedCopyFailure.checkpoint,'Unknown failure fixture');
        assert.equal(windowsPath(fixture.base_installer.path),windowsPath(expectedPath),'Fixture base is not candidate installer');
        assert.equal(fixture.base_installer.sha256,entry.sha256.toLowerCase(),'Fixture base hash differs from candidate');
        assert(inCapture(script),'Failure fixture is outside captured evidence');
        assert.equal(windowsPath(run.script.path),windowsPath(script),'Fixture script identity mismatch');
        assert.deepEqual(await raw(run.script),createPreStartCopyFailureInstaller(await raw(fixture.base_installer)),'Failure fixture differs from fixed candidate transformation');
      }else{
        assert.equal(windowsPath(script),windowsPath(expectedPath),'Unsupported Windows action script');
        assert.equal(windowsPath(run.script?.path),windowsPath(expectedPath),'Executed script identity mismatch');
        assert.equal(run.script.sha256,entry.sha256.toLowerCase(),'Action script is not the candidate source');await raw(run.script);
        assert(!run.qualification_fixture,'Failure fixture cannot qualify a successful install');
      }
      const allowed=installer?['releaseroot','installroot','workspaceroot','projectregistry','nodepath','managedrequirementspath','restport','execute','fresh','activateprepared','evidenceutf8','evidenceidentitypath']:['root','timeoutseconds','validateonly','evidenceutf8','evidenceidentitypath'];
      assert([...args.keys()].every(x=>allowed.includes(x)),'Unsupported action parameter');
      assert.equal(args.has('evidenceutf8'),args.has('evidenceidentitypath'),'Evidence capture flags must be paired');
      if(args.has('evidenceidentitypath')) {
        assert(settings.raw_root,'Expected capture root is required');
        const location=win32.relative(windowsPath(settings.raw_root),windowsPath(args.get('evidenceidentitypath')));
        assert(inCapture(args.get('evidenceidentitypath')),'Identity capture escapes verified capture roots');
      }
      assert.equal(windowsPath(args.get(installer?'installroot':'root')),windowsPath(target.root),'Command targets another installation');
      if(installer) {
        assert.equal(windowsPath(args.get('releaseroot')),release,'Command targets another candidate');assert.equal(args.get('execute'),true,'Installer was not executed');
        assert.equal(args.has('fresh'),phase==='prepare','Incorrect fresh action');
        assert.equal(args.has('activateprepared'),phase==='activate','Incorrect activation action');
      } else assert.equal(args.has('validateonly'),phase==='start','Incorrect runtime action');
      const stdout=await raw(run.stdout),stderr=await raw(run.stderr);
      assert.equal(run.stdout.encoding,'utf-8','Explicit UTF-8 stdout capture required');decodeUtf8(stdout);
      let outputRow;
      if(phase==='inject') {assert.notEqual(run.exit_code,0,'Failure injection did not fail');assert(stderr.length>0,'Missing original failure stream');injectRun=run;}
      else {
        assert.equal(run.exit_code,0,'Windows phase failed');
        const documents=jsonDocuments(stdout);
        if(installer) {
          const rows=documents.filter(x=>x.install_root && windowsPath(x.install_root)===windowsPath(target.root) && x.execute===true && x.ready===true);
          assert.equal(rows.length,1,'Missing actual installer output');const row=rows[0];outputRow=row;
          if(phase==='prepare') assert(row.operation==='prepare-fresh' && row.prepared===true && row.service_started===false,'Missing prepare result');
          else if(phase==='activate') assert(row.operation==='activate-prepared' && row.activated===true,'Missing activation result');
          else assert(row.healthy===true && row.data_action==='preserve' && windowsPath(row.canonical_data)===windowsPath(win32.join(target.root,'data')),'Missing actual update result');
        } else if(phase==='stop') assert(documents.some(x=>x.stopped===true),'Missing clean stop output');
      }
      const freshStart=name==='fresh_install'&&phase==='start',activationOnly=name==='fresh_install'&&phase==='activate'&&phases.includes('start');
      let before;
      if(phase==='update' || phase==='start' || (phase==='recover' && step.before)) before=await snapshot(step.before,target,id,phase==='start'?previous:beginning,start,freshStart,phase==='start'&&!freshStart?'inactive':null);
      if(freshStart)assert.equal(before.installed.installation_status,'activated','Fresh start must follow activation');
      if(phase==='update') {
        assert.equal(before.installed.release_manifest_sha256?.toLowerCase(),target.predecessor_manifest_sha256,'Wrong update predecessor');
        assert.notEqual(target.predecessor_manifest_sha256,result.manifest_sha256,'Same candidate reinstall is not managed update');
        assert.notEqual(before.installed.release_revision,manifest.release_revision,'Same revision is not managed update');
      }
      if(installer && run.exit_code===0 && ['update','recover'].includes(phase))
        verifiedUpdates.set(refKey(step.process),{id,preserved:outputRow?.preserve_existing_hidden_launcher===true,before,start,end});
      const after=await snapshot(step.after,target,id,end,ending,phase!=='inject',phase==='prepare'||phase==='inject'||activationOnly?null:phase==='stop'?'inactive':'active',freshStart?beginning:start);
      if(phase==='inject')injectState=after;
      if(phase==='prepare') assert.equal(after.installed.installation_status,'prepared','Installation was not prepared');
      else if(phase!=='inject') assert.equal(after.installed.installation_status,'activated','Installation was not activated');
      if(phase==='stop') stoppedRun=after.runtime.run_id;
      if(phase==='start'&&!freshStart) assert(before.runtime.run_id===stoppedRun && after.runtime.run_id!==stoppedRun,'Restart did not replace the stopped run');
      previous=after.at;lastStateAt=after.at;
    }
    const capture=async(ref,kind)=>{
      const x=await proof(ref);bind(x,target,id);
      assert(typeof x.capture_id==='string' && x.capture_id && !usedObservation.has(x.capture_id),'Reused API observation');usedObservation.add(x.capture_id);
      const at=evidenceTime(x.observed_at_utc);assert(at>=beginning && at<=ending,'API observation outside scenario');
      assert.equal(x.request?.project,target.project,'API project mismatch');
      const url=new URL(x.request.url);
      assert(url.origin===origin.origin && !url.username && !url.password,'API targets another installation');
      const paths={created:'/agentmemory/remember',search:'/agentmemory/search'};
      if(kind==='detail') {assert(url.pathname.startsWith('/agentmemory/memories/'),'Wrong detail endpoint');assert.equal(url.searchParams.get('project'),target.project,'Detail project mismatch');}
      else assert.equal(url.pathname,paths[kind],'Wrong memory endpoint');
      assert.equal(x.request.method,kind==='detail'?'GET':'POST','Wrong memory request method');
      assert(x.status_code>=200 && x.status_code<300,'Memory API failed');
      return {at,body:await proof(x.response),url};
    };
    const created=await capture(scenario.memory?.created,'created'),search=await capture(scenario.memory?.search,'search'),detail=await capture(scenario.memory?.detail,'detail');
    assert(search.at>=lastStateAt && detail.at>=search.at,'Search/detail predates the action or is reordered');
    assert(created.at<=search.at && (name==='fresh_install'?created.at>=lastEnd:created.at<=firstStart),'Memory creation does not bracket the action');
    const row=verifyMemoryPreservation(created.body,search.body,detail.body);
    assert.equal((created.body.result?.memory??created.body.memory).project,target.project,'Created memory project mismatch');
    assert.equal(decodeURIComponent(detail.url.pathname.slice('/agentmemory/memories/'.length)),row.id,'Detail request uses another memory');
    if(name==='failure_recovery') {
      const failure=await proof(scenario.failure);
      verifyFixedCopyFailureOutcome(failure);
      assert(failure.outcome==='automatic_rollback'||failure.runtime_stopped===true,'Unconfirmed runtime stop cannot qualify recovery');
      assert(typeof failure.original_error==='string' && failure.original_error.trim(),'Missing original failure');
      assert(typeof failure.phase==='string' && failure.phase.trim(),'Missing failure phase');
      assert.deepEqual(failure.stderr,injectRun.stderr,'Failure is not bound to the failed child stream');
      assert(['rollback_failed','rollback_withheld','automatic_rollback'].includes(failure.outcome),'Unclassified rollback outcome');
      if(failure.outcome==='rollback_failed') {
        assert(typeof failure.restore_error==='string' && failure.restore_error.trim(),'Missing restoration failure');
        assert.deepEqual(failure.restore_stderr,injectRun.stderr,'Restoration stream is not bound to the failed installer child');
        assert((await raw(failure.restore_stderr)).length>0,'Missing raw restoration failure');
      }
      const observed=injectState.installed.cutover_failure;
      assert(observed,'Missing installed cutover failure outcome');
      for(const k of ['original_error','original_error_id','original_error_hresult','restore_error','phase','outcome','restoration_completed','runtime_ready','runtime_stopped'])assert.deepEqual(failure[k],observed[k],'Failure summary differs from installed outcome');
      if(failure.outcome==='automatic_rollback'){
        assert(failure.restoration_completed===true&&failure.runtime_ready===true,'Automatic rollback lacks restored/fresh-ready evidence');
        const restored=await snapshot(failure.restored_state,target,id,evidenceTime(injectRun.end_utc),ending,false,'active',evidenceTime(injectRun.start_utc));
        assert.equal(restored.installed.release_manifest_sha256?.toLowerCase(),target.predecessor_manifest_sha256,'Rollback restored another version');
        assert.deepEqual(restored.installed,injectState.installed,'Restored state differs from failure snapshot');
      }
    }
    summaries[name]={installation_id:id,first_action_at:firstStart,last_action_at:lastEnd,memory_id:row.id};
  }
  return {success:true,source_commit:result.source_commit,source_input_digest:result.source_input_digest,manifest_sha256:result.manifest_sha256,scenarios:summaries};
}
// A partial check never enters windowsAcceptanceProofs and cannot satisfy the final gate.
async function partialWindowsEvidence(result, qualification, context, synthetic) {
  assert.equal(result.synthetic,synthetic,'Partial evidence kind mismatch');
  assert.equal(result.evidence_kind,synthetic?'synthetic_contract':'windows_execution','Partial evidence kind mismatch');
  assert.equal(result.production_qualified,false,'Partial evidence cannot claim production qualification');
  const names=Object.keys(result.scenarios??{});
  assert(names.length>0 && names.every(n=>['fresh_install','restart'].includes(n)),'Partial check supports only fresh/restart');
  if(names.includes('restart'))assert(names.includes('fresh_install'),'Restart requires its fresh predecessor in this partial run');
  const selected=Object.fromEntries(names.map(n=>[n,windowsPhases[n]]));
  const checked=await windowsScenarioContract(result,qualification,{...context,load:synthetic?(context.load??boundedRead):boundedRead},selected);
  if(names.includes('restart')) {
    const a=result.scenarios.fresh_install,b=result.scenarios.restart;
    assert.equal(a.installation_id,b.installation_id,'Partial lifecycle changed installations');
    assert(evidenceTime(b.start_utc)>=evidenceTime(a.end_utc),'Partial lifecycle is out of order');
  }
  return Object.freeze({...checked,acceptance:synthetic?'synthetic_partial_contract':'windows_partial_execution',production_qualified:false,remaining_scenarios:Object.keys(windowsPhases).filter(n=>!names.includes(n))});
}
export function verifyPartialWindowsScenarioEvidence(result,qualification,context) {return partialWindowsEvidence(result,qualification,context,false);}
export function verifySyntheticPartialWindowsScenarioEvidence(result,qualification,context) {return partialWindowsEvidence(result,qualification,context,true);}

export async function verifySyntheticWindowsScenarioEvidence(result, qualification, context) {
  assert.equal(result.evidence_kind,'synthetic_contract','Synthetic contract evidence required');
  assert.equal(result.synthetic,true,'Explicit synthetic marker required');
  const checked=await windowsScenarioContract(result,qualification,{...context,load:context.load??boundedRead});
  return {...checked,acceptance:'synthetic_contract',production_qualified:false};
}
export async function verifyWindowsScenarioEvidence(result, qualification, context) {
  assert.equal(result.evidence_kind,'windows_execution','Synthetic or legacy evidence cannot qualify Windows execution');
  assert.equal(result.synthetic,false,'Synthetic Windows evidence cannot qualify a distribution');
  const checked=await windowsScenarioContract(result,qualification,{...context,load:boundedRead});
  const accepted=Object.freeze({...checked,acceptance:'windows_execution'});
  windowsAcceptanceProofs.add(accepted);return accepted;
}

async function verifyEvidenceFiles(qualification, context) {
  for (const name of ['source','adapter','packaging']) {
    const suite = qualification.suites?.[name];
    assert(suite?.log_path && suite.log_sha256, 'Missing suite log evidence');
    const bytes = await boundedRead(suite.log_path);
    assert.equal(hash(bytes), suite.log_sha256, 'Test log changed after qualification');
    const parsed = parseSuiteLog(name, bytes.toString('utf8'));
    for (const key of ['passed','failed','skipped','cancelled','total']) assert.equal(parsed[key],suite[key],'Test counts differ from their log');
  }
  const proof = qualification.windows_e2e?.evidence;
  assert(proof?.path && proof.sha256, 'Missing Windows scenario evidence file');
  const bytes = await boundedRead(proof.path);
  assert.equal(hash(bytes),proof.sha256,'Windows scenario evidence changed');
  const result = JSON.parse(bytes);
  assert.equal(result.source_commit,qualification.source_commit,'Windows scenario source mismatch');
  assert.equal(result.source_input_digest,qualification.source_input_digest,'Windows scenario inputs mismatch');
  assert.equal(result.manifest_sha256,qualification.manifest_sha256,'Windows scenario manifest mismatch');
  return verifyWindowsScenarioEvidence(result,qualification,context);
}

export async function sourceInputDigest(root, paths) {
  assert(Array.isArray(paths) && paths.length > 0 && new Set(paths).size === paths.length, 'Invalid source file inventory');
  const files = [];
  for (const path of [...paths].sort()) {
    const target = resolve(root, path), within = relative(resolve(root), target);
    assert(within && !within.startsWith('..') && !isAbsolute(within), 'Source inventory escapes its root');
    const stat = await lstat(target);
    assert(stat.isFile() && !stat.isSymbolicLink(), 'Source inventory requires regular files');
    const bytes = await readFile(target);
    files.push({ path: path.replaceAll('\\', '/'), bytes: bytes.length, sha256: hash(bytes) });
  }
  return { sha256: hash(JSON.stringify(files)), file_count: files.length };
}

export function verifyQualificationRecordContract({ manifest, manifestHash, inputDigest, qualification, native }) {
  assert.equal(manifest.custom_libraries?.input_digest,qualification.library_input_digest,'Custom library input binding mismatch');
  assert.equal(manifest.build_kind, 'release_candidate', 'Not a release candidate');
  assert.equal(manifest.tests_skipped, false, 'Release tests were skipped or unrecorded');
  assert.equal(qualification.schema_version, 1, 'Unsupported qualification schema');
  assert.equal(qualification.tests_skipped, false, 'Qualification tests were skipped or unrecorded');
  assert.equal(qualification.source_commit, manifest.source_commit, 'Qualification source commit mismatch');
  assert.equal(qualification.source_input_digest, inputDigest, 'Qualification source input mismatch');
  assert.equal(manifest.source_input_digest, inputDigest, 'Manifest source input mismatch');
  assert.equal(qualification.manifest_sha256, manifestHash, 'Qualification manifest mismatch');
  assert.equal(qualification.payload_digest, payloadDigest(manifest), 'Qualification payload mismatch');
  for (const key of ['node', 'pnpm', 'platform', 'powershell']) assert(qualification.environment?.[key], 'Missing qualification environment');
  for (const name of ['source', 'adapter', 'packaging']) {
    const suite = qualification.suites?.[name];
    assert(suite && suite.status === 'passed', 'Missing or failed mandatory test suite');
    for (const key of ['passed', 'failed', 'skipped', 'cancelled', 'total']) assert(Number.isSafeInteger(suite[key]) && suite[key] >= 0, 'Invalid test counts');
    assert(suite.passed > 0 && suite.failed === 0 && suite.cancelled === 0, 'Mandatory tests did not pass');
    assert.equal(suite.total, suite.passed + suite.skipped, 'Unaccounted test outcomes');
    if (suite.skipped) assert(typeof suite.skip_reason === 'string' && suite.skip_reason.trim(), 'Skipped tests require a reason');
    if (name === 'packaging') assert.equal(suite.skipped, 0, 'Mandatory Windows packaging tests cannot be skipped');
  }
  const windows = qualification.windows_e2e;
  assert.equal(windows?.source_commit, manifest.source_commit, 'Windows E2E source mismatch');
  assert.equal(windows?.manifest_sha256, manifestHash, 'Windows E2E manifest mismatch');
  for (const scenario of ['fresh_install', 'managed_update', 'restart', 'failure_recovery']) assert.equal(windows[scenario], 'passed', 'Missing or failed Windows E2E scenario');
  assert.equal(native?.success, true, 'Native operating evidence is not confirmed');
  assert.equal(native.identity?.sourceCommit, manifest.source_commit, 'Native E2E source mismatch');
  assert.equal(native.identity?.releaseManifestHash, manifestHash, 'Native E2E manifest mismatch');
  assert.equal(native.identity?.runtime, manifest.release_revision, 'Native E2E runtime mismatch');
  for (const name of ['worker-start', 'capture', 'discovery', 'drain', 'search', 'status', 'qualification'])
    assert.equal(native.stages?.[name]?.status, 'passed', 'Incomplete native E2E stage evidence');
  const fresh = native.stages?.qualification?.result?.freshGraph;
  assert(fresh && fresh.sourceId === native.target?.observationId && fresh.sourceKey === native.target?.sourceKey && fresh.nodes?.length > 0, 'Fresh native automatic graph and source proof required');
  assert(Number.isFinite(Date.parse(fresh.extraction?.completedAt)) && Date.parse(fresh.extraction.completedAt) >= Date.parse(native.identity.activationAt), 'Native graph predates candidate activation');
  return { success: true, validation: 'record_contract', production_qualified: false, source_commit: manifest.source_commit, manifest_sha256: manifestHash, source_input_digest: inputDigest };
}

export function verifyQualificationRecords(value) {
  const contract = verifyQualificationRecordContract(value);
  const checked = value.windowsEvidence;
  assert(windowsAcceptanceProofs.has(checked), 'Live Windows verification in this process required');
  for (const key of ['source_commit','source_input_digest','manifest_sha256'])
    assert.equal(checked[key],contract[key], 'Verified Windows result binding mismatch');
  return { success:true, source_commit:contract.source_commit, source_input_digest:contract.source_input_digest,
    manifest_sha256:contract.manifest_sha256, validation:'distribution_evidence' };
}

async function trackedSourceDigest(sourceRoot) {
  const result = spawnSync('git', ['-C', sourceRoot, 'ls-files', '-z', '--', '.'], { maxBuffer: 16 * 1024 * 1024, timeout: 10000, windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 0, 'Could not read tracked source inventory');
  const paths = new TextDecoder('utf-8', { fatal: true }).decode(result.stdout).split('\0').filter(Boolean);
  return sourceInputDigest(sourceRoot, paths);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [mode, sourceRoot, releaseRoot, qualificationPath, expectedCommit] = process.argv.slice(2);
    if (mode === 'memory') {
      console.log(JSON.stringify(verifyMemoryPreservation(
        JSON.parse(await boundedRead(sourceRoot)),JSON.parse(await boundedRead(releaseRoot)),JSON.parse(await boundedRead(qualificationPath)))));
    }
    else if (mode === 'suite') {
      const raw = await boundedRead(sourceRoot);
      console.log(JSON.stringify({ ...parseSuiteLog(releaseRoot,raw.toString('utf8')), log_path:resolve(sourceRoot), log_sha256:hash(raw) }));
    }
    else if (mode === 'payload') {
      const manifest = JSON.parse(await readFile(join(sourceRoot,'release-manifest.json'),'utf8'));
      await verifyUserLibraryFiles(join(sourceRoot,'payload'),manifest,{library_input_digest:manifest.custom_libraries?.input_digest});
      await verifyNativeSourceEvidenceFiles(sourceRoot,manifest);
      console.log(JSON.stringify({sha256:payloadDigest(manifest)}));
    }
    else if (mode === 'snapshot') console.log(JSON.stringify(await trackedSourceDigest(sourceRoot)));
    else {
      assert.equal(mode, 'verify');
      const snapshot = await trackedSourceDigest(sourceRoot);
      const raw = await readFile(join(releaseRoot, 'release-manifest.json'));
      const manifest = JSON.parse(raw);
      assert.equal(manifest.source_commit, expectedCommit, 'Packaging source commit mismatch');
      const location = relative(resolve(releaseRoot), resolve(qualificationPath));
      assert(location === '..' || location.startsWith('..' + sep) || isAbsolute(location), 'Qualification must remain outside immutable release payload');
      const qualification = JSON.parse(await readFile(qualificationPath, 'utf8'));
      await verifyUserLibraryFiles(join(releaseRoot,'payload'),manifest,qualification);
      await verifyNativeSourceEvidenceFiles(releaseRoot,manifest);
      const windowsEvidence = await verifyEvidenceFiles(qualification, { manifestBytes:raw, releaseRoot });
      const operating = qualification.operating_e2e;
      assert(operating?.evidence_root && operating.process_outcome, 'Missing operating E2E evidence');
      const native = await consumeNativeEvidence(operating.evidence_root, operating.process_outcome);
      console.log(JSON.stringify(verifyQualificationRecords({ manifest, manifestHash: hash(raw), inputDigest: snapshot.sha256, qualification, native, windowsEvidence })));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
