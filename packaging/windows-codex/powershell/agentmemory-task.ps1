param(
    [string]$Root = '',
    [string]$NodePath = '',
    [Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int]$HiddenLauncherPid
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

. (Join-Path $PSScriptRoot 'agentmemory-layout.ps1')
$layout = Resolve-AgentMemoryLayout -Root $Root -NodePath $NodePath
$resolvedRoot = $layout.Root
$NodePath = $layout.NodePath
$daemonScript = Join-Path $resolvedRoot 'scripts\agentmemory-daemon.ps1'
$logsPath = Join-Path $resolvedRoot 'logs'

try {
    & $daemonScript -Root $resolvedRoot -NodePath $NodePath -LauncherPid $HiddenLauncherPid
    exit 0
}
catch {
    try {
        [void][System.IO.Directory]::CreateDirectory($logsPath)
        $runId = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
        $errorPath = Join-Path $logsPath "task-$runId.stderr.log"
        $message = "AgentMemory scheduled task failed: $($_.Exception.Message)"
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($errorPath, $message, $utf8NoBom)
    }
    catch {}
    exit 1
}
