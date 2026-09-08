# AgentMemory for Codex on Windows

[English](README.md) | [한국어 안내](../../READMEs/README.ko-KR.md) | [日本語案内](../../READMEs/README.ja-JP.md)

> [!IMPORTANT]
> This is the source and operating guide for independent downstream Technical
> Preview `0.1.0-preview.2`, based on upstream AgentMemory `v0.9.29`. It is not the
> official upstream repository, an `@agentmemory/*` npm release, or a promise
> of upstream support. Build and evaluate it from source; do not substitute an
> upstream `npx` install for the steps in this guide.

This source contains unreleased reconciliation changes; the public version is
a release baseline, not evidence that this checkout was packaged or installed.
Use an explicit new `-ReleaseRevision` and the exact source identity for each
qualified build. Existing versioned installation targets are not replaced.

This directory is the source authority for the Windows/Codex adapter around the
upstream AgentMemory TypeScript package. The adapter keeps iii-engine,
AgentMemory's official state scopes, and the normal memory, lesson, graph,
audit, and provenance lifecycles. It introduces no secondary database or queue.

The public `r62` baseline and the reconciled source organize supported behavior into
clearer boundaries without changing the upstream-compatible API or data model:

- four managed Codex hooks capture normal main-task prompts and final responses
  while excluding ambient UI, host, fork, and subagent traffic;
- durable writes remain exact-project and provenance-checked, while bounded,
  source-labelled reads may federate relevant context across projects;
- optional Local Qwen remains credential-free, loopback-only, and restricted to
  typed graph extraction. Its graph completions use streamed SSE so long-running
  llama.cpp responses remain live and incomplete streams fail closed; every
  other LLM-backed function receives the noop provider;
- graph derivation, query-index access, canonical persistence, and official
  lifecycle handling are separate code responsibilities. Sixty-four
  rebuildable index shards accelerate project, text, pagination, and bounded
  walk queries. If that derived index is temporarily unavailable, reads return
  an explicitly bounded snapshot instead of launching a non-cancellable full
  graph enumeration; canonical AgentMemory graph scopes remain authoritative;
- graph output, deadlines, retries, parser bounds, relationship endpoints, and
  observation provenance are bounded and fail closed without advancing a
  failed source cursor;
- MCP and REST authentication, observation visibility, hook runtime settings,
  token estimates, and worker pidfile handling each have one shared
  implementation so entrypoints cannot silently drift;
- REST and durable session-start paths call the registered context
  implementation directly, avoiding same-worker iii re-entry while preserving
  the upstream context contract and state stores; and
- session forget and semantic graph persistence share a keyed lifecycle
  boundary, so completed background inference cannot recreate a deleted source
  session or advance its graph cursor after deletion;
- session forget atomically detaches the exact source session and observation
  provenance from the canonical graph. Shared graph records remain, while only
  provenance-free orphan relationships and unreferenced nodes are removed;
- exact graph edge inventory is available as an opt-in query mode with stable
  edge-ID ordering, revision checks, and hydration verification, while the
  existing page-local `edges` response remains compatible;
- session start, observation, completion, forget, eviction, migration, and
  graph dispatch share one per-session lifecycle boundary, so ending an unknown
  or concurrently forgotten session cannot materialize an incomplete row in
  iii's file-backed state store; and
- historical stub repair and purge migrations are not included in this source.
  Use the supported exact-project inspection and recoverable empty-observation
  lifecycle described below; do not replay an old migration against current data.

The detailed failure lessons later in this guide explain why these constraints
exist. They are operational history, not additional product surfaces.

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
- large upstream-compatible CLI and API registration surfaces remain close to
  upstream structure and have not received an independent manual code audit;
  the Windows `codex-turn.mjs` payload deliberately remains self-contained for
  single-file deployment; and
- this remains a Technical Preview, not a general production-readiness claim.

## Preview scope

The preview is intentionally narrow:

- The public downstream release identity is **AgentMemory for Codex on Windows
  `0.1.0-preview.2`**; `agentmemory-codex-windows` is the intended repository
  name.
- Package, API, export, CLI, and MCP compatibility continue to use upstream
  AgentMemory `0.9.29` and the `agentmemory` identifier. These are not the
  downstream release version.
- `r62` identifies the historical public qualification, not a public version
  line or the qualification of this checkout. Each new build uses a fresh numeric
  revision such as `r81`; the builder accepts `r` followed by a positive integer.
- Public source snapshots and generated release-folder names use the downstream
  version.
  The installed runtime directory and CLI still use AgentMemory compatibility
  version `0.9.29` so existing data and integrations are not relabelled.
- Native Windows and Codex are the supported downstream host profile.
- Existing versioned runtime directories are preserved. Build changed contents
  with a fresh internal revision before cutover; the installer refuses a
  different payload at an existing versioned target. Failed cutover restores the
  predecessor configuration. Canonical `data` is never replaced by this workflow.
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
  -IiiEnginePath D:\inputs\iii-0.11.2.exe `
  -ReleaseRevision r81
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
& D:\staging\agentmemory-codex\agentmemory-codex-windows-0.1.0-preview.2\Install-WindowsCodex.ps1 `
  -ReleaseRoot D:\staging\agentmemory-codex\agentmemory-codex-windows-0.1.0-preview.2 `
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
ambient UI, title/fork, and subagent traffic is excluded. Capture requires the
documented Codex `turn_id` on both prompt and Stop events. An assistant response
is accepted only for the most recently accepted normal prompt's turn in the
same project and working directory. Unmatched or missing turn identity fails
closed. Internal requests preserve existing normal session history; only the
automatic `codex_internal_prompt` exclusion can recover on a later normal
Codex prompt, with an audit entry. Other exclusion reasons remain in force.

`memory_sessions` requires `project` (explicit `*` for cross-project reads),
returns newest sessions first, defaults to 20 rows, caps requests at 500, and
returns `total`, `offset`, and `nextOffset`. Excluded sessions may be inspected
only with an exact project and session ID. Listings omit legacy rows without
a usable session ID and project. SessionEnd is a no-op for missing or incomplete
sessions. An explicit SessionStart fills missing identity while preserving
observations and capture policy; known identity is never reassigned.
REST session listings retain the
oldest-first order used by the curation backlog. Oversized curation candidates
are skipped within the existing context budget so a fitting later source can
still be offered with its complete text and provenance.

Durable writes and graph provenance remain exact-project scoped. The legacy
session/observation `POST /agentmemory/forget` apply path is irreversible and does
not reconcile all derived references; do not use it for an unverified cleanup.
Pass `dryRun: true`, an exact `project` and `sessionId`, and optionally a non-empty
`observationIds` array for a read-only content and reference inventory. Empty ID
arrays are rejected rather than expanding to a whole-session deletion. This
preview neither authorizes deletion nor provides a transaction against concurrent
writers. The pinned iii-engine 0.11.2 `state::list_groups` API enumerates every
observation and enriched-chunk bucket, including legacy sessions without IDs and
orphan buckets. A failed scope/read operation fails the preview; it never silently
claims complete coverage. The ID-less session count remains diagnostic metadata.
It does not remove records or create a recovery copy.

Local revision r80 adds recoverable empty-observation actions to this same REST
endpoint (no new MCP tool or REST endpoint). Pass `action: "delete-empty"`, one
exact `project`, `sessionId`, a one-element `observationIds` array, and
`dryRun: true`. Apply with `dryRun: false`, the returned `expectedVersion`, and a
non-empty `reason`. `action: "restore-empty"` uses the same preview/apply contract.
The original observation ID and empty fields remain in the canonical observation
row, with versioned `emptyDeletion` audit metadata; no recovery database, side
queue, original-content copy or session snapshot is created. Ordinary observation
reads and graph inputs hide deleted rows. Restore exposes the same row and ID.

This action only accepts observations with no content in known or unknown fields,
apart from metadata and the empty `assistant_response`/`prompt_submit` labels.
Deletion requires a completed session and completed graph processing, zero
bootstrap/backfill, a valid forward cursor strictly after the target, and a
complete zero-reference inventory. One observation is changed per request.
Cursors remain unchanged; active session counts are recalculated from real rows.
The same-version retry repairs count/search side effects without creating a new
version. Recovery metadata stays protected after restore as well.

The supported single-worker service rebuilds its in-memory protection index from
official observation buckets before registering writers. An exclusive lifecycle
attempt returns a no-change busy result while an ordinary writer is active;
ordinary writes wait during recovery. Source writes reject deleted IDs, old-row
overwrites and permanent deletion of protected observations/sessions are blocked,
and import/mesh/snapshot payloads are checked before application. JSONL replay
skips protected sessions, and eviction/auto-forget retain them. Snapshot restore
reads the requested Git object without changing its working tree before validation.
Legacy migration checks sessions, observations and summaries before writing.

An ambiguous canonical SDK write disables further mutations in that worker.
Verify the engine outcome and restart the worker before retrying; errors explicitly
distinguish a committed change, unknown commit outcome, and a preflight failure.
Search visibility rechecks canonical rows, while index persistence is best effort
and runs after the exclusive interval. Whole-install backups preserve recovery
rows; older workers do not implement their visibility or protection semantics.
Keep a recovery-capable worker with this data when restoring an installation.

The managed user-prompt hook performs
bounded federated recall across projects, boosts the current project, labels
every source project, and treats `*` as a read-only scope. Durable promotion is
performed by the current Codex turn through the official memory,
lesson, and manual graph tools. Local Qwen may add graph entities and relations
only after validating the exact project, session, and observation provenance.
`memory_graph_provenance_reconcile` (and `POST /agentmemory/graph/provenance/reconcile`)
also accepts `action: "retire"` or `"restore"` for exact versioned edge IDs. For
these actions, target `sources` cite the review evidence; the edge's original
supporting observations and sessions stay unchanged. Retirement hides the edge
from active queries, preserves its ID, endpoints, properties, history and original
provenance, and blocks re-creation through manual upsert, typed extraction and
graphify import. An explicit restore requires the current `expectedUpdatedAt`,
live same-project endpoints and valid original provenance. A graph reset/purge
or full-state replacement remains a separate lifecycle; portable temporal/mesh
writers are outside this supported profile. Default `action: "detach"` retains
the existing final-source guard. All actions preflight the whole bounded batch,
audit changes, and report partial storage failures without claiming success.
Summary, consolidation, reflection, crystallization, and automatic compression
stay disabled. Deterministic structural graph extraction remains available
when Qwen is busy or unavailable. The existing local-AI launcher atomically
updates `data/qwen-coordination/qwen-ready.json` after exact owned readiness.
The Windows watcher accepts the final filename and the atomic writer's
`qwen-ready.json.tmp-*`/`.bak-*` filenames, because `fs.watch` may report only
an intermediate rename during `File.Replace`.
That event starts a 15-second stability check and bounded four-batch drains;
full batches may continue after a 30-second cooldown, while a 15-minute probe is
retained only for missed events and AgentMemory restarts. Every batch still
selects the least-recently-serviced project and keeps forward and r30-prefix
backfill cursors separate. Foreground Qwen markers abort background work without
advancing either cursor; malformed graph XML gets one bounded repair attempt.
An explicit invalid citation in a single-observation
local-Qwen response uses that same one-attempt budget to regenerate from the
original observation, then passes through unchanged exact-ID validation. No
prefix matching or citation substitution is performed. After local malformed or
empty output, the existing backlog retries one observation; success restores the
configured batch size. Output-budget and foreground-preemption controls remain
separate. New observations reopen semantic work while preserving both cursors. After extraction, completion is calculated under the observation
lock against the latest official observations, including any tail captured during
the provider request.

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
16. **Ambient-session poisoning:** A single internal host prompt could mark an
    established Codex session capture-excluded and silently suppress later
    normal prompts and final responses. Session-wide exclusion is now limited
    to sessions without normal capture, a later normal prompt reactivates a
    provisional exclusion, and the prompt hook no longer spends its timeout on
    a redundant capture-state lookup.
17. **Idle Qwen polling:** A 30-second runtime probe kept waking the service even
    when Qwen was normally off, while short availability windows still drained
    too little backlog. Exact launcher readiness now emits an advisory file
    event, the worker revalidates the live runtime before bounded draining, and
    a 15-minute probe remains only as a missed-event safety net.
18. **Truncated graph XML:** A real four-observation response opened both XML
    roots but exhausted the 2,048-token output budget before closing
    `relationships`; the repair attempt had the same budget and could not make
    the cursor advance. The Windows graph profile now allows 4,096 output tokens
    and a three-minute background deadline, while schema-only prompting,
    provenance validation, cursor fail-closed behavior, and foreground
    preemption remain unchanged.
19. **Ready-event grace reuse:** Windows delivered every atomic ready-file
    event, but a launcher signal for an already known model fingerprint did not
    restart the stability grace. The drain could therefore overlap the
    launcher's foreground-protection window or be absorbed by an earlier timer.
    Every accepted ready signal now resets the grace timestamp and schedules the
    existing bounded drain after that grace, without adding Qwen polling.
20. **Service-side event loss:** A standalone Windows watcher observed all
    atomic replacement filenames, while the long-lived worker still produced no
    drain on the same launcher event. The ready subscriber now deduplicates by
    final-file mtime and size and adds a five-second metadata-only fallback. It
    does not call the Qwen API, load a model, or replace the 15-minute runtime
    safety probe.
21. **Unknown repair endpoints:** A real single-observation response and its
    repair both emitted a relationship to an entity key absent from the same
    XML output. The parser correctly failed closed but deterministic retries
    could repeat forever. The repair contract now requires both endpoints to
    match emitted entity keys and directs Qwen to omit an ungrounded
    relationship instead of weakening parser validation.
22. **Prompt-only endpoint repair was insufficient:** Live r47 qualification
    showed that Qwen could truncate an entity during repair yet retain one
    relationship to that removed key despite the explicit repair instruction.
    Only the repaired response may now deterministically omit such orphan
    relationships. The initial response remains strict, omitted relationships
    are never persisted, and XML shape, allowed types, provenance, and total
    relationship bounds still fail closed before the semantic cursor advances.
23. **Partial XML parsing was not fail-closed:** Adversarial r48 tests proved
    that prose outside the two roots, malformed property tails, duplicate or
    bare attributes, and unknown XML entities could be ignored while a cursor
    still advanced. The bounded parser now consumes the complete envelope and
    every supported child and attribute exactly once; malformed repaired output
    remains deferred with no semantic cursor advance.
24. **Equal nested deadlines hid provider timeouts:** Live r49 draining showed
    `mem::graph-backlog-step` timing out at the same 180-second boundary as the
    Local-Qwen request, before the provider failure could return and enter the
    existing single-observation retry path. Only the two internal graph trigger
    calls now receive bounded 30-second layers of headroom; the provider
    deadline, fail-closed parser, cursor rules, and every non-graph invocation
    remain unchanged.

Historical Codex approval-assessment envelopes (both initial and delta forms)
are consumed by graph replay without deriving nodes or relationships. Their
original observations and chronological cursors remain intact. The official
extraction audit records exact excluded IDs and `processingCompleted`; an
internal-only batch reports `semanticCompleted=false` and makes no provider call.
Normal observations in a mixed batch retain strict, separately filtered citation
validation. New hook capture skips both envelope forms without excluding the
normal user session.

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
