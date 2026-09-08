#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Transform, Readable } from 'node:stream';
import { spawn } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
export const help = `AgentMemory for Codex on Windows
Usage: agentmemory-codex-windows --install-root <absolute path>
  --workspace-root <absolute path> --project-registry <absolute file>
  [--fresh | --activate-prepared] [--execute] [--archive <local release ZIP>]

Default: verify a proposed existing-install update, without installing it.
--fresh: prepare a new, empty installation. No task or Codex setting changes.
--activate-prepared: register tasks and managed hooks for a prepared installation.
--execute: explicitly perform the selected operation (otherwise dry-run).
--archive: use an offline copy of this version's ZIP; the same SHA-256 is required.
Windows x64, Node.js 24 or newer, and Windows PowerShell 5.1 are required.
Activation needs permission to create managed Codex requirements; run as the
same Windows user who will use Codex. No npm lifecycle scripts are run.
`;

export function parseArgs(args) {
  const result = {};
  const flags = new Set(['fresh', 'activate-prepared', 'execute', 'help']);
  const values = new Set(['install-root', 'workspace-root', 'project-registry', 'archive']);
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, '');
    if (!args[i].startsWith('--') || (!flags.has(key) && !values.has(key))) throw Error(`Unknown option: ${args[i]}`);
    if (Object.hasOwn(result, key)) throw Error(`Repeated option: --${key}`);
    if (flags.has(key)) result[key] = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith('--') || /[\x00-\x1f"]/u.test(value) || !path.win32.isAbsolute(value) || value.startsWith('\\\\')) {
        throw Error(`--${key} requires an absolute local Windows path without control characters or quotes.`);
      }
      result[key] = value;
    }
  }
  if (result.fresh && result['activate-prepared']) throw Error('Choose --fresh or --activate-prepared.');
  if (!result.help) for (const key of ['install-root', 'workspace-root', 'project-registry']) {
    if (!result[key]) throw Error(`Missing --${key}`);
  }
  return result;
}

export function validateDescriptor(d) {
  if (d.schema_version !== 1 || d.product_id !== 'agentmemory-codex-windows' ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(d.version) || !/^[a-f0-9]{40}$/.test(d.source_commit) ||
      !/^[a-f0-9]{64}$/.test(d.archive_sha256) || !/^[a-f0-9]{64}$/.test(d.manifest_sha256) ||
      !Number.isSafeInteger(d.archive_bytes) || d.archive_bytes < 1 || d.archive_bytes > 3 * 1024 ** 3 ||
      d.url !== `https://github.com/M-T-D-N/agentmemory-codex-windows/releases/download/v${d.version}/agentmemory-codex-windows-${d.version}-win32-x64.zip`) {
    throw Error('Invalid pinned release descriptor.');
  }
  return d;
}

export async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function verifyArchive(file, descriptor) {
  if ((await stat(file)).size !== descriptor.archive_bytes || await sha256(file) !== descriptor.archive_sha256) {
    throw Error('Release ZIP integrity mismatch; installation was not started.');
  }
}

export function powershellArgs(script, named) {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    ...Object.entries(named).flatMap(([key, value]) => value === true ? [`-${key}`] : [`-${key}`, value])];
}

export async function runPowerShell(script, named) {
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await new Promise((resolve, reject) => {
    const child = spawn(executable, powershellArgs(script, named), { stdio: 'inherit', windowsHide: true, shell: false, env: powershellEnvironment() });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(Error(`PowerShell failed (${signal || code}).`)));
  });
}

export function powershellEnvironment() {
  return { ...process.env, PSModulePath: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules') };
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) { console.log(help); return; }
  if (process.platform !== 'win32' || process.arch !== 'x64' || Number(process.versions.node.split('.')[0]) < 24) {
    throw Error('This package requires native Windows x64 with Node.js 24 or newer.');
  }
  const descriptor = validateDescriptor(JSON.parse(await readFile(path.join(here, 'release.json'), 'utf8')));
  const scratch = await mkdtemp(path.join(tmpdir(), 'agentmemory-install-'));
  try {
    let archive = options.archive;
    if (!archive) {
      archive = path.join(scratch, 'release.zip');
      console.log(`Downloading AgentMemory ${descriptor.version} (${descriptor.archive_bytes} bytes)…`);
      const response = await fetch(descriptor.url, { signal: AbortSignal.timeout(30 * 60_000) });
      if (!response.ok || !response.body || new URL(response.url).protocol !== 'https:') throw Error(`Release download failed: HTTP ${response.status}`);
      let received = 0;
      const bounded = new Transform({ transform(chunk, _encoding, done) {
        received += chunk.length;
        done(received > descriptor.archive_bytes ? Error('Release download exceeds its pinned size.') : null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), bounded, createWriteStream(archive, { flags: 'wx' }));
    }
    await verifyArchive(archive, descriptor);
    const release = path.join(scratch, 'release');
    await runPowerShell(path.join(here, 'Expand-Release.ps1'), { Archive: archive, Destination: release });
    const manifestPath = path.join(release, 'release-manifest.json');
    if (await sha256(manifestPath) !== descriptor.manifest_sha256) throw Error('Release manifest integrity mismatch.');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (manifest.downstream_version !== descriptor.version || manifest.source_commit !== descriptor.source_commit) throw Error('Release identity mismatch.');
    const installer = manifest.release_files.find(f => f.path === 'Install-WindowsCodex.ps1');
    if (!installer || await sha256(path.join(release, installer.path)) !== installer.sha256.toLowerCase()) throw Error('Installer integrity mismatch.');
    const named = { ReleaseRoot: release, InstallRoot: options['install-root'], WorkspaceRoot: options['workspace-root'],
      ProjectRegistry: options['project-registry'], NodePath: process.execPath };
    if (options.fresh) named.Fresh = true;
    if (options['activate-prepared']) named.ActivatePrepared = true;
    if (options.execute) named.Execute = true;
    await runPowerShell(path.join(release, 'Install-WindowsCodex.ps1'), named);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
