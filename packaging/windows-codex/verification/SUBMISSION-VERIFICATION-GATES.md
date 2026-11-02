# Submission verification gates

> **Current local result (2026-11-02):** r269 from `7e66cd75` completed the exact Windows/native/v2/real-Qwen/distribution checks and bounded artifact review. [Final identities, hashes and limits](../../../docs/PREVIEW_19.md#r269-local-qualification-2026-11-02) supersede only those unfinished items in the historical checkpoint below. Public source review/CI and publication remain pending. This documentation follow-up is not a rebuild or new approval.

## Historical pre-r269 qualification checkpoint

Role: current-state and conditional runbook. Read this when preparing a submission candidate, not during ordinary runtime use. This document does not authorize execution.

The synthetic coordinator is a contract test facility. Its four independent fixtures are not an observed installation lifecycle and cannot qualify a distribution. The production host adapter, one-use continuations and ownership-safe cleanup have separate code and runtime-only evidence. The fixed pre-start I/O failure seam has reviewed actual r262 and r263 Windows evidence. The r263 full operating E2E failed at discovery and remains a failure. The subsequent fixed r264 candidate passed its full seven-stage operating E2E with a consumed parent-confirmed receipt and a new automatically collected synthetic Qwen sample; that limited operating scope was reviewed. NATIVE56 subsequently passed the actual isolated native/v2 diagnostic on fixed r267 and Node 24.22.2, including owned-resource cleanup, and received original-evidence review. Final changed-candidate native/v2/Qwen and submission acceptance remain incomplete. Do not send synthetic fixtures to production acceptance.

| Gate | Required next evidence | Current status |
|---|---|---|
| Clean source build | New clean commit/tree, offline frozen install/deploy, source/adapter/packaging raw logs, source/payload/manifest binding | Fixed r267 source 6883a50c19fd902b0bab1cf93e545f5b74a15ee1 includes SEARCH32 and passed the offline build with 4,510 source tests passing and 35 explicitly skipped, seven adapter tests and 515 packaging tests. Build Node was 24.19.0. Later documentation changes, including NOTICE50 at f64487c5, are not that build's source. Final changed inputs still require their own qualification; no build is authorized by this document. |
| Candidate integrity | Complete inventory, default custom-library fields absent, SDK CLI absent, notices included, final verifier input hashes | Immutable r267 has manifest SHA-256 11ca6f9041d11e04dc3f4412f704550abbbcaf1e258c33d88bcd7c7a0fc9ad15. Its recorded inventory checked 11 release files and 11,260 payload files with no missing, extra or mismatched files. This is the fixed 6883a50c artifact, not the later documentation source or a new final release. Historical candidates retain their identities; final-source artifact and distribution verification remain open. |
| Windows fresh/restart/update/failure | Real supported actions and observations, candidate and target identity, process creation/exit, ordered memory rows, distinct predecessor, original failure/restore streams | WINDOWS35 accepted r267's actual fresh installation, normal restart, managed update and fixed pre-start I/O failure recovery on the exact source/manifest above. The three owned roots and six tasks were cleaned up after ownership and normal exit checks. This Windows scope was reviewed; production_qualified remains false. Original r260 activation exit UNKNOWN, r261 failed update and NATIVE31 search failure remain unchanged. Changed candidates/runtime inputs need their own scoped evidence; do not repeat unchanged WINDOWS35. |
| Native and v2 coexistence | Actual native invocation plus confirmed receipt, isolated v2 profile/hook behavior and no duplicate capture | NATIVE56 continuation10 passed on fixed r267 with Node 24.22.2: two synthetic native turns, v2 and automatic recall in the same second model request, four automatically collected observations/source mappings, manual search of those four rows, same-cursor replay with inserted0, and SessionEnd/archive preservation. Wrapper, driver and native exited0; the approved owned processes, tasks, test key and roots were cleaned up. Dot accepted the original evidence on 2026-11-01 at 17:17:30 UTC. The source-link observation interval was 81.249608 seconds without forced initialization. This local synthetic Responses test does not prove real Qwen, native background generation or restart/durable deduplication. Operating-hook boundary reasons were directly observed for three events and unobserved for three; universal network nonaccess is not claimed. Prior CRLF/LF and NATIVE52–55 failures retain their original outcomes. Fixed r264's seven-stage operating/Qwen receipt remains separate historical evidence; final changed-candidate qualification remains open. |
| Route A licenses | Artifact-specific GUID exclusion, exact component notices and recipient access to sources, build trees, patches and replacement instructions | SOURCE61 review accepted bundled licensed components plus fixed upstream build-tree delivery; a blanket repository republication reply is not a prerequisite. New v4 contains 859 files, 95,754,646 bytes, SHA-256 feb32a6ee7f17de11c9eb9bb6cbf38ff497d9d55a6cc3927e911ddbfabb7029d. It retains 855 source/notice files and externally maps 13 selected build files. This input and the revised descriptor await original review and final-candidate binding; immutable r267 remains v2. DirectML/DXC package notices and six DLL non-signature byte comparisons are now recorded, without a whole-file/signature claim. Final recipient access/rights and changed-candidate qualification remain open. |
| Publication | dot review of exact source/artifact, target branch/PR, current tags/assets and detailed README/release notes | Not published. Conditional publication permission does not replace final source/artifact acceptance or authorize npm publication. |

Status checkpoint: 2026-11-02 KST. The r267 build-time qualification records its then-unrun Windows scenarios and no operating receipt; later WINDOWS35 and NATIVE56 evidence are separate and must not be backdated into that record. Under explicit approval, Node 24.22.2 was installed at its versioned shared-toolchain path and the same existing isolated fixture transitioned to it; previous Node bytes were preserved, and PATH/current pointers were not changed. NATIVE56 then verified that runtime and cleaned up the owned fixture. This is not qualification of a final changed candidate or a production Node transition. The final source archive/descriptor and runtime inputs must settle before creating the next acceptance candidate.

## Conditional supported commands

Use task-owned paths, installed exact tools and a newly allocated revision/output. `$Package`, `$Node`, `$Engine`, `$Revision`, `$Output`, `$Scratch`, `$ReviewedSources`, `$Release`, `$Install`, `$Workspace`, `$Registry`, `$Requirements` and `$FinalCommit` must be concrete reviewed values. Check root ownership/absence and every port immediately before an approved real run. None of these commands were executed by the coordinator.

```powershell
$env:PNPM_CONFIG_OFFLINE = 'true'
& "$Package/packaging/windows-codex/Build-WindowsCodex.ps1" -Offline -ReleaseRevision $Revision -OutputDirectory $Output -ScratchDirectory $Scratch -NodePath $Node -IiiEnginePath $Engine -NativeSourceEvidenceArchive $ReviewedSources
# Read-only plan; not fresh-install acceptance:
& "$Package/packaging/windows-codex/Install-WindowsCodex.ps1" -ReleaseRoot $Release -InstallRoot $Install -WorkspaceRoot $Workspace -ProjectRegistry $Registry -ManagedRequirementsPath $Requirements -NodePath $Node -RestPort $Rest -Fresh
# Only after separate exact security/installation approval and producer readiness:
& "$Package/packaging/windows-codex/Install-WindowsCodex.ps1" -ReleaseRoot $Release -InstallRoot $Install -WorkspaceRoot $Workspace -ProjectRegistry $Registry -ManagedRequirementsPath $Requirements -NodePath $Node -RestPort $Rest -Fresh -Execute -EvidenceUtf8 -EvidenceIdentityPath $PrepareEvidence
& "$Package/packaging/windows-codex/Install-WindowsCodex.ps1" -ReleaseRoot $Release -InstallRoot $Install -WorkspaceRoot $Workspace -ProjectRegistry $Registry -ManagedRequirementsPath $Requirements -NodePath $Node -RestPort $Rest -ActivatePrepared -Execute -EvidenceUtf8 -EvidenceIdentityPath $ActivateEvidence
& $Node "$Package/packaging/windows-codex/verification/distribution-qualification.mjs" verify $Package $Release $Qualification $FinalCommit
```

The real producer must capture immutable original bytes, explicit UTF-8 structured output, precise process identity/exit and supported-action receipts. EvidenceIdentityPath must be unique; missing/null/nonzero exits and rollback failures remain failures. A dry-run or static memory response cannot establish an executed action. Native operating acceptance remains an additional gate.

## Effects and restoration boundary

Real preparation creates a root-local DPAPI CurrentUser secret, restricted root ACL, current-user limited scheduled tasks, isolated workspace/requirements and child processes. This document does not authorize those effects. An actual execution must match valid direct approval naming exact roots, ports, tasks and cleanup; a previous approved root does not authorize a new one. Keep every model endpoint closed or explicitly isolated; do not inherit an operating endpoint.

Cleanup must first match installation owner/nonce, task definitions and recorded PID/parent/creation/executable/command. Stop only that installation through its normal path, prove exit, unregister only verified owned tasks, then remove only the resolved approved synthetic roots/auth. An unknown owner or denied query means HOLD, not broad kill, security relaxation or an alternative query. The reviewed ownership-safe cleanup code has a separate runtime-only result; this document neither authorizes it nor supplies missing fresh-install evidence.

A private pre-start qualification fixture is derived from the candidate installer
without modifying the candidate. The verifier reproduces the two fixed changes:
the evidence bootstrap reads the explicit release root, and a locked scratch file
causes a Copy-Item sharing violation at the copy-adapter boundary. The lock is
released before rollback. No arbitrary script hook or default-product failure
switch is added. UTF-8 BOM and all other source bytes are preserved.

The installer records the original error identity separately from automatic
rollback, failed restoration and withheld rollback. Automatic rollback requires
restored predecessor files and fresh runtime readiness; the original install
action still exits nonzero. Collection compares the captured installed outcome
and original stream, accepts only the intended I/O failure, and withholds a
recovery action if runtime stop is unconfirmed. These paths have synthetic
regression and real scratch-file sharing-violation evidence. The r262 Windows update/recovery run was accepted; post-start withholding is
not proven by its pre-start failure. Do not restore an operating database.

Existing synthetic update/recovery targets now require `admitExisting` before
scenario execution. This reads owner/nonce, the pinned predecessor and the closed
model/isolated Codex configuration without rewriting configuration or creating a
credential. After a successful update, the candidate configuration is read again
before credential use. This admission has synthetic regression and accepted r262 Windows evidence;
those historical runs do not qualify a changed candidate.

Host collection allows 5 minutes for fresh preparation, 15 for activation and
30 for update/inject/recover, covering the installer's 780-second readiness wait
plus stop/backup/copy. Restart keeps its existing 60/180-second stop/start bounds.
Timeout still means UNKNOWN/HOLD; late terminal evidence never silently retries
the action or converts an unknown activation to fresh-install acceptance.

## Route A and handoff

Preserve existing features while resolving licenses. The added upstream texts are component evidence, not a complete source offer or universal file-level grant. Do not invent copyright, remove optional features or contact maintainers without explicit authorization.

The earlier cloud-to-local handoff is complete: the cloud writer reported its terminal handoff and the existing local conversation accepted ownership. Continue in that local worktree after checking current HEAD/index/files and competing writers; do not restart the retired cloud work. Read the current task checkpoint after compaction. Historical r255 drivers and unresolved incident roots remain excluded. The private handoff record carries exact machine paths and evidence IDs; this public guide does not grant additional permissions.

## Next matrix fixture preparation (no execution)

After review of a newly built fixed candidate, propose three new task-owned roots
in the current AgentMemory task scratch: `fresh`, `update` and `recovery`.
AgentMemory fixture preparation does not require an Ares restart. These are plan names,
not created or approved security state. Do not reuse the removed slot-a, old
claims/nonces or incident a/b roots. Before any prepare, fix actual candidate
manifest/tool hashes, owner SID, absent roots, five nonconflicting ports per
slot and the exact two daemon/watchdog task names per slot. No availability or
collision check has been run for these prospective fixtures.

Fresh must capture actual prepare/activation exit and ordered synthetic-memory
responses, followed by normal restart and exact row comparison. Update requires
an actual distinct reviewed predecessor package and a complete owned synthetic
cold recovery set; the r252 code-only diagnostic envelope is not an accepted
release predecessor, and same-version reinstall is not cross-version evidence.
Recovery starts from its own distinct predecessor installation, not the already
updated slot. It must execute the candidate-bound pre-start I/O fixture above;
the default installer has no free-form hook. Preserve original
failure/restore streams and refuse post-start ambiguity. This is preparatory
scope only: no new roots, credentials, ACL, tasks, processes, API or DB changes.
Package build and the exact security/action bundle must be reviewed before use.

The optional pinned source packet is included through the existing release
inventory, with `complete=false`; it does not qualify any matrix/native gate.
The reviewed source assembly is the tracked descriptor's input, not a qualified
release. The partial source packet's r266 binding is historical evidence. The known GUID carriers are excluded from that reviewed Windows Node-profile artifact; the original third-party packages are not relicensed. Complete
recipient-source access remains open. Do not turn a
successful archive copy into licensing clearance or an operating PASS.
