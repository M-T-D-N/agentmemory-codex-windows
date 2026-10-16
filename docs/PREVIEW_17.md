# Preview.17 operating and validation notes

This independent Windows/Codex downstream bundles AgentMemory 0.9.30 and patched iii engine/SDK 0.22.1 (file-flush-v1, data contract 5). It is an unsigned technical preview. It is separate from upstream support and from an npm registry publication.

## Requirements and supported entry points

Use native Windows x64, Node.js 24+, Windows PowerShell 5.1 and the Windows account running Codex. Permit space for extraction, runtime and compatible recovery copies. Local Qwen is optional, uses loopback HTTP and is not installed by this package. The validated provider was Qwen 27B with 131072 context and reasoning off; this does not qualify arbitrary providers.

The [pinned installer guide](../packaging/windows-codex/npm/README.md) provides commands and a minimal project registry. An empty target supports prepare/activate/validate; an owned managed installation updates the same root while retaining data, auth and task identity. Explicit adoption supports original upstream 0.9.29/0.9.30 native file-backed installations into a separate target. Newer or unqualified storage is not silently downgraded. Preview the operation, then add `--execute`. Never combine a historical launcher with newer assets.

The default authenticated REST/MCP listeners are loopback3111/3114. Adopted installations retain configured ports. Validate the installed service before connecting Codex MCP. The daemon/watchdog and managed hooks collect ordinary main-agent prompts/final replies; title, fork, ambient and subagent traffic are excluded. The installer preserves existing MCP registrations and OAuth credentials. See the full guide for exact task/hook ownership and startup behavior.

## Update, removal and recovery

Use the existing owned root for a managed update; do not create a second service to update one installation. Preserve the active release and actual immediate predecessor with compatible code/config/data. A code backup alone cannot reverse a data-contract change. Stop through the installed lifecycle, confirm ownership and follow [existing-install cutover](../packaging/windows-codex/README.md#existing-install-cutover) if a phase fails. Never point predecessor binaries blindly at changed data, overwrite manifests, or replace canonical data with generated runtime output.

To decommission, first retain a readable recovery/export according to the operating guide. Stop the installed watchdog with `scripts/agentmemory-watch-stop.ps1 -Root <install-root>` and runtime with `scripts/agentmemory-stop.ps1 -Root <install-root>` under the installation owner. Remove the exact Codex MCP registration if no longer wanted. Disable/remove only the scheduled tasks and managed hook configuration proven to belong to that installation, using its recorded task registration and predecessor configuration. This release does not provide a destructive one-command data uninstaller. Deleting source or downloaded ZIPs does not uninstall the operating service. Keep data/config/auth and recovery sets until intentionally retired; Qwen remains separately owned by LocalAI.

## Changes and qualification

- Bounded sequential Zstandard reading keeps already decoded windows available when other sources evict the shared cache.
- A complete inventory whose canonical messages already match resumes at its verified end; missing real messages still follow normal capture.
- Source discovery handles simultaneous sessions/archive relocation and plain/Zstandard transitions only after matching source metadata and complete preview/apply correspondence.
- Distribution requires matching source input, actual suite logs, immutable manifest/payload, all Windows scenarios and a confirmed operating native evidence result. Changed or incomplete evidence is rejected.
- The builder and Windows CI use one test inventory. LocalAI ownership responses and first-boot cloud secrets are not printed.

| Evidence | Observed result |
|---|---|
| Source / adapter / packaging suites | 4253 / 93 / 224 passed; 35 / 3 / 0 explicit existing skips |
| Actual Windows scenarios | Fresh install, managed update, restart, injected-failure recovery passed |
| Actual Codex/provider flow | Native input collection, discovery, drain, search, source link and fresh Qwen graph query passed |
| Preservation | 522 selected prior records and encrypted authentication preserved; three repaired source histories preserved 520 canonical records and 2206 related graph records |
| New graph sample | Six source-linked nodes from one explicitly synthetic input after activation |
| Public CI | Check the workflow at the exact published commit; local results are not remote CI proof |

The tests ran on the owner's Windows PC. Skips remain explicit existing suite exclusions, not evidence of successful operating coverage. The sample does not prove every historical graph is complete, unrelated machines work, all cloud platforms work, or every possible secret is detected. No price, speedup, long-term reliability or semantic accuracy claim is made. Product code was reviewed by AI and tested by the user; there is no independent human security audit.

## Immutable assets and source correspondence

The qualified payload is internal revision r216. Its recorded workspace source is `e863ee82879a53b9919947db066eeb83282f4ad2`; the public repository has its own commit history. The public product-source snapshot is `1ee9ec09664a576fcf6f060831397a3637483b0e`. Included source blobs/modes match the qualified package. Unused upstream website/media/other language copies and deployment configurations are excluded. Four cloud entrypoints remain solely for the secret-output regression; no cloud service is deployed. Later publication-document changes do not replace or relabel the frozen payload. The source tag may include these documentation updates; the Release identifies both source points.

Manifest SHA256: `129fd6502c6de638d07535d751b753344f36409e3e63f2f28a0ab519cbb280d2`.

| Asset | SHA256 |
|---|---|
| agentmemory-codex-windows-0.1.0-preview.17-win32-x64.zip | `8e633a237453b94ff902b1c49f08f3a2e0cb3d2915e72039937be53b4885d9ab` |
| agentmemory-codex-windows-0.1.0-preview.17.tgz | `62cfd1667d85dd31aeb55b988dfc4aec444eecb9d5a3d3af2cdc9a5dfed1e950` |
| release.json | `358c0d79838a737d9e54bc3a979d224382667be816f5a933185e97913bbe6ed4` |
| SHA256SUMS.txt | `86b962220fe0e2fe29c0ba5b59fb32d39f7dc92138200166a901227ba13540e6` |

Use the versioned [release page](https://github.com/M-T-D-N/agentmemory-codex-windows/releases/tag/v0.1.0-preview.17); if assets are not present, publication is pending. `release.json` pins ZIP size/hash and `SHA256SUMS.txt` lists ZIP/TGZ/descriptor checksums. SHA256 proves integrity against the recorded files, not Authenticode signing. The launcher is an npm-format TGZ downloaded from GitHub, not an npm registry release. Packaged candidate-status prose reflects build time; this versioned guide and the final Release record identify publication state and qualification.

## Privacy, support and licensing

Do not post memory databases, real conversations, credentials, owner tokens or unredacted local logs. The release source/assets exclude those operating materials. Boundary checks searched the final source/archive contents for the operating secret and private-key/AWS patterns; reviewed hits were parser markers or a public synthetic example. This bounded check is not universal secret absence. Report the version, phase and a small redacted reproduction through [SUPPORT](../SUPPORT.md); use [SECURITY](../SECURITY.md) for private security reports.

Source/adapter: [Apache-2.0](../LICENSE), with upstream attribution in [NOTICE](../NOTICE) and [upstream-source.json](../upstream-source.json). Engine: [Elastic License2.0](../packaging/windows-codex/licenses/iii-LICENSE_ELv2). Preserve [third-party notices](../packaging/windows-codex/licenses/THIRD-PARTY-NOTICES.md). No license, original authorship or official-upstream support is implied by this downstream release.
