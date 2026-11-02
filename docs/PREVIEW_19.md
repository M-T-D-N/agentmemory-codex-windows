# Preview.19 candidate: identity, use and qualification

**Status: unpublished candidate.** Source prepares `0.1.0-preview.19`; no new
GitHub tag, release or downloadable asset is claimed; qualified local assets are listed below. Published preview.18/r225 and its
[fixed instructions](https://github.com/M-T-D-N/agentmemory-codex-windows/blob/v0.1.0-preview.18/packaging/windows-codex/npm/README.md)
remain unchanged. Do not combine historical assets with this candidate.

## Identity and changes

Compatibility is AgentMemory 0.9.30, patched iii engine/SDK 0.22.1 with
file-flush-v1, and data contract 5. A qualified new build must use its exact clean
source commit and a new runtime revision. The final release manifest is the
authority for that revision, source commit and source-input digest; a planned
revision number in documentation does not identify the final candidate.
Historical r228 qualification results remain evidence for r228 only and must not
be relabeled or carried forward to a different manifest. The upstream
compatibility/schema versions do not change when this downstream preview changes.

- Accept JSON integer ports from Windows PowerShell 5.1 and PowerShell 7 while
  retaining strict type, range and distinct-port validation.
- Read-only status exposes only allowlisted cursor diagnostics and stable native
  discovery failure categories; unexpected source text/paths remain excluded.
- An independently bundled `@agentmemory/agentmemory/diagnostics` provides exact
  metadata helpers without starting a worker. The package root intentionally
  starts the worker and must not be imported for inspection.
- Historical privacy matching preserves the existing redaction only when exact
  source provenance, complete inventory and historical digests are proved. A
  missing optional project needs a validated canonical session binding. Hook
  timestamps and prior approved eligibility metadata remain unchanged.
- Synthetic regressions cover compression/replacement/content/truncation guards,
  privacy compatibility and graph/lifecycle composition. They do not repair any
  operating cursor, observation, project path or audit state.
- Compressed replay avoids copying discarded prefixes while retaining source,
  size, correspondence and read-budget checks. An uncached late offset in one
  Zstd frame still requires sequential decoding.
- Indexed graph reads validate publication consistency after hydration and retry
  transient changes at most three times within a one-second retry window. A
  persistently unavailable index retains the bounded, explicitly inexact fallback;
  clean-index queries do not wait for Qwen extraction.

## Search scope and build-tool baseline

Explicit current-project-only requests remain narrow across keyword/hybrid
discovery, original expansion, graph queries and source reuse, including empty
or failed local retrieval. Scope withdrawal retains the concrete task topic;
a later explicit all-project request can reopen federation. Same-turn conflicts
stay narrow, and assistant/tool/quoted wording does not authorize widening.
The tested Korean/English phrases and repeated follow-ups form a bounded grammar,
not complete natural-language understanding. See the
[verification boundaries](CURSOR_AND_QWEN_VERIFICATION.md#explicit-recall-scope-and-build-tool-verification).

Source builds use pnpm **11.25.0**, matching the downstream package-manager
declaration and Windows CI. The Windows builder checks the selected executable's
actual version before installation and rejects mismatch or an unreadable version;
it does not replace shared tooling. pnpm 11.19.0 support remains unverified.
The original lockfile's dependency resolutions and upstream provenance remain
unchanged.

## Windows Node shipping profile

Subsequent source changes narrow the freshly deployed Windows dependency copy
before manifest/ZIP generation. The pinned GUID package and ONNX Web all/WebGL
carriers are excluded with matching dependency/export/type/package-map changes.
Ordinary Node providers and dedicated WASM/WebGPU/JSPI assets remain. Direct
`onnxruntime-web/all`, `onnxruntime-web/webgl` and injected/custom runtime uses
are outside this profile. See the
[exact scope and failure behavior](../packaging/windows-codex/README.md#windows-node-dependency-shipping-profile).

Real native CPU MatMul and synthetic image processing passed on a disposable
r264 copy. That is not a new qualified candidate or proof of all pretrained/GPU
features. The original r264 payload and operating receipt are unchanged.

## Fixture process safety

The isolated live-daemon fixture records each engine, worker and bridge child by
PID, parent, creation time, executable and full command. It rechecks that identity
before graceful termination and again before forced termination. A failed lookup
or changed identity refuses the signal; an exited child receives no signal and
late force timers are cleared. Synthetic regressions cover refusal, PID reuse and
timer behavior. The Codex, Copilot and Antigravity live fixtures passed with the
pinned engine, synthetic home/data and model providers disabled. This is component
verification, not the final Windows installation matrix or an operating Qwen receipt.

## Installation and managed update

Requirements remain native Windows x64, Node.js 24+, Windows PowerShell 5.1 and
the Windows account that runs Codex. This remains an unsigned Technical Preview.
Local Qwen is optional, separately installed and loopback-only; other LLM
capabilities and external fallbacks remain disabled in the supported profile.

Once all release gates below pass, use only the matching four assets:
`agentmemory-codex-windows-0.1.0-preview.19-win32-x64.zip`,
`agentmemory-codex-windows-0.1.0-preview.19.tgz`, `release.json`, and `SHA256SUMS.txt`.
The [candidate launcher guide](../packaging/windows-codex/npm/README.md) contains
version-pinned commands. Its future download URLs are not evidence of publication.

Preview the exact operation first. For an empty target, the qualified installer
prepares, activates and validates. For an owned managed update, use the same root
and preserve canonical data, authentication, ports and task identity. Do not
create a second production installation to update one service. Validate REST/MCP
and the managed hooks before connecting Codex. An ordinary code update does not
authorize source reconciliation or repair existing attention conditions.

## Failure recovery and removal

Use the installed managed lifecycle and ownership checks. Preserve the active
runtime, actual immediate predecessor and a verified complete cold code/config/
auth/data/home recovery set before a consequential update. Code/config alone
cannot roll back changed canonical data. Never pair old binaries with newer data
or replace live data with generated build output. Keep originals and failed-phase
evidence and follow [existing-install cutover](../packaging/windows-codex/README.md#existing-install-cutover).

Removal remains a separate intentional operation: stop owned watchdog/runtime,
review exact task/hook/MCP ownership, retain recoverable data/auth and remove only
approved registrations. There is no destructive one-command data uninstaller.
Qwen ownership remains with its separate lifecycle. Startup may reconcile an
exactly proven legacy final response through the bounded normal initialization
path described below. This is not general source-path repair, permission to
rewrite arbitrary observations, or a data-recovery command.

## r269 local qualification (2026-11-02)

This is a locally qualified, **unpublished** Windows technical preview. Public
source review, exact-public-commit Windows CI, the tag/Release and download-hash
verification remain pending. Existing preview.18 and earlier assets are preserved.
The future versioned Release will record those public identities and CI links
only after they exist. A source or documentation commit is not a new binary build.

| Identity | Fixed value |
|---|---|
| Downstream / runtime revision | `0.1.0-preview.19` / `r269` |
| Payload workspace source | `7e66cd75702222aece989ac1c6be4c73aa004e7d` |
| Release manifest SHA-256 | `dd9419bb3d16d25f2f765fce7e14eb930cb3b7a94e790d9d8db0d4484086b8b9` |
| Source-input digest | `c6c20bb2683faab925c4bf122b04d91d424620f64f8985f4236b5cfbd354e1c9` |
| Payload digest | `0d054671ab5da6a9965a29491d932a10cda3aac87126acb72c0e1f668287143e` |

The public repository has separate history. Its source snapshot matches that
workspace commit for included product files; this later documentation overlay
reports completed qualification without replacing the immutable candidate's
build-time records. The final public commit and its CI must be recorded separately.

Actual checks on one Windows x64 host, using Node.js 24.22.2:

- Source suite: 4,510 passed and 35 existing skips; adapter: seven passed;
  selected final packaging suite: 526 passed. Skips remain skips.
- The exact candidate passed isolated Windows fresh installation, managed
  update from a distinct predecessor, normal restart, and fixed pre-start I/O
  failure recovery with synthetic memory preservation. Owned test resources
  were cleaned up. This does not prove arbitrary post-start or power-loss recovery.
- Fixed Codex native and local synthetic Responses verified Memory v2 selection,
  same-request automatic recall, four automatically captured observations with
  manual search/source links, zero insertions on same-cursor replay, and owned
  cleanup. Synthetic Responses are separate from the real-model check below.
- The live r264-to-r269 update preserved selected baseline records and
  authentication. A new explicitly synthetic observation submitted by an agent
  through the native Codex conversation under the user-authorized validation
  workflow was automatically collected, found, and extracted by real local Qwen.
  Source-linked graph results were queried; this is a small sample, not completion
  of all historical graphs or proof that every linked node was newly created.
- The official seven-stage operating verifier passed. Actual process exit 0,
  confirmed receipt and official consume were linked to the same result hash.
  Discovery warnings for a particular changed historical source were reconciled
  only after complete correspondence and a cold recovery copy: 27 original rows
  remained identical, 14 missing source references were collected, and 41 unique
  references matched. The historical writer that changed the source is unknown.
- The official distribution verifier and builder passed for these exact bytes.
  A packaging attempt first failed because two pnpm paths were combined; its
  failure is preserved. The successful build used one pinned pnpm in its child
  PATH. General handling of multiple pnpm executables was not changed in product
  source. Earlier native/discovery/encoding/execution-policy failures likewise
  retain their original outcomes rather than being relabeled successful.

Local assets (future Release URLs are not yet verified downloads):

| Asset | Bytes | SHA-256 |
|---|---:|---|
| `agentmemory-codex-windows-0.1.0-preview.19-win32-x64.zip` | 277941639 | `e188f74f2880055927eb1fd5fb2a694fb3c72c38ba5d53e6fc9edd9fa63fd977` |
| `agentmemory-codex-windows-0.1.0-preview.19.tgz` | 66854 | `1c12cbe9491e44822b6a94c29595190525920bc9a128358bff4fbf5981f58d8c` |
| `release.json` | 564 | `9c1d50daebe86c4033b61c1371e94bfcd067b4aaa845f2d2739f16249d94d144` |
| `SHA256SUMS.txt` | 315 | `c7f51fdee0b352b02839a6cd92db662b1bfc37ada9d1a0d65fa3d29d35cf96c8` |

All 11,272 Windows ZIP files matched the fixed manifest and previously reviewed
exact bytes. All ZIP entry types passed the installer's type mask. The nine-file
TGZ, full launcher metadata and exactly three checksum entries matched. Its one
path finding was the literal nonpersonal `YourName` installation example,
classified only by exact file hash, match hash and offset. The first unresolved
audit remains recorded; the later audit had no unresolved findings or tool errors.
These bounded regex/name/inventory checks do not establish absence of every kind
of sensitive information or constitute an independent third-party security audit.

The ZIP includes `NATIVE-SOURCE-EVIDENCE.zip` (95,754,646 bytes, SHA-256
`feb32a6ee7f17de11c9eb9bb6cbf38ff497d9d55a6cc3927e911ddbfabb7029d`),
its descriptor, exact notices and documented pinned build-source access paths.
Its `complete=false` is retained: source materials and build instructions do not
prove byte-identical DLL/signature reconstruction or the exact historical Cargo
dependency selection. Twelve upstream source samples lack directly confirmed
consumer references. Public upstream test literals/build paths remain narrowly
classified. See the [recipient source limitations](../packaging/windows-codex/README.md#current-recipient-source-input-2026-11-02).

Use Windows x64, Node.js 24+, PowerShell 5.1 and the Codex Windows account.
The product is unsigned. Optional Qwen is separately installed and loopback-only;
it is not bundled. Current operating and distinct predecessor runtimes plus
matched cold recovery remain preserved. Existing acknowledged historical capture
holds are not erased by this release. See the installation/update/removal and
recovery instructions below. There is no universal interoperability, semantic
accuracy, all-operating-time contention or all-failure recovery guarantee.

## Historical r267 qualification checkpoint (2026-11-02)

The immutable diagnostic r267 uses source
`6883a50c19fd902b0bab1cf93e545f5b74a15ee1` and manifest SHA-256
`11ca6f9041d11e04dc3f4412f704550abbbcaf1e258c33d88bcd7c7a0fc9ad15`.
WINDOWS35 accepted its actual isolated fresh installation, managed update,
normal restart and fixed pre-start I/O failure recovery. NATIVE56 later passed
on that same candidate with Node 24.22.2: two synthetic native turns, v2 and
automatic recall in the same second model request, four automatically collected
observations with source mappings and manual search, same-cursor replay with
zero insertions, and SessionEnd/archive preservation. Owned test resources were
cleaned up, and the original results received review. Source links were observed
after 81.249608 seconds without forcing initialization.

NATIVE56 used local synthetic Responses; it does not establish real Qwen,
native background generation or restart/durable deduplication. It does not
qualify these later documentation bytes or a final changed candidate. The
separate r264 operating/Qwen receipt below remains historical. Source rights,
final recipient-source delivery, exact final-candidate Windows/native/Qwen
qualification and the distribution verifier remain open. No preview.19 public
assets or exact-commit public CI success are claimed. See the
[current verification status](../packaging/windows-codex/verification/SUBMISSION-VERIFICATION-GATES.md).

## Historical r264 operating checkpoint (2026-10-30)

The following records r264 and its then-open items; the r267 evidence above
supersedes only the corresponding limited checks, not its original failures.

The immutable r264 candidate is built from source
`8b46bbaeb22787ef491c97ce463417d56ea180cb`, with manifest SHA-256
`5c0a6c937d199481c138349b0a878104669f76fcdee772ed9ffcd6590b0d6008`.
Its build passed 4,501 source tests with 35 skips, seven adapter tests and
499 packaging tests. This later documentation is not a new build identity.

Its existing-root operating update exited 0. Normal automatic discovery restored
one exactly matched legacy final response through the supported initialization
path, preserving its observation ID and recorded metadata. Nine other baseline
narratives/source identities, authentication and managed configuration bytes
were preserved. Original facts were not independently hashed in that earlier
baseline; this is not a complete database equivalence claim. The planned manual
preview stopped on an outdated expectation because the automatic repair had
already completed; its exit 1 is retained and no manual apply was executed.

An agent submitted an explicitly synthetic input through the normal Codex
conversation under the user-authorized validation workflow. Automatic collection
and fresh Qwen extraction were observed before manual capture. The official
seven-stage operating E2E then exited 0; its separate parent-confirmed receipt
was accepted by the official consumer. Search and graph queries linked the sample
to its original source. Linked or walked graph nodes are not all newly created,
and historical terminal capture classifications remain. The current runtime,
actual r263 predecessor and one verified cold recovery set were retained.

This operating scope was reviewed. The r263 Windows four-scenario evidence is
historical and does not qualify r264 or later bytes. Positive same-prompt native
Memory v2/adapter coexistence, exact final-candidate Windows qualification,
guid-typescript's exact notice, complete recipient-source delivery and the final
distribution verifier remain open. Isolated v2 reads or hook discovery and the
operating Qwen run are distinct evidence, not proof of their joint execution.
No preview.19 public asset or exact-commit public CI success is claimed. See the
[current verification status](../packaging/windows-codex/verification/SUBMISSION-VERIFICATION-GATES.md).

## Historical r262 qualification checkpoint (2026-10-30)

The following is the earlier r262 checkpoint. Its then-open items are superseded
only by the exact r264 evidence above; its failed attempts remain unchanged.

The immutable r262 candidate uses source `f800bc0524d7679879ed1802eb8bc3f7bd4ec69a`
and manifest SHA-256
`531e4ca96e84c8f45cf9b2c1ddfe3a2de012fbcad9354e1dd399285ce0383c1e`.
Its original build recorded 4,476 passing source tests with 35 skips, seven
adapter tests and 499 packaging tests. Real isolated Windows fresh installation,
managed update, normal restart and the fixed pre-start I/O failure/recovery
passed the official scenario verifier. The intended failed installer exited 1;
the recovery exited 0. Owned test resources were retired after review.

The separate r252-to-r262 operating update exited 0. Nine existing observation
samples retained their content digests and source identities; authentication and
managed configuration bytes were unchanged. This is sample preservation, not a
whole-database equivalence claim. The first update attempt failed before mutation
because its child PowerShell module path was unsuitable; that failure is retained.
A complete cold recovery set and the actual immediate predecessor were preserved.

Later source commits `c3503b08` and `c55c8af6` are **not in r262**. They preserve
canonical memory citations while matching native display mirrors, and bind a
short temporary Qwen retry citation to its exact single original observation.
Their synthetic/read-only checks do not qualify new package bytes or establish
successful operating recollection or model extraction. A new exact-source
candidate and the affected Windows/native/Qwen evidence are still required.

Native Memory v2 enabled/disabled read selection has separate limited evidence.
A failed root-contract probe and a later CRLF-versus-LF assertion remain recorded
as failures; successful byte adjudication does not rewrite their outcomes.
Positive normal-prompt hook/v2 coexistence, automatic collection before manual
capture, a fresh Qwen graph and its confirmed source-linked receipt remain open.
The partial corresponding-source archive is bound to r262, but the exact guid
notice, complete recipient-source review and final distribution acceptance remain
open. No preview.19 public asset or exact-commit public CI success is claimed.

## Historical private candidate and release limits (2026-10-29)

The following records the earlier r260 checkpoint. Its then-open Windows/source
items are not the current status above; its UNKNOWN activation is not rewritten.

The immutable private r260 candidate was built from `ef99faa7` and has manifest
SHA-256 `96e5c3be3015c00bb0c84d1e95b73f7ac86ba0c899cbaae8a068610c080d66d5`.
The separately pinned verification tools subsequently changed; their newer
source commits do not change that candidate's payload or source identity.
Current documentation changes are not a rebuilt or published r260 artifact.

A reviewed same-slot continuation completed an **owned-runtime restart** with
synthetic data: create returned HTTP 201, search/detail returned 200, and exact
memory ID, content, project and origin survived a normal stop/start. Ownership-
checked cleanup removed the trial root/key and its two tasks; a separate
read-only check confirmed the root and both tasks absent. The original activation
timed out without a final exit receipt, so its exit remains **UNKNOWN**. The new
result is not fresh-install evidence and does not qualify the Windows matrix.

| Distribution check | Established evidence | Remaining before submission |
| --- | --- | --- |
| Candidate bytes and build | r260 immutable inventory and original source/adapter/packaging logs were reviewed. | Current-source release artifacts and final exact-candidate verifier acceptance; do not relabel a historical build. |
| Windows acceptance | The separate runtime-only synthetic-memory restart and owned cleanup completed. | Fresh installation, cross-version managed update and failure recovery, with a complete accepted four-scenario record. Original activation remains UNKNOWN. |
| Native/model coexistence | Component and synthetic tests have narrower recorded scopes. | Current-candidate native capture/discovery/graph evidence, native Codex Memory v2 coexistence and actual Local Qwen verification. |
| Dependency notices | Six MIT supplement mappings and complete GPL/LGPL/MPL texts are present in the inspected r260 notices. | Exact guid-typescript 1.0.9 ISC copyright/full notice and source-version link; sharp/libvips component attribution and corresponding-source route. |

The [dated dependency checklist](../packaging/windows-codex/licenses/THIRD-PARTY-NOTICES.md#dated-distribution-evidence-checklist-2026-10-29)
separates supplied texts from missing evidence. A standard license text is not
component-wide attribution or a completed source offer. Existing package/source
records were rechecked locally; no current upstream availability, maintainer
answer or downloaded source archive is claimed. License clearance and full
distribution qualification remain unresolved. No new public assets are supplied.

## Evidence required before distribution

A source-suite pass is source verification. The ZIP/TGZ distributor additionally
requires the exact source commit/input digest, release manifest/payload, complete
suite logs, Windows fresh-install/managed-update/restart/failure-recovery evidence,
and confirmed native worker/capture/discovery/drain/search/status evidence. The
native proof must include a fresh automatically derived graph tied to its exact
new observation and source key. Mocks or historical operating results cannot
replace any of those records. The distributor must remain closed when they are
missing or stale; do not set synthetic success fields or skip mandatory tests.

**Current local result:** the exact r269 Windows matrix, native/v2 check,
real-Qwen operating receipt and final distribution assets are qualified within
the [recorded scope](#r269-local-qualification-2026-11-02). Public-source final
review, exact-public-commit CI, tag/Release and downloaded-asset verification
remain pending. This is not a claim that publication has occurred.

The independent synthetic suites and payload import smoke retain their narrower
scope; they do not claim equivalence to removed historical tests. Removed files
were not restored or required as execution entrypoints. The r264 receipt remains
bound to source 8b46bbae, and the r267 Windows/NATIVE56 results retain their own
identities. Those historical results were not substituted for r269 qualification.
The isolated synthetic lifecycle tests alone do not establish live GPU startup
or model quality; r269's real Qwen check is a separate operating sample.
See [detailed source verification boundaries](CURSOR_AND_QWEN_VERIFICATION.md).

The current LocalAI launcher uses a fixed configuration and shared worker state;
a separate port alone does not isolate ownership/readiness. A real isolated test
requires separately reviewed host support for distinct configuration, state,
ready signal, coordination, home/KV and loopback endpoint while retaining shared
GPU admission and exact owner release. This candidate makes no such host change.
