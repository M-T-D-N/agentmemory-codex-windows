import assert from 'node:assert/strict';
import { open, lstat, readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname, join, relative, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const ARCHIVE = 'NATIVE-SOURCE-EVIDENCE.zip';
const DESCRIPTOR = 'NATIVE-SOURCE-EVIDENCE.json';
const hash = b => createHash('sha256').update(b).digest('hex');
const sameFile = (a, b) => ['dev','ino','size','mtimeNs','ctimeNs'].every(k => a[k] === b[k]);
const keys = (o, expected) => assert.deepEqual(Object.keys(o ?? {}).sort(), [...expected].sort(), 'Invalid native source evidence fields');

export function verifyNativeSourceProfile(profile) {
  keys(profile, ['schema_version','kind','archive_name','archive_size_bytes','archive_sha256','coverage','unresolved','complete']);
  assert.equal(profile.schema_version, 1);
  assert.equal(profile.kind, 'partial-native-source-evidence');
  assert.equal(profile.archive_name, ARCHIVE);
  assert(Number.isSafeInteger(profile.archive_size_bytes) && profile.archive_size_bytes > 0 && profile.archive_size_bytes <= 200 * 1024 * 1024, 'Invalid source evidence size');
  assert(/^[a-f0-9]{64}$/.test(profile.archive_sha256), 'Invalid source evidence digest');
  assert.equal(profile.complete, false, 'Partial source evidence cannot clear distribution rights');
  assert.equal(profile.coverage, 'sources-and-notices-with-selected-and-conditional-rust');
  assert(Array.isArray(profile.unresolved) && profile.unresolved.every(issue => typeof issue === 'string' && issue.trim().length > 0), 'Invalid unresolved source review items');
  assert.equal(new Set(profile.unresolved).size, profile.unresolved.length, 'Duplicate unresolved source review items');
  return profile;
}

async function profileDefault() {
  return verifyNativeSourceProfile(JSON.parse(await readFile(new URL('../licenses/native-source-evidence.json', import.meta.url), 'utf8')));
}

async function physical(path, file) {
  path = resolve(path);
  let p = path;
  while (true) {
    const s = await lstat(p);
    assert(!s.isSymbolicLink(), 'Redirected native source evidence path');
    if (p === path) assert(file ? s.isFile() : s.isDirectory(), 'Invalid native source evidence path type');
    else assert(s.isDirectory(), 'Invalid native source evidence parent');
    const parent = dirname(p);
    if (parent === p) break;
    p = parent;
  }
  assert.equal((await realpath(path)).toLowerCase(), path.toLowerCase(), 'Native source evidence physical path mismatch');
  return path;
}

async function streamHash(handle, expected, destination) {
  const sha = createHash('sha256');
  const buffer = Buffer.alloc(1024 * 1024);
  let size = 0;
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, size);
    if (!bytesRead) break;
    size += bytesRead;
    assert(size <= expected.archive_size_bytes, 'Source evidence grew during read');
    const chunk = buffer.subarray(0, bytesRead);sha.update(chunk);
    if (destination) await destination.writeFile(chunk);
  }
  assert.equal(size, expected.archive_size_bytes, 'Source evidence size mismatch');
  assert.equal(sha.digest('hex'), expected.archive_sha256, 'Source evidence digest mismatch');
}

// Copies opaque reviewed bytes only. It does not unpack/run sources or judge rights.
// Caller owns the fresh candidate directory exclusively; no hostile-writer/race claim.
export async function stageNativeSourceEvidence(archive, release, profile) {
  profile = profile ? verifyNativeSourceProfile(profile) : await profileDefault();
  archive = await physical(archive, true);release = await physical(release, false);
  const within = relative(release, archive);
  assert(within === '..' || within.startsWith('..' + sep) || isAbsolute(within), 'Evidence input must remain outside the fresh candidate');
  const input = await open(archive, 'r');
  let output;
  try {
    const initial = await input.stat({bigint:true});
    assert.equal(initial.size, BigInt(profile.archive_size_bytes), 'Source evidence size mismatch');
    assert(sameFile(initial, await lstat(archive, {bigint:true})), 'Source evidence identity changed');
    await streamHash(input, profile); // Verify before creating any candidate file.
    assert(sameFile(initial, await input.stat({bigint:true})), 'Source evidence mutated');
    output = await open(join(release, ARCHIVE), 'wx');
    await streamHash(input, profile, output);
    await output.sync();await output.close();output = undefined;
    assert(sameFile(initial, await input.stat({bigint:true})) && sameFile(initial, await lstat(archive, {bigint:true})), 'Source evidence mutated during copy');
    const descriptor = Buffer.from(JSON.stringify(profile, null, 2) + '\n');
    const descriptorHandle = await open(join(release, DESCRIPTOR), 'wx');
    try { await descriptorHandle.writeFile(descriptor);await descriptorHandle.sync(); }
    finally { await descriptorHandle.close(); }
    return {schema_version:1,kind:profile.kind,archive_path:ARCHIVE,archive_size_bytes:profile.archive_size_bytes,archive_sha256:profile.archive_sha256,descriptor_path:DESCRIPTOR,descriptor_sha256:hash(descriptor),complete:false};
  } finally { if (output) await output.close();await input.close(); }
  // On failure, leave any create-new partial candidate unqualified for diagnosis.
}

export async function verifyNativeSourceEvidenceFiles(release, manifest, profile) {
  const binding = manifest.native_source_evidence;
  const rows = manifest.release_files ?? [];
  if (!binding) {
    assert(!rows.some(x => [ARCHIVE.toLowerCase(),DESCRIPTOR.toLowerCase()].includes(String(x.path).toLowerCase())), 'Unbound native source evidence');
    release = await physical(release, false);
    for (const name of [ARCHIVE, DESCRIPTOR]) {
      try { await lstat(join(release,name)); }
      catch (error) { if (error.code === 'ENOENT') continue;throw error; }
      assert.fail('Unmanifested native source evidence');
    }
    return {present:false,complete:false};
  }
  profile = profile ? verifyNativeSourceProfile(profile) : await profileDefault();
  keys(binding, ['schema_version','kind','archive_path','archive_size_bytes','archive_sha256','descriptor_path','descriptor_sha256','complete']);
  assert.equal(binding.schema_version,1);assert.equal(binding.kind,profile.kind);assert.equal(binding.complete,false);
  assert.equal(binding.archive_path,ARCHIVE);assert.equal(binding.descriptor_path,DESCRIPTOR);
  assert.equal(binding.archive_sha256,profile.archive_sha256);assert.equal(binding.archive_size_bytes,profile.archive_size_bytes);
  release = await physical(release, false);
  for (const [name, digest, size] of [[ARCHIVE,profile.archive_sha256,profile.archive_size_bytes],[DESCRIPTOR,binding.descriptor_sha256,null]]) {
    assert(/^[a-f0-9]{64}$/.test(digest), 'Invalid native source descriptor digest');
    const matching = rows.filter(x => String(x.path).toLowerCase() === name.toLowerCase());
    assert.equal(matching.length,1,'Missing or duplicate native source inventory');
    const row = matching[0];assert.equal(row.path,name);assert.equal(String(row.sha256).toLowerCase(),digest);
    const path = await physical(join(release,name),true);
    if (size !== null) assert.equal(row.size_bytes,size);
    else assert(Number.isSafeInteger(row.size_bytes) && row.size_bytes>0 && row.size_bytes<=16384);
    const handle = await open(path,'r');
    try { await streamHash(handle,{archive_size_bytes:row.size_bytes,archive_sha256:digest}); }
    finally { await handle.close(); }
  }
  const descriptor = await readFile(join(release,DESCRIPTOR));
  assert.deepEqual(JSON.parse(descriptor.toString('utf8')),profile,'Native source coverage changed');
  return {present:true,complete:false,scope:'Opaque archive bytes/descriptor and release-manifest binding only'};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert.equal(process.argv.length,4,'Expected archive and fresh release directory');
    console.log(JSON.stringify(await stageNativeSourceEvidence(process.argv[2],process.argv[3])));
  } catch (error) { console.error(error.message);process.exitCode=1; }
}
