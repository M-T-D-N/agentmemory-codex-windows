import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, mkdtempSync, copyFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../../../', import.meta.url));
const built = join(source, 'dist/providers/index.mjs');
const metadata = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));

test('actual built optional SDK loading, isolated synthetic modules without resolver mocks', async (t) => {
  assert.equal(process.env.AGENTMEMORY_INTEGRATION, '0');
  assert.equal(process.env.AGENTMEMORY_CURATE, '0');
  const temp = process.env.AGENTMEMORY_SYNTHETIC_TEST_ROOT;
  assert.ok(temp);
  const root = mkdtempSync(join(temp, 'sdk-bundle-'));
  const fixture = (name) => {
    const base = join(root, name);
    mkdirSync(join(base, 'dist/providers'), { recursive: true });
    mkdirSync(join(base, 'home'), { recursive: true });
    copyFileSync(built, join(base, 'dist/providers/index.mjs'));
    for (const name of Object.keys(metadata.dependencies)) {
      assert.notEqual(name, '@anthropic-ai/claude-agent-sdk');
      const target = join(base, 'node_modules', name);
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(resolve(source, 'node_modules', name), target, 'junction');
    }
    return base;
  };
  const sdk = (base, result, version = '0.3.296') => {
    const dir = join(base, 'node_modules/@anthropic-ai/claude-agent-sdk');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version, type: 'module', exports: './sdk.mjs' }));
    writeFileSync(join(dir, 'sdk.mjs'), `export async function* query() { yield {type:'result',result:${JSON.stringify(result)}}; }`);
  };
  const run = (base, code) => {
    const started = new Date().toISOString();
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `import assert from 'node:assert/strict'; import {createProvider} from './dist/providers/index.mjs'; ${code}`], {
      cwd: base, encoding: 'utf8', timeout: 15000, windowsHide: true,
      env: { ...process.env, HOME: join(base, 'home'), USERPROFILE: join(base, 'home'),
        AGENTMEMORY_LOCAL_QWEN_COORDINATION_DIR: join(base, 'home') },
    });
    console.log(JSON.stringify({ pid: child.pid, parent_pid: process.pid, started, completed: new Date().toISOString(), cwd: base, entry: 'dist/providers/index.mjs', status: child.status, scope: 'synthetic provider child; no model request' }));
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
  };
  const requested = `createProvider({provider:'agent-sdk', model:'synthetic',maxTokens:100}).summarize('synthetic','synthetic')`;
  try {
    await t.test('absent SDK leaves noop and local-qwen available, explicit SDK fails', () => {
      const base = fixture('absent');
      run(base, `const n=createProvider({provider:'noop',model:'noop',maxTokens:100}); assert.equal(await n.summarize('s','u'),''); assert.equal(createProvider({provider:'local-qwen',model:'synthetic',maxTokens:100}).name,'local-qwen'); await assert.rejects(${requested},/agent_sdk_optional_provider_unavailable/);`);
    });
    await t.test('portable peer resolves from the copied dist location', () => {
      const base = fixture('peer'); sdk(base, 'synthetic-peer');
      run(base, `assert.equal(await ${requested},'synthetic-peer');`);
    });
    await t.test('owned extension wins over an available portable peer', () => {
      const base = fixture('extension'); sdk(base, 'synthetic-peer');
      sdk(join(base, 'home/.agentmemory/extensions/agent-sdk'), 'synthetic-extension');
      run(base, `assert.equal(await ${requested},'synthetic-extension');`);
    });
    await t.test('invalid extension cannot fall back to a valid portable peer', () => {
      const base = fixture('bad-extension'); sdk(base, 'synthetic-peer');
      sdk(join(base, 'home/.agentmemory/extensions/agent-sdk'), 'synthetic-invalid', '0.1.0');
      run(base, `await assert.rejects(${requested},/unsupported_package_or_version/);`);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
