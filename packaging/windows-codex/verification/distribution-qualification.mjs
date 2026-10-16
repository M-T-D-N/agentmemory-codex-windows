import assert from 'node:assert/strict';
import { readFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve, relative, isAbsolute, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { consumeNativeEvidence } from './native-evidence-store.mjs';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const payloadDigest = manifest => hash(JSON.stringify(manifest.immutable_files.map(file => ({
  path: file.path, sha256: file.sha256.toLowerCase(), size_bytes: file.size_bytes ?? null,
})).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));

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

async function verifyEvidenceFiles(qualification) {
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
  for (const scenario of ['fresh_install','managed_update','restart','failure_recovery'])
    assert.equal(result.scenarios?.[scenario]?.success,true,'Missing or failed Windows scenario result');
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

export function verifyQualificationRecords({ manifest, manifestHash, inputDigest, qualification, native }) {
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
  return { success: true, source_commit: manifest.source_commit, manifest_sha256: manifestHash, source_input_digest: inputDigest };
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
    if (mode === 'suite') {
      const raw = await boundedRead(sourceRoot);
      console.log(JSON.stringify({ ...parseSuiteLog(releaseRoot,raw.toString('utf8')), log_path:resolve(sourceRoot), log_sha256:hash(raw) }));
    }
    else if (mode === 'payload') console.log(JSON.stringify({ sha256: payloadDigest(JSON.parse(await readFile(join(sourceRoot, 'release-manifest.json'), 'utf8'))) }));
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
      await verifyEvidenceFiles(qualification);
      const operating = qualification.operating_e2e;
      assert(operating?.evidence_root && operating.process_outcome, 'Missing operating E2E evidence');
      const native = await consumeNativeEvidence(operating.evidence_root, operating.process_outcome);
      console.log(JSON.stringify(verifyQualificationRecords({ manifest, manifestHash: hash(raw), inputDigest: snapshot.sha256, qualification, native })));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
