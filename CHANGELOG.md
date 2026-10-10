# Changelog

This file records public releases and unreleased source changes of **AgentMemory for Codex on Windows**.
The upstream AgentMemory release history remains in the
[upstream repository](https://github.com/rohitg00/agentmemory/blob/main/CHANGELOG.md).

## 0.1.0-preview.15

- Settle intentionally skipped native-managed and excluded captures without creating false dead letters. Preserve real failures and retry limits.
- Report general and graph provider capabilities separately so the graph-only local Qwen profile does not present disabled summaries as active failures.
- Exclude app-generated next-message suggestion requests from capture and retrieval while preserving quoted examples and stored originals.
- Seed the managed viewer stream through bounded key pages instead of transferring all payloads at startup. Use actual stored keys under the existing retention limit; canonical observations and graph data remain separate.
- Integrate AgentMemory 0.9.30 and iii engine/SDK 0.22.1, retaining the downstream file flush barrier, recovery intents, complete graph provenance, exact project filters and graph-only local Qwen capability.
- A single Windows installation entry selects fresh installation, managed upgrade or explicitly identified original upstream adoption. Qualified file-state adoption preserves the original directory, copies data with integrity checks and carries authentication and listener ports into the managed installation. A newer unsupported upstream is not silently downgraded.
- Bring in upstream capture, indexed list pagination, profile derivation, viewer events and client secret discovery. Preserve raw observation sources and verify indexed candidates against canonical state. Export and file import paths reject directory escapes and symbolic-link destinations.
- Separate worker lifecycle metadata by instance. Keep production installation qualification distinct from unit tests and engine data compatibility fixtures; actual fresh installation, managed upgrade, original upstream 0.9.29/0.9.30 adoption, restart and planned adoption failure recovery have been exercised on the owner's Windows host.

- Close only each successful Windows builder invocation's fresh disposable scratch unit and restore the caller environment. Preserve failed units for diagnosis; dependency stores, source outputs, accepted releases and canonical data are outside automatic cleanup. Document one-shot Cargo qualification without incremental targets accumulating between runs.
- Keep bundled YAML files at LF in Windows Git checkouts and limit source-package hardening assertions to shipped native/Docker configurations; excluded upstream cloud deployment directories are not inputs to the public Windows build.
- Use the existing confined atomic file writer for Markdown compression backups and replacements. Refuse symbolic-link destinations before modifying the source, and preserve the source when replacement writing fails.

### Qualification and limits

- Installation documentation follow-up: npm 12 defaults to refusing remote TGZ URLs. The current launcher guide uses command-scoped `--allow-remote=root`; the public TGZ and automatic ZIP download were verified through that entry point. This clarifies npm policy and does not replace immutable preview.15 binaries or their recorded source identity.

- Actual native Windows installation flows on r186 covered a fresh target, an owned managed predecessor, original upstream 0.9.29 and 0.9.30 file-state sources, post-install restart, and deliberate candidate failure with source recovery. Synthetic fixtures are distinct from the owner's live r187 production cutover and viewer-stream qualification. The final public packaging reuses those checks for unchanged installer/runtime inputs; it does not relabel them as a newly repeated installation matrix. A managed-upgrade controller's initial restored-service read failed during startup, with a later actual MCP read succeeding; its configuration hash comparison was not completed.
- The pinned patched iii 0.22.1 binary passed 20 synthetic recovery cases, including forced process-crash boundaries through the real StateModule. Its snapshot compatibility and bounded viewer-stream recovery were checked separately. This does not certify Windows power-loss or disk-failure recovery, Redis/Docker adoption, every upstream operation or other PCs.
- Pre-publication live graph inspection verified current capture progress, no queued/retrying/dead capture items, no pending/deferred graph sessions in the visible session inventory, and source expansion for sampled graph provenance. Canonical totals include archived/retained sources and differ from visible query totals. A sample does not establish whole-graph semantic correctness.
- Local Qwen remains graph-only; general summaries, consolidation, reflection and compression remain disabled. AdGuard/redirect-driver interoperability and the earlier intermittent post-MCP caller delay remain unqualified. Binaries remain unsigned, and no independent security audit is claimed.

## 0.1.0-preview.14

- Skip nonimproving repeated node paths and construct winning context lazily once, preserving the strongest-candidate rule without repeated observation allocations.

- Retain the strongest complete candidate per observation across graph entity and chunk seeds. A weak first path no longer suppresses a later direct match or shorter expansion; context and provenance follow the winning candidate. Input-chunk exclusion and canonical project/visibility guards remain unchanged.
- Add focused regression cases for both seed orders, direct/shorter matches, provenance/context replacement, deduplication and result limits.
- Expand English, Korean and Japanese descriptions of retrieval, filtering, derived indexes, Qwen scope and validation limits. Correct stale prebuilt installation links and Japanese tool/endpoint counts.
- Keep the unresolved post-MCP caller delay separate from graph ranking; no claim that this release resolves that intermittent latency.

## 0.1.0-preview.13

- Read only the required canonical keyword head when no semantic or graph channel and no reranker can change its rank; continue past invalid or out-of-scope candidates.

- Preserve exact watchdog timestamp identity after PowerShell 7 JSON date conversion so authenticated graceful stop remains compatible with Windows PowerShell 5.1.

- Preserve normal sessions without rewriting or auditing an already absent capture turn; retain audited actual clears and response attribution.

- Keep lesson recall read-only instead of rewriting the entire file-backed audit scope for each search; retain mutation audits and existing audit history.

- Store the derived keyword snapshot with numeric document and term references; retain v2 snapshot reads, posting order and scores.
- Avoid repeating canonical completion reads when a freshly locked session is already complete, and read the graph reset epoch once per backlog eligibility scan; retain per-session completion and digest validation and fresh epoch checks before writes.

- Read the agent owner once per native source drain and refresh it on the next invocation; preserve ownership filters, discovery and bounded sweep progress.
- Preserve native source validation while skipping durable session rewrites when the verified capture checkpoint and canonical count are unchanged.

- Run independent keyword, vector and graph candidate reads concurrently within the same request while retaining canonical filtering and fusion order. — 2026-10-07

- Reuse verified compact-search results and update derived Korean vocabulary and
  document lengths incrementally after individual observation changes.
- Fuse word and Hangul syllable-bigram ranks for multi-term Korean queries from
  existing postings; bound prefix-variant rarity by the literal query term's
  document frequency. Preserve canonical tokens and read compatibility with v2 snapshots.
- Scale automatically inferred entity graph weight by query-term coverage;
  explicit entity hints and vector-based graph expansion retain their weight.
- Reuse canonical observations and session metadata within each search request,
  limit final enrichment to returned candidates, and skip edge traversal when
  no eligible graph entity matches. Preserve project, speaker, archive and
  ambient-source filtering.

- Coalesce backlog execution until its server handler finishes, even when the caller times out.
- Defer automatic graph extraction and index repair while the graph writer is busy; preserve pending observations and resume through existing events and timers.
- Retry a deferred index repair on the next health cycle without classifying contention as a failed rebuild.

- Count each query term's strongest prefix match once per document and exclude
  prefix bonuses when that document already matches the exact term. This prevents
  variant-heavy documents from displacing more relevant historical originals.

- Infer missing memory projects only when every cited session resolves to the
  same project. Fail before writes on session-read errors, leave mixed or missing
  provenance ambiguous, and report only safe migration candidates as fixable.

- Permit memory imports to cite live sources in sessions that contain recoverable
  observations while retaining protected-target, deleted-source, recovery-metadata
  and replace-import rejection before writes.

- Derive low-weight Korean syllable-bigram candidates from the existing keyword
  vocabulary without changing canonical tokens. Cap
  partial contributions below existing exact contributions and refresh the derived
  cache after index mutations. This improves inflection coverage; it does not
  translate English identifiers or resolve ambiguous historical-session queries.

- Preserve ambient-looking XML inside Markdown fenced/inline/indented code and
  block quotations in both capture and stored observation visibility. Continue
  excluding actual ambient blocks outside those literal regions.

- Algorithm review considered lexical/hybrid retrieval, filtered ANN, selective
  classification, provenance, temporal graph memory, duplicate resolution, context
  construction and retrieval/factual evaluation. Adopt only the above local changes.
  Korean multi-representation retrieval provides the bigram rationale
  ([NTCIR-5](https://research.nii.ac.jp/ntcir/workshop/OnlineProceedings5/data/CLIR/NTCIR5-CLIR-NaS.pdf));
  its reported combined-system results do not establish this adapter's gains.
  Keep predicate eligibility before limits ([ACORN](https://arxiv.org/abs/2403.04871)),
  originals alongside derived facts ([LongMemEval](https://arxiv.org/abs/2410.10813)),
  and source/current-state distinctions ([Zep](https://arxiv.org/abs/2501.13956)).
  No new embedding/reranking model, graph community store, automatic deletion,
  inferred time filter or evaluation framework is justified by these papers alone.

- Reclaim replay-import test fixtures in their existing teardown and remove the
  stale fixed-count acceptance flag from optional physical recovery evidence.
  Keep the test runner result and per-case process evidence authoritative.

- Match numeric keyword terms exactly so ordinal queries such as `2차` do not
  accumulate unrelated scores from year and timestamp prefixes. Word and
  identifier prefix search remains available.

- Preserve fused retrieval score order instead of applying a three-hit session
  quota. Higher-ranked originals from the same conversation remain eligible in
  manual search and automatic recall.

- Index the displayed spelling of bare Markdown-escaped underscore identifiers
  alongside their original tokens. Literal Windows path queries remain available;
  absolute drive and UNC paths are not joined into identifier aliases.

- Remove the unpublished bulk LLM backfill shell helper, which has no supported
  CLI, CI, documentation or release consumer. Keep the registered import,
  summary and consolidation APIs and portable provider behavior.

- Remove the unused reranker availability getter and its getter-only test.
  Retain actual reranking and unavailable-provider fallback tests.

- Remove the unregistered session-stub migration graph preflight and its
  helper-only assertion, retaining the semantic graph provenance/cursor test
  and supported lifecycle reconciliation. Remove seven private, unreferenced
  type declarations; stored records and exposed tool/REST schemas are unchanged.

- Correct the memory-slots environment example to the boolean value consumed
  by the existing parser, and align the documented full MCP count to 58.

- Reclaim the existing runner's own empty temporary test home at process exit.
  Non-empty or unavailable homes remain in place with their path reported.

- Remove ten unconnected input schemas and the unused context scoring helper,
  along with twelve tests of those unused definitions. Preserve runtime
  compression/summary output validation and scoring; exercise the existing
  generic validator against its actual compression output schema.

- Remove eleven unused internal exports and their private remnants after checking
  source, dynamic imports, adapters, tests and documentation. Quiet startup
  logging no longer retains an unread buffer; verbose output is unchanged.
  Keep actual diagnostic/remove paths, CJK segmentation, metric recording,
  embedding setters and the required test accessors. Remove the environment
  example for the unused standalone-mode flag.

- Remove the unused dotenv production dependency and its lockfile entries.
  Configuration already reads environment files through the existing parser
  in config.ts; retain the parser and its configuration precedence behavior.

- Remove the unused environment-example checker. It is outside CI, package
  scripts and release inputs; it fails on Windows paths and mistakes unrelated
  string-array constants and host variables for user configuration. Keep the
  existing skill/configuration reference generation and supported build checks.

- Remove the unregistered vector migration helper and its helper-only tests.
  The published entry points already rebuild indexes through the canonical
  candidate/publication path in search.ts; retain dimension validation tests.

- Preserve shallower weighted graph routes when a stronger route uses more hops.
  Entity recall and chunk expansion retain every reachable node within the hop
  limit while choosing the lowest-cost valid path for each returned node.

- Resolve shared graph observation provenance through existing indexed session
  locations before scanning source sessions. Verify the canonical observation,
  retain project/agent/speaker visibility and fall back when a hint is stale or
  absent from graph provenance; no graph candidate is accepted from the index alone.

- Cancel local Qwen requests when worker shutdown begins, including streamed
  canary and graph responses. Drain the existing graph handler and release its
  lease while leaving unfinished observation cursors eligible for restart.
  This prevents inference from consuming the Windows graceful-stop deadline.

- Record unpublished index shards in the existing manifest cleanup list before
  writing them. Preserve the current search snapshot and legacy first-save data
  across interruptions, then reclaim incomplete generations on the next save.
  Physical engine crash tests cover interrupted first saves and replacements.

- Read managed audit history through bounded StateModule pages, retaining only
  the newest filtered results. Whole audit history no longer crosses one SDK
  WebSocket frame; the initial row-count cutoff also bounds a growing ledger scan.

- Pin an iii-sdk 0.11.2 disconnect patch: reject interrupted RPCs immediately,
  discard their unsent requests instead of replaying them, and let uncertain
  canonical writes enter the existing durability recovery path. Direct socket
  tests cover cancellation, fresh calls after reconnection and no mutation retry;
  release smoke verifies that both deployed SDK entry points match the tested patch.

- Deploy the validated workspace lockfile instead of re-resolving production
  dependencies through legacy deploy. Release smoke rejects direct dependency
  version or availability differences from the tested source environment.
- Repeat bounded native source discovery independently of long capture sweeps;
  ingest newly created, initialized or relocated sources in the discovery batch
  without resetting the fair capture cursor or continuously rescanning idle sources.
- Relocate an established original after host working-directory changes using
  exact source identity, file identity and cursor anchors. Preserve the original
  project/capture scope; unowned sessions, changed originals and ownership conflicts
  still require reconciliation.
- Distinguish absent native source files from other read failures in canonical
  capture diagnostics and whole-source liveness. Preserve attention, source
  provenance and retry behavior without assuming deletion or data loss.
- Retire explicitly archived sessions with confirmed absent source files from
  automatic capture; keep their originals and archive counts, and resume checks
  on restore. Other archived sessions and read failures retain their behavior.
- Document cloud conversation exports, durable summaries and native session
  identities separately; preserve the actual saving conversation's provenance.

## 0.1.0-preview.12 — 2026-10-01

- Normalize Windows child environment keys before overriding PowerShell module paths,
  preventing duplicate-case inherited keys from hiding native utility commands.

- Coalesce slow index saves into one running and one pending generation; retry
  quiet failures at most three times and preserve required-save error reporting.
- Reconcile restored nonempty search indexes from canonical rows. Publish complete
  rebuild candidates with concurrent additions/deletions merged; retain the live
  generation on failed reads or cancellation. Preserve compatible existing vectors
  during startup reconciliation and report readiness after complete publication.
- Count acknowledged original deletions before ancillary cleanup, continue independent
  cleanup steps, and disclose image/access/index persistence failures separately.
  Keep source, graph, archive and primary-delete failures strict and audited.

- Selectively backport upstream snapshot read-failure protection and pagination
  total floors, weight-zero graph retrieval exclusion, and HTTP 413 export refusal.
  Preserve managed graph locks, provenance and exact query indexes.
- Keep the first five-second index-save reservation under continuous writes; schedule
  completed live additions and late vectors without newly checkpointing unfinished
  bulk rebuild chunks. Preserve existing index generations and strict flush behavior.
- Record all 26 upstream main changes and remaining compatibility candidates in the
  Windows/Codex upstream review; engine, data layout and installed version stay pinned.

- Accept validated plugin mentions in Codex user display mirrors while retaining
  canonical text identity and fail-closed handling of unknown content.
- Apply LocalAI's background hold to every local-Qwen probe/extraction entrypoint
  without launching Qwen. Keep historical transport errors distinct from current
  holds; preserve graph cursors and report unrelated failures normally.
- Resolve demonstrative follow-ups against the preceding final answer as a
  bounded, unverified topic locator; current user requirements remain authoritative.

- Discover automatic recall with compact source metadata, then expand bounded
  original observation/session pairs in their exact source projects. Preserve
  established user constraints and later corrections, whole narratives or
  explicit expansion pointers, and adaptive estimated-token budgets. Missing
  subjects and partial retrieval remain explicit; optional output cannot erase
  successful recall. Conditional automatic hybrid fallback skips vector scans
  above 4,096 entries and graph/provider reranking, reports degraded channels,
  and never starts Qwen. Manual defaults and stored originals remain unchanged.
- Search response budgets skip oversized items and continue to later affordable
  originals without changing their content; compact results include source role.

- Ignore only valid session-end-only legacy rows during timeline enumeration;
  retain their source data and reject conflicting declared identities. Do not
  allow an incomplete historical session marker to disable unrelated recall.

- Preserve the concrete same-conversation subject and intervening latest user
  qualifiers when short follow-up requests ask to proceed, analyze or create a
  goal. Reject stale recall-plan subjects and trim duplicate hook/native prompts.
  Current user corrections continue to take precedence over historical context.
- Ignore the exact empty host page-open event without excluding a real user
  session. Keep unrelated or content-bearing events outside this exception.
- Bound timeline reads by native state pages and serialized response bytes,
  preserving complete originals, stable ordering, exact project boundaries and
  explicit offset/continuation metadata. Report changed sources or an original
  that cannot fit rather than truncating its content or claiming a complete read.
  Local runtime revision r131 retains upstream 0.9.29 and data contract 4.

- Reconcile image-read failure displays without changing canonical source text:
  a separate host diagnostic, attachment header, exact image path and matching
  same-turn display must agree. Consume each primary at most once, including
  source-hold review and restartable cursor reads.
- Recover uniquely corresponding legacy user hooks when hook and native record
  timestamps differ by more than five seconds in either direction. Require the
  complete inventory, proven absence of alternate source files, original hook
  provenance and unique source/capture claims. Preserve IDs, timestamps and
  origin; repeated text, conflicting provenance and protected records remain
  unresolved. Image display recovery restores the exact canonical diagnostic
  through the audited initialization path. No timeout increase or graph wait.
- Require evidence handling on normal user turns, including fresh and projectless
  questions. Retrieve new scope, or validate originals already expanded in the
  same uncompacted conversation through official project-scoped expansion.
  Reuse source references without repeating their bodies; no separate cache.
- Resolve omitted follow-up subjects to the actual recent user task. New details,
  corrections and current-state requests require fresh evidence; latest user
  instructions always take precedence. Do not equate candidate matches with
  verified requirements or source stability with model understanding.
- Avoid unconditional historical searches after sufficient local user-original
  candidates. Preserve local evidence on optional history failure, report the
  missing scope and hold dependent decisions while allowing independent work.
  Preserve explicit per-turn bypass and immediate stop requests.
- Retrieve historical user originals and other source-labelled records across
  projects; match concrete identifiers inside hostnames and exclude attachment
  transport headers from recall queries. Keep the shared deadline and independent
  capture-reconciliation behavior. No graph completion wait or Stop retry loop.

## 0.1.0-preview.11 — 2026-09-25

- Page large graph write intents instead of sending their combined index shards
  in one engine frame. Preserve source/precondition checks, durable commit
  ordering and idempotent recovery across staging, application and cleanup.
  Managed data contract 4 prevents older runtimes from opening the new intent
  format; reverting requires a matching pre-upgrade data backup.
- Use one hook work deadline shared by recall, capture, graph and curation.
  A lightweight graph-statistics read scales the base 12-second prompt budget
  with node-plus-edge count, up to 60 seconds; the registered host timeout is
  65 seconds. Individual retrieval budgets scale with it. This is a ceiling,
  not an added delay. Keep recalled evidence when capture is unconfirmed.
- Run original-text recall and capture before graph/curation work, serialize
  the two heavy graph reads and cap observation-fetch concurrency at four.
  Once the shared deadline expires, do not dispatch more auxiliary requests.
- Bound indexed graph walks before canonical hydration, including high-degree
  roots. Partial walks carry explicit incomplete totals/inventory warnings.
  Dense node pages hydrate at most 1,000 page edges; exact edge inventory
  pagination remains available for complete enumeration.

- Support project registry v4, including registered nested Git repositories.
  Resolve parent ownership independently of entry order and reject conflicting
  cutover states, path traversal, reparse points and noncanonical Git roots.
  This restores both source discovery and prompt/stop hooks on v4 workspaces.
- Treat Codex `configuration_update` response items as non-conversation settings
  so capture continues without importing them as user requirements. Unknown
  record types still stop the cursor for review.
- Recover partially populated `source=unknown` index rows only when their
  nonempty working directory matches the verified original header. Conflicting
  paths and unsupported identities remain unknown; the Codex index is unchanged.

- Keep a successful current-project recall while also looking for original user
  evidence across historical project scopes. Recent assistant summaries no longer
  suppress that lookup. `memory_recall` and REST search accept `sourceKind` to
  select user or assistant observations before candidate limits, while preserving
  archive visibility and project/agent access boundaries.
- Use keyword retrieval for automatic recall instead of repeating hybrid graph
  traversal already covered by graph context. REST `searchMode: "keyword"`
  retains canonical visibility checks; ordinary searches keep hybrid retrieval.
- Label automatic excerpts as user or derived evidence with their source dates
  and IDs. Preserve current evidence, prefer newer user corrections among the
  retrieved originals, and state that the current user request wins. The total
  hook context keeps its 2,300-character normal cap and can use up to 2,800 only
  when distinct relevant user originals need the extra room. No model call or data
  migration is added. Retrieval remains bounded and is not a guarantee of complete history
  or model compliance.

- Close graph query index updates for empty extraction batches and merge-only
  changes outside the top-degree snapshot. Those cases previously left exact
  graph search unavailable until an explicit rebuild.
- Managed health checks detect an unavailable graph index and request one
  bounded, serialized rebuild using the existing recovery operation. Failed
  attempts remain visible and retry after five minutes. Reads stay bounded,
  canonical records and archive decisions are preserved, and no model is needed.
  When a clean snapshot agrees with canonical totals, repair only query shards;
  avoid rewriting every name, degree and relationship lookup on startup. Full
  rebuilds also cap concurrent lookup writes at the existing index I/O bound.
- Mark fallback graph totals as inexact, including empty fallback results.

## 0.1.0-preview.10 — 2026-09-23

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

## 0.1.0-preview.9 — 2026-09-21

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
