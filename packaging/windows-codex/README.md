# AgentMemory for Codex on Windows

[English](README.md) | [한국어 안내](../../READMEs/README.ko-KR.md) | [日本語案内](../../READMEs/README.ja-JP.md)

> [!IMPORTANT]
> This is the source and operating guide for independent downstream Technical
> Preview `0.1.0-preview.1`, based on upstream AgentMemory `v0.9.29`. It is not the
> official upstream repository, an `@agentmemory/*` npm release, or a promise
> of upstream support. Build and evaluate it from source; do not substitute an
> upstream `npx` install for the steps in this guide.

This directory is the source authority for the Windows/Codex adapter around the
upstream AgentMemory TypeScript package. The adapter keeps iii-engine,
AgentMemory's official state scopes, and the normal memory/lesson/graph
lifecycle. It does not introduce another database or queue. Revision r32 keeps
the loopback-only, graph-scoped local-Qwen provider, adds bounded fair recovery
of deferred graph batches, and federates relevant read context across projects;
every other LLM-backed function continues to receive the noop provider.

## AI development disclosure and validation limits

Most downstream modifications were generated and revised by OpenAI Codex from
user-provided requirements and iterative acceptance requests. The repository
owner did not manually review the source code. Validation is based on automated
tests and live functional testing in the owner's Windows/Codex environment; no
independent third-party code or security audit has been performed.

The current evidence is deliberately narrower than a production guarantee:

- qualification was performed primarily on the owner's Windows 11 and Codex
  configuration, not every supported Windows release or Codex configuration;
- automated tests and selected live flows cover the supported profile, but not
  every destructive, mesh, bridge, import, or export path against real user
  data;
- local-Qwen graph output is provenance-checked derived information, not a
  source of truth;
- provider-backed summary, consolidation, reflection, crystallization, and
  compression are intentionally disabled in the supported profile;
- upstream updates require source-level review and renewed qualification;
- `src/functions/graph.ts` and the Windows `codex-turn.mjs` adapter remain
  candidates for limited medium-term refactoring; and
- this remains a Technical Preview, not a general production-readiness claim.

## Preview scope

The preview is intentionally narrow:

- The public downstream release identity is **AgentMemory for Codex on Windows
  `0.1.0-preview.1`**; `agentmemory-codex-windows` is the intended repository
  name.
- Package, API, export, CLI, and MCP compatibility continue to use upstream
  AgentMemory `0.9.29` and the `agentmemory` identifier. These are not the
  downstream release version.
- `r32` is internal qualification provenance, not a public version line.
- Source tags and generated release-folder names use the downstream version.
  The installed runtime directory and CLI still use AgentMemory compatibility
  version `0.9.29` so existing data and integrations are not relabelled.
- Native Windows and Codex are the supported downstream host profile.
- Existing AgentMemory memory, lesson, graph, audit, and provenance stores stay
  authoritative.
- Local Qwen is optional and capability-scoped to typed graph extraction over
  credential-free loopback HTTP.
- External fallback providers, provider-backed summaries, consolidation,
  reflection, crystallization, and automatic compression remain disabled.
- Build output, install state, canonical memory data, and user workspaces are
  separate lifecycles and must not replace one another.
- GitHub publication, tags, releases, installers, and npm publication are not
  implied by a successful local build.

For Korean readers, the
[Korean README](../../READMEs/README.ko-KR.md) summarizes the product boundary
and this preview contract. This English file remains authoritative for build,
installation, security, retention, and rollback commands.

## Source and generated boundaries

- `hooks/`, `node/`, `powershell/`, `launcher/`, and `config/` are source.
- `Build-WindowsCodex.ps1` generates `dist/`, source maps, types, plugin assets,
  a portable production dependency tree, the hidden launcher, and a complete
  immutable-file manifest in a new staging directory.
- `data/`, `home/`, `logs/`, DPAPI secrets, owner markers, task registrations,
  install state, and backups are installation data. They are never build inputs
  or payload replacements.
- `hook-spec.json` is the single source for the four managed Codex lifecycle
  hooks. The installer renders both the installed TOML and the JSON diagnostic
  view from that spec.

## Build

Run from Windows PowerShell 5.1 or newer. The output directory must not exist.

```powershell
& .\packaging\windows-codex\Build-WindowsCodex.ps1 `
  -OutputDirectory D:\staging\agentmemory-codex `
  -IiiEnginePath D:\inputs\iii-0.11.2.exe
```

The normal build uses the pinned `pnpm-lock.yaml`, runs the existing skill
consistency check, package tests, Codex hook tests, a single TypeScript build,
`pnpm deploy --prod`, and a public index/CLI/MCP/source-map parity smoke. `-SkipTests` is only for local iteration; it is not a
release qualification.

## Existing-install cutover

The installer supports an owned existing installation. Without `-Execute` it
only validates release hashes, owner/manifest identity, exact paths, and the
managed Codex requirements predecessor.

```powershell
& D:\staging\agentmemory-codex\agentmemory-codex-windows-0.1.0-preview.1\Install-WindowsCodex.ps1 `
  -ReleaseRoot D:\staging\agentmemory-codex\agentmemory-codex-windows-0.1.0-preview.1 `
  -InstallRoot D:\services\AgentMemoryCodex `
  -WorkspaceRoot D:\workspaces\example `
  -ProjectRegistry D:\workspaces\example\.workspace\config\project-repositories.json `
  -NodePath C:\path\to\node.exe
```

Copy `config/codex-workspace.example.json` and replace its two example paths
with the same workspace root and project registry passed to the installer.

Add `-Execute` only for an approved cutover. The installer gracefully stops the
owned runtime, retains a rollback backup, copies only immutable code/config,
preserves canonical data and instance metadata, keeps the existing task
identity and working directory, restarts the owned tasks, and requires the
normal status path to become healthy. It never runs a standard reinstall inside
the live runtime and never migrates or deletes canonical data.

The Codex deployment sets `AGENTMEMORY_FORCE_PROXY=true`, provider
`local-qwen`, capability `graph`, and fallback providers `none`. The provider
accepts only credential-free loopback HTTP and discovers the active model and
context on every graph call instead of pinning either value. Its input budget
automatically grows or shrinks with the discovered context while retaining a
20% context reserve. MCP calls cannot silently mutate the
standalone local fallback store and no external LLM is used.

The active Codex registration uses authenticated Streamable HTTP at
`http://127.0.0.1:3114/mcp`. The existing AgentMemory worker owns that listener,
so Codex tasks share one MCP process instead of starting a launcher and Node
shim per task. Local OAuth uses dynamic client registration, S256 PKCE, and an
explicit browser consent page. Its bearer token is domain-separated from the
DPAPI-protected backend secret; unauthenticated MCP requests fail closed. The
hidden stdio launcher remains packaged as a compatibility path for other MCP
clients.

## Active operating profile

The installed profile uses four managed hooks: `SessionStart`,
`UserPromptSubmit`, `Stop`, and `SessionEnd`. Normal main-agent user prompts and
final assistant responses enter the official session/observation lifecycle;
ambient UI, title/fork, and subagent traffic is excluded. Writes, deletion, and
provenance remain exact-project scoped. The managed user-prompt hook performs
bounded federated recall across projects, boosts the current project, labels
every source project, and treats `*` as a read-only scope. Durable promotion is
performed by the current Codex turn through the official memory,
lesson, and manual graph tools. Local Qwen may add graph entities and relations
only after validating the exact project, session, and observation provenance.
Summary, consolidation, reflection, crystallization, and automatic compression
stay disabled. Deterministic structural graph extraction remains available
when Qwen is busy or unavailable. A single background scheduler waits for a
stable Qwen runtime, processes at most one oldest project batch per tick, and
keeps forward and r30-prefix backfill cursors separate. Foreground Qwen markers
abort background work without advancing either cursor; malformed graph XML gets
one bounded repair attempt.

## Failure history and lessons

The following condensed history records failure modes that materially changed
the supported profile. It does not reproduce private session logs or imply that
every lesson was extracted automatically by AgentMemory.

1. **Lifecycle integration:** Hooks and configuration alone did not prove that
   the adapter and backend lifecycle worked end to end. Qualification now uses
   an actual session → observation → recall path.
2. **New-session OAuth:** An HTTP/OAuth transition left authentication
   incomplete, and optional MCP registration silently produced zero tools in a
   new Codex task. Authentication changes are now checked in a completely new
   task with callable tools and real CRUD.
3. **Expired consent:** Reusing a one-time OAuth consent URL repeatedly failed.
   Each authorization attempt must use newly issued consent.
4. **Tool-surface checks:** Static tool lists were confused with Codex's lazy
   callable surface. Qualification distinguishes listing errors from genuine
   authentication failures and invokes the real functions.
5. **MCP proxy fidelity:** Special proxy handling risked dropping `project`,
   `expandIds`, or audit filters and could report false success through a local
   fallback. The proxy now preserves official-server arguments and fails closed.
6. **Graph completeness:** A small graph and an over-broad internal-prompt filter
   hid eligible history. Coverage checks now reconcile the eligible-session
   ledger with source observations and detect omissions, duplicates, and orphan
   relations.
7. **New projects:** A fixed project list missed newly created projects. New
   projects are discovered, separated, and resolved to registered canonical
   project IDs.
8. **Subagent contamination:** Treating subagent transcripts as main-session
   evidence inflated the graph and distorted user intent. Raw subagent traffic
   is excluded; only results delivered into the main task are eligible there.
9. **Over-broad Qwen enablement:** Enabling a general provider also activated
   summaries, consolidation, and reflection and competed for the single local
   Qwen slot. The `local-qwen` provider is capability-scoped to graph extraction.
10. **Pinned model assumptions:** Hard-coding a model name and 128K context made
    model changes require repackaging. Model identity is diagnostic only; API,
    context, and schema capabilities are discovered at runtime.
11. **Cross-project recall:** Existing graph data from another project was not
    automatically visible in the current project, and deferred sessions
    remained. Writes stay exact-project while reads use bounded, source-labelled
    federated recall.
12. **Fair scheduling:** Equal oldest timestamps repeatedly selected the same
    project. Scheduling now uses project-level last-service time and verifies
    actual rotation.
13. **Foreground contention:** A background Qwen job could advance its cursor
    before yielding to a foreground request, risking skipped data. Foreground
    work aborts the background job without advancing its cursor.
14. **Immutable releases:** A live check after the r31 installation found the
    scheduling bias. The installed revision was not overwritten; the correction
    was packaged and qualified as r32.
15. **Large indexes:** Parallel writes of large BM25 shards with short timeouts
    destabilized the worker. Shard writes are serialized and bounded timeouts
    are sized for the actual index.

## Release retention and cleanup

Keep the active package, the immediately preceding rollback package, the
pristine upstream source archive, and the final qualification artifact for the
active and rollback revisions. Keep canonical `data/`, current `logs/`,
`home/`, DPAPI secrets, owner metadata, task identity, and active manifests
independently of release cleanup.

Older packages, duplicate release backups, failed staging artifacts, and
superseded inactive capture candidates may be removed only after resolving each
exact path, rejecting reparse targets, and confirming that the active manifest,
task commands, and owned processes do not reference them. Cleanup is an
explicit maintenance action, not a new runtime gate or a reason to rewrite
canonical data.
