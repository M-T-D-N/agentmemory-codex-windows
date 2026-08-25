param(
    [string]$Root = '',
    [ValidateRange(2, 60)][int]$CodexExitGraceSeconds = 5,
    [ValidateRange(500, 5000)][int]$PollMilliseconds = 1000,
    [ValidateRange(10, 300)][int]$LeaseDiagnosticSeconds = 30
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$resolvedRoot = if ([string]::IsNullOrWhiteSpace($Root)) { [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)) } else { [System.IO.Path]::GetFullPath($Root) }
$envScript = Join-Path $resolvedRoot 'scripts\agentmemory-env.ps1'
$lifecycleScript = Join-Path $resolvedRoot 'scripts\agentmemory-lifecycle.ps1'
$taskRegistrationPath = Join-Path $resolvedRoot 'config\task-registration.json'
$ownerMarkerPath = Join-Path $resolvedRoot '.agentmemory-install-owner.json'
$hiddenLauncherPath = Join-Path $resolvedRoot 'bin\agentmemory-hidden-launcher.exe'
$statePath = Join-Path $resolvedRoot 'data\watchdog-state.json'
$runtimeStatePath = Join-Path $resolvedRoot 'data\runtime-state.json'
$stopPath = Join-Path $resolvedRoot 'data\stop-request.json'
$watchStopPath = Join-Path $resolvedRoot 'data\watchdog-stop-request.json'
$lockPath = Join-Path $resolvedRoot 'data\watchdog.lock'
$startupLockPath = Join-Path $resolvedRoot 'data\startup.lock'
$reservedPorts = @(3111, 3112, 3113, 3114, 49134)

foreach ($requiredFile in @($envScript, $lifecycleScript, $taskRegistrationPath, $ownerMarkerPath, $hiddenLauncherPath)) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw "Required AgentMemory watchdog file is missing: $requiredFile"
    }
}

. $envScript -Root $resolvedRoot
. $lifecycleScript

function Get-SidSuffix {
    param([Parameter(Mandatory = $true)][string]$Sid)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Sid)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').Substring(0, 12).ToLowerInvariant())
    }
    finally {
        $sha.Dispose()
        [System.Array]::Clear($bytes, 0, $bytes.Length)
    }
}

function Resolve-PrincipalSid {
    param([Parameter(Mandatory = $true)][string]$UserId)
    if ($UserId -match '^S-1-') {
        return (New-Object System.Security.Principal.SecurityIdentifier($UserId)).Value
    }
    return (New-Object System.Security.Principal.NTAccount($UserId)).Translate([System.Security.Principal.SecurityIdentifier]).Value
}

function Get-OwnedDaemonTask {
    Import-Module ScheduledTasks -ErrorAction Stop
    $ownerSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $ownerMarker = Get-Content -Raw -LiteralPath $ownerMarkerPath | ConvertFrom-Json
    $registration = Get-Content -Raw -LiteralPath $taskRegistrationPath | ConvertFrom-Json
    $expectedName = 'AgentMemoryCodex-Daemon-' + (Get-SidSuffix -Sid $ownerSid)
    $expectedDescription = "OpenAI Codex AgentMemory daemon; install_nonce=$([string]$ownerMarker.install_nonce)"
    if (
        [string]$registration.task_path -ne '\' -or
        [string]$registration.task_name -ne $expectedName -or
        [string]$registration.owner_sid -ne $ownerSid -or
        [string]$registration.install_nonce -ne [string]$ownerMarker.install_nonce -or
        [string]$registration.description -ne $expectedDescription -or
        [System.IO.Path]::GetFullPath([string]$registration.execute) -ne $hiddenLauncherPath -or
        [string]$registration.arguments -ne 'task' -or
        [System.IO.Path]::GetFullPath([string]$registration.working_directory) -ne $resolvedRoot
    ) {
        throw 'The protected AgentMemory daemon task registration does not match this installation.'
    }

    $task = Get-ScheduledTask -TaskPath '\' -TaskName $expectedName -ErrorAction Stop
    $actions = @($task.Actions)
    $triggers = @($task.Triggers | Where-Object { $null -ne $_ })
    $principalSid = Resolve-PrincipalSid -UserId ([string]$task.Principal.UserId)
    $executionLimit = [string]$task.Settings.ExecutionTimeLimit
    if (
        [string]$task.Description -ne $expectedDescription -or
        $actions.Count -ne 1 -or
        [System.IO.Path]::GetFullPath([string]$actions[0].Execute) -ne $hiddenLauncherPath -or
        [string]$actions[0].Arguments -ne 'task' -or
        [System.IO.Path]::GetFullPath([string]$actions[0].WorkingDirectory) -ne $resolvedRoot -or
        $triggers.Count -ne 0 -or
        $principalSid -ne $ownerSid -or
        [string]$task.Principal.LogonType -notin @('Interactive', 'InteractiveToken') -or
        [string]$task.Principal.RunLevel -notin @('Limited', 'LeastPrivilege') -or
        [string]$task.Settings.MultipleInstances -ne 'IgnoreNew' -or
        $executionLimit -notin @('00:00:00', 'PT0S') -or
        -not [bool]$task.Settings.AllowDemandStart
    ) {
        throw 'The AgentMemory daemon task failed its ownership or least-privilege checks.'
    }
    return $task
}

function Get-ReservedConnections {
    $netstatPath = Join-Path $env:SystemRoot 'System32\netstat.exe'
    $connections = foreach ($line in @(& $netstatPath -ano -p TCP)) {
        if ($line -match '^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$') {
            $port = [int]$Matches[2]
            if ($port -in $reservedPorts) {
                [pscustomobject]@{ LocalAddress = [string]$Matches[1]; LocalPort = $port; OwningProcess = [int]$Matches[3] }
            }
        }
    }
    return @($connections)
}

function Test-IPv4LoopbackAddress {
    param([Parameter(Mandatory = $true)][string]$Address)
    $parsed = $null
    if (-not [System.Net.IPAddress]::TryParse($Address, [ref]$parsed)) { return $false }
    if ($parsed.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { return $false }
    return $parsed.GetAddressBytes()[0] -eq 127
}

function Test-ServiceReady {
    try {
        $headers = @{ Authorization = "Bearer $($env:AGENTMEMORY_SECRET)" }
        $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3111/agentmemory/health' -Headers $headers -TimeoutSec 2
        if ($response.StatusCode -ne 200) { return $false }
        if (-not (Test-AgentMemoryMcpHttp)) { return $false }
        $connections = @(Get-ReservedConnections)
        if (@($connections | Where-Object { -not (Test-IPv4LoopbackAddress -Address $_.LocalAddress) }).Count -gt 0) { return $false }
        foreach ($port in @(3111, 3112, 49134)) {
            if (-not @($connections | Where-Object { $_.LocalPort -eq $port })) { return $false }
        }
        if (-not @($connections | Where-Object { $_.LocalPort -eq 3114 })) { return $false }
        return $true
    }
    catch {
        return $false
    }
}

function Request-AgentMemoryStop {
    if (-not (Test-Path -LiteralPath $runtimeStatePath -PathType Leaf)) {
        return $false
    }
    $runtimeState = Get-Content -Raw -LiteralPath $runtimeStatePath | ConvertFrom-Json
    if ([string]$runtimeState.status -ne 'active' -or -not $runtimeState.worker -or -not $runtimeState.daemon -or -not $runtimeState.run_id) {
        return $false
    }

    $keyBytes = [System.Text.Encoding]::UTF8.GetBytes($env:AGENTMEMORY_SECRET)
    $messageBytes = [System.Text.Encoding]::UTF8.GetBytes("Codex.AgentMemory.Stop.v1|$([int]$runtimeState.daemon.pid)|$([string]$runtimeState.run_id)")
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
        worker_pid = [int]$runtimeState.worker.pid
        requested_at_utc = [DateTime]::UtcNow.ToString('o')
        reason = 'codex_desktop_window_absent'
    } | ConvertTo-Json
    $temporaryPath = "$stopPath.$PID.tmp"
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($temporaryPath, $request, $utf8NoBom)
    Move-Item -LiteralPath $temporaryPath -Destination $stopPath -Force

    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        if (@(Get-ReservedConnections).Count -eq 0) {
            return $true
        }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    return $false
}

function Test-WatchdogStopRequest {
    if (-not [System.IO.File]::Exists($watchStopPath)) {
        return $false
    }
    try {
        $request = Get-Content -Raw -LiteralPath $watchStopPath | ConvertFrom-Json
        if ([int]$request.watcher_pid -ne $PID -or [string]$request.watcher_started_at_utc -ne $watchdogStartedAtUtc) {
            return $false
        }
        $keyBytes = [System.Text.Encoding]::UTF8.GetBytes($env:AGENTMEMORY_SECRET)
        $messageBytes = [System.Text.Encoding]::UTF8.GetBytes("Codex.AgentMemory.WatchdogStop.v1|$PID|$watchdogStartedAtUtc")
        $hmac = New-Object System.Security.Cryptography.HMACSHA256(,$keyBytes)
        try {
            $expected = [Convert]::ToBase64String($hmac.ComputeHash($messageBytes))
        }
        finally {
            $hmac.Dispose()
            [System.Array]::Clear($keyBytes, 0, $keyBytes.Length)
            [System.Array]::Clear($messageBytes, 0, $messageBytes.Length)
        }
        return [string]$request.token -eq $expected
    }
    catch {
        return $false
    }
}

function Invoke-SerializedStop {
    $startupLock = $null
    try {
        $deadline = [DateTime]::UtcNow.AddSeconds(15)
        do {
            try {
                $startupLock = [System.IO.File]::Open(
                    $startupLockPath,
                    [System.IO.FileMode]::OpenOrCreate,
                    [System.IO.FileAccess]::ReadWrite,
                    [System.IO.FileShare]::None
                )
            }
            catch [System.IO.IOException] {
                Start-Sleep -Milliseconds 250
            }
        } while (-not $startupLock -and [DateTime]::UtcNow -lt $deadline)
        if (-not $startupLock) {
            throw 'Timed out waiting for the AgentMemory lifecycle lock before stop.'
        }

        $recheck = Get-AgentMemoryConsumerState -Root $resolvedRoot
        if ($recheck.State -ne 'Absent') {
            return [pscustomobject]@{ Outcome = 'SkippedConsumerPresent'; Consumer = $recheck }
        }
        if (@(Get-ReservedConnections).Count -eq 0) {
            return [pscustomobject]@{ Outcome = 'AlreadyStopped'; Consumer = $recheck }
        }
        if (Request-AgentMemoryStop) {
            return [pscustomobject]@{ Outcome = 'Stopped'; Consumer = $recheck }
        }
        return [pscustomobject]@{ Outcome = 'Failed'; Consumer = $recheck }
    }
    finally {
        if ($startupLock) { $startupLock.Dispose() }
    }
}

$watchdogStartedAtUtc = [DateTime]::UtcNow.ToString('o')
$watchdogProcessStartedAtUtc = (Get-Process -Id $PID -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')
$watchdogState = [ordered]@{
    schema_version = 2
    status = 'active'
    watcher_pid = $PID
    watcher_started_at_utc = $watchdogStartedAtUtc
    watcher_process_started_at_utc = $watchdogProcessStartedAtUtc
    lifecycle_mode = 'windows_codex_desktop_window'
    consumer_state = 'Unknown'
    desktop_state = 'Unknown'
    desktop_process_state = 'Unknown'
    process_probe_state = 'Indeterminate'
    window_probe_state = 'NotRun'
    classification_reason = 'not_probed'
    probe_session_id = $null
    desktop_scope = $null
    probe_window_station = $null
    probe_desktop = $null
    window_probe_error = $null
    window_probe_error_source = $null
    window_probe_error_code = 0
    mcp_lease_state = 'Unknown'
    active_mcp_lease_count = 0
    stale_mcp_lease_count = 0
    official_codex_pids = @()
    official_codex_process_pids = @()
    official_codex_window_pids = @()
    last_codex_present_at_utc = $null
    last_codex_absent_at_utc = $null
    last_agentmemory_start_requested_at_utc = $null
    last_agentmemory_stop_requested_at_utc = $null
    last_agentmemory_stop_completed_at_utc = $null
    last_stop_desktop_state = $null
    last_stop_desktop_process_state = $null
    last_stop_process_probe_state = $null
    last_stop_window_probe_state = $null
    last_stop_classification_reason = $null
    last_stop_official_process_pids = @()
    last_stop_official_window_pids = @()
    last_stop_probe_session_id = $null
    last_stop_desktop_scope = $null
    last_stop_probe_window_station = $null
    last_stop_probe_desktop = $null
    last_stop_window_probe_error_source = $null
    last_stop_window_probe_error_code = 0
    start_request_count = 0
    stop_request_count = 0
    terminal_reason = $null
    last_error = $null
    updated_at_utc = [DateTime]::UtcNow.ToString('o')
}

function Write-WatchdogState {
    param([switch]$Force)
    $now = [DateTime]::UtcNow
    $signature = @(
        [string]$watchdogState.status,
        [string]$watchdogState.consumer_state,
        [string]$watchdogState.desktop_state,
        [string]$watchdogState.desktop_process_state,
        [string]$watchdogState.process_probe_state,
        [string]$watchdogState.window_probe_state,
        [string]$watchdogState.classification_reason,
        [string]$watchdogState.probe_session_id,
        [string]$watchdogState.desktop_scope,
        [string]$watchdogState.probe_window_station,
        [string]$watchdogState.probe_desktop,
        [string]$watchdogState.window_probe_error,
        [string]$watchdogState.window_probe_error_source,
        [string]$watchdogState.window_probe_error_code,
        [string]$watchdogState.mcp_lease_state,
        [string]$watchdogState.active_mcp_lease_count,
        [string]$watchdogState.stale_mcp_lease_count,
        (@($watchdogState.official_codex_pids) -join ','),
        (@($watchdogState.official_codex_process_pids) -join ','),
        (@($watchdogState.official_codex_window_pids) -join ','),
        [string]$watchdogState.start_request_count,
        [string]$watchdogState.stop_request_count,
        [string]$watchdogState.last_stop_classification_reason,
        (@($watchdogState.last_stop_official_process_pids) -join ','),
        (@($watchdogState.last_stop_official_window_pids) -join ','),
        [string]$watchdogState.last_stop_desktop_scope,
        [string]$watchdogState.last_stop_probe_window_station,
        [string]$watchdogState.last_stop_probe_desktop,
        [string]$watchdogState.last_stop_window_probe_error_source,
        [string]$watchdogState.last_stop_window_probe_error_code,
        [string]$watchdogState.last_error,
        [string]$watchdogState.terminal_reason
    ) -join '|'
    if (-not $Force -and $signature -eq $script:lastStateSignature -and ($now - $script:lastStateWriteUtc).TotalSeconds -lt 30) {
        return
    }
    if ([string]$watchdogState.desktop_state -eq 'Present') {
        $watchdogState.last_codex_present_at_utc = $now.ToString('o')
    }
    $watchdogState.updated_at_utc = $now.ToString('o')
    $temporaryPath = "$statePath.$PID.tmp"
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($temporaryPath, ($watchdogState | ConvertTo-Json -Depth 5), $utf8NoBom)
    Move-Item -LiteralPath $temporaryPath -Destination $statePath -Force
    $script:lastStateSignature = $signature
    $script:lastStateWriteUtc = $now
}

$watchdogLock = $null
try {
    try {
        $watchdogLock = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    }
    catch [System.IO.IOException] {
        exit 0
    }

    $absentSince = $null
    $lastStartAttempt = [DateTime]::MinValue
    $lastStopAttempt = [DateTime]::MinValue
    $lastReadinessCheck = [DateTime]::MinValue
    $lastObservedDesktopState = $null
    $lastLeaseDiagnostic = [DateTime]::MinValue
    $cachedLeaseState = $null
    $stoppedForCurrentAbsence = $false
    $script:lastStateSignature = $null
    $script:lastStateWriteUtc = [DateTime]::MinValue
    Write-WatchdogState -Force

    while ($true) {
        try {
            if (Test-WatchdogStopRequest) {
                $watchdogState.status = 'inactive'
                $watchdogState.terminal_reason = 'authenticated_update_stop'
                Write-WatchdogState -Force
                Remove-Item -Force -LiteralPath $watchStopPath
                break
            }
            $probeNow = [DateTime]::UtcNow
            if ($null -eq $cachedLeaseState -or ($probeNow - $lastLeaseDiagnostic).TotalSeconds -ge $LeaseDiagnosticSeconds) {
                $cachedLeaseState = Get-AgentMemoryMcpLeaseState -Root $resolvedRoot
                $lastLeaseDiagnostic = [DateTime]::UtcNow
            }
            $consumer = Get-AgentMemoryConsumerState -Root $resolvedRoot -LeaseState $cachedLeaseState
            $watchdogState.consumer_state = [string]$consumer.State
            $watchdogState.desktop_state = [string]$consumer.DesktopState
            $watchdogState.desktop_process_state = [string]$consumer.DesktopProcessState
            $watchdogState.process_probe_state = [string]$consumer.DesktopProcessProbeState
            $watchdogState.window_probe_state = [string]$consumer.DesktopWindowProbeState
            $watchdogState.classification_reason = [string]$consumer.DesktopClassificationReason
            $watchdogState.probe_session_id = [int]$consumer.DesktopProbeSessionId
            $watchdogState.desktop_scope = [string]$consumer.DesktopScope
            $watchdogState.probe_window_station = [string]$consumer.DesktopProbeWindowStation
            $watchdogState.probe_desktop = [string]$consumer.DesktopProbeDesktop
            $watchdogState.window_probe_error = [string]$consumer.DesktopWindowProbeError
            $watchdogState.window_probe_error_source = [string]$consumer.DesktopWindowProbeErrorSource
            $watchdogState.window_probe_error_code = [int]$consumer.DesktopWindowProbeErrorCode
            $watchdogState.mcp_lease_state = [string]$consumer.LeaseState
            $watchdogState.active_mcp_lease_count = [int]$consumer.ActiveLeaseCount
            $watchdogState.stale_mcp_lease_count = [int]$consumer.StaleLeaseCount
            $watchdogState.official_codex_pids = @($consumer.DesktopPids)
            $watchdogState.official_codex_process_pids = @($consumer.DesktopProcessPids)
            $watchdogState.official_codex_window_pids = @($consumer.DesktopWindowPids)
            $desktopStateChanged = [string]$consumer.DesktopState -ne [string]$lastObservedDesktopState
            $lastObservedDesktopState = [string]$consumer.DesktopState

            if ($consumer.State -eq 'Present') {
                $now = [DateTime]::UtcNow
                $absentSince = $null
                $stoppedForCurrentAbsence = $false
                if ($desktopStateChanged -or ($now - $lastReadinessCheck).TotalSeconds -ge 5) {
                    $lastReadinessCheck = $now
                    if (-not (Test-ServiceReady) -and @(Get-ReservedConnections).Count -eq 0 -and ($now - $lastStartAttempt).TotalSeconds -ge 10) {
                        $daemonTask = Get-OwnedDaemonTask
                        Start-ScheduledTask -InputObject $daemonTask -ErrorAction Stop
                        $lastStartAttempt = $now
                        $watchdogState.last_agentmemory_start_requested_at_utc = $now.ToString('o')
                        $watchdogState.start_request_count = [int]$watchdogState.start_request_count + 1
                    }
                }
                $watchdogState.last_error = $null
            }
            elseif ($consumer.State -eq 'Unknown') {
                # Fail open: never stop when the official app identity cannot be classified.
                $absentSince = $null
                $stoppedForCurrentAbsence = $false
            }
            else {
                $now = [DateTime]::UtcNow
                if (-not $absentSince) {
                    $absentSince = $now
                    $watchdogState.last_codex_absent_at_utc = $now.ToString('o')
                }
                if (
                    -not $stoppedForCurrentAbsence -and
                    ($now - $absentSince).TotalSeconds -ge $CodexExitGraceSeconds -and
                    ($now - $lastStopAttempt).TotalSeconds -ge 10
                ) {
                    $lastStopAttempt = $now
                    $watchdogState.last_agentmemory_stop_requested_at_utc = $now.ToString('o')
                    $watchdogState.stop_request_count = [int]$watchdogState.stop_request_count + 1
                    $stopResult = Invoke-SerializedStop
                    if ($stopResult.Outcome -in @('Stopped', 'AlreadyStopped')) {
                        $stoppedForCurrentAbsence = $true
                        $watchdogState.last_stop_desktop_state = [string]$stopResult.Consumer.DesktopState
                        $watchdogState.last_stop_desktop_process_state = [string]$stopResult.Consumer.DesktopProcessState
                        $watchdogState.last_stop_process_probe_state = [string]$stopResult.Consumer.DesktopProcessProbeState
                        $watchdogState.last_stop_window_probe_state = [string]$stopResult.Consumer.DesktopWindowProbeState
                        $watchdogState.last_stop_classification_reason = [string]$stopResult.Consumer.DesktopClassificationReason
                        $watchdogState.last_stop_official_process_pids = @($stopResult.Consumer.DesktopProcessPids)
                        $watchdogState.last_stop_official_window_pids = @($stopResult.Consumer.DesktopWindowPids)
                        $watchdogState.last_stop_probe_session_id = [int]$stopResult.Consumer.DesktopProbeSessionId
                        $watchdogState.last_stop_desktop_scope = [string]$stopResult.Consumer.DesktopScope
                        $watchdogState.last_stop_probe_window_station = [string]$stopResult.Consumer.DesktopProbeWindowStation
                        $watchdogState.last_stop_probe_desktop = [string]$stopResult.Consumer.DesktopProbeDesktop
                        $watchdogState.last_stop_window_probe_error_source = [string]$stopResult.Consumer.DesktopWindowProbeErrorSource
                        $watchdogState.last_stop_window_probe_error_code = [int]$stopResult.Consumer.DesktopWindowProbeErrorCode
                        $watchdogState.last_agentmemory_stop_completed_at_utc = [DateTime]::UtcNow.ToString('o')
                        $watchdogState.last_error = $null
                    }
                    elseif ($stopResult.Outcome -eq 'SkippedConsumerPresent') {
                        $absentSince = $null
                        $stoppedForCurrentAbsence = $false
                    }
                    else {
                        $watchdogState.last_error = 'The authenticated stop request did not complete; no process was force-terminated.'
                    }
                }
            }
            Write-WatchdogState
        }
        catch {
            $absentSince = $null
            $stoppedForCurrentAbsence = $false
            $lastObservedDesktopState = 'Unknown'
            $watchdogState.consumer_state = 'Unknown'
            $watchdogState.desktop_state = 'Unknown'
            $watchdogState.desktop_process_state = 'Unknown'
            $watchdogState.process_probe_state = 'Indeterminate'
            $watchdogState.window_probe_state = 'Indeterminate'
            $watchdogState.classification_reason = 'watchdog_probe_exception'
            $watchdogState.desktop_scope = $null
            $watchdogState.probe_window_station = $null
            $watchdogState.probe_desktop = $null
            $watchdogState.window_probe_error = 'watchdog_probe_exception'
            $watchdogState.window_probe_error_source = 'watchdog_probe_exception'
            $watchdogState.window_probe_error_code = 0
            $watchdogState.official_codex_pids = @()
            $watchdogState.official_codex_process_pids = @()
            $watchdogState.official_codex_window_pids = @()
            $watchdogState.last_error = $_.Exception.Message
            try { Write-WatchdogState } catch {}
        }
        Start-Sleep -Milliseconds $PollMilliseconds
    }
}
finally {
    if ($watchdogLock) {
        $watchdogLock.Dispose()
    }
}
