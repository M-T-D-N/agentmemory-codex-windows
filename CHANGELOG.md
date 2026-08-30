# Changelog

This file records public releases of **AgentMemory for Codex on Windows** only.
The upstream AgentMemory release history remains in the
[upstream repository](https://github.com/rohitg00/agentmemory/blob/main/CHANGELOG.md).

## Unreleased

No unreleased changes.

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
