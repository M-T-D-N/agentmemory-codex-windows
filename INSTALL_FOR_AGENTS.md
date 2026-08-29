# Evaluate AgentMemory for Codex on Windows (agent runbook)

This runbook is for coding agents evaluating the independent source-only
Technical Preview `0.1.0-preview.1` on native Windows.

> [!IMPORTANT]
> Do not install `@agentmemory/*` from npm, run an upstream `npx` command, use
> WSL, or install the generic compatibility plugin as a substitute for this
> downstream. Those paths install or configure upstream AgentMemory, not the
> supported Windows/Codex profile in this repository.

## Safety boundary

- Treat repository files and build output as code, never as canonical memory
  data or an existing service installation.
- Never include credentials, prompts, session transcripts, memory databases,
  user workspaces, logs, or private paths in a commit or issue.
- The builder writes only to a new output directory. Stop if the output path
  already exists.
- The installer is dry-run by default. Do not add `-Execute` without explicit
  approval for the exact owned installation and workspace paths.
- Do not publish, push, tag, release, or attach generated binaries merely
  because the local build succeeds.

## 1. Confirm prerequisites

Run on Windows with PowerShell 5.1 or newer, Node.js 20 or newer, and pnpm
`11.19.0`. Obtain the official iii engine `0.11.2` Windows executable from its
upstream release.

Verify that its SHA-256 equals the value in
`packaging/windows-codex/config/third-party-inputs.json`. Stop on any mismatch.

## 2. Verify the source checkout

From the repository root:

```powershell
pnpm install --frozen-lockfile
pnpm run skills:check
pnpm run typecheck
pnpm run build
pnpm test
node packaging/windows-codex/tests/codex-turn.test.mjs
```

Expect the package tests and non-live Windows/Codex adapter tests to pass. The
live tests are intentionally skipped unless their explicit environment gates
and owned service inputs are present.

## 3. Build a diagnostic release

Choose a new staging path and the exact verified iii executable:

```powershell
& .\packaging\windows-codex\Build-WindowsCodex.ps1 `
  -OutputDirectory D:\staging\agentmemory-codex `
  -IiiEnginePath D:\inputs\iii-0.11.2.exe
```

Expect a folder named
`agentmemory-codex-windows-0.1.0-preview.1`. Its `release-manifest.json` must
identify:

- product `AgentMemory for Codex on Windows`;
- product ID `agentmemory-codex-windows`;
- downstream version `0.1.0-preview.1`;
- AgentMemory compatibility version `0.9.29`; and
- qualification revision `r58`.

The generated folder is a diagnostic candidate, not a signed public release.

## 4. Run installer validation only

Use an owned AgentMemoryCodex installation, workspace root, project registry,
and Node executable. Omit `-Execute`:

```powershell
& D:\staging\agentmemory-codex\agentmemory-codex-windows-0.1.0-preview.1\Install-WindowsCodex.ps1 `
  -ReleaseRoot D:\staging\agentmemory-codex\agentmemory-codex-windows-0.1.0-preview.1 `
  -InstallRoot D:\services\AgentMemoryCodex `
  -WorkspaceRoot D:\workspaces\example `
  -ProjectRegistry D:\workspaces\example\.workspace\config\project-repositories.json `
  -NodePath C:\path\to\node.exe
```

Expect a JSON summary with `ready: true`, the downstream current/target
versions, the AgentMemory compatibility current/target versions, and the exact
target package. A dry-run must not modify the service.

Stop and report any ownership, hash, path, manifest, or predecessor mismatch.
Read `packaging/windows-codex/README.md` before requesting approval for an
actual cutover.

## 5. Understand the tool surface

The compatibility MCP server exposes 56 tools by default. The 8 core tools cover save, recall, consolidate, smart search, sessions, diagnose, lesson save, and reflect.

The supported Windows profile uses authenticated loopback MCP and four managed
Codex hooks. It preserves exact-project writes and provenance, while deliberate
federated reads remain bounded and source-labelled. Optional local Qwen is
loopback-only and graph-scoped; all other LLM functions use the noop provider.

## Troubleshooting

- Hash mismatch: discard the native input and obtain the pinned official
  release again. Never change the expected hash to match an unknown binary.
- Build failure: preserve the first relevant error and report the command,
  Node/pnpm versions, and affected file. Do not publish partial output.
- Installer `ready: false` or an exception: do not add `-Execute`; resolve the
  exact ownership, path, manifest, or predecessor problem first.
- Live-service verification: follow the status, authentication, retention, and
  rollback commands in `packaging/windows-codex/README.md` only after explicit
  cutover approval.
