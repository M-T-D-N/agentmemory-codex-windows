# Continuing one closed configuration failure

The separate `createWindowsPreparedConfigureContinuationProducer(options,
originalSpec, continuationSpec)` imports the verified original prepare and one
closed resumed configure failure. It does not reset either failed producer,
delete or replace the existing lifecycle claim, prepare again, choose another
slot/nonce, or invent a general retry framework. The candidate remains immutable;
external verification tool pins are separate. This implementation has only
synthetic/native-filesystem regression evidence. No actual slot retry is made.

## Closed evidence and a single ordinal

The read-only verifier checks exact original plan/prepare evidence, the resumed
plan and driver source pins, controller PID/birth/parent/command/time/exit,
completed admission, failed configure contract/identity/receipt, and every pinned
raw hash. The original resumed tool source is read from its pinned archive in
the same task controller's parent evidence directory, never from Git/history or
a modified live source. Missing, pending, later actions, another slot/nonce/tool,
changed bytes or invalid retained source metadata hold before dispatch.

`resumePrepared()` reuses the unchanged existing claim and appends exactly one
create-new sibling `<claim>.configure-2.json`. That ordinal binds the claim hash,
closed evidence digest, original execution/slot/nonce/candidate and current time.
Concurrent/repeated instances fail create-new. Neither this entry nor its original
claim is deleted on failure. A failed or unknown continuation remains held; a
second ordinal or automatic retry is not implemented.

The existing ownership re-observation must still show prepared state, no runtime,
and the exact two absent tasks. The scoped prepared inspector additionally checks
absence of the closed writer PID, unchanged prepared manifest/config and exactly
one retained temp. The temp descriptor must name a regular nonredirected file in
the exact config directory and pin its size/hash. Its bytes must equal the
deterministic PowerShell `New-IsolatedConfiguration` transform, with the exact
workspace/registry/five ports, owned home Codex path and closed loopback model.
No credential read is part of admission or configure.

## Retained-source native replacement

The original typed-null fix for ordinary new-temp configuration remains in place.
It is insufficient when retained source/destination read handles remain open:
the controlled native sharing comparisons reproduce File.Replace sharing failure.
Releasing the source and trusting its name again would lose the source binding.

The retained path therefore opens the validated source with READ+DELETE access
and read sharing only. Its handle remains open until the operation is verified:
competing writes/rename/delete fail. Source final physical path, file ID, link
count and bytes are checked through that handle. Only our original config read
handle is released, then destination is reopened without write sharing and its
file ID, path, one-link status and baseline bytes are checked. Source and target
owner/group/DACL descriptors must match byte-for-byte, so the rename cannot
silently substitute different access control. Descriptor values are not logged.

Normal Windows handle rename requires the destination closed. After validation,
only our destination handle is closed; parent/owner/manifest and retained source
handles remain held. `SetFileInformationByHandle(FileRenameInfo)` replaces the
fixed destination using that source handle. It does not use POSIX semantics,
ignore-readonly, in-place writes or a fallback. A foreign destination read handle
still blocks it. Source final physical path/file ID/link count/hash and consumed
temp name are checked before success. Unknown/failed outcomes preserve evidence
and hold. This is not a transactional compare-and-swap against arbitrary hostile
same-user directory writers during the destination release window; create-new
ordinal and ownership admission exclude cooperating writers, and the source
identity remains locked. No stronger filesystem isolation is claimed.

Native controls cover both-side sharing, changed source/destination, retained
source swap/write denial, exact transform, extra temp and actual configure-retained
backend success on generated benign metadata. Initial failed buffer and destination
release experiments remain in the evidence. The NUL-terminated rename buffer is
per the official FILE_RENAME_INFO contract; only the ordinary replacement flag is
used. Official references:
- https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_rename_info
- https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_rename_information

## Reviewed next invocation, not executed here

After dot reviews source/native evidence, use the fixed r260 candidate and newly
pinned external preparation tool, with a new task-owned evidence output. Construct
the continuation factory with `execute:true`, the original spec and closed
configure spec. Call `resumePrepared()` once, then `configurePrepared()` once.
The existing producer object can then run the previously approved fresh/restart,
non-promoting partial verification and owned cleanup sequence. Every boundary
must succeed; no new prepare, claim reset, temp deletion or replacement slot.
Current slot/temp/claim status is not refreshed by this implementation unit.
Original failure records and the 06:16 read-only projection are preserved as dated
evidence, not a claim of new current admission. Actual execution still awaits dot
review. Windows four-case/native/v2/Qwen/license acceptance remains incomplete.

Run the opt-in `synthetic-windows-config-replace.test.mjs` only with an explicit
task-owned AGENTMEMORY_REPLACE_FIXTURE_ROOT and installed Node/WindowsPS. It calls
actual native APIs and configure backend on generated files, never a live slot,
DPAPI, ACL writer, OS task or model. Ordinary fake-effect continuation regressions
are registered through the existing synthetic-windows-resume suite.
