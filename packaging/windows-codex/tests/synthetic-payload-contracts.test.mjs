import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { smokePayload } from '../verification/payload-import-smoke.mjs';

test('payload metadata and absent exports cannot pass import smoke', async () => {
  assert.ok(process.env.AGENTMEMORY_SYNTHETIC_TEST_ROOT);
  const source = fileURLToPath(new URL('../../../', import.meta.url));
  const root = await mkdtemp(join(process.env.AGENTMEMORY_SYNTHETIC_TEST_ROOT, 'payload-'));
  try {
    const metadata = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    await writeFile(join(root, 'package.json'), JSON.stringify({ ...metadata, version: '0.0.0-synthetic' }));
    await assert.rejects(smokePayload(root, source));
    await writeFile(join(root, 'package.json'), JSON.stringify(metadata));
    await assert.rejects(smokePayload(root, source));
  } finally { await rm(root, { recursive: true, force: true }); }
});
