# AgentMemory for Codex on Windows

> **Preview.19/r269 candidate — locally qualified, not published.** The exact Windows payload was built from `7e66cd75702222aece989ac1c6be4c73aa004e7d`; the public-source documentation below is a later overlay, not a new binary build. See [the final local evidence and limits](../../docs/PREVIEW_19.md#r269-local-qualification-2026-11-02). The [versioned preview.19 Release target](https://github.com/M-T-D-N/agentmemory-codex-windows/releases/tag/v0.1.0-preview.19) is reserved for publication; its existence and exact-public-commit CI success are not yet claimed.

> **Published preview.18/r225:** The [fixed Release](https://github.com/M-T-D-N/agentmemory-codex-windows/releases/tag/v0.1.0-preview.18) provides the four verified assets, hashes and installation instructions. Tagged public source: `6359546a`; payload workspace source: `3632849b`. This post-publication main documentation and its CI are separate from the unchanged binary build source. Historical preview.17/r216 remains preserved.

Current source prepares unpublished `0.1.0-preview.19`. The exact r269 local
Windows/native/Qwen/distribution checks are complete within the recorded scope;
public-source review, CI and publication remain pending. See [candidate evidence
and remaining publication steps](../../docs/PREVIEW_19.md). Published preview.18 remains available through
its fixed tag and matching assets; do not substitute a development build for it.

Preview.18 qualification and release identities are summarized in [the operating and validation notes](../../docs/PREVIEW_18.md). The detailed lifecycle commands below remain the authority for installation, cutover, data preservation and recovery.

[English](README.md) | [한국어 안내](../../READMEs/README.ko-KR.md) | [日本語案内](../../READMEs/README.ja-JP.md)

> [!IMPORTANT]
> This is the source and operating guide for independent downstream Technical
> Preview candidate `0.1.0-preview.19`, based on upstream AgentMemory `v0.9.30`. It is not the
> official upstream repository, an `@agentmemory/*` npm release, or a promise
> of upstream support. Use this downstream
> npm launcher or source builder; an upstream `npx` command installs a different product.

The matching preview.18 tag and four release assets are identified by the [preview.18 release](https://github.com/M-T-D-N/agentmemory-codex-windows/releases/tag/v0.1.0-preview.18). Historical preview.16 retains its own immutable guide and assets. Current main documentation corrections do not replace the preview.18 tag, manifests or assets.

This release version identifies the source and independently packaged downstream launcher. Each generated package and
installed runtime has its own qualification and installation evidence.
Use an explicit new `-ReleaseRevision` and the exact source identity for each
qualified build. Existing versioned installation targets are not replaced.

For prebuilt TGZ installation with npm 12, the [launcher guide](npm/README.md)
uses command-scoped `--allow-remote=root`; npm 12 otherwise rejects a remote
tarball URL. This is an installation-command clarification; published package
hashes and their original source commits remain fixed.

This directory is the source authority for the Windows/Codex adapter around the
upstream AgentMemory TypeScript package. The adapter keeps iii-engine,
AgentMemory's official state scopes, and the normal memory, lesson, graph,
audit, and provenance lifecycles. It introduces no secondary database or queue.

The public `r62` baseline and the reconciled source organize supported behavior into
clearer boundaries without changing the upstream-compatible API or data model:

- four managed Codex hooks capture normal main-task prompts and final responses
  while excluding ambient UI, host, fork, and subagent traffic;
- durable writes remain exact-project and provenance-checked, while bounded,
  source-labelled reads may federate relevant context across projects;
- optional Local Qwen remains credential-free, loopback-only, and restricted to
  typed graph extraction. Its graph completions use streamed SSE so long-running
  llama.cpp responses remain live and incomplete streams fail closed; every
  other LLM-backed function receives the noop provider;
- graph derivation, query-index access, canonical persistence, and official
  lifecycle handling are separate code responsibilities. Sixty-four
  rebuildable index shards accelerate project, text, pagination, and bounded
  walk queries. If that derived index is temporarily unavailable, reads return
  an explicitly bounded snapshot instead of launching a non-cancellable full
  graph enumeration; canonical AgentMemory graph scopes remain authoritative;
- graph output, deadlines, retries, parser bounds, relationship endpoints, and
  observation provenance are bounded and fail closed without advancing a
  failed source cursor;
- MCP and REST authentication, observation visibility, hook runtime settings,
  token estimates, and worker pidfile handling each have one shared
  implementation so entrypoints cannot silently drift;
- REST and durable session-start paths call the registered context
  implementation directly, avoiding same-worker iii re-entry while preserving
  the upstream context contract and state stores; and
- session forget and semantic graph persistence share a keyed lifecycle
  boundary, so completed background inference cannot recreate a deleted source
  session or advance its graph cursor after deletion;
- session forget atomically detaches the exact source session and observation
  provenance from the canonical graph. Shared graph records remain, while only
  provenance-free orphan relationships and unreferenced nodes are removed;
- exact graph edge inventory is available as an opt-in query mode with stable
  edge-ID ordering, revision checks, and hydration verification, while the
  existing page-local `edges` response remains compatible;
- session start, observation, completion, forget, eviction, migration, and
  graph dispatch share one per-session lifecycle boundary, so ending an unknown
  or concurrently forgotten session cannot materialize an incomplete row in
  iii's file-backed state store; and
- historical stub repair and purge migrations are not included in this source.
  Use the supported exact-project inspection and recoverable empty-observation
  lifecycle described below; do not replay an old migration against current data.

The detailed failure lessons later in this guide explain why these constraints
exist. They are operational history, not additional product surfaces.

## User-rebuilt compatible libvips inputs (source implementation)

The optional source-builder argument `-UserLibvipsInputDirectory` stages user
supplied Windows x64 C DLL and/or MSVC wrapper bytes into a **new** candidate
after frozen dependency deployment and before immutable manifest generation.
Without that argument the default build branch is unchanged. This implementation
has synthetic staging/repackaging verification only; it has not established
native ABI/image processing, a completed corresponding-source offer or a tested
Windows install of a user-rebuilt library. Immutable r254 and earlier artifacts
remain unchanged and do not contain this implementation.

The input root must be a physical local directory containing `libvips-input.json`
and the selected `libvips-42.dll` and/or `libvips-cpp-8.18.7.dll`. Other file
names, `.node` replacements, MinGW C++ wrappers, redirected directories and
arbitrary overlays are unsupported. Unverified internal junctions fail safely.
The current profile requires sharp 0.35.5 and libvips 8.18.7. A valid C ABI does
not make the removed MinGW C++ wrapper compatible with the MSVC addon.
The unchanged native addon is exactly `sharp-win32-x64-0.35.5.node`, selected by
the captured package's `./sharp.node` export through its versioned `index.cjs`
entry. Layout regression expectations come from those preserved package bytes
and their r254 inventory binding, rather than the staging helper's constants.
No wildcard native-addon replacement is accepted.

The descriptor has exactly these top-level fields: `schema_version` (1), `kind`
(`user-built-libvips`), `platform` (`win32-x64`), `sharp_version` (`0.35.5`),
`libvips_version` (`8.18.7`), `files` and `sources`. Each `files` item contains
`component` (`vips-c` or `vips-cpp-msvc`), its fixed `file` name, positive integer
`size_bytes` and lowercase SHA-256 `sha256`. Provide exactly one source item per
selected component with `component`, `version` (`8.18.7`), `source_url`,
`source_revision`, `recipe_url`, `recipe_revision`, `patches` (an array of
`{url,sha256}` objects, possibly empty), and `verification` (`declared`). Source
revisions are git/release identifiers. URLs must be HTTPS without embedded
credentials, query parameters or fragments. Only supply public source references
without secrets; syntax checks do not independently verify source publication
or contents. Do not include a username, local path, token or free-form notes.
The validated descriptor is packaged verbatim, so review its actual contents.

For an intentionally separate candidate, choose unused owned output/revision
values and pass the input directory explicitly:

```powershell
& .\packaging\windows-codex\Build-WindowsCodex.ps1 -Offline `
  -OutputDirectory $newOutput -ScratchDirectory $taskScratch `
  -ReleaseRevision $newRevision -IiiEnginePath $pinnedEngine `
  -UserLibvipsInputDirectory $userInputs
```

The builder locks input reads, verifies physical paths and hashes, creates new
files and atomically replaces only candidate directory entries. It does not
write through pnpm cache hardlinks or fall back to in-place overwrite. Failure
leaves an unqualified owned candidate for diagnosis. The runtime's
`user-libvips-input.json` and `user-libvips-provenance.json`, external input digest,
`distribution_variant: user-libvips`, DLL hashes and qualification are bound to
the new manifest. Provenance keeps `native_api_abi: not-verified` and source
verification `declared`. Existing code source identity keeps its original
meaning. Old manifests/receipts cannot qualify the changed bytes.

The installer's existing `-ReleaseRoot` and file-hash/ownership checks remain in
place; no signature, integrity, version or policy exception is added. A future
authorized isolated installation/native test must validate the actual compatible
libraries. Do not modify operating DLLs or an existing immutable payload. See
[the source/patch and ABI notes](licenses/THIRD-PARTY-NOTICES.md#sharp--libvips-source-and-replacement-investigation)
for the remaining LGPL/MPL source and notice work.

## Windows Node dependency shipping profile

The source builder now narrows only its freshly deployed Windows copy, before
manifest or ZIP creation. It excludes guid-typescript 1.0.9 and the pinned
ONNX Web all/WebGL bundles, their five maps, and the vendor development lib tree.
The original dependency store, source checkout, published packages, immutable
candidates and operating installation are not modified. Metadata is replaced
through new files so pnpm hardlinks cannot modify the source store.

The transformation is bound to the reviewed input hashes, exact removal set,
metadata shapes and physical staging path. Unexpected versions, new GUID
references, redirected paths or missing retained export/map/assets fail the
build and leave the incomplete staging output for diagnosis. It reconciles
package dependencies, exports, ambient types and pnpm's package map together.

The retained profile includes ordinary Transformers Node ESM/CJS, ORT
node/common/native providers, sharp, and dedicated WASM, WebGPU and JSPI
entries/assets. The vendor imports `onnxruntime-web/all` and
`onnxruntime-web/webgl` are intentionally unavailable; applications using
those subpaths or injected/custom ORT runtimes are outside this shipping profile.
The retained upstream build scripts are provenance, not a complete vendor
development/rebuild environment. Upstream dependencies and notices remain
identified; this profile does not relicense them.

The existing payload smoke verifies retained references and runs real native
CPU MatMul plus synthetic image resize, without downloading pretrained models.
These checks do not establish pretrained embedding/CLIP/reranker semantics or
WASM/WebGPU/GPU execution. The implementation was exercised on a disposable copy
of r264, not a new qualified release. Fixed r264 and its accepted operating
receipt retain their original contents; a final new candidate still requires
its own scoped verification and recipient-source review.

## Native corresponding-source evidence input (partial)

Current status (2026-11-02): the partial v4 assembly with selected/conditional
Rust sources and exact upstream build-tree delivery is the tracked input below.
Its exact input bytes passed the bounded SOURCE80 review and are bound to the
r269 manifest and qualified Windows ZIP; limitations below remain. Historical v2 remains bound to the fixed
r267 candidate; private v3 is retained separately. The original research ZIP
contains private retrieval records; do not publish it as-is. See the
[current recipient-source input](licenses/THIRD-PARTY-NOTICES.md#current-recipient-source-input-2026-11-02)
for bundled versus external sources, exact downloads and recipient-delivery
limits. Source-input review alone does not qualify a product candidate; r269
has separate linked functional and distribution evidence.

The source builder accepts `-NativeSourceEvidenceArchive <reviewed-local-zip>`.
It never downloads, unpacks or executes that archive. The tracked
`licenses/native-source-evidence.json` pins the 95,754,646-byte v4 input
to SHA-256 `feb32a6ee7f17de11c9eb9bb6cbf38ff497d9d55a6cc3927e911ddbfabb7029d`.
Without the option, the existing default branch adds no source-evidence files
or manifest field. The input must be outside a fresh exclusively owned physical
candidate directory. Existing output files are never overwritten. A failed copy
leaves an unqualified partial candidate for diagnosis; it is not retried or published.

With the input, `NATIVE-SOURCE-EVIDENCE.zip` and `NATIVE-SOURCE-EVIDENCE.json`
are release-root files. Their size/hashes enter `release_files`; the explicit
`native_source_evidence` record binds the partial descriptor to those entries.
The existing distributor checks that inventory and includes the entire release
directory in the Windows ZIP. The small npm TGZ downloads that ZIP and does not
need another archive copy. These external bytes are bound by the manifest hash,
not by the tracked source-input digest or immutable payload digest.

The archive contains nine component source archives, cairo file notices,
pinned GLib GVDB with its notices, fixed recipes/patches, and a patched librsvg
source map with 167 base Windows gnullvm Rust crates and 17 conditional AVIF
crates. License metadata and supplemental notice provenance are bound to members
of checksum-verified original crates. Cargo tree analysis and this conservative
AVIF superset do not prove the historical binary's exact compilation graph.
`complete=false` is mandatory: the descriptor verifies copied bytes, not complete
historical binary reconstruction or blanket redistribution rights. The exact guid 1.0.9 notice
remains unresolved where that package is shipped; the separate Windows Node
profile's exclusions must be verified against each final payload. No
license-clearance or production-qualification result is created.
Historical container-digest uncertainty is recorded without inventing a new
independent release blocker. Sources, patches and build instructions are read
from the enclosed README/component map by recipients; this byte-copy helper
does not attest their completeness or execute them.

The earlier Windows Library materialization failed while applying xattrs; that
failure remains in the investigation history. Source assembly alone did not
qualify a distribution. The later r269 descriptor, manifest and final ZIP now bind
the exact archive below, with recipient paths and bounded audit reviewed.
r260 remains fixed and is not relabelled; public availability is still pending.

### Current recipient-source input (2026-11-02)

The new partial source archive contains 859 files, 95,754,646 bytes,
SHA-256 `feb32a6ee7f17de11c9eb9bb6cbf38ff497d9d55a6cc3927e911ddbfabb7029d`.
Its descriptor pins these bytes inside the locally qualified r269 Windows ZIP.
It is not yet published. The earlier v2/v3 archives and r267 candidate are unchanged.

The archive retains 855 source/notice files byte-for-byte, including the nine
component archives, GVDB, 167 base and 17 conditional AVIF Rust crates. It keeps
five patches with explicit MXE license references and the corresponding MXE
license. Thirteen other selected build-win64-mxe files are supplied through
the complete fixed upstream tree rather than copied into this new ZIP.
BUILD-SOURCE-MAP.json lists those individual paths/hashes and full-tree downloads;
SOURCE-MAP.json explicitly marks bundled versus externally provided patches.
This is a delivery distinction, not permission to omit required scripts,
patches or non-patch edits from a recipient's reconstruction.

| Exact source download | Bytes | SHA-256 |
| --- | ---: | --- |
| [libvips/build-win64-mxe ef19ca09](https://codeload.github.com/libvips/build-win64-mxe/tar.gz/ef19ca09af2453d127453d677c849ccb37cf5694) | 65766 | `f52864572e6df6e549016369fdb2705aa195a837bd7bc8c52e45f42b59ef97a7` |
| [kleisauke/mxe c36160b2](https://codeload.github.com/mxe/mxe/tar.gz/c36160b231e66e1cbe032ed54aef7617e8b259da) | 2666414 | `b71d435d977b64f56b048c948a7649892fc36a1977ecd30ca0e7fe3c21b2f607` |
| [lovell/sharp-libvips ebb95f8a](https://codeload.github.com/lovell/sharp-libvips/tar.gz/ebb95f8add54eee8bed840e3fb587e4cbec857d7) | 24490 | `65fdb633c2d97626352a3771b7a0ce30b6a89af03d2a1238491c8b068e6b8dad` |

Verify the archive digest, preserve each full directory layout and notices, and
follow the reconstruction instructions below. The MXE source is the
kleisauke fork selected by the pinned recipe; the recorded mxe/mxe archive URL
retrieves the same inspected Git object. Historical build provenance is not
inferred from the recipe's moving branch.

The distributor remains responsible for equivalent recipient access. Before
publication, verify these exact downloads and place this guide/source archive
beside the binary download. If a route becomes unavailable, provide an authorized
equivalent source location; a repository homepage or moving branch is not a
substitute. The descriptor's `complete: false` describes the byte verifier's
limited scope. Review items may change without turning that verifier into a
license-clearance decision.

A maintainer's repository-wide republication answer is not a prerequisite to
this external-source delivery route. Original license and delivery obligations
still apply. Historical inquiries and findings below remain dated evidence.
The r269 Windows payload's GUID exclusion and exact source archive were checked
separately; this native source archive contains no guid-typescript. The final
local Windows/native/Qwen and distribution evidence is recorded in
[the r269 qualification](../../docs/PREVIEW_19.md#r269-local-qualification-2026-11-02).
Public-source CI and recipient access through a published Release remain pending.

### Recipient reconstruction needs complete build repositories

`NATIVE-SOURCE-EVIDENCE.zip` is a selected source/notice collection, not a
standalone build workspace. Do not run its selected recipe files as if the
whole build repository were included. Before reconstruction, obtain complete
copies of these upstream trees at the fixed revisions:

- [build-win64-mxe ef19ca09af2453d127453d677c849ccb37cf5694](https://github.com/libvips/build-win64-mxe/tree/ef19ca09af2453d127453d677c849ccb37cf5694).
  Keep the entire `build/`, `container/` and `packaging/` trees.
  The selected packet omits `build/patches/libtool-2-fixes.patch`,
  `build/settings/release.mk` and `packaging/`; the ordinary release recipe
  uses them. `build/settings/debug.mk` is additionally needed only for a
  selected debug build.
- [kleisauke/mxe c36160b231e66e1cbe032ed54aef7617e8b259da](https://github.com/kleisauke/mxe/tree/c36160b231e66e1cbe032ed54aef7617e8b259da).
  The pinned build-win64-mxe tree selects this fork's `llvm-mingw-20260924`
  branch in `container/base.Dockerfile:14`; that branch reference is not a
  commit pin or proof of the historical binary's build. The source map retains
  the original download URL through `mxe/mxe` for the same Git object.
  The four selected base recipes are not the complete toolchain/build tree.
- [sharp-libvips ebb95f8add54eee8bed840e3fb587e4cbec857d7](https://github.com/lovell/sharp-libvips/tree/ebb95f8add54eee8bed840e3fb587e4cbec857d7),
  the commit referenced by tag `v1.3.4`. Keep its full packaging layout,
  including `versions.properties`, sourced by `build/win.sh` through the
  recipe's `/packaging` mount; this file is not in the selected packet.

Use a full checkout/archive of each fixed tree, rather than copying a single
linked script or using the moving default branch. A Git checkout must report
the listed commit from `git rev-parse HEAD`. These paths and the sharp-libvips
tag-to-commit mapping were read from the official repositories; the commands
and container builds were not executed during this review. Follow their
included build/mount instructions and preserve the component patches,
non-patch edits, GVDB and selected Rust sources described in the source map.
Keep the sharp 0.35.5 MSVC wrapper source and ABI requirements in the linked
native notes when replacing libraries.

This documents an accessible pinned reconstruction route, not a fully offline
toolchain bundle, historical container-digest proof, bit-identical rebuild or
validated replacement DLL. The final distributed ZIP must still expose this
guide and the source archive/descriptor with their manifest-bound hashes.
The current source input and descriptor are the v4 bytes identified above;
historical v2/v3 archives and the fixed r267 candidate remain unchanged.

## Optional Agent SDK provider (candidate source)

An offline production dependency fixture excluded
`@anthropic-ai/claude-agent-sdk` and its proprietary native CLI packages. The
MIT-licensed `@anthropic-ai/sdk` remains an independent dependency. SDK types and
synthetic provider tests retain the exact development version `0.3.296`; this is
not a change to provider selection, the published preview.18 assets, or operating
configuration. Managed Windows still uses local-qwen/noop as documented above.

For a portable deployment that deliberately selects `agent-sdk`, separately
install the optional peer `@anthropic-ai/claude-agent-sdk@0.3.296` under its own
terms, or install it in `~/.agentmemory/extensions/agent-sdk/node_modules`.
For example, after reviewing those terms, run your package manager's explicit
`npm install --prefix <extension-root> --save-exact @anthropic-ai/claude-agent-sdk@0.3.296`
yourself. AgentMemory does not run this command, accept terms, download SDKs,
or configure credentials. On managed Windows the process home is installation
`home`, so the extension root is `home/.agentmemory/extensions/agent-sdk`.
This is outside the immutable `runtime` payload and must remain in its owned
home backup/recovery set; do not install into the versioned managed runtime.

The loader checks the exact package name/version, ESM entrypoint, physical path
boundary and exported query function before use. An existing extension takes
precedence; invalid extensions, redirected roots and escaping module paths fail
explicitly rather than falling back. An absent SDK produces an actionable
`agent_sdk_optional_provider_unavailable` error when requested; local-qwen/noop
do not load it. Loading an extension executes user-installed code: metadata/API
checks do not authenticate its publisher or prove its safety. Only use a package
you have independently chosen and verified. Portable opt-in remains explicit
through `AGENTMEMORY_ALLOW_AGENT_SDK=true`; existing provider precedence is
unchanged. Do not add this opt-in to the managed profile to bypass its capabilities.

That fixture used an interim lock. The preserved-version lock initially failed
offline policy verification because registry metadata was missing. A subsequent
supported metadata-only refresh passed the policy check and an offline frozen
lockfile check without changing lock bytes or downloading package payloads.
This does not qualify a final build or distribution artifact. The import-safe internal `dist/providers/index.mjs`
entry enables synthetic tests of the same bundler settings without starting the
worker or CLI.

Only synthetic module loading/provider regressions and offline dependency
checks are in scope for this change. Real SDK authentication/model execution,
Windows extension preservation across install/recovery, and a new qualified
distribution remain separate acceptance work; historical r253 results do not
qualify changed source bytes.

## AI development disclosure and validation limits

Most downstream modifications were generated and revised by OpenAI Codex from
user-provided requirements and iterative acceptance requests. The repository
owner did not manually review the source code. Validation is based on automated
tests and live functional testing in the owner's Windows/Codex environment; no
independent third-party code or security audit has been performed.

The current evidence is deliberately narrower than a production guarantee:

- qualification was performed primarily on the owner's Windows 11 and Codex
  configuration, not every supported Windows release or Codex configuration;
- automated tests and selected live flows cover the supported profile, but not
  every destructive, mesh, bridge, import, or export path against real user
  data;
- local-Qwen graph output is provenance-checked derived information, not a
  source of truth;
- provider-backed summary, consolidation, reflection, crystallization, and
  compression are intentionally disabled in the supported profile;
- upstream updates require source-level review and renewed qualification;
- large upstream-compatible CLI and API registration surfaces remain close to
  upstream structure and have not received an independent manual code audit;
  the Windows hook and its shared project resolver ship together through the
  managed payload manifest; and
- this remains a Technical Preview, not a general production-readiness claim.

## Upstream update preparation

Before integrating a new upstream release, consult the [fixed main comparison and
selective backport decisions](UPSTREAM_REVIEW.md). It distinguishes source preparation
from installed qualification and preserves the current engine/data contracts.

## Preview scope

The preview is intentionally narrow:

- The public downstream release identity is **AgentMemory for Codex on Windows
  `0.1.0-preview.18`**; `agentmemory-codex-windows` is the intended repository
  name.
- Package, API, export, CLI, and MCP compatibility continue to use upstream
  AgentMemory `0.9.30` and the `agentmemory` identifier. These are not the
  downstream release version.
- `r62` identifies the historical public qualification, not a public version
  line or the qualification of this checkout. Each new build uses a fresh numeric
  revision such as `r82`; the builder accepts `r` followed by a positive integer.
- Public source snapshots and generated release-folder names use the downstream
  version.
  The installed runtime directory and CLI still use AgentMemory compatibility
  version `0.9.30` so existing data and integrations are not relabelled.
- Native Windows and Codex are the supported downstream host profile.
- Existing versioned runtime directories are preserved. Build changed contents
  with a fresh internal revision before cutover; the installer refuses a
  different payload at an existing versioned target. Failed cutover follows the
  data-contract recovery boundary below; restoring predecessor binaries is not
  unconditional. Canonical `data` is never replaced by this workflow.
- Existing AgentMemory memory, lesson, graph, audit, and provenance stores stay
  authoritative.
- Local Qwen is optional and capability-scoped to typed graph extraction over
  credential-free loopback HTTP.
- External fallback providers, provider-backed summaries, consolidation,
  reflection, crystallization, and automatic compression remain disabled.
- Build output, install state, canonical memory data, and user workspaces are
  separate lifecycles and must not replace one another.
- GitHub publication, tags, releases, installers, and npm publication are not
  implied by a successful local build.

For Korean readers, the
[Korean README](../../READMEs/README.ko-KR.md) summarizes the product boundary
and this preview contract. This English file remains authoritative for build,
installation, security, retention, and rollback commands.

## Source and generated boundaries

- `hooks/`, `node/`, `powershell/`, `launcher/`, and `config/` are source.
- `Build-WindowsCodex.ps1` generates `dist/`, source maps, types, plugin assets,
  a portable production dependency tree, the hidden launcher, and a complete
  immutable-file manifest in a new staging directory.
- `data/`, `home/`, `logs/`, DPAPI secrets, owner markers, task registrations,
  install state, and backups are installation data. They are never build inputs
  or payload replacements.
- `hook-spec.json` is the single source for the four managed Codex lifecycle
  hooks. The installer renders both the installed TOML and the JSON diagnostic
  view from that spec.

## Build

Run from Windows PowerShell 5.1 or newer with Node.js 24+ and pnpm 11.25.0,
matching this downstream's package.json#packageManager and Windows CI.
The builder checks the selected PATH launcher's actual version before dependency
installation or creating build output. A mismatch, failed version probe or
unpinned declaration stops the build. The version probe disables package-manager
auto-selection; the builder does not install/downgrade pnpm or modify shared
shims/settings. pnpm 11.19.0 compatibility is unverified. The original
upstream-source.json#build_runtime is historical upstream provenance, not the
current downstream build-tool requirement. The output directory must not exist.

```powershell
& .\packaging\windows-codex\Build-WindowsCodex.ps1 `
  -OutputDirectory D:\staging\agentmemory-codex `
  -IiiEnginePath D:\inputs\iii-0.22.1.exe `
  -ScratchDirectory D:\staging\agentmemory-build-temp `
  -ReleaseRevision r83
```

The normal build uses the pinned `pnpm-lock.yaml`, runs the existing skill
consistency check, package tests, Codex hook tests, a single TypeScript build,
`pnpm deploy --prod`, and a public index/CLI/MCP/source-map parity smoke. `-SkipTests` is only for local iteration; it is not a
release qualification.

Choose an unused runtime revision for every build intended for cutover. If r83
is already installed, use a new `rN`; do not replace its immutable package. Python
3 must be on PATH for the HTTP regression tests (public CI uses Python 3.12).

## Prebuilt npm distribution and first installation

The [npm guide](npm/README.md) is the user entry point after both artifacts are
published. A small, dependency-free package contains a fixed-version GitHub URL,
ZIP size/SHA-256, manifest SHA-256 and exact source commit. It has no install or
postinstall lifecycle scripts. It never publishes the private root package or
an upstream-scoped package. Temporary downloads are removed after each command.

`--fresh` (PowerShell `-Fresh`) verifies an empty or absent target;
`--fresh --execute` copies the verified runtime, DPAPI secret, ownership and
configuration into that root. It does not register tasks or modify Codex.
`--activate-prepared` then checks the same user, exact release/payload, task and
port collisions, and absence of managed requirements. With `--execute`, it
registers the existing daemon/watchdog tasks and four hooks. It does not start
the service or edit MCP/OAuth configuration. Follow the npm guide's existing
startup verification and OAuth connection steps. A preparation failure leaves
the partial root for inspection; no existing user files are deleted or replaced.
Activation rolls back only the task registrations and requirements it created.

Publisher workflow: finish source checks, commit the clean release candidate,
then build once with a fresh, unused numeric revision. From that same clean
commit run:

```powershell
& .\packaging\windows-codex\Build-NpmDistribution.ps1 `
  -ReleaseRoot D:\staging\build\agentmemory-codex-windows-0.1.0-preview.18 `
  -OutputDirectory D:\staging\npm-preview18 `
  -QualificationPath D:\staging\build\qualification.json
```

The release builder records raw tracked-input digests before and after the build,
test log hashes and suite counts in `qualification.json`, outside the immutable
release directory. Its Windows scenarios start as `not-run` and native evidence
is absent. That initial record cannot authorize distribution. Attach the actual
same-candidate Windows matrix result and the confirmed native operating E2E
process outcome; passing labels alone are insufficient. The matrix result must
bind `source_commit`, `source_input_digest`, `manifest_sha256` and the four
`scenarios` (`fresh_install`, `managed_update`, `restart`, `failure_recovery`).
`windows_e2e.evidence` identifies that result by path and SHA-256.
`operating_e2e` identifies the existing native evidence root and successful
wrapper `process_outcome`. Do not copy internal evidence into public assets.

### Windows evidence schema 2 and synthetic contracts

Windows distribution acceptance now requires schema 2 with
`evidence_kind: "windows_execution"` and `synthetic: false`.
`verifySyntheticWindowsScenarioEvidence` checks the same action/state/observation
contract for explicitly labelled synthetic fixtures and always returns
`production_qualified: false`. Neither that result nor
`verifyQualificationRecordContract` can be supplied as a verified Windows result
to `verifyQualificationRecords`. The CLI verifies Windows evidence in its own
process before consuming the unchanged, separate confirmed native operating gate.

The Windows record carries an execution UUID and the same candidate source,
input digest and raw manifest hash as qualification. The caller supplies the
actual release directory and raw release-manifest bytes. The qualification's
`windows_e2e.installations` maps installation IDs to exact local roots, install
nonces, exact projects, loopback REST origins and distinct predecessor manifest
hashes for updates. `windows_e2e.powershell` pins the executable path and hash.
These are expectations to fix in the approved test plan, not values inferred
from a success label.

Each scenario has explicit start/end times and ordered phase records:
prepare/activate/start, stop/start, update, inject/recover. Fresh startup invokes
the installed MCP script with `-ValidateOnly` after task/hook activation; a
public package has no private-source closeout side effect to start it.
Historical two-phase private evidence remains valid only when its activation
snapshot and original receipts already prove the active runtime.
Each phase references a
hashed raw process receipt with execution/installation/scenario/phase identity,
PID/parent/creation time, argument array, actual executable and script
path/hash references, raw stdout/stderr and an integer exit code. The supported
profile uses PowerShell `-File` and the manifest-bound installer or installed
stop/MCP scripts. Installer actions require `-Execute` and the corresponding
Fresh/ActivatePrepared switch; no-op commands, dry runs and foreign roots or
scripts do not qualify. This does not execute any command while verifying.

After each action, a hashed timestamped snapshot references the installed
manifest (root, nonce, release and source hashes) and applicable runtime state.
Updates also require the distinct predecessor before the action; restart must
observe a clean inactive run followed by a different active run. The memory
created/search/detail references are timestamped API capture envelopes with
unique capture IDs, execution/installation identity, method, loopback URL,
project, HTTP status and a reference to the original response. Search/detail
must follow the last action; an existing row must predate restart/update/recovery.
The full ID/content/project/origin comparison remains required. Original
injection/restore errors and their raw streams remain attached, even when a
later updater retry succeeds. Structured stdout must be captured as UTF-8 with
an explicit encoding: "utf-8" on its raw reference. Decoding is fatal on invalid
UTF-8; a BOM is accepted and Korean paths are preserved. The future executor must
configure its output encoding before the command, retaining the captured raw
bytes and hash; labelling old host-code-page output as UTF-8 is not conversion.
Opaque stderr may retain its host code page and is not decoded by the verifier.
A rollback failure's restoration stream must be the same failed installer child's
stderr reference (which contains that installer's rollback errors). Unrelated
streams, even nonempty ones, do not qualify; separate rollback processes are not
supported by this profile without a separately verified receipt.

The updater may preserve only bin/agentmemory-hidden-launcher.exe when the
installed manifest reports that actual result and the verified updater output
reports preservation. A snapshot's launcher_preservation references that exact
validated update/recovery action, the preceding installed manifest, timestamped
captures of the previous binary/source and current binary at their fixed original
paths, and the candidate's manifest-bound C# source. Previous manifest hashes must
match captured bytes; normalized UTF-8 C# source (BOM and CR/LF normalization) must
match the candidate adapter source hashes; unchanged binary bytes must match the
new installed manifest. Other files retain exact candidate hashes. A declaration
without those byte/transition proofs does not qualify. Runtime process creation
must not postdate runtime.updated_at, which must not postdate the snapshot.

This validates the consistency and meaning of trusted local execution records.
It is not cryptographic host attestation: a party able to fabricate all input
records and timestamps is outside this verifier's trust boundary. A marker or
JSON schema alone cannot prove a command ran. Collect these records from the
approved executor, retain raw bytes and review the actual run. Old phase labels,
r255/r257 synthetic drivers and their prior PASS labels cannot be upgraded by
editing a marker. No schema 2 Windows production execution has been performed
for this change.

The [collector implementation and remaining integration plan](verification/WINDOWS-EVIDENCE-COLLECTOR-PLAN.md)
separates two import-safe APIs. The existing synthetic-only assembler accepts
supplied benign bytes/receipts and cannot emit production evidence or execute
actions. The new `windows-evidence-host.mjs` defines manifest-pinned host actions,
fixed state/launcher captures and loopback API capture. Its actual factory is
disabled unless explicitly enabled; its separate synthetic factory requires all
fake effects and always emits synthetic, non-production evidence. This code has
only been exercised with fake host effects, plus an own-process UTF-8/identity
PowerShell fixture. Installer/stop/start scripts were parsed, not executed.

The separate `windows-evidence-production.mjs` producer now supplies a fixed
candidate execution interface and an ownership-checked cleanup backend. Import
does not start it. The real factory requires explicit execution, manifest-pinned
tools, isolated targets and the permissions for each actual action. A distinct
fake-effects harness always retains `synthetic_contract` and
`production_qualified=false`; those markers cannot promote its results.
Fresh preparation pauses after one-use nonce enrollment for explicit activation
and configuration. This unit has executed only fake installer/API/process/task
effects. Its PowerShell regression extracts three allowlisted pure functions
from the backend AST and uses fake process probes; it does not execute the
backend's top-level commands or query real tasks/processes.

Prepared-state resumption uses the separate `createWindowsPreparedResumeProducer`
factory and `resumePrepared()` admission. It does not rerun fresh preparation,
reset an old guard, replace its nonce, or recreate a root. The read-only
`windows-prepared-resume.mjs` verifier requires pinned original plan/controller,
successful prepare command and child identity, original enrollment and installed
inventory, prepared snapshot/ownership receipt, and the conclusively closed failed
configuration receipt. Candidate, slot, owner, source and unchanged execution-tool
pins must match; only the separately pinned preparation backend revision may
change. Creation FILETIME numbers are read losslessly and compared with BigInt,
not rounded through JavaScript Number.

A new attempt keeps the original execution identity for the original prepare
receipt and records its own resume UUID, output and durable create-new claim.
The claim is keyed by execution/slot/nonce/candidate and is never automatically
deleted, reset or reused, including after an admission failure. Current ownership
must show the same empty prepared slot with both tasks absent. The read-only
preparation admission additionally checks an unmodified original installed
manifest, an unconfigured config with the pinned fresh installer's five-port
profile, no partial config temp, and absence of the exact prior producer PID.
A present/reused PID or an unavailable lookup holds admission. This observation
does not decrypt a credential, register tasks, alter ACLs or configure the slot.
It pins config bytes for the following explicit configuration action. A claim
alone is not admission or authority to activate.

The final partial/full verifier rechecks the original evidence and the durable
claim; it allows original capture/identity paths only from that verified prior
root alongside the new recorder root. New records retain the failed attempt and
their link to it. Synthetic resumption remains synthetic/non-production, and the
full Windows/native gates remain required. A separate fixed-candidate run reached
prepared state and failed before activation; it is not a completed Windows
scenario. The new resume path has only fake-effects/pure regression evidence,
plus read-only validation of closed original records, until an approved actual
admission and continuation succeed.

The [closed configuration continuation contract](verification/WINDOWS-CONFIG-CONTINUATION.md)
records the typed-null Windows replacement fix, bounded safe diagnostics and
the separate single-ordinal retained-temp continuation factory and native
source-handle replacement contract. It preserves the original claim and failures;
only generated-file/fake-effect regressions have run. No actual held-slot retry
or lifecycle acceptance is claimed.

Preparation input sizes remain bounded: only `install-manifest.json` receives a
32 MiB limit because the complete installed inventory exceeds the ordinary
1 MiB input limit. Config, contract, owner and credential inputs retain that
ordinary limit. SHA256 comparisons first require exactly 64 hex digits and then
ignore hex case; nonce, owner and path matching is unchanged. These external
verification tools are pinned separately from an already immutable candidate;
changing a tool does not relabel the candidate as built from the new source.

Cleanup must re-observe every previously captured role/PID, including identities
omitted or null in later runtime state. Missing records are not absence proof;
changed identities and unknown outcomes hold cleanup. Both observations must
cover the same roles, and active runtime evidence requires daemon, worker and
engine to be present. A stop retains its pre-action proof and passes it to the
backend inspection; every previous PID must be explicitly absent before the new
observation replaces that proof or cleanup proceeds. Identity reuse, missing
roles and unknown outcomes hold the producer. Prepared installations may retire with genuinely absent
tasks; an activated task disappearing is rejected. Explicitly requested removal
also rejects redirected trees rather than weakening ownership checks.

These initial synthetic protocol results are not real lifecycle acceptance.
Later WINDOWS35 and NATIVE56 separately established fixed r267's Windows
four-scenario and isolated native/v2 results, including owned-resource cleanup;
see the [current candidate evidence](../../docs/PREVIEW_19.md#r269-local-qualification-2026-11-02).
The later exact r269 candidate also passed its separately recorded Windows,
native/v2, real operating/Qwen and distribution checks. Public-source review,
exact-public-commit CI and publication remain pending. No default installer
failure seam was added, and the synthetic coordinator itself does not execute
real installation or cleanup actions.

Paired opt-in `EvidenceUtf8`/`EvidenceIdentityPath` parameters capture the child
itself before an approved action; they never change execution policy, ACLs or
authentication. Default script invocations do not load the capture helper. A new
candidate must include the helper and bind every changed script before any live
run. Archived raw inputs retain their original identity paths and immutable
hashes; the verifier confines archive storage to the expected capture root.

The import-safe `windows-evidence-scenarios.mjs` now coordinates four independent
synthetic contract cases through the existing synthetic adapter and semantic
verifier. It requires all fake effects, enforces fixed phase order and returns
only synthetic/non-production acceptance. It is not a Windows execution runner
or proof that the same host installation moved between independent fixtures.
It preserves original failure causes and refuses failed API captures before
continuing. This synthetic coordinator does not execute real Windows actions or
authorize them. The API cannot authorize actions, create a qualification
receipt by itself or replace the native gate. It rejects concurrent actions and
blocks further actions after unknown/nonzero outcomes. All asynchronous capture,
API and assembly methods now share the same operation guard as action dispatch:
capture-first and action-first orderings both refuse overlapping work. Child
environment normalization preserves an inherited Process execution-policy value;
it does not remove or override it while clearing Node/AgentMemory overrides.
Any post-dispatch evidence failure latches the recorder, including stdout,
stderr and receipt storage. Original failures remain available as Error.cause;
if even their error receipt cannot be saved, evidence_storage_error retains that
second failure without claiming a saved receipt. Timeout/output-limit
receipts remain incomplete; pending owned children are not silently killed or
claimed absent. A separately approved owner must resolve them before proceeding.
No production host action or Windows scenario is qualified by this change.

A future Windows run must first fix its exact new candidate, isolated roots,
ports, task names and predecessor, capture the above process/state/API evidence,
and obtain the required authentication/ACL/task permissions. The existing
incident a/b roots and rejected queries are outside the current code/test scope.
Native Codex Memory v2 and AgentMemory are separate systems; configuration or
automatic v2 reading alone does not prove hook coexistence. The later NATIVE56
test used the approved synthetic profile and established its same-request
v2/recall and capture/source scope without changing the user's native memory.
That separate diagnostic does not convert these synthetic coordinator results
into Windows or real-model acceptance. Artifact-specific GUID exclusion and
component-specific sharp/libvips source/build/patch closure still require final
qualification; this verifier change does not clear those requirements.

This produces the versioned Windows ZIP, npm-compatible tarball, release
descriptor and SHA256SUMS.txt, without publishing. It uses the existing pnpm
toolchain to pack the script-free launcher; a separate npm installation is not
required to produce the tarball.
The producer rejects dirty/mismatched source, unmanifested files and junctions.
After final review and the exact-source CI result, upload the exact assets under
the descriptor's versioned GitHub names. npm-registry publication is optional
and is not required for the GitHub TGZ installation command. Publishing artifacts,
creating tags and changing an existing installation require separate authorization.
SHA-256 integrity is not Authenticode signing or an independent security audit.

The ZIP and installed payload retain Apache LICENSE/NOTICE, the official
iii-engine Elastic License 2.0 text, and shipped dependency licenses. See
[third-party notices](licenses/THIRD-PARTY-NOTICES.md); Apache licensing of this
adapter does not relicense the engine or other dependencies.

## One installation entry point

The same `Install-WindowsCodex.ps1` accepts a fresh target, a managed existing
installation, or an explicitly identified original upstream installation.
The npm launcher forwards the same options. Without `-Execute`, the entry point
inspects the selected inputs without changing the installation.

| Existing state | Operation |
|---|---|
| Empty installation root | Prepare, activate and start the supported runtime; `-Fresh` alone remains preparation-only |
| Older owned managed installation | Preserve canonical data, authentication, connections and task identity while replacing immutable runtime files |
| Qualified original upstream 0.9.29 or 0.9.30, file-backed native engine | Stop the verified source, retain its original files and a data copy, then install the supported runtime with the same authentication and listener ports |
| A newer upstream release | Refuse a silent downgrade and retain the source |
| Older unqualified state, Redis or Docker data | Retain the source; direct file adoption is not qualified for this storage layout |

For original upstream adoption, provide `-UpstreamPackageRoot`,
`-UpstreamDataDir`, and the original `.agentmemory` configuration directory as
`-UpstreamHome`. `-UpstreamRuntimeDir` identifies instance-specific lifecycle
metadata when it differs from that directory. These paths identify the actual
installation; a globally installed package alone does not identify its data.
The target `-InstallRoot` must be separate from all source paths. The npm names
are `--upstream-package-root`, `--upstream-data-dir`, `--upstream-home`, and
`--upstream-runtime-dir`.

Managed upgrades retain existing operational settings. Original adoption carries
the documented storage/retention/search settings into `upstream_settings`;
provider settings use the managed graph-only local Qwen profile. Original
configuration files remain available in the source directory. Qualification of
these actual installation paths is separate from engine snapshot compatibility
tests. Preview.15 qualification includes actual Windows fresh installation,
managed upgrade, original 0.9.29/0.9.30 adoption, restart and planned adoption
failure recovery. These were performed on the owner's Windows host, not a
broad host matrix; see the public changelog for the boundary.

## Existing-install cutover

The installer supports an owned existing installation. Without `-Execute` it
only validates release hashes, owner/manifest identity, exact paths, and the
managed Codex requirements predecessor. It also rejects a workspace-root change
that would lose an existing LocalAI launcher, before creating backups or stopping
the service. Use the workspace root from installed `config/codex-workspace.json`;
the directory holding the project registry is not necessarily that root. Existing
hosts without LocalAI and fresh installations may still omit this integration.

```powershell
& D:\staging\agentmemory-codex\agentmemory-codex-windows-0.1.0-preview.18\Install-WindowsCodex.ps1 `
  -ReleaseRoot D:\staging\agentmemory-codex\agentmemory-codex-windows-0.1.0-preview.18 `
  -InstallRoot D:\services\AgentMemoryCodex `
  -WorkspaceRoot D:\workspaces\example `
  -ProjectRegistry D:\workspaces\example\.workspace\config\project-repositories.json `
  -NodePath C:\path\to\node.exe
```

Copy `config/codex-workspace.example.json` and replace its two example paths
with the same workspace root and project registry passed to the installer.

Add `-Execute` only for an approved cutover. The installer gracefully stops the
owned runtime, retains a rollback backup, copies only immutable code/config,
preserves canonical data and instance metadata, keeps the existing task
identity and working directory, restarts the owned tasks, and requires the
normal status path to become healthy. It never runs a standard reinstall inside
the live runtime and never migrates or deletes canonical data.

The managed package declares data contract version 5 for the qualified engine
0.22.1 and SDK 0.22.1 runtime. It retains version 4 paged graph write intents,
version 3 source-linked duplicate captures and partial-forget
protection, and version 2 native capture, recoverable graph writes and archive lifecycle state. The release and installed
manifests retain that contract independently of the upstream compatibility version.
An absent declaration means legacy contract 1. The current installer rejects a
target contract below the installed contract before cutover. The managed worker
checks the selected package's declaration before importing its CLI, including
when `AGENTMEMORY_PACKAGE_DIR` selects a different package.

Cutover holds the existing startup file lock, records its phase in the existing
install manifest and retains the contract floor before copying the candidate.
If failure follows a contract transition or candidate startup, the installer
stops the owned runtime and leaves `cutover_failed`, candidate files, canonical
data and the predecessor code/config backup available for review. It does not
automatically restore predecessor binaries against possibly newer data. An
unconfirmed stop also prevents file rollback. Complete or repair a compatible
release; a partial package copy may require review before retry. Reverting to a
legacy runtime requires a matching pre-upgrade **data** backup as well as its
code/config. Successful managed upgrades retain this complete cold recovery set.

These are protections in the supported installer and worker entry points. An
old installer or an independently launched old upstream binary cannot learn this
new contract and must not be pointed at the upgraded live store. Directly
overwriting manifests or bypassing managed entry points is not a supported rollback.

The Codex deployment sets `AGENTMEMORY_FORCE_PROXY=true`, provider
`local-qwen`, capability `graph`, and fallback providers `none`. The provider
accepts only credential-free loopback HTTP and discovers the active model and
context on every graph call instead of pinning either value. Its input budget
automatically grows or shrinks with the discovered context while retaining a
20% context reserve. MCP calls cannot silently mutate the
standalone local fallback store and no external LLM is used.

The active Codex registration uses authenticated Streamable HTTP at
`http://127.0.0.1:3114/mcp`. The existing AgentMemory worker owns that listener,
so Codex tasks share one MCP process instead of starting a launcher and Node
shim per task. Local OAuth uses dynamic client registration, S256 PKCE, and an
explicit browser consent page. Its bearer token is domain-separated from the
DPAPI-protected backend secret; unauthenticated MCP requests fail closed. The
hidden stdio launcher remains packaged as a compatibility path for other MCP
clients.

## Active operating profile

Recall applies project and agent scope before taking the top keyword, vector,
or graph candidates. A fixed over-fetch multiplier no longer determines whether
an in-scope memory can appear. Canonical candidate checks are shared within each
request and state reads use batches of at most eight. Saved memories keep their
own project even when their first source session belongs to another project;
compact and expanded results carry that project, and expansion resolves saved
memories from the canonical memory store. An explicit working directory requires
a proven matching source session directory.

The primary recall path uses graph retrieval even without a populated vector
index. Project-scoped graph traversal excludes other projects, verifies source
session/observation provenance before returning graph-only hits, and skips
superseded or review-retired relationships in current recall. Explicit temporal
history remains separate. Missing graph source provenance does not authorize
guessing a session. These changes do not start a local model or migrate data.

The installed profile uses four managed hooks: `SessionStart`,
`UserPromptSubmit`, `Stop`, and `SessionEnd`. Normal main-agent user prompts and
final assistant responses enter the official session/observation lifecycle;
ambient UI, title/fork, and subagent traffic is excluded. Capture requires the
documented Codex `turn_id` on both prompt and Stop events. An assistant response
is accepted only for the most recently accepted normal prompt's turn in the
same project and working directory. Unmatched or missing turn identity fails
closed. Internal requests preserve existing normal session history; only the
automatic `codex_internal_prompt` exclusion can recover on a later normal
Codex prompt, with an audit entry. Other exclusion reasons remain in force.

Normal user turns require evidence handling before substantive work, including
new and projectless chats. The prompt hook retrieves current-project context,
widening to historical user originals and other records when local originals
are insufficient or historical scope is requested. It can instead validate
originals already expanded in the same uncompacted conversation.
Explicit current-project-only requests take precedence over historical intent,
insufficient local results, and retrieval failures. A request-scoped permission
is carried through keyword/hybrid discovery, original expansion, graph queries
and source reuse. A scope-only follow-up retains the concrete topic; a later
explicit all-project request can reopen federation. Contradictory scope in one
request stays narrow. Quoted text, tool output and assistant wording cannot
authorize broader scope.
The deterministic Korean/English scope grammar is bounded: it does not prove
understanding of every natural-language paraphrase. Scope enforcement is separate
from that interpretation. Restrictions use existing conversation/recall-plan
evidence, without a new user-data store. Local function tests do not qualify a
new operating installation or replace the Windows distribution scenarios.
It reports lookup status separately from evidence coverage; successful search or
injected graph text does not prove that a relevant original was read or applied.
Concrete identifiers anchor retrieval, including identifiers within hostnames;
attachment transport headers are not treated as the user's search topic.

Unavailable lookup is explicitly reported as missing evidence, not no history.
The agent must hold decisions depending on that missing history; independently
supported work and recovery can continue. An optional history failure preserves
local candidates. No-match results require no identical automatic retry.
Image-only requests can require the agent to inspect the image and perform a
topic-specific lookup before proceeding. Stop/cancel requests bypass recall.
For recovery during an outage, users may directly put `AgentMemory 조회 없이 복구`
or `AgentMemory 조회 없이 진행` on the first line and the request on following
lines. This bypass applies to that turn only, not quoted text or document content.
Capture failures retain their independent reconciliation path and do not invalidate
a successful recall. No new queue, per-tool guard, or automatic Stop retry is added.
Hook execution/availability and correct use of evidence must be verified in the
host; a delivered excerpt alone is not an end-to-end acceptance result.

`memory_recall` and `memory_smart_search` expose an optional `agentId`, including
smart-search expansion. Omission preserves the configured agent scope; an
explicit `*` requests a cross-agent read within the selected project. Invalid
explicit agent IDs fail before search rather than silently selecting the default.
This does not assign an owner to existing unscoped sessions or observations.

`memory_sessions` requires `project` (explicit `*` for cross-project reads),
returns newest sessions first, defaults to 20 rows, caps requests at 500, and
returns `total`, `offset`, and `nextOffset`. Excluded sessions may be inspected
only with an exact project and session ID. Listings omit legacy rows without
a usable session ID and project. SessionEnd is a no-op for missing or incomplete
sessions. An explicit SessionStart fills missing identity while preserving
observations and capture policy; known identity is never reassigned.
REST session listings retain the
oldest-first order used by the curation backlog. Oversized curation candidates
are skipped within the existing context budget so a fitting later source can
still be offered with its complete text and provenance.

Managed hooks accept the path-based project registry and version 3
`relocation_ref` entries. References resolve the unique relocation batch
destination, including an explicitly matching nested Git path. Missing or
ambiguous targets, path escapes, linked checkouts, and unverified retained source
identities fail closed. The registry and its sibling relocation manifest remain
the routing authority; hooks do not rewrite them or create a parallel registry.

Existing unassigned normal Codex sessions can be reconciled through authenticated
`POST /agentmemory/session/start` with `action: "reconcile-owner"`. First send an
exact `project`, `sessionId`, a `sourcePath` relative to the configured Codex source
root, and `dryRun: true`. The preview returns the native identity, current/target
owner, observation counts, and `expectedVersion`. Apply the same request with
`dryRun: false`, that version, and a non-empty `reason` (at most 512 characters).
A stale preview or conflicting owner is rejected before changes. There is no
blanket adoption of unassigned history and no wildcard write scope.

The trusted source root defaults to the Windows account's `.codex` directory,
independently of the service's synthetic HOME. An optional absolute
`codex_source_root` in `config/codex-workspace.json` overrides it and is preserved
by updates. Inherited environment variables and request bodies cannot override
it. Only normal CLI/Desktop `session_meta` identity under `sessions` or
`archived_sessions` is read; linked paths, unknown sources and inherited fork
history are rejected. Normally this operation reads only the bounded metadata
header and does not enable automatic collection. When the canonical cwd differs
from the initial header, reconciliation additionally requires the exact native
thread index to agree with the canonical cwd and a complete supported inventory
whose last verified turn context names that cwd. Preview and audit expose
`verifiedCurrentCwd`; the initial source header, canonical cwd and project are
preserved. Merely finding a directory mentioned in conversation text or an
earlier turn does not prove the current cwd.

Reconciliation preserves existing session/observation IDs, contents, counts and
graph cursors. It uses the existing writer exclusion barrier, records an audit,
and stores pending/completed reconciliation provenance on the canonical session.
The session owner is written first so future captures inherit the correct owner;
completion is written only after observation updates acknowledge success. An
interrupted application remains pending and can be previewed again and resumed.
An ambiguous StateModule write still requires the existing worker restart and
canonical verification procedure before further writes. Other agents, excluded
sessions and recovery-protected observations are not reassigned. Derived memory,
lesson and graph ownership is not changed by this session-only operation.

The same authenticated endpoint accepts `action: "inspect-source"`, exact
`project`, `sessionId`, relative `sourcePath`, and optional `limit` (1–200, default
20). This read-only comparison identifies source messages, existing matches,
missing observations and ambiguous legacy correspondence without returning the
conversation text. It reads at most 256 bounded windows per request and reports
partial tails, unsupported records and pending display/primary correspondence
separately. A ready comparison is diagnostic evidence, not an apply authorization
or a graph-completion claim. Initial legacy matching requires a complete native
inventory so a read-window boundary cannot hide another matching repeated input.
Existing capture observations without an explained source match are reported as
`unmatchedCaptures`; a complete inventory with unresolved captures is blocked.
Manual curation and tool observations do not require a native conversation match.
Known internal host notifications use the same exclusion rules as native parsing;
legacy rows with canonical source or deletion/recovery metadata remain checked.
Automatic native capture and graph recovery are not enabled by this inspection.

`action: "initialize-source"` on the same endpoint previews the initial native
correspondence with `dryRun: true`. Applying requires the returned `expectedVersion`,
`dryRun: false`, and a non-empty `reason`; the source root remains server-owned.
For reviewed large-source maintenance, the existing internal
`mem::codex-source-initialize` SDK function also accepts an explicit integer
`readTimeoutMilliseconds` from 30000 to 90000. The default remains 30000;
physical/decoded byte and decoder-window limits remain unchanged. The timeout
is bound to `expectedVersion`, so preview and apply must use the same value.
This internal maintenance option is not forwarded by the REST session action.
Cooperative checks bound the work between reads; they do not forcibly cancel an
in-flight operating-system read. Longer maintenance can hold the session capture
lock longer, so inspect its measured cost and run reviewed repairs sequentially.
Initialization preserves existing observation IDs and metadata.
When its complete inventory has no missing, adopted or recovered records and no
unresolved provenance, source holds or ownership/content repairs, initialization
resumes from the verified end instead of replaying already captured originals.
Missing native input keeps the replay path so it is still collected.
Legacy matching ignores already deleted, unbound empty rows as conversation candidates using
the official empty-observation content check. Those rows and their recovery
metadata are not modified. Protected rows with content, restored state or source
provenance continue to require their existing lifecycle.

Initialization and inspection can also identify a delayed legacy user hook
without enlarging the ordinary five-second window. This requires a complete
native inventory, successful discovery proving no alternate physical source,
one full-content source and one stored claimant across the entire inventory,
the exact original `prompt_submit`/`conversation` synthetic hook shape and user
origin, and a capture timestamp no earlier than that source's session creation.
Hook and native record writes may occur in either order. Conflicting item/turn
provenance, repeated text, protected observations and uncertain source discovery
do not qualify. Duplicate reconciliation cannot infer uniqueness from a reduced
row set. Preview/audit report `adoptDelayedHook`; IDs, timestamps and origin stay
unchanged.

An image-read diagnostic can make the canonical input differ from its displayed
user message. Only a separate terminal host diagnostic with an exact attachment
header and a matching same-turn local-image path qualifies for a display alias.
Each primary satisfies at most one mirror, and cursor resume/source-hold review
use the same correspondence rule. Canonical primary text and identity stay intact.
A legacy hook containing only that proven display can regain the full canonical
text in its original observation through initialization; preview/audit report
`restoreImageReadDiagnostic`. This additionally requires unique full-inventory
claims and no alternate source, and preserves the original user text, ID, time,
origin and other metadata. An absent mirror, quoted/inline diagnostic, different
image path or ambiguous claim is insufficient. No failed file is read or altered.

Ordinary correspondence
uses full-content correspondence within the existing five-second window and
requires a unique mapping across the complete inventory. It can append one final
LF when the resulting digest exactly matches the native source. Legacy synthetic
user prompts can regain their complete text when the upstream 399-character
prefix plus ellipsis reproduces the entire stored narrative and the original
conversation type/confidence agree. This does not trim or otherwise normalize
the source text; competing prefixes remain unresolved. For an unbound, unprotected
synthetic user prompt, a second exact comparison can remove only ASCII space,
tab, CR and LF from the native text boundaries. The complete result, or its
exact upstream 399-character prefix plus ellipsis, must equal the entire stored
narrative within five seconds and have a unique source in the complete inventory.
Recovery restores the original native text in the same observation, preserving
metadata and retrying index publication by that ID. Preview and audit identify
`restoreLegacyPromptWhitespace`. Internal whitespace, Unicode spacing and other
text changes remain unsupported; two competing sources or stored records block
recovery. This compatibility rule does not establish which historical writer
removed the boundary whitespace. Legacy synthetic
assistant records can regain their complete native answer only when the upstream
turn-ID prefix and 400-character truncation reproduce the entire stored narrative,
the native turn ID matches the stored subtitle, and the synthetic type/confidence
agree. Legacy image-wrapper text can be normalized only when actual native
image triplets reproduce the entire stored user narrative, the timestamps are
equal, and correspondence is unique. Existing image references and payloads are
preserved; literal image-tag text does not qualify. Competing source matches still block recovery. Arbitrary trimming and fuzzy
matching are not supported. Unfinished raw
captures can be converted in place through the existing zero-LLM synthetic path
only when their owner, shape and complete source correspondence are verified.
When a later native source generation omits an existing capture, initialization
can inspect up to 16 older source candidates for that exact session. Only a
matching source kind and cwd, complete prior inventory, full unchanged text,
unique identity and the existing five-second legacy window permit adoption.
Previously bound rows must retain their native key. Matching retained records
store their relative path in codexSource.retainedSourcePath and use the existing
indexPending publication retry. Preview/audit report adoptRetainedSource and
retainedSourceObservations; inspection counts retainedSourceMessageCount apart
from current native messages. This preserves already captured history outside a
continuation boundary or superseded source file without changing the current
replay cursor or importing uncaptured prior tails. Ambiguous, protected, changed,
missing and unsupported evidence remains unresolved.
For a complete source whose verified task completion is blocked only by a unique
unmatched UserMessage display item, initialize-source accepts
reviewSourceHolds: true (default false). Preview scans the complete source,
reports at most 128 exact source holds, and includes the option and their
provenance in expectedVersion. Apply requires that preview version and a reason.
Only genuine primary messages are eligible for collection. Each hold retains the
session, turn, item, byte/record locations, text and record digests, and the
verified completion location/digest in canonical codexNativeCapture.sourceHolds;
it stores no display body and creates no synthetic primary or graph completion.
Repeated ambiguous display text, conflicting item identities, unmatched assistant
items, a mismatched final response, unknown records and incomplete tails remain
blocking. An approved hold is not a general permission to skip parser failures.

Incremental reads and restarts cross only those exact reviewed holds. Later
unknown input requires a fresh explicit preview/apply. Capture reports
caught_up_with_holds, inspection reports ready_with_source_holds, and both
report sourceHoldCount; native health also reports the aggregate sourceHolds.
completeNativeInventory describes a complete source scan and does not mean
that a held item acquired a primary message. Observation-level
unresolvedCaptures remains separate and retains its existing protections.
An absent local source (`ENOENT`) sets the existing capture issue to
`native_source_missing`; other read failures retain `native_source_read_failed`.
Native drain and liveness report `sourceUnavailable` as a subset of
`captureUnknown`, not an additional number of lost conversations. Missing source
records remain unknown and require attention. This does not establish deletion,
data loss, or an empty conversation. Cursors, captured originals and graph
provenance remain unchanged; normal bounded capture retries resume automatically
if the same source becomes readable. Do not exclude records from a matching count
or a dummy title: intentional retirement requires an exact source identity and
the existing reviewed lifecycle, while unknown absence remains visible.
An explicit AgentMemory session archive combined with `native_source_missing`
retires that source from automatic capture and active issue counts. Liveness
reports it separately as `archivedSourceUnavailable`, a reviewed archive count
that does not trigger attention. Restoring the session re-enables ordinary source
checks. A Codex UI archive, a missing file alone, an archived observation alone,
or another read failure does not qualify; readable archived sessions continue
their existing capture behavior. No source or observation is deleted.

Cloud Work/Dot conversations do not acquire local JSONL sources from this
adapter. A deliberate conversation export, a saved durable summary, and a native
local session are separate artifacts. A summary saved from a local storage chat
retains that chat and its actual observations as provenance; including a cloud
conversation ID in its content does not reassign the source session. Recall the
cloud ID in the approved project to find the summary and its export reference;
an empty native session listing for that ID alone does not prove memory loss.
Do not fabricate a native cloud session or install per-turn cloud export based
on an earlier preference when the latest request asks for a one-time export.
Held sessions and cursors use version 2. Older readers refuse them rather than
silently marking their tails caught up; unaffected sessions keep version 1.
Export/import preserves validated source holds, discards the local cursor and
requires source reconciliation. Older versions reject this held transfer state.
Rolling back therefore leaves held sessions unprocessable until a supporting
version is restored; it must not be reported as fully reconciled collection.

Complete marked ambient UI blocks are stripped before classifying a mixed user
message. A following request remains eligible in replay, observation visibility
and session summaries, including its normal final response. The request text
and native message identity are preserved. Internal-only, unmarked host and
incomplete host payloads remain excluded.
For proven duplicate captures, initialize-source accepts the explicit
reconcileDuplicates option (default false). Complete inventory and the same
existing exact/legacy proofs must uniquely link each row to one native message.
An existing canonical binding is preferred; otherwise a stable observation-ID
order chooses the representative without claiming it was chronologically first.
Other rows retain their IDs and metadata and store codexSource.duplicateOfObservationId.
Any supported body recovery still restores the full native body in place.
Preview/audit expose linkDuplicateCaptures and the exact duplicateCaptures plan.
Distinct primary messages, conflicting ownership/provenance, protected rows,
orphaned links and alias chains remain blocked. Existing valid links need no
opt-in for later capture or import reconciliation. Archive/restore remains a
separate explicit official lifecycle operation; review graph provenance before
archiving redundant rows. Forget must select the entire linked native-message
group, or the whole session, so a duplicate is neither resurrected nor left orphaned.
All repairs are included in the versioned preview and audit, and use the existing
index publication retry. Existing final responses from a turn without a normal
user message can receive verified native provenance when the stored turn subtitle,
complete content and unique correspondence agree. Their IDs, content and derived
references remain intact; `codexSource.legacyExcludedReason` records their original
exclusion from normal capture. Inspection counts these source records separately.
The preview and audit identify adopted excluded finals. This does not insert
previously uncaptured internal responses or change normal capture eligibility.
Final-response hooks record their collection time, which may trail the native
answer by more than five seconds. An unbound, unprotected assistant capture may
be adopted outside that window only when its exact stored turn ID and complete
answer prove a unique source in the complete inventory, and collection follows
the native answer. Preview and audit report `adoptDelayedFinal`; the original
collection timestamp is preserved alongside the canonical source timestamp.
Historical `codex-task-recovery:prompt_submit:<item ID>` imports may use a
displayed UserMessage item ID instead of the primary message or execution turn
ID. Complete inventory can link that item to one primary user message only when
the turn and full text agree and neither identity has a competing claim. An
unbound, unprotected import with that exact item provenance and unchanged full
body can then be adopted outside the ordinary time window. Its original ID,
timestamp and metadata remain intact. Preview and audit report
`adoptImportedUserItem`; this source-derived proof is not persisted, and display
items are never collected as additional messages or used without a primary.
Historical `obs_codex_recovery_*` user observations can regain their native text
when the original content-part assembly reproduces the complete stored digest
and deterministic observation ID. The exact source timestamp and stored
`Codex original turn` provenance must agree, and competing source claims still
block recovery. This handles separators once introduced by image or blank parts
without applying arbitrary whitespace normalization. Preview and audit report
`restoreLegacyRecoveryParts`; the source-derived helper proof is not persisted.
Legacy `MM/dd/yyyy HH:mm:ss` timestamps can be restored to the native UTC instant
only when they exactly reproduce its UTC calendar fields, the complete body is
identical, and the complete source inventory proves a unique correspondence.
This recovery does not shift arbitrary dates or widen the ordinary time window;
competing messages in the same second remain unresolved. Timestamp repairs are
identified in the preview and audit and re-enter the existing index retry path.
Any unexplained stored capture, ambiguous match or
unresolved legacy forget evidence blocks the entire initialization. An initialized
session accepts `action: "capture-source"` with exact `project` and `sessionId`.
Its canonical cursor advances only after the bounded batch has been stored.
For a canonical session already assigned to a later verified cwd, initialization
keeps the immutable initial source identity and binds its existing cwd through
`captureCwd` in the same canonical capture state. A complete source inventory and
the ordinary observation correspondence checks are still required. Capture and
source relocation check that binding against the current canonical session;
changing the canonical cwd again requires reconciliation. Transfer preserves the
binding but discards executable cursors and requires a fresh source comparison.
This does not move observations, reassign projects or infer missing owners.
Normal managed hooks then request native capture and still inject recall context,
without also storing another copy of the hook text.

For already initialized sessions, the service performs a startup catch-up and a
60-second recovery sweep. Each serial batch selects up to eight sources in stable
ID order, reads up to four windows each, and yields between windows after about
two seconds; an in-flight state or source call is allowed to finish. An unfinished
sweep resumes after a 100 ms yield instead of waiting a minute per batch. Hooks
updating a source's checked time cannot move it behind the current sweep.
Sources with a progressing unread tail request another bounded sweep; unchanged
partial tails and failed reads do not request rapid retries. Discovery is paged
until its current cycle ends, then starts another cycle after the 60-second
recovery interval, independently of capture-sweep completion. Once there
is no progressing backlog or unfinished inventory cycle, ordinary 60-second
polling remains. The in-memory sweep position is only scheduling state; restart
begins a fresh sweep using the existing canonical capture cursors and IDs.
Health exposes `lastCaptureCycleCompletedAt` as a completed inspection pass,
not proof that every source, graph or historical hold has been reconciled.
Capture wakes the existing graph backlog after storage; the source reader itself
does not acquire or start Qwen.

The internal `mem::codex-source-index` function reads the managed source root's
Codex `state_5.sqlite` thread index in bounded ID-ordered pages (default 200,
maximum 500). This requires Node's built-in `node:sqlite`; it is loaded only when
the function is called. The adapter opens the source index read-only, selects
identity metadata only, and never uses it as an AgentMemory state store. It
keeps Codex's registered task ID and rollout path, including replacement filenames,
instead of interpreting filename suffixes as new tasks. Subagent sources are
excluded, unsupported metadata remains unknown, and missing/newer index versions,
incompatible schemas or read failures are errors rather than empty coverage.
Candidates still require original-header, project, inherited-history and existing
observation checks before registration or capture; listing alone authorizes no writes.

The startup/60-second source drain now discovers tasks from that index before
capturing initialized sessions. It shares the hook's project registry and Git
routing implementation. Each discovery pass reads at most 500 index entries,
inspects at most eight new/uninitialized or moved sources and yields between entries after
about two seconds; an in-flight source or state call is allowed to finish. A
successfully created, initialized or relocated source ends that discovery batch
and receives one immediate capture window within the ordinary eight-source limit.
At least one ordinary sweep source can still advance; priority capture does not
reset or advance the ordinary sweep position. The
in-memory index position advances through the page and cycles from the beginning;
after restart it begins a fresh cycle. This position is not capture-completion evidence.

A previously unseen source needs a supported standalone or paginated-fork header, a real
conversation message, a matching current working directory/project and no orphaned
observations, summary or forget evidence. Discovery creates one canonical session
with its native cursor at zero, then the ordinary capture path stores messages.
An existing session with the exact managed owner and matching project can also
transition after the existing preview/apply correspondence check succeeds; each
automatic inventory is bounded to four read windows. Existing observation IDs and
content are preserved. Unassigned/other owners, source replacements, ambiguous or
incomplete correspondence and unknown inherited-history formats still require reconciliation.
For an initialized source moved between `sessions` and `archived_sessions`,
discovery verifies the existing file identity, source metadata and cursor anchor
at the indexed path, then updates only the source location and capture wait state.
When relocation also changes between plain JSONL and Zstandard, discovery first verifies the same original metadata at the indexed location and runs the complete preview/apply correspondence check. It uses the verified new cursor only after that check; missing messages remain for ordinary capture. The saved cursor is not advanced by this check. The normal drain captures any
unread tail, preserving observation IDs and graph provenance. Copies with a new
file identity are held for reconciliation rather than borrowing the old cursor.
For an initialized source, the host index's latest working directory is not its
memory ownership identity. The stored original/capture directory must still match
the canonical session, and relocation still verifies the exact original and saved
cursor. A later host directory need not have reached the saved parser cursor;
the original project and directory remain unchanged. Unowned sources continue to
require matching index/header directory and verifiable project routing.
An already owned hook session whose worktree no longer exists can initialize
using its canonical project and the matching index/header or verified later cwd, after the same
complete observation correspondence check. It does not infer a new project from
the absent directory name. A new source without an existing owner still needs
verifiable project routing. Codex task archival does not archive, hide or delete
the AgentMemory records derived from that task.
Empty originals do not create empty sessions. These unresolved cases remain visible;
automatic discovery is not a claim that historical migration or whole-Codex graph
coverage has completed. The packaged hook now includes `codex-project.mjs` beside
`codex-turn.mjs`; both are required when copying the hook independently.

A paginated fork must declare matching parent ID, ordinal and byte boundaries in
its native header. The adapter retains that reference in source provenance and
reads the child's own rollout only; it does not recapture the parent history.
New final answers may continue that inherited conversation without another user
prompt; internal title/ambient turns remain excluded.
Records before the child's creation time or without a valid timestamp stop the
read as unknown. Cursor identity includes the parent boundary, and export/import
preserves it while requiring host cursor reconciliation.

A same-task continuation with `history_base` reads the declared prefix from one
proven earlier rollout, followed by the current file after its metadata header.
The adapter checks the same native task ID, supported source kind, chronological
header timestamps, and exact line/byte boundary. Filename matches only select
candidates; they never establish task identity. The logical source retains the
original creation time and the prior relative path. Original files stay unchanged,
and bytes beyond the declared earlier boundary are excluded. Cursor identity binds
both files and the reference, so replacement or a changed prior file requires
reconciliation; appending to the current file remains resumable. Transfer preserves
the reference and requires host cursor reconciliation. Missing or ambiguous prior
files, nested external segments, and fork bases remain unsupported and held.
Working-directory differences still require the separate ownership reconciliation;
joining source history does not authorize project reassignment.

Initialized native sessions use per-observation graph completion records. An older
insert remains eligible even when the forward cursor is newer or the session was
previously complete. A valid zero-entity result is recorded as processed. Records
match the exact source input and graph reset boundary; changed inputs and graph
resets invalidate the prior result. The forward/backfill cursors remain progress
hints rather than proof that every observation was processed.

Validated graph assignments and completion records are stored in one recoverable
StateModule write plan before application. Startup recovery reuses those exact
assignments and checks source identity, source content, and target preconditions;
it does not rerun the model for a partially applied result. An uncertain write
acknowledgement retains the existing worker-recovery boundary. Canonical writers
wait for a successful active application and remain blocked if recovery fails.
Completion transfer through every backup surface and whole-corpus activation
still require the remaining lifecycle integration and acceptance checks.

Managed Codex forget now retains minimal capture exclusions in the official
StateModule store before deleting observations: session/observation identifiers,
an exact native source key when available, or legacy timestamp/kind/content
digest. It retains no deleted conversation body or attachment. An ambiguous
legacy exclusion blocks source reconciliation instead of guessing. Failed
deletion remains distinguishable from completed deletion when its original row
survives. These exclusions apply to both inspection and initialized native capture.

A whole-session forget excludes native history through its recorded forget time
and the exact targeted captures. It does not prohibit all future messages in the
same Codex task. A later whole-session forget can extend that time boundary.
Capture exclusions survive ordinary merge/replace imports. Imports that would
restore a forgotten capture or contradict surviving canonical rows are rejected
before import changes. Explicit forget remains deletion, not recoverable archive.
Exports containing exclusions or native capture provenance use
`0.9.29-codex-lifecycle-1`; older readers
must reject that unsupported version rather than silently omit the exclusions.
The portable package compatibility version is `0.9.30`.
Exports containing reversible archive lifecycle metadata use
`0.9.29-codex-lifecycle-2` and include the original targets with their archive
states. Explicit archive inspection and mutation use `memory_archive` or
`POST /agentmemory/archive`; automatic archive policy is not enabled.
Use `action: "candidates"` with one exact `project` to review the current
retention/TTL candidates. `policy` accepts `all` (default), `retention`, or `ttl`;
`threshold` defaults to 0.15; `limit`/`offset` page the project-filtered results.
The response includes an evaluation time, policy parameters, exact target IDs,
selection reasons and invalid-policy record count without returning original
bodies or changing access logs, retention scores, archive state or source records.
Retention uses the existing default decay formula recomputed from current records
and access history; unavailable history fails the request rather than selecting
records as unused. TTL retains the existing strict `now > forgetAfter` rule.
Archived/deleted targets and unresolved project ownership are excluded. This
preview covers memory and semantic retention plus memory TTL, not other cleanup
heuristics. Each page is evaluated against current data, not a historical snapshot.
Candidate status alone is not approval: inspect each target and request its
individual archive preview before applying a reviewed change. Existing automatic
cleanup settings are not enabled or changed by this read-only action.
Automatic TTL/contradiction cleanup, age/capacity eviction, retention eviction
and lesson decay preserve targets with archive lifecycle history and their source
sessions. A manual restore does not authorize deleting the same original on the
next automatic sweep; use explicit lifecycle review for subsequent cleanup.
Unprotected records retain the existing cleanup rules. Protection is resolved
before mutations and cleanup stops on unreadable or invalid archive provenance.
Retention eviction and lesson decay join the existing observation writer boundary
so archive/restore cannot race their candidate selection and writes. These rules
do not enable automatic cleanup or replace explicit forget with archive.
Explicit `POST /agentmemory/forget` requires the archive's exact `project` when
an archived memory, session, observation or affected graph target is involved.
Its session dry-run reports `archiveTargets`. After confirmed original deletion,
the same operation removes only that target's archive metadata and audits the
removal; surviving graph originals keep their archive state. If metadata cleanup
fails after source deletion, retry the same exact request to finish cleanup.
Deleting a source does not create a content-bearing archive or permit restore of
the deleted original. Pending archive imports must be recovered first. A session
forget that would remove another archived target's required project provenance
is rejected for explicit dependency review instead of silently orphaning it.
The same metadata cleanup now applies to governance memory deletion and lesson
soft-delete. Supply `project` to the existing MCP/REST delete request for an
archive target. Governance bulk filtering honors that exact project before
preview or mutation, and a mixed-project explicit ID list is rejected before
deletion when a project is supplied. After a bulk cleanup failure, use the returned
failure IDs with exact governance deletion to finish metadata cleanup; repeating
a content filter cannot rediscover an already removed original. Lesson deletion
keeps the upstream soft-delete contract: its row remains marked `deleted`, while
its archive metadata is removed. This is not physical erasure of lesson content.
Direct graph purge and the graph-provenance stage of explicit forget now use
the existing durable graph write plan. Version 2 supports exact deletions alongside
assignments; version 1 assignment plans remain readable. A deletion stores its
original digest and address, not a backup of the deleted body. The plan includes
the canonical graph, affected lookup/query indexes, matching archive metadata
removal and the completed audit state. Archive-only cleanup plans are rejected.
After an ambiguous state acknowledgement, ordinary graph reads and canonical
writes remain fenced until the existing fresh-worker recovery reapplies the
same plan. It accepts already-applied changes and refuses conflicting state.
In source forget, graph failure leaves the source records present; recover the
graph plan before retrying that exact source deletion. Independently supported
graph records keep their archive state and remaining provenance. Inspect the
completed purge audit and canonical results after recovery rather than treating
an old inventory as a fresh purge request. The patched engine's process-crash
qualification and managed rollback boundary are documented below and above;
full release acceptance and explicit activation approval remain required.
Ordinary memory lists/counts/details, semantic/procedural lists, skill list and
matching, working context and related-memory traversal also exclude archived
or import-pending originals. Related-memory traversal does not use a hidden
memory as a bridge. These filters run before page counts, ranking limits or
context budgets, and a restore exposes the same canonical ID. Explicit archive
inspection remains the route for viewing a hidden original.
Snapshot creation and restoration use the same transfer
boundary. Merge imports preserve the destination's existing archive or restore
decision; a stale backup does not change that decision. Replacing an archived
original with different content, transferring metadata without its original, or
reassigning its project is rejected before import writes. Replace imports require
a destination without archive lifecycle history; use merge for an existing store.
An interrupted archive import retains a hidden pending state until the identical
payload's originals are verified as stored. Export and manual visibility changes
remain unavailable for that pending target until recovery finishes. The export
version fence protects transfers; the managed data-contract floor separately
protects supported runtime updates and package selection for the live store.
Legacy Mesh payloads cannot carry archive/restore history or its source records.
Stores with any archive lifecycle history therefore reject legacy Mesh push,
pull, receive and export, including after a restore. Receive also rejects a
payload containing archive metadata instead of silently discarding it. Use the
archive-aware export/import functions to transfer lifecycle originals; merge
preserves the destination's own archive/restore decision. This is an explicit
compatibility boundary, not automatic archive synchronization between peers.
A refused transfer leaves the synchronization cursor unchanged. REST transfer
refusals return HTTP 409. Copies previously sent to a peer are not recalled.
Claude MEMORY.md regeneration omits archived and import-pending memories before
its line budget and exposes the same original again after restore. Metadata read
failure prevents a new file write. Regeneration and Mesh export participate in
the existing writer boundary so an archive transition cannot race their reads.
Previously generated or independently copied files are not automatically erased;
the explicit bridge-read operation still reads the configured file as it exists.
Ordinary injected context, lesson recall/list, session pages and observation pages
now exclude archive targets before their result limits. Session-level archive
also hides that session's observations. When individual observations are archived,
the session's aggregate summary and cached first prompt are withheld from ordinary
session/context responses; context can still use the remaining observations.
Original summaries and independently retained memories stay in canonical storage.
Restoring a lesson takes effect on its next recall even with a warm lesson index.
Direct graph queries also filter archive state before node/edge pagination and
traversal. Archived nodes cannot act as bridges, and their incident edges stay
out of ordinary results without deleting canonical relationships. Exact edge
inventory revisions include the graph archive state and become inexact if it
changes during the read. With archived graph targets, the default viewer query
uses the existing exact index; if unavailable, its bounded snapshot fallback
filters archive state and reports potentially incomplete totals. It never falls
back to canonical graph enumeration. Temporal retrieval respects current archive
visibility as well. `graph-stats` retains canonical snapshot counts and labels
them `includesArchived: true` when applicable; those are not active-only counts.

For an exact project, use `action: "list"` to page archive metadata (20 by default,
maximum 100, with `state: "archived"`, `"restored"` or `"all"`). Use `action:
"inspect"` and an exact `{kind, id}` target to read its canonical original and
lifecycle state; observation targets also need `sessionId`. Inspection does not
restore or strengthen the record. Use `action: "archive"` or `"restore"` for a
preview, then pass `dryRun: false`, the returned `expectedRevision` and
`expectedDigest`, and a reason to apply that reviewed change. Stale previews and
missing/deleted originals are rejected. This tool preserves source references and
does not substitute for an explicitly requested forget. The remaining full
acceptance checks must finish before deploying this development candidate
against live data.
Transferred native sessions retain source identity but discard the host-specific
cursor and require reconciliation before capture resumes. Observations-only
imports also invalidate an affected native cursor. A verified resumed session
may retain post-forget observations; earlier observations, an old first prompt,
and the forgotten summary cannot be restored through that exception.

Durable writes and graph provenance remain exact-project scoped. The legacy
session/observation `POST /agentmemory/forget` apply path is irreversible and does
not reconcile all derived references; do not use it for an unverified cleanup.
Pass `dryRun: true`, an exact `project` and `sessionId`, and optionally a non-empty
`observationIds` array for a read-only content and reference inventory. Empty ID
arrays are rejected rather than expanding to a whole-session deletion. This
preview neither authorizes deletion nor provides a transaction against concurrent
writers. The pinned iii-engine 0.22.1 `state::list_groups` API enumerates every
observation and enriched-chunk bucket, including legacy sessions without IDs and
orphan buckets. A failed scope/read operation fails the preview; it never silently
claims complete coverage. The ID-less session count remains diagnostic metadata.
It does not remove records or create a recovery copy.

Local revision r94 reconciles `Session.observationCount` from the actual visible
observation rows for sessions or observation buckets included in an import.
For an exact existing session, `POST /agentmemory/import` with `strategy: "skip"`,
an empty `sessions` array and `observations: { "<exact-session-id>": [] }` repairs
only its count; provide the normal compatibility version, export timestamp and
empty `memories`/`summaries` arrays. Verify the session's registered project first.
It neither imports observations nor changes capture state or graph cursors.
The response reports `reconciledSessions`; an identical second repair reports 0.
Existing recovery-protected sessions remain subject to the import prohibition.

Local revision r97 marks an affected session pending when an import actually
writes observations and the existing graph cursors leave an unprocessed tail.
It notifies the same backlog scheduler after exclusive import access ends.
Capture metadata and forward/backfill cursors stay intact. A complete backup
restore, duplicate-only import or count-only repair does not reopen graph work;
disabled extraction remains disabled. Historical inserts before an already
processed cursor still require explicit scoped extraction/backfill and provenance
verification; r97 does not rewind completed history. Notification failure leaves
committed data pending for the existing recovery probe instead of failing import.

Local revision r98 keeps forward and bootstrap-backfill cursors monotonic when
explicitly extracting historical observations. The existing session lock covers
comparison with current official timestamp/ID order and completion calculation.
Unsorted selected inputs do not rewind progress; historical graph provenance is
still extracted, and an unprocessed tail stays pending. An unknown existing
cursor is preserved for explicit repair rather than replaced with a guessed
position. This does not automatically extract historical imports before a cursor.

Imports use the existing single-worker exclusive observation lifecycle. An
already active writer causes a no-change busy failure; incoming writers wait
until the import settles. This is not a database transaction: a failed import
may have committed rows, and every started chunk write settles before the
exclusive interval ends. Inspect canonical results after ambiguous failures.
Normal small repairs should be bounded to the exact affected sessions; large
imports can delay ordinary capture and should run in a quiet maintenance window.

Local revision r80 adds recoverable empty-observation actions to this same REST
endpoint (no new MCP tool or REST endpoint). Pass `action: "delete-empty"`, one
exact `project`, `sessionId`, a one-element `observationIds` array, and
`dryRun: true`. Apply with `dryRun: false`, the returned `expectedVersion`, and a
non-empty `reason`. `action: "restore-empty"` uses the same preview/apply contract.
The original observation ID and empty fields remain in the canonical observation
row, with versioned `emptyDeletion` audit metadata; no recovery database, side
queue, original-content copy or session snapshot is created. Ordinary observation
reads and graph inputs hide deleted rows. Restore exposes the same row and ID.

This action only accepts observations with no content in known or unknown fields,
apart from metadata and the empty `assistant_response`/`prompt_submit` labels.
Deletion requires a completed session and completed graph processing, zero
bootstrap/backfill, a valid forward cursor strictly after the target, and a
complete zero-reference inventory. One observation is changed per request.
Cursors remain unchanged; active session counts are recalculated from real rows.
The same-version retry repairs count/search side effects without creating a new
version. Recovery metadata stays protected after restore as well.

The supported single-worker service rebuilds its in-memory protection index from
official observation buckets before registering writers. An exclusive lifecycle
attempt returns a no-change busy result while an ordinary writer is active;
ordinary writes wait during recovery. Source writes reject deleted IDs, old-row
overwrites and permanent deletion of protected observations/sessions are blocked,
and import/mesh/snapshot payloads are checked before application. JSONL replay
skips protected sessions, and eviction/auto-forget retain them. Snapshot restore
reads the requested Git object without changing its working tree before validation.
Legacy migration checks sessions, observations and summaries before writing.

An ambiguous canonical SDK write disables further mutations in that worker.
Verify the engine outcome and restart the worker before retrying; errors explicitly
distinguish a committed change, unknown commit outcome, and a preflight failure.
Search visibility rechecks canonical rows, while index persistence is best effort
and runs after the exclusive interval. Whole-install backups preserve recovery
rows; older workers do not implement their visibility or protection semantics.
Keep a recovery-capable worker with this data when restoring an installation.

Native capture uses a strict index flush and keeps failed publication pending.
Within one persistence instance, fingerprints of successfully stored BM25 and
vector snapshots let queued or unchanged flush requests avoid duplicate writes
when the current persisted manifest still matches the committed generation.
An unchanged BM25 mutation revision also avoids serialization and hashing after
this instance successfully saves it and rechecks that manifest. The revision is
checked again after that awaited confirmation; mutations during a save remain
pending for the next flush. Loading a snapshot does not mark the live index saved.
The fingerprint covers the serialized content, including externally retained
vector buffers; it is not based only on request counts or snapshot length.
Changed snapshots remain serialized, failed publication is retried, and a new
worker performs its first requested save normally. Unchanged observation
reindexing preserves posting and tie order. Previous-shard cleanup remains
sequential and records every attempted target and outcome in one grouped audit.
This changes neither stored formats nor the canonical source/graph lifecycle.

The managed user-prompt hook searches the exact current project first, then
performs bounded user-history and general discovery across `*` when current
evidence is inadequate or history is requested. Three or more distinct current
user candidates with no truncated/degraded response and no historical request
permit exact local expansion without repeating global discovery. This is a
bounded adequacy heuristic, not semantic verification. It uses compact
keyword results with source role, title, exact project, session and observation
IDs under a 1,200 estimated-token discovery budget; full narratives do not
consume that discovery budget. It selects at most eight source pairs and expands
originals through authenticated `/smart-search` calls in each exact source
project. `exactExpansion: true` requires observation/session pairs and never
searches other sessions when one is missing. Automatic reads pass
`trackAccess: false` through both REST search and expansion. Nothing rewrites or
persists the recalled originals.

When keyword discovery finds no user candidates or the request asks for history,
the hook conditionally uses existing hybrid search with
`retrievalPolicy: "automatic"`. This additive REST policy skips vector scans above
4,096 indexed entries, graph traversal/expansion and provider reranking. It does
not start embedding providers or Qwen; absent embeddings and provider failures
leave lexical evidence usable while reporting unavailable/degraded channels.
An automatic cold read does not initiate a full index rebuild. Omitted policies
keep existing manual hybrid and expansion behavior.

Managed source validation and transcript reuse use the native realpath API so Windows extended-length paths from Codex remain readable. Equivalent ordinary/namespace spellings must resolve to the same actual file and root; source metadata, file identity and foreign-home/reparse rejection remain enforced.

Hooks recognize the completed capture API outcome `skipped: true, reason: native_source_managed` as canonical source ownership. They continue source capture and retain recalled context; excluded or incomplete skips are not promoted to that outcome.

Failures before context generation include a bounded `agentmemory-recall-failure` diagnosis with the exception category or source-boundary reason and adapter basename/line, when available. It excludes raw input, arbitrary exception messages, credentials and absolute host paths. A diagnosis does not confirm capture or recovery.

A failed current-project read does not silently broaden scope. Discovery,
expansion, filtered/missing sources and skipped semantic channels are reported as
partial coverage; successful originals from another source remain usable.
No returned matches is a bounded result, never proof that no history exists.
Keyword originals need a concrete topical match; semantic originals may remain
labelled, unverified candidates without local word overlap. Source projects are
never reassigned through fuzzy aliases. Selection gives user originals priority,
retains established older requirements alongside later corrections, and spreads
source projects before filling by relevance. Distinct user requirements do not
share the derived-text cap of two per project. Current user instructions win;
selection and source validation do not establish semantic applicability or a
complete requirements list.

Original narratives are emitted whole when they fit. A source that cannot fit
receives an explicit `needs-expansion` pointer containing the exact project,
observation and session IDs rather than a clipped sentence that could lose a
negation or qualification. Derived reports remain labelled separately. Duplicate
source pairs are emitted once. Graph lookup retains its current-project-first
fallback and expands succession through each node's exact source project.
When a follow-up gives only scope or an operation, the hook keeps the recent
concrete user topic in the same session and retains intervening scope, history,
status, and correction instructions. Operational words alone do not qualify
recalled text or graph nodes as topical evidence. Explicit service status recall
queries use that service name to match originals; graph matching keeps its
existing stricter topic rule. The hook reads
at most the last 1 MiB of the canonical host transcript, verifying the session
header and source-root boundary. A small hook plan must bind to the prior user
prompt and retain a concrete subject; a generic or incomplete plan falls back
to actual user prompts, then to canonical observation pages of 200 rows within
one base 3,000 ms continuation deadline (also bounded by the whole hook budget).
The first page is reused for same-session source selection. Explicit new topics
remain independent. Incomplete paging does not publish a complete reusable plan.

Only full `expanded` observation results in tool outputs qualify as retained
originals. User quotations, compact results, assistant summaries and compacted
history do not. At most four same-project originals are re-expanded through the
official `/smart-search` API with access tracking disabled; all must remain
visible and have unchanged content/identity. Successful reuse emits references,
not their bodies, and skips optional graph/curation enrichment. Fresh searches,
changed scope, corrections, current-state requests, compaction, unknown transcript
shapes and failed source validation invalidate reuse or fall back to retrieval.
No separate topic/evidence cache or model call is introduced. Data validation is
not a guarantee that a model understood or correctly applied the originals.
Explicit MCP recall remains available. Graph neighbors need their own topic
match, except for explicit supersession links preserving a matched decision's
replacement and historical status. Local and fallback discovery and original expansion share a base 5,000 ms retrieval
budget. Discovery reserves room for expansion within that budget and the shared
hook deadline. Original recall runs before current input storage; graph and
curation reads follow those two essential stages. Evidence uses the smallest
adequate ceiling of 512, 1,024 or 2,048 estimated tokens (characters divided by
three, labelled as an estimate). This is an adaptive allowance, not a fixed
maximum body on every turn. The existing host limit is 7,600 characters including
the turn wrapper, bounded plan, recall, graph and curation. Assembly preserves
recall first and admits optional context only if the complete block fits.
All prompt work shares one deadline defined in `config/hook-spec.json`.
A lightweight `/graph/stats` read sets a scale of
`max(1, (totalNodes + totalEdges) / 80000)`, capped at five. The 12-second base
prompt deadline and individual read allowances use that scale, up to 60 seconds
of work within a 65-second host ceiling. Unavailable/invalid counts retain the
base budget. These are maximum allowances, not sleeps; fast work exits promptly.
The base covers the measured roughly 30,000-node/50,000-edge corpus. At larger
sizes the allowance grows without editing constants for each increase. Counts
are an estimate of work, not a guarantee of latency: storage contention or a
different graph shape can still exhaust the maximum. Successful recall survives
capture errors, failures are distinguished from confirmed capture, and no new
auxiliary requests start after the shared deadline. The heavy topic/curation
graph reads are serialized; curation observation reads run at most four at a time.
Indexed topic/curation reads still scale with corpus size; this is not a claim of
constant-time graph search. Controlled large-corpus tests supplement actual
installed-hook validation rather than representing a 200,000-node deployment.
No LLM inference is added. Explicit `memory_recall` and REST `/agentmemory/search` also expose
`sourceKind: "user" | "assistant"`; omission retains ordinary mixed-source
search. Speaker selection happens before candidate limits, and keeps existing
archive, source-exclusion, project and agent visibility rules. Derived saved
memories are not original user observations. Generic display/publishing commands such as
`띄워줘` and `게시 진행` can use this same-session topic recovery. This lexical
selection can miss synonyms or unrecognized Korean
inflections; it is not a semantic relevance guarantee. Durable promotion is
performed by the current Codex turn through the official memory,
lesson, and manual graph tools. Local Qwen may add graph entities and relations
only after validating the exact project, session, and observation provenance.
`memory_graph_provenance_reconcile` (and `POST /agentmemory/graph/provenance/reconcile`)
also accepts `action: "retire"` or `"restore"` for exact versioned edge IDs. For
these actions, target `sources` cite the review evidence; the edge's original
supporting observations and sessions stay unchanged. Retirement hides the edge
from active queries, preserves its ID, endpoints, properties, history and original
provenance, and blocks re-creation through manual upsert, typed extraction and
graphify import. An explicit restore requires the current `expectedUpdatedAt`,
live same-project endpoints and valid original provenance. A graph reset/purge
or full-state replacement remains a separate lifecycle; portable temporal/mesh
writers are outside this supported profile. Default `action: "detach"` retains
the existing final-source guard. All actions preflight the whole bounded batch,
audit changes, and report partial storage failures without claiming success.
Summary, consolidation, reflection, crystallization, and automatic compression
stay disabled. Deterministic structural graph extraction remains available
when Qwen is busy or unavailable. The existing local-AI launcher atomically
updates `data/qwen-coordination/qwen-ready.json` after exact owned readiness.
The Windows watcher accepts the final filename and the atomic writer's
`qwen-ready.json.tmp-*`/`.bak-*` filenames, because `fs.watch` may report only
an intermediate rename during `File.Replace`.
That event starts a 15-second stability check and bounded four-batch drains;
full batches may continue after a 30-second cooldown, while a 15-minute probe is
retained only for missed events and AgentMemory restarts. Every batch still
selects the least-recently-serviced project and keeps forward and r30-prefix
backfill cursors separate. Foreground Qwen markers abort background work without
advancing either cursor; malformed graph XML gets one bounded repair attempt.

A newly stored observation also wakes the same scheduler after its canonical
write succeeds. Wake failures preserve the stored observation and the periodic
recovery path. In the managed Windows profile, the environment adapter discovers
only `<workspace_root>/projects/local-ai/scripts/Invoke-LocalAI.ps1` and supplies
its absolute path through `AGENTMEMORY_LOCAL_QWEN_LIFECYCLE_SCRIPT`. Inherited
values are scrubbed; the service environment file cannot override that path.
If PowerShell 7 or the existing LocalAI script is absent, cold start is disabled.
The portable provider does not enable this integration by default.
A failed probe with no lifecycle integration is logged as
`local_qwen_autostart_unconfigured`. Transport failures include their underlying
code and loopback host/port, for example
`local_qwen_transport_failed:ECONNREFUSED:127.0.0.1:8000`; connection refusal alone
does not imply a GPU admission failure. Timeouts and unknown transport causes are
reported as `TIMEOUT` and `UNKNOWN`, with the original error retained as the cause.

When a provider probe fails, the same internal backlog function is queried in
read-only mode. Only a batch that passes the existing source, cursor and output
budget rules permits `start-qwen -Background`. Empty or blocked-only backlog
does not launch Qwen. Startup is single-flight, admission failures have a
15-minute retry interval, and hooks never wait for model loading. The existing
host owns manual holds, resource admission and the GPU transition lease; this
repository does not bundle that host or prescribe universal memory thresholds.
Successful startup and a subsequent provider probe clear the startup retry
restriction before the ordinary 15-second grace and fair batch drain. After a
normal five-minute idle shutdown, newly eligible work can request startup again
without waiting out the earlier 15-minute interval. Failed launches, failed
post-start probes and host admission refusals retain that retry backoff.

The returned exact instance identity is retained in memory. Only a worker-started
instance is released after five minutes of empty backlog or graceful worker
shutdown, using `stop-qwen -ExpectedOwnerToken`. Busy consumer guards defer idle
release; borrowed or replaced instances are never stopped. New observations
interrupt the idle wait. Abrupt worker termination cannot run this cleanup; the
existing host ownership and desktop-exit lifecycle remain the recovery boundary.
No parallel queue, new database or transcript copy is introduced.

A stored response is still not a verified durable decision. The current Codex
model selects reusable decisions and verified fixes through official curation
tools; automatic provider extraction only enriches the source-backed graph.
An explicit invalid citation in a single-observation
local-Qwen response uses that same one-attempt budget to regenerate from the
original observation, then passes through unchanged exact-ID validation. No
prefix matching or citation substitution is performed. After local malformed or
empty output, the existing backlog retries one observation; success restores the
configured batch size. Output-budget and foreground-preemption controls remain
separate. New observations reopen semantic work while preserving both cursors. After extraction, completion is calculated under the observation
lock against the latest official observations, including any tail captured during
the provider request.

## Failure history and lessons

The following condensed history records failure modes that materially changed
the supported profile. It does not reproduce private session logs or imply that
every lesson was extracted automatically by AgentMemory.

1. **Lifecycle integration:** Hooks and configuration alone did not prove that
   the adapter and backend lifecycle worked end to end. Qualification now uses
   an actual session → observation → recall path.
2. **New-session OAuth:** An HTTP/OAuth transition left authentication
   incomplete, and optional MCP registration silently produced zero tools in a
   new Codex task. Authentication changes are now checked in a completely new
   task with callable tools and real CRUD.
3. **Expired consent:** Reusing a one-time OAuth consent URL repeatedly failed.
   Each authorization attempt must use newly issued consent.
4. **Tool-surface checks:** Static tool lists were confused with Codex's lazy
   callable surface. Qualification distinguishes listing errors from genuine
   authentication failures and invokes the real functions.
5. **MCP proxy fidelity:** Special proxy handling risked dropping `project`,
   `expandIds`, or audit filters and could report false success through a local
   fallback. The proxy now preserves official-server arguments and fails closed.
6. **Graph completeness:** A small graph and an over-broad internal-prompt filter
   hid eligible history. Coverage checks now reconcile the eligible-session
   ledger with source observations and detect omissions, duplicates, and orphan
   relations.
7. **New projects:** A fixed project list missed newly created projects. New
   projects are discovered, separated, and resolved to registered canonical
   project IDs.
8. **Subagent contamination:** Treating subagent transcripts as main-session
   evidence inflated the graph and distorted user intent. Raw subagent traffic
   is excluded; only results delivered into the main task are eligible there.
9. **Over-broad Qwen enablement:** Enabling a general provider also activated
   summaries, consolidation, and reflection and competed for the single local
   Qwen slot. The `local-qwen` provider is capability-scoped to graph extraction.
10. **Pinned model assumptions:** Hard-coding a model name and 128K context made
    model changes require repackaging. Model identity is diagnostic only; API,
    context, and schema capabilities are discovered at runtime.
11. **Cross-project recall:** Existing graph data from another project was not
    automatically visible in the current project, and deferred sessions
    remained. Writes stay exact-project while reads use bounded, source-labelled
    federated recall.
12. **Fair scheduling:** Equal oldest timestamps repeatedly selected the same
    project. Scheduling now uses project-level last-service time and verifies
    actual rotation.
13. **Foreground contention:** A background Qwen job could advance its cursor
    before yielding to a foreground request, risking skipped data. Foreground
    work aborts the background job without advancing its cursor.
14. **Immutable releases:** A live check after the r31 installation found the
    scheduling bias. The installed revision was not overwritten; the correction
    was packaged and qualified as r32.
15. **Large indexes:** Parallel writes of large BM25 shards with short timeouts
    destabilized the worker. Shard writes are serialized and bounded timeouts
    are sized for the actual index.
16. **Ambient-session poisoning:** A single internal host prompt could mark an
    established Codex session capture-excluded and silently suppress later
    normal prompts and final responses. Session-wide exclusion is now limited
    to sessions without normal capture, a later normal prompt reactivates a
    provisional exclusion, and the prompt hook no longer spends its timeout on
    a redundant capture-state lookup.
17. **Idle Qwen polling:** A 30-second runtime probe kept waking the service even
    when Qwen was normally off, while short availability windows still drained
    too little backlog. Exact launcher readiness now emits an advisory file
    event, the worker revalidates the live runtime before bounded draining, and
    a 15-minute probe remains only as a missed-event safety net.
18. **Truncated graph XML:** A real four-observation response opened both XML
    roots but exhausted the 2,048-token output budget before closing
    `relationships`; the repair attempt had the same budget and could not make
    the cursor advance. The Windows graph profile now allows 4,096 output tokens
    and a three-minute background deadline, while schema-only prompting,
    provenance validation, cursor fail-closed behavior, and foreground
    preemption remain unchanged.
19. **Ready-event grace reuse:** Windows delivered every atomic ready-file
    event, but a launcher signal for an already known model fingerprint did not
    restart the stability grace. The drain could therefore overlap the
    launcher's foreground-protection window or be absorbed by an earlier timer.
    Every accepted ready signal now resets the grace timestamp and schedules the
    existing bounded drain after that grace, without adding Qwen polling.
20. **Service-side event loss:** A standalone Windows watcher observed all
    atomic replacement filenames, while the long-lived worker still produced no
    drain on the same launcher event. The ready subscriber now deduplicates by
    final-file mtime and size and adds a five-second metadata-only fallback. It
    does not call the Qwen API, load a model, or replace the 15-minute runtime
    safety probe.
21. **Unknown repair endpoints:** A real single-observation response and its
    repair both emitted a relationship to an entity key absent from the same
    XML output. The parser correctly failed closed but deterministic retries
    could repeat forever. The repair contract now requires both endpoints to
    match emitted entity keys and directs Qwen to omit an ungrounded
    relationship instead of weakening parser validation.
22. **Prompt-only endpoint repair was insufficient:** Live r47 qualification
    showed that Qwen could truncate an entity during repair yet retain one
    relationship to that removed key despite the explicit repair instruction.
    Only the repaired response may now deterministically omit such orphan
    relationships. The initial response remains strict, omitted relationships
    are never persisted, and XML shape, allowed types, provenance, and total
    relationship bounds still fail closed before the semantic cursor advances.
23. **Partial XML parsing was not fail-closed:** Adversarial r48 tests proved
    that prose outside the two roots, malformed property tails, duplicate or
    bare attributes, and unknown XML entities could be ignored while a cursor
    still advanced. The bounded parser now consumes the complete envelope and
    every supported child and attribute exactly once; malformed repaired output
    remains deferred with no semantic cursor advance.
24. **Equal nested deadlines hid provider timeouts:** Live r49 draining showed
    `mem::graph-backlog-step` timing out at the same 180-second boundary as the
    Local-Qwen request, before the provider failure could return and enter the
    existing single-observation retry path. Only the two internal graph trigger
    calls now receive bounded 30-second layers of headroom; the provider
    deadline, fail-closed parser, cursor rules, and every non-graph invocation
    remain unchanged.

Historical Codex approval-assessment envelopes (both initial and delta forms)
are consumed by graph replay without deriving nodes or relationships. Their
original observations and chronological cursors remain intact. The official
extraction audit records exact excluded IDs and `processingCompleted`; an
internal-only batch reports `semanticCompleted=false` and makes no provider call.
Normal observations in a mixed batch retain strict, separately filtered citation
validation. New hook capture skips both envelope forms without excluding the
normal user session.

Local revision r144 applies the shared visibility policy to native reasoning-effort evaluator requests, including the stored first-prompt prefix. Internal sessions remain canonical but are excluded from capture, ordinary recall and semantic backlog scheduling. Graph query, snapshot fallback, traversal and retrieval exclude records whose session provenance is entirely internal; mixed or unknown provenance is retained. Exact edge pagination includes the source-visibility revision and rechecks it. Snapshot statistics report `countsScope: "canonical_storage"`; their counts include retained internal sources and differ from scoped visible query totals.

Qwen lease publication, stale reclamation and release use the same exclusive
`qwen-use.lock.lifecycle.lock` file handle as the supported Windows Qwen host.
The OS releases this handle when a coordinator exits; the guard file is retained.
A lease contains the actual process start FILETIME as well as its PID and token.
Unknown identity, inaccessible markers and near-time ambiguous legacy identities
remain deferred. A fully written, closed temporary file is published by a Windows
hard link inside the guard. The packaged PowerShell helper uses the existing
Windows runtime; compiler intermediates use the coordination directory and are
removed by the runtime. It never logs ownership records. Read-only foreground
polling may cancel active background inference, but only the guarded coordinator
reclaims stale files. Every participant must use this host protocol; arbitrary
external programs that overwrite marker files are outside its mutual exclusion.

Qwen lease cleanup retries transient Windows sharing failures with exact owner/token checks. An exhausted own release remains recoverable on the next call, with concurrent recovery serialized; cleanup errors preserve the original request failure. Stream interruptions retain transport cause/address. Daemon startup now reports an exited engine or worker immediately with its exit code and run log paths, preserving the cold-load bounds and owned-process cleanup. The historical Windows 10013 bind cause remains undetermined.

## Source validation without a release payload

During source iteration, run `packaging/windows-codex/Build-WindowsCodex.ps1 -ValidationOnly`.
It runs the frozen hoisted dependency install, skills check, typecheck, build and
existing source/adapter/distribution tests, but does not deploy dependencies or
create an output/release directory. It accepts a dirty source checkout and reports
`source_dirty`; it is validation evidence, not a release source identity.
`-SkipTests` keeps its existing explicit meaning for a focused subsequent run.

Both modes create a fresh `agentmemory-build-<unique-id>` directory under
`-ScratchDirectory`, otherwise `WORKSPACE_TASK_ROOT`, otherwise the portable
host's temporary directory. Workspace runs must provide the D-owned task parent
or use the registered task environment. The builder redirects `TEMP`, `TMP`,
`TMPDIR` and `NODE_COMPILE_CACHE` into that unit and restores the caller's process
environment. After validation succeeds, or the complete release manifest is
written, it removes only that disposable unit. Failures/interruption retain the
unit and report its exact path; a cleanup error fails the invocation before any
success result is emitted. Physical directory checks reject reparse traversal.
The caller's parent/files, dependency store, source `node_modules`/`dist`/plugin
outputs, release payload and arbitrary Cargo targets are outside this cleanup.

Use the normal `-OutputDirectory` and `-IiiEnginePath` invocation once the source is
ready for final packaging. That mode still requires a clean Git checkout and
creates the same self-contained release. Validation does not activate a runtime.

### Continuation topic recovery in local r252

Modified and joined status requests, such as `각종 현황 확인` and
`전반적인 현황확인`, retain the concrete task. A multiline plan made entirely
of generic follow-ups cannot become a new topic. Instructions about the next
report remain qualifiers, including publication holds, while named new subjects
remain independent. Canonical paging still preserves intervening user changes.

An immediately preceding final answer bound to the prior user prompt may locate
the subject of an anaphoric request. It does not replace the recovered user task
or its constraints. Its search terms are taken from the existing bounded topic
tokenizer; the full answer and internal locator label are not sent as a search
query. A matching original from the same session is expanded through the normal
API and retained as derived evidence alongside user originals. Incidental final
answers cannot override a concrete task on a bare status/progress request.

History discovery follows the current and still-applicable prior user scope,
including explicit past/all-project requests. The internal phrase “Previous
answer” or a failure mentioned only in an assistant answer cannot silently
request cross-project history and hybrid retrieval. A current failure by itself
does not request all past history; inadequate local evidence still widens through
the normal discovery path. Named-service status requests use consistent tokens
for retrieval, same-session matching and evidence rendering.

Continuation lookup reports bounded, non-sensitive causes (`deadline`, `timeout`,
`http-NNN`, `transport`, `invalid-response` or `unavailable`) separately from a
valid empty page. Unknown or incomplete history is not absence. Candidate and
context budgets remain limits on evidence coverage, not retrieval failures or
proof that every prior requirement has been recalled. No separate topic cache,
model invocation, schema migration or increased hook deadline is introduced.

### Completed compressed source checks in local r251

Periodic capture reuses a previously committed EOF checkpoint when the compressed
source's path, device/file identity, physical size and modification time still
match. It checks the source path without opening a plain replacement or following
links, preserves the cursor and original rows, and keeps pending index publication
on its existing retry path. This avoids scanning every Zstd block header and
decoding the whole unchanged archive merely to recheck its final 256 bytes.
Changed, replaced, missing, incomplete or segmented sources use the existing
full reader and reconciliation rules. Snapshot identity has the same metadata
trust boundary as the existing compressed reader cache; it is not a cryptographic
proof against an adversarial same-identity rewrite.

A fresh canonical source-read failure remains its specific capture cause; the
backlog does not label that same application failure as a second RPC failure.
Unconfirmed transport failures still retain their RPC diagnostic and retries.
Read-budget diagnostics expose validated numeric usage/limits and the recorded
elapsed-time, physical-byte or decoded-byte reason, without source text or paths.
Legacy records without that reason remain unspecified rather than inferred.
Read limits, source correspondence, original retention and decoder limits remain
enforced on reads that need source bytes.

### Recall evidence budgets in local r250

Recall output retains one representative of byte-identical original bodies per
project, session and speaker, with existing ordering choosing the representative.
It does not delete stored observations or combine different corrections, sessions,
projects or speakers. Compact candidates are expanded before the eight-source
presentation limit; at most 20 exact originals are requested per discovery batch.
The same-session page can identify repeated bodies before expansion. Bounded
candidate omissions remain explicit and do not claim exhaustive history coverage.

Long originals retain exact source pointers, with identical pointer lengths used
for reservation and emission. If source identities themselves exceed the budget,
the output reports the omitted count and requires official search/expansion. The
complete turn wrapper and recall plan share the 7,600-character ceiling; the
renderer reduces body space before output rather than truncating source records.
Pointers do not qualify as read originals for reuse. Current user instructions
continue to take precedence over historical candidates. These bounded changes do
not guarantee semantic recall of every instruction or every historical turn.

### Automatic recall channel status in local r249

When both the embedding provider and vector index are intentionally absent,
automatic hybrid retrieval reports `vector:disabled`. Successful keyword
search and original expansion can then return candidates, or a bounded
no-match result, without a false `retrieval-incomplete` warning. This does
not enable semantic search or imply complete history coverage.

A missing provider/index counterpart, configured empty vector index, vector
request failure, scan bound, keyword index not ready, transport failure and
incomplete original expansion retain their existing degraded status. Qwen
graph extraction is a separate capability; its availability does not enable
vector embeddings. Manual search ranking and stored observations are unchanged.

### Native capture and recall corrections in local r240–r247 candidates

r241 treats joined status requests such as `현황확인` and `상태확인` as
subjectless follow-ups and requests fresh evidence for status. If the bounded
1 MiB transcript tail has lost the topic, the hook reads the newest 48 canonical
observations of the same project/session in explicit descending order. It stops
at the newest concrete user subject, preserving intervening corrections, instead
of reading the oldest page. A missing subject remains `needs-query`; this bounded
fallback does not claim to reconstruct every earlier turn. Named new topics keep
their own query. Source identity and source-reuse checks remain unchanged.

The r241 native status trial exposed another context-selection error: the previous
final answer's incidental transport/UI explanation displaced the user's task.
r242 prioritizes the latest concrete user task for bare status/progress requests,
even without a complete reuse plan. Explicit references to a previous answer still
use that answer as an unverified locator; when no concrete task is recoverable,
the existing preceding-answer fallback remains available.
Transcript message order distinguishes an already answered identical follow-up
from the current input, so repeated `진행` does not discard its prior plan.

r243 also resolves demonstrative and residual references such as `이거` and
`남은 제약` against the user task plus intervening corrections. Repeated bare
status/progress requests keep a stable topic query; status still requires a fresh
read. Relevant originals from the newest 48 same-session observations take
precedence over generic commands from other conversations. Explicit new topics
remain independent. r244 ignores inline Markdown emphasis/code only when classifying
continuations, preserving original input and source digests. Bare 확인 follows
the current task; approval replies still retain their question context.
In r245 the 48-row window is a page, not the end of continuation history.
When the transcript has lost the task, canonical pages are followed backwards
until the latest concrete user task is found, preserving intervening corrections
and deduplicating repeated control prompts. Paging shares a bounded time budget;
failure or exhaustion reports `continuation-history-incomplete` and does not
emit a reusable complete recall plan. A visible session with no originals is
distinct from authorization, transport, or server failure.
The previous assistant answer is only a fallback locator after canonical task
recovery; an incidental answer cannot displace a recoverable user task.

Relevant same-session originals are considered for fully worded requests as well
as short continuations. Within that relevant set, latest user instructions precede
older high-scoring records and assistant reports. Named new topics remain independent
and unavailable local history may still require wider discovery. The 2,048-token
original-evidence ceiling and explicit expansion pointers remain: a finite hook
response cannot prove complete history or semantic understanding. Neither the
1 MiB transcript tail nor output limits are treated as proof of memory absence.

Recall reports candidate/context budget limits separately from actual failed
retrieval, missing originals or a failed same-session read. Candidate results still
require source verification, and oversized originals retain expansion pointers.

r247 also treats bare resume variants such as `이어서 진행`, `마저 진행`, and
`재개` as continuations. Repeated variants cannot become the new task when the
original user request has left the transcript tail. A previous recall plan whose
query contains only a continuation is discarded as a task locator, allowing the
canonical history to recover the task and intervening corrections. Named new
subjects remain independent; these wording rules do not remove the time or
evidence-output bounds described above.

An authenticated prompt capture includes its exact `promptTurnId` and, in r244,
a SHA-256 of the privacy-redacted input. Codex can deliver multiple different user
inputs within one turn; confirmation also matches the digest in the canonical
parser. The hook and parser share the unchanged privacy transform. No raw prompt
is added to this request, and pending hints distinguish replacement digests.
This confirms matching content in the turn, not a unique occurrence of identical
repeated text; canonical source IDs still govern occurrence capture and deduplication.
A cursor
that has not yet observed that turn's ordinary user message reports
`promptCaptured: false`; an available scheduler queues up to four follow-up
attempts with 250 ms, 1 s, 3 s and 10 s inter-attempt delays. At most two due
sessions run before each regular fair drain, with at most 64 pending sessions and
one latest turn per session. Shutdown clears this in-memory priority hint;
restarts, exhaustion and queue saturation rely on the regular source drain.
These delays are scheduling intervals, not end-to-end latency guarantees. Hooks
retain independently recalled evidence while capture remains unconfirmed.
No source cursor is jumped and no observation is synthesized from the hook body.

r246 creates that same scheduler before exposing native capture APIs and starts
its execution after index loading. A prompt observed before its native row is
appended therefore keeps its exact retry request during cold startup instead of
falling back to the full session sweep. Multiple inputs for one active turn keep
the latest digest; canonical window capture still collects all intervening rows.
Shutdown before startup completes discards pending work without starting timers;
the next process recovers from the preserved native source. Search can still
report `index-not-ready` during initialization; a current-session original remains
usable, but this does not claim complete historical search while indexes load.

Structured question replies use an explicit answer topic as the search query.
A single bare status/progress answer continues the existing task in transcript
and canonical-history lookup, without promoting the assistant's question into a
new task. Confirmations and other subjectless answers retain question context.
Transport identifiers remain in the retained original, not the query. Automatic
recall selects by retrieval relevance, then presents selected user originals with
newer entries first. Candidates are unverified evidence, not established facts.

A moved Codex conversation keeps its canonical session project. Hooks resolve the
exact native session through the existing scoped API and request native capture
under that identity; they do not rename the project or submit another legacy
observation. Failed or inconsistent ownership reads remain visible failures.
Previously failed hook jobs require the existing explicit retry with exact native
turn/content/stored-source correspondence.

r244 increases compressed input and decoder output chunks to 256 KiB, reducing
stream iteration overhead on large cold sources. The 30-second read deadline,
8 GiB physical/decoded budgets and 128 MiB decoder window remain unchanged.
Frame/checksum validation, source identity and exact cursor anchors still apply;
this is not a guarantee for arbitrary source size or machine load.

When a continued conversation's retained base becomes compressed, discovery can
recover it through the existing complete correspondence preview and bound apply.
The source identity, canonical observations and historical privacy protections
must still match. This is not permission to skip an invalid cursor or accept
changed source content. Local operating verification and public distribution
qualification are separate; preview.19 remains an unreleased candidate.

## Independent non-live validation

The builder's `-Offline` mode passes pnpm `--offline` to frozen installation
and production deployment, using only the existing pinned cache. Cache misses
fail without downloading; source, adapter, packaging and payload checks remain
mandatory. This prepares a candidate for subsequent acceptance, not a release
already qualified for operation or publication.

`test-suites.json` lists the current independent adapter and packaging checks.
These exercise bounded synthetic hook, launcher, payload, archive, ownership,
lifecycle, recovery-copy, receipt and qualification contracts. They do not
assert equivalence to removed historical tests or replace actual Windows
fresh-install/update/restart/failure-recovery and native/Qwen receipts.
The builder sets both live gates to zero and supplies its owned scratch root;
CI uses runner.temp. The PowerShell wrapper uses the launcher's existing
environment normalization and trusted module search path, without invoking
its ExecutionPolicy argument generator or changing machine security settings.
Child failures are failures, never skipped checks. See INSTALL_FOR_AGENTS.md
for the same suite entrypoint outside the builder.

The payload smoke resolves exports and syntax-checks worker/CLI entrypoints,
then imports only the documented import-safe diagnostics API. It never starts
a worker. A diagnostic candidate remains unqualified; successful non-live
checks alone do not produce a confirmed operating receipt or public eligibility.

Windows scenario acceptance requires hash-bound original child-process receipts
with integer exit codes, phase completion, and saved creation/search/detail API
responses. Compare the exact memory ID, full content, project and origin; a
matching string alone proves neither row identity nor complete preservation.
The search projection omits origin, so the matching ID's detail response is
required too. A null exit code or missing raw response leaves acceptance
incomplete. Preserve prior receipts when correcting a qualification record.
Automatic rollback, withheld rollback, failed restoration and recovery by a
later normal updater retry are different outcomes. A failed restoration records
the original cutover error, restoration error, phase and backup location, and
keeps the owned runtime stopped. Synthetic tests of these checks do not qualify
an earlier Windows run or a new product candidate.

## Build artifact closeout

When a package must be exercised during development, use the existing builder's
`-DiagnosticOnly -IiiEnginePath <pinned-engine> -QualificationScript <task-script>`
with a D-owned `-ScratchDirectory`. It materializes one diagnostic release in its
fresh unit and passes `-ReleaseRoot` and `-ScratchRoot` to the synchronous script.
Share that release across the script's checks instead of cloning dependencies
for every trial; keep independent synthetic install roots inside `ScratchRoot`.
The script must finish its exact child processes before returning, export the
minimum evidence outside the unit, and fail if any check fails. Success removes
the diagnostic package and synthetic installations together; failure retains
them. This is a trusted synchronous callback contract, not OS confinement or a
proof that arbitrary scripts have no background consumers. It never activates
the managed service. Use `-ValidationOnly` when no packaged execution is needed.

After build and related validation/qualification, the main agent must perform this
closeout before reporting the work complete. This applies to validation-only runs,
engine builds, package builds and installation/compatibility tests as well as
release work. A successful build alone does not complete closeout.

1. Identify the exact task-owned intermediate directories and their consumers
   from the actual build/test commands. Include engine target/temp outputs,
   synthetic test data, disposable test installations, diagnostic copies and
   superseded staging/package copies. Distinguish synthetic test data from
   canonical or recovery data before any deletion.
2. After successful validation and consumption, remove only confirmed unused,
   task-owned nonpersistent units using the workspace exact-path, reparse and
   process/approval rules. Reuse needed caches; do not copy entire targets,
   dependency stores or runtimes into another recovery folder. Finish each
   completed unit in the same task instead of waiting for chat/project closure.
3. Retain the accepted package and explicitly required rollback/recovery sets,
   source identity, manifests and the minimum qualification inputs/results/logs.
   Published artifacts and unique audit evidence follow their existing retention
   rules. Keep canonical data, secrets, installation state and shared runtime/
   caches protected. A synthetic install directory is not an approved copy of
   live data merely because its name contains "test".
4. If a build/check fails or is interrupted, or ownership, active use or recovery
   need is unclear, preserve the affected unit and record its exact path, reason
   and condition for review. Do not hide a cleanup failure behind build success,
   treat unknowns as unused, or apply an automatic age/size expiry.
5. Record actual removed paths and logical bytes, retained paths and their uses,
   and failed/deferred units in the existing build/qualification record. Verify
   removed targets are absent and direct parents/protected targets survive.
   Report build/qualification status and cleanup status separately. Do not create
   a new runner, runtime gate, standalone cleanup report or backup ZIP for this.

The builder closes its own synchronous disposable unit. It does not know when
downstream checks or consumers of other outputs have finished, so the remaining
task closeout is still mandatory. For repeated development, retain an explicitly
owned dependency/Cargo cache when its current consumer and reuse need are known;
for one-shot qualification, use a fresh success-cleaned unit and export the
accepted output and minimum evidence before success. Review failed diagnostics
before disposing of them. Do not apply an unmeasured size budget or remove active
or shared caches.
Release/backups still follow the separate rules below; failed staging is retained
until its diagnosis/resume owner has finished and the workspace policy permits
its disposition.

### Private source candidates for local installation

For ordinary local managed updates, explicitly pass the owning task directory as
`-ScratchDirectory D:\Workspace\scratch\agentmemory\<task-UUID>` (or its child)
and put `-OutputDirectory` beneath it. The builder classifies only newly created
outputs under that supplied owner boundary as private installation candidates;
no additional option is needed. Historical scratch/workspace outputs stay unclassified; new local installation builds must use the AgentMemory task boundary above. `-PrivateInstallCandidate` requires this same
boundary explicitly; `-PinPrivateInstallCandidate` protects an exceptional source.
The new qualification record binds exact scratch/release paths, source/manifest
identity and the `private-install-candidate-rolling-v1` storage declaration.
The build result says `pending_acceptance`: building alone retires nothing.
`-ValidationOnly` and `-DiagnosticOnly` retain their existing disposable behavior.

After managed candidate readiness and completed owned backup/runtime retention,
the installer records an accepted private source in `install-manifest.json`'s
`private_package_retention`. Activated fresh private installs register only after
service validation; bare fresh preparation never accepts a source. A later
accepted handover invokes the existing package closeout on recorded private
sources outside the current and actual distinct predecessor revisions. All source
copies of those two revisions remain protected, including same-revision duplicate
builds; this is not a bound of exactly two expanded payloads. Explicit pins,
unknown schemas, missing proof and uncertain outcomes remain protected.

Acceptance history is preserved across upgrades and saved before disposal. Writes
use the existing startup lock and exact manifest stamp; a concurrent accepted
upgrade stops stale metadata writes. The package helper keeps its qualification
journal, source shells and suite logs and records original/recycle/receipt mapping.
An absent payload is reconciled only from its unique completed journal entry;
uncertain outcomes are never blindly retried. Source closeout reports separately
as `private_package_closeout`; incomplete source or backup closeout exits nonzero
while the healthy installation remains active. Canonical data/authentication,
installed runtimes and cold recovery are outside source-payload disposal.

r248 fixes private source staging that could itself exceed the Windows Shell
path limit: automatic closeout uses `s/<unique-leaf>` directly under the declared
AgentMemory task scratch boundary, independent of nested revision/build folders.
The existing physical-path, protected-path and longest-path checks still apply.
An existing staging parent is preserved; only an empty parent created by this
operation is removed. Historical uncertain attempts still require explicit
review and the existing older-package closeout procedure.

Unclassified public outputs and legacy packages are never adopted by path or age.
Public distributions must be built outside this owned scratch output boundary;
the distribution builder rejects private candidate qualification. It does not
silently remove the declaration or infer publication completion. The explicit
older-payload review below remains available for separately authorized history.

### Explicit older package payload closeout

After accepting the current release, use the existing builder's
-CloseoutPackages mode to review exact older package roots. It does not build,
activate a runtime, discover packages recursively, or change installed data.
-ScratchDirectory is the explicit D-owned task boundary; pass the installation
with -InstallRoot and literal package roots with -RetirePackageRoots.
Only each selected root's payload is eligible. Manifests, installer shells,
sibling qualification records and logs remain in place.

The default is a read-only plan. After reviewing actual consumers, publication
and completed failure diagnosis, add -ConsumersPublicationDiagnosisEnded -Execute.
The current revision and actual predecessor are protected by installation
metadata. Pass exceptional retained history through -ProtectedPackagePaths;
installation recovery archives and metadata pins remain protected independently.
Legacy, failed, unqualified and mismatched packages stay protected: this mode
requires a release-candidate manifest and matching successful source, adapter and
packaging qualification plus unchanged suite-log hashes. It checks declared
payload names/sizes and physical paths; unknown data and external/unproven
reparse entries stop the operation. It does not requalify the package or certify
historical data preservation.

Execution holds the existing installation startup lock, installation-manifest
read lock and exclusive qualification-record handles. It rechecks identity and
process/task/configuration consumers before each effect. Qualification evidence
raw bytes and fields remain unchanged; the existing record gains a unique package_closeout_<operationid>
field for this package under its exclusive handle. Only that new field is updated during this operation; prior record bytes are preserved. An incomplete operation stops the
remaining selected targets and records its actual partial result. The existing
Windows recycle-only operation and matching receipt are required; permanent
deletion and fallback are unavailable.

For paths too long for Windows Shell, optionally pass an existing physical
-RecycleStagingDirectory in an explicitly supplied D task scratch on the same volume (which may belong to the current cleanup task). Its physical ancestors and separation from packages, installation and pins are checked. The mode
records the original/staged/recycle mapping, chooses an absent eight-character
leaf and requires the longest staged path to be below 260 characters. Absolute
junction payloads are protected from staging. A failed recycle restores a
definitely retained staged directory to its vacant original path; uncertain
outcomes stop for review. Keep the existing qualification record and returned
result; do not create another backup ZIP or cleanup runner.


## Release retention and cleanup

A successful distinct revision update keeps the installed runtime, its actual
immediate predecessor runtime, and one complete pre-upgrade recovery ZIP. After
stopping the owned runtime under the existing startup lock, the installer copies
and hashes code, all configuration and authentication files, owner metadata,
canonical data, and home state. The held `data/startup.lock` is excluded. It
checks the copied bytes and unchanged sources before touching installation data.
`recovery-set.json` records the exact revision, data contract, owner nonce and
file hashes. After candidate readiness, the existing ZIP compactor verifies all
archive bytes, and the installation manifest records `upgrade_retention` with the
actual predecessor, archive path and SHA-256. Restoring a data contract requires
the matching code and cold data together in a reviewed recovery operation;
extract recovery ZIPs into an empty directory, never over live data.

Only then does automatic retention inspect installed runtimes and backups. It
verifies ownership from the installation nonce and archived manifests, verifies
older runtime bytes, rejects external package junctions, and checks process,
scheduled-task and configuration consumers plus explicit
`upgrade_retention.pinned_paths`. Owned package-internal junctions remain valid.
It recognizes the prior cold-snapshot descriptor format only after checking its
owner, revision, complete recorded file inventory and every byte. The legacy producer may keep the owner marker outside its file list; only that exact marker is accepted separately after independent nonce validation. Unknown,
foreign, unreadable or pinned sets preserve all retirement candidates and report
`release_backup_closeout.status=incomplete`. Historical audit and published source
artifacts remain outside automatic retention. After recovery from a verified
pre-start automatic rollback, the exact cold backup referenced by
`cutover_failure` remains protected failure evidence. Its direct release-backup
path, reparse-free inventory, owner nonce, installation identity and original
failure record must validate. It is never a transient recycle candidate;
missing, changed, foreign or unreferenced directories still hold closeout.
The original failure and its nonzero exit remain historical failures.

Eligible inactive older installed runtimes and recovery copies go through the
existing Windows recycle-only operation, with no permanent-delete fallback.
The shell operation recycles each selected top-level directory as a whole,
preserving its nested package content and internal junctions. Each
operation verifies the original path's absence, surviving parent and protected
paths and matching recycle receipt; archive disposal also checks recovered bytes; uncertainty stops
subsequent operations and reports actual attempts and partial results. A normal
managed update converges to two runtimes and one complete recovery ZIP. Fresh
installation has no predecessor. Reinstalling the same revision preserves its
recorded distinct predecessor and recovery ZIP and recycles only its transient
rollback copy, without creating another lasting archive. An incomplete
post-readiness closeout emits the installation summary and exits nonzero; the
healthy candidate remains activated. Earlier attempted/recycled entries survive
a later closeout error. Failed cutovers retire
nothing and retain recovery material. Pending transition metadata keeps the
original cold predecessor set for a retry; a data-contract transition or candidate
start still prevents silent automatic data rollback.

The bounded read-only `release_backup_retention_review` and explicit manual
maintenance interface remain available. They do not grant deletion permission to
unknown sets or imply that an incomplete automatic closeout succeeded. A healthy
service remains running when retention cannot finish; the returned closeout is
explicitly incomplete.

The installer accepts `-MaintenancePlanPath` (npm `--maintenance-plan`) to select
the existing explicit maintenance path instead of automatic retirement. The JSON input uses
`schema_version: 1`, exact `current_release` and `immediate_predecessor` identities
(`release_revision`, `data_contract_version`, `source_package`), completed
`code_data_recovery` and `consumers_and_publication` reviews, each with an existing
`evidence` reference and `protected_paths`, and `decisions` for every older
reviewed candidate: exact `path`, `action` (`retain` or `recycle`), nonempty
`reason`, and the approved `sha256` for recycling. These declarations reflect
the caller's actual review and approval; a Boolean alone proves neither.
Only direct-child completed ZIP backups classified as older distinct candidates
can be recycled. Current/predecessor/unknown entries and reviewed recovery or
consumer pins cannot be selected. The entire decision set and bytes are checked
before any operation; startup locking rechecks the current installed identity.
Windows recycling refuses permanent-delete fallback. It never empties the bin.
The summary's `release_backup_closeout` distinguishes `disposed`, protected-only,
pending decisions, unresolved identity, omitted protected scope, and failures with actual partial
results. A healthy update remains healthy if maintenance cannot finish, but its
artifact closeout is incomplete. Record the returned actual result in the
existing qualification record; do not create a second cleanup report or ZIP.

The manual closeout's `runtime_packages` remains a bounded, read-only review.
Automatic retirement results are reported separately in
`release_backup_closeout.attempted`, `recycled`, `retained`, and `unresolved`.

Worker diagnostic snapshots now include the executing module's package root and
data contract, with `selectionSource: executing-module`; this is independent of
the installation manifest and inherited diagnostic variables. Older installed
workers lack this field until a separately qualified update; source changes do
not activate a runtime or prove an older worker's selected package.

Keep the active package, the immediately preceding rollback package, the
pristine upstream source archive, and the final qualification artifact for the
active and rollback revisions. Keep canonical `data/`, current `logs/`,
`home/`, DPAPI secrets, owner metadata, task identity, and active manifests
independently of release cleanup.

Older packages, duplicate release backups, failed staging artifacts, and
superseded inactive capture candidates may be removed only after resolving each
exact path, rejecting reparse targets, and confirming that the active manifest,
task commands, and owned processes do not reference them. The successful installer applies the automatic owned-set policy above;
other cleanup remains explicit maintenance. Canonical data is preserved.

### Runtime responsiveness recovery

Managed viewer stream recovery uses `stream::list_keys_page` on the pinned
file-backed engine. Pages contain at most 128 actual item keys and no item
payloads, avoiding a whole-stream WebSocket frame at startup. The helper shares
the engine's existing bounded page validation and rejects unsupported adapters.
The tracker waits for complete pagination before pruning, uses actual stored
keys, and keeps the configured latest-item limit. This affects viewer events,
not canonical observations, memories or graph provenance. Portable hosts keep
their existing stream listing behavior.

Managed audit queries use the existing bounded `state::list_page` route and
retain only the requested newest matching records. A read captures its initial
row count rather than chasing subsequent ledger appends. This avoids transferring
the whole audit scope in a single SDK frame without deleting audit history or
raising the WebSocket payload limit. Portable hosts retain their existing read.

The Windows/Codex dependency lock applies `patches/iii-sdk@0.22.1.patch` to
both SDK entry points. Upstream 0.22.1 reconnects its socket without settling
requests sent on the closed connection. The downstream patch rejects those
requests immediately and drops only queued requests with rejected invocation IDs.
It does not retry an interrupted write or reduce the existing long invocation
timeout. StateKV marks a failed canonical write as uncertain; the existing
readiness and owned-runtime recovery lifecycle handles that boundary. New
requests can proceed through the reconnected SDK. This protects against stranded
locks but does not identify or prevent the host transport disconnect itself.
The real socket regression and release SDK-byte comparison qualify the shipped
patch; production code/config backups remain separate from canonical data.

#### Storage acknowledgement and crash qualification

Unmodified iii-engine 0.22.1's file-backed KV acknowledges an in-memory mutation and
persists dirty scopes on a default five-second timer. The state path is a directory
of per-scope binary snapshots, not a SQLite database. A successful StateModule RPC
therefore does not prove that its value or a graph recovery plan has reached disk.
See the [pinned engine implementation](https://github.com/iii-hq/iii/tree/e7de3820d1e558f3762edf95e4440552444d48d3/engine/src/workers/state).

The opt-in `test/engine-write-recovery.test.ts` launches an explicitly supplied,
hash-verified 0.22.1 engine on an isolated loopback port and temporary data directory.
It checks owned process identity before forced exit and checks recovery through
the real StateModule. Enable with `AGENTMEMORY_TEST_ENGINE` and
`AGENTMEMORY_TEST_ENGINE_SHA256`, and set `AGENTMEMORY_TEST_ENGINE_DURABILITY=required`
for the patched engine; an optional `AGENTMEMORY_ENGINE_TEST_REPORT`
receives local evidence for index publication, paged graph intents, graph/archive
recovery, native capture and bounded original reads. The test runner reports
suite success; the evidence file records completed cases without a fixed-count
acceptance flag. This is not part of routine unit runs or a test against the
live installation.
An additional opt-in `AGENTMEMORY_TEST_ENGINE_PERFORMANCE=true` case measures
ten durable writes in one synthetic 20 MiB scope with 80 rows. It can write
`AGENTMEMORY_ENGINE_PERFORMANCE_REPORT` and is separate from crash recovery
checks. This isolates large-scope persistence cost; it is not a whole-graph
throughput or many-small-records benchmark.

The unmodified engine fails immediate post-acknowledgement crash recovery.
This downstream pins a modified release build with `state::flush` and
`state::list_page`. The managed
launcher fixes `AGENTMEMORY_STATE_DURABILITY=file-flush-v1`; worker startup verifies
the barrier before recovery and function registration. Ordinary writes wait for
flush success. Graph plans flush the intent, assignment batch and intent removal
in that order. A flush failure fences subsequent writes for recovery. Portable
hosts retain the default behavior unless they explicitly require this mode.

Graph intents larger than 1 MiB are encoded as checksummed 1 MiB pages in the
same StateModule scope. The preparing manifest is durable before staging pages;
pages are flushed before the ready manifest; canonical assignments are flushed
before the complete manifest. Recovery discards incomplete staging, replays a
ready plan idempotently after validating all pages, sources and preconditions,
or finishes cleanup after a completed plan. Missing or changed ready pages block
graph access rather than permit partial reads. Small version 1/2 intents remain
readable. Aggregate plan size no longer has to fit a single engine frame; each
canonical record must still fit the transport limit. This does not make query
shard reads independent of corpus size or remove per-record memory limits.

The engine patch uses the existing canonical file store and dirty-scope lock,
waits for file writes/sync/rename, retains unpersisted work on errors, and lets an
in-flight flush finish independently of RPC caller cancellation. It adds no second
database and does not change the stored snapshot format. The qualified release
binary passed all eight synthetic process-crash boundaries; this does not certify
Windows power-loss recovery, disk failure recovery or full production acceptance.

To rebuild the engine, check out `iii/v0.22.1` at the exact `source_commit` in
`config/third-party-inputs.json` and apply `patches/iii-0.22.1-state-flush.patch`.
Use the included qualified Cargo lock and the Rust/native prefix mappings in
**Rebuilding the engine without build-machine paths** below before running
`cargo build --release --locked -p iii --bin iii` in a child x64 MSVC environment.
Use the recorded compiler versions; a bare build without prefix mappings retains
build-machine paths. Assertions must remain unchanged.

Qualify the rebuilt executable with `test/engine-write-recovery.test.ts`, setting
`AGENTMEMORY_TEST_ENGINE`, its actual `AGENTMEMORY_TEST_ENGINE_SHA256`,
`AGENTMEMORY_TEST_ENGINE_DURABILITY=required` and a task-owned
`AGENTMEMORY_ENGINE_TEST_REPORT`. Keep TEMP/TMP/TMPDIR and the Cargo target in
that task's qualification directory. The current pinned hash passed 20 actual
process-crash/write-recovery cases; the optional performance case was not run.
This does not certify power loss or disk-failure recovery.
Retain the qualified binary, hash, test report and build provenance. After every
consumer has finished, remove only this invocation's disposable Cargo target and
test fixtures; preserve failed inputs until diagnosis ends. A locally rebuilt
binary must match the pinned manifest before the package builder accepts it.
Do not overwrite an existing accepted binary or change the pin to hide a failure.

The manifest records the Rust/Cargo, MSVC and Windows SDK versions and Cargo.lock
hash used for the pinned binary. The package builder verifies the binary hash and
normalized-LF patch hash and includes the patch and license in the payload. Source
reconstruction is documented; bit-for-bit rebuild reproducibility is not claimed.

#### Bounded timeline reads

Managed timeline reads enumerate sessions and observation scopes through
`state::list_page` with native offsets. The reader checks page keys and counts
and fails if a page is unavailable or changes during traversal; it never
substitutes a whole-scope list. Portable engines retain the existing list
path. Matching and ordering use lightweight references, and selected original
observations are fetched and checked before the response. This is not an
atomic snapshot across requests.

`memory_timeline` and `POST /agentmemory/timeline` accept non-negative safe
integer `before`, `after`, and `offset` values. The defaults are 5, 5, and 0;
zero is valid. The full requested before/after window is preserved. Each
response returns at most 100 complete observations and stays within 2 MiB
of serialized JSON, including the MCP text envelope. Continue at `nextOffset`
until it is null; `total` is the full window count and `anchorIndex` is null
on pages without the anchor. A single original too large for one response
fails with its session and observation ID. Exact `project` values are trimmed,
`*` intentionally spans projects, and omitting the field retains the existing
all-project behavior. Page order is timestamp then stable ID; concurrent
source changes can invalidate a traversal and require a new read.

#### Bounded graph-index recovery

The managed engine additionally provides `state::list_page` without changing
canonical file layout or durability semantics. Each response contains actual
stored keys, values, the scope's row count and a next offset. The default page
contains at most 128 rows (API maximum 256) and its serialized JSON never exceeds
1 MiB. An oversized single row, invalid offset or unsupported adapter returns an
error; the engine never substitutes a whole-scope response. Page order follows
the existing insertion order. Pages are not a snapshot transaction: the caller
must serialize mutations across a traversal.

The explicit `mem::graph-snapshot-rebuild` operation holds the existing graph
write lock while reading both canonical scopes in pages. It yields between pages,
enforces a six-second timeout per page and a 128 MiB total serialized inventory
budget, and checks stable counts, exact keys and duplicate entries before derived
writes. It preserves reset visibility and source provenance. Partial derived
writes keep the query manifest dirty; success publishes the complete index last.
No canonical node or relationship is deleted or replaced by this operation.
An unavailable managed paging surface fails without a whole-list fallback.
Portable engines retain the previous 25,000-node whole-response ceiling and
refuse a known oversized snapshot before enumeration. Recovery does not require
resetting the graph; corpora outside the bounded budget remain an explicit error.

The managed worker checks query-index consistency during its existing 30-second
health cycle, starting at worker startup. An unavailable index requests one
`mem::graph-snapshot-rebuild` invocation, which rechecks consistency under the
graph write lock before rebuilding. When a clean snapshot matches canonical node and edge totals, only
query shards are rewritten; full lookup rebuilding is reserved for a missing or
inconsistent snapshot and limits each batch to 16 state writes. A completed failed attempt retries after
five minutes; a running attempt is never duplicated. `health.graphQueryIndex`
reports ready, recovering, unavailable or error, with the last failure and next
retry time when applicable. Recovery uses no Qwen invocation. Other observation
collection can continue while graph writers wait for the rebuild lock. Portable
profiles do not enable automatic rebuilds. Query fallback remains bounded and
returns `totalsExact: false`; zero fallback matches are not proof of no matching
canonical records. Empty extraction batches and merges outside the top-degree
snapshot still close their index update, so later exact queries remain usable.

Indexed graph queries recheck the snapshot and manifest revision after node and
edge hydration. A concurrent publication discards the mixed read and permits at
most three attempts within a one-second retry window, polling the existing
writer state without queuing lock work. Clean indexes remain readable while
graph extraction waits for its model. A persistent unavailable index or a writer
that outlasts the retry window retains the bounded, inexact snapshot fallback;
queries never enumerate canonical graph scopes or repair the index themselves.

Managed health snapshots expose `cpu.percent` as the process's share of available
CPU capacity, plus `cpu.corePercent` and `cpu.availableParallelism` for the original
core-equivalent measurement and denominator. Portable profiles preserve their
existing CPU metric. This prevents normal multicore processing from reporting
health 503 solely because process CPU time exceeds one wall-clock core; event-loop,
connection and resource-pressure checks still apply.

Managed memory severity uses `memory.heapSizeLimit`, the configured V8 heap
capacity, as the denominator for the existing heap-pressure percentages. The
snapshot preserves `memory.heapUsed`, `memory.heapTotal`, and RSS; portable
profiles continue to use `heapTotal` as their denominator. The RSS floor remains
part of memory warning and critical decisions.

#### Existing supervisor

The Windows daemon allows up to 180 seconds for the engine's cold state load and
the existing 30 seconds for worker readiness. It checks the database-free liveness
and MCP metadata routes every 30 seconds, with a three-second timeout per route and loopback proxy
bypass. Three consecutive failures end that owned run with
`runtime_unresponsive`; a successful check clears the failure count. Cleanup
uses the existing exact process identity checks and graceful-stop timeout.
The existing watchdog can restart only after the reserved ports are clear and
the Codex consumer is present. No second watchdog or memory store is added.
Authenticated stops and the normal Desktop-consumer exit path preserve the owned
worker and engine while shutdown is unconfirmed. Native reads receive a cooperative
shutdown signal; new native work is refused, accepted canonical commits finish, and
the managed durability barrier completes before SDK shutdown. The eight-second
managed warning does not force process exit. Stop callers still have a bounded
wait and report failure if completion is unconfirmed. The installer withholds cold
backup and cutover on that failure, missing or mismatched terminal identity, or an
unclean exit. A clean already-inactive installation remains eligible for update.
Stall recovery retains its separate exact-owner cleanup behavior; this does not
repair an underlying stall or authorize automatic data recovery.

The liveness response retains HTTP 200 and `status: ok` to identify a running
worker, and includes a database-free `writeRecoveryRequired` flag. An uncertain
canonical write acknowledgement, failed graph recovery initialization, or a durable
graph plan left without an active application sets this flag. The Windows daemon
counts it as an unsuccessful recovery probe using the same three-failure rule.
A healthy in-flight graph plan does not request a restart. Startup resumes the
existing graph plan before exposing the API; a canonical conflict still refuses
recovery rather than overwriting the conflicting value. No readiness probe
starts Qwen or changes its hold and ownership rules.


Managed StateKV mutations are sent in order through one worker connection, including the required durability confirmation. Reads retain their bounded concurrency. A failed durable write holds queued writes until canonical recovery and worker restart; concurrency is not restored by swallowing an error.

The pinned engine records WebSocket send and receive failures in its existing run log with a fixed error category, an OS numeric code when available, and numeric message/capacity limits. It does not record payloads, close-reason text or raw errors. These observations distinguish transport and capacity failures; they do not establish their cause or recovery.

### Stall diagnostics (local r96)

The Windows daemon enables a diagnostic worker thread inside the existing Node
process. It records only registered function names, the six allowed state RPC
names, numeric local parent IDs, start/end times, coarse outcomes and memory
counters. Payloads, results, state keys/scopes, request URLs, credentials,
environment variables, raw error text and heap contents are never recorded.
Portable hosts remain unchanged unless they explicitly supply the diagnostic
file and valid run identity.

The thread updates `logs/worker-diagnostics-<run-id>.json` once a second using a
temporary file and rename. It continues when the main JavaScript loop stalls.
Active entries are capped at 128, recent completions at 64 and queued messages at
512 including reserved completions. Trace admission reserves both start and end
capacity, so overload skips new traces instead of leaving completed work active.
Dropped counts explicitly make incomplete tracing visible. Fixed MCP tools,
resources and prompts handler names are retained alongside mem/api names. The main-loop
heartbeat age and the snapshot's own age are separate: a stale snapshot does not
prove that its last heartbeat still describes the process. A whole-process
suspension or native failure can prevent the diagnostic thread from running too.

After the existing third failed responsiveness probe and before owned shutdown,
the daemon writes one create-new `logs/stall-<run-id>.json`. It validates snapshot
run/PID identity and whitelists its fields, then samples the exact owned engine
and worker's cumulative CPU time, working/private memory, and up to 32 OS thread
states/wait reasons. A missing, invalid or mismatched snapshot is classified and
does not prevent the OS sample or recovery. This is a wait-state sample, not a
native call-stack dump or a proven deadlock diagnosis. Unavailable OS samples
remain explicitly unavailable. Existing incident files are never overwritten.

There is one rolling snapshot and at most one stall incident per daemon run,
alongside the existing run logs; no separate service, storage queue, graph write,
provider call or Qwen startup is introduced. These files are installation logs,
not release payload. Preserve the relevant incident while investigating its
cause and apply the host's log-retention policy with the other run logs. Normal
SDK results/errors are unchanged, the diagnostic thread does not keep an exiting
worker alive, and diagnostic IO failures do not block the existing recovery path.
A diagnostic thread or IO failure emits one fixed warning per run without error
details, paths or payloads; IO retries continue on the existing one-second cadence.


### Hidden desktop windows and capture continuity

The Windows watcher keeps AgentMemory available while an identity-verified
official Codex process is alive, even when no top-level window is visible.
Background turns can continue with hidden windows; window absence alone is not
proof of app exit. Window probe results remain diagnostic. Unknown identity
preserves the service, and verified app exit still uses the existing graceful
stop path. MCP leases alone never extend its lifetime. Closing a window while
Codex remains in the background therefore no longer stops AgentMemory; fully
exiting Codex does. Qwen foreground priority and owned-instance cleanup are
unchanged.

This prevents the observed hidden-window shutdown gap. It cannot recreate a
hook invocation the host never delivered or retroactively capture requests
lost during installation. Missing historical observations require the official
exact-project import lifecycle with original provenance; no alternate queue
or database is introduced.

### Native reconciliation warnings

Indexed graph walks cap queued nodes at the requested page end, with a floor
of 64 and a ceiling of 5,000, and retain at most 1,000 traversed edge references.
Reaching either work bound returns a partial view with `totalsExact: false` and
an incomplete edge inventory. Automatic succession context refuses that result.
Node-page edge hydration is limited to 1,000 edges; an explicit warning directs
complete consumers to the existing exact edge inventory pages. Canonical graph
data is preserved.

From preview.10, discovery accepts a working-directory transition already
verified by the native capture cursor when it matches the current index. It
retains the session's project and original ownership; unrelated paths, owners
or source kinds are still rejected. Archive/restore moves retain the existing
file-identity, source-metadata and cursor checks.

A placeholder index row with `source=unknown` and null `thread_source` can be
classified from its exact original header when `cwd` is empty or matches that
verified header. The adapter
requires a supported source, matching session identity and supported user task
kind, keeps the existing bounded header read, and never rewrites the Codex
index. Missing, contradictory or unsupported source evidence stays unknown.
Codex `configuration_update` response items are settings metadata, not user or
assistant messages. They leave conversation state intact and allow source
capture to continue; unrecognized response types still stop for review.

Registry v4 supports `nested_ref: {project_id, subpath}` in addition to the
existing path and relocation reference forms. Exactly one selector is required.
Nested parents must be registered non-nested projects; parent and child cutover
states must match, and both paths must identify physical canonical Git roots.
Entry order does not change ownership. Escaping paths, reparse points, reference
chains and duplicate canonical roots are rejected. The same resolver serves
automatic source discovery and the managed prompt/stop hooks.

An absent source is pending creation only when all optional index usage signals
are explicitly empty and no canonical session, observation, summary or capture
exclusion exists. A used source disappearing remains an issue. Pending entries
are rechecked, without permanent suppressions or fabricated empty memories.

Agent-created tasks can receive their initial request through a delegation
tool result. Verified task metadata now makes their own final answers eligible
for capture, even after a large tool-only prefix. Tool output itself is not
copied into conversation memory, internal tasks remain excluded, and previous
reviewed-final provenance is retained on an exact correspondence.

Cursor identity changes and verification limits are documented in
[Cursor and Qwen verification](../../docs/CURSOR_AND_QWEN_VERIFICATION.md).
The read-only capture status reports validated cursor rejection metadata; a
physical identity change is not proof of content loss and never authorizes
resetting a cursor or suppressing the warning.

Managed native capture publishes a bounded, in-memory diagnostic summary through
the existing `/agentmemory/livez` and `/agentmemory/health` responses. `nativeCapture`
reports recent attempts, completed drain batches, the last completed discovery
cycle, discovery/capture issues, and known failed graph extractions in initialized
native sessions. `checking` describes an operating reconciler, **not** proof that
every source has been read or every graph is current. Discovery problems remain
visible until a complete subsequent discovery cycle is clean. A drain with no
completion for more than three minutes is `stalled`; this diagnostic does not
cancel it, launch a competing drain, or change Qwen ownership.

The next genuine managed user-prompt hook reads this summary with a one-second
deadline and returns a fixed `systemMessage` warning for missing/disabled/stalled
reconciliation, outstanding issues, graph failures, or a required write recovery.
Normal `local_qwen_deferred:*` yields are not counted as graph extraction errors.
Warnings contain no source content, session identifiers, paths, or raw errors.
The authenticated hook requests `livez?notify=true`. Within a worker lifetime,
the existing liveness handler compares one in-memory aggregate status snapshot:
unchanged status and issue counts suppress repeat warnings, while status/count
changes or a worker restart allow a new warning. Timestamp changes and another
failure of the same kind alone do not repeat it. Ordinary health/liveness reads
do not consume this comparison. This is a notification attempt, not proof that
a person read it; no persistent queue or delivery-acknowledgement store is added.
If the liveness request itself fails, each newly failed prompt check may warn.

Capture errors in `SessionStart`, `UserPromptSubmit`, and `Stop` also return a
warning and exit zero so Codex can consume the warning and continue the user's
work. This is notification transport success, **not** a successful capture; no
capture-completion state is written by that error handler. `SessionEnd` and invalid
payloads retain the nonzero error path. Existing recall context shares the same
single JSON output when capture succeeds.

Codex documents `systemMessage` as a warning in its UI or event stream in its
[hook output contract](https://learn.chatgpt.com/docs/hooks#common-output-fields).
Hook delivery still requires a running, configured Codex host and an applicable
hook event. This is not an out-of-app desktop notification service, and generating
warning JSON alone is not evidence that a person saw it. Whole-corpus and live
host acceptance remain separate from these diagnostic and adapter tests.

### Retained unresolved legacy captures

Explicit full-inventory initialization may use `retainUnmatched: true` to keep
intact, unbound legacy observations whose native correspondence cannot be proved.
Their IDs, contents, ownership and graph provenance stay unchanged. Confirmed
native messages are captured with their own deterministic identities; a retained
legacy observation is not declared a duplicate or assigned a guessed source.
The existing session capture state records matching-relevant fingerprints, and
changed records require reconciliation. Protected, native-bound, raw and forgotten
records are never eligible for this option. Preview identity covers the option.

Native `caught_up` describes the source cursor only. Initialization, capture and
source inspection report unresolved counts. A proven source with reviewed legacy
ambiguities is `ready_with_unresolved`; newly changed or unreviewed correspondence
still blocks reconciliation. The scheduler reports historical unresolved counts
separately from current capture failures. Graph processing may continue, but these counts must not be
reported as complete historical correspondence. Archiving preserves this status;
individual forget is blocked until correspondence is resolved. Lifecycle transfer
discards trusted capture checkpoints and requires reinitialization with a new
explicit review. No observation is deleted, rewritten or automatically archived.

Project slots now require an exact `project` when created (scope defaults to `project`); pass the same project to slot reads and edits. `scope: "global"` remains shared and ignores `project`. Ownerless legacy slots remain accessible through unscoped slot management and are never injected into project context or assigned automatically.

### Session activity and import recovery

Session inactivity uses `lastActivityAt` when available, with the existing timestamp fallback for older records. Native discovery and capture derive activity from verified source timestamps; reindexing does not count as user activity. Recent genuine user messages can resume abandoned sessions. Completed sessions require a valid completion time and a later user message, or an explicit session start.

Archive retries confirm durable state before reporting success. A worker with an uncertain write outcome requires recovery before retrying. Import validates required memory search arrays and known retained source ownership before changing state; unknown legacy citations retain the existing compatibility behavior. Source forgetting shares the memory-save lock so validation and saving cannot overlap deletion.

### Live qualification and request diagnostics

The maintained local entry point is `node scripts/qualify-live.mjs before|after RECORD INSTALL_ROOT PROJECT HISTORY_SESSION REVISION [LOOPBACK_BASE_URL]`. Supply the backend secret through the command's inherited environment. `before` records 20 original observations and the encrypted authentication file hash; `after` requires the selected installed revision, exercises the REST/MCP paths and removes only its exact owned test records. This command mutates test records and requires authorization for the selected installation; it is not run automatically by the builder.

Reports retain singular `warning`, index/snapshot provenance, optional exactness and revision fields, and elapsed time. Readability and exact indexed results are separate: omitted fields remain unknown. Slot and remember ownership intent is persisted before each write; lost acknowledgements remain unknown until exact owned records are reconciled and their absence verified. Session, slot and memory cleanup runs independently. A session never created remains `not_created`; failure in one cleanup stage cannot produce a successful overall result. Incomplete or ranked memory inventories cannot prove absence.

The existing opt-in runtime diagnostic collector accepts the qualification request header `x-agentmemory-request-id` and retains bounded stage times, read/mutation call counts and server completion records. It does not store payloads or credentials. Client deadlines do not cancel server work; correlate the request ID with a completed server record before claiming completion. Busy recovery diagnostics record writer counts and rejection before mutation; exclusion still prevents recovery work from overlapping an observation writer. Successful bounded retries are not evidence that contention is resolved. A limited cold/warm comparison means fresh process caches, not a cleared operating-system page cache, and cannot establish the cause of a previous unobserved timeout.
In the managed Windows profile (`AGENTMEMORY_FORCE_PROXY=true` and `AGENTMEMORY_AUTO_COMPRESS=false`), administrative recovery may reserve admission for up to five seconds while existing writers drain. New writers wait for that reservation, preventing continuous native capture from starving archive/import requests. A timeout starts no recovery work and releases the reservation; reentrant recovery and concurrent recovery still reject. Other profiles retain immediate rejection by default. This is in-process bounded admission in the existing coordinator, not durable scheduling or cancellation of client-aborted work.
### Installation-owned local Qwen overrides

The managed default remains http://127.0.0.1:8000 and the workspace's projects/local-ai/scripts/Invoke-LocalAI.ps1 when present. To use an already supported relocated LocalAI installation, set local_qwen in config/codex-workspace.json:

```json
"local_qwen": {
  "base_url": "http://127.0.0.1:8890",
  "lifecycle_script": "D:\\LocalAI\\scripts\\Invoke-LocalAI.ps1"
}
```

These are installation-owned settings, retained on managed updates; inherited environment variables cannot override them. The endpoint must be loopback HTTP with no credentials, query, fragment or custom route (root and /v1 are supported). The launcher must be the LocalAI entry point with its companion/config layout and supported Operation/Background/ExpectedOwnerToken/ReadOnly API. Its qwen.api_base must match the configured host/port. Merely renaming another script is not a supported launcher. If no default launcher exists, an endpoint alone allows a manually managed local server; it does not authorize arbitrary automatic startup. Configure the LocalAI installation itself through its own supported procedure before changing this setting. AgentMemory does not modify its GPU/model configuration. Coordination remains installation-scoped and ownership tokens are retained for exact release, without logging service responses.

### Rebuilding the engine without build-machine paths

Use the exact source_commit and existing state-flush patch above. The qualified Windows build uses the included patches/iii-0.22.1-Cargo.lock (verify cargo_lock_sha256); copy it over the source checkout's Cargo.lock before the locked build. The upstream lock identity is separately recorded. This preserves the previously qualified dependency resolution instead of silently selecting new crates.

In the child x64 MSVC build environment, use the recorded Rust 1.98.0 and clang-cl 22.1.8. Set CARGO_INCREMENTAL=0 and a task-owned CARGO_TARGET_DIR. Use CARGO_ENCODED_RUSTFLAGS with --remap-path-prefix mappings from the actual engine source, task scratch, Cargo home, Rust sysroot and user profile to /src/iii, /build/agentmemory, /cargo, /rust/toolchain and /user. Separate encoded Rust arguments with character 31.

Set CC and CXX to clang-cl and target CFLAGS_x86_64_pc_windows_msvc/CXXFLAGS_x86_64_pc_windows_msvc to /clang:-ffile-prefix-map=FROM=TO for the same prefixes, plus the MSVC toolchain parent and LLVM root to /msvc and /llvm. Include native and slash-normalized FROM spellings. This covers native library file macros as well as Rust panic/debug paths; do not disable assertions or modify executable bytes after compilation. Run the existing locked release command and scan ASCII/UTF-16 paths before qualifying the actual new binary. Do not reuse an older hash's crash/flush results for the rebuilt engine.

Explicit relocated launchers must also match a qualified launcher/common fingerprint pair in the installed immutable third-party-inputs.json profile. Matching a filename and parameter shape alone is insufficient. Unknown controller revisions require support qualification; an arbitrary script or operator-provided fingerprint is not accepted through local_qwen settings. The legacy implicit workspace integration remains unchanged.


### Native source status and explicit history

The authenticated `GET /agentmemory/status` JSON response includes `nativeCapture` on the managed Windows/Codex profile. The existing `agentmemory://status` MCP resource exposes the same canonical source report. Service, hook inbox and graph checks describe their own scopes; they do not establish original-source collection health.

`nativeCapture.components` counts current unknown sources, sources requiring reconciliation and retained failed calls. Categories can overlap: `uniqueSessionCount` counts affected sessions and `uniqueEventCount` deduplicates current target/observation-time records; categories from the same observation do not create additional events, and missing observation times leave this count unknown. `issueCount` is the number of displayed issue categories. `batch` describes the latest scheduler drain separately, including observation time, cycle completion, freshness and its non-unique component sum. Neither current-state counts nor batch totals are a lifetime incident count.

Issue pages default to ten records. Use `nativeLimit` (1–100) and `nativeOffset`, following `nativeCapture.nextOffset`, and optionally `nativeProject` for one exact registered project. `nativeHistory=true` explicitly includes reviewed legacy IDs/fingerprints and their existing archive audit/revision evidence; its `history.nextOffset` pages that list independently. Ordinary responses contain no closed-history banner or original text. The normal archive inspect lifecycle remains the explicit original-content lookup/recovery path.

An archived legacy original is treated as reviewed history only when the retained exact observation ID and the existing correspondence fingerprint match. Relevant correspondence changes, newly encountered targets/errors and an explicit archive restore are reported. An archive read failure or pending import verification returns an incomplete/unavailable report with unknown counts; it is not a clean result. These status reads do not drain, discover, capture, heal, delete or start a provider.

### Explicit source cwd reconciliation

The existing authenticated session-start maintenance action `initialize-source` accepts optional `reconcileSourceCwd: true`. Its dry-run reads the complete native inventory and binds the option to the existing expectedVersion proof. It requires the same stored source identity (session, creation time, kind and fork/continuation metadata), allowing only its cwd/path to reflect relocation. The canonical session project and owner stay fixed; the new cwd comes from the verified final turn context, or the source header when no turn cwd exists. Existing captureCwd proof remains valid. The preview and audit expose previousCwd/reconciledSourceCwd. This is explicit maintenance, not automatic ownership reassignment or cursor reset on a failed read.

An invalid/replaced/truncated cursor is reported as native_source_cursor_invalid and requires reconciliation instead of being repeatedly retried as a generic filesystem read failure. Incidental pure host Page context already excluded from normal conversation is preserved in canonical data but does not block unmatched-capture reconciliation; actual mapped content conflicts and protected observation lifecycles remain blocking.

Retained-source reconciliation also reuses the verified continuation base path. That exact prior segment can retain a captured original even when its creation time equals the current segment and cwd has moved; unrelated same-time/different-cwd candidates remain excluded, and ambiguous/conflicting source locations still block.

### Internal warning recovery (r204)

The ordinary status view continues to report unresolved capture jobs. Explicit authenticated `capture/retry` can reconcile legacy server-generated project-mismatch jobs only when the supported native reader proves the same session, turn, kind and full content, and the corresponding canonical native observation is already stored with matching provenance. Existing session/observation projects are preserved. Missing originals are collected through the existing source-initialization/capture workflow first; retry does not manufacture an observation or weaken the ordinary project check. Prior failure and exact source linkage remain in the existing completed capture-event record.

A stale approval-review first-prompt preview cannot hide a session whose native parser proves a normal user turn. Full initialization replaces that derived preview with a verified source user request and retains its earlier digest/source key in the audit. Explicit capture exclusion still wins. Index health consults the existing StateModule scope list to avoid reads for genuinely absent zero-count observation scopes; stale zero-count scopes remain inspected. Live acceptance must still verify capture, search and automatic graph provenance after cutover.

Approval-preview recovery in explicit source initialization validates the entire supported inventory before any state change; its proof does not depend on the last-turn parser flags remaining unchanged between preview and apply. No normal source request or explicit capture exclusion means no recovery.

### Compressed Codex archives

The Windows source reader also follows a missing logical `.jsonl` source to its
exact `.jsonl.zst` sibling. Node's Zstandard streaming decoder reads the original
byte offsets without expanding archives onto disk; shared cached read ranges are bounded
to 32 MiB in process memory. Within that existing bound, at most 8 MiB is reserved for requested ranges of 64 KiB or less (metadata and cursor anchors), so unrelated streaming decodes cannot evict every verified checkpoint. The same file identity and source/cursor validation still apply. Read-budget exhaustion, correspondence changes and oversized native observations retain their precise diagnostic reason. Each open decoder also retains at most 4.25 MiB
of chunk data so other readers evicting shared ranges cannot restart its
sequential prefetch. This buffer is released with the decoder. Decoded ranges
may prefetch up to the existing
4 MiB capture window and are shared across unchanged file identities; a single
Zstd frame still requires sequential decoding for an uncached later offset.
Decoded prefixes before the requested offset are counted and validated without
copying them into the range cache or decoder tail. This reduces avoidable replay
work; it does not make seeking constant-time or remove the existing time/byte
budgets. Backward reads restart decoding when their exact range is unavailable.
Concatenated frames, skippable metadata frames and
frames without a declared original size are supported. RFC 8878 container
boundaries are checked before decoding each frame independently, avoiding Node's
concatenated-stream truncation. Declared sizes are summed across frames; absent
sizes are counted by a complete streaming decode. Size metadata is cached for up
to 1,024 unchanged physical file identities without storing expanded originals.
An ENOENT during source resolution/open is retried three times at 50 ms intervals,
rechecking both representations; callbacks and other errors are never retried.
Plain files remain authoritative when both forms exist. Linked paths, invalid
headers, truncated streams, changed source identity and changed correspondence
remain errors. An archive transport transition uses the existing full source
preview and initialization path; it preserves a completed cursor only when the
source, parser, offset, ordinal, anchor and stored correspondence still match and
no original is missing. Otherwise the existing replay path collects missing
originals. Reviewed holds and archived legacy originals retain their existing
provenance and visibility. This does not change Codex files or require a Codex
restart.

Native collection diagnostics retain batch.workerStartedAt and batch.lastCycleCompletedAt
from the current scheduler. These timestamps survive subsequent incomplete batches
but reset on worker startup. A fresh completed cycle and current issue counters
are separate evidence; latest batch cycleComplete=false alone does not negate a
completed cycle. Verification rejects an old completion or a changed worker epoch.


### Native collection E2E evidence

The tracked `verification/run-native-capture-e2e.mjs` operating wrapper runs
`native-operating-e2e.mjs` as a child, using the installed SDK, authenticated
REST API and actual Codex source observations. Its JSON configuration supplies
`installRoot`, `releaseRoot`, `expectedRevision`, `project`, `sessionId`, `query`,
`existingGraphObservationId`, `baselinePath` and `evidenceRoot`; set
`requireFreshGraph: true` only when Qwen startup/extraction is authorized.
The baseline mode takes `selectionPath` (session/observation identities) and
creates a fresh no-overwrite baseline of canonical narrative/source/deletion
identities and the authentication file hash before cutover. It never edits
canonical rows. Optional `apiUrl`, `engineUrl` and `deadlineMs` retain explicit
host routing and bounded execution.

Run the child with `native-operating-e2e.mjs baseline <config.json>` before
cutover, then run `run-native-capture-e2e.mjs run <config.json>` after activation.
Load the official installed environment for authentication without printing its
secret. The parent emits the current execution ID and result hash only after
its child exits normally with code zero and the confirmation write completes.
A caller must retain that actual parent process exit code and invoke
`run-native-capture-e2e.mjs consume <config.json> <execution-id> <result-hash>
<actual-parent-exit-code>`. Never substitute zero for an unknown outcome.

Each execution has an exclusive UUID directory. `result.json` always contains
an unconfirmed record with `success: false`; passing checks alone are not a
committed result. `confirmation.json` binds its exact bytes to the child outcome.
Consumption requires the expected current UUID/hash, both complete matching
files and an actual normal zero parent exit. A partial file, write-then-throw,
missing response, late writer, old successful run, nonzero exit or interruption
cannot certify the new execution. If persistence itself fails, failure may be
available only in process output; absence of a confirmed result is never PASS.

Worker identity is acquired before capture and checked after capture, every
discovery/drain iteration (including direct completion), exact search, final
diagnostics and additional operating qualification. Missing, invalid or changed
identity fails the whole execution. A scheduler completion timestamp is accepted
only on that same worker and after this execution began. Operating qualification
checks preserved canonical identities/authentication and actual graph lookup
with original observation links; an old extraction is never labelled fresh.

### Codex additional tool declarations

The parser validates the current Codex AdditionalTools shape (type/id/role/tools) before excluding developer/system tool declarations. Conversation-bearing, malformed or unrecognized variants stop at their original boundary. No unknown-type blanket skip is used. A supported adapter update retries the saved cursor through the normal source-capture path; never edit originals or jump cursors. Unsupported diagnostics expose only a sanitized record/payload type, ordinal/byte offset and update-and-retry guidance; no tool definitions or message bodies are exposed.


## Owned runtime continuation after an activation timeout

An action timeout is an unknown outcome, not a failed or successful installation.
The original host receipt and the failed producer remain immutable and held.
`windows-owned-process.mjs` keeps the original child handle's `exit` and `close`
events after returning the initial timeout or output-limit result. It writes
separate create-new terminal JSON and bounded late stdout/stderr files in the
same capture directory. The receipt includes the original PID, parent, command,
identity hash and creation FILETIME. Late output is limited to 1 MiB across both
streams and marks truncation. Missing identity or storage failure is explicit;
terminal evidence never resumes a producer or upgrades its primary result.
This cannot recover a historical exit whose original handle was already lost.

`createWindowsActiveTimeoutProducer` is a separate, narrow continuation for the
same already-active isolated slot. Construction verifies the original prepared
history, consumed configure-2 ordinal, successful exact configuration, immutable
activation TIMEOUT, closed original driver and pinned runtime anchor. Admission
consumes one create-new `.active-after-timeout.json` claim without changing the
original claim or ordinal. It rechecks the exact owner/nonce/candidate/config,
two task registrations/actions, and current daemon/worker/engine PID, creation,
parent, executable and command against the anchor. A scoped read-only backend
must explicitly observe both old driver/installer PIDs absent; PID reuse,
unknown/unsupported observation, changed processes/configuration or stale data
holds the continuation before credential/API or restart effects.

The API exposes only admission, one runtime restart sequence, status and the
existing ownership-safe cleanup. It does not expose prepare, activation,
configuration, full assembly or the fresh/restart partial qualification gate.
The new restart records a new synthetic memory API operation and normal
stop/start with exact ID/content/project/origin preservation. Its acceptance is
`owned_runtime_restart_after_timeout`, with `production_qualified=false` and
`original_activation_exit=unknown`. Existing Windows distribution and native
operating qualification requirements remain unchanged.

The restart start budget is 180 seconds: the supported ValidateOnly path can
sequentially wait 10 seconds for a trusted consumer, 60 seconds for the startup
lock, 3 seconds for port drain and 45 seconds for readiness (118 seconds total).
Health and MCP HTTP checks each allow 2 seconds; deadline loops can finish a
last check after their deadline. A conservative 32-second HTTP/check allowance
plus 30 seconds for setup/identity/task/port operations gives the fixed 180-second
outer budget. The two-request readiness probe is not a nested 45-second wait;
the lock wait is not multiplied by readiness. Unbounded Windows task/CIM/FS
latency is not claimed to have a mathematical total bound.

Normal runtime stop gets 60 seconds for its 30-second graceful stop window,
one final 2-second liveness diagnostic and setup/identity/polling overhead.
Ownership inspect/preflight remain 45 seconds; stop-watchdog gets 60 seconds
for its 15-second graceful window and before/after ownership observations.
Cleanup-retain gets 60 seconds and cleanup-remove 120 seconds for the checked
two task removals and two ownership observations, plus traversal/removal of this
fixed payload for remove. These are finite collection budgets, not termination
or success criteria. A timeout still means held/unknown, with late terminal
capture and no kill or automatic continuation. Preparation remains 15 seconds;
unused installer prepare/activate/update/recovery budgets remain unchanged at
30 seconds. The active-runtime route cannot call those installer phases.
The new code is tested with fake effects and pure backend functions; actual
active admission, credential use, API/restart/cleanup and full candidate rebuild
remain separate reviewed execution steps. Synthetic PASS is not Windows,
native Memory v2 coexistence, Qwen, license clearance or release qualification.


### Windows path spelling in owned argv

Owned daemon/watchdog argument comparison treats only executable, script and
root tokens (indices 0, 7 and 9) as Windows paths. They must be explicit local
canonical paths, pass the existing Same-Path and physical/reparse checks, and
resolve to the same volume/file ID through read-only Windows handles. This
accepts C:\WINDOWS versus C:\Windows for the identical file. Every option,
non-path value, parent PID and token count remains exact. Other paths, relative
paths, parent traversal and extra tokens remain rejected. Existing process
birth, parent, command and installed-script checks remain in force.

The observed admission failure before this fix consumed its handoff claim but
performed only ownership reads. That producer remains held: the claim is never
deleted/reset and the old driver cannot be rerun. Any continuation requires
reviewed, closed failure evidence and an explicit one-use continuation record;
the fixed continuation below implements that reviewed code path.


`createWindowsActiveAdmissionContinuationProducer` accepts only the closed v31
inspect-only argv failure profile. It verifies the old executed plan, exact
driver, immutable old ownership helper, terminal exit/close 1, consumed active
claim and absence of a completed runtime/API phase in the closed driver. The
original prepare/configure/timeout proof is still verified under its historical
ownership pin; only the current ownership-tool revision is rebound separately.
Candidate, slot, owner, nonce, config and process anchor remain unchanged.

Admission creates exactly one `.argv-case-fix.json` sibling of the consumed
active claim, linking its hash and the closed inspect failure to the current
tool pin. Existing claims/ordinals and the failed producer are never reset.
Competing or repeated attempts fail; altered, pending, successful, effectful or
unknown closed records are rejected. Fresh current ownership and config/writer
checks still precede credential/API or runtime actions. The reviewed fixed
continuation subsequently completed same-slot synthetic-memory API validation,
normal stop/start, exact memory preservation and ownership-checked cleanup.
Create returned 201 and search/detail 200; the memory ID, content, project and
origin matched after restart. The trial root/key and two tasks were removed,
with a separate read-only absence check. This is an owned-runtime restart
result, not the original fresh activation: its final exit remains UNKNOWN.
Full Windows/native/Memory-v2/Qwen and distribution qualification remain
incomplete. See [the dated release limits](../../docs/PREVIEW_19.md#historical-private-candidate-and-release-limits-2026-10-29)
and [dependency evidence checklist](licenses/THIRD-PARTY-NOTICES.md#dated-distribution-evidence-checklist-2026-10-29).


### Native memory citation display compatibility

Codex keeps `<oai-mem-citation>` blocks in canonical assistant response records
while removing those literal blocks from the displayed `AgentMessage` and
completion text. The adapter retains the full canonical text, source key and
content digest, and records an optional display digest only for mirror
correspondence. Different canonical content under the same native message ID
still blocks collection, including changes confined to a citation. Unknown
record types, changed visible text and unmatched mirror multiplicity remain
blocking. The matching follows the native literal, non-nested citation tags,
including its EOF auto-close behavior; it does not strip arbitrary markup.

A saved cursor containing a prior display mirror can resume through the normal
capture path after this reader update. Saved primary-first cursors that lack
the new display digest may still require the existing complete-source
inspection/initialization procedure; never jump the cursor or erase records.
The same normal procedure handles an actual physical source-file replacement
after complete correspondence verification. Read-only preview is not a repair
or successful collection. Final-message conflict and unmatched-mirror reasons
are now exposed as bounded diagnostic codes instead of being collapsed into
`capture_issue_unclassified`.

The immutable r263 candidate includes the native mirror correction and has
reviewed Windows fresh/restart/update/failure-recovery evidence. Its operating
update and one explicitly synthetic native UI/Qwen sample were also reviewed.
At that r263 checkpoint the full operating verifier failed at discovery and
had no confirmed receipt. That historical failure is preserved. It does not
establish complete Memory v2/hook coexistence.

The subsequent legacy-final compatibility change addresses old hook observations
that retained the displayed answer without its hidden memory citation. It requires
a complete native inventory, one-to-one correspondence, the same session, owner,
project and exact turn, the known hook shape/origin, and an exact display digest.
The display digest is comparison-only: preview/apply re-read and verify the full
canonical text before restoring that text in the same observation ID. Existing
facts, timestamps and origin remain; canonical key/digest and the bounded repair
audit are attached through normal initialization. Stale previews, ambiguous or
changed text, existing canonical conflicts, and deletion/exclusion protections
remain blocking. It does not trim text, strip arbitrary tags or jump a cursor.
This later change is not in the frozen r263 bytes. It is included in fixed r264
source `8b46bbae`. The supported automatic initialization restored the exact
canonical response in the same observation ID, and r264 passed its seven-stage
operating E2E with a separately confirmed, consumed exit receipt. The new
explicitly synthetic normal-chat sample was automatically collected and linked
to fresh Qwen extraction before manual capture. That reviewed operating scope
does not qualify the final Windows matrix or positive Memory v2/hook coexistence.
See the [current candidate evidence and limits](../../docs/PREVIEW_19.md#r269-local-qualification-2026-11-02).
Later documentation changes do not relabel the immutable r264 source or payload.


### Single-source Qwen citation regeneration

When local Qwen rejects a source citation by emitting an ID outside its input,
the existing one-time regeneration for a single original observation uses the
temporary citation `source_1`. Only that retry enables the alias. The parser
resolves it to the sole exact original observation ID before graph persistence,
including relationship provenance, and collapses duplicate alias/exact citations.
Ordinary parsing and multi-source extraction do not enable the alias. Other
IDs and invalid retained provenance still reject the provider result: provider
graph changes are not committed and semantic completion/cursor progress is
withheld. Existing structural-graph heuristics and error/attempt metadata may
still change. The existing repair path can omit relationships whose endpoints
are absent; this is not a guarantee that every relationship defect fails the
whole extraction. Original observations, capture cursors and source text are
not rewritten or inferred from invalid output. The retry retains its input budget and
at most one additional model request. This source change needs its own candidate
and actual Qwen validation; synthetic success is not operating qualification.
