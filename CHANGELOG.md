# Changelog

This file records public releases of **AgentMemory for Codex on Windows** only.
The upstream AgentMemory release history remains in the
[upstream repository](https://github.com/rohitg00/agentmemory/blob/main/CHANGELOG.md).

## Unreleased

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
- Internal qualification revision r58 is provenance, not the public version.
