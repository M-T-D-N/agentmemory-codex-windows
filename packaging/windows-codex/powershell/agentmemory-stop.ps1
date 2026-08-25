param(
    [string]$Root = '',
    [int]$TimeoutSeconds = 30
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$resolvedRoot = if ([string]::IsNullOrWhiteSpace($Root)) { [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)) } else { [System.IO.Path]::GetFullPath($Root) }
$envScript = Join-Path $resolvedRoot 'scripts\agentmemory-env.ps1'
$statePath = Join-Path $resolvedRoot 'data\runtime-state.json'
$stopPath = Join-Path $resolvedRoot 'data\stop-request.json'

foreach ($requiredFile in @($envScript, $statePath)) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw "Required AgentMemory file is missing: $requiredFile"
    }
}
. $envScript -Root $resolvedRoot

$state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
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

$reservedPorts = @(3111, 3112, 3113, 3114, 49134)
$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
do {
    $listeners = foreach ($line in @(& (Join-Path $env:SystemRoot 'System32\netstat.exe') -ano -p TCP)) {
        if ($line -match '^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$' -and [int]$Matches[2] -in $reservedPorts) {
            [pscustomobject]@{ LocalPort = [int]$Matches[2]; OwningProcess = [int]$Matches[3] }
        }
    }
    if (@($listeners).Count -eq 0) {
        [ordered]@{
            stopped = $true
            daemon_pid = [int]$state.daemon.pid
            worker_pid = [int]$state.worker.pid
        } | ConvertTo-Json
        exit 0
    }
    Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $deadline)

throw 'AgentMemory did not stop gracefully before the timeout; no process was force-terminated.'
