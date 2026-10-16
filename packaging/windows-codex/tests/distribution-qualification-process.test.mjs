import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { hash, payloadDigest, sourceInputDigest } from '../verification/distribution-qualification.mjs';
import { saveUnconfirmedEvidence, confirmNativeEvidence } from '../verification/native-evidence-store.mjs';
import { powershellEnvironment } from '../npm/cli.mjs';

const windows = process.platform === 'win32';
const packaging = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const quote = value => "'" + value.replaceAll("'", "''") + "'";
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'am-dist-proof-'));
  const source = path.join(root, 'source'), release = path.join(root, 'release'), output = path.join(root, 'output');
  const scripts = path.join(source, 'packaging/windows-codex');
  await mkdir(path.join(scripts, 'verification'), {recursive:true});await mkdir(path.join(scripts, 'npm'));
  for (const name of ['Build-NpmDistribution.ps1','verification/distribution-qualification.mjs','verification/native-evidence-store.mjs','npm/cli.mjs','npm/Expand-Release.ps1','npm/README.md'])
    await copyFile(path.join(packaging,name),path.join(scripts,name));
  const git = (...args) => {
    const r=spawnSync('git',['-C',source,...args],{encoding:'utf8',timeout:10000,windowsHide:true});
    assert.ifError(r.error);assert.equal(r.status,0,r.stderr);return r.stdout.trim();
  };
  // This is an isolated, task-owned synthetic repository; the real checkout is never queried or changed.
  await mkdir(path.join(root,'empty-hooks'));
  git('init','-q');
  git('add','.');git('-c','user.name=Qualification Fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath='+path.join(root,'empty-hooks'),'-c','commit.gpgsign=false','-c','core.autocrlf=false','commit','-qm','synthetic fixture');
  const commit=git('rev-parse','HEAD');
  const paths=git('ls-files').split(/\r?\n/);
  const input=(await sourceInputDigest(source,paths)).sha256;
  await mkdir(path.join(release,'payload'),{recursive:true});
  await writeFile(path.join(release,'payload/worker.mjs'),'synthetic worker\n');
  const manifest={schema_version:1,product_id:'agentmemory-codex-windows',downstream_version:'0.1.0-preview.17',source_commit:commit,release_revision:'r212',
    build_kind:'release_candidate',tests_skipped:false,source_input_digest:input,release_files:[],immutable_files:[{path:'worker.mjs',sha256:hash(await readFile(path.join(release,'payload/worker.mjs'))),size_bytes:17}]};
  for(const name of ['LICENSE','NOTICE','iii-LICENSE_ELv2','THIRD-PARTY-NOTICES.md']){await writeFile(path.join(release,name),'synthetic license fixture\n');manifest.release_files.push({path:name,sha256:hash(await readFile(path.join(release,name)))})}
  await writeFile(path.join(release,'release-manifest.json'),JSON.stringify(manifest));
  const mh=hash(JSON.stringify(manifest)),suite={status:'passed',passed:4,failed:0,cancelled:0,skipped:0,total:4};
  const qualification={schema_version:1,tests_skipped:false,source_commit:commit,source_input_digest:input,manifest_sha256:mh,payload_digest:payloadDigest(manifest),
    environment:{node:process.version,pnpm:'synthetic',platform:'win32',powershell:'5.1'},suites:{source:{...suite},adapter:{...suite},packaging:{...suite}},
    windows_e2e:{source_commit:commit,manifest_sha256:mh,fresh_install:'passed',managed_update:'passed',restart:'passed',failure_recovery:'passed'}};
  for(const name of ['source','adapter','packaging']){
    const log=name==='source'?'Tests 4 passed (4)\n':'# tests 4\n# pass 4\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
    const file=path.join(root,name+'.log');await writeFile(file,log);qualification.suites[name].log_path=file;qualification.suites[name].log_sha256=hash(log);
  }
  const windowsProofPath=path.join(root,'windows-results.json');
  const windowsProof=JSON.stringify({source_commit:commit,source_input_digest:input,manifest_sha256:mh,
    scenarios:Object.fromEntries(['fresh_install','managed_update','restart','failure_recovery'].map(name=>[name,{success:true}]))});
  await writeFile(windowsProofPath,windowsProof);qualification.windows_e2e.evidence={path:windowsProofPath,sha256:hash(windowsProof)};
  const executionId=randomUUID(),evidence=path.join(root,'native');
  const record={executionId,success:false,verificationPassed:true,identity:{sourceCommit:commit,releaseManifestHash:mh,runtime:'r212',activationAt:'2026-10-15T00:00:00Z'},target:{observationId:'synthetic-observation',sourceKey:'synthetic-key'},
    stages:Object.fromEntries(['worker-start','capture','discovery','drain','search','status','qualification'].map(name=>[name,{status:'passed'}]))};
  record.stages.qualification.result={freshGraph:{sourceId:record.target.observationId,sourceKey:record.target.sourceKey,nodes:['synthetic-node'],extraction:{completedAt:'2026-10-15T00:01:00Z'}}};
  const ack=await saveUnconfirmedEvidence(evidence,record);await confirmNativeEvidence(evidence,{...ack,exitCode:0});
  qualification.operating_e2e={evidence_root:evidence,process_outcome:{...ack,exitCode:0}};
  const proof=path.join(root,'qualification.json');
  return {root,source,release,output,scripts,manifest,qualification,proof};
}
for(const fault of ['normal','missing','failed','skipped','old-commit','tampered-payload','missing-windows','tampered-log','missing-windows-proof']) {
  test(`actual PS5.1 distribution ${fault==='normal'?'accepts synthetic matching evidence':'rejects '+fault}`,{skip:!windows},async()=>{
    const f=await fixture();
    try {
      if(fault==='failed')f.qualification.suites.source.failed=1;
      if(fault==='skipped')f.qualification.tests_skipped=true;
      if(fault==='old-commit')f.qualification.source_commit='f'.repeat(40);
      if(fault==='missing-windows')delete f.qualification.windows_e2e.failure_recovery;
      if(fault==='missing-windows-proof')delete f.qualification.windows_e2e.evidence;
      if(fault==='tampered-log')await writeFile(f.qualification.suites.source.log_path,'Tests 100 passed (100)\n');
      if(fault==='tampered-payload')await writeFile(path.join(f.release,'payload/worker.mjs'),'tampered\n');
      if(fault!=='missing')await writeFile(f.proof,JSON.stringify(f.qualification));
      const env=powershellEnvironment();env.NPM_CONFIG_CACHE=path.join(f.root,'npm-cache');env.NPM_CONFIG_UPDATE_NOTIFIER='false';
      const command=`$ErrorActionPreference='Stop'; & ${quote(path.join(f.scripts,'Build-NpmDistribution.ps1'))} -ReleaseRoot ${quote(f.release)} -OutputDirectory ${quote(f.output)} -QualificationPath ${quote(f.proof)}; exit $LASTEXITCODE`;
      const r=spawnSync(path.join(env.SYSTEMROOT,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',command],{env,encoding:'utf8',timeout:45000,windowsHide:true});
      assert.ifError(r.error);
      if(fault==='normal'){
        assert.equal(r.status,0,r.stderr);
        const sums=(await readFile(path.join(f.output,'SHA256SUMS.txt'),'utf8')).trim().split('\n');
        assert.equal(sums.length,3);
        const assets=[];
        for(const line of sums){const [,digest,name]=/^([a-f0-9]{64})  ([^/\\]+)$/.exec(line)??[];assert(digest&&name);assets.push(name);assert.equal(hash(await readFile(path.join(f.output,name))),digest)}
        assert.deepEqual(assets.sort(),['agentmemory-codex-windows-0.1.0-preview.17-win32-x64.zip','agentmemory-codex-windows-0.1.0-preview.17.tgz','release.json'].sort());
        const descriptor=JSON.parse(await readFile(path.join(f.output,'release.json'),'utf8'));
        assert.equal(descriptor.source_commit,f.manifest.source_commit);
        assert.equal(descriptor.archive_sha256,hash(await readFile(path.join(f.output,'agentmemory-codex-windows-0.1.0-preview.17-win32-x64.zip'))));
      }else{assert.notEqual(r.status,0);await assert.rejects(access(f.output),{code:'ENOENT'})}
    } finally {await rm(f.root,{recursive:true,force:true})}
  });
}
