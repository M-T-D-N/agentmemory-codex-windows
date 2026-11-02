# Evaluate AgentMemory for Codex on Windows (agent runbook)

**Published preview.19/r269.** The [fixed Release](https://github.com/M-T-D-N/agentmemory-codex-windows/releases/tag/v0.1.0-preview.19) contains four assets whose public downloads were verified by size and SHA-256. Payload build source: `7e66cd75702222aece989ac1c6be4c73aa004e7d`; tag source: `0d9ec592c127eb4c93479452d191b67b0baf3576` with [successful Windows CI](https://github.com/M-T-D-N/agentmemory-codex-windows/actions/runs/41381747290). This subsequent documentation-only main update and its own CI are separate; see the Release for the separate follow-up commit and CI status. The frozen tag and payload are not rebuilt. See [identities and limits](docs/PREVIEW_19.md).

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

Run on Windows with PowerShell 5.1 or newer, Node.js 24 or newer, and pnpm
`11.25.0`, plus Python 3 on PATH for the HTTP regression tests (CI uses 3.12).
For a published prebuilt installation use the [fixed preview.19 launcher guide](packaging/windows-codex/npm/README.md); upstream installation is not a prerequisite.
For npm 12 remote-TGZ execution, include the command-scoped `--allow-remote=root`
option shown in the current launcher guide; do not change global npm policy.
Source builders must use the downstream-patched iii engine `0.22.1`, rebuilt with the pinned patch and toolchain described in the [operating guide](packaging/windows-codex/README.md#storage-acknowledgement-and-crash-qualification). The unmodified upstream binary does not match the required hash.

Verify that its SHA-256 equals the value in
`packaging/windows-codex/config/third-party-inputs.json`. Stop on any mismatch.

## 2. Verify the source checkout

For cache-only validation and candidate builds, pass `-Offline` to
`Build-WindowsCodex.ps1`. Both frozen dependency preparation and production
deployment then use pnpm `--offline`; missing cached packages fail without
downloading or updating dependencies. All quality checks still run. A generated
candidate remains unqualified until Windows and native operating evidence pass.

For a new build, record its exact clean source commit with `git rev-parse HEAD` and matching manifest/evidence. [Published preview.19](https://github.com/M-T-D-N/agentmemory-codex-windows/releases/tag/v0.1.0-preview.19) is tied to payload source `7e66cd75` and tag `0d9ec592`, not a later main checkout. Historical tags/assets do not qualify a new build.
From the repository root:

```powershell
pnpm install --frozen-lockfile
pnpm run skills:check
pnpm run typecheck
pnpm run build
pnpm test
$env:AGENTMEMORY_INTEGRATION = '0'
$env:AGENTMEMORY_CURATE = '0'
# Explicit task-owned scratch directory; CI uses runner.temp.
$env:AGENTMEMORY_SYNTHETIC_TEST_ROOT = 'D:\Workspace\scratch\agentmemory\YOUR_TASK_ID\contracts'
New-Item -ItemType Directory -Force $env:AGENTMEMORY_SYNTHETIC_TEST_ROOT | Out-Null
$suites = Get-Content -Raw packaging/windows-codex/test-suites.json | ConvertFrom-Json
node --test @($suites.adapter)
if ($LASTEXITCODE -ne 0) { throw 'Adapter synthetic checks failed' }
node --test @($suites.packaging)
if ($LASTEXITCODE -ne 0) { throw 'Packaging synthetic checks failed' }
```

These independent synthetic checks cover bounded hook, launcher, archive,
ownership, lifecycle, recovery-copy, receipt and qualification contracts. They
do not claim equivalence to removed historical tests. PowerShell subprocesses
use the installed Windows PowerShell 5.1 without changing execution policy;
an execution denial is a failed/unverified check, never a skip or bypass.
The builder uses `verification/payload-import-smoke.mjs` for payload export,
syntax and import-safe diagnostics checks; it does not start a worker.
Actual Windows fresh-install/update/restart/failure-recovery evidence and a
confirmed native/Qwen receipt remain mandatory for public qualification.
Synthetic success alone does not authorize publication or certify readiness.

If an access policy blocks a test or source input, preserve its error and leave
that test unverified. Continue independent permitted checks, but do not copy or
read restricted inputs through another route, run a dependent source snapshot,
or represent a skipped test as passed. A diagnostic build does not replace the
complete source, adapter, packaging and Windows scenario qualification.

## 3. Build a release candidate after source verification

Choose a new staging path in the owned AgentMemory task scratch and the exact
verified iii executable. Replace `<task-id>` below with the actual task ID and
the example `r300` with an unused numeric runtime revision; this example does
not reserve or qualify that revision. Run this only when all required inputs
can be accessed and verified:

```powershell
& .\packaging\windows-codex\Build-WindowsCodex.ps1 `
  -OutputDirectory 'D:\Workspace\scratch\agentmemory\<task-id>\candidate' `
  -IiiEnginePath D:\inputs\iii-0.22.1.exe `
  -ScratchDirectory 'D:\Workspace\scratch\agentmemory\<task-id>' `
  -ReleaseRevision r300
```

Expect a folder named
`agentmemory-codex-windows-0.1.0-preview.19`. Its `release-manifest.json` must
identify:

- product `AgentMemory for Codex on Windows`;
- product ID `agentmemory-codex-windows`;
- downstream version `0.1.0-preview.19`;
- AgentMemory compatibility version `0.9.30`; and
- the unused runtime revision selected for this build.

The normal builder produces a release candidate and refuses `-SkipTests`.
Its output still needs the matching Windows scenario matrix, native/Qwen proof
and final distribution verification before publication. The separate
`-DiagnosticOnly -QualificationScript <owned-script>` mode is disposable component
verification; when used with `-SkipTests`, its skipped-test and missing full-source
digest status must remain explicit. It is never a qualified distribution.

## 4. Run installer validation only

Use an owned AgentMemoryCodex installation, workspace root, project registry,
and Node executable. Omit `-Execute`:

```powershell
& 'D:\Workspace\scratch\agentmemory\<task-id>\candidate\agentmemory-codex-windows-0.1.0-preview.19\Install-WindowsCodex.ps1' `
  -ReleaseRoot 'D:\Workspace\scratch\agentmemory\<task-id>\candidate\agentmemory-codex-windows-0.1.0-preview.19' `
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

## 5. Update an owned installation

Use a fresh staging directory and an unused runtime revision in the form
`-ReleaseRevision rN`, replacing N with the unused numeric revision. The example
r300 is not an allocation or an instruction to replace an existing revision.
A public preview version and an internal runtime revision are
different identities; a new public version never permits same-revision replacement.

Run the dry-run against the existing owned InstallRoot and inspect its exact
predecessor, target, hashes, and paths. An approved cutover preserves canonical
data, secrets, task identity, and instance metadata, retains a rollback backup,
and verifies the owned service health. Follow the operating guide for rollback;
do not copy a second data store into the package or overwrite the active runtime.
The historical session-stub recovery/purge migrations are excluded from this
preview; updating does not perform a data migration.

## 6. Understand the tool surface

The compatibility MCP server exposes 58 tools by default. The 8 core tools cover save, recall, consolidate, smart search, sessions, diagnose, lesson save, and reflect.

The supported Windows profile uses authenticated loopback MCP and four managed
Codex hooks. It preserves exact-project writes and provenance, while deliberate
federated reads remain bounded and source-labelled. Optional local Qwen is
loopback-only and graph-scoped; all other LLM functions use the noop provider.

New committed observations wake the existing graph scheduler, but storing a
response does not classify its content as verified. Codex selects durable
decisions through official curation tools. Qwen, when configured and available,
provides optional graph enrichment. With an existing configured Windows LocalAI integration, the adapter may request conditional startup for eligible backlog and releases only a model instance it owns; hosts without that integration use an already running provider.
See the README for timing and the operating guide for host readiness integration.

## Troubleshooting

- Hash mismatch: retain the unexpected input for diagnosis and obtain or rebuild the exact pinned downstream-patched binary. Never change the expected hash to match an unknown binary.
- Build failure: preserve the first relevant error and report the command,
  Node/pnpm versions, and affected file. Do not publish partial output.
- Installer `ready: false` or an exception: do not add `-Execute`; resolve the
  exact ownership, path, manifest, or predecessor problem first.
- Live-service verification: follow the status, authentication, retention, and
  rollback commands in `packaging/windows-codex/README.md` only after explicit
  cutover approval.
