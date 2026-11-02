param([Parameter(Mandatory=$true)][string]$ScratchRoot)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$product=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $product 'powershell\agentmemory-lifecycle.ps1')
$cases=[Collections.Generic.List[object]]::new()
$started=[DateTime]::UtcNow.ToString('o')
function Check([bool]$Value,[string]$Message) { if (-not $Value) { throw $Message } }
function Reject([scriptblock]$Action) {
    $failed=$false; try { & $Action | Out-Null } catch { $failed=$true }
    Check $failed 'Expected ownership or process-identity refusal'
}
function Case([string]$Name,[scriptblock]$Action) {
    try { & $Action; $cases.Add([ordered]@{name=$Name;status='passed'}) }
    catch { $cases.Add([ordered]@{name=$Name;status='failed';error=$_.Exception.Message}); throw }
}
$created='2026-10-01T00:00:00.0000000Z'
$state=[pscustomobject]@{daemon=[pscustomobject]@{pid=101;creation_date=$created};engine=[pscustomobject]@{pid=102;creation_date=$created}}
try {
    Check ($env:AGENTMEMORY_INTEGRATION -eq '0' -and $env:AGENTMEMORY_CURATE -eq '0') 'Live gates must be zero'
    Case 'failed startup without worker is exited only when every recorded child is absent' {
        Check (Test-AgentMemoryRecordedRunExited -RuntimeState $state -Probe { param($ProcessId) [pscustomobject]@{state='absent'} }) 'Failed-start identities not released'
        Check (-not (Test-AgentMemoryRecordedRunExited -RuntimeState $state -Probe { param($ProcessId) if ($ProcessId -eq 102) { [pscustomobject]@{state='present';creation_date=$created} } else { [pscustomobject]@{state='absent'} } })) 'Live engine was classified exited'
    }
    Case 'reused PID is distinct from the recorded process without signalling either process' {
        Check (Test-AgentMemoryRecordedRunExited -RuntimeState $state -Probe { param($ProcessId) [pscustomobject]@{state='present';creation_date='2026-10-02T00:00:00.0000000Z'} }) 'Reused PID held old run'
    }
    Case 'unknown and malformed observations cannot authorize restart' {
        foreach ($response in @($null,[pscustomobject]@{state='unknown'},[pscustomobject]@{state='present';creation_date='invalid'})) {
            Reject { Test-AgentMemoryRecordedRunExited -RuntimeState $state -Probe { param($ProcessId) $response } }
        }
    }
    Case 'missing or invalid recorded identity cannot authorize restart' {
        foreach ($invalid in @([pscustomobject]@{},[pscustomobject]@{daemon=[pscustomobject]@{pid=0;creation_date=$created}},[pscustomobject]@{daemon=[pscustomobject]@{pid=101}})) {
            Reject { Test-AgentMemoryRecordedRunExited -RuntimeState $invalid -Probe { param($ProcessId) [pscustomobject]@{state='absent'} } }
        }
    }
    Case 'DateTime identities from JSON materialization retain exact instant comparison' {
        $materialized=[pscustomobject]@{daemon=[pscustomobject]@{pid=101;creation_date=[DateTimeOffset]::Parse($created)}}
        Check (-not (Test-AgentMemoryRecordedRunExited -RuntimeState $materialized -Probe { param($ProcessId) [pscustomobject]@{state='present';creation_date=[DateTime]::Parse($created).ToUniversalTime()} })) 'DateTime changed identity'
    }
    Case 'daemon task registration binds installation nonce owner action and working directory' {
        $root=Join-Path ([IO.Path]::GetFullPath($ScratchRoot)) 'synthetic-uncreated-install'
        $sid='S-1-5-21-100-200-300-1001'
        $registration=[pscustomobject]@{task_path='\';task_name=('AgentMemoryCodex-Daemon-'+(Get-AgentMemoryTaskSidSuffix $sid));owner_sid=$sid;install_nonce='synthetic-nonce';description='OpenAI Codex AgentMemory daemon; install_nonce=synthetic-nonce';execute=(Join-Path $root 'bin\agentmemory-hidden-launcher.exe');arguments='task';working_directory=$root}
        Assert-AgentMemoryTaskRegistration -Root $root -OwnerSid $sid -InstallNonce 'synthetic-nonce' -Kind daemon -Registration $registration
        foreach ($change in @(@{install_nonce='foreign-synthetic-nonce'},@{owner_sid='S-1-5-21-1-2-3-1001'},@{arguments='watch'},@{execute=(Join-Path $root 'different.exe')},@{working_directory=$ScratchRoot})) {
            $copy=$registration.PSObject.Copy()
            foreach ($key in $change.Keys) { $copy.$key=$change[$key] }
            Reject { Assert-AgentMemoryTaskRegistration -Root $root -OwnerSid $sid -InstallNonce 'synthetic-nonce' -Kind daemon -Registration $copy }
        }
    }
} finally {
    $record=[ordered]@{started=$started;completed=[DateTime]::UtcNow.ToString('o');pid=$PID;executable=(Get-Process -Id $PID).Path;command=[Environment]::CommandLine;cases=@($cases.ToArray());scope='Actual lifecycle functions with injected synthetic process probes and registration; no OS task queries, signals, daemon, engine, model, or operational restart';live_gates='0';fixtures_created=$false}
    [IO.File]::WriteAllText((Join-Path $ScratchRoot 'lifecycle-contracts-result.json'),($record | ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
}
Write-Output ('PASS cases='+$cases.Count)
