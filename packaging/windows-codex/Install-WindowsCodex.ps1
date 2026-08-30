param(
    [Parameter(Mandatory = $true)][string]$ReleaseRoot,
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [Parameter(Mandatory = $true)][string]$WorkspaceRoot,
    [Parameter(Mandatory = $true)][string]$ProjectRegistry,
    [Parameter(Mandatory = $true)][string]$NodePath,
    [string]$ManagedRequirementsPath = 'C:\ProgramData\OpenAI\Codex\requirements.toml',
    [switch]$Execute
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Utf8NoBom {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Content)
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Get-NormalizedTextSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    $text = [System.IO.File]::ReadAllText($Path).Replace("`r`n", "`n").Replace("`r", "`n")
    $encoding = New-Object System.Text.UTF8Encoding($false)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return (($sha.ComputeHash($encoding.GetBytes($text)) | ForEach-Object { $_.ToString('x2') }) -join '').ToUpperInvariant()
    }
    finally {
        $sha.Dispose()
    }
}

function Set-ObjectProperty {
    param([Parameter(Mandatory = $true)]$Object, [Parameter(Mandatory = $true)][string]$Name, $Value)
    if ($Object.PSObject.Properties.Name -contains $Name) {
        $Object.$Name = $Value
    }
    else {
        $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
    }
}

function ConvertTo-WindowsManifestPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    return $Path.Replace('/', '\')
}

function Test-ExistingPackageMatchesRelease {
    param(
        [Parameter(Mandatory = $true)][string]$PackageRoot,
        [Parameter(Mandatory = $true)]$Manifest
    )

    $prefix = ([string]$Manifest.package_relative_path).TrimEnd('/', '\') + '/'
    $expected = [ordered]@{}
    foreach ($file in $Manifest.immutable_files) {
        $manifestPath = [string]$file.path
        if (-not $manifestPath.StartsWith($prefix, [System.StringComparison]::Ordinal)) { continue }
        $relative = ConvertTo-WindowsManifestPath -Path $manifestPath.Substring($prefix.Length)
        $expected[$relative] = [string]$file.sha256
    }

    $actualFiles = @(Get-ChildItem -Recurse -File -LiteralPath $PackageRoot)
    if ($actualFiles.Count -ne $expected.Count) { return $false }
    foreach ($file in $actualFiles) {
        $relative = $file.FullName.Substring($PackageRoot.Length).TrimStart('\')
        if (-not $expected.Contains($relative)) { return $false }
        if ((Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash -ne $expected[$relative]) { return $false }
    }
    return $true
}

function Copy-FileWhenChanged {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    if (Test-Path -LiteralPath $Destination -PathType Leaf) {
        $sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Source).Hash
        $destinationHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Destination).Hash
        if ($sourceHash -eq $destinationHash) { return }
    }
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Move-PackageJunctionTargets {
    param(
        [Parameter(Mandatory = $true)][string]$SourceRoot,
        [Parameter(Mandatory = $true)][string]$DestinationRoot
    )

    $source = [System.IO.Path]::GetFullPath($SourceRoot).TrimEnd('\')
    $destination = [System.IO.Path]::GetFullPath($DestinationRoot).TrimEnd('\')
    $sourcePrefix = $source + [System.IO.Path]::DirectorySeparatorChar
    $destinationPrefix = $destination + [System.IO.Path]::DirectorySeparatorChar
    $junctions = @(
        Get-ChildItem -LiteralPath $destination -Recurse -Force -Attributes ReparsePoint |
            Where-Object { $_.LinkType -eq 'Junction' } |
            Sort-Object { $_.FullName.Length } -Descending
    )

    foreach ($junction in $junctions) {
        $targets = @($junction.Target)
        if ($targets.Count -ne 1) {
            throw "Package junction has an unexpected target count: $($junction.FullName)"
        }
        $sourceTarget = [System.IO.Path]::GetFullPath([string]$targets[0])
        if ($sourceTarget -eq $destination -or $sourceTarget.StartsWith($destinationPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            if (-not (Test-Path -LiteralPath $sourceTarget -PathType Container)) {
                throw "Relocated package junction target is missing: $sourceTarget"
            }
            continue
        }
        if ($sourceTarget -ne $source -and -not $sourceTarget.StartsWith($sourcePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Package junction target escapes the release package: $($junction.FullName)"
        }
        $relativeTarget = [System.IO.Path]::GetRelativePath($source, $sourceTarget)
        $destinationTarget = [System.IO.Path]::GetFullPath((Join-Path $destination $relativeTarget))
        if ($destinationTarget -ne $destination -and -not $destinationTarget.StartsWith($destinationPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Relocated package junction target escapes the installed package: $($junction.FullName)"
        }
        if (-not (Test-Path -LiteralPath $destinationTarget -PathType Container)) {
            throw "Relocated package junction target is missing: $destinationTarget"
        }

        [System.IO.Directory]::Delete($junction.FullName)
        [void](New-Item -ItemType Junction -Path $junction.FullName -Target $destinationTarget)
    }
}

function Get-OwnedTaskRegistrations {
    param([Parameter(Mandatory = $true)][string]$Root)

    $registrations = @()
    foreach ($name in @('task-registration.json', 'watchdog-task-registration.json')) {
        $path = Join-Path $Root "config\$name"
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
        $registration = Get-Content -Raw -LiteralPath $path | ConvertFrom-Json
        $registrations += [pscustomobject]@{
            Name = $name
            TaskPath = [string]$registration.task_path
            TaskName = [string]$registration.task_name
        }
    }
    return @($registrations)
}

function Stop-OwnedRuntimeForCutover {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][object[]]$Registrations
    )

    Import-Module ScheduledTasks -ErrorAction Stop
    $watchStopScript = Join-Path $Root 'scripts\agentmemory-watch-stop.ps1'
    if (Test-Path -LiteralPath $watchStopScript -PathType Leaf) {
        try { & $watchStopScript -Root $Root -TimeoutSeconds 15 } catch {
            $watchdog = @($Registrations | Where-Object { $_.Name -eq 'watchdog-task-registration.json' })
            if ($watchdog.Count -eq 0) { throw }
        }
    }
    foreach ($registration in @($Registrations | Where-Object { $_.Name -eq 'watchdog-task-registration.json' })) {
        Stop-ScheduledTask -TaskPath $registration.TaskPath -TaskName $registration.TaskName -ErrorAction SilentlyContinue
    }

    $stopScript = Join-Path $Root 'scripts\agentmemory-stop.ps1'
    $stopFailure = $null
    if (Test-Path -LiteralPath $stopScript -PathType Leaf) {
        try { & $stopScript -Root $Root -TimeoutSeconds 30 } catch { $stopFailure = $_ }
    }
    foreach ($registration in @($Registrations | Where-Object { $_.Name -eq 'task-registration.json' })) {
        Stop-ScheduledTask -TaskPath $registration.TaskPath -TaskName $registration.TaskName -ErrorAction SilentlyContinue
    }
    if ($stopFailure) {
        $runtimeStatePath = Join-Path $Root 'data\runtime-state.json'
        if (-not (Test-Path -LiteralPath $runtimeStatePath -PathType Leaf)) { throw $stopFailure }
        $runtimeState = Get-Content -Raw -LiteralPath $runtimeStatePath | ConvertFrom-Json
        $ownedPids = @(
            [int]$runtimeState.daemon.pid,
            [int]$runtimeState.engine.pid,
            [int]$runtimeState.worker.pid
        ) | Where-Object { $_ -gt 0 } | Sort-Object -Unique
        if ($ownedPids.Count -eq 0) { throw $stopFailure }

        # Stop-ScheduledTask closes the registered hidden launcher's Job Object.
        # Continue only after every process recorded for that owned run is gone.
        $deadline = [DateTime]::UtcNow.AddSeconds(15)
        do {
            $liveOwnedPids = @($ownedPids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
            if ($liveOwnedPids.Count -eq 0) { break }
            Start-Sleep -Milliseconds 250
        } while ([DateTime]::UtcNow -lt $deadline)
        if ($liveOwnedPids.Count -gt 0) { throw $stopFailure }
    }
}

function Start-OwnedTasks {
    param([Parameter(Mandatory = $true)][object[]]$Registrations)

    Import-Module ScheduledTasks -ErrorAction Stop
    foreach ($registration in $Registrations) {
        Start-ScheduledTask -TaskPath $registration.TaskPath -TaskName $registration.TaskName -ErrorAction Stop
    }
}

function ConvertTo-TomlBasicString {
    param([Parameter(Mandatory = $true)][string]$Value)
    return '"' + $Value.Replace('\', '\\').Replace('"', '\"') + '"'
}

function New-HookArtifacts {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)]$Spec
    )
    $powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $hookScript = Join-Path $Root 'scripts\agentmemory-hook.ps1'
    $command = '"' + $powerShell + '" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $hookScript + '" -ScriptName "codex-turn.mjs"'
    $commandWindows = "& '$powerShell' -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File '$hookScript' -ScriptName 'codex-turn.mjs'"

    $hookMap = [ordered]@{}
    $toml = New-Object System.Collections.Generic.List[string]
    $toml.Add('[features]')
    $toml.Add('hooks = true')
    $toml.Add('')
    $toml.Add('[hooks]')
    $toml.Add('windows_managed_dir = ' + (ConvertTo-TomlBasicString (Join-Path $Root 'scripts')))
    foreach ($event in $Spec.events) {
        $name = [string]$event.name
        $entry = [ordered]@{
            type = 'command'
            command = $command
            commandWindows = $commandWindows
            timeout = [int]$event.timeout_seconds
        }
        if ($event.PSObject.Properties.Name -contains 'additional_context_limit') {
            $entry.additionalContextLimit = [int]$event.additional_context_limit
        }
        $hookMap[$name] = @([ordered]@{ hooks = @($entry) })

        $toml.Add('')
        $toml.Add("[[hooks.$name]]")
        $toml.Add('')
        $toml.Add("[[hooks.$name.hooks]]")
        $toml.Add('type = "command"')
        $toml.Add('command = ' + (ConvertTo-TomlBasicString $command))
        $toml.Add('command_windows = ' + (ConvertTo-TomlBasicString $commandWindows))
        $toml.Add("timeout = $([int]$event.timeout_seconds)")
        if ($event.PSObject.Properties.Name -contains 'additional_context_limit') {
            $toml.Add("additionalContextLimit = $([int]$event.additional_context_limit)")
        }
    }
    return [pscustomobject]@{
        Toml = (($toml -join [Environment]::NewLine) + [Environment]::NewLine)
        Json = ([ordered]@{ description = [string]$Spec.description; hooks = $hookMap } | ConvertTo-Json -Depth 10)
    }
}

$release = [System.IO.Path]::GetFullPath($ReleaseRoot)
$root = [System.IO.Path]::GetFullPath($InstallRoot)
$workspace = [System.IO.Path]::GetFullPath($WorkspaceRoot)
$registry = [System.IO.Path]::GetFullPath($ProjectRegistry)
$node = [System.IO.Path]::GetFullPath($NodePath)
$managedRequirements = [System.IO.Path]::GetFullPath($ManagedRequirementsPath)
$releaseManifestPath = Join-Path $release 'release-manifest.json'
$payload = Join-Path $release 'payload'
$ownerPath = Join-Path $root '.agentmemory-install-owner.json'
$installManifestPath = Join-Path $root 'config\install-manifest.json'

foreach ($required in @($releaseManifestPath, $payload, $ownerPath, $installManifestPath, $registry, $node)) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Required install input is missing: $required" }
}
if ($root.TrimEnd('\') -eq [System.IO.Path]::GetPathRoot($root).TrimEnd('\')) {
    throw 'InstallRoot cannot be a drive root.'
}

$releaseManifest = Get-Content -Raw -LiteralPath $releaseManifestPath | ConvertFrom-Json
if ([string]$releaseManifest.product_id -ne 'agentmemory-codex-windows') {
    throw 'Release manifest product_id is not agentmemory-codex-windows.'
}
if ([string]$releaseManifest.downstream_version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$') {
    throw 'Release manifest downstream_version is invalid.'
}
foreach ($file in $releaseManifest.release_files) {
    $candidate = [System.IO.Path]::GetFullPath((Join-Path $release ([string]$file.path)))
    if (-not $candidate.StartsWith($release + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Release manifest path escapes release root: $($file.path)"
    }
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw "Release file is missing: $candidate" }
    $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $candidate).Hash
    if ($actualHash -ne [string]$file.sha256) { throw "Release file hash mismatch: $($file.path)" }
}
foreach ($file in $releaseManifest.immutable_files) {
    $candidate = [System.IO.Path]::GetFullPath((Join-Path $payload ([string]$file.path)))
    if (-not $candidate.StartsWith($payload + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Release manifest path escapes payload: $($file.path)"
    }
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw "Release payload file is missing: $candidate" }
    $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $candidate).Hash
    if ($actualHash -ne [string]$file.sha256) { throw "Release payload hash mismatch: $($file.path)" }
}

$owner = Get-Content -Raw -LiteralPath $ownerPath | ConvertFrom-Json
$installed = Get-Content -Raw -LiteralPath $installManifestPath | ConvertFrom-Json
if (-not $owner.install_nonce -or [string]$owner.install_nonce -ne [string]$installed.install_nonce) {
    throw 'The install owner and manifest nonce do not match.'
}
if ([System.IO.Path]::GetFullPath([string]$installed.install_root) -ne $root) {
    throw 'The existing install manifest does not own InstallRoot.'
}

$existingManagedCopy = Join-Path $root 'config\managed-requirements.toml'
if (Test-Path -LiteralPath $managedRequirements -PathType Leaf) {
    if (-not (Test-Path -LiteralPath $existingManagedCopy -PathType Leaf)) {
        throw 'Managed requirements exist but the owned predecessor copy is missing.'
    }
    $managedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $managedRequirements).Hash
    $ownedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $existingManagedCopy).Hash
    if ($managedHash -ne $ownedHash) {
        throw 'Managed requirements differ from the owned predecessor; refusing to overwrite unrelated Codex policy.'
    }
}

$newPackageRoot = [System.IO.Path]::GetFullPath((Join-Path $root ([string]$releaseManifest.package_relative_path)))
$reuseExistingPackage = $false
$replaceExistingPackage = $false
if (Test-Path -LiteralPath $newPackageRoot) {
    if (Test-ExistingPackageMatchesRelease -PackageRoot $newPackageRoot -Manifest $releaseManifest) {
        $reuseExistingPackage = $true
    }
    else {
        $replaceExistingPackage = $true
    }
}
$taskRegistrations = @(Get-OwnedTaskRegistrations -Root $root)
$hiddenLauncherRelative = 'bin\agentmemory-hidden-launcher.exe'
$hiddenLauncherPath = Join-Path $root $hiddenLauncherRelative
$hiddenLauncherSourcePath = Join-Path $root 'src\AgentMemoryHiddenLauncher.cs'
$expectedLauncherSourceHash = [string]$releaseManifest.adapter_source_hashes.hidden_launcher
$expectedNormalizedLauncherSourceHash = [string]$releaseManifest.adapter_source_hashes.hidden_launcher_normalized
$installedLauncherHash = [string]$installed.source_hashes.$hiddenLauncherRelative
$preserveHiddenLauncher = (
    $expectedLauncherSourceHash -match '^[A-Fa-f0-9]{64}$' -and
    $expectedNormalizedLauncherSourceHash -match '^[A-Fa-f0-9]{64}$' -and
    $installedLauncherHash -match '^[A-Fa-f0-9]{64}$' -and
    (Test-Path -LiteralPath $hiddenLauncherSourcePath -PathType Leaf) -and
    (Test-Path -LiteralPath $hiddenLauncherPath -PathType Leaf) -and
    (Get-NormalizedTextSha256 -Path $hiddenLauncherSourcePath) -eq $expectedNormalizedLauncherSourceHash.ToUpperInvariant() -and
    (Get-FileHash -Algorithm SHA256 -LiteralPath $hiddenLauncherPath).Hash -eq $installedLauncherHash.ToUpperInvariant()
)

$summary = [ordered]@{
    ready = $true
    execute = [bool]$Execute
    install_root = $root
    current_downstream_version = if ($installed.PSObject.Properties.Name -contains 'downstream_version') { [string]$installed.downstream_version } else { $null }
    target_downstream_version = [string]$releaseManifest.downstream_version
    current_version = [string]$installed.agentmemory_version
    target_version = [string]$releaseManifest.agentmemory_version
    target_package = $newPackageRoot
    reused_staged_package = $reuseExistingPackage
    replace_existing_package = $replaceExistingPackage
    preserve_existing_hidden_launcher = $preserveHiddenLauncher
    canonical_data = (Join-Path $root 'data')
    data_action = 'preserve'
}
if (-not $Execute) {
    $summary | ConvertTo-Json
    return
}

$backupId = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
$backupRoot = Join-Path $root "backups\releases\$backupId"
$replacedPackageBackupRoot = Join-Path $backupRoot 'replaced-versioned-package'
[void][System.IO.Directory]::CreateDirectory($backupRoot)
$copyRoots = @('scripts', 'bin', 'src')
foreach ($relative in $copyRoots) {
    $current = Join-Path $root $relative
    if (Test-Path -LiteralPath $current) {
        Copy-Item -Recurse -LiteralPath $current -Destination (Join-Path $backupRoot $relative)
    }
}
foreach ($relative in @('config\iii-config.yaml', 'config\hook-spec.json', 'config\third-party-inputs.json', 'config\upstream-source.json', 'config\mcp-launcher-environment.json', 'config\codex-workspace.json', 'config\codex-hooks.json', 'config\managed-requirements.toml', 'config\install-manifest.json', 'config\install-state.json')) {
    $current = Join-Path $root $relative
    if (Test-Path -LiteralPath $current -PathType Leaf) {
        $backup = Join-Path $backupRoot $relative
        [void][System.IO.Directory]::CreateDirectory((Split-Path -Parent $backup))
        Copy-Item -LiteralPath $current -Destination $backup
    }
}
if (Test-Path -LiteralPath $managedRequirements -PathType Leaf) {
    Copy-Item -LiteralPath $managedRequirements -Destination (Join-Path $backupRoot 'requirements.toml')
}

try {
    Stop-OwnedRuntimeForCutover -Root $root -Registrations $taskRegistrations
    $runtimeStatePath = Join-Path $root 'data\runtime-state.json'
    $previousRunId = $null
    try {
        $previousRuntimeState = Get-Content -Raw -LiteralPath $runtimeStatePath | ConvertFrom-Json
        $previousRunId = [string]$previousRuntimeState.run_id
    }
    catch {}

    $packageSource = [System.IO.Path]::GetFullPath((Join-Path $payload ([string]$releaseManifest.package_relative_path)))
    if ($replaceExistingPackage) {
        if (-not (Test-Path -LiteralPath $newPackageRoot -PathType Container)) {
            throw "The package selected for replacement disappeared before cutover: $newPackageRoot"
        }
        if (Test-ExistingPackageMatchesRelease -PackageRoot $newPackageRoot -Manifest $releaseManifest) {
            throw "The package selected for replacement changed before cutover: $newPackageRoot"
        }
        Move-Item -LiteralPath $newPackageRoot -Destination $replacedPackageBackupRoot
    }
    if (-not $reuseExistingPackage) {
        [void][System.IO.Directory]::CreateDirectory((Split-Path -Parent $newPackageRoot))
        $robocopy = Join-Path $env:SystemRoot 'System32\robocopy.exe'
        # pnpm deploy uses package-internal junctions. Preserve their compact
        # topology, then relocate their absolute targets into the install root.
        & $robocopy $packageSource $newPackageRoot /E /SL /SJ /COPY:DAT /DCOPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS /NP
        $copyExit = $LASTEXITCODE
        if ($copyExit -ge 8) { throw "Versioned package copy failed with robocopy exit code $copyExit." }
        Move-PackageJunctionTargets -SourceRoot $packageSource -DestinationRoot $newPackageRoot
        if (-not (Test-ExistingPackageMatchesRelease -PackageRoot $newPackageRoot -Manifest $releaseManifest)) {
            throw 'The copied versioned package does not exactly match the release manifest.'
        }
    }
    Copy-Item -Path (Join-Path $payload 'scripts\*') -Destination (Join-Path $root 'scripts') -Recurse -Force
    [void][System.IO.Directory]::CreateDirectory((Join-Path $root 'src'))
    Copy-Item -LiteralPath (Join-Path $payload 'src\AgentMemoryHiddenLauncher.cs') -Destination $hiddenLauncherSourcePath -Force
    foreach ($file in @(Get-ChildItem -File -LiteralPath (Join-Path $payload 'bin'))) {
        if ($preserveHiddenLauncher -and $file.Name -eq 'agentmemory-hidden-launcher.exe') { continue }
        Copy-FileWhenChanged -Source $file.FullName -Destination (Join-Path $root "bin\$($file.Name)")
    }
    foreach ($name in @('iii-config.yaml', 'hook-spec.json', 'third-party-inputs.json', 'upstream-source.json', 'mcp-launcher-environment.json')) {
        Copy-Item -LiteralPath (Join-Path $payload "config\$name") -Destination (Join-Path $root "config\$name") -Force
    }

    $workspaceConfig = [ordered]@{ schema_version = 1; workspace_root = $workspace; project_registry = $registry }
    Write-Utf8NoBom -Path (Join-Path $root 'config\codex-workspace.json') -Content ($workspaceConfig | ConvertTo-Json)
    $hookSpec = Get-Content -Raw -LiteralPath (Join-Path $root 'config\hook-spec.json') | ConvertFrom-Json
    $hookArtifacts = New-HookArtifacts -Root $root -Spec $hookSpec
    Write-Utf8NoBom -Path (Join-Path $root 'config\managed-requirements.toml') -Content $hookArtifacts.Toml
    Write-Utf8NoBom -Path (Join-Path $root 'config\codex-hooks.json') -Content $hookArtifacts.Json
    Write-Utf8NoBom -Path $managedRequirements -Content $hookArtifacts.Toml

    Set-ObjectProperty -Object $installed -Name 'product' -Value ([string]$releaseManifest.product)
    Set-ObjectProperty -Object $installed -Name 'product_id' -Value ([string]$releaseManifest.product_id)
    Set-ObjectProperty -Object $installed -Name 'downstream_version' -Value ([string]$releaseManifest.downstream_version)
    Set-ObjectProperty -Object $installed -Name 'agentmemory_version' -Value ([string]$releaseManifest.agentmemory_version)
    Set-ObjectProperty -Object $installed -Name 'release_revision' -Value ([string]$releaseManifest.release_revision)
    Set-ObjectProperty -Object $installed -Name 'package_relative_path' -Value ([string]$releaseManifest.package_relative_path)
    Set-ObjectProperty -Object $installed -Name 'node_path' -Value $node
    Set-ObjectProperty -Object $installed -Name 'verified_at_utc' -Value ([DateTime]::UtcNow.ToString('o'))
    Set-ObjectProperty -Object $installed -Name 'release_manifest_sha256' -Value ((Get-FileHash -Algorithm SHA256 -LiteralPath $releaseManifestPath).Hash)
    Set-ObjectProperty -Object $installed -Name 'preserved_existing_hidden_launcher' -Value $preserveHiddenLauncher
    if ($null -ne $installed.security) {
        Set-ObjectProperty -Object $installed.security -Name 'external_llm' -Value 'loopback-only local Qwen enabled for typed graph extraction; remote fallback disabled'
        Set-ObjectProperty -Object $installed.security -Name 'automatic_graph_extraction' -Value $true
        Set-ObjectProperty -Object $installed.security -Name 'graph_extraction_mode' -Value 'keyless structural extraction plus exact-provenance local-Qwen typed extraction'
        Set-ObjectProperty -Object $installed.security -Name 'mcp_tool_approval' -Value 'Codex UI approval remains approve for the single complete AgentMemory MCP registration'
        Set-ObjectProperty -Object $installed.security -Name 'mcp_transport' -Value 'shared Streamable HTTP on http://127.0.0.1:3114/mcp; hidden stdio launcher retained for compatibility'
        Set-ObjectProperty -Object $installed.security -Name 'mcp_authentication' -Value 'local OAuth dynamic client registration with S256 PKCE and explicit consent; bearer is domain-separated from the DPAPI backend secret'
        Set-ObjectProperty -Object $installed.security -Name 'mcp_fail_closed' -Value $true
    }
    $sourceHashes = [ordered]@{}
    foreach ($file in $releaseManifest.immutable_files) {
        $sourceHashes[(ConvertTo-WindowsManifestPath -Path ([string]$file.path))] = [string]$file.sha256
    }
    if ($preserveHiddenLauncher) {
        $sourceHashes[$hiddenLauncherRelative] = (Get-FileHash -Algorithm SHA256 -LiteralPath $hiddenLauncherPath).Hash
    }
    Set-ObjectProperty -Object $installed -Name 'source_hashes' -Value $sourceHashes
    Write-Utf8NoBom -Path $installManifestPath -Content ($installed | ConvertTo-Json -Depth 12)
    $legacyInstallStatePath = Join-Path $root 'config\install-state.json'
    if (Test-Path -LiteralPath $legacyInstallStatePath -PathType Leaf) {
        Remove-Item -LiteralPath $legacyInstallStatePath -Force
    }

    Start-OwnedTasks -Registrations $taskRegistrations

    # The scheduled daemon runs in the interactive user's DPAPI context and
    # writes active state only after authenticated loopback health succeeds.
    # The installer may run under an elevated/sandbox token that cannot decrypt
    # that CurrentUser secret, so consume the daemon's fresh readiness result.
    $deadline = [DateTime]::UtcNow.AddSeconds(75)
    $healthy = $false
    do {
        Start-Sleep -Milliseconds 500
        try {
            $runtimeState = Get-Content -Raw -LiteralPath $runtimeStatePath | ConvertFrom-Json
            $engineProcess = Get-Process -Id ([int]$runtimeState.engine.pid) -ErrorAction Stop
            $workerProcess = Get-Process -Id ([int]$runtimeState.worker.pid) -ErrorAction Stop
            $healthy = (
                [string]$runtimeState.status -eq 'active' -and
                [System.IO.Path]::GetFullPath([string]$runtimeState.root) -eq $root -and
                -not [string]::IsNullOrWhiteSpace([string]$runtimeState.run_id) -and
                [string]$runtimeState.run_id -ne $previousRunId -and
                -not $engineProcess.HasExited -and
                -not $workerProcess.HasExited
            )
        }
        catch { $healthy = $false }
    } while (-not $healthy -and [DateTime]::UtcNow -lt $deadline)
    if (-not $healthy) { throw 'AgentMemory did not become healthy after cutover.' }

    $summary.backup_root = $backupRoot
    if ($replaceExistingPackage) {
        $summary.replaced_package_backup = $replacedPackageBackupRoot
    }
    $summary.healthy = $true
    $summary | ConvertTo-Json
}
catch {
    $failure = $_
    try { Stop-OwnedRuntimeForCutover -Root $root -Registrations $taskRegistrations } catch {}
    $scriptsBackup = Join-Path $backupRoot 'scripts'
    if (Test-Path -LiteralPath $scriptsBackup) {
        Copy-Item -Path (Join-Path $scriptsBackup '*') -Destination (Join-Path $root 'scripts') -Recurse -Force
    }
    $binBackup = Join-Path $backupRoot 'bin'
    if (Test-Path -LiteralPath $binBackup) {
        foreach ($file in @(Get-ChildItem -File -LiteralPath $binBackup)) {
            if ($preserveHiddenLauncher -and $file.Name -eq 'agentmemory-hidden-launcher.exe') { continue }
            Copy-FileWhenChanged -Source $file.FullName -Destination (Join-Path $root "bin\$($file.Name)")
        }
    }
    $srcBackup = Join-Path $backupRoot 'src'
    if (Test-Path -LiteralPath $srcBackup) {
        Copy-Item -Path (Join-Path $srcBackup '*') -Destination (Join-Path $root 'src') -Recurse -Force
    }
    elseif (Test-Path -LiteralPath $hiddenLauncherSourcePath -PathType Leaf) {
        Remove-Item -LiteralPath $hiddenLauncherSourcePath -Force
    }
    foreach ($relative in @('config\iii-config.yaml', 'config\hook-spec.json', 'config\third-party-inputs.json', 'config\upstream-source.json', 'config\mcp-launcher-environment.json', 'config\codex-workspace.json', 'config\codex-hooks.json', 'config\managed-requirements.toml', 'config\install-manifest.json', 'config\install-state.json')) {
        $backup = Join-Path $backupRoot $relative
        if (Test-Path -LiteralPath $backup -PathType Leaf) {
            Copy-Item -LiteralPath $backup -Destination (Join-Path $root $relative) -Force
        }
        elseif (Test-Path -LiteralPath (Join-Path $root $relative) -PathType Leaf) {
            Remove-Item -LiteralPath (Join-Path $root $relative) -Force
        }
    }
    $requirementsBackup = Join-Path $backupRoot 'requirements.toml'
    if (Test-Path -LiteralPath $requirementsBackup -PathType Leaf) {
        Copy-Item -LiteralPath $requirementsBackup -Destination $managedRequirements -Force
    }
    if ($replaceExistingPackage -and (Test-Path -LiteralPath $replacedPackageBackupRoot -PathType Container)) {
        if (Test-Path -LiteralPath $newPackageRoot) {
            Remove-Item -LiteralPath $newPackageRoot -Recurse -Force
        }
        [void][System.IO.Directory]::CreateDirectory((Split-Path -Parent $newPackageRoot))
        Move-Item -LiteralPath $replacedPackageBackupRoot -Destination $newPackageRoot
    }
    try { Start-OwnedTasks -Registrations $taskRegistrations } catch {}
    throw "AgentMemory cutover failed; owned predecessor files were restored from $backupRoot. $($failure.Exception.Message)"
}
