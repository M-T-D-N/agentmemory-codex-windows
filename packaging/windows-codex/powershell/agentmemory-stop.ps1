param(
    [string]$Root = '',
    [int]$TimeoutSeconds = 30,
    [switch]$EvidenceUtf8,
    [string]$EvidenceIdentityPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if ($EvidenceUtf8 -or -not [string]::IsNullOrWhiteSpace($EvidenceIdentityPath)) {
    . (Join-Path $PSScriptRoot 'agentmemory-evidence.ps1')
    Initialize-AgentMemoryEvidenceCapture -Utf8:$EvidenceUtf8 -IdentityPath $EvidenceIdentityPath
}

function Get-StopReservedConnections {
    foreach ($line in @(& (Join-Path $env:SystemRoot 'System32\netstat.exe') -ano -p TCP)) {
        if ($line -match '^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$' -and [int]$Matches[2] -in $reservedPorts) {
            [pscustomobject]@{ LocalPort = [int]$Matches[2]; OwningProcess = [int]$Matches[3] }
        }
    }
}

$resolvedRoot = if ([string]::IsNullOrWhiteSpace($Root)) { [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)) } else { [System.IO.Path]::GetFullPath($Root) }
$envScript = Join-Path $resolvedRoot 'scripts\agentmemory-env.ps1'
$lifecycleScript = Join-Path $resolvedRoot 'scripts\agentmemory-lifecycle.ps1'
$statePath = Join-Path $resolvedRoot 'data\runtime-state.json'
$stopPath = Join-Path $resolvedRoot 'data\stop-request.json'

foreach ($requiredFile in @($envScript, $lifecycleScript, $statePath)) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw "Required AgentMemory file is missing: $requiredFile"
    }
}
. $lifecycleScript
. $envScript -Root $resolvedRoot

$state = Get-Content -Encoding UTF8 -Raw -LiteralPath $statePath | ConvertFrom-Json
if ([string]$state.status -ne 'active' -or -not $state.worker -or -not $state.daemon -or -not $state.run_id) {
    throw 'AgentMemory does not have an active owned runtime state.'
}

$keyBytes = [System.Text.Encoding]::UTF8.GetBytes($env:AGENTMEMORY_SECRET)
$messageBytes = [System.Text.Encoding]::UTF8.GetBytes("Codex.AgentMemory.Stop.v1|$([int]$state.daemon.pid)|$([string]$state.run_id)")
$hmac = New-Object System.Security.Cryptography.HMACSHA256(,$keyBytes)
try {
    $stopToken = [Convert]::ToBase64String($hmac.ComputeHash($messageBytes))
}
finally {
    $hmac.Dispose()
    [System.Array]::Clear($keyBytes, 0, $keyBytes.Length)
    [System.Array]::Clear($messageBytes, 0, $messageBytes.Length)
}

$request = [ordered]@{
    schema_version = 1
    token = $stopToken
    worker_pid = [int]$state.worker.pid
    requested_at_utc = [DateTime]::UtcNow.ToString('o')
} | ConvertTo-Json
$temporaryPath = "$stopPath.$PID.tmp"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($temporaryPath, $request, $utf8NoBom)
Move-Item -LiteralPath $temporaryPath -Destination $stopPath -Force

. (Join-Path $PSScriptRoot 'agentmemory-layout.ps1')
$servicePorts = Get-AgentMemoryServicePorts -Root $resolvedRoot
$reservedPorts = @($servicePorts.rest, $servicePorts.stream, $servicePorts.viewer, $servicePorts.mcp, $servicePorts.engine)
$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
do {
    $listeners = @(Get-StopReservedConnections)
    $runExited = Test-AgentMemoryRecordedRunExited -RuntimeState $state -Probe { param($ProcessId) Get-AgentMemoryProcessIdentity -ProcessId $ProcessId }
    if ($listeners.Count -eq 0 -and $runExited) {
        $terminal = Get-Content -Encoding UTF8 -Raw -LiteralPath $statePath | ConvertFrom-Json
        if (@("run_id","status","terminal_reason") | Where-Object { -not $terminal.PSObject.Properties[$_] }) { throw "Recorded runtime clean-stop metadata is missing; no process was force-terminated." }
        if ($terminal.run_id -cne $state.run_id -or $terminal.status -cne "inactive" -or $terminal.terminal_reason -cnotin @("authenticated_external_stop","codex_desktop_window_absent")) { throw "Recorded runtime exited without a confirmed clean authenticated stop; no process was force-terminated." }
        [ordered]@{
            stopped = $true
            daemon_pid = [int]$state.daemon.pid
            worker_pid = [int]$state.worker.pid
        } | ConvertTo-Json
        exit 0
    }
    Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $deadline)

$shutdown = $null
try {
    $body = Invoke-RestMethod -Uri "http://127.0.0.1:$($servicePorts.rest)/agentmemory/livez" -Headers @{ Authorization = "Bearer $($env:AGENTMEMORY_SECRET)" } -TimeoutSec 2
    $shutdown = Get-AgentMemoryShutdownSummary -RuntimeState $state -Body $body
} catch {}
$delivery = $null
try { $delivery = Get-AgentMemoryStopDeliverySummary -RuntimeState (Get-Content -Encoding UTF8 -Raw -LiteralPath $statePath | ConvertFrom-Json) } catch {}
$detail = if ($shutdown) { " Worker shutdown=$($shutdown.state), stage=$($shutdown.stage)." } else { '' }
if ($delivery) { $detail += " Delivery=$delivery." }
throw "AgentMemory did not stop gracefully before the timeout;$detail no process was force-terminated."
