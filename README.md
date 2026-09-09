# AgentMemory for Codex on Windows

Independent, Windows-native AgentMemory downstream for OpenAI Codex Desktop
and Codex CLI.

[English](README.md) | [한국어](READMEs/README.ko-KR.md) | [日本語](READMEs/README.ja-JP.md)

<p align="center">
  <a href="https://github.com/M-T-D-N/agentmemory-codex-windows/actions/workflows/ci.yml"><img src="https://github.com/M-T-D-N/agentmemory-codex-windows/actions/workflows/ci.yml/badge.svg" alt="Windows CI" /></a>
  <img src="https://img.shields.io/badge/release-0.1.0--preview.4-orange" alt="0.1.0-preview.5" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="Apache-2.0" /></a>
</p>

> [!IMPORTANT]
> This is an independent Technical Preview. It is based on
> [AgentMemory](https://github.com/rohitg00/agentmemory) `v0.9.29`, but it is
> not the official upstream repository, an `@agentmemory/*` npm release, or a
> promise of upstream support. Do not use an upstream `npx` command or the
> compatibility plugin manifests as a substitute for the Windows build and
> installer described here.

Development note: this downstream is AI-generated and user-tested; [read the
full disclosure](#ai-development-disclosure).

## What this preview does

AgentMemory preserves useful context across Codex tasks while keeping the
official AgentMemory memory, lesson, graph, audit, and provenance stores as the
only canonical stores.

- Captures normal main-agent user prompts and final assistant responses through
  four managed Codex hooks: `SessionStart`, `UserPromptSubmit`, `Stop`, and
  `SessionEnd`.
- Excludes ambient UI, title/fork traffic, known internal host prompts, and
  subagent traffic from durable capture.
- Keeps writes, deletion, curation, and provenance exact-project scoped.
- Supports audited, target-scoped live graph provenance correction with dry-run
  previews. Manual graph writes with multiple source groups must map every node
  and edge through zero-based `sourceIndexes`, or explicitly opt into shared
  provenance with `sharedSources: true`.
- Supports audited recovery of proven empty observations through the existing
  REST forget endpoint, with exact IDs, version checks and preserved graph cursors.
- Supports bounded, source-labelled federated recall across projects without
  allowing wildcard writes.
- Can use a credential-free, loopback-only local Qwen worker for typed graph
  extraction. Every other AgentMemory LLM feature receives the noop provider;
  external fallbacks remain disabled.
- Uses an authenticated loopback MCP endpoint for Codex and retains a packaged
  stdio launcher only as a compatibility path.

The upstream-compatible source surface contains 57 MCP tools. Its MCP surface
is 57 tools, 6 resources, and 3 prompts; it also has 134 endpoints on port 3111,
12 portable hooks, and 17 skills. The supported Windows profile intentionally
activates only the four managed hooks listed above.

For audits, MCP `memory_recall`, `memory_smart_search`, and `memory_timeline`
accept `trackAccess: false` to avoid access-count reinforcement. The default
remains true; visibility, project boundaries, and recovery guards still apply.
Graph query shards are rebuildable indexes in the same iii StateModule as the
canonical graph. Missing or dirty indexes use a bounded snapshot with a warning;
only an explicit snapshot rebuild refreshes them.

Release changes are recorded in [CHANGELOG.md](CHANGELOG.md). Source tags
identify public releases; each build manifest records its own qualification.

## When the graph updates

1. The managed hooks store eligible conversation turns as observations. A new
   committed observation wakes the existing graph backlog scheduler; rejected or
   duplicate observations do not. A wake failure leaves the observation intact.
2. The current Codex model selects reusable decisions and verified fixes through
   official memory, lesson, and graph curation tools with source provenance.
   Storing a final answer alone does not mark it as a verified decision.
3. If the optional local Qwen graph provider is configured and available, the
   scheduler enriches the graph in bounded batches. Runtime readiness must be
   stable for 15 seconds; an observation wake reuses an already stable runtime
   without restarting that wait. Drains run up to four batches, with a 30-second
   cooldown before continuing full drains. A 15-minute probe covers
   missed wakes and restarts. Foreground Qwen work can defer extraction without
   advancing the cursor.

AgentMemory probes the provider; it does not start Qwen itself. A separately
configured host launcher can start Qwen on demand using its own manual-hold,
resource-budget, and process-ownership rules. This repository does not ship
that host policy or prescribe a universal GPU/RAM threshold. Provider-free
manual curation and deterministic structural extraction remain available.

See the [operating guide](packaging/windows-codex/README.md) for readiness
coordination, cursor recovery, and provider limits.

## Version identities

| Identity | Value | Meaning |
|---|---:|---|
| Downstream release | `0.1.0-preview.5` | Public version and source tag |
| AgentMemory compatibility | `0.9.29` | CLI, MCP, package, API, export, and installed-runtime compatibility |
| Qualification revision | Build manifest | Internal build provenance, not a public version line |
| iii engine | `0.11.2` | Pinned native runtime input, verified by SHA-256 during the build |

The exact upstream tag, commit, tree, and pristine package hash are recorded in
[`upstream-source.json`](upstream-source.json).

## Install without building

After the preview.4 npm package and matching GitHub ZIP are published, use the
[pinned npm/npx installation guide](packaging/windows-codex/npm/README.md).
It covers empty-root preparation, separate activation, existing-install updates,
and offline hash verification. Users need Windows x64, Node.js 24+, and Codex;
pnpm, Python, and compilers are only needed by source builders.

## Source-build requirements

- Windows with PowerShell 5.1 or newer; this preview is qualified on Windows 11
- Node.js 20 or newer
- Python 3 on PATH for the plaintext HTTP regression tests (CI uses Python 3.12)
- pnpm `11.19.0` through the repository's pinned package-manager declaration
- The official iii engine `0.11.2` Windows executable whose SHA-256 matches
  [`packaging/windows-codex/config/third-party-inputs.json`](packaging/windows-codex/config/third-party-inputs.json)

The npm launcher uses a prebuilt release ZIP. The binaries are not Authenticode-signed;
the pinned npm descriptor, ZIP SHA-256 and per-file manifest provide integrity checks.

## Build and evaluate from source

Clone the repository on Windows, then run the release builder from PowerShell.
The output directory must not already exist.

```powershell
git clone --branch v0.1.0-preview.5 https://github.com/M-T-D-N/agentmemory-codex-windows.git
Set-Location agentmemory-codex-windows

& .\packaging\windows-codex\Build-WindowsCodex.ps1 `
  -OutputDirectory D:\staging\agentmemory-codex `
  -IiiEnginePath D:\inputs\iii-0.11.2.exe `
  -ReleaseRevision r83
```

The normal builder verifies the pinned native input, restores the frozen lock,
checks generated skills, type-checks, builds, runs the package and Codex adapter
tests, creates a production dependency tree, and writes a complete immutable
file manifest.

The installer is dry-run by default. It validates release hashes, ownership,
paths, and the existing installation before changing anything. Review the exact
build, dry-run, cutover, rollback, retention, and authentication contract in
[`packaging/windows-codex/README.md`](packaging/windows-codex/README.md) before
using `-Execute`.

> [!WARNING]
> The Windows installer is designed for an owned, managed AgentMemoryCodex
> service layout. Do not point it at an unrelated directory or treat build
> output as user data. Canonical `data`, secrets, logs, task identity, and
> rollback state have independent lifecycles.

## Updating an existing installation

Check out the release tag into a source checkout and use a fresh staging directory.
Choose a new `-ReleaseRevision rN` that is not already installed; `r83` in the
examples is a build label, not permission to overwrite an existing r83 runtime.
Run the installer dry-run against the same owned installation, review the exact
predecessor and target, and follow the approved cutover and rollback procedure.
Canonical data, secrets, and instance metadata stay in the installation. Do not
copy data into the source tree or invoke the historical one-off session-stub
migrations removed from this preview. See [the agent runbook](INSTALL_FOR_AGENTS.md).

## Privacy and security boundaries

- MCP and service traffic stay on authenticated loopback endpoints in the
  supported profile.
- The optional Qwen provider accepts only credential-free loopback HTTP and is
  capability-scoped to graph extraction.
- The source tree contains no memory database, session transcript, user export,
  API key, generated installer, or private development history.
- Security reports should use GitHub's private vulnerability reporting flow;
  see [`SECURITY.md`](SECURITY.md).

## Repository map

| Path | Purpose |
|---|---|
| `src/` | AgentMemory compatibility source |
| `packaging/windows-codex/` | Supported Windows/Codex adapter, builder, installer, and tests |
| `plugin/` | Upstream-compatible plugin assets bundled into the source build; not the supported installation path |
| `test/` | Unit and security regression tests |
| `benchmark/`, `eval/` | Upstream-derived harnesses and historical reference results; not Windows preview qualification |
| `integrations/` | Compatibility integrations; not separately supported downstream products |
| `upstream-source.json` | Exact upstream provenance |

The upstream marketing website, cloud deployment examples, other upstream language copies,
generated build output, and private monorepo history are intentionally outside
the first public repository snapshot. Historical benchmark material is retained
only for reproducibility and is explicitly labelled as upstream reference; no
benchmark number in those directories is a claim for this downstream preview.

## Development checks

```powershell
pnpm install --frozen-lockfile
pnpm run skills:check
pnpm run typecheck
pnpm run build
pnpm test
node packaging/windows-codex/tests/codex-turn.test.mjs
```

The repository is marked `private` in package manifests to prevent accidental
publication under upstream `@agentmemory/*` package names. Contributions should
follow [`CONTRIBUTING.md`](CONTRIBUTING.md), and the downstream release history
is in [`CHANGELOG.md`](CHANGELOG.md).

## AI development disclosure

Most downstream modifications were generated and revised by OpenAI Codex from
user-provided requirements and iterative acceptance requests. The repository
owner did not manually review the source code. Validation is based on automated
tests and live functional testing in the owner's Windows/Codex environment. No
independent third-party code or security audit has been performed.

**In short:** AI-generated, user-tested, not manually code-reviewed.

## Upstream attribution and license

This downstream is based on AgentMemory by Rohit Ghumare and contributors. See
[`NOTICE`](NOTICE) and [`upstream-source.json`](upstream-source.json) for the
attribution and exact source identity. The code is provided under the
[Apache License 2.0](LICENSE).
