function Assert-LocalInstallPath {
    param([string]$Path)
    if ($Path.StartsWith('\\') -or $Path.Contains("'") -or $Path -match '[\x00-\x1f"`$]' -or $Path -notmatch '^[A-Za-z]:\\') {
        throw 'Installation paths must be local absolute paths without shell metacharacters.'
    }
    $cursor = $Path
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -Force -LiteralPath $cursor
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Installation path traverses a reparse point: $cursor" }
        }
        $parent = Split-Path -Parent $cursor
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
}

function New-InstallTaskRegistration {
    param([string]$Root, [string]$Sid, [string]$Nonce, [switch]$Watchdog)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $suffix = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Sid))).Replace('-', '').Substring(0, 12).ToLowerInvariant() }
    finally { $sha.Dispose() }
    $kind = if ($Watchdog) { 'Watchdog' } else { 'Daemon' }
    $label = if ($Watchdog) { 'app watchdog' } else { 'daemon' }
    $registration = [ordered]@{
        schema_version = 1; task_path = '\'; task_name = "AgentMemoryCodex-$kind-$suffix"
        owner_sid = $Sid; install_nonce = $Nonce
        description = "OpenAI Codex AgentMemory $label; install_nonce=$Nonce"
        execute = (Join-Path $Root 'bin\agentmemory-hidden-launcher.exe')
        arguments = $(if ($Watchdog) { 'watch' } else { 'task' }); working_directory = $Root
    }
    if ($Watchdog) { $registration.trigger_type = 'user_logon'; $registration.trigger_user_sid = $Sid }
    return [pscustomobject]$registration
}

function Get-InstallPortConflicts {
    return @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object { $_.Port -in @(3111, 3112, 3113, 3114, 49134) })
}

function Invoke-FreshInstallation {
    param([switch]$Activate, [switch]$Execute)
    foreach ($path in @($root, $workspace, $registry, $node)) { Assert-LocalInstallPath $path }
    $nodeVersion = (& $node --version).Trim()
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 24) { throw 'Node.js 24 or newer is required.' }
    $registryDocument = Get-Content -Raw -LiteralPath $registry | ConvertFrom-Json
    if ($null -eq $registryDocument.PSObject.Properties['projects'] -or $registryDocument.projects -isnot [Array]) { throw 'ProjectRegistry must contain a projects array.' }
    if (-not (Test-Path -LiteralPath $workspace -PathType Container) -or
        -not (Test-Path -LiteralPath $registry -PathType Leaf) -or
        -not $registry.StartsWith($workspace.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'ProjectRegistry must be an existing file inside WorkspaceRoot.'
    }
    if ($root -eq $workspace -or $workspace.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $release.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $root.StartsWith($release + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'InstallRoot must be separate from the workspace and release input.' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $sid = $identity.User.Value
    if ($sid -in @('S-1-5-18', 'S-1-5-19', 'S-1-5-20')) { throw 'Run installation as the Windows user who will use Codex.' }
    $nonce = [Guid]::NewGuid().ToString('N')
    if ($Activate) {
        $owner = Get-Content -Raw -LiteralPath $ownerPath | ConvertFrom-Json
        $installed = Get-Content -Raw -LiteralPath $installManifestPath | ConvertFrom-Json
        if ([string]$installed.installation_status -ne 'prepared' -or [string]$installed.owner_sid -ne $sid -or
            [string]$installed.install_root -ne $root -or [string]$owner.install_nonce -ne [string]$installed.install_nonce -or
            [string]$installed.release_manifest_sha256 -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $releaseManifestPath).Hash) {
            throw 'Activation requires this user''s prepared installation of this exact release.'
        }
        $nonce = [string]$installed.install_nonce
        $workspaceConfig = Get-Content -Raw -LiteralPath (Join-Path $root 'config\codex-workspace.json') | ConvertFrom-Json
        if ([string]$workspaceConfig.workspace_root -ne $workspace -or [string]$workspaceConfig.project_registry -ne $registry -or
            [string]$installed.node_path -ne $node) { throw 'Prepared installation inputs have changed.' }
        foreach ($file in $releaseManifest.immutable_files) {
            $target = Join-Path $root ([string]$file.path)
            Assert-LocalInstallPath $target
            if ((Get-FileHash -Algorithm SHA256 -LiteralPath $target).Hash -ne [string]$file.sha256) { throw "Prepared file hash mismatch: $($file.path)" }
        }
        Add-Type -AssemblyName System.Security
        $plain = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes((Join-Path $root 'config\secret.dpapi')),
            [Text.Encoding]::UTF8.GetBytes('Codex.AgentMemory.v1'), [Security.Cryptography.DataProtectionScope]::CurrentUser)
        try { if ([Text.Encoding]::UTF8.GetString($plain) -notmatch '^[A-Za-z0-9+/]{43}=$') { throw 'Invalid installation secret.' } }
        finally { [Array]::Clear($plain, 0, $plain.Length) }
    } elseif (Test-Path -LiteralPath $root) {
        if (-not (Test-Path -LiteralPath $root -PathType Container) -or @(Get-ChildItem -Force -LiteralPath $root).Count -ne 0) {
            throw 'Fresh preparation requires an absent or empty InstallRoot; existing content is never replaced.'
        }
    }
    $daemon = New-InstallTaskRegistration -Root $root -Sid $sid -Nonce $nonce
    $watchdog = New-InstallTaskRegistration -Root $root -Sid $sid -Nonce $nonce -Watchdog
    $hookSpec = Get-Content -Raw -LiteralPath (Join-Path $payload 'config\hook-spec.json') | ConvertFrom-Json
    $hooks = New-HookArtifacts -Root $root -Spec $hookSpec
    if ($Activate) {
        Assert-LocalInstallPath $managedRequirements
        if (Test-Path -LiteralPath $managedRequirements) { throw 'Managed Codex requirements already exist; activation will not replace another policy.' }
        Import-Module ScheduledTasks -ErrorAction Stop
        foreach ($registration in @($daemon, $watchdog)) {
            if (Get-ScheduledTask -TaskPath '\' -TaskName $registration.task_name -ErrorAction SilentlyContinue) { throw "Scheduled task already exists: $($registration.task_name)" }
        }
        $occupied = @(Get-InstallPortConflicts)
        if ($occupied.Count -gt 0) { throw 'An AgentMemory port is already occupied; activation was not started.' }
    }
    $summary = [ordered]@{ ready = $true; execute = [bool]$Execute; operation = $(if ($Activate) { 'activate-prepared' } else { 'prepare-fresh' })
        install_root = $root; target_downstream_version = [string]$releaseManifest.downstream_version
        data_action = 'create-empty-only'; service_started = $false; codex_mcp_configuration = 'manual OAuth connection'
        managed_requirements = $(if ($Activate) { $managedRequirements } else { $null }) }
    if (-not $Execute) { $summary | ConvertTo-Json; return }
    if (-not $Activate) {
        [void][IO.Directory]::CreateDirectory($root)
        $ownerStream = [IO.File]::Open($ownerPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            if (@(Get-ChildItem -Force -LiteralPath $root | Where-Object { $_.FullName -ne $ownerPath }).Count -ne 0) { throw 'InstallRoot changed during preparation.' }
            $ownerBytes = [Text.Encoding]::UTF8.GetBytes(([ordered]@{ schema_version = 1; install_nonce = $nonce; intended_root = $root } | ConvertTo-Json))
            $ownerStream.Write($ownerBytes, 0, $ownerBytes.Length)
        } finally { $ownerStream.Dispose() }
        $acl = New-Object Security.AccessControl.DirectorySecurity
        $acl.SetAccessRuleProtection($true, $false)
        foreach ($allowedSid in @($sid, 'S-1-5-18', 'S-1-5-32-544')) {
            $rule = New-Object Security.AccessControl.FileSystemAccessRule(
                (New-Object Security.Principal.SecurityIdentifier($allowedSid)), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
            $acl.AddAccessRule($rule)
        }
        Set-Acl -LiteralPath $root -AclObject $acl
        foreach ($directory in @('config', 'data', 'home', 'logs', 'backups')) { [void][IO.Directory]::CreateDirectory((Join-Path $root $directory)) }
        foreach ($file in $releaseManifest.immutable_files) {
            $target = Join-Path $root ([string]$file.path)
            [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
            [IO.File]::Copy((Join-Path $payload ([string]$file.path)), $target, $false)
            if ((Get-FileHash -Algorithm SHA256 -LiteralPath $target).Hash -ne [string]$file.sha256) { throw "Copied file hash mismatch: $($file.path)" }
        }
        Add-Type -AssemblyName System.Security
        $random = New-Object byte[] 32
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        $plain = $null
        try {
            $rng.GetBytes($random)
            $plain = [Text.Encoding]::UTF8.GetBytes([Convert]::ToBase64String($random))
            $protected = [Security.Cryptography.ProtectedData]::Protect($plain, [Text.Encoding]::UTF8.GetBytes('Codex.AgentMemory.v1'), [Security.Cryptography.DataProtectionScope]::CurrentUser)
            [IO.File]::WriteAllBytes((Join-Path $root 'config\secret.dpapi'), $protected)
        } finally { $rng.Dispose(); [Array]::Clear($random, 0, $random.Length); if ($plain) { [Array]::Clear($plain, 0, $plain.Length) } }
        Write-Utf8NoBom (Join-Path $root 'config\codex-workspace.json') ([ordered]@{ schema_version = 1; workspace_root = $workspace; project_registry = $registry } | ConvertTo-Json)
        Write-Utf8NoBom (Join-Path $root 'config\managed-requirements.toml') $hooks.Toml
        Write-Utf8NoBom (Join-Path $root 'config\codex-hooks.json') $hooks.Json
        Write-Utf8NoBom (Join-Path $root 'config\task-registration.json') ($daemon | ConvertTo-Json)
        Write-Utf8NoBom (Join-Path $root 'config\watchdog-task-registration.json') ($watchdog | ConvertTo-Json)
        $hashes = [ordered]@{}
        foreach ($file in $releaseManifest.immutable_files) { $hashes[([string]$file.path).Replace('/', '\')] = [string]$file.sha256 }
        $installed = [ordered]@{ schema_version = 1; installation_status = 'prepared'; install_nonce = $nonce; owner_sid = $sid; install_root = $root
            product = [string]$releaseManifest.product; product_id = [string]$releaseManifest.product_id
            downstream_version = [string]$releaseManifest.downstream_version; agentmemory_version = [string]$releaseManifest.agentmemory_version
            release_revision = [string]$releaseManifest.release_revision; package_relative_path = [string]$releaseManifest.package_relative_path
            node_path = $node; release_manifest_sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $releaseManifestPath).Hash
            source_hashes = $hashes; security = @{} }
        Write-Utf8NoBom $installManifestPath ($installed | ConvertTo-Json -Depth 12)
        $summary.prepared = $true
        $summary.next_step = 'Repeat the package command with --activate-prepared (dry-run), then add --execute to register tasks and hooks.'
    } else {
        $created = @()
        $createdRequirements = $false
        try {
            $principal = New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
            $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
            foreach ($registration in @($daemon, $watchdog)) {
                $action = New-ScheduledTaskAction -Execute $registration.execute -Argument $registration.arguments -WorkingDirectory $root
                $taskArgs = @{ Action = $action; Principal = $principal; Settings = $settings; Description = $registration.description }
                if ($registration.arguments -eq 'watch') { $taskArgs.Trigger = New-ScheduledTaskTrigger -AtLogOn -User $sid }
                $task = New-ScheduledTask @taskArgs
                Register-ScheduledTask -TaskPath '\' -TaskName $registration.task_name -InputObject $task -ErrorAction Stop | Out-Null
                $created += $registration
            }
            [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($managedRequirements))
            $stream = [IO.File]::Open($managedRequirements, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            $createdRequirements = $true
            try { $bytes = [Text.Encoding]::UTF8.GetBytes($hooks.Toml); $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
            $installed.installation_status = 'activated'
            Write-Utf8NoBom $installManifestPath ($installed | ConvertTo-Json -Depth 12)
        } catch {
            $failure = $_
            foreach ($registration in $created) {
                $current = Get-ScheduledTask -TaskPath '\' -TaskName $registration.task_name -ErrorAction SilentlyContinue
                if ($current -and [string]$current.Description -eq $registration.description) { Unregister-ScheduledTask -InputObject $current -Confirm:$false }
            }
            if ($createdRequirements -and (Get-FileHash -Algorithm SHA256 -LiteralPath $managedRequirements).Hash -eq (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $root 'config\managed-requirements.toml')).Hash) {
                Remove-Item -LiteralPath $managedRequirements
            }
            throw $failure
        }
        $summary.activated = $true
        $summary.next_step = "Restart Codex, then run scripts\agentmemory-mcp.ps1 -Root '$root' -ValidateOnly to start and verify the owned service before adding the HTTP MCP connection."
    }
    $summary | ConvertTo-Json
}
