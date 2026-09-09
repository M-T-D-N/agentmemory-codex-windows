# Changelog

This file records public releases and unreleased source changes of **AgentMemory for Codex on Windows**.
The upstream AgentMemory release history remains in the
[upstream repository](https://github.com/rohitg00/agentmemory/blob/main/CHANGELOG.md).

## Unreleased

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
