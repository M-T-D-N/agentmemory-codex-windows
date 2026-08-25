# Changelog

This file records public releases of **AgentMemory for Codex on Windows** only.
The upstream AgentMemory release history remains in the
[upstream repository](https://github.com/rohitg00/agentmemory/blob/main/CHANGELOG.md).

## Unreleased

### Added

- Opt-in non-reinforcing retrieval for administrative inspection, evaluation,
  reporting, previews, and other analytical scans. Existing clients continue
  to track access by default.

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
