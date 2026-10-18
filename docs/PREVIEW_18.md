# Preview.18 operating and validation notes

> **Preview.18 candidate:** This guide is committed before public CI and asset publication. The final versioned Release reports actual commit/CI links and hashes. The historical preview.17/r216 guide and assets remain unchanged. Any later documentation-only commit must identify its own CI separately from the payload source.

This independent Windows/Codex downstream bundles AgentMemory 0.9.30 and patched iii engine/SDK 0.22.1 (file-flush-v1, data contract 5). It is an unsigned technical preview. It is separate from upstream support and from an npm registry publication.

## Requirements and supported entry points

Use native Windows x64, Node.js 24+, Windows PowerShell 5.1 and the Windows account running Codex. Permit space for extraction, runtime and compatible recovery copies. Local Qwen is optional, uses loopback HTTP and is not installed by this package. The validated provider was Qwen 27B with 131072 context and reasoning off; this does not qualify arbitrary providers.

The [pinned installer guide](../packaging/windows-codex/npm/README.md) provides commands and a minimal project registry. An empty target supports prepare/activate/validate; an owned managed installation updates the same root while retaining data, auth and task identity. Explicit adoption supports original upstream 0.9.29/0.9.30 native file-backed installations into a separate target. Newer or unqualified storage is not silently downgraded. Preview the operation, then add `--execute`. Never combine a historical launcher with newer assets.

The default authenticated REST/MCP listeners are loopback3111/3114. Adopted installations retain configured ports. Validate the installed service before connecting Codex MCP. The daemon/watchdog and managed hooks collect ordinary main-agent prompts/final replies; title, fork, ambient and subagent traffic are excluded. The installer preserves existing MCP registrations and OAuth credentials. See the full guide for exact task/hook ownership and startup behavior.

## Update, removal and recovery

Use the existing owned root for a managed update; do not create a second service to update one installation. Preserve the active release and actual immediate predecessor with compatible code/config/data. A code backup alone cannot reverse a data-contract change. Stop through the installed lifecycle, confirm ownership and follow [existing-install cutover](../packaging/windows-codex/README.md#existing-install-cutover) if a phase fails. Never point predecessor binaries blindly at changed data, overwrite manifests, or replace canonical data with generated runtime output.

To decommission, first retain a readable recovery/export according to the operating guide. Stop the installed watchdog with `scripts/agentmemory-watch-stop.ps1 -Root <install-root>` and runtime with `scripts/agentmemory-stop.ps1 -Root <install-root>` under the installation owner. Remove the exact Codex MCP registration if no longer wanted. Disable/remove only the scheduled tasks and managed hook configuration proven to belong to that installation, using its recorded task registration and predecessor configuration. This release does not provide a destructive one-command data uninstaller. Deleting source or downloaded ZIPs does not uninstall the operating service. Keep data/config/auth and recovery sets until intentionally retired; Qwen remains separately owned by LocalAI.

## Changes and evidence boundary

Preview.18 carries the reviewed r223 Windows implementation under a fresh public version and package identity. The already published preview.17/r216 tag and assets remain immutable and separate.

- Resume collection across explicitly validated non-conversational `additional_tools` declarations. Malformed, content-bearing and future unknown records remain stopped; originals and cursors are not force-skipped.
- Serialize Qwen lease acquisition, stale reclamation and release with the shared Windows lifecycle lock. Verify PID plus process-start identity and exact ownership. Uncertain owners remain deferred; foreground ownership takes priority over background extraction.
- Exclude development-only pnpm workspace/lock metadata from installed runtime inputs while retaining source build inputs and upstream provenance.

The r223 baseline (workspace source `93374f4ac9b442b996af6e39ec5f7e67105463fd`) passed 4276 source / 93 adapter / 249 packaging tests, with 35 / 3 / 0 existing skips. Actual Windows fresh-install, managed-update, restart and injected-failure recovery passed. Five sessions resumed from retained boundaries without duplicate insertion. Actual operating native collection, search, original-source linkage and a fresh Qwen graph sample passed all seven stages with a confirmed process receipt. A foreground-priority sample observed zero background HTTP calls.

Those are r223 baseline results, not automatic qualification of new preview.18 bytes. The versioned Release must report its new source, internal revision, exact public CI, manifest and asset hashes, and newly executed Windows/operating checks. The existing distribution verifier requires evidence tied to the exact source/manifest/payload before producing distributable assets. Never mix a historical launcher with newer assets.

The first r223 native run timed out at its five-minute total drain deadline; it remains failed. A subsequent longer-deadline run passed without removing checks. The final bounded audit used exact reviewed file/offset/hash approvals and 46 auditor self-tests. This is not universal sensitive-information detection or an independent third-party security audit. Vendor CI build paths, documentation examples and explicitly synthetic fixtures may remain. A small graph sample does not prove all historical graphs are complete or all operating intervals are contention-free. This is an unsigned, AI-assisted, user-tested Windows technical preview.

## Immutable assets and source correspondence

Use only the matching [preview.18 Release](https://github.com/M-T-D-N/agentmemory-codex-windows/releases/tag/v0.1.0-preview.18) ZIP, TGZ, `release.json` and `SHA256SUMS.txt`. The descriptor pins ZIP URL/size/SHA256; checksums cover ZIP/TGZ/descriptor. The final Release records actual hashes and source correspondence; incomplete publication is not an installation target. SHA256 integrity is not Authenticode signing. No npm registry or GitHub Pages site is published by this GitHub release.

Workspace and public source histories differ. Only product code/tests/build inputs/public documentation are exported; operating databases, real conversations, credentials, backups and internal scratch evidence are excluded. Exact-commit public CI and local operating evidence are separate results. Do not reuse the preview.17/r216 or local r223 hash for these new bytes.

## Privacy, support and licensing

Do not post memory databases, real conversations, credentials, owner tokens or unredacted local logs. The release source/assets exclude those operating materials. For the reviewed r223 baseline, boundary checks searched its source/archive contents for the operating secret and private-key/AWS patterns; reviewed hits were parser markers or a public synthetic example. This bounded check is not universal secret absence. Report the version, phase and a small redacted reproduction through [SUPPORT](../SUPPORT.md); use [SECURITY](../SECURITY.md) for private security reports.

Source/adapter: [Apache-2.0](../LICENSE), with upstream attribution in [NOTICE](../NOTICE) and [upstream-source.json](../upstream-source.json). Engine: [Elastic License2.0](../packaging/windows-codex/licenses/iii-LICENSE_ELv2). Preserve [third-party notices](../packaging/windows-codex/licenses/THIRD-PARTY-NOTICES.md). No license, original authorship or official-upstream support is implied by this downstream release.
