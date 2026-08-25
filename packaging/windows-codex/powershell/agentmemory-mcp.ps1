param(
    [string]$Root = '',
    [string]$NodePath = '',
    [switch]$ValidateOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

. (Join-Path $PSScriptRoot 'agentmemory-layout.ps1')
$layout = Resolve-AgentMemoryLayout -Root $Root -NodePath $NodePath
$resolvedRoot = $layout.Root
$NodePath = $layout.NodePath
$envScript = Join-Path $resolvedRoot 'scripts\agentmemory-env.ps1'
$lifecycleScript = Join-Path $resolvedRoot 'scripts\agentmemory-lifecycle.ps1'
$daemonScript = Join-Path $resolvedRoot 'scripts\agentmemory-daemon.ps1'
$taskScript = Join-Path $resolvedRoot 'scripts\agentmemory-task.ps1'
$taskRegistrationPath = Join-Path $resolvedRoot 'config\task-registration.json'
$ownerMarkerPath = Join-Path $resolvedRoot '.agentmemory-install-owner.json'
$officialCliPath = Join-Path $layout.PackageRoot 'dist\cli.mjs'
$hiddenLauncherPath = Join-Path $resolvedRoot 'bin\agentmemory-hidden-launcher.exe'
$startupLockPath = Join-Path $resolvedRoot 'data\startup.lock'
$reservedPorts = @(3111, 3112, 3113, 3114, 49134)

foreach ($requiredFile in @($envScript, $lifecycleScript, $daemonScript, $taskScript, $taskRegistrationPath, $ownerMarkerPath, $officialCliPath, $hiddenLauncherPath, $NodePath)) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        [Console]::Error.WriteLine("Required AgentMemory file is missing: $requiredFile")
        exit 1
    }
}
try {
    . $envScript -Root $resolvedRoot
    . $lifecycleScript
}
catch {
    [Console]::Error.WriteLine("AgentMemory environment initialization failed: $($_.Exception.Message)")
    exit 1
}

function Get-ReservedConnections {
    $netstatPath = Join-Path $env:SystemRoot 'System32\netstat.exe'
    $connections = foreach ($line in @(& $netstatPath -ano -p TCP)) {
        if ($line -match '^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$') {
            $port = [int]$Matches[2]
            if ($port -in $reservedPorts) {
                [pscustomobject]@{
                    LocalAddress = [string]$Matches[1]
                    LocalPort = $port
                    OwningProcess = [int]$Matches[3]
                }
            }
        }
    }
    return @($connections)
}

function Test-AgentMemoryHealth {
    try {
        $headers = @{ Authorization = "Bearer $($env:AGENTMEMORY_SECRET)" }
        $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3111/agentmemory/health' -Headers $headers -TimeoutSec 2
        return $response.StatusCode -eq 200
    }
    catch {
        return $false
    }
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
        if (-not (Test-AgentMemoryHealth)) {
            return $false
        }
        if (-not (Test-AgentMemoryMcpHttp)) {
            return $false
        }
        $connections = Get-ReservedConnections
        if (@($connections | Where-Object { -not (Test-IPv4LoopbackAddress -Address $_.LocalAddress) }).Count -gt 0) {
            return $false
        }
        foreach ($port in @(3111, 3112, 49134)) {
            if (-not @($connections | Where-Object { $_.LocalPort -eq $port })) {
                return $false
            }
        }
        if (-not @($connections | Where-Object { $_.LocalPort -eq 3114 })) {
            return $false
        }
        return $true
    }
    catch {
        return $false
    }
}

function Wait-ServiceReady {
    param([int]$TimeoutSeconds)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        if (Test-ServiceReady) {
            return $true
        }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    return $false
}

function Wait-CodexWindowPresent {
    param([int]$TimeoutSeconds)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        try {
            $consumer = Get-CodexDesktopState
        }
        catch {
            $consumer = [pscustomobject]@{ State = 'Unknown' }
        }
        if ($consumer.State -eq 'Present') { return $consumer }
        if ($consumer.State -eq 'Unknown' -and (Test-ServiceReady)) { return $consumer }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    return $null
}

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

function Get-XmlChildText {
    param(
        [AllowNull()][System.Xml.XmlNode]$Node,
        [Parameter(Mandatory = $true)][string]$Name
    )
    if ($null -eq $Node) { return '' }
    $child = $Node.SelectSingleNode("./*[local-name()='$Name']")
    if ($null -eq $child) { return '' }
    return [string]$child.InnerText
}

function Assert-OwnedScheduledTaskRegistration {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $ownerSid = $identity.User.Value
    $ownerMarker = Get-Content -Raw -LiteralPath $ownerMarkerPath | ConvertFrom-Json
    $registration = Get-Content -Raw -LiteralPath $taskRegistrationPath | ConvertFrom-Json
    $expectedName = 'AgentMemoryCodex-Daemon-' + (Get-SidSuffix -Sid $ownerSid)
    $expectedDescription = "OpenAI Codex AgentMemory daemon; install_nonce=$([string]$ownerMarker.install_nonce)"
    $expectedArguments = 'task'

    if (
        [string]$registration.task_path -ne '\' -or
        [string]$registration.task_name -ne $expectedName -or
        [string]$registration.owner_sid -ne $ownerSid -or
        [string]$registration.install_nonce -ne [string]$ownerMarker.install_nonce -or
        [string]$registration.description -ne $expectedDescription -or
        [System.IO.Path]::GetFullPath([string]$registration.execute) -ne $hiddenLauncherPath -or
        [string]$registration.arguments -ne $expectedArguments -or
        [System.IO.Path]::GetFullPath([string]$registration.working_directory) -ne $resolvedRoot
    ) {
        throw 'The protected AgentMemory scheduled-task registration does not match this installation.'
    }

    $schtasksPath = Join-Path $env:SystemRoot 'System32\schtasks.exe'
    $taskXmlText = @(& $schtasksPath /Query /TN "\$expectedName" /XML ONE 2>$null)
    if ($LASTEXITCODE -ne 0 -or $taskXmlText.Count -eq 0) {
        throw 'The installed AgentMemory scheduled task could not be read for ownership verification.'
    }
    try {
        [xml]$taskXml = $taskXmlText -join [Environment]::NewLine
    }
    catch {
        throw 'The installed AgentMemory scheduled task returned invalid XML.'
    }
    $principals = @($taskXml.SelectNodes('/*[local-name()="Task"]/*[local-name()="Principals"]/*[local-name()="Principal"]'))
    $actionNodes = @($taskXml.SelectNodes('/*[local-name()="Task"]/*[local-name()="Actions"]/*'))
    $actions = @($actionNodes | Where-Object { $_.LocalName -eq 'Exec' })
    $triggers = @($taskXml.SelectNodes('/*[local-name()="Task"]/*[local-name()="Triggers"]/*'))
    $registrationInfoNode = $taskXml.SelectSingleNode('/*[local-name()="Task"]/*[local-name()="RegistrationInfo"]')
    $settingsNode = $taskXml.SelectSingleNode('/*[local-name()="Task"]/*[local-name()="Settings"]')
    $restartNode = if ($settingsNode) { $settingsNode.SelectSingleNode("./*[local-name()='RestartOnFailure']") } else { $null }
    $description = Get-XmlChildText -Node $registrationInfoNode -Name 'Description'
    $principalUserId = if ($principals.Count -eq 1) { Get-XmlChildText -Node $principals[0] -Name 'UserId' } else { '' }
    $principalSid = if ($principalUserId) { Resolve-PrincipalSid -UserId $principalUserId } else { $null }
    $logonType = if ($principals.Count -eq 1) { Get-XmlChildText -Node $principals[0] -Name 'LogonType' } else { '' }
    $runLevel = if ($principals.Count -eq 1) { Get-XmlChildText -Node $principals[0] -Name 'RunLevel' } else { '' }
    $executionLimit = Get-XmlChildText -Node $settingsNode -Name 'ExecutionTimeLimit'
    $restartInterval = Get-XmlChildText -Node $restartNode -Name 'Interval'
    $restartCount = Get-XmlChildText -Node $restartNode -Name 'Count'
    $allowDemandStart = Get-XmlChildText -Node $settingsNode -Name 'AllowStartOnDemand'
    $multipleInstances = Get-XmlChildText -Node $settingsNode -Name 'MultipleInstancesPolicy'
    $actionCommand = if ($actions.Count -eq 1) { Get-XmlChildText -Node $actions[0] -Name 'Command' } else { '' }
    $actionArguments = if ($actions.Count -eq 1) { Get-XmlChildText -Node $actions[0] -Name 'Arguments' } else { '' }
    $actionWorkingDirectory = if ($actions.Count -eq 1) { Get-XmlChildText -Node $actions[0] -Name 'WorkingDirectory' } else { '' }
    if (
        $description -ne $expectedDescription -or
        $principals.Count -ne 1 -or
        $actionNodes.Count -ne 1 -or
        $actions.Count -ne 1 -or
        [System.IO.Path]::GetFullPath($actionCommand) -ne $hiddenLauncherPath -or
        $actionArguments -ne $expectedArguments -or
        [System.IO.Path]::GetFullPath($actionWorkingDirectory) -ne $resolvedRoot -or
        $triggers.Count -ne 0 -or
        $principalSid -ne $ownerSid -or
        $logonType -notin @('Interactive', 'InteractiveToken') -or
        $runLevel -notin @('', 'Limited', 'LeastPrivilege') -or
        $multipleInstances -ne 'IgnoreNew' -or
        $executionLimit -notin @('00:00:00', 'PT0S') -or
        [int]$restartCount -ne 3 -or
        $restartInterval -notin @('00:01:00', 'PT1M') -or
        $allowDemandStart -notin @('', 'true', 'True')
    ) {
        throw 'The installed AgentMemory scheduled task failed its ownership or least-privilege checks.'
    }
}

function Get-OwnedScheduledTask {
    Import-Module ScheduledTasks -ErrorAction Stop
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $ownerSid = $identity.User.Value
    $ownerMarker = Get-Content -Raw -LiteralPath $ownerMarkerPath | ConvertFrom-Json
    $registration = Get-Content -Raw -LiteralPath $taskRegistrationPath | ConvertFrom-Json
    $expectedName = 'AgentMemoryCodex-Daemon-' + (Get-SidSuffix -Sid $ownerSid)
    $expectedDescription = "OpenAI Codex AgentMemory daemon; install_nonce=$([string]$ownerMarker.install_nonce)"
    $expectedArguments = 'task'

    if (
        [string]$registration.task_path -ne '\' -or
        [string]$registration.task_name -ne $expectedName -or
        [string]$registration.owner_sid -ne $ownerSid -or
        [string]$registration.install_nonce -ne [string]$ownerMarker.install_nonce -or
        [string]$registration.description -ne $expectedDescription -or
        [System.IO.Path]::GetFullPath([string]$registration.execute) -ne $hiddenLauncherPath -or
        [string]$registration.arguments -ne $expectedArguments -or
        [System.IO.Path]::GetFullPath([string]$registration.working_directory) -ne $resolvedRoot
    ) {
        throw 'The protected AgentMemory scheduled-task registration does not match this installation.'
    }

    $task = Get-ScheduledTask -TaskPath '\' -TaskName $expectedName -ErrorAction Stop
    $actions = @($task.Actions)
    $triggers = @($task.Triggers | Where-Object { $null -ne $_ })
    $principalSid = Resolve-PrincipalSid -UserId ([string]$task.Principal.UserId)
    $logonType = [string]$task.Principal.LogonType
    $runLevel = [string]$task.Principal.RunLevel
    $executionLimit = [string]$task.Settings.ExecutionTimeLimit
    $executionLimitIsZero = $executionLimit -in @('00:00:00', 'PT0S')
    $restartInterval = [string]$task.Settings.RestartInterval
    if (
        [string]$task.Description -ne $expectedDescription -or
        $actions.Count -ne 1 -or
        [System.IO.Path]::GetFullPath([string]$actions[0].Execute) -ne $hiddenLauncherPath -or
        [string]$actions[0].Arguments -ne $expectedArguments -or
        [System.IO.Path]::GetFullPath([string]$actions[0].WorkingDirectory) -ne $resolvedRoot -or
        $triggers.Count -ne 0 -or
        $principalSid -ne $ownerSid -or
        $logonType -notin @('Interactive', 'InteractiveToken') -or
        $runLevel -notin @('Limited', 'LeastPrivilege') -or
        [string]$task.Settings.MultipleInstances -ne 'IgnoreNew' -or
        -not $executionLimitIsZero -or
        [int]$task.Settings.RestartCount -ne 3 -or
        $restartInterval -notin @('00:01:00', 'PT1M') -or
        -not [bool]$task.Settings.AllowDemandStart
    ) {
        throw 'The installed AgentMemory scheduled task failed its ownership or least-privilege checks.'
    }
    return $task
}

$initialConsumer = Wait-CodexWindowPresent -TimeoutSeconds 10
if (-not $initialConsumer) {
    [Console]::Error.WriteLine('AgentMemory startup was withheld because no trusted visible Windows Codex app window was found.')
    exit 1
}

$startupLock = $null
try {
    $lockDeadline = [DateTime]::UtcNow.AddSeconds(60)
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
    } while (-not $startupLock -and [DateTime]::UtcNow -lt $lockDeadline)
    if (-not $startupLock) {
        throw 'Timed out waiting for the AgentMemory startup file lock.'
    }
    try {
        $consumerRecheck = Get-CodexDesktopState
    }
    catch {
        $consumerRecheck = [pscustomobject]@{ State = 'Unknown' }
    }
    if ($consumerRecheck.State -ne 'Present' -and -not ($consumerRecheck.State -eq 'Unknown' -and (Test-ServiceReady))) {
        throw 'AgentMemory startup was withheld because the trusted Windows Codex app window disappeared or became indeterminate.'
    }
    Assert-OwnedScheduledTaskRegistration
    if (-not (Test-ServiceReady)) {
        $drainDeadline = [DateTime]::UtcNow.AddSeconds(3)
        do {
            $occupiedPorts = @(Get-ReservedConnections)
            if ($occupiedPorts.Count -eq 0 -or (Test-ServiceReady)) {
                break
            }
            Start-Sleep -Milliseconds 250
        } while ([DateTime]::UtcNow -lt $drainDeadline)

        if (-not (Test-ServiceReady)) {
            $occupiedPorts = @(Get-ReservedConnections)
            if ($occupiedPorts.Count -gt 0) {
                throw "AgentMemory is unhealthy while reserved ports are occupied ($($occupiedPorts.LocalPort -join ', ')); manual inspection is required."
            }
            $ownedTask = Get-OwnedScheduledTask
            Start-ScheduledTask -InputObject $ownedTask -ErrorAction Stop
            if (-not (Wait-ServiceReady -TimeoutSeconds 45)) {
                $failureDetail = $null
                $statePath = Join-Path $resolvedRoot 'data\runtime-state.json'
                try {
                    $runtimeState = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
                    if ([string]$runtimeState.status -eq 'failed' -and $runtimeState.error_message) {
                        $failureDetail = [string]$runtimeState.error_message
                    }
                }
                catch {}
                if ($failureDetail) {
                    throw "AgentMemory scheduled task did not start: $failureDetail"
                }
                throw 'AgentMemory scheduled task did not become ready.'
            }
        }
    }
}
catch {
    [Console]::Error.WriteLine("AgentMemory startup failed: $($_.Exception.Message)")
    exit 1
}
finally {
    if ($startupLock) {
        $startupLock.Dispose()
    }
}

if ($ValidateOnly) {
    exit 0
}

& $NodePath $officialCliPath mcp --no-engine --tools all
exit $LASTEXITCODE
