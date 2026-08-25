param(
    [string]$Root = '',
    [ValidateRange(2, 60)][int]$TimeoutSeconds = 15
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$resolvedRoot = if ([string]::IsNullOrWhiteSpace($Root)) { [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)) } else { [System.IO.Path]::GetFullPath($Root) }
$envScript = Join-Path $resolvedRoot 'scripts\agentmemory-env.ps1'
$statePath = Join-Path $resolvedRoot 'data\watchdog-state.json'
$requestPath = Join-Path $resolvedRoot 'data\watchdog-stop-request.json'
$registrationPath = Join-Path $resolvedRoot 'config\watchdog-task-registration.json'
foreach ($requiredFile in @($envScript, $statePath, $registrationPath)) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw "Required AgentMemory watchdog file is missing: $requiredFile"
    }
}
. $envScript -Root $resolvedRoot

$state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
if ([string]$state.status -ne 'active' -or -not $state.watcher_pid -or -not $state.watcher_started_at_utc -or -not $state.watcher_process_started_at_utc) {
    return
}

$keyBytes = [System.Text.Encoding]::UTF8.GetBytes($env:AGENTMEMORY_SECRET)
$messageBytes = [System.Text.Encoding]::UTF8.GetBytes("Codex.AgentMemory.WatchdogStop.v1|$([int]$state.watcher_pid)|$([string]$state.watcher_started_at_utc)")
$hmac = New-Object System.Security.Cryptography.HMACSHA256(,$keyBytes)
try {
    $token = [Convert]::ToBase64String($hmac.ComputeHash($messageBytes))
}
finally {
    $hmac.Dispose()
    [System.Array]::Clear($keyBytes, 0, $keyBytes.Length)
    [System.Array]::Clear($messageBytes, 0, $messageBytes.Length)
}

$request = [ordered]@{
    schema_version = 1
    watcher_pid = [int]$state.watcher_pid
    watcher_started_at_utc = [string]$state.watcher_started_at_utc
    token = $token
    requested_at_utc = [DateTime]::UtcNow.ToString('o')
} | ConvertTo-Json
$temporaryPath = "$requestPath.$PID.tmp"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($temporaryPath, $request, $utf8NoBom)
Move-Item -LiteralPath $temporaryPath -Destination $requestPath -Force

$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
do {
    Start-Sleep -Milliseconds 250
    try {
        $current = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
        if (
            [int]$current.watcher_pid -eq [int]$state.watcher_pid -and
            [string]$current.watcher_started_at_utc -eq [string]$state.watcher_started_at_utc -and
            [string]$current.status -eq 'inactive'
        ) {
            $watcherProcess = Get-Process -Id ([int]$state.watcher_pid) -ErrorAction SilentlyContinue
            if ($watcherProcess -and $watcherProcess.StartTime.ToUniversalTime().ToString('o') -eq [string]$state.watcher_process_started_at_utc) {
                continue
            }
            $registration = Get-Content -Raw -LiteralPath $registrationPath | ConvertFrom-Json
            Import-Module ScheduledTasks -ErrorAction Stop
            $task = Get-ScheduledTask -TaskPath ([string]$registration.task_path) -TaskName ([string]$registration.task_name) -ErrorAction Stop
            if ([string]$task.State -eq 'Ready') {
                return
            }
        }
    }
    catch {}
} while ([DateTime]::UtcNow -lt $deadline)

throw 'AgentMemory watchdog did not stop gracefully before the timeout; no process was force-terminated.'
