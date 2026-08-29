param(
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [Parameter(Mandatory = $true)][string]$IiiEnginePath,
    [string]$NodePath = '',
    [string]$ReleaseRevision = 'r58',
    [switch]$SkipTests
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

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

$priorNodeOptions = [System.Environment]::GetEnvironmentVariable('NODE_OPTIONS', 'Process')
$priorCi = [System.Environment]::GetEnvironmentVariable('CI', 'Process')
$env:CI = 'true'
$nodeHeapOption = '--max-old-space-size=12288'
if ([string]::IsNullOrWhiteSpace($priorNodeOptions)) {
    $env:NODE_OPTIONS = $nodeHeapOption
}
elseif ($priorNodeOptions -notmatch '(?:^|\s)--max-old-space-size(?:=|\s)') {
    $env:NODE_OPTIONS = "$priorNodeOptions $nodeHeapOption"
}

$sourceRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$outputRoot = [System.IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $outputRoot) {
    throw "OutputDirectory already exists: $outputRoot"
}

$node = $NodePath
if ([string]::IsNullOrWhiteSpace($node)) {
    $node = [string](Get-Command node.exe -ErrorAction Stop).Source
}
$node = [System.IO.Path]::GetFullPath($node)
$pnpm = [string](Get-Command pnpm.cmd -ErrorAction Stop).Source
$iii = [System.IO.Path]::GetFullPath($IiiEnginePath)
foreach ($required in @($node, $iii, (Join-Path $sourceRoot 'pnpm-lock.yaml'), (Join-Path $sourceRoot 'pnpm-workspace.yaml'), (Join-Path $sourceRoot 'upstream-source.json'))) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Required build input is missing: $required"
    }
}

$thirdParty = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'config\third-party-inputs.json') | ConvertFrom-Json
$iiiHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $iii).Hash
if ($iiiHash -ne [string]$thirdParty.iii_engine.sha256) {
    throw "iii-engine hash mismatch: expected $($thirdParty.iii_engine.sha256), got $iiiHash"
}

$packageJson = Get-Content -Raw -LiteralPath (Join-Path $sourceRoot 'package.json') | ConvertFrom-Json
$version = [string]$packageJson.version
$downstreamVersion = [string]$packageJson.agentmemoryDownstream.version
if ($downstreamVersion -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$') {
    throw 'package.json agentmemoryDownstream.version must be a semantic version.'
}
if ($ReleaseRevision -notmatch '^[0-9A-Za-z](?:[0-9A-Za-z._-]{0,62}[0-9A-Za-z])?$') {
    throw 'ReleaseRevision must be a 1-64 character path-safe identifier using letters, digits, dot, underscore, or hyphen, and must begin and end with a letter or digit.'
}
$runtimeRelease = "$version-codex-$ReleaseRevision"
$releaseRoot = Join-Path $outputRoot "agentmemory-codex-windows-$downstreamVersion"
$payloadRoot = Join-Path $releaseRoot 'payload'
$runtimePackageRoot = Join-Path $payloadRoot "runtime\$runtimeRelease\agentmemory"
[void][System.IO.Directory]::CreateDirectory($releaseRoot)

Push-Location $sourceRoot
try {
    & $pnpm --config.confirmModulesPurge=false --config.node-linker=hoisted install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw "pnpm install failed with exit code $LASTEXITCODE" }

    & $pnpm run skills:check
    if ($LASTEXITCODE -ne 0) { throw "skills check failed with exit code $LASTEXITCODE" }

    & $pnpm run typecheck
    if ($LASTEXITCODE -ne 0) { throw "typecheck failed with exit code $LASTEXITCODE" }

    & $pnpm run build
    if ($LASTEXITCODE -ne 0) { throw "build failed with exit code $LASTEXITCODE" }

    if (-not $SkipTests) {
        & $pnpm test
        if ($LASTEXITCODE -ne 0) { throw "test suite failed with exit code $LASTEXITCODE" }
        & $node (Join-Path $PSScriptRoot 'tests\codex-turn.test.mjs')
        if ($LASTEXITCODE -ne 0) { throw "Codex adapter tests failed with exit code $LASTEXITCODE" }
    }

    & $pnpm --filter '@agentmemory/agentmemory' deploy --prod --legacy $runtimePackageRoot
    if ($LASTEXITCODE -ne 0) { throw "pnpm deploy failed with exit code $LASTEXITCODE" }
    Get-ChildItem -Recurse -Directory -Filter '.bin' -LiteralPath (Join-Path $runtimePackageRoot 'node_modules') |
        Sort-Object { $_.FullName.Length } -Descending |
        Remove-Item -Recurse -Force
    $modulesMetadata = Join-Path $runtimePackageRoot 'node_modules\.modules.yaml'
    if (Test-Path -LiteralPath $modulesMetadata -PathType Leaf) {
        Remove-Item -LiteralPath $modulesMetadata -Force
    }
    & $node (Join-Path $PSScriptRoot 'tests\release-smoke.mjs') $runtimePackageRoot $sourceRoot
    if ($LASTEXITCODE -ne 0) { throw "release smoke failed with exit code $LASTEXITCODE" }
}
finally {
    Pop-Location
    if ($null -eq $priorNodeOptions) {
        Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
    }
    else {
        $env:NODE_OPTIONS = $priorNodeOptions
    }
    if ($null -eq $priorCi) {
        Remove-Item Env:CI -ErrorAction SilentlyContinue
    }
    else {
        $env:CI = $priorCi
    }
}

$scriptsOut = Join-Path $payloadRoot 'scripts'
$binOut = Join-Path $payloadRoot 'bin'
$configOut = Join-Path $payloadRoot 'config'
$srcOut = Join-Path $payloadRoot 'src'
foreach ($directory in @($scriptsOut, $binOut, $configOut, $srcOut)) {
    [void][System.IO.Directory]::CreateDirectory($directory)
}

Copy-Item -Path (Join-Path $PSScriptRoot 'powershell\*.ps1') -Destination $scriptsOut
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'hooks\codex-turn.mjs') -Destination $scriptsOut
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'node\agentmemory-worker.mjs') -Destination $binOut
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'config\iii-config.yaml') -Destination $configOut
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'config\hook-spec.json') -Destination $configOut
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'config\third-party-inputs.json') -Destination $configOut
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'config\mcp-launcher-environment.json') -Destination $configOut
Copy-Item -LiteralPath (Join-Path $sourceRoot 'upstream-source.json') -Destination $configOut
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'launcher\AgentMemoryHiddenLauncher.cs') -Destination $srcOut
Copy-Item -LiteralPath $iii -Destination (Join-Path $binOut 'iii.exe')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Install-WindowsCodex.ps1') -Destination $releaseRoot

$cscCandidates = @(
    (Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:SystemRoot 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$csc = $cscCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $csc) { throw 'A .NET Framework C# compiler was not found.' }
$launcherOut = Join-Path $binOut 'agentmemory-hidden-launcher.exe'
& $csc /nologo /target:winexe /optimize+ /r:System.Security.dll /r:System.Runtime.Serialization.dll "/out:$launcherOut" (Join-Path $PSScriptRoot 'launcher\AgentMemoryHiddenLauncher.cs')
if ($LASTEXITCODE -ne 0) { throw "launcher compilation failed with exit code $LASTEXITCODE" }

$unexpectedBackups = @(Get-ChildItem -Recurse -File -LiteralPath $payloadRoot | Where-Object { $_.Name -match '\.bak(?:-|$)' })
if ($unexpectedBackups.Count -gt 0) {
    throw "Release payload contains backup artifacts: $($unexpectedBackups.FullName -join ', ')"
}

$upstream = Get-Content -Raw -LiteralPath (Join-Path $sourceRoot 'upstream-source.json') | ConvertFrom-Json
$files = @(
    Get-ChildItem -Recurse -File -LiteralPath $payloadRoot |
        Sort-Object FullName |
        ForEach-Object {
            $relative = $_.FullName.Substring($payloadRoot.Length).TrimStart('\').Replace('\', '/')
            [ordered]@{
                path = $relative
                size_bytes = $_.Length
                sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash
            }
        }
)
$releaseFiles = @(
    Get-ChildItem -File -LiteralPath $releaseRoot |
        Where-Object { $_.Name -ne 'release-manifest.json' } |
        Sort-Object FullName |
        ForEach-Object {
            [ordered]@{
                path = $_.Name
                size_bytes = $_.Length
                sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash
            }
        }
)
$manifest = [ordered]@{
    schema_version = 1
    product = 'AgentMemory for Codex on Windows'
    product_id = 'agentmemory-codex-windows'
    downstream_version = $downstreamVersion
    agentmemory_version = $version
    release_revision = $ReleaseRevision
    package_relative_path = "runtime/$runtimeRelease/agentmemory"
    upstream = [ordered]@{
        tag = [string]$upstream.tag
        commit = [string]$upstream.commit
        tree = [string]$upstream.tree
        pristine_npm_sha256 = [string]$upstream.npm_artifact.sha256
    }
    build_runtime = [ordered]@{
        node = (& $node --version).Trim()
        pnpm = (& $pnpm --version).Trim()
        iii = [string]$thirdParty.iii_engine.version
    }
    adapter_source_hashes = [ordered]@{
        hidden_launcher = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $PSScriptRoot 'launcher\AgentMemoryHiddenLauncher.cs')).Hash
        hidden_launcher_normalized = Get-NormalizedTextSha256 -Path (Join-Path $PSScriptRoot 'launcher\AgentMemoryHiddenLauncher.cs')
    }
    release_files = $releaseFiles
    immutable_files = $files
}
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText(
    (Join-Path $releaseRoot 'release-manifest.json'),
    ($manifest | ConvertTo-Json -Depth 8),
    $utf8NoBom
)

[ordered]@{
    success = $true
    release_root = $releaseRoot
    payload_files = $files.Count
    version = $downstreamVersion
    agentmemory_version = $version
} | ConvertTo-Json
