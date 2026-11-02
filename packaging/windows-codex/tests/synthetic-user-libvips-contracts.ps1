param([Parameter(Mandatory=$true)][string]$ScratchRoot)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '..\build\Stage-UserLibvips.ps1')
$capturedLayout=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'fixtures\sharp-win32-x64-0.35.5-layout.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$nativeMatch=[regex]::Match($capturedLayout.index_cjs.text,"^\s*module\.exports = require\('\./lib/([^']+)'\);\s*$")
if (-not $nativeMatch.Success) { throw 'Captured package index is not a literal native entry' }
$nativeName=$nativeMatch.Groups[1].Value
$root=Join-Path ([IO.Path]::GetFullPath($ScratchRoot)) ('libvips-'+[guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($root)
$started=[DateTime]::UtcNow.ToString('o'); $cases=[Collections.Generic.List[object]]::new(); $binding=$null
function Check([bool]$Value,[string]$Message) { if (-not $Value) { throw $Message } }
function Reject([scriptblock]$Action,[string]$Pattern) { $failure=$null; try { & $Action | Out-Null } catch { $failure=$_.Exception.Message }; Check ($null -ne $failure -and $failure -match $Pattern) ('Expected rejection: '+$Pattern) }
function Case([string]$Name,[scriptblock]$Action) { try { & $Action; $cases.Add(@{name=$Name;status='passed'}) } catch { $cases.Add(@{name=$Name;status='failed';error=$_.Exception.Message}); throw } }
function Save($f) { [IO.File]::WriteAllText((Join-Path $f.Input 'libvips-input.json'),($f.Descriptor | ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false)) }
function Fixture([switch]$Both) {
    $unit=Join-Path $root ([guid]::NewGuid().ToString('N')); $input=Join-Path $unit 'input'; $package=Join-Path $unit 'package'; $lib=Join-Path $package 'node_modules\@img\sharp-win32-x64\lib'
    foreach ($dir in @($input,$lib,(Join-Path $package 'node_modules\sharp'))) { [void][IO.Directory]::CreateDirectory($dir) }
    foreach ($name in @('libvips-42.dll','libvips-cpp-8.18.7.dll',$nativeName)) { [IO.File]::WriteAllText((Join-Path $lib $name),'synthetic-original-'+$name) }
    [IO.File]::WriteAllText((Join-Path $package 'node_modules\sharp\package.json'),'{"name":"sharp","version":"0.35.5"}')
    [IO.File]::WriteAllText((Join-Path $package 'node_modules\@img\sharp-win32-x64\package.json'),$capturedLayout.package_json.text)
    [IO.File]::WriteAllText((Join-Path $package 'node_modules\@img\sharp-win32-x64\index.cjs'),$capturedLayout.index_cjs.text)
    $files=@(); $sources=@(); $components=@(@{component='vips-c';file='libvips-42.dll'})
    if ($Both) { $components+=@{component='vips-cpp-msvc';file='libvips-cpp-8.18.7.dll'} }
    foreach ($component in $components) {
        $path=Join-Path $input $component.file; [IO.File]::WriteAllText($path,'synthetic-user-'+$component.file)
        $files += [ordered]@{component=$component.component;file=$component.file;size_bytes=(Get-Item -LiteralPath $path).Length;sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()}
        $sources += [ordered]@{component=$component.component;version='8.18.7';source_url='https://example.invalid/synthetic-source';source_revision='synthetic-only';recipe_url='https://example.invalid/synthetic-recipe';recipe_revision='synthetic-only';patches=@();verification='declared'}
    }
    $f=[pscustomobject]@{Unit=$unit;Input=$input;Package=$package;Lib=$lib;Descriptor=[pscustomobject][ordered]@{schema_version=1;kind='user-built-libvips';platform='win32-x64';sharp_version='0.35.5';libvips_version='8.18.7';files=@($files);sources=@($sources)}}
    Save $f; return $f
}
function Stage($f) { Stage-AgentMemoryUserLibvips -InputDirectory $f.Input -RuntimePackageRoot $f.Package }
try {
    Check ($env:AGENTMEMORY_INTEGRATION -eq '0' -and $env:AGENTMEMORY_CURATE -eq '0') 'Live gates must be disabled'
    Case 'single C DLL preserves wrapper and records unverified ABI' {
        $f=Fixture; $wrapper=Join-Path $f.Lib 'libvips-cpp-8.18.7.dll'; $before=(Get-FileHash -LiteralPath $wrapper).Hash
        $result=Stage $f; $descriptor=[IO.File]::ReadAllText((Join-Path $f.Package 'user-libvips-input.json')); $proof=[IO.File]::ReadAllText((Join-Path $f.Package 'user-libvips-provenance.json'))
        Check ((Get-FileHash -LiteralPath $wrapper).Hash -ceq $before) 'Unselected wrapper changed'
        Check (($proof | ConvertFrom-Json).native_api_abi -ceq 'not-verified') 'False ABI result'
        Check (-not $proof.Contains($f.Unit)) 'Private path in provenance'
        $base='runtime/synthetic/agentmemory';$rows=@();$payloadFiles=@()
        foreach ($file in Get-ChildItem -LiteralPath $f.Package -Recurse -File) {
            $relative=$base+'/'+$file.FullName.Substring($f.Package.Length+1).Replace('\','/')
            $rows+=@{path=$relative;size_bytes=$file.Length;sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
            $payloadFiles+=@{path=$relative;bytes=[Convert]::ToBase64String([IO.File]::ReadAllBytes($file.FullName))}
        }
        $script:binding=@{descriptor=$descriptor;provenance=$proof;payload_files=$payloadFiles;qualification=@{library_input_digest=$result.input_digest};manifest=@{package_relative_path=$base;distribution_variant='user-libvips';immutable_files=$rows;custom_libraries=@{schema_version=1;kind='user-built-libvips';input_digest=$result.input_digest;descriptor_path=$base+'/user-libvips-input.json';provenance_path=$base+'/user-libvips-provenance.json';provenance_sha256=$result.provenance_sha256}}}
    }
    Case 'two DLLs replace fixed component paths' {
        $f=Fixture -Both; Stage $f | Out-Null
        foreach ($file in $f.Descriptor.files) { Check ((Get-FileHash -LiteralPath (Join-Path $f.Lib $file.file)).Hash.ToLowerInvariant() -ceq $file.sha256) 'Wrong copied bytes' }
    }
    Case 'duplicate components and escape or MinGW names fail' {
        foreach ($name in @('../escape.dll','libvips-cpp-42.dll')) { $f=Fixture;$f.Descriptor.files[0].file=$name;Save $f;Reject { Stage $f } 'invalid_or_duplicate_component' }
        $f=Fixture -Both;$f.Descriptor.files[1].component='VIPS-C';Save $f;Reject { Stage $f } 'invalid_or_duplicate_component'
    }
    Case 'foreign profile private fields and credential URLs fail' {
        $f=Fixture;$f.Descriptor.platform='win32-arm64';Save $f;Reject { Stage $f } 'unsupported_profile'
        $f=Fixture;Add-Member -InputObject $f.Descriptor -NotePropertyName private_path -NotePropertyValue $f.Unit;Save $f;Reject { Stage $f } 'unknown_or_missing_field'
        $f=Fixture;$f.Descriptor.sources[0].source_url='https://synthetic:synthetic@example.invalid/source';Save $f;Reject { Stage $f } 'invalid_source_url'
    }
    Case 'changed input bytes never publish successful provenance' {
        $f=Fixture;[IO.File]::WriteAllText((Join-Path $f.Input 'libvips-42.dll'),'synthetic-changed');Reject { Stage $f } 'input_bytes_changed'
        Check (-not (Test-Path -LiteralPath (Join-Path $f.Package 'user-libvips-provenance.json'))) 'Published failed copy'
    }
    Case 'an existing writer prevents input handle acquisition' {
        $f=Fixture;$writer=[IO.File]::Open((Join-Path $f.Input 'libvips-42.dll'),[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::ReadWrite)
        try { Reject { Stage $f } 'locked_read_failed' } finally { $writer.Dispose() }
    }
    Case 'input and descriptor writes are blocked while staging holds handles' {
        $f=Fixture;$original=${function:Set-UserLibraryAtomicFile}
        try {
            function script:Set-UserLibraryAtomicFile([string]$Temporary,[string]$Destination) {
                foreach ($name in @('libvips-42.dll','libvips-input.json')) { $failed=$false;try { [IO.File]::WriteAllText((Join-Path $f.Input $name),'synthetic-write') } catch { $failed=$true };Check $failed 'Input lock allowed write' }
                & $original $Temporary $Destination
            }
            Stage $f | Out-Null
        } finally { Set-Item Function:script:Set-UserLibraryAtomicFile -Value $original }
    }
    Case 'atomic replacement preserves a synthetic cache hardlink' {
        $f=Fixture;$cache=Join-Path $f.Unit 'synthetic-cache.dll';[IO.File]::WriteAllText($cache,'synthetic-cache-original')
        $target=Join-Path $f.Lib 'libvips-42.dll';Remove-Item -LiteralPath $target;New-Item -ItemType HardLink -Path $target -Value $cache | Out-Null
        $before=(Get-FileHash -LiteralPath $cache).Hash;Stage $f | Out-Null
        Check ((Get-FileHash -LiteralPath $cache).Hash -ceq $before) 'Cache inode bytes changed'
        Check ((Get-FileHash -LiteralPath $target).Hash -cne $before) 'Target not replaced'
    }
    Case 'second atomic replacement failure leaves no success descriptor' {
        $f=Fixture -Both;$original=${function:Set-UserLibraryAtomicFile};$script:replacementCount=0
        try {
            function script:Set-UserLibraryAtomicFile([string]$Temporary,[string]$Destination) { $script:replacementCount++;if ($script:replacementCount -eq 2) { throw 'synthetic_atomic_replace_failure' };& $original $Temporary $Destination }
            Reject { Stage $f } 'synthetic_atomic_replace_failure'
            Check (-not (Test-Path -LiteralPath (Join-Path $f.Package 'user-libvips-provenance.json'))) 'Partial result published'
        } finally { Set-Item Function:script:Set-UserLibraryAtomicFile -Value $original }
    }
    Case 'source and unverified destination junctions fail' {
        $f=Fixture;$other=Join-Path $f.Unit 'original-input';Move-Item -LiteralPath $f.Input -Destination $other;New-Item -ItemType Junction -Path $f.Input -Value $other | Out-Null
        try { Reject { Stage $f } 'directory_redirect' } finally { [IO.Directory]::Delete($f.Input) }
        $f=Fixture;$other=Join-Path $f.Unit 'original-lib';Move-Item -LiteralPath $f.Lib -Destination $other;New-Item -ItemType Junction -Path $f.Lib -Value $other | Out-Null
        try { Reject { Stage $f } 'directory_redirect' } finally { [IO.Directory]::Delete($f.Lib) }
    }
} finally {
    Check ([IO.Path]::GetDirectoryName($root) -eq [IO.Path]::GetFullPath($ScratchRoot).TrimEnd('\')) 'Cleanup boundary changed'
    Remove-Item -LiteralPath $root -Recurse -Force
    $record=@{started=$started;completed=[DateTime]::UtcNow.ToString('o');pid=$PID;command=[Environment]::CommandLine;cases=@($cases.ToArray());fixture_removed=(-not (Test-Path -LiteralPath $root));scope='Synthetic opaque DLL bytes only; no native library loading or installation';live_gates='0';library_binding=$binding}
    [IO.File]::WriteAllText((Join-Path $ScratchRoot 'user-libvips-contracts-result.json'),($record | ConvertTo-Json -Depth 30),[Text.UTF8Encoding]::new($false))
}
Write-Output ('PASS cases='+$cases.Count)
