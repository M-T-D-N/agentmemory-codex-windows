param([Parameter(Mandatory=$true)][string]$ScratchRoot)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$product = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $product 'powershell\agentmemory-layout.ps1')
. (Join-Path $product 'powershell\agentmemory-upgrade-retention.ps1')
$root = Join-Path ([IO.Path]::GetFullPath($ScratchRoot)) ('install-contracts-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($root)
$started = [DateTime]::UtcNow.ToString('o')
$cases = [Collections.Generic.List[object]]::new()
$childReceipts = [Collections.Generic.List[object]]::new()
function Check([bool]$Value, [string]$Message) { if (-not $Value) { throw $Message } }
function Reject([scriptblock]$Action, [string]$Pattern) {
    $failure = $null
    try { & $Action | Out-Null } catch { $failure = $_.Exception.Message }
    Check ($null -ne $failure -and $failure -match $Pattern) ('Expected rejection: ' + $Pattern)
}
function Case([string]$Name, [scriptblock]$Action) {
    try { & $Action; $cases.Add([ordered]@{name=$Name;status='passed'}) }
    catch { $cases.Add([ordered]@{name=$Name;status='failed';error=$_.Exception.Message}); throw }
}
function Put([string]$Relative, [string]$Value) {
    $path = Join-Path $root $Relative
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $path))
    [IO.File]::WriteAllText($path,$Value,[Text.UTF8Encoding]::new($false))
}
$install = Join-Path $root 'installation'
$backup = Join-Path $root 'cold-copy'
$saved = @{}
foreach ($name in @('AGENTMEMORY_NODE_PATH','AGENTMEMORY_PACKAGE_DIR','AGENTMEMORY_RUNTIME_VERSION')) {
    $saved[$name] = [Environment]::GetEnvironmentVariable($name,'Process')
    [Environment]::SetEnvironmentVariable($name,$null,'Process')
}
try {
    Check ($env:AGENTMEMORY_INTEGRATION -eq '0' -and $env:AGENTMEMORY_CURATE -eq '0') 'Live gates must be disabled'
    [void][IO.Directory]::CreateDirectory($install)
    [void][IO.Directory]::CreateDirectory($backup)
    Case 'empty install uses distinct documented default ports' {
        $ports = Get-AgentMemoryServicePorts -Root $install
        Check ($ports.rest -eq 3111 -and $ports.engine -eq 49134) 'Unexpected default ports'
        Check (@($ports.PSObject.Properties.Value | Select-Object -Unique).Count -eq 5) 'Duplicate defaults'
    }
    Case 'managed update retains configured ports and refuses duplicate endpoints' {
        Put 'installation/config/codex-workspace.json' '{"service_ports":{"rest":3201,"stream":3202,"viewer":3203,"mcp":3204,"engine":49234}}'
        Check ((Get-AgentMemoryServicePorts -Root $install).rest -eq 3201) 'Configured port lost'
        Put 'installation/config/codex-workspace.json' '{"service_ports":{"rest":3201,"stream":3201,"viewer":3203,"mcp":3204,"engine":49234}}'
        Reject { Get-AgentMemoryServicePorts -Root $install } 'must be distinct'
        Put 'installation/config/codex-workspace.json' '{"service_ports":{"rest":3201,"stream":3202,"viewer":3203,"mcp":3204,"engine":49234}}'
    }
    $manifest = [pscustomobject]@{install_nonce='synthetic-owner';release_revision='r701';data_contract_version=5;package_relative_path='runtime/r701/agentmemory';node_path='C:\synthetic\node.exe';agentmemory_version='0.9.30'}
    Put 'installation/config/install-manifest.json' ($manifest | ConvertTo-Json)
    Case 'manifest selects predecessor package; missing runtime identity is rejected' {
        $layout = Resolve-AgentMemoryLayout -Root $install -NodePath 'C:\synthetic\node.exe'
        Check ($layout.PackageRoot -eq (Join-Path $install 'runtime\r701\agentmemory')) 'Manifest package selection lost'
        $empty = Join-Path $root 'empty-install'; [void][IO.Directory]::CreateDirectory($empty)
        Reject { Resolve-AgentMemoryLayout -Root $empty -NodePath 'C:\synthetic\node.exe' } 'version is missing'
    }
    Put 'installation/.agentmemory-install-owner.json' '{"install_nonce":"synthetic-owner"}'
    Put 'installation/config/secret.dpapi' 'synthetic-opaque-bytes-not-real-authentication'
    Put 'installation/data/synthetic-state.txt' 'synthetic state v1'
    Put 'installation/data/startup.lock' 'synthetic lock excluded from recovery'
    Put 'installation/home/synthetic-settings.txt' 'synthetic home'
    Put 'installation/scripts/synthetic-code.txt' 'synthetic code'
    Case 'cold recovery preserves synthetic config data home and code while excluding startup lock' {
        New-AgentMemoryColdRecovery -InstallRoot $install -BackupRoot $backup -PreviousManifest $manifest -IncludeData
        $recovered = Read-AgentMemoryColdRecoveryDirectory -Path $backup -Nonce 'synthetic-owner'
        Check ($null -ne $recovered) 'Cold copy not accepted'
        foreach ($relative in @('data/synthetic-state.txt','home/synthetic-settings.txt','scripts/synthetic-code.txt')) {
            Check ([IO.File]::ReadAllText((Join-Path $backup $relative)) -ceq [IO.File]::ReadAllText((Join-Path $install $relative))) 'Recovery bytes differ'
        }
        Check (-not (Test-Path -LiteralPath (Join-Path $backup 'data/startup.lock'))) 'Startup lock copied'
    }
    Case 'foreign ownership and later byte corruption cannot qualify as recovery' {
        Reject { Read-AgentMemoryColdRecoveryDirectory -Path $backup -Nonce 'foreign-synthetic-owner' } 'identity mismatch'
        Put 'cold-copy/data/synthetic-state.txt' 'synthetic corrupted state'
        Reject { Read-AgentMemoryColdRecoveryDirectory -Path $backup -Nonce 'synthetic-owner' } 'bytes changed'
        Check ([IO.File]::ReadAllText((Join-Path $install 'data/synthetic-state.txt')) -ceq 'synthetic state v1') 'Source data changed'
    }
    Case 'incomplete cold copy never publishes a completed recovery descriptor' {
        $partial = Join-Path $root 'incomplete'; $partialBackup = Join-Path $root 'incomplete-copy'
        [void][IO.Directory]::CreateDirectory($partial); [void][IO.Directory]::CreateDirectory($partialBackup)
        Put 'incomplete/data/synthetic-state.txt' 'synthetic incomplete'
        Reject { New-AgentMemoryColdRecovery -InstallRoot $partial -BackupRoot $partialBackup -PreviousManifest $manifest -IncludeData } 'Required recovery input is missing'
        Check (-not (Test-Path -LiteralPath (Join-Path $partialBackup 'recovery-set.json'))) 'Incomplete copy published'
    }
    $tokens=$null; $errors=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $product 'Install-WindowsCodex.ps1'),[ref]$tokens,[ref]$errors)
    Check ($errors.Count -eq 0) 'Installer syntax invalid'
    foreach($name in @('Write-Utf8NoBom','Set-ObjectProperty','Invoke-RollbackRestoration','Write-CutoverOutcome')) {
        $fn=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$false))
        Check ($fn.Count -eq 1) 'Rollback helper is ambiguous'
        . ([scriptblock]::Create($fn[0].Extent.Text))
    }
    $original=$null;try{throw 'synthetic original copy failure'}catch{$original=$_}
    Case 'rollback write lock preserves original error restoration error phase and stopped state' {
        Put 'restore-target.txt' 'synthetic predecessor'
        $path=Join-Path $root 'restore-target.txt'
        $locked=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
        $state=[pscustomobject]@{installation_status='cutover'}
        $statePath=Join-Path $root 'failed-install.json'
        try {
            Reject { Invoke-RollbackRestoration -OriginalFailure $original -Phase 'copy-adapter' -BackupRoot $backup -Installed $state -InstallManifestPath $statePath -Action { [IO.File]::WriteAllText($path,'synthetic restored') } } 'Original \(copy-adapter\): synthetic original copy failure.*Restore:'
        } finally {$locked.Dispose()}
        $recorded=Get-Content -LiteralPath $statePath -Raw|ConvertFrom-Json
        Check ($recorded.installation_status -ceq 'rollback_failed') 'False rollback success'
        Check ($recorded.cutover_failure.original_error -ceq $original.Exception.Message) 'Original failure lost'
        Check ($recorded.cutover_failure.restore_error -and $recorded.cutover_failure.runtime_stopped -and $recorded.cutover_failure.backup_root -ceq $backup) 'Recovery diagnostic incomplete'
        Check ([IO.File]::ReadAllText($path) -ceq 'synthetic predecessor') 'Locked data changed'
    }
    Case 'failure-state write error does not hide either original or restoration error' {
        $state=[pscustomobject]@{installation_status='cutover'}
        Reject { Invoke-RollbackRestoration -OriginalFailure $original -Phase 'copy-adapter' -BackupRoot $backup -Installed $state -InstallManifestPath (Join-Path $root 'absent-parent/install.json') -Action {throw 'synthetic restore failure'} } 'Original.*synthetic original copy failure.*Restore: synthetic restore failure.*Failure-state write also failed:'
    }
    Case 'successful restoration does not publish a failed state' {
        $state=[pscustomobject]@{installation_status='cutover'}
        $statePath=Join-Path $root 'not-created.json'
        Invoke-RollbackRestoration -OriginalFailure $original -Phase 'copy-adapter' -BackupRoot $backup -Installed $state -InstallManifestPath $statePath -Action { [IO.File]::WriteAllText((Join-Path $root 'restored.txt'),'synthetic restored') }
        Check (-not(Test-Path -LiteralPath $statePath)) 'Success wrote a failure descriptor'
    }
    Case 'automatic rollback records original error and preserves predecessor identity only with readiness' {
        $state=[pscustomobject]@{installation_status='activated';release_revision='synthetic-predecessor'}
        $statePath=Join-Path $root 'automatic-rollback.json'
        Write-CutoverOutcome -Installed $state -InstallManifestPath $statePath -OriginalFailure $original -Phase 'copy-adapter' -BackupRoot $backup -Outcome 'automatic_rollback' -RestorationCompleted $true -RuntimeReady $true -RuntimeStopped $false
        $recorded=Get-Content -LiteralPath $statePath -Raw|ConvertFrom-Json
        Check ($recorded.installation_status -ceq 'activated' -and $recorded.release_revision -ceq 'synthetic-predecessor') 'Predecessor identity changed'
        Check ($recorded.cutover_failure.original_error -ceq $original.Exception.Message -and $recorded.cutover_failure.original_error_id -ceq $original.FullyQualifiedErrorId) 'Original error identity lost'
        Check ($recorded.cutover_failure.runtime_ready -and $recorded.cutover_failure.restoration_completed -and -not $recorded.cutover_failure.runtime_stopped) 'Incorrect automatic rollback outcome'
    }
    Case 'incomplete automatic rollback cannot publish success' {
        $state=[pscustomobject]@{installation_status='cutover'}
        $statePath=Join-Path $root 'incomplete-automatic.json'
        foreach($flags in @(@($false,$true),@($true,$false))) {
            Reject { Write-CutoverOutcome -Installed $state -InstallManifestPath $statePath -OriginalFailure $original -Phase 'copy-adapter' -BackupRoot $backup -Outcome 'automatic_rollback' -RestorationCompleted $flags[0] -RuntimeReady $flags[1] -RuntimeStopped $false } 'requires restoration and fresh readiness'
        }
        Check (-not [IO.File]::Exists($statePath)) 'Incomplete restoration published success'
    }
    Case 'withheld stop and restored files with failed restart remain different outcomes' {
        foreach($outcome in @('rollback_withheld','rollback_failed')) {
            $state=[pscustomobject]@{installation_status='cutover'}
            $statePath=Join-Path $root ($outcome+'.json')
            Write-CutoverOutcome -Installed $state -InstallManifestPath $statePath -OriginalFailure $original -Phase 'copy-adapter' -BackupRoot $backup -Outcome $outcome -RestorationCompleted ($outcome -eq 'rollback_failed') -RuntimeReady $false -RuntimeStopped $false -RestoreError 'synthetic restart or stop error'
            $recorded=Get-Content -LiteralPath $statePath -Raw|ConvertFrom-Json
            Check ($recorded.cutover_failure.outcome -ceq $outcome -and -not $recorded.cutover_failure.runtime_stopped -and -not $recorded.cutover_failure.runtime_ready) 'Unconfirmed stop/readiness promoted'
            Check ($recorded.cutover_failure.restore_error -ceq 'synthetic restart or stop error') 'Restoration error lost'
        }
    }
    Case 'outcome write failure keeps original and restart error' {
        $state=[pscustomobject]@{installation_status='cutover'}
        Reject { Write-CutoverOutcome -Installed $state -InstallManifestPath (Join-Path $root 'missing-outcome-parent/manifest.json') -OriginalFailure $original -Phase 'copy-adapter' -BackupRoot $backup -Outcome 'rollback_failed' -RestorationCompleted $true -RuntimeReady $false -RuntimeStopped $true -RestoreError 'synthetic restart error' } 'Original.*synthetic original copy failure.*Restore: synthetic restart error.*State:'
    }
    function New-RetentionFixture {
        $base = Join-Path $root ('retention-' + [guid]::NewGuid().ToString('N'))
        foreach ($name in @('config','data','home','scripts','backups/releases','runtime/0.9.30-codex-r701/agentmemory','runtime/0.9.30-codex-r702/agentmemory')) {
            [void][IO.Directory]::CreateDirectory((Join-Path $base $name))
        }
        $state = [pscustomobject]@{install_nonce='synthetic-retention-owner';install_root=$base;release_revision='r701';data_contract_version=5;package_relative_path='runtime/0.9.30-codex-r701/agentmemory';installation_status='activated'}
        $manifestPath = Join-Path $base 'config/install-manifest.json'
        Write-Utf8NoBom $manifestPath ($state | ConvertTo-Json -Depth 12)
        Write-Utf8NoBom (Join-Path $base '.agentmemory-install-owner.json') '{"install_nonce":"synthetic-retention-owner"}'
        Write-Utf8NoBom (Join-Path $base 'config/secret.dpapi') 'synthetic opaque bytes; no DPAPI call or real credential'
        Write-Utf8NoBom (Join-Path $base 'data/memory.txt') 'synthetic memory preserved'
        $code = Join-Path $base 'scripts/code.txt'
        Write-Utf8NoBom $code 'synthetic predecessor code'
        $failed = Join-Path $base 'backups/releases/20260101T010101001Z'
        [void][IO.Directory]::CreateDirectory($failed)
        New-AgentMemoryColdRecovery -InstallRoot $base -BackupRoot $failed -PreviousManifest $state -IncludeData
        $copyFailure = $null
        $handle = [IO.File]::Open($code,'Open','Read','Read')
        try { try { [IO.File]::WriteAllText($code,'synthetic candidate') } catch { $copyFailure = $_ } } finally { $handle.Dispose() }
        Check ($null -ne $copyFailure) 'Synthetic pre-start write unexpectedly succeeded'
        Invoke-RollbackRestoration -OriginalFailure $copyFailure -Phase 'copy-adapter' -BackupRoot $failed -Installed $state -InstallManifestPath $manifestPath -Action { [IO.File]::Copy((Join-Path $failed 'scripts/code.txt'),$code,$true) }
        Write-CutoverOutcome -Installed $state -InstallManifestPath $manifestPath -OriginalFailure $copyFailure -Phase 'copy-adapter' -BackupRoot $failed -Outcome 'automatic_rollback' -RestorationCompleted $true -RuntimeReady $true -RuntimeStopped $false
        $failureBefore = $state.cutover_failure | ConvertTo-Json -Depth 8 -Compress
        $next = Join-Path $base 'new-cold-copy'; [void][IO.Directory]::CreateDirectory($next)
        New-AgentMemoryColdRecovery -InstallRoot $base -BackupRoot $next -PreviousManifest $state -IncludeData
        Add-Type -AssemblyName System.IO.Compression
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $archive = Join-Path $base 'backups/releases/20260101T010102001Z.zip'
        $zip = [IO.Compression.ZipFile]::Open($archive,[IO.Compression.ZipArchiveMode]::Create)
        try {
            $inventory = Get-AgentMemoryRetentionInventory $next
            foreach ($relative in $inventory.Keys) {
                if ($relative.EndsWith('/')) { [void]$zip.CreateEntry($relative) }
                else { [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,(Join-Path $next $relative),$relative) }
            }
        } finally { $zip.Dispose() }
        Set-ObjectProperty $state 'upgrade_retention' ([pscustomobject]@{immediate_predecessor=[pscustomobject]@{release_revision='r701';data_contract_version=5;package_relative_path=$state.package_relative_path};recovery_archive=$archive;recovery_sha256=(Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash})
        $state.release_revision='r702';$state.package_relative_path='runtime/0.9.30-codex-r702/agentmemory'
        Write-Utf8NoBom $code 'synthetic recovered candidate code'
        Write-Utf8NoBom $manifestPath ($state | ConvertTo-Json -Depth 12)
        return [pscustomobject]@{root=$base;manifest=$state;manifest_path=$manifestPath;failed=$failed;failure_before=$failureBefore}
    }
    function Refresh-FailureInventory($Fixture,[string]$Relative) {
        $path=Join-Path $Fixture.failed 'recovery-set.json'
        $record=Get-Content -LiteralPath $path -Raw -Encoding UTF8|ConvertFrom-Json
        $record.files.PSObject.Properties[$Relative].Value=(Get-FileHash -LiteralPath (Join-Path $Fixture.failed $Relative) -Algorithm SHA256).Hash
        Write-Utf8NoBom $path ($record|ConvertTo-Json -Depth 12)
    }
    function Get-CimInstance { @() }
    function Get-ScheduledTask { @() }
    function Invoke-AgentMemoryRetentionRecycle { throw 'Synthetic retention must not recycle any resource' }
    Case 'synthetic pre-start rollback then recovered candidate retains exact failed cold evidence' {
        $fixture=New-RetentionFixture
        $result=Complete-AgentMemoryAutomaticRetention -InstallRoot $fixture.root -CurrentManifest $fixture.manifest
        Check ($result.status -ceq 'disposed' -and $result.unresolved.Count -eq 0 -and $result.attempted.Count -eq 0) ('Retention incomplete: '+($result|ConvertTo-Json -Depth 5 -Compress))
        Check ($result.retained -contains $fixture.failed -and (Test-Path -LiteralPath $fixture.failed)) 'Failure evidence was not retained'
        $after=Get-Content -LiteralPath $fixture.manifest_path -Raw -Encoding UTF8|ConvertFrom-Json
        Check (($after.cutover_failure|ConvertTo-Json -Depth 8 -Compress) -ceq $fixture.failure_before) 'Original failure record changed'
        Check ([IO.File]::ReadAllText((Join-Path $fixture.root 'data/memory.txt')) -ceq 'synthetic memory preserved') 'Synthetic memory changed'
        [void](Read-AgentMemoryColdRecoveryDirectory -Path $fixture.failed -Nonce $fixture.manifest.install_nonce)
    }
    foreach ($variant in @('foreign-nonce','outside-path','reparse','changed-bytes','missing-file','missing-directory','unreferenced-directory','unproven-outcome','foreign-owner','relocated-snapshot','transient')) {
        Case ('failure evidence remains HOLD for '+$variant) {
            $fixture=New-RetentionFixture; $link=$null; $transient=''
            switch ($variant) {
                'foreign-nonce' {
                    $path=Join-Path $fixture.failed 'recovery-set.json';$record=Get-Content -LiteralPath $path -Raw -Encoding UTF8|ConvertFrom-Json
                    $record.install_nonce='foreign';Write-Utf8NoBom $path ($record|ConvertTo-Json -Depth 12)
                }
                'outside-path' { $fixture.manifest.cutover_failure.backup_root=Join-Path $root 'outside-evidence' }
                'reparse' {
                    $link=Join-Path $fixture.root 'backups/releases/20260101T010103001Z'
                    [void](New-Item -ItemType Junction -Path $link -Target $fixture.failed)
                    $fixture.manifest.cutover_failure.backup_root=$link
                }
                'changed-bytes' { Write-Utf8NoBom (Join-Path $fixture.failed 'data/memory.txt') 'synthetic changed' }
                'missing-file' { [IO.File]::Delete((Join-Path $fixture.failed 'data/memory.txt')) }
                'missing-directory' { $fixture.manifest.cutover_failure.backup_root=Join-Path $fixture.root 'backups/releases/20260101T010104001Z' }
                'unreferenced-directory' { [void][IO.Directory]::CreateDirectory((Join-Path $fixture.root 'backups/releases/20260101T010105001Z')) }
                'unproven-outcome' { $fixture.manifest.cutover_failure.runtime_ready=$false }
                'foreign-owner' { Write-Utf8NoBom (Join-Path $fixture.failed '.agentmemory-install-owner.json') '{"install_nonce":"foreign"}';Refresh-FailureInventory $fixture '.agentmemory-install-owner.json' }
                'relocated-snapshot' {
                    $path=Join-Path $fixture.failed 'config/install-manifest.json';$record=Get-Content -LiteralPath $path -Raw -Encoding UTF8|ConvertFrom-Json
                    $record.install_root=Join-Path $root 'other-install';Write-Utf8NoBom $path ($record|ConvertTo-Json -Depth 12);Refresh-FailureInventory $fixture 'config/install-manifest.json'
                }
                'transient' { $transient=$fixture.failed }
            }
            Write-Utf8NoBom $fixture.manifest_path ($fixture.manifest|ConvertTo-Json -Depth 12)
            try {
                $result=Complete-AgentMemoryAutomaticRetention -InstallRoot $fixture.root -CurrentManifest $fixture.manifest -TransientBackup $transient
                Check ($result.status -ceq 'incomplete' -and $result.attempted.Count -eq 0) ('Unsafe failure evidence accepted: '+$variant)
                Check (Test-Path -LiteralPath $fixture.failed) 'Failure directory removed'
                Check ([IO.File]::ReadAllText((Join-Path $fixture.root 'data/memory.txt')) -ceq 'synthetic memory preserved') 'Live synthetic memory changed'
            } finally {
                if ($link) { Check ((Get-Item -LiteralPath $link -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) 'Expected owned junction changed';[IO.Directory]::Delete($link);Check (Test-Path -LiteralPath $fixture.failed) 'Junction target removed' }
            }
        }
    }
    Case 'retained process handle captures an actual nonzero synthetic child exit' {
        $exe=(Get-Process -Id $PID).Path
        $child=Start-Process -FilePath $exe -ArgumentList @('-NoProfile','-NonInteractive','-Command','exit 7') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $root 'child.stdout.log') -RedirectStandardError (Join-Path $root 'child.stderr.log') -PassThru
        $receipt=[ordered]@{pid=$child.Id;parent_pid=$PID;created_at_utc=$child.StartTime.ToUniversalTime().ToString('o');command=@($exe,'-NoProfile','-NonInteractive','-Command','exit 7')}
        try {
            $null=$child.Handle
            $child.WaitForExit()
            $code=$child.ExitCode
            $receipt.exit_code=$code
            Check ($null -ne $code -and $code -is [int] -and $code -eq 7) 'Child exit was missing or changed'
        } finally {$childReceipts.Add($receipt);$child.Dispose()}
    }
} finally {
    foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name,$saved[$name],'Process') }
    $resolved = (Get-Item -LiteralPath $root).FullName
    Check ([IO.Path]::GetDirectoryName($resolved) -eq [IO.Path]::GetFullPath($ScratchRoot).TrimEnd('\')) 'Cleanup scope changed'
    Assert-AgentMemoryRetentionPath $root
    Remove-Item -LiteralPath $root -Recurse -Force
    Check (-not (Test-Path -LiteralPath $root)) 'Synthetic fixture remains'
    $record = [ordered]@{started=$started;completed=[DateTime]::UtcNow.ToString('o');pid=$PID;executable=(Get-Process -Id $PID).Path;command=[Environment]::CommandLine;cases=@($cases.ToArray());child_processes=@($childReceipts.ToArray());fixture_removed=$true;scope='Product functions only, no service activation, original tests, model or actual authentication';live_gates='0'}
    [IO.File]::WriteAllText((Join-Path $ScratchRoot 'install-contracts-result.json'),($record | ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
}
Write-Output ('PASS cases=' + $cases.Count)
