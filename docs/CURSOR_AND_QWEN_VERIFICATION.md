# Cursor and Qwen verification scope

This is unreleased source verification, not an installation or recovery receipt.
Published preview.18 is unchanged; source prepares unpublished preview.19.
Compatibility version 0.9.30 and data contract 5 are unchanged.
No operating cursor or user observation is repaired by these changes.

## Import-safe diagnostics and investigation correction

The package root (`dist/index.mjs`) intentionally starts the worker when imported:
`startWorkerForEngineState` in the CLI relies on that behavior. Hashed runtime
chunks are private executable internals. Do not import either for introspection.
The separately bundled `@agentmemory/agentmemory/diagnostics` exports only
`canonicalCodexCwd`, `parseCodexSourceIdentity`, and `readCodexSourceIdentity`.
Importing it does not start a worker. The last function reads source metadata only
when explicitly called with an exact root, relative source path and session ID.
Do not print returned paths or metadata into public diagnostics. Identity results
contain metadata only, but compressed/segmented sources may require substantial
reads under the existing reader budget. This is not a bulk-history introspector.

The packaging regression imports the built subpath and an encoded file URL,
including spaces and `#`. It blocks common file-write, child-process, network and
background-timer APIs before import, verifies those guards with synthetic misuse
probes, reads one synthetic source, and checks unchanged fixture content and an
empty isolated home. These checks do not claim exhaustive sandbox enforcement.
The intentional CLI startup path and package root are unchanged.

During host investigation an installed worker chunk was incorrectly imported.
It registered another worker, overwrote a user-profile PID file, created a new
user-profile secret file, and wrote an unreadable legacy-audit migration marker
in the shared KV. The inspection process was identified and stopped. The managed
service subsequently failed three responsiveness checks and was automatically
restarted. Temporal association is established; the failing HTTP endpoint and
precise restart mechanism are not captured. A later diagnostic accidentally read
the old run's file and incorrectly described the original worker as still live;
current-run process and runtime-state evidence corrected that statement.

The managed service uses a separate synthetic home and injected encrypted secret.
Its restart health does not restore the overwritten profile PID or migration
marker. Their previous values are unknown. No restoration or deletion was
attempted. No complete observation/graph snapshots exist for the incident, so
unchanged global observations or graph state cannot be asserted.

## Cursor identity and safe triage

The native reader compares the persisted cursor's file identity with the current
physical/logical reader identity. Plain files use device/inode; compressed readers
include their physical snapshot; combined history segments use a derived identity.
Compression, replacement or relocation can therefore change identity without
proving that logical messages changed. The reader still rejects the old cursor.
A `file_identity` diagnostic alone cannot establish unchanged content or data loss.

Read-only status now exposes only allowlisted cursor reasons, non-negative safe
snapshot byte counts and SHA-256 comparison digests. It excludes paths, parser
state, message content and unexpected fields. Invalid diagnostics are omitted;
the original warning, affected-session count and canonical state are preserved.

Discovery reports stable categories for read-budget exhaustion, incomplete native
inventory, unverified correspondence, changed source holds and scope mismatch.
Unexpected errors remain a generic failure with incomplete diagnostic coverage;
raw exceptions are not returned. Classification never advances or resets a cursor.

The existing compressed/uncompressed transition path requires unchanged source
metadata and complete native-to-observation correspondence before initialization.
A raw replacement does not qualify for this automatic transport transition, even
if its bytes are identical. It requires the existing explicit preview and its
matching expectedVersion. Changed content, truncation or a stale preview must
remain blocked. Missing originals are different from duplicates and must not be
silently accepted. Previously reviewed source holds and unresolved observations
retain their existing disposition; do not reopen them from aggregate counts.

Before any operating reconciliation, identify exact project/session/source and
rejection reason; preserve the raw/compressed source set and existing observations;
obtain a complete read-only correspondence preview; review every adoption,
missing observation, content repair, hold and retained unmatched row. Obtain
separate approval for that exact operating mutation. Use the managed lifecycle
and a matched cold code/config/data recovery set before application. Rollback is
that complete recovery set, not an ad hoc cursor edit. Never edit the DB directly.
This source qualification performs none of those operating steps.

## Historical privacy compatibility

A complete native inventory may prove that a canonical source-linked capture
contains the exact redaction produced by the fixed historical privacy rules.
An absent optional observation project is accepted only through the exact
canonical session ID/project/owner read by the caller. Separate hook and native
timestamps are retained; matching uses the stored native provenance timestamp,
key, message ID, kind, ordinal and offset. The existing proved final eligibility
transition remains consistent with the canonical provenance check. Both stored
narrative and source digests must match the historical digest. Incomplete
inventory, explicit scope conflicts or unproved source/content remain blocked.
The source change does not restore redacted text or authorize operating repair.

## Isolated Qwen lifecycle test

`test/graph-observation-result.test.ts` connects the real backlog selector, graph
extractor, XML parser, graph write/completion state and scheduler to an isolated
in-memory KV. One synthetic observation and a deterministic provider response
exercise automatic background startup, graph completion, empty-backlog idle
release, a borrowed instance, and a consumer-guarded release retry. The production
host lifecycle adapter runs against an injected host invocation; no server process,
GPU workload, external API or user record is used. The test checks exact ownership
arguments, unchanged observations and no duplicate extraction on a later wake.

This proves composition of those source paths. It does not prove current model
quality, GPU admission, a live llama-server startup, OS socket access, or global
operating backlog completion. Existing provider transport and lifecycle tests
cover their separate contracts; do not present mocks as live model acceptance.

The normal idle-release default is five minutes of empty backlog. Only a service
owned instance is released with its owner token; borrowed instances and active
consumers remain protected. A missing Qwen process can be normal idle behavior.
A real isolated Qwen test remains unexecuted: the current host launcher has a
fixed configuration path, and the worker has a shared hardcoded state directory.
Changing only the port would not isolate ready/state/ownership records. A future
review must cover separate configuration, state, ready signal, KV and home while
retaining shared GPU admission and exact ownership checks on both start and stop.
An old ready-signal file alone is not current readiness evidence. A release log
without a timestamp/reason cannot prove which release condition fired.

## Codex thread/read boundary

`thread/read` access denial during Desktop background hydration is distinct from
native source collection and graph extraction. Retain the request method, error
code, source and timestamp; never bypass the denial or change account/ACL policy.
The current native thread read handler and error mapping must be compared with
the exact upstream base before attributing a regression to an adapter.
Unchanged handlers plus an incoming Desktop RPC error narrow attribution but do
not prove the behavior of a remote thread store, account permission or closed
Desktop code. A causal upstream defect requires an authorized reproducible
baseline; absence of the error text in adapter sources is not sufficient.

## Verification commands and boundaries

Use an owned temporary directory and the existing Windows/Codex validation
entrypoint for a candidate source checkout. The targeted source set is:

```text
vitest run test/codex-source-status.test.ts test/codex-source-backlog.test.ts
  test/codex-source-capture.test.ts test/graph-observation-result.test.ts
  test/local-qwen-lifecycle.test.ts test/semantic-graph-backlog.test.ts --no-cache
```

`codex-source-capture` tests exercise identical raw replacement with an explicit
preview, content changes and truncation after compression, stale-preview
rejection, repeated capture without duplicates, and preservation of canonical
observations. The existing unchanged compressed transport regression remains.
Qualification results and initial failed test attempts belong in the local work
record. No new public version, Windows platform qualification or distribution
receipt is implied by these source tests.

## Explicit recall scope and build-tool verification

The current-only permission is preserved through discovery, original expansion,
graph queries and source reuse even when local results are empty, degraded or
unavailable. A later scope-only restriction retains the concrete topic; only an
explicit user all-project request reopens federation. Korean/English regression
fixtures cover scope withdrawal, same-topic progress/status requests, conflicting
scope and quoted/assistant/tool text. Their bounded grammar does not establish
correct interpretation of every natural-language phrasing.

Earlier checkpoints separately recorded 122 scope/continuation/builder checks,
270 subsequent packaging checks, six missing-tsdown failures and a later
six-scenario lifecycle plus two-case diagnostics-import pass. These runs have
different inputs and scopes; do not sum them into a whole-product pass. Initial
failures remain failed history. The diagnostic package was disposable and was
not installed. Runtime code is unchanged by the subsequent build-tool/document
alignment, while affected builder checks require their own new result.

The downstream declaration and Windows CI now select pnpm 11.25.0, the version
used for the prior local build and isolated checks. New builder fixtures exercise
matching/mismatching versions, a failed probe and invalid declarations before
dependency installation. They use synthetic Git/pnpm responses to test control
flow and do not prove Git identity, real installation or pnpm 11.19.0 support.
The original dependency lock and upstream provenance record are unchanged.

Full candidate qualification remains **HOLD**: restricted tests, current-source
operating automatic recall/manual search and Qwen/native graph provenance,
the matching Windows fresh-install/managed-update/restart/failure-recovery matrix,
and the final distribution verifier have not been completed for this revision.
No operating service, authentication, model, data or public artifact is changed
by this work. Final hashes/results belong to the exact execution record; a
documentation update does not requalify an earlier manifest.
