# Changelog

This file records public releases and unreleased source changes of **AgentMemory for Codex on Windows**.
The upstream AgentMemory release history remains in the
[upstream repository](https://github.com/rohitg00/agentmemory/blob/main/CHANGELOG.md).

## Unreleased

- Recognize captured Codex working-directory transitions without changing the
  session's project ownership. Preserve source identity and archive-move checks.
  Recover placeholder index entries only from verified original headers, and
  treat missing sources with no conversation evidence as pending creation.
  Missing used sources and unverified metadata remain visible as issues.
- Allow a bounded 60-second engine cold start when loading persisted state, and
  keep update readiness within a 150-second overall window. Confirm stopped
  partial starts even when no worker identity was created; never restore files
  while a recorded process remains alive.
- Capture final answers from verified agent-created Codex tasks whose initial
  request arrives as a delegation tool result. Preserve internal-turn exclusion
  and let these tasks advance beyond a tool-only first discovery window. Keep
  prior reviewed-final provenance when the same exact source is now eligible.
- Exclude archived memories from the `recall_context` prompt before its
  bounded latest-memory feed, while preserving live results and fail-closed
  archive reads.

## 0.1.0-preview.9 — release candidate

- Separate the engine's caller metadata from archive business inputs so real
  inspect, candidate, list, archive and restore requests reach their handlers.
  Public REST/MCP requests still reject unknown fields and caller-supplied
  metadata; exact-project ownership and preview evidence remain required.

- Rebuild large graph search indexes through bounded pages from the managed
  StateModule, preserving canonical nodes, relationships and source provenance.
  Missing page support, oversized records, inconsistent inventory and interrupted
  writes fail explicitly; a partial derived index cannot claim exact completion.
  Portable engines retain their whole-response safety limit.

- Measure managed Windows health CPU usage against available processor capacity,
  retaining the original core-equivalent measurement in the response. A busy
  core alone no longer rejects startup or MCP readiness on a multicore host;
  event-loop, connection and sustained capacity thresholds remain enforced.

- Measure managed Windows memory pressure against the configured V8 heap
  capacity while preserving the raw `heapUsed`, `heapTotal`, and RSS readings.
  Portable profiles retain the existing committed-heap denominator.

- Resume unfinished native capture sweeps through bounded serial batches instead
  of waiting one minute for every eight sessions. Stable source ordering prevents
  hook checks from postponing a partially read conversation. Progressing large
  sources continue through the existing canonical cursors, while incomplete tails
  and failures return to ordinary polling. Health distinguishes a completed sweep
  from individual batch activity; no separate queue or Qwen launcher is added.

- An explicit, version-checked source review can preserve an unmatched user
  display item as a source hold while collecting later genuine primary messages.
  The held item's source and completion fingerprints remain visible; it never
  becomes a fabricated observation. Future unknown items still block capture.
  Held sessions use capture/cursor version 2, which older readers reject, and
  transfer preserves the hold while requiring local source reconciliation.

- Explicit native initialization can retain unresolved legacy captures without
  blocking confirmed source messages. Existing contents and IDs remain intact,
  health reports unresolved counts, and ambiguous individual forget stays blocked.

- Reconcile supported normal Codex history from the native thread index and
  message identities. Bounded discovery and incremental capture recover missed
  hooks while preserving distinct repeated messages, excluded host/subagent
  traffic, proven ownership, and supported fork/continuation boundaries. Ambiguous,
  missing or unsupported sources remain explicit instead of claiming completion.
  Preserve native source identity across proven in-thread cwd changes. Complete
  source history can verify an existing canonical cwd without moving its project,
  observations or graph provenance. Existing captures omitted from a later native
  source generation can retain an exact earlier source path after same-session,
  full-content and unique-correspondence checks; current replay boundaries and
  existing IDs stay intact. Initialization, restart, source relocation,
  ownership reconciliation and transfer retain the same binding checks.

- Preserve user requests following complete marked browser/UI context blocks.
  Native replay, session visibility and first-prompt summaries now agree on the
  remaining user text; internal-only and incomplete host payloads stay excluded.

- Explicit full-inventory reconciliation can link multiple proven captures of
  one native message while preserving every observation ID and full source body.
  Linked duplicates remain compatible with archive/restore and future capture;
  partial forget refuses to leave a surviving copy or an orphaned source link.
  Managed data contract 3 prevents an older runtime from ignoring these links.

- Recover interrupted raw captures and verified legacy text transformations in
  place, preserving observation IDs, image data, provenance and index retry.
  Exact native evidence can restore a truncated synthetic answer, a missing
  terminal LF or image-wrapper serialization. Legacy prompts that differ only
  by stripped ASCII boundary whitespace, including exact 400-character synthetic
  truncation, can be restored from a unique nearby native source. Internal
  whitespace, competing messages and protected records are not normalized. Existing final answers excluded
  from normal capture can retain their source provenance without collecting new
  internal responses. Preview and inspection preserve ambiguous and protected
  records as unresolved instead of guessing their source.
  Restore legacy timestamps that lost their UTC designation and fractional
  seconds only when native calendar fields, the complete body and unique source
  correspondence prove the original instant.
  Reconcile historical recovery records whose content-part assembly added
  image or blank-part separators only when their deterministic observation ID,
  exact source turn/time and complete stored-body digest prove the old encoding.
  Adopt delayed final-response captures when the exact turn and complete answer
  prove a unique native source, preserving the original collection time. Restore
  user prompts truncated by the upstream 400-character synthetic compressor only
  when its complete encoding, original type/confidence and unique source agree.
  Preserve already deleted, content-free legacy observation rows as lifecycle
  metadata instead of treating them as uncaptured conversations. Surviving
  content, restored rows and source-bound protected rows remain blocked.
  Reconcile historical user imports identified by a displayed message item only
  after complete native history proves its unique primary message, matching
  turn and full unchanged body. Preserve the original observation and collection
  time, and report the adoption separately without collecting display duplicates.

- Track graph completion per source observation, including valid zero-node
  results and older gaps. Recover interrupted canonical graph assignments and
  deletion through the existing StateModule store and writer coordination; do
  not substitute a second graph database or advance failed work as complete.

- Require the pinned downstream iii-engine 0.11.2 durability patch for managed
  writes. Confirm file persistence before recording completion and fence writes
  after uncertain outcomes. The patch and build identity are shipped with the
  engine's Elastic License 2.0; this is not an official upstream engine binary
  or a guarantee against every storage-device or power failure.

- Add reversible, exact-project archive inspection and lifecycle operations in
  the canonical store. Preserve original IDs, relationships and provenance,
  apply shared visibility across ordinary readers and backup/restore, and keep
  explicit forget separate. Retention/TTL candidates are read-only previews;
  this release does not activate automatic archiving. Legacy mesh exchange that
  cannot preserve archive state fails explicitly rather than re-exposing it.

- Preserve capture exclusions, archive state and graph completion provenance
  through supported export/import and snapshots. Managed data contract 2 rejects
  unsafe downgrade and prevents automatic predecessor restart after candidate
  startup or contract transition failure. A compatible data backup is required
  for a deliberate downgrade; the installer's code/config backup is insufficient.

- Apply canonical project/agent scope before search candidate limits, preserve
  durable-memory ownership and compact/expanded lookup, and retain bounded reads.
  Hidden Codex windows no longer imply desktop exit or stop normal capture.

- Search the current project before automatic cross-project recall, preserve
  source IDs/timestamps and deduplicate scoped results. Short follow-ups can
  reuse a recent topic from the same source session within the existing lookup
  budget. Candidate searches use the existing non-reinforcing
  access option so unused results do not affect retention. Local read failures
  do not broaden scope, and fallback queries share the existing retrieval deadline.

- Keep failed native-capture index saves pending for retry, and make repeated
  indexing of the same observation preserve document lengths and search terms.
  Repair legacy relative working directories only when the exact native source
  and thread index agree. Existing protected empty observations remain untouched
  when their ownership is already correct; incomplete legacy session metadata
  no longer interrupts otherwise valid context reads.

- Avoid rewriting an already committed BM25/vector snapshot for unchanged or
  overlapping flush requests. Native capture still requires successful storage,
  failed saves remain retryable, and intervening changes are persisted in order.
  Reindexing unchanged observations preserves snapshot and search tie order.
  Previous-shard cleanup stays sequential with one audit containing every target
  and deletion outcome; persisted formats and canonical data are unchanged.

- Reuse graph traversal adjacency across matching entities and yield between
  traversals to reduce blocking during broad recall, while preserving candidate
  scope, ordering and provenance. Treat incomplete graph snapshots as degraded
  results. Label recalled decision excerpts with their source time and require
  verification before treating historical claims as current facts.

- Surface managed native-reconciliation and known graph-extraction problems in
  the existing health/liveness diagnostics and Codex hook warnings. Retain
  discovery issues across partial passes, distinguish ordinary Qwen yield from
  extraction errors, and keep capture failures visible without blocking the
  user's Codex work. A recent successful batch never claims whole-corpus or
  graph completion. Repeated unchanged diagnostic warnings are suppressed within
  the worker lifetime; status/issue-count changes can notify again. Ordinary
  health checks do not consume notifications, and no second queue or data store
  is created. A notification attempt does not prove human receipt.

## 0.1.0-preview.8 — 2026-09-12

- Preserve forward and bootstrap-backfill progress when explicitly extracting
  older observations. Compare official timestamp/ID order against the current
  cursor under the existing session lock; unsorted inputs cannot rewind it.
  Historical provenance is still extracted, and genuinely unprocessed tails
  remain pending. Unknown cursor positions are preserved for explicit repair.

- Reopen graph processing when an import writes observations beyond an existing
  session's processing cursors. Notify the existing scheduler after exclusive
  import access ends. Preserve capture metadata, graph cursors, complete backup
  restores, duplicate-only imports and count-only repairs. Disabled extraction
  remains disabled; a failed wake notification does not fail a committed import.

- Preserve bounded stall evidence before the existing Windows runtime recovery.
  A diagnostic worker thread records function/state-operation names and timings,
  main-loop heartbeat age, and memory counters without inputs, values, keys,
  credentials or error text. The daemon retains an incident with owned process
  CPU/memory and thread wait states, even when the main loop cannot respond.
  Missing diagnostics never prevent recovery; no additional watchdog is added.
  Reserve completion capacity when admitting diagnostic traces so an overloaded
  queue cannot permanently fill the active list with completed work. Preserve
  fixed MCP handler names and warn once, without sensitive error details, when
  the diagnostic thread or its file output fails.

- Recalculate session observation counts from stored rows after import, including
  skipped existing sessions and empty observation buckets used for count repair.
  Preserve existing metadata with field-only count updates. Run imports under
  the existing exclusive observation lifecycle; refuse active writers before
  mutation and settle every started chunk write before releasing the boundary.
  Failed skip lookups for sessions or observations no longer allow overwrites.

- Recover a live but unresponsive Windows worker after three consecutive
  lightweight checks. Honor authenticated stop requests through bounded,
  identity-checked cleanup. Preserve the existing watchdog, runtime data and
  upstream dependency versions.

- Follow [upstream AgentMemory's dependency version](https://github.com/rohitg00/agentmemory/blob/main/package.json):
  retain iii-sdk 0.11.2. PR #9's proposed 0.23.0 fails type checking because it
  removes the ISdk API used by this source. Review future minor/major SDK
  updates against upstream and bundled-engine compatibility before adoption;
  patch updates and other dependencies remain eligible for Dependabot review.
- Use Dependabot's automatically created default labels instead of custom
  labels that were absent in this repository. No runtime dependency, installed
  release or memory data changes are included.

## 0.1.0-preview.7 — 2026-09-09

- Clear the startup retry restriction after both conditional Qwen startup and
  its provider probe succeed. Newly eligible work after normal idle shutdown can
  start again; failed startup, failed readiness and host refusals keep the
  15-minute backoff. Keep the five-minute idle policy and ownership guards.
- Reject existing-install workspace changes that would disconnect a working
  LocalAI launcher before cutover. Report transport cause codes and loopback
  endpoints, and identify missing automatic-start integration separately.
- Follow canonical decision successors in bounded graph recall, retaining
  source-project boundaries and history; abstain on failed, incomplete or cyclic
  successor expansion instead of presenting an obsolete decision as current.
- Add restart-after-idle and failure-backoff regressions, transport diagnostics,
  installer refusal coverage and successor-recall tests. Preserve compatibility
  version 0.9.29, canonical data, cursors and provenance without migration.

## 0.1.0-preview.6 — 2026-09-09

- Connect eligible graph backlog to the existing Windows LocalAI conditional
  launcher, automatically after observation writes and service recovery probes.
  Reuse the canonical batch selector in read-only mode before cold startup.
- Preserve host manual holds, memory admission, shared GPU ownership and active
  consumer guards. Coalesce startup, back off denied admission for 15 minutes,
  and release only this worker's exact instance after five idle minutes.
- Keep hooks nonblocking and preserve existing graph cursors, fairness, source
  provenance, output-budget blocks and manual curation. No schema migration.
- Add startup, empty backlog, hold, ownership, busy-release and shutdown-race
  coverage. LocalAI remains an optional external host dependency.

## 0.1.0-preview.5 — 2026-09-09

- Require a concrete topic, filename, or identifier before automatically injecting
  recalled memory or graph context. Generic follow-ups and product names alone
  no longer trigger automatic retrieval; explicit MCP search remains available.
- Apply the same relevance condition across projects and graph neighbors while
  retaining source labels, decision replacement history and existing budgets.
- Preserve filenames and digit-leading IDs, handle common Korean particles, and
  avoid substring matches such as RAM/program. Lexical matching can still miss
  synonyms or unfamiliar inflections; it is not a semantic relevance guarantee.
- Add nine adapter regression cases covering relevance, history, source labels,
  identifiers, request bounds and failure behavior. No memory schema or provider
  changes are included.

## 0.1.0-preview.4 — 2026-09-09

- Add an independent, dependency-free npm/npx installer launcher with a pinned
  GitHub release archive, size/SHA-256 and manifest/source identity verification.
- Add empty-root first-install preparation and separate explicit activation,
  preserving CurrentUser DPAPI, existing task ownership, hooks and OAuth setup.
  Existing-install updates continue through the protected cutover/rollback path.
- Package physical hoisted runtime dependencies for ZIP delivery, require clean
  source identity, and retain upstream notices and the iii engine's Elastic
  License 2.0 in both distribution and installation.
- Add launcher, tamper, extraction, and isolated first-install regression tests.
  Preparation is exercised locally; task activation is validated with isolated
  mocks and refusal cases, not an additional live service on the qualification PC.

## 0.1.0-preview.3 — 2026-09-09

Source-only prerelease collecting the changes on main since the published
preview.1 GitHub release, including the preview.2 source line below.

### Added

- New committed observations wake the existing semantic graph backlog scheduler,
  so arrivals while Qwen is already ready need not wait for a readiness event or
  the 15-minute recovery probe. Rejected and duplicate observations do not wake
  it; wake failures preserve successful observation storage.
- Updated English, Korean, and Japanese guides and the agent installation runbook
  with graph timing, verified-decision curation, host-owned Qwen startup boundaries,
  pinned source evaluation, and immutable-revision update instructions.

### Fixed

- Fixed managed hooks rejecting a version 3 project registry that uses
  `relocation_ref`. Resolve exact batch destinations and declared nested Git
  roots while preserving cutover, retained-source, and canonical-path checks.
  This prevents unrelated reference entries from breaking normal turn capture.

- Reconciled the public development branch with the later local recovery and
  provenance fixes. Restored bounded graph queries, strict graph XML parsing,
  neutral MCP retrieval, session lifecycle serialization, and Qwen readiness
  event drains without replacing the canonical iii data store.
- Kept r80 cursor-tail completion, approval-review exclusion, exact capture-turn
  matching, recoverable empty observations, and explicit edge retirement/restore.
  Provenance edits now maintain the restored query index; derived graph writes
  also reject references to recoverably deleted observations.
- Kept the local Qwen JSON fallback, adaptive input budget, 32768 output budget,
  and 1200000 ms timeout, while restoring incomplete SSE stream rejection.
- Excluded the historical one-off session-stub recovery/purge migration from
  this source integration: it predates the current protected recovery and
  reference scopes. No live data migration is performed.
- Retained immutable versioned installation targets; the public same-revision
  package replacement path is not adopted. Publication and runtime installation
  remain separate operations.

### Compatibility and preview limits

- Downstream version is 0.1.0-preview.3; package, CLI, MCP, API, plugins, and
  export compatibility remain on upstream AgentMemory 0.9.29. No data schema
  migration is introduced.
- The source surface remains 57 MCP tools, 6 resources, 3 prompts, and 134 REST
  endpoints. The supported Windows/Codex profile activates four managed hooks.
- Source only: no npm publication, signed installer, or binary release asset.
  Public Windows CI verifies source checks; a locally generated installer has
  its own build manifest and requires separate cutover validation.
- AgentMemory does not auto-start Qwen. Optional host startup policies and
  machine-specific GPU/RAM measurements are outside this public repository.
- AI-generated and user-tested; no owner manual source review or independent
  third-party code/security audit is claimed.

## 0.1.0-preview.2 — 2026-08-30

Second public source preview.

### Added

- Opt-in non-reinforcing retrieval for administrative inspection, evaluation,
  reporting, previews, and other analytical scans. Existing clients continue
  to track access by default.

### Fixed

- Removed a redundant session-activity state trigger. On iii 0.11.2, a session
  write and its matching callback target the same worker, so registering the
  callback deadlocks the originating write even when the callback has no side
  effects. Raw and compressed observation events continue to drive the viewer.
- Kept the upstream context implementation while routing REST context and
  session-start handlers to it directly. Re-entering `mem::context` through
  iii from the same worker could deadlock a new session before recall began.
- Serialized semantic graph persistence with the matching session-forget
  lifecycle. A graph extraction that finishes after its source is deleted is
  now discarded, so background work cannot recreate a partially forgotten
  session or advance its graph cursor.
- Streamed loopback Local Qwen graph completions as SSE and reject responses
  that end without the terminal marker. This keeps generation alive past the
  llama.cpp non-streaming disconnect boundary without accepting truncated graph
  output or advancing its source cursor.
- Prevented unknown or concurrently forgotten session-end requests from
  materializing incomplete session rows in iii's file-backed state store.
  Session start, observation, completion, forget, eviction, migration, and
  graph dispatch now share the same per-session lifecycle boundary.
- Added an exact-match, dry-run-first migration for legacy Codex session-end
  stubs. It restores only caller-supplied task metadata and observations with
  deterministic IDs and source-item provenance, rejects ambiguous or conflicting
  rows, and is safe to resume or repeat.
- Added a separate exact-ID, dry-run-first migration for irrecoverable legacy
  session-end stubs that contain no source observations or task identity. It
  refuses the whole batch unless every candidate is the exact two-field shape
  and has zero session, observation, summary, memory, lesson, commit, crystal,
  and graph references; the official apply path is audited and idempotent.
- Reopened semantic graph backlog work whenever a completed session receives a
  new observation. The existing cursor is preserved, so an abrupt shutdown
  before the matching session-end hook can no longer strand an unprocessed tail
  or force previously processed observations to be extracted again.
- Detached the forgotten session and observation provenance from the canonical
  graph while preserving shared nodes and relationships. Only provenance-free
  orphan relationships and then unreferenced nodes are removed; stale indexes,
  concurrent changes, and project mismatches fail closed.
- Added opt-in exact edge pagination to the existing graph query. Stable edge-ID
  ordering, revision checks, and page hydration make duplicates or omissions
  detectable without changing the existing page-local `edges` response.

### Compatibility

- Based on upstream AgentMemory v0.9.29 at commit 2d38daf.
- Package, API, plugin, CLI, MCP, and export compatibility remain on 0.9.29.
- Internal qualification revision r62 is provenance, not the public version.

### Preview limits

- Source release only. No npm package, signed installer, binary release asset,
  or upstream support is provided.
- Native Windows with Codex is the supported downstream host profile.

## 0.1.0-preview.1 — 2026-08-25

Initial public source preview.

### Included

- Native Windows packaging and an owned-install cutover path for Codex.
- Four managed Codex lifecycle hooks: SessionStart, UserPromptSubmit, Stop,
  and SessionEnd.
- Exact-project writes and source-labelled federated recall.
- Optional credential-free, loopback-only local Qwen graph extraction.
- Official AgentMemory memory, lesson, graph, audit, and provenance stores as
  the canonical data lifecycle.
- Sharded exact graph queries with a bounded snapshot fallback that never
  launches a non-cancellable full graph enumeration when the derived index is
  dirty or unavailable.
- English primary documentation with Korean and Japanese entry guides.

### Compatibility

- Based on upstream AgentMemory v0.9.29 at commit 2d38daf.
- CLI and MCP identifiers remain agentmemory.
- Package, API, plugin, and export compatibility remain on 0.9.29.

### Preview limits

- Source release only. No npm package, signed installer, binary release asset,
  or upstream support is provided.
- Native Windows with Codex is the supported downstream host profile.
- Internal qualification revision r32 is provenance, not the public version.
