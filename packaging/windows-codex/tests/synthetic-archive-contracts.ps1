param([Parameter(Mandatory=$true)][string]$ScratchRoot,[Parameter(Mandatory=$true)][string]$NodePath,[switch]$CaptureAuthorizationMetadata)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$product=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$root=Join-Path ([IO.Path]::GetFullPath($ScratchRoot)) ('a-'+[guid]::NewGuid().ToString('N').Substring(0,8))
[void][IO.Directory]::CreateDirectory($root)
$cases=[Collections.Generic.List[object]]::new(); $started=[DateTime]::UtcNow.ToString('o')
function Check([bool]$Condition,[string]$Message) { if (-not $Condition) { throw $Message } }
$script:authorizationSequence=0
$script:authorizationFailure=$null
function Capture-InstallerAuthorization {
    if (-not $CaptureAuthorizationMetadata) {return}
    $rows=@()
    foreach($name in @('agentmemory-lifecycle.ps1','agentmemory-layout.ps1','agentmemory-upgrade-retention.ps1')) {
        $path=Join-Path $release ('payload\scripts\'+$name)
        $signature=Get-AuthenticodeSignature -LiteralPath $path -ErrorAction Stop
        $streams=@(Get-Item -LiteralPath $path -Stream '*' -ErrorAction Stop | ForEach-Object {$_.Stream})
        $zone=$null;if($streams -contains 'Zone.Identifier'){$zone=Get-Content -LiteralPath $path -Stream Zone.Identifier -Raw -ErrorAction Stop}
        $rows+=@([ordered]@{path=$path;path_length=$path.Length;sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256 -ErrorAction Stop).Hash;signature_status=[string]$signature.Status;signature_message=$signature.StatusMessage;streams=$streams;zone_identifier=$zone})
    }
    $value=[ordered]@{sequence=(++$script:authorizationSequence);captured_at_utc=[DateTime]::UtcNow.ToString('o');pid=$PID;account=[Security.Principal.WindowsIdentity]::GetCurrent().Name;sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;host_executable=[Diagnostics.Process]::GetCurrentProcess().MainModule.FileName;host_version=$PSVersionTable.PSVersion.ToString();effective_policy=[string](Get-ExecutionPolicy);policy_list=@(Get-ExecutionPolicy -List|ForEach-Object{[ordered]@{scope=[string]$_.Scope;policy=[string]$_.ExecutionPolicy}});process_policy_environment=[Environment]::GetEnvironmentVariable('PSExecutionPolicyPreference','Process');files=$rows;capture_point='immediately before existing installer rejection call; same process';synthetic=$true;production_qualified=$false}
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($value|ConvertTo-Json -Depth 8))
    $stream=[IO.File]::Open((Join-Path $ScratchRoot ('archive-authorization-'+$script:authorizationSequence+'.json')),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush()}finally{$stream.Dispose()}
}
function Reject([scriptblock]$Action,[string]$Pattern) {
    $failure=$null; try { & $Action | Out-Null } catch { if($CaptureAuthorizationMetadata -and ($_.Exception -is [System.Management.Automation.PSSecurityException] -or $_.CategoryInfo.Category -eq 'SecurityError' -or $_.FullyQualifiedErrorId -eq 'UnauthorizedAccess')){$script:authorizationFailure=[ordered]@{message=$_.Exception.Message;code=$_.FullyQualifiedErrorId;category=[string]$_.CategoryInfo.Category;exception_type=$_.Exception.GetType().FullName};throw};$failure=$_.Exception.Message }
    Check ($null -ne $failure -and $failure -match $Pattern) ('Expected rejection: '+$Pattern+'; observed: '+$failure)
}
function Case([string]$Name,[scriptblock]$Action) {
    try { & $Action; $cases.Add([ordered]@{name=$Name;status='passed'}) }
    catch { $cases.Add([ordered]@{name=$Name;status='failed';error=$_.Exception.Message}); throw }
}
function Zip([string]$Path,[string[]]$Names,[switch]$Link) {
    $archive=[IO.Compression.ZipFile]::Open($Path,[IO.Compression.ZipArchiveMode]::Create)
    try { foreach ($name in $Names) {
        $entry=$archive.CreateEntry($name)
        if ($Link) { $entry.ExternalAttributes=-1610612736 }
        $stream=$entry.Open(); $bytes=[Text.Encoding]::UTF8.GetBytes('synthetic payload')
        try { $stream.Write($bytes,0,$bytes.Length) } finally { $stream.Dispose() }
    } } finally { $archive.Dispose() }
}
try {
    Check ($env:AGENTMEMORY_INTEGRATION -eq '0' -and $env:AGENTMEMORY_CURATE -eq '0') 'Live gates must be zero'
    Case 'physical nested archive expands exact bytes' {
        $zip=Join-Path $root 'valid.zip'; $dest=Join-Path $root 'expanded'
        Zip $zip @('nested/payload.txt')
        & (Join-Path $product 'npm\Expand-Release.ps1') -Archive $zip -Destination $dest
        Check ([IO.File]::ReadAllText((Join-Path $dest 'nested/payload.txt')) -ceq 'synthetic payload') 'Extracted bytes differ'
    }
    Case 'unsafe late entry rejects the entire archive before any extraction' {
        $zip=Join-Path $root 'traversal.zip'; $dest=Join-Path $root 'rejected-traversal'
        Zip $zip @('valid.txt','../outside.txt')
        Reject { & (Join-Path $product 'npm\Expand-Release.ps1') -Archive $zip -Destination $dest } 'Unsafe'
        Check (-not (Test-Path -LiteralPath $dest)) 'Partial destination created'
        Check (-not (Test-Path -LiteralPath (Join-Path $root 'outside.txt'))) 'Escaping file created'
    }
    Case 'Windows case aliases and archive links are refused' {
        $zip=Join-Path $root 'aliases.zip'
        Zip $zip @('Payload.txt','payload.txt')
        Reject { & (Join-Path $product 'npm\Expand-Release.ps1') -Archive $zip -Destination (Join-Path $root 'aliases') } 'duplicate'
        $zip=Join-Path $root 'link.zip'; Zip $zip @('link') -Link
        Reject { & (Join-Path $product 'npm\Expand-Release.ps1') -Archive $zip -Destination (Join-Path $root 'link') } 'links and special files'
    }
    Case 'existing extraction target is preserved' {
        $dest=Join-Path $root 'existing'; [void][IO.Directory]::CreateDirectory($dest)
        [IO.File]::WriteAllText((Join-Path $dest 'keep.txt'),'synthetic existing')
        Reject { & (Join-Path $product 'npm\Expand-Release.ps1') -Archive (Join-Path $root 'valid.zip') -Destination $dest } 'already exists'
        Check ([IO.File]::ReadAllText((Join-Path $dest 'keep.txt')) -ceq 'synthetic existing') 'Existing target changed'
    }
    $release=Join-Path $root 'release'; $install=Join-Path $root 'managed'; $workspace=Join-Path $root 'workspace'
    foreach ($dir in @($release,(Join-Path $release 'payload\scripts'),(Join-Path $install 'config'),$workspace)) { [void][IO.Directory]::CreateDirectory($dir) }
    foreach ($name in @('agentmemory-lifecycle.ps1','agentmemory-layout.ps1','agentmemory-upgrade-retention.ps1')) {
        [IO.File]::Copy((Join-Path $product ('powershell\'+$name)),(Join-Path $release ('payload\scripts\'+$name)))
    }
    $registry=Join-Path $workspace 'registry.json'; [IO.File]::WriteAllText($registry,'{"schema_version":2,"projects":[]}')
    $candidate=[ordered]@{product_id='agentmemory-codex-windows';downstream_version='0.1.0-preview.19';data_contract_version=5;release_files=@();immutable_files=@()}
    $installed=[ordered]@{install_nonce='synthetic-owner';data_contract_version=5;install_root=$install}
    $manifest=Join-Path $release 'release-manifest.json'; $installedPath=Join-Path $install 'config\install-manifest.json'
    $ownerPath=Join-Path $install '.agentmemory-install-owner.json'
    [IO.File]::WriteAllText($installedPath,($installed | ConvertTo-Json))
    [IO.File]::WriteAllText($ownerPath,'{"install_nonce":"synthetic-owner"}')
    [IO.File]::WriteAllText((Join-Path $install 'keep.txt'),'synthetic managed bytes')
    $arguments=@{ReleaseRoot=$release;InstallRoot=$install;WorkspaceRoot=$workspace;ProjectRegistry=$registry;NodePath=$NodePath;ManagedRequirementsPath=(Join-Path $root 'requirements.toml')}
    Case 'installer rejects manifest payload traversal without changing managed target' {
        $candidate.immutable_files=@([ordered]@{path='../outside.txt';sha256='synthetic-invalid'})
        [IO.File]::WriteAllText($manifest,($candidate | ConvertTo-Json -Depth 6))
        Capture-InstallerAuthorization
        Reject { & (Join-Path $product 'Install-WindowsCodex.ps1') @arguments } 'escapes payload'
        $candidate.immutable_files=@()
    }
    Case 'installer refuses foreign owner and relocated manifest ownership' {
        [IO.File]::WriteAllText($manifest,($candidate | ConvertTo-Json -Depth 6))
        [IO.File]::WriteAllText($ownerPath,'{"install_nonce":"foreign-synthetic-owner"}')
        Capture-InstallerAuthorization
        Reject { & (Join-Path $product 'Install-WindowsCodex.ps1') @arguments } 'nonce do not match'
        [IO.File]::WriteAllText($ownerPath,'{"install_nonce":"synthetic-owner"}')
        $installed.install_root=Join-Path $root 'different-target'
        [IO.File]::WriteAllText($installedPath,($installed | ConvertTo-Json))
        Capture-InstallerAuthorization
        Reject { & (Join-Path $product 'Install-WindowsCodex.ps1') @arguments } 'does not own InstallRoot'
        $installed.install_root=$install
    }
    Case 'installer refuses a data-contract downgrade and preserves predecessor bytes' {
        $installed.data_contract_version=6; [IO.File]::WriteAllText($installedPath,($installed | ConvertTo-Json))
        Capture-InstallerAuthorization
        Reject { & (Join-Path $product 'Install-WindowsCodex.ps1') @arguments } 'Runtime downgrade'
        Check ([IO.File]::ReadAllText((Join-Path $install 'keep.txt')) -ceq 'synthetic managed bytes') 'Managed bytes changed'
    }
} finally {
    $fixtureRetained=$CaptureAuthorizationMetadata -and @($cases | Where-Object {$_.status -eq 'failed'}).Count -gt 0
    if(-not $fixtureRetained) {
        . (Join-Path $product 'powershell\agentmemory-upgrade-retention.ps1')
        Check ([IO.Path]::GetDirectoryName($root) -eq [IO.Path]::GetFullPath($ScratchRoot).TrimEnd('\')) 'Fixture scope changed'
        Assert-AgentMemoryRetentionPath $root
        Remove-Item -LiteralPath $root -Recurse -Force
    }
    [IO.File]::WriteAllText((Join-Path $ScratchRoot 'archive-contracts-result.json'),([ordered]@{started=$started;completed=[DateTime]::UtcNow.ToString('o');pid=$PID;command=[Environment]::CommandLine;cases=@($cases.ToArray());fixture_removed=(-not (Test-Path -LiteralPath $root));fixture_retained=$fixtureRetained;authorization_capture=$CaptureAuthorizationMetadata.IsPresent;authorization_failure=$script:authorizationFailure;scope='Actual expansion and installer rejection only; synthetic manifest is deliberately incomplete and not distribution evidence';live_gates='0'} | ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
}
Write-Output ('PASS cases='+$cases.Count)
