param(
    [Parameter(Mandatory = $true)][string]$ReleaseRoot,
    [Parameter(Mandatory = $true)][string]$OutputDirectory
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$release = [IO.Path]::GetFullPath($ReleaseRoot)
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $output) { throw 'OutputDirectory already exists.' }
if ($output.StartsWith($release.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Distribution output must be outside ReleaseRoot.' }
$manifestPath = Join-Path $release 'release-manifest.json'
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$version = [string]$manifest.downstream_version
$head = (& git -C $sourceRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $head -ne [string]$manifest.source_commit) { throw 'Release and packaging source commits differ.' }
$dirty = @(& git -C $sourceRoot status --porcelain --untracked-files=normal)
if ($LASTEXITCODE -ne 0 -or $dirty.Count -gt 0) { throw 'Distribution requires a clean source checkout.' }
if ($version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$' -or [string]$manifest.product_id -ne 'agentmemory-codex-windows') { throw 'Invalid downstream release identity.' }
$links = @(Get-ChildItem -Force -Recurse -LiteralPath $release | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })
if ($links.Count -gt 0) { throw 'Portable ZIP requires a physical hoisted payload without links or junctions.' }
foreach ($file in @($manifest.release_files) + @($manifest.immutable_files)) {
    $base = if ($file -in $manifest.release_files) { $release } else { Join-Path $release 'payload' }
    $target = [IO.Path]::GetFullPath((Join-Path $base ([string]$file.path)))
    if (-not $target.StartsWith($base.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or
        (Get-FileHash -Algorithm SHA256 -LiteralPath $target).Hash -ne [string]$file.sha256) { throw "Invalid release file: $($file.path)" }
}
$expectedCount = @($manifest.release_files).Count + @($manifest.immutable_files).Count + 1
if (@(Get-ChildItem -Force -Recurse -File -LiteralPath $release).Count -ne $expectedCount) { throw 'Release contains unmanifested files.' }
[void][IO.Directory]::CreateDirectory($output)
$asset = "agentmemory-codex-windows-$version-win32-x64.zip"
$archive = Join-Path $output $asset
[IO.Compression.ZipFile]::CreateFromDirectory($release, $archive, [IO.Compression.CompressionLevel]::Optimal, $false)
$packageRoot = Join-Path $output 'npm-package'
[void][IO.Directory]::CreateDirectory($packageRoot)
foreach ($name in @('cli.mjs', 'Expand-Release.ps1')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot "npm\$name") -Destination $packageRoot }
foreach ($name in @('LICENSE', 'NOTICE', 'iii-LICENSE_ELv2', 'THIRD-PARTY-NOTICES.md')) { Copy-Item -LiteralPath (Join-Path $release $name) -Destination $packageRoot }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'npm\README.md') -Destination $packageRoot
$descriptor = [ordered]@{ schema_version = 1; product_id = 'agentmemory-codex-windows'; version = $version; source_commit = $head
    url = "https://github.com/M-T-D-N/agentmemory-codex-windows/releases/download/v$version/$asset"
    archive_sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
    archive_bytes = (Get-Item -LiteralPath $archive).Length
    manifest_sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $manifestPath).Hash.ToLowerInvariant() }
$package = [ordered]@{ name = 'agentmemory-codex-windows'; version = $version; description = 'Verified Windows/Codex installer for the independent AgentMemory downstream'
    type = 'module'; bin = @{ 'agentmemory-codex-windows' = 'cli.mjs' }; license = 'Apache-2.0'; os = @('win32'); cpu = @('x64'); engines = @{ node = '>=24' }
    repository = @{ type = 'git'; url = 'git+https://github.com/M-T-D-N/agentmemory-codex-windows.git' }
    files = @('cli.mjs', 'Expand-Release.ps1', 'release.json', 'README.md', 'LICENSE', 'NOTICE', 'iii-LICENSE_ELv2', 'THIRD-PARTY-NOTICES.md') }
$utf8 = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $packageRoot 'release.json'), ($descriptor | ConvertTo-Json), $utf8)
[IO.File]::WriteAllText((Join-Path $packageRoot 'package.json'), ($package | ConvertTo-Json -Depth 5), $utf8)
Push-Location $packageRoot
try {
    & npm.cmd pack --ignore-scripts --json --pack-destination $output
    if ($LASTEXITCODE -ne 0) { throw 'npm pack failed.' }
} finally { Pop-Location }
[ordered]@{ success = $true; source_commit = $head; archive = $archive; archive_sha256 = $descriptor.archive_sha256
    npm_tarball = (Join-Path $output "agentmemory-codex-windows-$version.tgz"); package_root = $packageRoot } | ConvertTo-Json
