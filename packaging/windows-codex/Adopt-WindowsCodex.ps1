function Read-UpstreamEnvironment {
    param([string[]]$Paths)
    $values = @{}
    foreach ($path in $Paths) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
        Assert-LocalInstallPath $path
        foreach ($line in Get-Content -LiteralPath $path) {
            if ($line -match '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
                $key = $Matches[1]
                $value = $Matches[2].Trim()
                if ($value.StartsWith('"') -or $value.StartsWith("'")) {
                    $close = $value.IndexOf($value.Substring(0, 1), 1)
                    if ($close -gt 0) { $value = $value.Substring(1, $close - 1) }
                } else {
                    $comment = $value.IndexOf(' #', [StringComparison]::Ordinal)
                    if ($comment -ge 0) { $value = $value.Substring(0, $comment).Trim() }
                }
                $values[$key] = $value
            }
        }
    }
    return $values
}

function Get-UpstreamInstallation {
    $package = [IO.Path]::GetFullPath($UpstreamPackageRoot).TrimEnd('\')
    $data = [IO.Path]::GetFullPath($UpstreamDataDir).TrimEnd('\')
    $runtime = if ($UpstreamRuntimeDir) { [IO.Path]::GetFullPath($UpstreamRuntimeDir).TrimEnd('\') } elseif ($UpstreamHome) { [IO.Path]::GetFullPath($UpstreamHome).TrimEnd('\') } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.agentmemory' }
    $sourceHome = if ($UpstreamHome) { [IO.Path]::GetFullPath($UpstreamHome).TrimEnd('\') } else { $runtime }
    foreach ($path in @($package, $data, $runtime, $sourceHome)) {
        Assert-LocalInstallPath $path
        if (-not (Test-Path -LiteralPath $path -PathType Container)) { throw 'The upstream package, data and configuration directories must exist.' }
        if ($path -eq $root -or $path.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase) -or $root.StartsWith($path + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Upstream input and the new InstallRoot must be separate.' }
    }
    $packageFile = Join-Path $package 'package.json'
    Assert-LocalInstallPath $packageFile
    $metadata = Get-Content -Raw -LiteralPath $packageFile | ConvertFrom-Json
    if ([string]$metadata.name -ne '@agentmemory/agentmemory' -or [string]$metadata.version -notmatch '^\d+\.\d+\.\d+$') { throw 'UpstreamPackageRoot must identify a released AgentMemory package.' }
    $version = [version]$metadata.version
    if ($version -gt [version]$releaseManifest.agentmemory_version) { throw 'This upstream version is newer than the supported release; no downgrade was performed.' }
    if ($version -lt [version]'0.9.29') { throw 'Direct file-state adoption is qualified for upstream 0.9.29 and newer. Earlier versions require an export/import migration; no source files were changed.' }
    if (-not (Test-Path -LiteralPath (Join-Path $data 'state_store.db') -PathType Container)) { throw 'Upstream adoption requires the original file-backed StateModule directory.' }
    $pending = New-Object 'Collections.Generic.Stack[string]'
    $pending.Push($data)
    while ($pending.Count) {
        foreach ($item in Get-ChildItem -Force -LiteralPath $pending.Pop()) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Upstream data contains a reparse entry; adoption was not started.' }
            if ($item.PSIsContainer) { $pending.Push($item.FullName) }
        }
    }
    $stateFile = Join-Path $runtime 'engine-state.json'
    $engineState = if (Test-Path -LiteralPath $stateFile) { Get-Content -Raw -LiteralPath $stateFile | ConvertFrom-Json } else { $null }
    if ($engineState -and [string]$engineState.kind -ne 'native') { throw 'Docker-backed installations require their own export/import migration.' }
    $environment = Read-UpstreamEnvironment -Paths @((Join-Path $sourceHome '.env'), (Join-Path $runtime 'runtime.env'))
    $configPath = if ($engineState) { [string]$engineState.configPath } else {
        $candidates = @()
        if ($environment['AGENTMEMORY_III_CONFIG']) {
            $selected = [string]$environment['AGENTMEMORY_III_CONFIG']
            $candidates += if ([IO.Path]::IsPathRooted($selected)) { $selected } else { Join-Path $package $selected }
        }
        $candidates += @((Join-Path $package 'iii-config.yaml'), (Join-Path $sourceHome 'iii-config.yaml'), (Join-Path $package 'dist\iii-config.yaml'))
        $found = @($candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1)
        if (-not $found.Count) { throw 'The original upstream engine configuration cannot be resolved; no source data was changed.' }
        [IO.Path]::GetFullPath([string]$found[0])
    }
    $portSources = @{}
    if ($environment['AGENTMEMORY_STATE_BACKEND'] -eq 'redis') { throw 'Redis-backed installations require an export/import migration.' }
    if (Test-Path -LiteralPath $configPath -PathType Leaf) {
        Assert-LocalInstallPath $configPath
        $configText = [IO.File]::ReadAllText($configPath)
        if ($configText -match '(?im)^\s*(?:name|class):\s*redis\s*$|\$\{AGENTMEMORY_REDIS_URL\}') { throw 'Redis-backed installations cannot be adopted as file state.' }
        foreach ($module in [regex]::Matches($configText, '(?ms)^\s*-\s*(?:name|class):\s*(?<name>[^\r\n]+)\r?\n(?<body>.*?)(?=^\s*-\s*(?:name|class):|\z)')) {
            if ($module.Groups['body'].Value -match '(?m)^\s*port:\s*(\d+)\s*$') {
                $modulePort = [int]$Matches[1]
                $key = switch -Regex ($module.Groups['name'].Value.Trim()) { 'iii-http|RestApiModule' { 'rest' }; 'iii-stream|StreamModule' { 'stream' }; 'iii-worker-manager|WorkerModule' { 'engine' } }
                if ($key) { $servicePorts.$key = $modulePort; $portSources[$key] = $true }
            }
        }
    }
    if ($engineState -and $engineState.PSObject.Properties['restPort']) { $servicePorts.rest = [int]$engineState.restPort }
    if ($engineState -and $engineState.PSObject.Properties['enginePort']) { $servicePorts.engine = [int]$engineState.enginePort; $portSources['engine'] = $true }
    foreach ($mapping in @{ III_REST_PORT = 'rest'; III_STREAM_PORT = 'stream'; III_STREAMS_PORT = 'stream'; III_VIEWER_PORT = 'viewer'; III_ENGINE_PORT = 'engine'; AGENTMEMORY_MCP_HTTP_PORT = 'mcp' }.GetEnumerator()) {
        if ($environment[$mapping.Key]) { $servicePorts.($mapping.Value) = [int]$environment[$mapping.Key]; $portSources[$mapping.Value] = $true }
    }
    if (-not $portSources['stream']) { $servicePorts.stream = $servicePorts.rest + 1 }
    if (-not $portSources['engine']) { $servicePorts.engine = $servicePorts.rest + 46023 }
    if (-not $environment['III_VIEWER_PORT']) { $servicePorts.viewer = $servicePorts.rest + 2 }
    if (-not $environment['AGENTMEMORY_MCP_HTTP_PORT']) { $servicePorts.mcp = $servicePorts.rest + 3 }
    $ports = @($servicePorts.rest, $servicePorts.stream, $servicePorts.viewer, $servicePorts.mcp, $servicePorts.engine)
    if (@($ports | Where-Object { $_ -lt 1 -or $_ -gt 65535 }).Count -or @($ports | Select-Object -Unique).Count -ne 5) { throw 'The upstream service ports are invalid or overlap.' }
    $secret = $environment['AGENTMEMORY_SECRET']
    if ($version -ge [version]'0.9.30' -and $secret -and $secret.StartsWith('${') -and $secret.EndsWith('}')) { $secret = $null }
    if (-not $secret -and (Test-Path -LiteralPath (Join-Path $sourceHome 'secret'))) { $secret = [IO.File]::ReadAllText((Join-Path $sourceHome 'secret')).Trim() }
    if ($secret -and $secret -notmatch '^[\x20-\x7e]+$') { throw 'The upstream secret cannot be carried in an HTTP authorization header; no authentication value was changed.' }
    if ((Split-Path -Leaf $sourceHome) -ine '.agentmemory') { throw 'UpstreamHome must be the original .agentmemory directory so its CLI can resolve the same home.' }
    $instance = $null
    if ($runtime -ine $sourceHome) {
        if ($runtime -ine $data -or (Split-Path -Leaf $runtime) -notmatch '^instance-([1-9]|[1-4][0-9]|50)$') { throw 'The original runtime cannot be resolved to its CLI instance; no process was stopped.' }
        $instance = $Matches[1]
    }
    return [pscustomobject]@{ Package = $package; Data = $data; Runtime = $runtime; Home = $sourceHome; Version = [string]$metadata.version; EngineState = $engineState; ConfigPath = $configPath; Environment = $environment; Secret = $secret; Instance = $instance; WasRunning = $false }
}

function Invoke-UpstreamCli {
    param($Source, [switch]$Stop)
    $arguments = @('--port', [string]$servicePorts.rest, '--data-dir', $Source.Data)
    if ($Source.Instance) { $arguments = @('--port', [string]$servicePorts.rest, '--instance', $Source.Instance, '--data-dir', (Split-Path -Parent $Source.Data)) }
    if ($Stop) { $arguments = @('stop') + $arguments }
    $prior = @{}
    foreach ($entry in Get-ChildItem Env:) { $prior[$entry.Name] = $entry.Value }
    try {
        foreach ($entry in Get-ChildItem Env: | Where-Object { $_.Name -match '^(?:AGENTMEMORY_|III_)' }) { [Environment]::SetEnvironmentVariable($entry.Name, $null, 'Process') }
        foreach ($key in $Source.Environment.Keys) { [Environment]::SetEnvironmentVariable($key, [string]$Source.Environment[$key], 'Process') }
        $env:USERPROFILE = Split-Path -Parent $Source.Home; $env:HOME = $env:USERPROFILE
        $env:AGENTMEMORY_RUNTIME_DIR = $Source.Runtime; $env:AGENTMEMORY_III_CONFIG = $Source.ConfigPath
        $env:III_STREAM_PORT = [string]$servicePorts.stream; $env:III_VIEWER_PORT = [string]$servicePorts.viewer
        $env:III_ENGINE_PORT = [string]$servicePorts.engine; $env:III_ENGINE_URL = "ws://127.0.0.1:$($servicePorts.engine)"
        $env:AGENTMEMORY_MCP_HTTP_PORT = [string]$servicePorts.mcp
        if ($Source.EngineState) { $env:PATH = (Split-Path -Parent ([string]$Source.EngineState.binPath)) + ';' + $env:PATH }
        if ($Source.Secret) { $env:AGENTMEMORY_SECRET = $Source.Secret }
        Push-Location $Source.Package
        try {
            $cli = Join-Path $Source.Package 'dist\cli.mjs'
            if ($Stop) {
                & $node $cli @arguments
                if ($LASTEXITCODE -ne 0) { throw 'The original upstream CLI operation failed.' }
            } else {
                $stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
                $restarted = Start-Process -FilePath $node -ArgumentList (@($cli) + $arguments | ForEach-Object { '"' + $_ + '"' }) -WorkingDirectory $Source.Package -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $Source.Runtime "adoption-recovery-$stamp.out.log") -RedirectStandardError (Join-Path $Source.Runtime "adoption-recovery-$stamp.err.log")
                $identity = Get-CimInstance Win32_Process -Filter "ProcessId=$($restarted.Id)"
                if (-not $identity -or $identity.ExecutablePath -ine $node -or -not ([string]$identity.CommandLine).Contains($cli)) { throw 'Original service restart identity could not be confirmed.' }
                $deadline = [DateTime]::UtcNow.AddSeconds(45)
                $ready = $false
                do {
                    if ($restarted.HasExited) { throw 'Original service exited during recovery; inspect its adoption-recovery logs.' }
                    try {
                        $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$($servicePorts.rest)/agentmemory/livez" -Headers @{ Authorization = "Bearer $($Source.Secret)" } -TimeoutSec 2
                        $body = $response.Content | ConvertFrom-Json
                        $ready = $response.StatusCode -eq 200 -and [string]$body.service -eq 'agentmemory' -and [string]$body.status -eq 'ok'
                    } catch { }
                    if (-not $ready) { Start-Sleep -Milliseconds 250 }
                } while (-not $ready -and [DateTime]::UtcNow -lt $deadline)
                $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($identity.ProcessId)"
                if (-not $ready -or -not $current -or $current.CreationDate -ne $identity.CreationDate -or $current.CommandLine -cne $identity.CommandLine) { throw 'Original service recovery readiness or process identity was not confirmed.' }
            }
        } finally { Pop-Location }
    } finally {
        foreach ($entry in Get-ChildItem Env:) { if (-not $prior.ContainsKey($entry.Name)) { [Environment]::SetEnvironmentVariable($entry.Name, $null, 'Process') } }
        foreach ($key in $prior.Keys) { [Environment]::SetEnvironmentVariable($key, $prior[$key], 'Process') }
    }
}

function Assert-UpstreamQuiescent {
    param($Source)
    foreach ($kind in @('iii', 'worker')) {
        $pidPath = Join-Path $Source.Runtime "$kind.pid"
        if (Test-Path -LiteralPath $pidPath) {
            $number = [IO.File]::ReadAllText($pidPath).Trim()
            if ($number -notmatch '^\d+$' -or (Get-CimInstance Win32_Process -Filter "ProcessId=$number")) { throw 'Original upstream is no longer quiescent; activation was not started.' }
        }
    }
    if (Get-InstallPortConflicts) { throw 'An upstream service port became occupied; activation was not started.' }
}

function Stop-UpstreamInstallation {
    param($Source)
    $identities = @()
    foreach ($kind in @('iii', 'worker')) {
        $pidPath = Join-Path $Source.Runtime "$kind.pid"
        if (-not (Test-Path -LiteralPath $pidPath)) { continue }
        $number = [IO.File]::ReadAllText($pidPath).Trim()
        if ($number -notmatch '^\d+$') { throw 'The upstream pidfile does not identify a process.' }
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$number"
        if (-not $process) { continue }
        $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid
        if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { throw 'The upstream process is not owned by this Windows user.' }
        $command = [string]$process.CommandLine
        if (($kind -eq 'iii' -and (-not $Source.EngineState -or $process.ExecutablePath -ine [string]$Source.EngineState.binPath -or -not $command.Contains($Source.ConfigPath))) -or
            ($kind -eq 'worker' -and -not $command.Contains($Source.Package))) { throw 'The upstream process identity does not match the selected installation.' }
        $identities += $process
    }
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in @($servicePorts.rest, $servicePorts.stream, $servicePorts.viewer, $servicePorts.mcp, $servicePorts.engine) })
    if (@($listeners | Where-Object { $_.OwningProcess -notin @($identities.ProcessId) }).Count) { throw 'An upstream port is owned by an unverified process; nothing was stopped.' }
    if ($identities.Count) {
        $Source.WasRunning = $true
        foreach ($before in $identities) {
            $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($before.ProcessId)"
            if (-not $current -or $current.CreationDate -ne $before.CreationDate -or $current.ParentProcessId -ne $before.ParentProcessId -or $current.CommandLine -cne $before.CommandLine) { throw 'Upstream process ownership changed before stop.' }
        }
        Invoke-UpstreamCli $Source -Stop
        foreach ($before in $identities) {
            if (Get-CimInstance Win32_Process -Filter "ProcessId=$($before.ProcessId)") { throw 'Original upstream shutdown is not confirmed; data was not copied.' }
        }
    }
    Assert-UpstreamQuiescent $Source
}

function Invoke-UpstreamAdoption {
    $source = Get-UpstreamInstallation
    $summary = [ordered]@{ operation = 'adopt-upstream'; execute = [bool]$Execute; source_version = $source.Version; target_version = [string]$releaseManifest.agentmemory_version; source_data = $source.Data; install_root = $root; service_ports = $servicePorts; data_action = 'copy-preserving-original'; service_started = $false }
    if (-not $Execute) { $summary | ConvertTo-Json -Depth 4; return }
    Invoke-FreshInstallation | Out-Null
    Assert-LocalInstallPath $managedRequirements
    if (Test-Path -LiteralPath $managedRequirements) { throw 'Managed Codex requirements already exist; upstream was not stopped.' }
    Import-Module ScheduledTasks -ErrorAction Stop
    $sourceSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    foreach ($registration in @((New-InstallTaskRegistration -Root $root -Sid $sourceSid -Nonce 'preflight'), (New-InstallTaskRegistration -Root $root -Sid $sourceSid -Nonce 'preflight' -Watchdog))) {
        if (Get-ScheduledTask -TaskPath '\' -TaskName $registration.task_name -ErrorAction SilentlyContinue) { throw "Scheduled task already exists; upstream was not stopped: $($registration.task_name)" }
    }
    try {
    Stop-UpstreamInstallation $source
    Invoke-FreshInstallation -Execute
    $backup = Join-Path $root 'backups\upstream-adoption'
    [void][IO.Directory]::CreateDirectory($backup)
    Copy-Item -LiteralPath $source.Data -Destination (Join-Path $backup 'data') -Recurse
    foreach ($item in Get-ChildItem -Force -LiteralPath $source.Data) {
        if ($item.Name -in @('iii.pid', 'worker.pid', 'engine-state.json', 'runtime.env', 'iii-config.runtime.yaml')) { continue }
        Copy-Item -LiteralPath $item.FullName -Destination (Join-Path $root 'data') -Recurse
    }
    Assert-UpstreamQuiescent $source
    foreach ($file in Get-ChildItem -Force -Recurse -File -LiteralPath $source.Data) {
        $relative = $file.FullName.Substring($source.Data.Length + 1)
        $originalHash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
        $backupFile = Join-Path (Join-Path $backup 'data') $relative
        if ($originalHash -ne (Get-FileHash -LiteralPath $backupFile -Algorithm SHA256).Hash) { throw 'The preserved upstream data copy did not match; activation was not started.' }
        if ($relative -in @('iii.pid', 'worker.pid', 'engine-state.json', 'runtime.env', 'iii-config.runtime.yaml')) { continue }
        if ($originalHash -ne (Get-FileHash -LiteralPath (Join-Path (Join-Path $root 'data') $relative) -Algorithm SHA256).Hash) { throw 'The adopted data did not match its original; activation was not started.' }
    }
    if ($source.Secret) {
        $plain = [Text.Encoding]::UTF8.GetBytes($source.Secret)
        try { [IO.File]::WriteAllBytes((Join-Path $root 'config\secret.dpapi'), [Security.Cryptography.ProtectedData]::Protect($plain, [Text.Encoding]::UTF8.GetBytes('Codex.AgentMemory.v1'), [Security.Cryptography.DataProtectionScope]::CurrentUser)) }
        finally { [Array]::Clear($plain, 0, $plain.Length) }
    }
    $settings = [ordered]@{}
    foreach ($key in @('AGENTMEMORY_VECTOR_BUCKET_SIZE', 'AGENTMEMORY_INDEX_SAVE_INTERVAL_MS', 'AGENTMEMORY_VECTOR_BACKFILL_MAX', 'AGENTMEMORY_VECTOR_BACKFILL', 'SESSION_TIMEOUT_MS', 'SESSION_TTL_DAYS', 'OBSERVATION_TTL_DAYS', 'AGENTMEMORY_AUDIT_RETENTION_DAYS', 'AGENTMEMORY_BM25_LIMIT', 'AGENTMEMORY_GRAPH_WEIGHT')) {
        if ($source.Environment.ContainsKey($key)) { $settings[$key] = [string]$source.Environment[$key] }
    }
    $workspaceDocument = Get-Content -Raw -LiteralPath (Join-Path $root 'config\codex-workspace.json') | ConvertFrom-Json
    $workspaceDocument | Add-Member -NotePropertyName upstream_settings -NotePropertyValue $settings
    Write-Utf8NoBom (Join-Path $root 'config\codex-workspace.json') ($workspaceDocument | ConvertTo-Json -Depth 6)
    $manifest = Get-Content -Raw -LiteralPath $installManifestPath | ConvertFrom-Json
    $manifest | Add-Member -NotePropertyName upstream_adoption -NotePropertyValue ([ordered]@{ source_version = $source.Version; source_package = $source.Package; source_data = $source.Data; original_preserved = $true })
    Write-Utf8NoBom $installManifestPath ($manifest | ConvertTo-Json -Depth 12)
    Invoke-FreshInstallation -Activate -Execute
    & (Join-Path $root 'scripts\agentmemory-mcp.ps1') -Root $root -ValidateOnly
    if ($LASTEXITCODE -ne 0) { throw 'Upstream data was preserved but the new service did not validate. Keep both the original source and adoption backup.' }
    } catch {
        $failure = $_
        try {
                . (Join-Path $payload 'scripts\agentmemory-lifecycle.ps1')
                $registrations = @(Get-OwnedTaskRegistrations -Root $root | Where-Object { Get-ScheduledTask -TaskPath $_.TaskPath -TaskName $_.TaskName -ErrorAction SilentlyContinue })
                if (Test-Path -LiteralPath (Join-Path $root 'data\runtime-state.json')) { Stop-OwnedRuntimeForCutover -Root $root -Registrations $registrations }
                else {
                    foreach ($registration in $registrations) {
                        $task = Get-OwnedTaskForCutover -Root $root -Registration $registration
                        Stop-ScheduledTask -InputObject $task -ErrorAction Stop
                    }
                }
                foreach ($registration in $registrations) {
                    $task = Get-OwnedTaskForCutover -Root $root -Registration $registration
                    Unregister-ScheduledTask -InputObject $task -Confirm:$false
                }
                if (Test-Path -LiteralPath $managedRequirements) {
                    $requirementsSource = Join-Path $root 'config\managed-requirements.toml'
                    if ((Get-FileHash -LiteralPath $managedRequirements -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $requirementsSource -Algorithm SHA256).Hash) { throw 'Failed adoption requirements changed; they were preserved.' }
                    Remove-Item -LiteralPath $managedRequirements
                }
                if (Test-Path -LiteralPath $installManifestPath) {
                    $failedInstall = Get-Content -Raw -LiteralPath $installManifestPath | ConvertFrom-Json
                    Set-ObjectProperty -Object $failedInstall -Name 'status' -Value 'adoption_failed'
                    Set-ObjectProperty -Object $failedInstall -Name 'installation_status' -Value 'adoption_failed'
                    Write-Utf8NoBom $installManifestPath ($failedInstall | ConvertTo-Json -Depth 12)
                }
                if ($source.WasRunning) {
                    Assert-UpstreamQuiescent $source
                    Invoke-UpstreamCli $source
                }
        } catch { throw "Adoption failed: $($failure.Exception.Message) Original data is preserved; cleanup or service recovery was not confirmed: $($_.Exception.Message)" }
        if ($source.WasRunning) {
            throw "Adoption failed; original service was restarted using its preserved data: $($failure.Exception.Message)"
        }
        throw $failure
    }
    $summary.service_started = $true
    $summary | ConvertTo-Json -Depth 4
}
