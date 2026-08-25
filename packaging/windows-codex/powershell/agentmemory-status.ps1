param(
    [string]$Root = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$resolvedRoot = if ([string]::IsNullOrWhiteSpace($Root)) { [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)) } else { [System.IO.Path]::GetFullPath($Root) }
$envScript = Join-Path $resolvedRoot 'scripts\agentmemory-env.ps1'
$statePath = Join-Path $resolvedRoot 'data\runtime-state.json'
$installManifestPath = Join-Path $resolvedRoot 'config\install-manifest.json'
$legacyInstallStatePath = Join-Path $resolvedRoot 'config\install-state.json'
$taskRegistrationPath = Join-Path $resolvedRoot 'config\task-registration.json'
. $envScript -Root $resolvedRoot

$health = $false
try {
    $headers = @{ Authorization = "Bearer $($env:AGENTMEMORY_SECRET)" }
    $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3111/agentmemory/health' -Headers $headers -TimeoutSec 2
    $health = $response.StatusCode -eq 200
}
catch {
    $health = $false
}
$mcpHealth = Test-AgentMemoryMcpHttp -VerifyFailClosed

$listeners = foreach ($line in @(& (Join-Path $env:SystemRoot 'System32\netstat.exe') -ano -p TCP)) {
    if ($line -match '^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$' -and [int]$Matches[2] -in @(3111, 3112, 3113, 3114, 49134)) {
        [pscustomobject]@{
            LocalAddress = [string]$Matches[1]
            LocalPort = [int]$Matches[2]
            OwningProcess = [int]$Matches[3]
        }
    }
}

$taskState = $null
$taskName = $null
try {
    $taskRegistration = Get-Content -Raw -LiteralPath $taskRegistrationPath | ConvertFrom-Json
    $taskName = [string]$taskRegistration.task_name
    Import-Module ScheduledTasks -ErrorAction Stop
    $task = Get-ScheduledTask -TaskPath ([string]$taskRegistration.task_path) -TaskName $taskName -ErrorAction Stop
    $taskState = [string]$task.State
}
catch {
    $taskState = 'unavailable'
}

$runtimeState = $null
$stateFilePresent = Test-Path -LiteralPath $statePath -PathType Leaf
$runtimeStateValid = $false
if ($stateFilePresent) {
    try { $runtimeState = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json } catch { $runtimeState = $null }
    $runtimeStateValid = (
        $null -ne $runtimeState -and
        -not [string]::IsNullOrWhiteSpace([string]$runtimeState.run_id) -and
        -not [string]::IsNullOrWhiteSpace([string]$runtimeState.status) -and
        -not [string]::IsNullOrWhiteSpace([string]$runtimeState.root) -and
        [System.IO.Path]::GetFullPath([string]$runtimeState.root) -eq $resolvedRoot
    )
}
$installManifest = $null
$installManifestPresent = Test-Path -LiteralPath $installManifestPath -PathType Leaf
$installManifestValid = $false
if ($installManifestPresent) {
    try { $installManifest = Get-Content -Raw -LiteralPath $installManifestPath | ConvertFrom-Json } catch { $installManifest = $null }
    $installManifestValid = (
        $null -ne $installManifest -and
        -not [string]::IsNullOrWhiteSpace([string]$installManifest.install_root) -and
        [System.IO.Path]::GetFullPath([string]$installManifest.install_root) -eq $resolvedRoot -and
        -not [string]::IsNullOrWhiteSpace([string]$installManifest.package_relative_path) -and
        -not [string]::IsNullOrWhiteSpace([string]$installManifest.release_revision) -and
        $null -ne $installManifest.source_hashes
    )
}
$runLogs = @()
if ($runtimeState -and $runtimeState.run_id) {
    $runId = [string]$runtimeState.run_id
    foreach ($name in @("engine-$runId.stdout.log", "engine-$runId.stderr.log", "worker-$runId.stdout.log", "worker-$runId.stderr.log")) {
        $path = Join-Path $resolvedRoot "logs\$name"
        $item = Get-Item -LiteralPath $path -ErrorAction SilentlyContinue
        $runLogs += [ordered]@{
            name = $name
            present = $null -ne $item
            bytes = if ($item) { [long]$item.Length } else { 0 }
        }
    }
}

[ordered]@{
    healthy = $health -and $mcpHealth -and $runtimeStateValid -and $installManifestValid
    service_healthy = $health
    mcp_http_healthy = $mcpHealth
    state_file_present = $stateFilePresent
    runtime_state_valid = $runtimeStateValid
    install_manifest_present = $installManifestPresent
    install_manifest_valid = $installManifestValid
    task_registration_present = Test-Path -LiteralPath $taskRegistrationPath -PathType Leaf
    scheduled_task_name = $taskName
    scheduled_task_state = $taskState
    run_id = if ($runtimeState) { [string]$runtimeState.run_id } else { $null }
    runtime_status = if ($runtimeState) { [string]$runtimeState.status } else { $null }
    active_package = if ($installManifest) { [string]$installManifest.package_relative_path } else { $null }
    release_revision = if ($installManifest) { [string]$installManifest.release_revision } else { $null }
    install_manifest_verified_at_utc = if ($installManifest) { [string]$installManifest.verified_at_utc } else { $null }
    legacy_install_state_present = Test-Path -LiteralPath $legacyInstallStatePath -PathType Leaf
    child_log_policy = 'quiet; zero-byte stream logs mean the child emitted no console output'
    current_run_logs = $runLogs
    listeners = @($listeners)
} | ConvertTo-Json -Depth 7
