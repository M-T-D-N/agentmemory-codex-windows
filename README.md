# AgentMemory for Codex on Windows

Independent, Windows-native AgentMemory downstream for OpenAI Codex Desktop
and Codex CLI.

[English](README.md) | [한국어](READMEs/README.ko-KR.md) | [日本語](READMEs/README.ja-JP.md)

<p align="center">
  <a href="https://github.com/M-T-D-N/agentmemory-codex-windows/actions/workflows/ci.yml"><img src="https://github.com/M-T-D-N/agentmemory-codex-windows/actions/workflows/ci.yml/badge.svg" alt="Windows CI" /></a>
  <img src="https://img.shields.io/badge/release-0.1.0--preview.1-orange" alt="0.1.0-preview.1" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="Apache-2.0" /></a>
</p>

> [!IMPORTANT]
> This is an independent source-only Technical Preview. It is based on
> [AgentMemory](https://github.com/rohitg00/agentmemory) `v0.9.29`, but it is
> not the official upstream repository, an `@agentmemory/*` npm release, or a
> promise of upstream support. Do not use an upstream `npx` command or the
> compatibility plugin manifests as a substitute for the Windows build and
> installer described here.

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
- Supports bounded, source-labelled federated recall across projects without
  allowing wildcard writes.
- Can use a credential-free, loopback-only local Qwen worker for typed graph
  extraction. Every other AgentMemory LLM feature receives the noop provider;
  external fallbacks remain disabled.
- Uses an authenticated loopback MCP endpoint for Codex and retains a packaged
  stdio launcher only as a compatibility path.

The upstream-compatible source surface contains 56 MCP tools. Its MCP surface
is 56 tools, 6 resources, and 3 prompts; it also has 133 endpoints on port 3111,
12 portable hooks, and 17 skills. The supported Windows profile intentionally
activates only the four managed hooks listed above.

## Version identities

| Identity | Value | Meaning |
|---|---:|---|
| Downstream release | `0.1.0-preview.1` | Public version and future source tag |
| AgentMemory compatibility | `0.9.29` | CLI, MCP, package, API, export, and installed-runtime compatibility |
| Qualification revision | `r32` | Internal build provenance, not a public version line |
| iii engine | `0.11.2` | Pinned native runtime input, verified by SHA-256 during the build |

The exact upstream tag, commit, tree, and pristine package hash are recorded in
[`upstream-source.json`](upstream-source.json).

## Requirements

- Windows with PowerShell 5.1 or newer; this preview is qualified on Windows 11
- Node.js 20 or newer
- pnpm `11.19.0` through the repository's pinned package-manager declaration
- The official iii engine `0.11.2` Windows executable whose SHA-256 matches
  [`packaging/windows-codex/config/third-party-inputs.json`](packaging/windows-codex/config/third-party-inputs.json)

No prebuilt or signed installer is attached to the first source preview.

## Build and evaluate from source

Clone the repository on Windows, then run the release builder from PowerShell.
The output directory must not already exist.

```powershell
git clone https://github.com/M-T-D-N/agentmemory-codex-windows.git
Set-Location agentmemory-codex-windows

& .\packaging\windows-codex\Build-WindowsCodex.ps1 `
  -OutputDirectory D:\staging\agentmemory-codex `
  -IiiEnginePath D:\inputs\iii-0.11.2.exe
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

## Upstream attribution and license

This downstream is based on AgentMemory by Rohit Ghumare and contributors. See
[`NOTICE`](NOTICE) and [`upstream-source.json`](upstream-source.json) for the
attribution and exact source identity. The code is provided under the
[Apache License 2.0](LICENSE).
