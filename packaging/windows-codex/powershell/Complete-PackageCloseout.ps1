function Get-AgentMemoryPackageCloseoutBoundaryPolicy {
    return [pscustomobject]@{ Volume = 'D:\'; TaskRoot = 'D:\Workspace\scratch'; PrivateRoot = 'D:\Workspace\scratch\agentmemory' }
}

function Resolve-AgentMemoryPackageCloseoutBoundary {
    param([string]$Path, [ValidateSet('scratch','staging','private')][string]$Kind, [Parameter(Mandatory)]$Policy)
    if ($Path -notmatch '^[A-Za-z]:[\\/]' -or $Path.IndexOfAny([char[]]'*?[]') -ge 0) { return $null }
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if ([IO.Path]::GetPathRoot($full) -ine $Policy.Volume) { return $null }
    if ($Kind -eq 'scratch') {
        if ($full.Substring(3) -notmatch '^[^\\]+\\.+') { return $null }
        return $full
    }
    $uuid = '[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}'
    $base = if ($Kind -eq 'private') { [regex]::Escape($Policy.PrivateRoot.TrimEnd('\')) } else { [regex]::Escape($Policy.TaskRoot.TrimEnd('\')) + '\\[^\\]+' }
    $match = [regex]::Match($full, '(?i)^' + $base + '\\' + $uuid + '(?=\\|$)')
    if ($match.Success) { return $match.Value }
    return $null
}

function Complete-AgentMemoryPackageCloseout {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$ScratchDirectory,
        [Parameter(Mandatory)][string]$InstallRoot,
        [Parameter(Mandatory)][string[]]$RetirePackageRoots,
        [string[]]$ProtectedPackagePaths = @(),
        [string]$RecycleStagingDirectory = '',
        [switch]$ConsumersPublicationDiagnosisEnded,
        [switch]$Execute
    )
    $result = [ordered]@{ status='incomplete'; execute=[bool]$Execute; reviewed=@(); attempted=@(); recycled=@(); retained=@(); unresolved=@() }
    $handles = @()
    $recordHandles = @()
    $entries = @()
    $operationId=[Guid]::NewGuid().ToString('N')
    try {
        function Full-Path([string]$Path) {
            if ($Path -notmatch '^[A-Za-z]:[\\/]' -or $Path.IndexOfAny([char[]]'*?[]') -ge 0) { throw 'Closeout requires literal absolute paths.' }
            return [IO.Path]::GetFullPath($Path).TrimEnd('\')
        }
        function Within([string]$Child, [string]$Parent) {
            return $Child.StartsWith($Parent.TrimEnd('\') + '\',[StringComparison]::OrdinalIgnoreCase)
        }
        function Overlaps([string]$Left, [string]$Right) {
            return $Left -ieq $Right -or (Within $Left $Right) -or (Within $Right $Left)
        }
        function Read-Json([string]$Path) {
            Assert-AgentMemoryRetentionPath $Path
            if ((Get-Item -LiteralPath $Path).Length -gt 64MB) { throw "Oversize closeout evidence: $Path" }
            return ([IO.File]::ReadAllText($Path) | ConvertFrom-Json)
        }
        function Get-Consumers([string]$Package) {
            $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop)
            $current = @($processes | Where-Object ProcessId -eq $PID)
            if ($current.Count -ne 1 -or -not $current[0].CreationDate -or -not $current[0].CommandLine) { throw 'Current invocation process identity unavailable.' }
            $lineage = @{}
            $cursor = $current[0]
            while ($null -ne $cursor) {
                $lineage[[int]$cursor.ProcessId] = [string]$cursor.CreationDate
                $parent = @($processes | Where-Object ProcessId -eq $cursor.ParentProcessId)
                $cursor = if ($parent.Count -eq 1 -and $parent[0].CreationDate -and $parent[0].CreationDate -le $cursor.CreationDate) { $parent[0] } else { $null }
                if ($null -ne $cursor -and $lineage.ContainsKey([int]$cursor.ProcessId)) { break }
            }
            $needle = $Package.Replace('\','/')
            foreach ($process in $processes) {
                if ($lineage.ContainsKey([int]$process.ProcessId) -and $lineage[[int]$process.ProcessId] -ceq [string]$process.CreationDate) { continue }
                if (([string]$process.CommandLine).Replace('\','/').IndexOf($needle,[StringComparison]::OrdinalIgnoreCase) -ge 0) { throw "Active process consumer: $($process.ProcessId)" }
            }
            foreach ($task in @(Get-ScheduledTask -ErrorAction Stop)) {
                foreach ($action in $task.Actions) {
                    $text = ($action.PSObject.Properties | Where-Object Name -in @('Execute','Arguments','WorkingDirectory') | ForEach-Object Value) -join ' '
                    if ($text.Replace('\','/').IndexOf($needle,[StringComparison]::OrdinalIgnoreCase) -ge 0) { throw 'Scheduled task consumer remains.' }
                }
            }
            foreach ($file in @(Get-ChildItem -LiteralPath (Join-Path $installation 'config') -File -ErrorAction Stop | Where-Object Extension -in @('.json','.yaml','.toml'))) {
                Assert-AgentMemoryRetentionPath $file.FullName
                $content=[IO.File]::ReadAllText($file.FullName)
                if ($file.Name -ieq 'install-manifest.json') {
                    $manifestContent=$content|ConvertFrom-Json
                    if ($manifestContent.PSObject.Properties['private_package_retention'] -and $manifestContent.private_package_retention.schema_version -eq 1 -and $manifestContent.private_package_retention.policy -ceq 'private-install-candidate-rolling-v1') {
                        $manifestContent.PSObject.Properties.Remove('private_package_retention')
                        $content=$manifestContent|ConvertTo-Json -Depth 32
                    }
                }
                if ($content.Replace('\\','\').Replace('\','/').IndexOf($needle,[StringComparison]::OrdinalIgnoreCase) -ge 0) { throw "Configuration consumer remains: $($file.Name)" }
            }
        }
        function Get-PayloadProof([string]$Payload, $Manifest) {
            $expected = @{}
            $directories = @{}
            foreach ($file in @($Manifest.immutable_files)) {
                $relative = [string]$file.path
                if ($relative -notmatch '^(bin|config|licenses|runtime|scripts|src)/' -or $relative.Contains('\') -or
                    $relative -match '(^|/)\.\.?(/|$)' -or $expected.ContainsKey($relative) -or
                    $file.size_bytes -isnot [ValueType] -or $file.size_bytes -lt 0) { throw 'Invalid immutable package inventory.' }
                $expected[$relative] = [long]$file.size_bytes
                $parent = $relative
                while ($parent.Contains('/')) { $parent=$parent.Substring(0,$parent.LastIndexOf('/')); $directories[$parent+'/']=$true }
            }
            if (-not $expected.Count) { throw 'Empty immutable package inventory.' }
            $inventory = Get-AgentMemoryRetentionInventory -Path $Payload -PackageJunctions -TopologyOnly
            $count=0; $bytes=0L; $links=0; $maximumRelativeLength=0
            foreach ($relative in $inventory.Keys) {
                $maximumRelativeLength=[Math]::Max($maximumRelativeLength,$relative.Length)
                if ($inventory[$relative] -eq 'directory') {
                    if (-not $directories.ContainsKey($relative)) { throw "Undeclared package directory: $relative" }
                } elseif ($inventory[$relative].StartsWith('junction:',[StringComparison]::Ordinal)) {
                    if ($relative -notmatch '^runtime/[^/]+/agentmemory/node_modules/' -or
                        $inventory[$relative] -notmatch '^junction:runtime/[^/]+/agentmemory/node_modules/\.pnpm/') { throw "Unproven package junction: $relative" }
                    $links++
                } else {
                    if (-not $expected.ContainsKey($relative)) { throw "Undeclared package file: $relative" }
                    $length=(Get-Item -LiteralPath (Join-Path $Payload $relative) -Force).Length
                    if ($length -ne $expected[$relative]) { throw "Package file size changed: $relative" }
                    $count++; $bytes+=$length
                }
            }
            if ($count -ne $expected.Count) { throw 'Missing immutable package files.' }
            return [pscustomobject]@{files=$count; logical_bytes=$bytes; junctions=$links; maximum_relative_length=$maximumRelativeLength}
        }
        function Save-Record($Entry) {
            $attempt=@($result.attempted | Where-Object original -eq $Entry.payload | Select-Object -Last 1)
            $outcome=[ordered]@{
                operation_id=$operationId; at=[DateTime]::UtcNow.ToString('o')
                package=$Entry.package; payload=$Entry.payload
                source_commit=$Entry.manifest.source_commit; manifest_sha256=$Entry.manifest_hash
                files=$Entry.proof.files; logical_bytes=$Entry.proof.logical_bytes
                status=if($attempt.Count){$attempt[0].status}else{'not_attempted'}
                attempt=if($attempt.Count){$attempt[0]}else{$null}
            }
            $encoding=New-Object Text.UTF8Encoding($false)
            $raw=$encoding.GetString($Entry.record_bytes)
            $closing=$raw.LastIndexOf('}')
            if($closing -lt 0 -or $raw.Substring($closing).Trim() -cne '}'){throw 'Qualification root terminator is invalid.'}
            $prefixLength=$encoding.GetByteCount($raw.Substring(0,$closing))
            $addition=$encoding.GetBytes((',"package_closeout_'+$operationId+'":'+($outcome|ConvertTo-Json -Depth 20 -Compress)))
            $stream=$Entry.record_handle
            $stream.Position=$prefixLength
            $stream.Write($addition,0,$addition.Length)
            $stream.Write($Entry.record_bytes,$prefixLength,$Entry.record_bytes.Length-$prefixLength)
            $stream.SetLength($Entry.record_bytes.Length+$addition.Length)
            $stream.Flush($true)
        }
        $boundaryPolicy=Get-AgentMemoryPackageCloseoutBoundaryPolicy
        $scratch=Full-Path $ScratchDirectory
        $installation=Full-Path $InstallRoot
        if (-not (Resolve-AgentMemoryPackageCloseoutBoundary -Path $scratch -Kind scratch -Policy $boundaryPolicy) -or (Overlaps $scratch $installation)) { throw 'Use the exact D-owned task scratch boundary, separate from installation.' }
        Assert-AgentMemoryRetentionPath $scratch
        Assert-AgentMemoryRetentionPath $installation
        $installManifestPath=Join-Path $installation 'config\install-manifest.json'
        $live=Read-Json $installManifestPath
        $installHash=(Get-FileHash -LiteralPath $installManifestPath -Algorithm SHA256).Hash
        $previous=$live.upgrade_retention.immediate_predecessor
        if (-not $live.release_revision -or -not $previous.release_revision -or -not $live.upgrade_retention.recovery_archive) { throw 'Current release, actual predecessor and recovery archive are required.' }
        $protected=@($installation)
        $protected+=Full-Path ([string]$live.upgrade_retention.recovery_archive)
        if ($live.upgrade_retention.PSObject.Properties['pinned_paths']) { foreach($pin in $live.upgrade_retention.pinned_paths){$protected+=Full-Path ([string]$pin)} }
        foreach($pin in $ProtectedPackagePaths){$protected+=Full-Path $pin}
        foreach($path in $protected){ Assert-AgentMemoryRetentionPath $path }
        $stageParent=''
        if ($RecycleStagingDirectory) {
            $stageParent=Full-Path $RecycleStagingDirectory
            if (-not (Resolve-AgentMemoryPackageCloseoutBoundary -Path $stageParent -Kind staging -Policy $boundaryPolicy) -or
                [IO.Path]::GetPathRoot($stageParent) -ine [IO.Path]::GetPathRoot($scratch)) { throw 'Staging requires an explicit D task scratch on the same volume.' }
            foreach($path in $protected){if(Overlaps $stageParent $path){throw 'Staging overlaps a protected path.'}}
            Assert-AgentMemoryRetentionPath $stageParent
        }
        $seen=@{}
        $entries=@()
        foreach($inputRoot in $RetirePackageRoots) {
            $package=Full-Path $inputRoot
            if (-not (Within $package $scratch) -or $seen.ContainsKey($package)) { throw 'Repeated package or package outside declared scratch.' }
            foreach($prior in $seen.Keys){if(Overlaps $package $prior){throw 'Overlapping selected packages.'}}
            $seen[$package]=$true
            $payload=Join-Path $package 'payload'
            if (-not (Test-Path -LiteralPath $payload -PathType Container)) { throw "Payload absent; no disposal attempted: $payload" }
            Assert-AgentMemoryRetentionPath $package
            foreach($path in $protected){if(Overlaps $payload $path){throw "Protected package path: $payload"}}
            if($stageParent -and (Overlaps $package $stageParent)){throw 'Staging overlaps selected package.'}
            $manifestPath=Join-Path $package 'release-manifest.json'
            $manifest=Read-Json $manifestPath
            $qualificationPath=Join-Path ([IO.Path]::GetDirectoryName($package)) 'qualification.json'
            $qualification=Read-Json $qualificationPath
            $manifestHash=(Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash
            if ($manifest.build_kind -cne 'release_candidate' -or $manifest.tests_skipped -isnot [bool] -or $manifest.tests_skipped -ne $false -or
                $manifest.source_commit -notmatch '^[a-f0-9]{40}$' -or $manifest.source_input_digest -notmatch '^[a-f0-9]{64}$' -or
                $qualification.schema_version -ne 1 -or $qualification.tests_skipped -isnot [bool] -or $qualification.tests_skipped -ne $false -or
                $qualification.source_commit -cne $manifest.source_commit -or $qualification.source_input_digest -cne $manifest.source_input_digest -or
                $qualification.manifest_sha256 -ine $manifestHash) { throw "Unqualified or mismatched package is protected: $package" }
            if ($manifest.release_revision -in @($live.release_revision,$previous.release_revision)) { throw 'Current or actual predecessor package is protected.' }
            foreach($name in @('source','adapter','packaging')) {
                $suite=$qualification.suites.$name
                if ($suite.status -cne 'passed' -or $suite.passed -le 0 -or $suite.failed -ne 0 -or $suite.cancelled -ne 0 -or
                    $suite.total -ne ($suite.passed+$suite.skipped) -or ($name -eq 'packaging' -and $suite.skipped -ne 0)) { throw "Failed or incomplete qualification: $package" }
                $log=Full-Path ([string]$suite.log_path)
                if ([IO.Path]::GetDirectoryName($log) -ine [IO.Path]::GetDirectoryName($qualificationPath)) { throw 'Qualification log is outside its existing record directory.' }
                Assert-AgentMemoryRetentionPath $log
                if ($suite.log_sha256 -notmatch '^[a-fA-F0-9]{64}$' -or (Get-FileHash -LiteralPath $log -Algorithm SHA256).Hash -ine $suite.log_sha256) { throw 'Qualification log changed.' }
            }
            $proof=Get-PayloadProof $payload $manifest
            if ($stageParent -and $proof.junctions) { throw 'Short staging of absolute package junctions is unsupported; preserve package.' }
            Get-Consumers $package
            $entry=[pscustomobject]@{package=$package;payload=$payload;manifest=$manifest;manifest_path=$manifestPath;manifest_hash=$manifestHash;qualification=$qualification;qualification_path=$qualificationPath;qualification_hash=(Get-FileHash -LiteralPath $qualificationPath -Algorithm SHA256).Hash;proof=$proof;record_handle=$null;record_bytes=$null}
            $entries+=$entry
            $result.reviewed+=[pscustomobject]@{package=$package;payload=$payload;release_revision=$manifest.release_revision;source_commit=$manifest.source_commit;files=$proof.files;logical_bytes=$proof.logical_bytes}
        }
        if (-not $entries.Count) { throw 'Explicit package roots are required.' }
        if (-not $Execute) { $result.status='planned'; return [pscustomobject]$result }
        if (-not $ConsumersPublicationDiagnosisEnded) { throw 'Execution requires explicit completed consumer/publication/diagnosis review.' }
        $startupLockPath=Join-Path $installation 'data\startup.lock'
        Assert-AgentMemoryRetentionPath $startupLockPath
        $handles+=[IO.File]::Open($startupLockPath,'Open','ReadWrite','None')
        $installationHandle=[IO.File]::Open($installManifestPath,'Open','Read','Read')
        $handles+=$installationHandle
        if ((Get-FileHash -LiteralPath $installManifestPath -Algorithm SHA256).Hash -cne $installHash) { throw 'Installation metadata changed after review.' }
        foreach($entry in $entries) {
            $handle=[IO.File]::Open($entry.qualification_path,'Open','ReadWrite','None')
            $recordHandles+=$handle
            $handle.Position=0;$rawBytes=New-Object byte[] ([int]$handle.Length);[void]$handle.Read($rawBytes,0,$rawBytes.Length)
            $sha=[Security.Cryptography.SHA256]::Create()
            try{$hash=([BitConverter]::ToString($sha.ComputeHash($rawBytes))).Replace('-','')}finally{$sha.Dispose()}
            if($hash -ine $entry.qualification_hash){throw 'Qualification changed before exclusive record lock.'}
            $entry.record_handle=$handle
            $entry.record_bytes=$rawBytes
        }
        foreach($entry in $entries) {
            $attempt=[pscustomobject]@{original=$entry.payload;stage=$null;recycle_path=$null;receipt_path=$null;status='pending';restored=$false}
            $result.attempted+=$attempt
            try {
                if((Get-FileHash -LiteralPath $installManifestPath -Algorithm SHA256).Hash -cne $installHash -or
                    (Get-FileHash -LiteralPath $entry.manifest_path -Algorithm SHA256).Hash -cne $entry.manifest_hash){throw 'Identity changed before disposal.'}
                [void](Get-PayloadProof $entry.payload $entry.manifest)
                Get-Consumers $entry.package
                $target=$entry.payload
                if($stageParent){
                    Assert-AgentMemoryRetentionPath $stageParent
                    $attempt.stage=Join-Path $stageParent ([Guid]::NewGuid().ToString('N').Substring(0,8))
                    if((Test-Path -LiteralPath $attempt.stage) -or ($attempt.stage.Length+1+$entry.proof.maximum_relative_length) -ge 260){throw 'Short staging collision or path remains too long; preserve original.'}
                    foreach($path in $protected){if(Overlaps $attempt.stage $path){throw 'Protected staging path.'}}
                    Save-Record $entry
                    [IO.Directory]::Move($target,$attempt.stage)
                    $target=$attempt.stage
                }
                $attempt.status='recycling'
                Save-Record $entry
                $recycled=Invoke-AgentMemoryRetentionRecycle -Path $target -ProtectedPaths @($protected + $entry.manifest_path + $entry.qualification_path) -PackageJunctions
                $attempt.recycle_path=$recycled.recycle_path
                $attempt.receipt_path=$recycled.receipt_path
                if(Test-Path -LiteralPath $entry.payload){throw 'Original payload still present.'}
                $attempt.status='recycled'
                $result.recycled+=[pscustomobject]@{original=$entry.payload;stage=$attempt.stage;recycle_path=$recycled.recycle_path;receipt_path=$recycled.receipt_path;files=$entry.proof.files;logical_bytes=$entry.proof.logical_bytes;verified=$true}
                Save-Record $entry
            } catch {
                $attempt.status='uncertain';$attempt|Add-Member -NotePropertyName error -NotePropertyValue $_.Exception.Message
                if($attempt.stage -and (Test-Path -LiteralPath $attempt.stage -PathType Container) -and -not(Test-Path -LiteralPath $entry.payload)){
                    try{Assert-AgentMemoryRetentionPath $attempt.stage;[void](Get-PayloadProof $attempt.stage $entry.manifest);[IO.Directory]::Move($attempt.stage,$entry.payload);$attempt.restored=$true;$attempt.status='retained_after_failure'}catch{$attempt|Add-Member -NotePropertyName restore_error -NotePropertyValue $_.Exception.Message}
                }
                throw
            }
        }
        $result.status='disposed'
    } catch {
        $result.status='incomplete'
        $result.unresolved+=$_.Exception.Message
    } finally {
        if($Execute){
            foreach($entry in @($entries)){if($entry.record_handle){try{Save-Record $entry}catch{$result.status='incomplete';$result.unresolved+=("Closeout evidence write failed: "+$entry.qualification_path)}}}
        }
        foreach($handle in $recordHandles){$handle.Dispose()}
        foreach($handle in $handles){$handle.Dispose()}
    }
    return [pscustomobject]$result
}

function Write-AgentMemoryPrivateRetentionManifest {
    param([Parameter(Mandatory)][string]$Path,[Parameter(Mandatory)][string]$Content,[Parameter(Mandatory)][string]$ExpectedSha256)
    Assert-AgentMemoryRetentionPath $Path
    $temporary=Join-Path (Split-Path -Parent $Path) ('.agentmemory-private-'+[Guid]::NewGuid().ToString('N')+'.tmp')
    $created=$false;$stream=$null
    try {
        $stream=[IO.File]::Open($temporary,'CreateNew','Write','None');$created=$true
        $bytes=(New-Object Text.UTF8Encoding($false)).GetBytes($Content)
        $stream.Write($bytes,0,$bytes.Length);$stream.Flush($true);$stream.Dispose();$stream=$null
        if((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -cne $ExpectedSha256){throw 'Private manifest input changed before atomic replacement.'}
        [IO.File]::Replace($temporary,$Path,[NullString]::Value)
    }finally{
        if($stream){$stream.Dispose()}
        if($created -and (Test-Path -LiteralPath $temporary)){[IO.File]::Delete($temporary)}
    }
}

function Complete-AgentMemoryPrivatePackageCloseout {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$InstallRoot, [Parameter(Mandatory)][string]$ReleaseRoot)
    $result=[ordered]@{status='incomplete';registered=@();retained=@();recycled=@();reconciled=@();closeouts=@();unresolved=@()}
    $policy='private-install-candidate-rolling-v1'
    $boundaryPolicy=Get-AgentMemoryPackageCloseoutBoundaryPolicy
    $state=[pscustomobject]@{stamp='';nonce='';revision='';history=$null}
    try {
        function Full-PrivatePath([string]$Path) {
            if($Path -notmatch '^[A-Za-z]:[\\/]' -or $Path.IndexOfAny([char[]]'*?[]') -ge 0){throw 'Private candidate requires literal absolute paths.'}
            $full=[IO.Path]::GetFullPath($Path).TrimEnd('\')
            Assert-AgentMemoryRetentionPath $full
            return $full
        }
        function Read-PrivateJson([string]$Path) {
            Assert-AgentMemoryRetentionPath $Path
            if((Get-Item -LiteralPath $Path).Length -gt 64MB){throw 'Oversize private candidate evidence.'}
            return ([IO.File]::ReadAllText($Path)|ConvertFrom-Json)
        }
        function Read-PrivateCandidate([string]$Package) {
            $packagePath=Full-PrivatePath $Package
            $qp=Join-Path (Split-Path -Parent $packagePath) 'qualification.json'
            $q=Read-PrivateJson $qp
            $life=$q.storage_lifecycle
            $scratch=Full-PrivatePath ([string]$life.scratch_directory)
            if($life.schema_version -ne 1 -or $life.policy -cne $policy -or $life.private_not_published -isnot [bool] -or -not $life.private_not_published -or $life.pinned -isnot [bool] -or
                -not (Resolve-AgentMemoryPackageCloseoutBoundary -Path $scratch -Kind private -Policy $boundaryPolicy) -or
                (Full-PrivatePath ([string]$life.release_root)) -ine $packagePath -or -not $packagePath.StartsWith($scratch+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Unknown or mismatched private candidate declaration.'}
            $mp=Join-Path $packagePath 'release-manifest.json'
            $m=Read-PrivateJson $mp
            $hash=(Get-FileHash -LiteralPath $mp -Algorithm SHA256).Hash
            if($m.build_kind -cne 'release_candidate' -or $m.tests_skipped -isnot [bool] -or $m.tests_skipped -or $q.schema_version -ne 1 -or $q.tests_skipped -isnot [bool] -or $q.tests_skipped -or
                $m.source_commit -notmatch '^[a-f0-9]{40}$' -or $m.source_input_digest -notmatch '^[a-f0-9]{64}$' -or $q.source_commit -cne $m.source_commit -or
                $q.source_input_digest -cne $m.source_input_digest -or $q.manifest_sha256 -ine $hash){throw 'Private candidate qualification identity differs.'}
            foreach($name in @('source','adapter','packaging')) {
                $suite=$q.suites.$name
                $log=Full-PrivatePath ([string]$suite.log_path)
                if($suite.status -cne 'passed' -or $suite.passed -le 0 -or $suite.failed -ne 0 -or $suite.cancelled -ne 0 -or $suite.total -ne ($suite.passed+$suite.skipped) -or
                    ($name -eq 'packaging' -and $suite.skipped -ne 0) -or (Split-Path -Parent $log) -ine (Split-Path -Parent $qp) -or
                    (Get-FileHash -LiteralPath $log -Algorithm SHA256).Hash -ine $suite.log_sha256){throw 'Private candidate suite proof differs.'}
            }
            return [pscustomobject]@{qualification=$q;qualification_path=$qp;entry=[pscustomobject]@{release_root=$packagePath;scratch_directory=$scratch;release_revision=$m.release_revision;source_commit=$m.source_commit;manifest_sha256=$hash;pinned=$life.pinned;accepted_at_utc=[DateTime]::UtcNow.ToString('o');disposition='accepted';last_closeout=$null}}
        }
        function Save-PrivateHistory {
            $held=$null
            try {
                $held=[IO.File]::Open((Join-Path $installation 'data/startup.lock'),'OpenOrCreate','ReadWrite','None')
                if((Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash -cne $state.stamp){throw 'Installation changed during private source closeout; metadata was not overwritten.'}
                $live=Read-PrivateJson $manifestPath
                if($live.install_nonce -cne $state.nonce -or $live.release_revision -cne $state.revision){throw 'Accepted installation changed.'}
                $live|Add-Member -NotePropertyName private_package_retention -NotePropertyValue $state.history -Force
                Write-AgentMemoryPrivateRetentionManifest -Path $manifestPath -Content ($live|ConvertTo-Json -Depth 32) -ExpectedSha256 $state.stamp
                $state.stamp=(Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash
            }finally{if($held){$held.Dispose()}}
        }
        $installation=Full-PrivatePath $InstallRoot
        $source=Full-PrivatePath $ReleaseRoot
        $manifestPath=Join-Path $installation 'config/install-manifest.json'
        $held=$null
        try {
            $held=[IO.File]::Open((Join-Path $installation 'data/startup.lock'),'OpenOrCreate','ReadWrite','None')
            $live=Read-PrivateJson $manifestPath
            $state.stamp=(Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash
            $state.nonce=[string]$live.install_nonce;$state.revision=[string]$live.release_revision
            $owner=Read-PrivateJson (Join-Path $installation '.agentmemory-install-owner.json')
            if(-not $state.nonce -or $owner.install_nonce -cne $state.nonce -or $live.installation_status -cne 'activated' -or [IO.Path]::GetFullPath([string]$live.install_root).TrimEnd('\') -ine $installation){throw 'Private source acceptance requires the active owned installation.'}
            if($live.PSObject.Properties['private_package_retention']){
                $state.history=$live.private_package_retention
                if($state.history.schema_version -ne 1 -or $state.history.policy -cne $policy -or $null -eq $state.history.packages){throw 'Unknown private package history is protected.'}
            }else{$state.history=[pscustomobject]@{schema_version=1;policy=$policy;packages=@()}}
        }finally{if($held){$held.Dispose()}}
        $qp=Join-Path (Split-Path -Parent $source) 'qualification.json'
        $candidate=$null
        if(Test-Path -LiteralPath $qp -PathType Leaf){$q=Read-PrivateJson $qp;if($q.PSObject.Properties['storage_lifecycle']){$candidate=Read-PrivateCandidate $source}}
        if($candidate){
            if($candidate.entry.release_revision -cne $state.revision -or $candidate.entry.manifest_sha256 -ine $live.release_manifest_sha256){throw 'Private candidate was not the accepted installed release.'}
            $existing=@($state.history.packages|Where-Object release_root -IEQ $source)
            if($existing.Count -gt 1){throw 'Duplicate private acceptance identity.'}
            if($existing.Count){if($existing[0].manifest_sha256 -ine $candidate.entry.manifest_sha256 -or $existing[0].source_commit -cne $candidate.entry.source_commit){throw 'Accepted private source identity changed.'}}
            else{$state.history.packages+=@($candidate.entry);$result.registered+=@($source)}
        }
        if(-not $state.history.packages.Count){$result.status='not_applicable';return [pscustomobject]$result}
        Save-PrivateHistory
        $previous=if($live.PSObject.Properties['upgrade_retention']){[string]$live.upgrade_retention.immediate_predecessor.release_revision}else{''}
        $seen=@{}
        $eligible=@()
        foreach($entry in @($state.history.packages)){
            $path=Full-PrivatePath ([string]$entry.release_root)
            if($seen.ContainsKey($path)){throw 'Duplicate private source history.'};$seen[$path]=$true
            $proof=Read-PrivateCandidate $path
            foreach($key in @('release_root','scratch_directory','release_revision','source_commit','manifest_sha256')){if([string]$entry.$key -ine [string]$proof.entry.$key){throw 'Stored private candidate identity changed.'}}
            if($entry.pinned -isnot [bool] -or $entry.disposition -notin @('accepted','pending','incomplete','disposed')){throw 'Unknown private candidate state is protected.'}
            if($entry.pinned -or $proof.entry.pinned -or $entry.release_revision -in @($state.revision,$previous)){$result.retained+=@($path);continue}
            $payloadPath=Join-Path $path 'payload'
            $outcomes=@($proof.qualification.PSObject.Properties|Where-Object Name -Like 'package_closeout_*'|ForEach-Object Value|Where-Object {$_.package -ieq $path -and $_.manifest_sha256 -ieq $entry.manifest_sha256 -and $_.source_commit -ceq $entry.source_commit})
            $completed=@($outcomes|Where-Object {$_.status -ceq 'recycled' -and $_.attempt.original -ieq $payloadPath -and $_.attempt.recycle_path -and $_.attempt.PSObject.Properties['receipt_path'] -and $_.attempt.receipt_path})
            if(-not(Test-Path -LiteralPath $payloadPath)){
                if($completed.Count -ne 1){throw 'Absent private payload has no unique completed closeout receipt.'}
                if($entry.disposition -ne 'disposed'){$entry.disposition='disposed';$entry.last_closeout=$completed[0];Save-PrivateHistory}
                $result.reconciled+=@($completed[0]);continue
            }
            if($entry.disposition -eq 'disposed' -or $completed.Count -or @($outcomes|Where-Object status -in @('pending','recycling','uncertain')).Count){throw 'Private payload closeout outcome is uncertain; no retry attempted.'}
            if(-not $previous){$result.retained+=@($path);continue}
            $eligible+=@($entry)
        }
        foreach($entry in $eligible){
            $stage=''
            $stageCreated=$false
            $topology=Get-AgentMemoryRetentionInventory -Path (Join-Path $entry.release_root 'payload') -PackageJunctions -TopologyOnly
            if(-not @($topology.Values|Where-Object {$_ -like 'junction:*'}).Count){
                $declaredScratch=if($candidate){$candidate.entry.scratch_directory}else{$entry.scratch_directory}
                $stageOwner=Resolve-AgentMemoryPackageCloseoutBoundary -Path $declaredScratch -Kind private -Policy $boundaryPolicy
                if(-not $stageOwner){throw 'Private staging requires the declared AgentMemory task boundary.'}
                Assert-AgentMemoryRetentionPath $stageOwner
                $stage=Join-Path $stageOwner 's'
                if(-not(Test-Path -LiteralPath $stage)){
                    [void](New-Item -ItemType Directory -Path $stage -ErrorAction Stop)
                    $stageCreated=$true
                }
                Assert-AgentMemoryRetentionPath $stage
            }
            $entry.disposition='pending';$entry.last_closeout=[pscustomobject]@{status='pending';staging_directory=$stage};Save-PrivateHistory
            $closeout=Complete-AgentMemoryPackageCloseout -ScratchDirectory $entry.scratch_directory -InstallRoot $installation -RetirePackageRoots @($entry.release_root) -RecycleStagingDirectory $stage -ConsumersPublicationDiagnosisEnded -Execute
            $entry.last_closeout=$closeout;$entry.disposition=if($closeout.status -eq 'disposed'){'disposed'}else{'incomplete'}
            $result.closeouts+=@($closeout);$result.recycled+=@($closeout.recycled)
            Save-PrivateHistory
            if($closeout.status -ne 'disposed'){throw 'Private package payload closeout is incomplete.'}
            if($stageCreated){
                Assert-AgentMemoryRetentionPath $stage
                try{[IO.Directory]::Delete($stage)}catch{throw ("Private staging closeout incomplete: $stage. "+$_.Exception.Message)}
                if((Test-Path -LiteralPath $stage) -or -not(Test-Path -LiteralPath $stageOwner -PathType Container)){throw ("Private staging cleanup verification failed: $stage" )}
            }
        }
        $result.status='disposed'
    }catch{$result.unresolved+=@($_.Exception.Message)}
    return [pscustomobject]$result
}
