# AgentMemory for Codex on Windows

[English](README.md) | [한국어 안내](../../READMEs/README.ko-KR.md) | [日本語案内](../../READMEs/README.ja-JP.md)

> [!IMPORTANT]
> This is the source and operating guide for independent downstream Technical
> Preview `0.1.0-preview.10`, based on upstream AgentMemory `v0.9.29`. It is not the
> official upstream repository, an `@agentmemory/*` npm release, or a promise
> of upstream support. Use this downstream
> npm launcher or source builder; an upstream `npx` command installs a different product.

This public version identifies the source and independently packaged downstream launcher. Each generated package and
installed runtime has its own qualification and installation evidence.
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
  the Windows hook and its shared project resolver ship together through the
  managed payload manifest; and
- this remains a Technical Preview, not a general production-readiness claim.

## Preview scope

The preview is intentionally narrow:

- The public downstream release identity is **AgentMemory for Codex on Windows
  `0.1.0-preview.10`**; `agentmemory-codex-windows` is the intended repository
  name.
- Package, API, export, CLI, and MCP compatibility continue to use upstream
  AgentMemory `0.9.29` and the `agentmemory` identifier. These are not the
  downstream release version.
- `r62` identifies the historical public qualification, not a public version
  line or the qualification of this checkout. Each new build uses a fresh numeric
  revision such as `r82`; the builder accepts `r` followed by a positive integer.
- Public source snapshots and generated release-folder names use the downstream
  version.
  The installed runtime directory and CLI still use AgentMemory compatibility
  version `0.9.29` so existing data and integrations are not relabelled.
- Native Windows and Codex are the supported downstream host profile.
- Existing versioned runtime directories are preserved. Build changed contents
  with a fresh internal revision before cutover; the installer refuses a
  different payload at an existing versioned target. Failed cutover follows the
  data-contract recovery boundary below; restoring predecessor binaries is not
  unconditional. Canonical `data` is never replaced by this workflow.
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
  -ReleaseRevision r83
```

The normal build uses the pinned `pnpm-lock.yaml`, runs the existing skill
consistency check, package tests, Codex hook tests, a single TypeScript build,
`pnpm deploy --prod`, and a public index/CLI/MCP/source-map parity smoke. `-SkipTests` is only for local iteration; it is not a
release qualification.

Choose an unused runtime revision for every build intended for cutover. If r83
is already installed, use a new `rN`; do not replace its immutable package. Python
3 must be on PATH for the HTTP regression tests (public CI uses Python 3.12).

## Prebuilt npm distribution and first installation

The [npm guide](npm/README.md) is the user entry point after both artifacts are
published. A small, dependency-free package contains a fixed-version GitHub URL,
ZIP size/SHA-256, manifest SHA-256 and exact source commit. It has no install or
postinstall lifecycle scripts. It never publishes the private root package or
an upstream-scoped package. Temporary downloads are removed after each command.

`--fresh` (PowerShell `-Fresh`) verifies an empty or absent target;
`--fresh --execute` copies the verified runtime, DPAPI secret, ownership and
configuration into that root. It does not register tasks or modify Codex.
`--activate-prepared` then checks the same user, exact release/payload, task and
port collisions, and absence of managed requirements. With `--execute`, it
registers the existing daemon/watchdog tasks and four hooks. It does not start
the service or edit MCP/OAuth configuration. Follow the npm guide's existing
startup verification and OAuth connection steps. A preparation failure leaves
the partial root for inspection; no existing user files are deleted or replaced.
Activation rolls back only the task registrations and requirements it created.

Publisher workflow: finish source checks, commit the clean release candidate,
then build once with a fresh, unused numeric revision. From that same clean
commit run:

```powershell
& .\packaging\windows-codex\Build-NpmDistribution.ps1 -ReleaseRoot D:\staging\build\agentmemory-codex-windows-0.1.0-preview.10 -OutputDirectory D:\staging\npm-preview10
```

This produces the versioned Windows ZIP and npm tarball, without publishing.
The producer rejects dirty/mismatched source, unmanifested files and junctions.
Upload the exact ZIP under the descriptor's versioned GitHub asset name before
publishing the tarball with the preview dist-tag. Publishing either artifact,
creating tags and changing an existing installation require separate authorization.
SHA-256 integrity is not Authenticode signing or an independent security audit.

The ZIP and installed payload retain Apache LICENSE/NOTICE, the official
iii-engine Elastic License 2.0 text, and shipped dependency licenses. See
[third-party notices](licenses/THIRD-PARTY-NOTICES.md); Apache licensing of this
adapter does not relicense the engine or other dependencies.

## Existing-install cutover

The installer supports an owned existing installation. Without `-Execute` it
only validates release hashes, owner/manifest identity, exact paths, and the
managed Codex requirements predecessor. It also rejects a workspace-root change
that would lose an existing LocalAI launcher, before creating backups or stopping
the service. Use the workspace root from installed `config/codex-workspace.json`;
the directory holding the project registry is not necessarily that root. Existing
hosts without LocalAI and fresh installations may still omit this integration.

```powershell
& D:\staging\agentmemory-codex\agentmemory-codex-windows-0.1.0-preview.10\Install-WindowsCodex.ps1 `
  -ReleaseRoot D:\staging\agentmemory-codex\agentmemory-codex-windows-0.1.0-preview.10 `
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

The managed package now declares data contract version 3 for source-linked
duplicate captures, including their partial-forget protection. It includes the
version 2 native capture, recoverable graph writes and archive lifecycle state. The release and installed
manifests retain that contract independently of the upstream compatibility version.
An absent declaration means legacy contract 1. The current installer rejects a
target contract below the installed contract before cutover. The managed worker
checks the selected package's declaration before importing its CLI, including
when `AGENTMEMORY_PACKAGE_DIR` selects a different package.

Cutover holds the existing startup file lock, records its phase in the existing
install manifest and retains the contract floor before copying the candidate.
If failure follows a contract transition or candidate startup, the installer
stops the owned runtime and leaves `cutover_failed`, candidate files, canonical
data and the predecessor code/config backup available for review. It does not
automatically restore predecessor binaries against possibly newer data. An
unconfirmed stop also prevents file rollback. Complete or repair a compatible
release; a partial package copy may require review before retry. Reverting to a
legacy runtime requires a matching pre-upgrade **data** backup as well as its
code/config; the installer's code/config backup alone is insufficient.

These are protections in the supported installer and worker entry points. An
old installer or an independently launched old upstream binary cannot learn this
new contract and must not be pointed at the upgraded live store. Directly
overwriting manifests or bypassing managed entry points is not a supported rollback.

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

Recall applies project and agent scope before taking the top keyword, vector,
or graph candidates. A fixed over-fetch multiplier no longer determines whether
an in-scope memory can appear. Canonical candidate checks are shared within each
request and state reads use batches of at most eight. Saved memories keep their
own project even when their first source session belongs to another project;
compact and expanded results carry that project, and expansion resolves saved
memories from the canonical memory store. An explicit working directory requires
a proven matching source session directory.

The primary recall path uses graph retrieval even without a populated vector
index. Project-scoped graph traversal excludes other projects, verifies source
session/observation provenance before returning graph-only hits, and skips
superseded or review-retired relationships in current recall. Explicit temporal
history remains separate. Missing graph source provenance does not authorize
guessing a session. These changes do not start a local model or migrate data.

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

`memory_recall` and `memory_smart_search` expose an optional `agentId`, including
smart-search expansion. Omission preserves the configured agent scope; an
explicit `*` requests a cross-agent read within the selected project. Invalid
explicit agent IDs fail before search rather than silently selecting the default.
This does not assign an owner to existing unscoped sessions or observations.

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

Managed hooks accept the path-based project registry and version 3
`relocation_ref` entries. References resolve the unique relocation batch
destination, including an explicitly matching nested Git path. Missing or
ambiguous targets, path escapes, linked checkouts, and unverified retained source
identities fail closed. The registry and its sibling relocation manifest remain
the routing authority; hooks do not rewrite them or create a parallel registry.

Existing unassigned normal Codex sessions can be reconciled through authenticated
`POST /agentmemory/session/start` with `action: "reconcile-owner"`. First send an
exact `project`, `sessionId`, a `sourcePath` relative to the configured Codex source
root, and `dryRun: true`. The preview returns the native identity, current/target
owner, observation counts, and `expectedVersion`. Apply the same request with
`dryRun: false`, that version, and a non-empty `reason` (at most 512 characters).
A stale preview or conflicting owner is rejected before changes. There is no
blanket adoption of unassigned history and no wildcard write scope.

The trusted source root defaults to the Windows account's `.codex` directory,
independently of the service's synthetic HOME. An optional absolute
`codex_source_root` in `config/codex-workspace.json` overrides it and is preserved
by updates. Inherited environment variables and request bodies cannot override
it. Only normal CLI/Desktop `session_meta` identity under `sessions` or
`archived_sessions` is read; linked paths, unknown sources and inherited fork
history are rejected. Normally this operation reads only the bounded metadata
header and does not enable automatic collection. When the canonical cwd differs
from the initial header, reconciliation additionally requires the exact native
thread index to agree with the canonical cwd and a complete supported inventory
whose last verified turn context names that cwd. Preview and audit expose
`verifiedCurrentCwd`; the initial source header, canonical cwd and project are
preserved. Merely finding a directory mentioned in conversation text or an
earlier turn does not prove the current cwd.

Reconciliation preserves existing session/observation IDs, contents, counts and
graph cursors. It uses the existing writer exclusion barrier, records an audit,
and stores pending/completed reconciliation provenance on the canonical session.
The session owner is written first so future captures inherit the correct owner;
completion is written only after observation updates acknowledge success. An
interrupted application remains pending and can be previewed again and resumed.
An ambiguous StateModule write still requires the existing worker restart and
canonical verification procedure before further writes. Other agents, excluded
sessions and recovery-protected observations are not reassigned. Derived memory,
lesson and graph ownership is not changed by this session-only operation.

The same authenticated endpoint accepts `action: "inspect-source"`, exact
`project`, `sessionId`, relative `sourcePath`, and optional `limit` (1–200, default
20). This read-only comparison identifies source messages, existing matches,
missing observations and ambiguous legacy correspondence without returning the
conversation text. It reads at most 256 bounded windows per request and reports
partial tails, unsupported records and pending display/primary correspondence
separately. A ready comparison is diagnostic evidence, not an apply authorization
or a graph-completion claim. Initial legacy matching requires a complete native
inventory so a read-window boundary cannot hide another matching repeated input.
Existing capture observations without an explained source match are reported as
`unmatchedCaptures`; a complete inventory with unresolved captures is blocked.
Manual curation and tool observations do not require a native conversation match.
Known internal host notifications use the same exclusion rules as native parsing;
legacy rows with canonical source or deletion/recovery metadata remain checked.
Automatic native capture and graph recovery are not enabled by this inspection.

`action: "initialize-source"` on the same endpoint previews the initial native
correspondence with `dryRun: true`. Applying requires the returned `expectedVersion`,
`dryRun: false`, and a non-empty `reason`; the source root remains server-owned.
Initialization preserves existing observation IDs and metadata. Legacy matching
ignores already deleted, unbound empty rows as conversation candidates using
the official empty-observation content check. Those rows and their recovery
metadata are not modified. Protected rows with content, restored state or source
provenance continue to require their existing lifecycle. Ordinary correspondence
uses full-content correspondence within the existing five-second window and
requires a unique mapping across the complete inventory. It can append one final
LF when the resulting digest exactly matches the native source. Legacy synthetic
user prompts can regain their complete text when the upstream 399-character
prefix plus ellipsis reproduces the entire stored narrative and the original
conversation type/confidence agree. This does not trim or otherwise normalize
the source text; competing prefixes remain unresolved. For an unbound, unprotected
synthetic user prompt, a second exact comparison can remove only ASCII space,
tab, CR and LF from the native text boundaries. The complete result, or its
exact upstream 399-character prefix plus ellipsis, must equal the entire stored
narrative within five seconds and have a unique source in the complete inventory.
Recovery restores the original native text in the same observation, preserving
metadata and retrying index publication by that ID. Preview and audit identify
`restoreLegacyPromptWhitespace`. Internal whitespace, Unicode spacing and other
text changes remain unsupported; two competing sources or stored records block
recovery. This compatibility rule does not establish which historical writer
removed the boundary whitespace. Legacy synthetic
assistant records can regain their complete native answer only when the upstream
turn-ID prefix and 400-character truncation reproduce the entire stored narrative,
the native turn ID matches the stored subtitle, and the synthetic type/confidence
agree. Legacy image-wrapper text can be normalized only when actual native
image triplets reproduce the entire stored user narrative, the timestamps are
equal, and correspondence is unique. Existing image references and payloads are
preserved; literal image-tag text does not qualify. Competing source matches still block recovery. Arbitrary trimming and fuzzy
matching are not supported. Unfinished raw
captures can be converted in place through the existing zero-LLM synthetic path
only when their owner, shape and complete source correspondence are verified.
When a later native source generation omits an existing capture, initialization
can inspect up to 16 older source candidates for that exact session. Only a
matching source kind and cwd, complete prior inventory, full unchanged text,
unique identity and the existing five-second legacy window permit adoption.
Previously bound rows must retain their native key. Matching retained records
store their relative path in codexSource.retainedSourcePath and use the existing
indexPending publication retry. Preview/audit report adoptRetainedSource and
retainedSourceObservations; inspection counts retainedSourceMessageCount apart
from current native messages. This preserves already captured history outside a
continuation boundary or superseded source file without changing the current
replay cursor or importing uncaptured prior tails. Ambiguous, protected, changed,
missing and unsupported evidence remains unresolved.
For a complete source whose verified task completion is blocked only by a unique
unmatched UserMessage display item, initialize-source accepts
reviewSourceHolds: true (default false). Preview scans the complete source,
reports at most 128 exact source holds, and includes the option and their
provenance in expectedVersion. Apply requires that preview version and a reason.
Only genuine primary messages are eligible for collection. Each hold retains the
session, turn, item, byte/record locations, text and record digests, and the
verified completion location/digest in canonical codexNativeCapture.sourceHolds;
it stores no display body and creates no synthetic primary or graph completion.
Repeated ambiguous display text, conflicting item identities, unmatched assistant
items, a mismatched final response, unknown records and incomplete tails remain
blocking. An approved hold is not a general permission to skip parser failures.

Incremental reads and restarts cross only those exact reviewed holds. Later
unknown input requires a fresh explicit preview/apply. Capture reports
caught_up_with_holds, inspection reports ready_with_source_holds, and both
report sourceHoldCount; native health also reports the aggregate sourceHolds.
completeNativeInventory describes a complete source scan and does not mean
that a held item acquired a primary message. Observation-level
unresolvedCaptures remains separate and retains its existing protections.
Held sessions and cursors use version 2. Older readers refuse them rather than
silently marking their tails caught up; unaffected sessions keep version 1.
Export/import preserves validated source holds, discards the local cursor and
requires source reconciliation. Older versions reject this held transfer state.
Rolling back therefore leaves held sessions unprocessable until a supporting
version is restored; it must not be reported as fully reconciled collection.

Complete marked ambient UI blocks are stripped before classifying a mixed user
message. A following request remains eligible in replay, observation visibility
and session summaries, including its normal final response. The request text
and native message identity are preserved. Internal-only, unmarked host and
incomplete host payloads remain excluded.
For proven duplicate captures, initialize-source accepts the explicit
reconcileDuplicates option (default false). Complete inventory and the same
existing exact/legacy proofs must uniquely link each row to one native message.
An existing canonical binding is preferred; otherwise a stable observation-ID
order chooses the representative without claiming it was chronologically first.
Other rows retain their IDs and metadata and store codexSource.duplicateOfObservationId.
Any supported body recovery still restores the full native body in place.
Preview/audit expose linkDuplicateCaptures and the exact duplicateCaptures plan.
Distinct primary messages, conflicting ownership/provenance, protected rows,
orphaned links and alias chains remain blocked. Existing valid links need no
opt-in for later capture or import reconciliation. Archive/restore remains a
separate explicit official lifecycle operation; review graph provenance before
archiving redundant rows. Forget must select the entire linked native-message
group, or the whole session, so a duplicate is neither resurrected nor left orphaned.
All repairs are included in the versioned preview and audit, and use the existing
index publication retry. Existing final responses from a turn without a normal
user message can receive verified native provenance when the stored turn subtitle,
complete content and unique correspondence agree. Their IDs, content and derived
references remain intact; `codexSource.legacyExcludedReason` records their original
exclusion from normal capture. Inspection counts these source records separately.
The preview and audit identify adopted excluded finals. This does not insert
previously uncaptured internal responses or change normal capture eligibility.
Final-response hooks record their collection time, which may trail the native
answer by more than five seconds. An unbound, unprotected assistant capture may
be adopted outside that window only when its exact stored turn ID and complete
answer prove a unique source in the complete inventory, and collection follows
the native answer. Preview and audit report `adoptDelayedFinal`; the original
collection timestamp is preserved alongside the canonical source timestamp.
Historical `codex-task-recovery:prompt_submit:<item ID>` imports may use a
displayed UserMessage item ID instead of the primary message or execution turn
ID. Complete inventory can link that item to one primary user message only when
the turn and full text agree and neither identity has a competing claim. An
unbound, unprotected import with that exact item provenance and unchanged full
body can then be adopted outside the ordinary time window. Its original ID,
timestamp and metadata remain intact. Preview and audit report
`adoptImportedUserItem`; this source-derived proof is not persisted, and display
items are never collected as additional messages or used without a primary.
Historical `obs_codex_recovery_*` user observations can regain their native text
when the original content-part assembly reproduces the complete stored digest
and deterministic observation ID. The exact source timestamp and stored
`Codex original turn` provenance must agree, and competing source claims still
block recovery. This handles separators once introduced by image or blank parts
without applying arbitrary whitespace normalization. Preview and audit report
`restoreLegacyRecoveryParts`; the source-derived helper proof is not persisted.
Legacy `MM/dd/yyyy HH:mm:ss` timestamps can be restored to the native UTC instant
only when they exactly reproduce its UTC calendar fields, the complete body is
identical, and the complete source inventory proves a unique correspondence.
This recovery does not shift arbitrary dates or widen the ordinary time window;
competing messages in the same second remain unresolved. Timestamp repairs are
identified in the preview and audit and re-enter the existing index retry path.
Any unexplained stored capture, ambiguous match or
unresolved legacy forget evidence blocks the entire initialization. An initialized
session accepts `action: "capture-source"` with exact `project` and `sessionId`.
Its canonical cursor advances only after the bounded batch has been stored.
For a canonical session already assigned to a later verified cwd, initialization
keeps the immutable initial source identity and binds its existing cwd through
`captureCwd` in the same canonical capture state. A complete source inventory and
the ordinary observation correspondence checks are still required. Capture and
source relocation check that binding against the current canonical session;
changing the canonical cwd again requires reconciliation. Transfer preserves the
binding but discards executable cursors and requires a fresh source comparison.
This does not move observations, reassign projects or infer missing owners.
Normal managed hooks then request native capture and still inject recall context,
without also storing another copy of the hook text.

For already initialized sessions, the service performs a startup catch-up and a
60-second recovery sweep. Each serial batch selects up to eight sources in stable
ID order, reads up to four windows each, and yields between windows after about
two seconds; an in-flight state or source call is allowed to finish. An unfinished
sweep resumes after a 100 ms yield instead of waiting a minute per batch. Hooks
updating a source's checked time cannot move it behind the current sweep.
Sources with a progressing unread tail request another bounded sweep; unchanged
partial tails and failed reads do not request rapid retries. Discovery is paged
until its current cycle ends, then waits for the next capture sweep. Once there
is no progressing backlog or unfinished inventory cycle, ordinary 60-second
polling remains. The in-memory sweep position is only scheduling state; restart
begins a fresh sweep using the existing canonical capture cursors and IDs.
Health exposes `lastCaptureCycleCompletedAt` as a completed inspection pass,
not proof that every source, graph or historical hold has been reconciled.
Capture wakes the existing graph backlog after storage; the source reader itself
does not acquire or start Qwen.

The internal `mem::codex-source-index` function reads the managed source root's
Codex `state_5.sqlite` thread index in bounded ID-ordered pages (default 200,
maximum 500). This requires Node's built-in `node:sqlite`; it is loaded only when
the function is called. The adapter opens the source index read-only, selects
identity metadata only, and never uses it as an AgentMemory state store. It
keeps Codex's registered task ID and rollout path, including replacement filenames,
instead of interpreting filename suffixes as new tasks. Subagent sources are
excluded, unsupported metadata remains unknown, and missing/newer index versions,
incompatible schemas or read failures are errors rather than empty coverage.
Candidates still require original-header, project, inherited-history and existing
observation checks before registration or capture; listing alone authorizes no writes.

The startup/60-second source drain now discovers tasks from that index before
capturing initialized sessions. It shares the hook's project registry and Git
routing implementation. Each discovery pass reads at most 500 index entries,
inspects at most eight new/uninitialized or moved sources and yields between entries after
about two seconds; an in-flight source or state call is allowed to finish. The
in-memory index position advances through the page and cycles from the beginning;
after restart it begins a fresh cycle. This position is not capture-completion evidence.

A previously unseen source needs a supported standalone or paginated-fork header, a real
conversation message, a matching current working directory/project and no orphaned
observations, summary or forget evidence. Discovery creates one canonical session
with its native cursor at zero, then the ordinary capture path stores messages.
An existing session with the exact managed owner and matching project can also
transition after the existing preview/apply correspondence check succeeds; each
automatic inventory is bounded to four read windows. Existing observation IDs and
content are preserved. Unassigned/other owners, source replacements, ambiguous or
incomplete correspondence and unknown inherited-history formats still require reconciliation.
For an initialized source moved between `sessions` and `archived_sessions`,
discovery verifies the existing file identity, source metadata and cursor anchor
at the indexed path, then updates only the source location and capture wait state.
The saved cursor is not advanced by this check. The normal drain captures any
unread tail, preserving observation IDs and graph provenance. Copies with a new
file identity are held for reconciliation rather than borrowing the old cursor.
An already owned hook session whose worktree no longer exists can initialize
using its canonical project and the matching index/header or verified later cwd, after the same
complete observation correspondence check. It does not infer a new project from
the absent directory name. A new source without an existing owner still needs
verifiable project routing. Codex task archival does not archive, hide or delete
the AgentMemory records derived from that task.
Empty originals do not create empty sessions. These unresolved cases remain visible;
automatic discovery is not a claim that historical migration or whole-Codex graph
coverage has completed. The packaged hook now includes `codex-project.mjs` beside
`codex-turn.mjs`; both are required when copying the hook independently.

A paginated fork must declare matching parent ID, ordinal and byte boundaries in
its native header. The adapter retains that reference in source provenance and
reads the child's own rollout only; it does not recapture the parent history.
New final answers may continue that inherited conversation without another user
prompt; internal title/ambient turns remain excluded.
Records before the child's creation time or without a valid timestamp stop the
read as unknown. Cursor identity includes the parent boundary, and export/import
preserves it while requiring host cursor reconciliation.

A same-task continuation with `history_base` reads the declared prefix from one
proven earlier rollout, followed by the current file after its metadata header.
The adapter checks the same native task ID, supported source kind, chronological
header timestamps, and exact line/byte boundary. Filename matches only select
candidates; they never establish task identity. The logical source retains the
original creation time and the prior relative path. Original files stay unchanged,
and bytes beyond the declared earlier boundary are excluded. Cursor identity binds
both files and the reference, so replacement or a changed prior file requires
reconciliation; appending to the current file remains resumable. Transfer preserves
the reference and requires host cursor reconciliation. Missing or ambiguous prior
files, nested external segments, and fork bases remain unsupported and held.
Working-directory differences still require the separate ownership reconciliation;
joining source history does not authorize project reassignment.

Initialized native sessions use per-observation graph completion records. An older
insert remains eligible even when the forward cursor is newer or the session was
previously complete. A valid zero-entity result is recorded as processed. Records
match the exact source input and graph reset boundary; changed inputs and graph
resets invalidate the prior result. The forward/backfill cursors remain progress
hints rather than proof that every observation was processed.

Validated graph assignments and completion records are stored in one recoverable
StateModule write plan before application. Startup recovery reuses those exact
assignments and checks source identity, source content, and target preconditions;
it does not rerun the model for a partially applied result. An uncertain write
acknowledgement retains the existing worker-recovery boundary. Canonical writers
wait for a successful active application and remain blocked if recovery fails.
Completion transfer through every backup surface and whole-corpus activation
still require the remaining lifecycle integration and acceptance checks.

Managed Codex forget now retains minimal capture exclusions in the official
StateModule store before deleting observations: session/observation identifiers,
an exact native source key when available, or legacy timestamp/kind/content
digest. It retains no deleted conversation body or attachment. An ambiguous
legacy exclusion blocks source reconciliation instead of guessing. Failed
deletion remains distinguishable from completed deletion when its original row
survives. These exclusions apply to both inspection and initialized native capture.

A whole-session forget excludes native history through its recorded forget time
and the exact targeted captures. It does not prohibit all future messages in the
same Codex task. A later whole-session forget can extend that time boundary.
Capture exclusions survive ordinary merge/replace imports. Imports that would
restore a forgotten capture or contradict surviving canonical rows are rejected
before import changes. Explicit forget remains deletion, not recoverable archive.
Exports containing exclusions or native capture provenance use
`0.9.29-codex-lifecycle-1`; older readers
must reject that unsupported version rather than silently omit the exclusions.
The portable package compatibility version remains `0.9.29`.
Exports containing reversible archive lifecycle metadata use
`0.9.29-codex-lifecycle-2` and include the original targets with their archive
states. Explicit archive inspection and mutation use `memory_archive` or
`POST /agentmemory/archive`; automatic archive policy is not enabled.
Use `action: "candidates"` with one exact `project` to review the current
retention/TTL candidates. `policy` accepts `all` (default), `retention`, or `ttl`;
`threshold` defaults to 0.15; `limit`/`offset` page the project-filtered results.
The response includes an evaluation time, policy parameters, exact target IDs,
selection reasons and invalid-policy record count without returning original
bodies or changing access logs, retention scores, archive state or source records.
Retention uses the existing default decay formula recomputed from current records
and access history; unavailable history fails the request rather than selecting
records as unused. TTL retains the existing strict `now > forgetAfter` rule.
Archived/deleted targets and unresolved project ownership are excluded. This
preview covers memory and semantic retention plus memory TTL, not other cleanup
heuristics. Each page is evaluated against current data, not a historical snapshot.
Candidate status alone is not approval: inspect each target and request its
individual archive preview before applying a reviewed change. Existing automatic
cleanup settings are not enabled or changed by this read-only action.
Automatic TTL/contradiction cleanup, age/capacity eviction, retention eviction
and lesson decay preserve targets with archive lifecycle history and their source
sessions. A manual restore does not authorize deleting the same original on the
next automatic sweep; use explicit lifecycle review for subsequent cleanup.
Unprotected records retain the existing cleanup rules. Protection is resolved
before mutations and cleanup stops on unreadable or invalid archive provenance.
Retention eviction and lesson decay join the existing observation writer boundary
so archive/restore cannot race their candidate selection and writes. These rules
do not enable automatic cleanup or replace explicit forget with archive.
Explicit `POST /agentmemory/forget` requires the archive's exact `project` when
an archived memory, session, observation or affected graph target is involved.
Its session dry-run reports `archiveTargets`. After confirmed original deletion,
the same operation removes only that target's archive metadata and audits the
removal; surviving graph originals keep their archive state. If metadata cleanup
fails after source deletion, retry the same exact request to finish cleanup.
Deleting a source does not create a content-bearing archive or permit restore of
the deleted original. Pending archive imports must be recovered first. A session
forget that would remove another archived target's required project provenance
is rejected for explicit dependency review instead of silently orphaning it.
The same metadata cleanup now applies to governance memory deletion and lesson
soft-delete. Supply `project` to the existing MCP/REST delete request for an
archive target. Governance bulk filtering honors that exact project before
preview or mutation, and a mixed-project explicit ID list is rejected before
deletion when a project is supplied. After a bulk cleanup failure, use the returned
failure IDs with exact governance deletion to finish metadata cleanup; repeating
a content filter cannot rediscover an already removed original. Lesson deletion
keeps the upstream soft-delete contract: its row remains marked `deleted`, while
its archive metadata is removed. This is not physical erasure of lesson content.
Direct graph purge and the graph-provenance stage of explicit forget now use
the existing durable graph write plan. Version 2 supports exact deletions alongside
assignments; version 1 assignment plans remain readable. A deletion stores its
original digest and address, not a backup of the deleted body. The plan includes
the canonical graph, affected lookup/query indexes, matching archive metadata
removal and the completed audit state. Archive-only cleanup plans are rejected.
After an ambiguous state acknowledgement, ordinary graph reads and canonical
writes remain fenced until the existing fresh-worker recovery reapplies the
same plan. It accepts already-applied changes and refuses conflicting state.
In source forget, graph failure leaves the source records present; recover the
graph plan before retrying that exact source deletion. Independently supported
graph records keep their archive state and remaining provenance. Inspect the
completed purge audit and canonical results after recovery rather than treating
an old inventory as a fresh purge request. The patched engine's process-crash
qualification and managed rollback boundary are documented below and above;
full release acceptance and explicit activation approval remain required.
Ordinary memory lists/counts/details, semantic/procedural lists, skill list and
matching, working context and related-memory traversal also exclude archived
or import-pending originals. Related-memory traversal does not use a hidden
memory as a bridge. These filters run before page counts, ranking limits or
context budgets, and a restore exposes the same canonical ID. Explicit archive
inspection remains the route for viewing a hidden original.
Snapshot creation and restoration use the same transfer
boundary. Merge imports preserve the destination's existing archive or restore
decision; a stale backup does not change that decision. Replacing an archived
original with different content, transferring metadata without its original, or
reassigning its project is rejected before import writes. Replace imports require
a destination without archive lifecycle history; use merge for an existing store.
An interrupted archive import retains a hidden pending state until the identical
payload's originals are verified as stored. Export and manual visibility changes
remain unavailable for that pending target until recovery finishes. The export
version fence protects transfers; the managed data-contract floor separately
protects supported runtime updates and package selection for the live store.
Legacy Mesh payloads cannot carry archive/restore history or its source records.
Stores with any archive lifecycle history therefore reject legacy Mesh push,
pull, receive and export, including after a restore. Receive also rejects a
payload containing archive metadata instead of silently discarding it. Use the
archive-aware export/import functions to transfer lifecycle originals; merge
preserves the destination's own archive/restore decision. This is an explicit
compatibility boundary, not automatic archive synchronization between peers.
A refused transfer leaves the synchronization cursor unchanged. REST transfer
refusals return HTTP 409. Copies previously sent to a peer are not recalled.
Claude MEMORY.md regeneration omits archived and import-pending memories before
its line budget and exposes the same original again after restore. Metadata read
failure prevents a new file write. Regeneration and Mesh export participate in
the existing writer boundary so an archive transition cannot race their reads.
Previously generated or independently copied files are not automatically erased;
the explicit bridge-read operation still reads the configured file as it exists.
Ordinary injected context, lesson recall/list, session pages and observation pages
now exclude archive targets before their result limits. Session-level archive
also hides that session's observations. When individual observations are archived,
the session's aggregate summary and cached first prompt are withheld from ordinary
session/context responses; context can still use the remaining observations.
Original summaries and independently retained memories stay in canonical storage.
Restoring a lesson takes effect on its next recall even with a warm lesson index.
Direct graph queries also filter archive state before node/edge pagination and
traversal. Archived nodes cannot act as bridges, and their incident edges stay
out of ordinary results without deleting canonical relationships. Exact edge
inventory revisions include the graph archive state and become inexact if it
changes during the read. With archived graph targets, the default viewer query
uses the existing exact index; if unavailable, its bounded snapshot fallback
filters archive state and reports potentially incomplete totals. It never falls
back to canonical graph enumeration. Temporal retrieval respects current archive
visibility as well. `graph-stats` retains canonical snapshot counts and labels
them `includesArchived: true` when applicable; those are not active-only counts.

For an exact project, use `action: "list"` to page archive metadata (20 by default,
maximum 100, with `state: "archived"`, `"restored"` or `"all"`). Use `action:
"inspect"` and an exact `{kind, id}` target to read its canonical original and
lifecycle state; observation targets also need `sessionId`. Inspection does not
restore or strengthen the record. Use `action: "archive"` or `"restore"` for a
preview, then pass `dryRun: false`, the returned `expectedRevision` and
`expectedDigest`, and a reason to apply that reviewed change. Stale previews and
missing/deleted originals are rejected. This tool preserves source references and
does not substitute for an explicitly requested forget. The remaining full
acceptance checks must finish before deploying this development candidate
against live data.
Transferred native sessions retain source identity but discard the host-specific
cursor and require reconciliation before capture resumes. Observations-only
imports also invalidate an affected native cursor. A verified resumed session
may retain post-forget observations; earlier observations, an old first prompt,
and the forgotten summary cannot be restored through that exception.

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

Local revision r94 reconciles `Session.observationCount` from the actual visible
observation rows for sessions or observation buckets included in an import.
For an exact existing session, `POST /agentmemory/import` with `strategy: "skip"`,
an empty `sessions` array and `observations: { "<exact-session-id>": [] }` repairs
only its count; provide the normal compatibility version, export timestamp and
empty `memories`/`summaries` arrays. Verify the session's registered project first.
It neither imports observations nor changes capture state or graph cursors.
The response reports `reconciledSessions`; an identical second repair reports 0.
Existing recovery-protected sessions remain subject to the import prohibition.

Local revision r97 marks an affected session pending when an import actually
writes observations and the existing graph cursors leave an unprocessed tail.
It notifies the same backlog scheduler after exclusive import access ends.
Capture metadata and forward/backfill cursors stay intact. A complete backup
restore, duplicate-only import or count-only repair does not reopen graph work;
disabled extraction remains disabled. Historical inserts before an already
processed cursor still require explicit scoped extraction/backfill and provenance
verification; r97 does not rewind completed history. Notification failure leaves
committed data pending for the existing recovery probe instead of failing import.

Local revision r98 keeps forward and bootstrap-backfill cursors monotonic when
explicitly extracting historical observations. The existing session lock covers
comparison with current official timestamp/ID order and completion calculation.
Unsorted selected inputs do not rewind progress; historical graph provenance is
still extracted, and an unprocessed tail stays pending. An unknown existing
cursor is preserved for explicit repair rather than replaced with a guessed
position. This does not automatically extract historical imports before a cursor.

Imports use the existing single-worker exclusive observation lifecycle. An
already active writer causes a no-change busy failure; incoming writers wait
until the import settles. This is not a database transaction: a failed import
may have committed rows, and every started chunk write settles before the
exclusive interval ends. Inspect canonical results after ambiguous failures.
Normal small repairs should be bounded to the exact affected sessions; large
imports can delay ordinary capture and should run in a quiet maintenance window.

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

Native capture uses a strict index flush and keeps failed publication pending.
Within one persistence instance, fingerprints of successfully stored BM25 and
vector snapshots let queued or unchanged flush requests avoid duplicate writes
when the current persisted manifest still matches the committed generation.
The fingerprint covers the serialized content, including externally retained
vector buffers; it is not based only on request counts or snapshot length.
Changed snapshots remain serialized, failed publication is retried, and a new
worker performs its first requested save normally. Unchanged observation
reindexing preserves posting and tie order. Previous-shard cleanup remains
sequential and records every attempted target and outcome in one grouped audit.
This changes neither stored formats nor the canonical source/graph lifecycle.

The managed user-prompt hook searches the exact current project first, then
requests original user evidence with `sourceKind: "user"` across `*` within the
same time budget, even when the local search found a match. It uses REST
`searchMode: "keyword"`; the separate graph lookup
already supplies graph context, so automatic recall does not repeat the full
hybrid graph traversal. Omitted `searchMode` keeps ordinary hybrid search.
This discovers requirements stored before project moves without assigning unrelated records to
the current project or hard-coding aliases. A failed local read does not silently
broaden scope; a failed historical lookup preserves local evidence and marks
history unavailable. Graph lookup retains its current-project-first fallback,
and graph succession expands through each node's exact source project.
Automatic recall and graph context require a
concrete topic, filename, or identifier shared with the effective request;
product names, generic follow-ups, search score and project membership alone
do not qualify. Recall reserves current-project evidence, then selects original
user observations with newer source dates first; retrieved old text cannot
override the current user request. It labels user versus derived excerpts,
requires applicability/correction checks and original-source expansion before
behavior changes, and preserves the source project, record ID and timestamp
(or an explicit unknown time). Topic-matching paragraphs can be excerpted from
longer messages. These are limited candidates, not a complete or authoritative
requirements list; contradictory requirements still need source review.
Repeated scoped record IDs are emitted once. Automatic candidate
searches pass the existing `trackAccess: false` option through REST to StateModule
search, so merely considering a result does not strengthen its access-based
retention. Explicit searches retain their default access tracking.
When a short follow-up omits its topic, the hook can reuse the most recent
topical user prompt among 12 recent observations in the same exact project and
session. It uses at most two existing observation-page reads (700 ms each),
without a separate topic cache or model call. The captured user message remains
unchanged. If no topic is found, automatic retrieval abstains; earlier injected
or model-generated text does not supply a topic.
Explicit MCP recall remains available. Graph neighbors need their own topic
match, except for explicit supersession links preserving a matched decision's
replacement and historical status. Local and fallback candidate queries share
the existing 1,200 ms retrieval budget. Recall normally has up to 650 characters;
two or more distinct topical user originals permit up to 1,150. Graph context
stays at 500 and curation keeps its reserved budget. Total injected context is
normally capped at 2,300 characters, or at 2,800 when the longer original-source
excerpts actually use the extra room. Duplicate text and unrelated records do
not justify expansion. These are character limits, not model-token counts.
No LLM inference is added. Bounded successor expansion
is unchanged. Explicit `memory_recall` and REST `/agentmemory/search` also expose
`sourceKind: "user" | "assistant"`; omission retains ordinary mixed-source
search. Speaker selection happens before candidate limits, and keeps existing
archive, source-exclusion, project and agent visibility rules. Derived saved
memories are not original user observations. Generic display/publishing commands such as
`띄워줘` and `게시 진행` can use this same-session topic recovery. This lexical
selection can miss synonyms or unrecognized Korean
inflections; it is not a semantic relevance guarantee. Durable promotion is
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

A newly stored observation also wakes the same scheduler after its canonical
write succeeds. Wake failures preserve the stored observation and the periodic
recovery path. In the managed Windows profile, the environment adapter discovers
only `<workspace_root>/projects/local-ai/scripts/Invoke-LocalAI.ps1` and supplies
its absolute path through `AGENTMEMORY_LOCAL_QWEN_LIFECYCLE_SCRIPT`. Inherited
values are scrubbed; the service environment file cannot override that path.
If PowerShell 7 or the existing LocalAI script is absent, cold start is disabled.
The portable provider does not enable this integration by default.
A failed probe with no lifecycle integration is logged as
`local_qwen_autostart_unconfigured`. Transport failures include their underlying
code and loopback host/port, for example
`local_qwen_transport_failed:ECONNREFUSED:127.0.0.1:8000`; connection refusal alone
does not imply a GPU admission failure. Timeouts and unknown transport causes are
reported as `TIMEOUT` and `UNKNOWN`, with the original error retained as the cause.

When a provider probe fails, the same internal backlog function is queried in
read-only mode. Only a batch that passes the existing source, cursor and output
budget rules permits `start-qwen -Background`. Empty or blocked-only backlog
does not launch Qwen. Startup is single-flight, admission failures have a
15-minute retry interval, and hooks never wait for model loading. The existing
host owns manual holds, resource admission and the GPU transition lease; this
repository does not bundle that host or prescribe universal memory thresholds.
Successful startup and a subsequent provider probe clear the startup retry
restriction before the ordinary 15-second grace and fair batch drain. After a
normal five-minute idle shutdown, newly eligible work can request startup again
without waiting out the earlier 15-minute interval. Failed launches, failed
post-start probes and host admission refusals retain that retry backoff.

The returned exact instance identity is retained in memory. Only a worker-started
instance is released after five minutes of empty backlog or graceful worker
shutdown, using `stop-qwen -ExpectedOwnerToken`. Busy consumer guards defer idle
release; borrowed or replaced instances are never stopped. New observations
interrupt the idle wait. Abrupt worker termination cannot run this cleanup; the
existing host ownership and desktop-exit lifecycle remain the recovery boundary.
No parallel queue, new database or transcript copy is introduced.

A stored response is still not a verified durable decision. The current Codex
model selects reusable decisions and verified fixes through official curation
tools; automatic provider extraction only enriches the source-backed graph.
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

## Source validation without a release payload

During source iteration, run `packaging/windows-codex/Build-WindowsCodex.ps1 -ValidationOnly`.
It runs the frozen hoisted dependency install, skills check, typecheck, build and
existing source/adapter/distribution tests, but does not deploy dependencies or
create an output/release directory. It accepts a dirty source checkout and reports
`source_dirty`; it is validation evidence, not a release source identity.
`-SkipTests` keeps its existing explicit meaning for a focused subsequent run.

Use the normal `-OutputDirectory` and `-IiiEnginePath` invocation once the source is
ready for final packaging. That mode still requires a clean Git checkout and
creates the same self-contained release. Validation does not activate a runtime.

## Release retention and cleanup

After a successful update and readiness confirmation, the installer compacts only
the new code/config backup into one sibling ZIP. It verifies every archived file
against SHA-256 before removing that newly created expanded copy; canonical data
and older backups are untouched. Failed updates retain the expanded backup used
for rollback. A compaction failure preserves the backup and reports
backup_compaction_error without undoing an already healthy installation.
Successful compaction reports backup_archive and clears backup_root.
For manual recovery, extract the archive into a new empty recovery directory
before inspecting or restoring its predecessor files; never extract over live data.
Superseded backup archives still follow the explicit maintenance rules below.

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

### Runtime responsiveness recovery

#### Storage acknowledgement and crash qualification

Unmodified iii-engine 0.11.2's file-backed KV acknowledges an in-memory mutation and
persists dirty scopes on a default five-second timer. The state path is a directory
of per-scope binary snapshots, not a SQLite database. A successful StateModule RPC
therefore does not prove that its value or a graph recovery plan has reached disk.
See the [pinned KV implementation](https://github.com/iii-hq/iii/blob/iii/v0.11.2/engine/src/builtins/kv.rs).

The opt-in `test/engine-write-recovery.test.ts` launches an explicitly supplied,
hash-verified 0.11.2 engine on an isolated loopback port and temporary data directory.
It checks owned process identity before forced exit and checks recovery through
the real StateModule. Enable with `AGENTMEMORY_TEST_ENGINE` and
`AGENTMEMORY_TEST_ENGINE_SHA256`, and set `AGENTMEMORY_TEST_ENGINE_DURABILITY=required`
for the patched engine; an optional `AGENTMEMORY_ENGINE_TEST_REPORT`
receives local evidence. This covers eight crash boundaries and one bounded-page RPC case. It is
not part of routine unit runs or a test against the live installation.
An additional opt-in `AGENTMEMORY_TEST_ENGINE_PERFORMANCE=true` case measures
ten durable writes in one synthetic 20 MiB scope with 80 rows. It can write
`AGENTMEMORY_ENGINE_PERFORMANCE_REPORT` and is separate from the eight crash
boundaries. This isolates large-scope persistence cost; it is not a whole-graph
throughput or many-small-records benchmark.

The unmodified engine fails immediate post-acknowledgement crash recovery.
This downstream pins a modified release build with `state::flush` and
`state::list_page`. The managed
launcher fixes `AGENTMEMORY_STATE_DURABILITY=file-flush-v1`; worker startup verifies
the barrier before recovery and function registration. Ordinary writes wait for
flush success. Graph plans flush the intent, assignment batch and intent removal
in that order. A flush failure fences subsequent writes for recovery. Portable
hosts retain the default behavior unless they explicitly require this mode.

The engine patch uses the existing canonical file store and dirty-scope lock,
waits for file writes/sync/rename, retains unpersisted work on errors, and lets an
in-flight flush finish independently of RPC caller cancellation. It adds no second
database and does not change the stored snapshot format. The qualified release
binary passed all eight synthetic process-crash boundaries; this does not certify
Windows power-loss recovery, disk failure recovery or full production acceptance.

To rebuild the engine, check out `iii/v0.11.2` at the exact `source_commit` in
`config/third-party-inputs.json`, apply `patches/iii-0.11.2-state-flush.patch`, then
run `cargo build --release --locked -p iii --bin iii` in an x64 MSVC build environment.
The manifest records the Rust/Cargo, MSVC and Windows SDK versions and Cargo.lock
hash used for the pinned binary. The package builder verifies the binary hash and
normalized-LF patch hash and includes the patch and license in the payload. Source
reconstruction is documented; bit-for-bit rebuild reproducibility is not claimed.

#### Bounded graph-index recovery

The managed engine additionally provides `state::list_page` without changing
canonical file layout or durability semantics. Each response contains actual
stored keys, values, the scope's row count and a next offset. The default page
contains at most 128 rows (API maximum 256) and its serialized JSON never exceeds
1 MiB. An oversized single row, invalid offset or unsupported adapter returns an
error; the engine never substitutes a whole-scope response. Page order follows
the existing insertion order. Pages are not a snapshot transaction: the caller
must serialize mutations across a traversal.

The explicit `mem::graph-snapshot-rebuild` operation holds the existing graph
write lock while reading both canonical scopes in pages. It yields between pages,
enforces a six-second timeout per page and a 128 MiB total serialized inventory
budget, and checks stable counts, exact keys and duplicate entries before derived
writes. It preserves reset visibility and source provenance. Partial derived
writes keep the query manifest dirty; success publishes the complete index last.
No canonical node or relationship is deleted or replaced by this operation.
An unavailable managed paging surface fails without a whole-list fallback.
Portable engines retain the previous 25,000-node whole-response ceiling and
refuse a known oversized snapshot before enumeration. Recovery does not require
resetting the graph; corpora outside the bounded budget remain an explicit error.

The managed worker checks query-index consistency during its existing 30-second
health cycle, starting at worker startup. An unavailable index requests one
`mem::graph-snapshot-rebuild` invocation, which rechecks consistency under the
graph write lock before rebuilding. When a clean snapshot matches canonical node and edge totals, only
query shards are rewritten; full lookup rebuilding is reserved for a missing or
inconsistent snapshot and limits each batch to 16 state writes. A completed failed attempt retries after
five minutes; a running attempt is never duplicated. `health.graphQueryIndex`
reports ready, recovering, unavailable or error, with the last failure and next
retry time when applicable. Recovery uses no Qwen invocation. Other observation
collection can continue while graph writers wait for the rebuild lock. Portable
profiles do not enable automatic rebuilds. Query fallback remains bounded and
returns `totalsExact: false`; zero fallback matches are not proof of no matching
canonical records. Empty extraction batches and merges outside the top-degree
snapshot still close their index update, so later exact queries remain usable.

Managed health snapshots expose `cpu.percent` as the process's share of available
CPU capacity, plus `cpu.corePercent` and `cpu.availableParallelism` for the original
core-equivalent measurement and denominator. Portable profiles preserve their
existing CPU metric. This prevents normal multicore processing from reporting
health 503 solely because process CPU time exceeds one wall-clock core; event-loop,
connection and resource-pressure checks still apply.

Managed memory severity uses `memory.heapSizeLimit`, the configured V8 heap
capacity, as the denominator for the existing heap-pressure percentages. The
snapshot preserves `memory.heapUsed`, `memory.heapTotal`, and RSS; portable
profiles continue to use `heapTotal` as their denominator. The RSS floor remains
part of memory warning and critical decisions.

#### Existing supervisor

The Windows daemon checks the database-free liveness and MCP metadata routes
every 30 seconds, with a three-second timeout per route and loopback proxy
bypass. Three consecutive failures end that owned run with
`runtime_unresponsive`; a successful check clears the failure count. Cleanup
uses the existing exact process identity checks and graceful-stop timeout.
The existing watchdog can restart only after the reserved ports are clear and
the Codex consumer is present. No second watchdog or memory store is added.
Authenticated stop requests use the same bounded cleanup even when the worker
cannot process its stop file. This limits the impact of a stalled worker; it
does not establish or repair the underlying cause of the stall.

The liveness response retains HTTP 200 and `status: ok` to identify a running
worker, and includes a database-free `writeRecoveryRequired` flag. An uncertain
canonical write acknowledgement, failed graph recovery initialization, or a durable
graph plan left without an active application sets this flag. The Windows daemon
counts it as an unsuccessful recovery probe using the same three-failure rule.
A healthy in-flight graph plan does not request a restart. Startup resumes the
existing graph plan before exposing the API; a canonical conflict still refuses
recovery rather than overwriting the conflicting value. No readiness probe
starts Qwen or changes its hold and ownership rules.


### Stall diagnostics (local r96)

The Windows daemon enables a diagnostic worker thread inside the existing Node
process. It records only registered function names, the six allowed state RPC
names, numeric local parent IDs, start/end times, coarse outcomes and memory
counters. Payloads, results, state keys/scopes, request URLs, credentials,
environment variables, raw error text and heap contents are never recorded.
Portable hosts remain unchanged unless they explicitly supply the diagnostic
file and valid run identity.

The thread updates `logs/worker-diagnostics-<run-id>.json` once a second using a
temporary file and rename. It continues when the main JavaScript loop stalls.
Active entries are capped at 128, recent completions at 64 and queued messages at
512 including reserved completions. Trace admission reserves both start and end
capacity, so overload skips new traces instead of leaving completed work active.
Dropped counts explicitly make incomplete tracing visible. Fixed MCP tools,
resources and prompts handler names are retained alongside mem/api names. The main-loop
heartbeat age and the snapshot's own age are separate: a stale snapshot does not
prove that its last heartbeat still describes the process. A whole-process
suspension or native failure can prevent the diagnostic thread from running too.

After the existing third failed responsiveness probe and before owned shutdown,
the daemon writes one create-new `logs/stall-<run-id>.json`. It validates snapshot
run/PID identity and whitelists its fields, then samples the exact owned engine
and worker's cumulative CPU time, working/private memory, and up to 32 OS thread
states/wait reasons. A missing, invalid or mismatched snapshot is classified and
does not prevent the OS sample or recovery. This is a wait-state sample, not a
native call-stack dump or a proven deadlock diagnosis. Unavailable OS samples
remain explicitly unavailable. Existing incident files are never overwritten.

There is one rolling snapshot and at most one stall incident per daemon run,
alongside the existing run logs; no separate service, storage queue, graph write,
provider call or Qwen startup is introduced. These files are installation logs,
not release payload. Preserve the relevant incident while investigating its
cause and apply the host's log-retention policy with the other run logs. Normal
SDK results/errors are unchanged, the diagnostic thread does not keep an exiting
worker alive, and diagnostic IO failures do not block the existing recovery path.
A diagnostic thread or IO failure emits one fixed warning per run without error
details, paths or payloads; IO retries continue on the existing one-second cadence.


### Hidden desktop windows and capture continuity

The Windows watcher keeps AgentMemory available while an identity-verified
official Codex process is alive, even when no top-level window is visible.
Background turns can continue with hidden windows; window absence alone is not
proof of app exit. Window probe results remain diagnostic. Unknown identity
preserves the service, and verified app exit still uses the existing graceful
stop path. MCP leases alone never extend its lifetime. Closing a window while
Codex remains in the background therefore no longer stops AgentMemory; fully
exiting Codex does. Qwen foreground priority and owned-instance cleanup are
unchanged.

This prevents the observed hidden-window shutdown gap. It cannot recreate a
hook invocation the host never delivered or retroactively capture requests
lost during installation. Missing historical observations require the official
exact-project import lifecycle with original provenance; no alternate queue
or database is introduced.

### Native reconciliation warnings

From preview.10, discovery accepts a working-directory transition already
verified by the native capture cursor when it matches the current index. It
retains the session's project and original ownership; unrelated paths, owners
or source kinds are still rejected. Archive/restore moves retain the existing
file-identity, source-metadata and cursor checks.

A placeholder index row with `source=unknown`, empty `cwd` and null
`thread_source` can be classified from its exact original header. The adapter
requires a supported source, matching session identity and supported user task
kind, keeps the existing bounded header read, and never rewrites the Codex
index. Missing, contradictory or unsupported source evidence stays unknown.
An absent source is pending creation only when all optional index usage signals
are explicitly empty and no canonical session, observation, summary or capture
exclusion exists. A used source disappearing remains an issue. Pending entries
are rechecked, without permanent suppressions or fabricated empty memories.

Agent-created tasks can receive their initial request through a delegation
tool result. Verified task metadata now makes their own final answers eligible
for capture, even after a large tool-only prefix. Tool output itself is not
copied into conversation memory, internal tasks remain excluded, and previous
reviewed-final provenance is retained on an exact correspondence.

Managed native capture publishes a bounded, in-memory diagnostic summary through
the existing `/agentmemory/livez` and `/agentmemory/health` responses. `nativeCapture`
reports recent attempts, completed drain batches, the last completed discovery
cycle, discovery/capture issues, and known failed graph extractions in initialized
native sessions. `checking` describes an operating reconciler, **not** proof that
every source has been read or every graph is current. Discovery problems remain
visible until a complete subsequent discovery cycle is clean. A drain with no
completion for more than three minutes is `stalled`; this diagnostic does not
cancel it, launch a competing drain, or change Qwen ownership.

The next genuine managed user-prompt hook reads this summary with a one-second
deadline and returns a fixed `systemMessage` warning for missing/disabled/stalled
reconciliation, outstanding issues, graph failures, or a required write recovery.
Normal `local_qwen_deferred:*` yields are not counted as graph extraction errors.
Warnings contain no source content, session identifiers, paths, or raw errors.
The authenticated hook requests `livez?notify=true`. Within a worker lifetime,
the existing liveness handler compares one in-memory aggregate status snapshot:
unchanged status and issue counts suppress repeat warnings, while status/count
changes or a worker restart allow a new warning. Timestamp changes and another
failure of the same kind alone do not repeat it. Ordinary health/liveness reads
do not consume this comparison. This is a notification attempt, not proof that
a person read it; no persistent queue or delivery-acknowledgement store is added.
If the liveness request itself fails, each newly failed prompt check may warn.

Capture errors in `SessionStart`, `UserPromptSubmit`, and `Stop` also return a
warning and exit zero so Codex can consume the warning and continue the user's
work. This is notification transport success, **not** a successful capture; no
capture-completion state is written by that error handler. `SessionEnd` and invalid
payloads retain the nonzero error path. Existing recall context shares the same
single JSON output when capture succeeds.

Codex documents `systemMessage` as a warning in its UI or event stream in its
[hook output contract](https://learn.chatgpt.com/docs/hooks#common-output-fields).
Hook delivery still requires a running, configured Codex host and an applicable
hook event. This is not an out-of-app desktop notification service, and generating
warning JSON alone is not evidence that a person saw it. Whole-corpus and live
host acceptance remain separate from these diagnostic and adapter tests.

### Retained unresolved legacy captures

Explicit full-inventory initialization may use `retainUnmatched: true` to keep
intact, unbound legacy observations whose native correspondence cannot be proved.
Their IDs, contents, ownership and graph provenance stay unchanged. Confirmed
native messages are captured with their own deterministic identities; a retained
legacy observation is not declared a duplicate or assigned a guessed source.
The existing session capture state records matching-relevant fingerprints, and
changed records require reconciliation. Protected, native-bound, raw and forgotten
records are never eligible for this option. Preview identity covers the option.

Native `caught_up` describes the source cursor only. Initialization, capture and
source inspection report unresolved counts. A proven source with reviewed legacy
ambiguities is `ready_with_unresolved`; newly changed or unreviewed correspondence
still blocks reconciliation. The scheduler reports historical unresolved counts
separately from current capture failures. Graph processing may continue, but these counts must not be
reported as complete historical correspondence. Archiving preserves this status;
individual forget is blocked until correspondence is resolved. Lifecycle transfer
discards trusted capture checkpoints and requires reinitialization with a new
explicit review. No observation is deleted, rewritten or automatically archived.
