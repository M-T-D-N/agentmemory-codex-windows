import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/sh';
const fakeSecret = 'synthetic-first-boot-secret-20261015';
for (const platform of ['fly', 'render', 'railway', 'coolify']) {
  test(`${platform} first boot preserves secret without logging it; restart reuses it`, async () => {
    const source = await readFile(new URL(`../../../deploy/${platform}/entrypoint.sh`, import.meta.url), 'utf8');
    const start = source.indexOf('if [ ! -s "$HMAC_FILE" ]; then');
    const end = source.indexOf('export AGENTMEMORY_SECRET', start);
    assert(start >= 0 && end > start, 'First-boot secret region is missing');
    const region = source.slice(start, end + 'export AGENTMEMORY_SECRET'.length);
    const root = await mkdtemp(join(tmpdir(), 'am-cloud-secret-'));
    try {
      const script = `set -eu\nHMAC_FILE="$1/secret"\nRUN_AS=synthetic\nchown() { :; }\nopenssl() { printf '%s' '${fakeSecret}'; }\n${region}\n[ "$AGENTMEMORY_SECRET" = '${fakeSecret}' ]\n`;
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = spawnSync(shell, ['-c', script, 'first-boot-fixture', root.replaceAll('\\', '/')], { encoding: 'utf8', timeout: 5000, windowsHide: true });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        assert(!result.stdout.includes(fakeSecret));
        assert(!result.stderr.includes(fakeSecret));
        assert.equal((await readFile(join(root, 'secret'), 'utf8')).trim(), fakeSecret);
        assert.equal(result.stdout.includes('generated HMAC secret'), attempt === 0);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
