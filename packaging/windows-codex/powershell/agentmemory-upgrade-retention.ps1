function Assert-AgentMemoryRetentionPath {
    param([string]$Path)
    $item = Get-Item -LiteralPath $Path -Force
    while ($null -ne $item) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse ancestor is protected: $Path" }
        $item = if ($item -is [IO.DirectoryInfo]) { $item.Parent } else { $item.Directory }
    }
}

function Get-AgentMemoryRetentionInventory {
    param([string]$Path, [switch]$PackageJunctions, [switch]$ExcludeStartupLock, [switch]$TopologyOnly, [string]$JunctionSourceRoot = '')
    Assert-AgentMemoryRetentionPath $Path
    $base = (Get-Item -LiteralPath $Path -Force).FullName.TrimEnd('\')
    $entries = [ordered]@{}
    $pending = New-Object 'Collections.Generic.Stack[IO.DirectoryInfo]'
    $pending.Push((Get-Item -LiteralPath $base -Force))
    while ($pending.Count) {
        foreach ($item in @($pending.Pop().EnumerateFileSystemInfos() | Sort-Object Name)) {
            $relative = $item.FullName.Substring($base.Length + 1).Replace('\','/')
            if ($ExcludeStartupLock -and $relative -ceq 'startup.lock') { continue }
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                $link = Get-Item -LiteralPath $item.FullName -Force
                $targets = @($link.Target)
                if (-not $PackageJunctions -or $link.LinkType -ne 'Junction' -or $targets.Count -ne 1) { throw "Unproven reparse entry: $relative" }
                $target = [IO.Path]::GetFullPath([string]$targets[0])
                $junctionBase = if ($JunctionSourceRoot) { $JunctionSourceRoot.TrimEnd('\') } else { $base }
                if (-not $target.StartsWith($junctionBase + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "External package junction: $relative" }
                if (-not $JunctionSourceRoot) { Assert-AgentMemoryRetentionPath $target }
                $entries[$relative + '/'] = 'junction:' + $target.Substring($junctionBase.Length + 1).Replace('\','/')
            } elseif ($item -is [IO.DirectoryInfo]) {
                $entries[$relative + '/'] = 'directory'
                $pending.Push($item)
            } else { $entries[$relative] = if ($TopologyOnly) { 'file' } else { (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash } }
        }
    }
    return ,$entries
}

function Test-AgentMemoryRetentionInventory {
    param($Left, $Right)
    if ($Left.Count -ne $Right.Count) { return $false }
    foreach ($key in $Left.Keys) { if (-not $Right.Contains($key) -or $Left[$key] -cne $Right[$key]) { return $false } }
    return $true
}

function New-AgentMemoryColdRecovery {
    param([string]$InstallRoot, [string]$BackupRoot, $PreviousManifest, [switch]$IncludeData, [string]$ManagedRequirementsPath = '')
    Assert-AgentMemoryRetentionPath $InstallRoot
    Assert-AgentMemoryRetentionPath $BackupRoot
    $files = [ordered]@{}
    foreach ($name in @('scripts','bin','src','licenses','config','.agentmemory-install-owner.json') + $(if ($IncludeData) { @('data','home') } else { @() })) {
        $source = Join-Path $InstallRoot $name
        if (-not (Test-Path -LiteralPath $source)) { continue }
        $destination = Join-Path $BackupRoot $name
        Assert-AgentMemoryRetentionPath $source
        if (Test-Path -LiteralPath $source -PathType Container) {
            $files[$name + '/'] = 'directory'
            $before = Get-AgentMemoryRetentionInventory -Path $source -ExcludeStartupLock:($name -eq 'data')
            [void][IO.Directory]::CreateDirectory($destination)
            foreach ($relative in $before.Keys) {
                $target = Join-Path $destination $relative
                if ($relative.EndsWith('/')) { [void][IO.Directory]::CreateDirectory($target) }
                else { [void][IO.Directory]::CreateDirectory((Split-Path -Parent $target)); [IO.File]::Copy((Join-Path $source $relative), $target, $false) }
                $files[($name + '/' + $relative)] = $before[$relative]
            }
            $after = Get-AgentMemoryRetentionInventory -Path $source -ExcludeStartupLock:($name -eq 'data')
            $copy = Get-AgentMemoryRetentionInventory -Path $destination
            if (-not (Test-AgentMemoryRetentionInventory $before $after) -or -not (Test-AgentMemoryRetentionInventory $before $copy)) { throw "Cold recovery copy changed: $name" }
        } else {
            $hash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
            [IO.File]::Copy($source,$destination,$false)
            if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne $hash -or (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne $hash) { throw 'Recovery identity changed.' }
            $files[$name] = $hash
        }
    }
    if ($ManagedRequirementsPath -and (Test-Path -LiteralPath $ManagedRequirementsPath -PathType Leaf)) {
        Assert-AgentMemoryRetentionPath $ManagedRequirementsPath
        $hash = (Get-FileHash -LiteralPath $ManagedRequirementsPath -Algorithm SHA256).Hash
        [IO.File]::Copy($ManagedRequirementsPath, (Join-Path $BackupRoot 'requirements.toml'), $false)
        if ((Get-FileHash -LiteralPath (Join-Path $BackupRoot 'requirements.toml') -Algorithm SHA256).Hash -cne $hash -or (Get-FileHash -LiteralPath $ManagedRequirementsPath -Algorithm SHA256).Hash -cne $hash) { throw 'Managed requirements recovery changed.' }
        $files['requirements.toml'] = $hash
    }
    foreach ($relative in $files.Keys) {
        if ($relative.EndsWith('/')) { continue }
        $source = if ($relative -ceq 'requirements.toml') { $ManagedRequirementsPath } else { Join-Path $InstallRoot $relative }
        Assert-AgentMemoryRetentionPath $source
        if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -cne $files[$relative]) { throw 'Recovery source changed before cutover.' }
    }
    if ($IncludeData) {
        foreach ($required in @('data','config/install-manifest.json','config/secret.dpapi','.agentmemory-install-owner.json')) {
            if (-not (Test-Path -LiteralPath (Join-Path $BackupRoot $required))) { throw "Required recovery input is missing: $required" }
        }
        $record = [ordered]@{ schema_version = 1; install_nonce = [string]$PreviousManifest.install_nonce; release_revision = [string]$PreviousManifest.release_revision; data_contract_version = $PreviousManifest.data_contract_version; package_relative_path = [string]$PreviousManifest.package_relative_path; cold_snapshot = $true; files = $files }
        [IO.File]::WriteAllText((Join-Path $BackupRoot 'recovery-set.json'), ($record | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    }
}

function Read-AgentMemoryColdRecoveryDirectory {
    param([string]$Path, [string]$Nonce)
    $actual = Get-AgentMemoryRetentionInventory $Path
    $record = Get-Content -LiteralPath (Join-Path $Path 'recovery-set.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $manifest = Get-Content -LiteralPath (Join-Path $Path 'config/install-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($record.schema_version -ne 1 -or $record.cold_snapshot -ne $true -or $record.install_nonce -cne $Nonce -or $manifest.install_nonce -cne $Nonce -or $record.release_revision -cne $manifest.release_revision -or $record.package_relative_path -cne $manifest.package_relative_path -or $record.data_contract_version -ne $manifest.data_contract_version) { throw 'Pending cold recovery identity mismatch.' }
    if ($actual.Count -ne ($record.files.PSObject.Properties.Name.Count + 1)) { throw 'Pending recovery inventory changed.' }
    foreach ($file in $record.files.PSObject.Properties) {
        if (-not $actual.Contains($file.Name) -or $actual[$file.Name] -cne $file.Value) { throw 'Pending recovery bytes changed.' }
    }
    foreach ($required in @('config/secret.dpapi','.agentmemory-install-owner.json')) { if ($null -eq $record.files.PSObject.Properties[$required]) { throw 'Pending authentication recovery is incomplete.' } }
    if (@($record.files.PSObject.Properties | Where-Object Name -like 'data/*').Count -eq 0) { throw 'Pending data recovery is incomplete.' }
    return $manifest
}

function Read-AgentMemoryRecoveryArchive {
    param([string]$Path, [string]$Nonce, [switch]$RequireComplete)
    Assert-AgentMemoryRetentionPath $Path
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($Path)
    try {
        $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($entry in $zip.Entries) {
            if (-not $names.Add($entry.FullName) -or $entry.FullName.Contains('\') -or $entry.FullName.StartsWith('/') -or $entry.FullName.Split('/') -contains '..') { throw 'Ambiguous archive paths.' }
        }
        function Read-ArchiveJson([string]$Name) {
            $entry = $zip.GetEntry($Name)
            if ($null -eq $entry -or $entry.Length -gt 16MB) { throw "Missing or oversized recovery metadata: $Name" }
            $reader = [IO.StreamReader]::new($entry.Open())
            try { return ($reader.ReadToEnd() | ConvertFrom-Json) } finally { $reader.Dispose() }
        }
        $manifest = Read-ArchiveJson 'config/install-manifest.json'
        if ([string]$manifest.install_nonce -cne $Nonce) { throw 'Foreign backup owner.' }
        if ($RequireComplete) {
            $record = Read-ArchiveJson 'recovery-set.json'
            if ($record.cold_snapshot -ne $true -or [string]$record.install_nonce -cne $Nonce -or $record.release_revision -cne $manifest.release_revision -or $record.data_contract_version -ne $manifest.data_contract_version -or $record.package_relative_path -cne $manifest.package_relative_path) { throw 'Recovery identity mismatch.' }
            foreach ($property in $record.files.PSObject.Properties) {
                $entry = $zip.GetEntry($property.Name)
                if ($null -eq $entry) { throw 'Incomplete recovery archive.' }
                if ($property.Name.EndsWith('/')) { if ($entry.Length -ne 0) { throw 'Invalid recovery directory.' }; continue }
                $input = $entry.Open(); $sha = [Security.Cryptography.SHA256]::Create()
                try { $hash = [BitConverter]::ToString($sha.ComputeHash($input)).Replace('-','') } finally { $input.Dispose(); $sha.Dispose() }
                if ($hash -cne $property.Value) { throw 'Recovery byte verification failed.' }
            }
            foreach ($required in @('config/secret.dpapi','.agentmemory-install-owner.json')) { if ($null -eq $record.files.PSObject.Properties[$required]) { throw 'Incomplete authentication recovery.' } }
            if (@($record.files.PSObject.Properties | Where-Object Name -like 'data/*').Count -eq 0) { throw 'Incomplete data recovery.' }
        }
        return $manifest
    } finally { $zip.Dispose() }
}

function Invoke-AgentMemoryRetentionRecycle {
    param([string]$Path, [string[]]$ProtectedPaths, [switch]$PackageJunctions)
    Assert-AgentMemoryRetentionPath $Path
    $item = Get-Item -LiteralPath $Path -Force
    $parent = if ($item.PSIsContainer) { $item.Parent.FullName } else { $item.DirectoryName }
    if ($item.PSIsContainer) { $parent = $item.Parent.FullName; [void](Get-AgentMemoryRetentionInventory $Path -PackageJunctions:$PackageJunctions -TopologyOnly) }
    else { $before = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash; $originalBytes = $item.Length }
    foreach ($protected in $ProtectedPaths) {
        $full = [IO.Path]::GetFullPath($protected).TrimEnd('\')
        if ($Path -ieq $full -or $full.StartsWith($Path.TrimEnd('\') + '\',[StringComparison]::OrdinalIgnoreCase) -or $Path.StartsWith($full + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Protected retention path.' }
        if (-not (Test-Path -LiteralPath $full)) { throw 'Required protected path is absent.' }
    }
    $destination = Send-CompletedBackupToRecycleBin -Path $Path
    if ((Test-Path -LiteralPath $Path) -or -not (Test-Path -LiteralPath $parent -PathType Container) -or -not (Test-Path -LiteralPath $destination)) { throw 'Recycle disposition is uncertain; stop.' }
    foreach ($protected in $ProtectedPaths) { if (-not (Test-Path -LiteralPath $protected)) { throw 'Protected path disappeared; stop.' } }
    $name = [IO.Path]::GetFileName($destination)
    if (-not $name.StartsWith('$R',[StringComparison]::Ordinal)) { throw 'Missing recoverable recycle payload.' }
    $receiptPath = Join-Path (Split-Path -Parent $destination) ('$I' + $name.Substring(2))
    $receipt = [IO.File]::ReadAllBytes($receiptPath)
    $version = [BitConverter]::ToInt64($receipt,0)
    if ($version -eq 2) { $original = [Text.Encoding]::Unicode.GetString($receipt,28,[BitConverter]::ToInt32($receipt,24)*2).TrimEnd([char]0) }
    elseif ($version -eq 1) { $original = [Text.Encoding]::Unicode.GetString($receipt,24,$receipt.Length-24).TrimEnd([char]0) }
    else { throw 'Unknown recycle receipt.' }
    if ($original -ine [IO.Path]::GetFullPath($Path)) { throw 'Recycle receipt path mismatch.' }
    if ($item.PSIsContainer) {
        if (-not (Test-Path -LiteralPath $destination -PathType Container)) { throw 'Missing recycled directory.' }
    } elseif ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -cne $before -or [BitConverter]::ToInt64($receipt,8) -ne $originalBytes) { throw 'Recycled archive bytes differ.' }
    return [pscustomobject]@{ path = $Path; recycle_path = $destination; receipt_path = $receiptPath; verified = $true }
}

function Read-AgentMemoryLegacyColdRecovery {
    param([string]$Path, [string]$Nonce)
    Assert-AgentMemoryRetentionPath $Path
    $recordPath = Join-Path $Path 'recovery-set.json'
    Assert-AgentMemoryRetentionPath $recordPath
    $record = Get-Content -LiteralPath $recordPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($record.schema -ne 1 -or $record.consistent_after_normal_stop -ne $true -or $record.readback_hash_verified -ne $true) { throw 'Unproven legacy cold snapshot.' }
    $manifest = Get-Content -LiteralPath (Join-Path $Path 'config/install-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $owner = Get-Content -LiteralPath (Join-Path $Path '.agentmemory-install-owner.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.install_nonce -cne $Nonce -or $owner.install_nonce -cne $Nonce -or $record.code_revision -cne $manifest.release_revision) { throw 'Foreign or mismatched legacy recovery.' }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($file in $record.files) {
        $relative = [string]$file.path
        if ([IO.Path]::IsPathRooted($relative) -or $relative.Replace('\','/').Split('/') -contains '..' -or -not $seen.Add($relative)) { throw 'Ambiguous legacy recovery path.' }
        $source = [IO.Path]::GetFullPath((Join-Path $Path $relative))
        if (-not $source.StartsWith($Path.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Legacy recovery path escapes snapshot.' }
        Assert-AgentMemoryRetentionPath $source
        if ((Get-Item -LiteralPath $source).Length -ne $file.bytes -or (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ine $file.sha256) { throw 'Legacy recovery byte mismatch.' }
    }
    foreach ($required in @('config\install-manifest.json','config\secret.dpapi')) { if (-not $seen.Contains($required)) { throw 'Legacy recovery authentication is incomplete.' } }
    if (@($record.files | Where-Object { $_.path -like 'data\*' }).Count -eq 0) { throw 'Legacy recovery data is incomplete.' }
    $inventory = Get-AgentMemoryRetentionInventory $Path -TopologyOnly
    $standaloneOwnerCount = if ($seen.Contains('.agentmemory-install-owner.json')) { 0 } else { 1 }
    if (@($inventory.Keys | Where-Object { -not $_.EndsWith('/') }).Count -ne ($seen.Count + 1 + $standaloneOwnerCount)) { throw 'Unrecorded legacy recovery files are protected.' }
    return $manifest
}

function Complete-AgentMemoryAutomaticRetention {
    param([string]$InstallRoot, $CurrentManifest, [string]$TransientBackup = '')
    $result = [ordered]@{ status = 'incomplete'; attempted = @(); recycled = @(); retained = @(); unresolved = @() }
    $lock = $null
    try {
        Assert-AgentMemoryRetentionPath $InstallRoot
        $lock = [IO.File]::Open((Join-Path $InstallRoot 'data/startup.lock'),'OpenOrCreate','ReadWrite','None')
        $live = Get-Content -LiteralPath (Join-Path $InstallRoot 'config/install-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($live.install_nonce -cne $CurrentManifest.install_nonce -or $live.release_revision -cne $CurrentManifest.release_revision) { throw 'Installation changed before retention.' }
        $owner = Get-Content -LiteralPath (Join-Path $InstallRoot '.agentmemory-install-owner.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($owner.install_nonce -cne $live.install_nonce) { throw 'Live retention owner changed.' }
        $retention = $CurrentManifest.upgrade_retention
        $archive = [IO.Path]::GetFullPath([string]$retention.recovery_archive)
        if ((Split-Path -Parent $archive) -ine (Join-Path $InstallRoot 'backups/releases')) { throw 'Recovery archive escapes installation.' }
        if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ine $retention.recovery_sha256) { throw 'Required recovery archive changed.' }
        $predecessor = Read-AgentMemoryRecoveryArchive -Path $archive -Nonce $live.install_nonce -RequireComplete
        if ($predecessor.release_revision -cne $retention.immediate_predecessor.release_revision -or $predecessor.package_relative_path -cne $retention.immediate_predecessor.package_relative_path -or $predecessor.data_contract_version -ne $retention.immediate_predecessor.data_contract_version -or $predecessor.release_revision -ceq $live.release_revision) { throw 'Actual predecessor recovery is unproven.' }
        foreach ($manifest in @($live,$predecessor)) {
            if ([string]$manifest.package_relative_path -notmatch '^runtime[\\/]\d+\.\d+\.\d+-codex-r\d+[\\/]agentmemory$') { throw 'Protected runtime package escapes the direct managed runtime layout.' }
        }
        $currentRuntime = [IO.Path]::GetFullPath((Split-Path -Parent (Join-Path $InstallRoot $live.package_relative_path)))
        $previousRuntime = [IO.Path]::GetFullPath((Split-Path -Parent (Join-Path $InstallRoot $predecessor.package_relative_path)))
        $protected = @($currentRuntime,$previousRuntime,$archive,(Join-Path $InstallRoot 'data'),(Join-Path $InstallRoot 'config'),(Join-Path $InstallRoot 'home'),(Join-Path $InstallRoot '.agentmemory-install-owner.json'))
        foreach ($path in $protected) { Assert-AgentMemoryRetentionPath $path }
        $manifests = @($live,$predecessor)
        $backups = @()
        foreach ($entry in @(Get-ChildItem -LiteralPath (Join-Path $InstallRoot 'backups') -Force | Where-Object Name -ne 'releases')) {
            try {
                Assert-AgentMemoryRetentionPath $entry.FullName
                if ($entry.PSIsContainer -and $entry.Name -ceq 'rejected' -and @(Get-ChildItem -LiteralPath $entry.FullName -Force).Count -eq 0) { $result.retained += $entry.FullName; continue }
                if (-not $entry.PSIsContainer) { throw 'Unknown backup is protected.' }
                $old = Read-AgentMemoryLegacyColdRecovery -Path $entry.FullName -Nonce $live.install_nonce
                $manifests += $old
                $backups += $entry.FullName
            } catch { $result.unresolved += [pscustomobject]@{path=$entry.FullName;reason=$_.Exception.Message} }
        }
        foreach ($entry in @(Get-ChildItem -LiteralPath (Join-Path $InstallRoot 'backups/releases') -Force)) {
            if ($entry.FullName -ieq $archive -or $entry.FullName -ieq $TransientBackup) { continue }
            try {
                if ($entry.PSIsContainer -or $entry.Name -notmatch '^[0-9]{8}T[0-9]{9}Z\.zip$') { throw 'Unknown backup is protected.' }
                $old = Read-AgentMemoryRecoveryArchive -Path $entry.FullName -Nonce $live.install_nonce
                $manifests += $old
                $backups += $entry.FullName
            } catch { $result.unresolved += [pscustomobject]@{path=$entry.FullName;reason=$_.Exception.Message} }
        }
        $candidates = @()
        foreach ($runtime in @(Get-ChildItem -LiteralPath (Join-Path $InstallRoot 'runtime') -Force)) {
            if ($runtime.FullName -in @($currentRuntime,$previousRuntime)) { $result.retained += $runtime.FullName; continue }
            try {
                Assert-AgentMemoryRetentionPath $runtime.FullName
                if (-not $runtime.PSIsContainer -or $runtime.Name -notmatch '^\d+\.\d+\.\d+-codex-r\d+$') { throw 'Unknown runtime is protected.' }
                $relative = 'runtime/' + $runtime.Name + '/agentmemory'
                $known = @($manifests | Where-Object { $_.package_relative_path.Replace('\','/') -ceq $relative -and $_.install_nonce -ceq $live.install_nonce })
                if ($known.Count -eq 0) { throw 'Runtime owner is unproven.' }
                $inventory = Get-AgentMemoryRetentionInventory $runtime.FullName -PackageJunctions
                $expected = [ordered]@{}
                foreach ($property in $known[0].source_hashes.PSObject.Properties) {
                    $key = $property.Name.Replace('\','/')
                    if ($key.StartsWith($relative + '/', [StringComparison]::Ordinal)) { $expected[$key.Substring(('runtime/' + $runtime.Name + '/').Length)] = $property.Value }
                }
                $actualFiles = @($inventory.Keys | Where-Object { -not $_.EndsWith('/') })
                if ($expected.Count -eq 0 -or $expected.Count -ne $actualFiles.Count) { throw 'Runtime file ownership differs.' }
                foreach ($key in $actualFiles) { if (-not $expected.Contains($key) -or $expected[$key] -ine $inventory[$key]) { throw 'Runtime bytes differ from owned manifest.' } }
                $candidates += $runtime.FullName
            } catch { $result.unresolved += [pscustomobject]@{path=$runtime.FullName;reason=$_.Exception.Message} }
        }
        if ($result.unresolved.Count) { return [pscustomobject]$result }
        $allCandidates = @($candidates) + @($backups)
        if ($TransientBackup) { $allCandidates += $TransientBackup }
        $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop)
        $tasks = @(Get-ScheduledTask -ErrorAction Stop)
        $configFiles = @(Get-ChildItem -LiteralPath (Join-Path $InstallRoot 'config') -File -Recurse | Where-Object { $_.Extension -in @('.json','.yaml','.toml') })
        foreach ($candidate in $allCandidates) {
            $candidateNormalized = $candidate.Replace('\','/')
            $candidateRelative = $candidateNormalized.Substring($InstallRoot.Length).TrimStart('/')
            $referenced = $false
            foreach ($process in $processes) { if ([string]$process.CommandLine -and ([string]$process.CommandLine).Replace('\','/').IndexOf($candidateNormalized,[StringComparison]::OrdinalIgnoreCase) -ge 0) { $referenced = $true } }
            foreach ($task in $tasks) { foreach ($action in $task.Actions) { if ((($action.PSObject.Properties | Where-Object Name -in @('Execute','Arguments','WorkingDirectory') | ForEach-Object Value) -join ' ').Replace('\','/').IndexOf($candidateNormalized,[StringComparison]::OrdinalIgnoreCase) -ge 0) { $referenced = $true } } }
            foreach ($file in $configFiles) { $text = [IO.File]::ReadAllText($file.FullName); if ($text.Replace('\\','\').Replace('\','/').IndexOf($candidateNormalized,[StringComparison]::OrdinalIgnoreCase) -ge 0 -or $text.Replace('\\','\').Replace('\','/').IndexOf($candidateRelative,[StringComparison]::OrdinalIgnoreCase) -ge 0) { $referenced = $true } }
            if ($retention.PSObject.Properties['pinned_paths']) { foreach ($pin in $retention.pinned_paths) { $full = [IO.Path]::GetFullPath([string]$pin).TrimEnd('\'); if ($candidate -ieq $full -or $candidate.StartsWith($full + '\',[StringComparison]::OrdinalIgnoreCase) -or $full.StartsWith($candidate + '\',[StringComparison]::OrdinalIgnoreCase)) { $referenced = $true } } }
            if ($referenced) { $result.unresolved += [pscustomobject]@{path=$candidate;reason='Active process, task, configuration consumer or explicit recovery pin.'} }
        }
        if ($result.unresolved.Count) { return [pscustomobject]$result }
        foreach ($candidate in $allCandidates) {
            $attempt = [pscustomobject]@{path=$candidate;original_present=$true;verified=$false}
            $result.attempted += $attempt
            $result.recycled += Invoke-AgentMemoryRetentionRecycle -Path $candidate -ProtectedPaths $protected -PackageJunctions:($candidates -contains $candidate)
            $attempt.original_present = $false; $attempt.verified = $true
        }
        $result.retained += $archive
        $result.status = if ($result.unresolved.Count) { 'incomplete' } else { 'disposed' }
    } catch { $result.error = $_.Exception.Message; foreach ($attempt in $result.attempted) { $attempt.original_present = Test-Path -LiteralPath $attempt.path } }
    finally { if ($lock) { $lock.Dispose() } }
    return [pscustomobject]$result
}
