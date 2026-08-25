# Public Preview Roadmap

This roadmap describes the downstream only. It is not an upstream AgentMemory
roadmap or a delivery promise.

## Technical Preview

- Publish a source-only 0.1.0-preview.1 repository with English and Korean
  entry documentation.
- Validate the Windows/Codex build, managed hooks, exact-project writes,
  federated recall labels, and optional local-Qwen graph boundary.
- Enable Windows CI and private vulnerability reporting.

## Before a stable release

- Replace source-build-only installation with a reproducible, signed release
  artifact or state clearly that source builds remain the only distribution.
- Publish a tested upgrade and rollback matrix.
- Define a supported Codex version range and a security maintenance window.
- Reassess plugin-marketplace distribution separately from the managed Windows
  installation profile.

## Out of scope for this preview

- Publishing packages under the upstream @agentmemory namespace.
- Claiming official upstream status or support.
- Cloud-hosted memory storage or external LLM fallback.
- Silent migration or deletion of canonical AgentMemory data.
