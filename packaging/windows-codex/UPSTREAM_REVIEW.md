# Upstream compatibility review

## Current 0.9.30 upgrade candidate (2026-10-10)

The selected target is upstream `v0.9.30`, commit
`8bf0c827aaaada297896b2b6efe2a64651ae9389`, with iii engine/SDK 0.22.1.
The source merge preserves the managed Windows capture, exact-project filtering,
complete provenance, scoped Qwen graph extraction and acknowledged file flush.
The older selective-backport decisions below are historical comparison evidence;
they do not describe the current candidate's engine or compatibility version.

The single installer selects fresh installation, an owned managed update, or
explicit adoption of a supported original file-backed 0.9.29/0.9.30 installation.
Adoption keeps original data, verifies its copied recovery set, carries supported
operational settings and authentication, and preserves the existing five ports.
An unqualified newer version is rejected before changing it; unsupported storage
requires its explicit export/import path. Recovery never guesses process ownership.

Qualification requires actual Windows fresh-install and old-version update runs,
including original-package adoption, preserved historical records and graph sources,
authenticated REST/MCP access, filtering, restart persistence and recovery.
Source/unit checks and isolated engine fixtures are supporting evidence, not a
substitute for installed-runtime E2E. Diagnostic overlays are not release acceptance.

Actual diagnostic installation exposed custom-port scheduled-task checks and a
REST `remember` source-forwarding omission; both were repaired and verified through
the installed REST/MCP paths. Original-package inspection also exposed PowerShell's
reserved `HOME` name; inspection now uses the selected source home and a scoped
regression. The public preview.15 remains a candidate until installation E2E completes.

Diagnostic adoption of both official npm 0.9.29 and 0.9.30 preserved 25 original
REST-written records, observations, engine-API graph fixtures, authentication,
ports and the vector bucket setting. A deliberately failing startup exercised
the real original CLI recovery. It exposed leftover candidate registrations and
requirements; recovery now removes only the verified registrations and unchanged
requirements created by that attempt, marks `adoption_failed`, and leaves both
source data and copied recovery data intact. Stopped-install configuration lookup
and quoted environment settings follow the original CLI's selected inputs.

Role: upgrade guide and fixed comparison evidence, not an installation or migration contract.
Reviewed 2026-09-30 through 2026-10-01 KST.

The comparison is upstream `v0.9.29` (`2d38dafede67d0d4ed920cde94d2106e98825b8a`)
to main `29ecfde4df5998d913991049629014baa024600a`: 26 commits ahead, none behind.
The local comparison parent is `a5439c454ebe3f7c4bb6deb0706800904a3410a0`.
[Immutable upstream comparison](https://github.com/rohitg00/agentmemory/compare/v0.9.29...29ecfde4df5998d913991049629014baa024600a).

This preparation selectively backports behavior; it does not change `upstream-source.json`,
the compatibility version, engine/SDK pin, data contract or installed runtime.
“Adopted” below means committed source with scoped validation, not deployed software.
“Candidate” and “deferred” do not mean a newly observed live incident.

## Commit decisions

| Upstream commit | Purpose | Downstream disposition |
|---|---|---|
| [e04ba888](https://github.com/rohitg00/agentmemory/commit/e04ba88819c365c9acf9d6661ea802143e728bd6) | Portable CLI paths, install and persistence | Keep the qualified managed launcher; live-add scheduling is adapted below. The portable CLI rewrite is not adopted wholesale. |
| [d5478836](https://github.com/rohitg00/agentmemory/commit/d54788361b89452a812315960676b0c6040b9329) | SDK/engine 0.19.7 and live persistence | Keep patched 0.11.2. Adapt completed-record save scheduling; startup reconciliation of nonempty indexes is adapted in the follow-up below. |
| [bb6cef38](https://github.com/rohitg00/agentmemory/commit/bb6cef38990bddb2af14e98464628f76fb043cc7) | SDK/engine 0.22.1 | Defer the coupled engine/SDK upgrade; preserve file-flush-v1 and existing data compatibility. |
| [20f26e4e](https://github.com/rohitg00/agentmemory/commit/20f26e4e1026d87125724f1ca430c8100464350c) | Status API and Health tab | Candidate: adapt status to managed hold, disabled providers and current diagnostics; do not copy upstream remediation commands. |
| [b1463827](https://github.com/rohitg00/agentmemory/commit/b146382797c7b098687f36a8976687db582a9632) | Viewer streams, retained data and counts | Candidate: retain last good panels/counts on refresh failure. Exact new HTML and frontend tests need review. |
| [8deb131f](https://github.com/rohitg00/agentmemory/commit/8deb131f6e76dd51719b8c2bbf23a2228b3fbc5d) | V8 heap limit | Managed health already uses the V8 limit with fallback tests; retain it. Portable hosts are a separate scope. |
| [e5fb5e99](https://github.com/rohitg00/agentmemory/commit/e5fb5e991b16a0fd3e47a5449a206a25e813b93c) | Website Node types | Development-only dependency update; no managed runtime benefit established. |
| [f08be653](https://github.com/rohitg00/agentmemory/commit/f08be653b54d5496cee15bbd7e27aae39e686092) | Package Node types | Defer until the coupled SDK type surface is selected; no runtime feature removed. |
| [39658a93](https://github.com/rohitg00/agentmemory/commit/39658a9335287e71f61e5e3edc4b81df8882c838) | Index audit opt-in | Candidate: reduce routine index-persist chatter without dropping canonical mutation/error audit coverage. |
| [cfc19340](https://github.com/rohitg00/agentmemory/commit/cfc193408c09cd7087c7c03cd682c3d92a187840) | Throttled index saves and diagnostics | Adapted: the first 5-second save reservation is not pushed back by later writes. Preserve serialized generations, fingerprints and strict flush. Per-leg dirty/error status remains a candidate. |
| [bcf4f0d0](https://github.com/rohitg00/agentmemory/commit/bcf4f0d00d1c71e9221287a4778e4122ce2d7574) | Fixed vector buckets and canonical BM25 rebuild | Defer storage rewrite: upstream v3 layout replaces our generation manifests/readback/recovery behavior. Measure actual write cost before choosing. |
| [e69a606e](https://github.com/rohitg00/agentmemory/commit/e69a606e8faf5ccdde15723278a8bd7dd7ec047a) | Write only changed decayed rows | Provider consolidation is disabled in the managed profile. Retain policy; adopt changed-row logic if that feature is enabled later. |
| [00411d63](https://github.com/rohitg00/agentmemory/commit/00411d63f5d91546625859b55400774e99147b5b) | Oversized export HTTP 413 | Adopted: preserve the existing refusal body and return 413 instead of 200; valid exports still return 200. |
| [c2df01a6](https://github.com/rohitg00/agentmemory/commit/c2df01a62c6438c22a494faac249ab974814a3d5) | Embedding outside remember lock | Candidate: keep provenance/supersession under the lock, embed outside, then recheck existence/latest before adding the vector. A late result must not resurrect forgotten records. |
| [ec887b9a](https://github.com/rohitg00/agentmemory/commit/ec887b9a2bd919730aba0bae9cc26373dd06057a) | Recent-session patterns bound | Candidate with explicit processed/skipped coverage and ambient filters. Upstream still lists an entire session before slicing; it is not a strict I/O bound. |
| [2493bc56](https://github.com/rohitg00/agentmemory/commit/2493bc56850ac562ef68635deeb468813aee1742) | Session and graph write locks | Existing managed observation/recovery/session-lifecycle and graph-write locks must be preserved. Do not add nested upstream locks to already locked paths. |
| [c314c7bf](https://github.com/rohitg00/agentmemory/commit/c314c7bf6a59cc6d024b77a15069887876f420d2) | Project session and observation lookup indexes | Candidate: observation-ID lookup first. A capped project index must apply agent/archive/ambient eligibility before truncating candidates, and retain exact-source expansion boundaries. |
| [92d4500f](https://github.com/rohitg00/agentmemory/commit/92d4500ff3eda8de3e699b6af60f39a136a6ef98) | Stream groups and bounded backlog | Candidate: stop unused future session-group writes, including our API writer, and bound viewer backlog. Existing persisted groups are not pruned in this preparation. |
| [0c4c56fd](https://github.com/rohitg00/agentmemory/commit/0c4c56fd5aa8db2a7e6aa4e3e73583f9658a8cf4) | Viewer rebuild and all-page streaming | Deferred until the complete HTML and frontend test bodies are reviewed; backend patches alone do not qualify the new UI. |
| [2e006bd5](https://github.com/rohitg00/agentmemory/commit/2e006bd5f88f8f08c49a2df84939357a7e16ac2c) | Monthly audit scopes and retention | Deferred data migration. Adapt to acknowledged disk flush; do not enable automatic retention deletion or use save-interval sleep as equivalent durability. |
| [ab3e4efd](https://github.com/rohitg00/agentmemory/commit/ab3e4efd282659b87d31b36c8514c6bc6b871f0b) | Optional Redis state/streams | Not selected for the managed file-backed profile. Adds deployment/storage semantics without a demonstrated local need. |
| [3b328a3f](https://github.com/rohitg00/agentmemory/commit/3b328a3f35871b4172567f1bf084720191d8664e) | Captured evidence and first vector checkpoint | Adapted live checkpoint scheduling. Preserve native exact-source identity and originals; upstream source is bounded to 16 KiB/record and 8 MiB/session, not complete original text. Generic source-object import still needs compatibility review; nonempty-index reconciliation is adapted below. |
| [63c54d9d](https://github.com/rohitg00/agentmemory/commit/63c54d9d497375b5288fb7955d9e6dc1c14602bd) | Export budget, forget accounting and shutdown flush | 413 is adopted. Post-delete cleanup accounting is adapted below. Incremental export budget and shutdown completion remain candidates. Do not copy the fixed 4-second flush/8-second hard exit into the durability contract. |
| [6e3134fd](https://github.com/rohitg00/agentmemory/commit/6e3134fddadc288b9548483f9fb932c10413b2da) | Snapshot total floor | Adopted in graph-query-index pagination for all/type-filtered pages. This is a lower bound on known retained nodes, not a repair or exact live inventory count. |
| [9925c9d2](https://github.com/rohitg00/agentmemory/commit/9925c9d2000d9170ff5cef5c6c8bec8609e47930) | Graph weight zero | Adopted: skip both entity traversal and vector-chunk expansion. Preserve the independent automatic-retrieval graph exclusion. |
| [29ecfde4](https://github.com/rohitg00/agentmemory/commit/29ecfde4df5998d913991049629014baa024600a) | Failed snapshot read safety | Adopted in delta persistence and manual upsert: retry once, distinguish absent from failed/unknown schema, abort before graph/index writes. Keep existing write plans and locks. |

## Local evidence and preserved guarantees

- `src/functions/graph.ts`: manual provenance, recoverable graph write plans and the
  existing graph/session/recovery lock order remain intact. Both snapshot-to-empty
  writer paths now use strict reads; display readers keep their existing fallback.
- `src/functions/graph-query-index.ts`: exact project/query/edge inventories remain
  the primary managed query path. Snapshot pagination only floors an undercount.
- `src/state/hybrid-search.ts`: explicit weight-zero graph exclusion complements,
  rather than replaces, the automatic-retrieval budget policy.
- `src/state/index-persistence.ts`: keep generation manifests, publication/readback
  checks, content fingerprints, serialized saves, previous-generation recovery and
  `requireSuccess` flushes. The scheduled deadline starts at the first request;
  five seconds schedules a save, not a guarantee that disk I/O completes in five seconds.
- `src/functions/search.ts`, `observe.ts`, `compress.ts`: completed live additions
  reserve a save. Single late vectors reserve their own checkpoint. Bulk rebuild
  chunks suppress new reservations; completion reserves one. The follow-up below replaces partial live rebuilds with complete candidates and
  reconciles nonempty startup snapshots.
- `src/health/monitor.ts`, `thresholds.ts`: managed V8 heap-limit pressure already
  covers the purpose of #1409. This does not prove overall performance superiority.
- `src/functions/context.ts`, `smart-search.ts`: current archive/ambient/agent
  filtering and exact observation expansion must survive any new lookup indexes.
- `packaging/windows-codex/README.md`: the qualified patched engine acknowledges
  disk flush. A portable engine shutdown wait based on its save interval is not an
  equivalent replacement for that tested guarantee.

No comparative benchmark was run. Structure, existing tests and patch review support
these choices; they do not establish that the entire downstream is faster or better.

## Next formal-release integration

Use the actual new release tag/commit, not a moving `main` or its unchanged package version.
Compare from the pinned base, then subtract the backported behavior listed above so
it is not added twice. Read corrections made after this fixed main commit as well.

Keep engine/SDK as a coupled upgrade using the existing Windows build/qualification
workflow. Verify the SDK type surface and the real engine's write acknowledgement,
crash recovery, backup/restore and source/graph transfer before any local cutover.
An interval-based shutdown sleep or successful TypeScript build is insufficient.

Select storage/index changes before publishing a new data contract. Use retained,
owned recovery data for compatibility qualification; do not migrate live data,
enable Redis/audit expiry, shorten original text, or delete old scopes as a side effect.
Keep source reconstruction, canonical exclusions, archives, graph completion cursors,
Qwen manual hold and capability-scoped noop providers under their existing contracts.

Prioritize remaining candidates by effect in the supported profile: nonempty-index
coverage/reconciliation and lookup expansion first; lock narrowing/status/viewer
reliability next. Provider-only patterns/consolidation and optional Redis do not justify
changing the managed profile now. Decide each layout change against measured workload
cost and preserved recovery behavior, not the number of upstream commits.

## Validation and coverage limits

- Initial safety backports: existing Validate entrypoint passed skill checks,
  TypeScript and build; source suite passed **2,672 tests, 18 skipped** before the
  subsequent live-checkpoint refinement.
- Final checkpoint refinement: TypeScript and build passed; **96 tests in seven
  affected files passed**, including continuous-write deadline, late vectors,
  offline embeddings and a paused bulk rebuild. The full suite was not repeated
  for unchanged graph/API inputs.
- The snapshot/error, graph-weight and export regression assertions were checked
  directly. Two upstream Apache-2.0 regression test files are retained with the
  adapted source. Snapshot tests also cover absent/unknown schema and no writes
  after persistent failure; existing managed graph tests remain in place.
- All 26 commit purposes and available relevant patches were compared. Several
  upstream test patches and the full viewer HTML were omitted from the API compare;
  the graph, export-refusal and graph-weight tests were fetched at the exact commit.
  This is not an exhaustive manual audit or a new engine/Redis/UI qualification.
- No service restart, live data mutation, Qwen startup, graph drain, package release
  or GitHub publication was performed by this preparation.

Use the existing operating/packaging guide for release acceptance. This review adds
no runner, automatic update trigger or approval gate.

## Follow-up: index lifecycle and forget cleanup (2026-10-01)

The four reviewed code paths are source changes, not a diagnosis of current live
original-data loss. The engine, serialized index layouts, installed r133 runtime,
Qwen manual hold and GitHub publication hold are unchanged.

- IndexPersistence coalesces callers into one active and one pending save; every
  required caller waits for its covering snapshot and still receives a failure.
  Quiet failures reserve at most three retries (5, 15, 30 seconds). Fresh writes
  can request another save; stop cancels timers and suppresses automatic retries.
  Existing generation manifests, hashes, readback and acknowledged state writes stay.
- Rebuilds use separate keyword/vector candidates and one shared in-flight rebuild.
  Every canonical memory/session/observation read must succeed before publication.
  Changed IDs are tracked on live indexes, including removal of an ID absent from
  the old snapshot; their final live state is merged into the candidate. A reset,
  configuration change, read failure or cancellation preserves the previous generation.
  Candidate construction remains linear in the corpus; live and candidate indexes
  coexist in RAM. This is not a constant-memory or accelerated rebuild claim.
- Boot reconciles nonempty snapshots too, reusing only existing vectors whose IDs
  remain canonical. It does not silently re-embed the full corpus on this path.
  Completed publication marks keyword readiness; startup failures retry at most
  three times (30, 60, 120 seconds), with cancellation before shutdown publication.
  Exhausted retries leave the existing index readable and incomplete readiness explicit.
- Forget counts only resolved primary deletes, immediately after acknowledgement.
  Independent image, access, keyword, vector and persistence cleanup errors become
  additive cleanupFailed/cleanupFailures response and audit fields. Source exclusions,
  graph reconciliation, session updates, primary deletes and archive completion
  still reject on failure. Confirmed partial deletions are audited in finally.
  Image-ref decrements are not automatically retried because a failed operation may
  already have changed shared references. Existing swallowed image unlink errors
  are not claimed to be detectable. Other callers retain best-effort access cleanup.

Direct verification: TypeScript and 147 tests in nine affected files passed before
final source validation. Added checks cover pre-reserved saves during rebuild,
read failure, concurrent add/delete, deletion absent from the old index, late vectors,
reset/cancellation, nonempty recovery, covering-save waiters, retry limits, primary
versus cleanup failure, and preserved strict archive retry behavior. Final whole-source
validation is recorded in the retained task log; deployment qualification is separate.

Final source tests passed 2,695 checks (18 intentionally skipped), plus 88 managed recall/hook checks. Distribution validation exposed a duplicate-case inherited `PSMODULEPATH` key; the existing npm PowerShell environment helper now normalizes Windows keys before applying its native-module override and rejects conflicting inherited duplicates. All 28 distribution/build validation checks then passed. This is a validation-blocking host environment fix, not a service installation. Detailed output remains in the task-owned validation logs.

## Follow-up: managed request hardening (2026-10-10)

Compared previous reviewed main `29ecfde4df5998d913991049629014baa024600a`
with `da91cc05b3c79c59f6c0480f728bb9c09127e000`: 36 additional commits.
[Immutable comparison](https://github.com/rohitg00/agentmemory/compare/29ecfde4df5998d913991049629014baa024600a...da91cc05b3c79c59f6c0480f728bb9c09127e000).
The exact source archive was read; commit purposes were classified. This is not
an exhaustive manual audit of all changed files.

Adapted [request-hardening commit 194b0501](https://github.com/rohitg00/agentmemory/commit/194b05018dbcea31bd8f3c4431d3a677cce1960e):
the upstream Origin/JSON-body check now runs in existing common HTTP auth paths
and before the viewer forwards a request with its server bearer. Authenticated
no-Origin JSON CLI, hook and MCP clients remain eligible. Viewer Host checks and
bearer validation remain; allowed REST ports follow configured REST and actual
viewer ports, including viewer fallback and ephemeral test ports.

Before adaptation, a real local viewer POST from an unrelated Origin reached a
fixture REST server (HTTP 204), and the common HTTP check accepted non-JSON bodies.
Three regression checks failed. After adaptation these requests return 403/415
before proxying; same-origin and no-Origin JSON writes still reach the fixture.
This local HTTP execution is separate from installed-runtime qualification.

| Additional upstream commits | Managed decision |
|---|---|
| 656ed604, df3d4a83: stale sweep, idle finalization and incremental summaries | Defer automatic abandonment and provider summaries; existing native reconciliation and session lifecycle own completion. No live session rewrite. |
| e950d583, e975353e, 60b88a2a, abb87d2c, 695b7e4f, d03e88f6: capture filtering, transport, spool and host backfill | Retain qualified native capture and exact message IDs. No second spool or replacement portable hooks; other hosts not selected. |
| 1abb2cb0, 976ad3e5: bounded provenance and boot compaction | Do not truncate retained source provenance or auto-compact canonical data; preserve shared references and cursors. |
| 1c520555: unknown session end | Already handled by managed completeExistingSession and shared lifecycle locks. |
| b3d6cf50: portable engine/save limits | Linux arena/fd changes do not apply; interval saves do not replace file-flush-v1. |
| 194b0501, 803a668d, ae8946e1, 1f644359: hardening, tests/docs and merge | Adapt request Origin/JSON checks. Keep DPAPI and managed source privacy rules. Broader file confinement and write scrubbing require path-specific review. |
| 461a9004: engine download/CI pins | Existing managed source/license/hash checks cover the engine; no engine replacement or unrelated CI copy. |
| 525e8968: client secret resolution | Existing managed launcher supplies canonical DPAPI secret; no parallel secret store. |
| 9d950920, e0339030: scrubbing and atomic confined files | Remain candidates for portable file functions; not copied over managed storage/archive/export contracts without qualification. |
| cd4ca4eb, af584550, ad9e8899, 89b57716: vector pending log/backfill | Defer alternate persistence/backlog; retain generation publication, startup reconciliation and acknowledged writes. |
| f40a6c18, 2eaf74f7: packed capture gate and cost benchmarks | Keep existing Windows qualification and real hook tests; no second gate or unmeasured performance claim. |
| da78ea89: comment/reference cleanup | No runtime benefit; preserve useful failure provenance. |
| 73fa8e48: dotenv | Not used by managed runtime; no dependency/runtime update. |
| 2a00e7b3, 007a1a7f: Codex plugins | Keep managed launcher/hook/skill ownership; no duplicate registration. |
| c51bf3f2: embedding keys, structured context, Docker | External embeddings remain disabled; preserve managed recall output and Windows engine config. |
| a766b7c7: index audit regression | Retain existing mutation audits and persistence tests; do not copy incompatible newer persistence tests. |
| 359c30ad, 8bf0c827: 0.9.30 metadata and translations | Preserve 0.9.29 compatibility and independent downstream version; selective backport is not a full release upgrade. |
| c5549733: exact MCP shim | Managed versioned launcher already binds exact runtime; no latest-shim substitution. |
| da91cc05: strongest prefix scores and evaluations | Downstream already uses strongest per-term prefix scores, numeric-prefix exclusion and Hangul ranking; retain those semantics. |

Engine/SDK pins, data contract, Qwen ownership and source exclusions are unchanged.
`upstream-source.json` still identifies the base v0.9.29; this section attributes
the selective backport. A full 0.9.30 engine/storage upgrade was not performed.
The historical 5456.393 ms transport outlier is not resolved by this security fix.

Installed acceptance exposed the separately registered hook auth middleware, which
still duplicated the older bearer-only check. It now calls the same common HTTP
check as other endpoints; two registered-middleware regressions failed before that
correction and pass afterward. The first r183 candidate was not accepted as final.
