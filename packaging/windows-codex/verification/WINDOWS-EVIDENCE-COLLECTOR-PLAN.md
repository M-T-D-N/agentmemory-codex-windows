# Windows evidence schema-2 collector: implemented boundary and remaining integration

Status (2026-10-30): the host adapter and candidate-derived pre-start I/O failure
path are implemented and have isolated regression evidence. The earlier r260
slot completed actual synthetic-memory creation/search/detail, normal runtime
restart, preservation and owned cleanup. Its initial activation exit remains
UNKNOWN; those observations do not qualify fresh installation or the full matrix.
Actual update/failure-recovery acceptance for the new source, native/v2 and Qwen
remain pending. The synthetic-only serializer remains separate and cannot be
promoted to production. The interrupted owner and incident a/b roots stay excluded.

## Implemented interfaces

- `verification/windows-evidence-collector.mjs`: supplied synthetic bytes and
  receipts only, create-new storage, fixed synthetic/non-production markers.
- `verification/windows-evidence-host.mjs`: import-safe actual adapter factory,
  disabled by default; separate synthetic factory requiring all five fake
  effects (read, digest, run, request, now), with no real-effect fallback.
- `powershell/agentmemory-evidence.ps1`: opt-in UTF-8 and own-process identity
  bootstrap. Paired EvidenceUtf8/EvidenceIdentityPath arguments are supported by
  installer, stop and MCP start scripts. A default invocation returns without
  encoding/file/process capture changes. No execution-policy override exists.
- `verification/distribution-qualification.mjs`: original pinned script/tool
  paths and hashes remain authoritative. An optional archived byte location is
  confined to the exact expected capture root. Synthetic validation and native
  operating qualification remain independent.

The builder already copies powershell/*.ps1. A new clean candidate build must
include the new helper and changed script bytes; historical r257 payloads do not.
The full builder invokes pnpm install/deploy and is NOT_RUN in this no-install
unit. Direct installed tsc --noEmit and tsdown public build API are separate
checks. Diagnostic compiler output is redirected entirely into task scratch;
it is not a deploy, payload inventory or release qualification.

## Capture protocol, not an automatic scenario runner

The immutable plan pins the source/input/raw manifest hashes, installed Node and
PowerShell bytes, release root and explicit isolation root. Installation roots,
workspace/registry/requirements and explicit loopback origins belong to that
plan. No arbitrary command, endpoint or credential-file reader is exposed.
Credentials are explicitly injected by a future permitted caller, not archived;
a response reflecting the credential is refused before storage.

`action` invokes only the manifest-pinned installer, stop or MCP start script
through an explicit -File argument array, with no shell/Bypass. Node bytes and
the child bootstrap are checked before dispatch. The child writes its own PID,
creation FILETIME/time, started time and executable to a create-new sidecar.
Original stdout/stderr, actual exit and those identities form the receipt.
A sidecar alone is not host attestation. The local approved executor is trusted.

Only one public asynchronous operation may be in flight per recorder. A shared
guard is acquired synchronously before its first await and released in finally
for action, snapshot, API capture, launcher capture/proof, failure and assembly.
Both start orders reject overlap; there is no capture-first gap. Normalized child
environments preserve inherited PSEXECUTIONPOLICYPREFERENCE unchanged (or absent
when absent), and never set execution-policy flags. Pure object tests verify this
without changing the actual host policy.

A null/pending/invalid identity or failed non-injection action
retains an incomplete/failed receipt and blocks subsequent operations. A thrown
transport retains an unknown outcome without inventing stdout or an exit code.
Every failure after dispatch faults the recorder before releasing the guard,
including stdout/stderr/receipt serialization and exclusive-file writes. Raw
archive failures also latch the recorder. A failed error-receipt write does not
replace the original cause: Error.cause retains the original transport/identity
error and evidence_storage_error retains the second storage error. If storage
is unavailable, there is no saved-receipt claim and no subsequent action.
Timeout/output-limit results do not kill or detach an unknown process; pending
children remain explicit, and normal owned cancellation needs a separate plan.

`snapshot` reads only the target install manifest and runtime-state bytes.
`captureLauncher` reads the fixed launcher binary/source paths and timestamps
the captures. `launcherPreservation` requires distinct captures and the same
recorder's successful updater; its candidate source is pinned. The verifier
still checks previous manifest/actual binary hashes, normalized source equality,
actual preservation output, unchanged installed binary and observation order.
It never grants an arbitrary file exception.

`memory` captures project-scoped remember/search/detail response bytes/status and
fresh observation time through the target loopback API. `failure` binds the
original/restore error classification to this recorder's failed child stderr;
it does not infer rollback success or run recovery. `assemble` accepts only
records captured here, then calls the semantic verifier on the stored bytes.
Even an actual successful Windows evidence object is returned with overall
production_qualified=false; the separate final/native gates still apply.

## Required future connection and permissions

A small synthetic-only coordinator is implemented in windows-evidence-scenarios.mjs.
It constructs the existing synthetic factory with all five fake effects, rejects
injected adapters/production markers/phase overrides, uses fixed serial steps,
and returns only after the existing synthetic verifier accepts. Its cases are
independent fixture contracts, not observed cross-scenario installation history.
A real producer for fixed candidate/owned phases and the fixed pre-start failure
fixture now exists. Before a live run, pin a new clean
candidate manifest, distinct predecessor, exact roots/tasks/ports, planned phase
ordering and synthetic row. Define and review actual failure-injection points
and expected outcomes. The fixture derives two fixed edits from the candidate
installer and holds a scratch file to cause a real Copy-Item sharing violation.
It releases that lock before rollback; no arbitrary script hook is exposed.
The producer preserves the original typed error and separately records automatic
restoration, restoration failure or withheld rollback. These implemented paths
and synthetic regressions are not actual Windows update/recovery acceptance.
Do not fake a nonzero exit or reuse a historical failure. Capture before/after states and fresh memory
API responses at actual boundaries; preserve all errors and pending outcomes.
No old r255/r257 driver or static response can be relabelled as execution proof.

Actual installation, task activation/start/stop, isolated DPAPI/ACL/auth effects
and ownership-verified cleanup require their exact current permissions. None
were executed or granted by this code change. Do not query or clean the incident
roots. No operating database, model, external endpoint or public write is part of
this unit. Native/Qwen and Codex Memory v2 coexistence remain separate gates.
The exact guid-typescript notice and sharp component source delivery gaps remain
listed in THIRD-PARTY-NOTICES.md and are not resolved by collector tests.

## Submission gate bundle

See [SUBMISSION-VERIFICATION-GATES.md](SUBMISSION-VERIFICATION-GATES.md) for the
exact proposed build/candidate paths, isolated roots/ports/tasks, commands,
security effects, recovery/cleanup boundaries and unresolved identities. This is
a NOT_RUN request bundle, not an execution permission or substituted PASS.


## Single-slot execution preparation and partial lifecycle check

`windows-execution-preparation.mjs` is import-safe. Its real factory is separate
from the forced-synthetic provider factory and requires explicit `execute=true`,
one fixed slot, pinned PowerShell/backend bytes, candidate hash, owner SID and
the install nonce enrolled from this producer's prepare receipt. The producer
also rejects a candidate whose C# launcher still requests an execution-policy
override: the previous r259 candidate cannot be used with this new path.
No process or credential operation happens while constructing a plan.

At first execution only the exact evidence ancestors are created, never the
slot root. Fresh preparation creates a new isolated workspace/registry with
`CreateNew` semantics (existing support files cause HOLD), then invokes the
normal installer. `configurePrepared` is a separate explicit action between
prepare and activation: it binds the original owner/nonce/manifest/config and
atomically replaces only `config/codex-workspace.json`. It sets isolated
`codex_source_root=<slot>/home/.codex` and closed `local_qwen.base_url` on port1,
with no lifecycle script. No default workspace LocalAI script is introduced.
No credential is created or changed by this preparation backend.

The PowerShell backend locks existing input files against writes/deletion,
holds parent-directory handles without delete sharing, rejects reparse paths,
and checks final physical paths. Config replacement uses a new sibling file
and `File.Replace`; it never falls back to in-place overwrite. A concurrent
config writer is unsupported: mismatch/failure is HOLD, not permission to retry
or repair. A failed nonsecret temp remains for explicit review. These Windows
handle/replacement APIs have not been live-tested by the synthetic regressions.

After explicit activation, each memory request invokes one scoped DPAPI reader
under CurrentUser. The sole plaintext transport is a bounded anonymous pipe
to Node, then the existing loopback request header. There is no plaintext file,
argv, environment, hash or transcript artifact. Provider stdout/stderr are never
passed through the normal raw-log recorder; only validated child PID, creation
time, fixed error class and original exit/pending state are stored. Buffers are
cleared in `finally`; JS immutable strings rely on scoped lifetime/garbage
collection, not a claim of guaranteed memory erasure. A provider failure,
pending child, storage error, response echo or semantic mismatch holds the run.
There is no forced PID termination or alternate credential reader.

The C# launcher task/watch and MCP validation argv inherit existing PowerShell
policy. The ownership backend expects that identical argv. This does not
change host policy or bypass a script-signing refusal. The npm install CLI is
outside this direct host-adapter path and was not changed or executed here.

`runScenario` checks actual remember/search/detail ID, content, project and
origin equality before it records success. `verifyPartial` reuses the same
schema2 command/source/hash/target/nonce/runtime/time/memory validation as the
full verifier. It accepts only fresh/restart, requires fresh before restart at
the same installation and returns `windows_partial_execution` (or forced
`synthetic_partial_contract`) with `production_qualified=false`. It never mints
the full Windows acceptance proof. Managed update, failure recovery, native/v2
coexistence and Qwen remain independent required gates; an incomplete run still
fails final distribution qualification.

Current validation is fake-effect Node and allowlisted pure PowerShell AST
functions only. No real backend top-level, DPAPI, ACL, task, installation,
process observation/termination, API or model action was performed. The earlier
two absent-task queries prove only task absence at their observation time.
Per-target `Process.StartTime`, CIM executable/creation/parent/command and
watchdog-parent reads remain live preconditions. Denial/unknown must HOLD;
synthetic coverage cannot grant or establish those capabilities. Incident
roots and previously denied observations must not be retried.

The launcher bytes, immutable source/input digest and cleanup argv have changed,
so a new clean offline candidate/manifest and exact tool pins must be reviewed
before an executable security-action bundle can be finalized. r259 remains
unchanged evidence, not the candidate for this modified launcher. No whole
build or security action is automatically started by this code unit.
