import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { powershellEnvironment } from '../npm/cli.mjs';
import { verifyUserLibraryRecords } from '../verification/distribution-qualification.mjs';

test('Windows PowerShell synthetic product contracts', async t => {
  assert.equal(process.env.AGENTMEMORY_INTEGRATION, '0');
  assert.equal(process.env.AGENTMEMORY_CURATE, '0');
  assert.ok(process.env.AGENTMEMORY_SYNTHETIC_TEST_ROOT);
  for (const name of ['install', 'archive', 'lifecycle', 'user-libvips']) {
    await t.test(name, async t => {
      const root = mkdtempSync(join(process.env.AGENTMEMORY_SYNTHETIC_TEST_ROOT, `ps-${name}-`));
      const executable = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
      const script = fileURLToPath(new URL(`./synthetic-${name}-contracts.ps1`, import.meta.url));
      const args = ['-NoProfile', '-NonInteractive', '-File', script, '-ScratchRoot', root];
      if (name === 'archive') args.push('-NodePath', process.execPath);
      const started = new Date().toISOString();
      const child = spawnSync(executable, args, { timeout: 30000, windowsHide: true,
        env: powershellEnvironment({ ...process.env, TEMP: root, TMP: root, TMPDIR: root }) });
      writeFileSync(join(root, 'stdout.log'), child.stdout ?? Buffer.alloc(0));
      writeFileSync(join(root, 'stderr.log'), child.stderr ?? Buffer.alloc(0));
      writeFileSync(join(root, 'execution.json'), JSON.stringify({ executable, args, started,
        completed: new Date().toISOString(), pid: child.pid, parentPid: process.pid,
        exitCode: child.status, signal: child.signal, errorCode: child.error?.code ?? null }));
      assert.ifError(child.error);
      assert.equal(child.status, 0, `PowerShell ${name} failed; evidence: ${root}`);
      const result = JSON.parse(readFileSync(join(root, `${name}-contracts-result.json`), 'utf8'));
      assert.equal(result.pid, child.pid);
      assert.equal(result.live_gates, '0');
      const expected = { install: 26, archive: 7, lifecycle: 6, 'user-libvips': 10 }[name];
      assert.equal(result.cases.length, expected);
      if (name === 'install') {
        assert.equal(result.child_processes.length,1);
        assert.equal(result.child_processes[0].exit_code,7);
      }
      for (const row of result.cases) await t.test(row.name, () => assert.equal(row.status, 'passed'));
      if (name === 'user-libvips') {
        const records = result.library_binding;
        await t.test('synthetic baseline matches the captured package export and versioned native entry', () => {
          const layout=JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/sharp-win32-x64-0.35.5-layout.json',import.meta.url)),'utf8'));
          const metadata=JSON.parse(layout.package_json.text);
          assert.equal(metadata.name,'@img/sharp-win32-x64'); assert.equal(metadata.version,'0.35.5');
          assert.equal(metadata.exports['./sharp.node'],'./index.cjs');
          const entry=layout.index_cjs.text.trim().match(/^module\.exports = require\('\.\/lib\/([^']+)'\);$/)?.[1];
          assert.equal(entry,`sharp-win32-x64-${metadata.version}.node`);
          assert(layout.native_inventory_entry.path.endsWith('/lib/'+entry));
          assert.equal(JSON.parse(records.provenance).baseline[2].file,entry);
        });
        const verify = x => verifyUserLibraryRecords(x.manifest,x.qualification,Buffer.from(x.descriptor),Buffer.from(x.provenance));
        await t.test('PowerShell-produced provenance binds the real synthetic copied bytes', () => assert.equal(verify(records).length,5));
        for (const [label,mutate] of Object.entries({
          qualification: x => { x.qualification.library_input_digest = '0'.repeat(64); },
          descriptor: x => { x.descriptor += ' '; },
          provenance: x => { x.provenance += ' '; },
          payload: x => { x.manifest.immutable_files.find(f => f.path.endsWith('/lib/libvips-42.dll')).sha256 = '0'.repeat(64); },
          path: x => { x.manifest.custom_libraries.descriptor_path = '../outside.json'; },
          variant: x => { delete x.manifest.distribution_variant; },
        })) await t.test(`custom library manifest refuses ${label} substitution`, () => { const value=structuredClone(records); mutate(value); assert.throws(() => verify(value)); });
        await t.test('official payload verifier reads copied synthetic files and rejects changed DLL bytes', () => {
          const release = join(root,'synthetic-release');
          try {
            for (const file of records.payload_files) {
              const path=join(release,'payload',file.path); mkdirSync(dirname(path),{recursive:true}); writeFileSync(path,Buffer.from(file.bytes,'base64'));
            }
            writeFileSync(join(release,'release-manifest.json'),JSON.stringify(records.manifest));
            const verify = () => {
              const args=[fileURLToPath(new URL('../verification/distribution-qualification.mjs',import.meta.url)),'payload',release];
              const started=new Date().toISOString();
              const child=spawnSync(process.execPath,args,{windowsHide:true,encoding:'utf8',timeout:15000});
              console.log(JSON.stringify({command:[process.execPath,...args],pid:child.pid,parentPid:process.pid,started,completed:new Date().toISOString(),exit:child.status,scope:'synthetic DLL bytes; no native loading'}));
              assert.ifError(child.error); return child;
            };
            assert.equal(verify().status,0);
            const target=join(release,'payload',records.manifest.package_relative_path,'node_modules/@img/sharp-win32-x64/lib/libvips-42.dll');
            const changed=readFileSync(target); changed[0] ^= 1; writeFileSync(target,changed);
            const failed=verify(); assert.equal(failed.status,1); assert.match(failed.stderr,/Custom library file bytes changed/);
          } finally { rmSync(release,{recursive:true,force:true}); }
        });
      }
      if (name !== 'lifecycle') assert.equal(result.fixture_removed, true);
      t.diagnostic(`Raw synthetic receipts retained: ${root}`);
    });
  }
});
