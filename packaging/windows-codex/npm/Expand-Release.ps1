param(
    [Parameter(Mandatory = $true)][string]$Archive,
    [Parameter(Mandatory = $true)][string]$Destination
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = [IO.Path]::GetFullPath($Destination).TrimEnd('\')
if (Test-Path -LiteralPath $root) { throw 'Extraction destination already exists.' }
$zip = [IO.Compression.ZipFile]::OpenRead($Archive)
try {
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    [long]$total = 0
    foreach ($entry in $zip.Entries) {
        $name = $entry.FullName.Replace('\', '/')
        if ($name -match '(^/|:|[\x00-\x1f])' -or $name -match '(^|/)\.\.?(/|$)' -or $name -match '[. ](/|$)' -or
            $name -match '(?i)(^|/)(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|/|$)' -or
            -not $seen.Add($name.TrimEnd('/'))) { throw "Unsafe or duplicate archive entry: $name" }
        $target = [IO.Path]::GetFullPath((Join-Path $root $name))
        if (-not $target.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive path escapes destination.' }
        $unixKind = ($entry.ExternalAttributes -shr 16) -band 0xF000
        if ($unixKind -ne 0 -and $unixKind -ne 0x8000 -and $unixKind -ne 0x4000) { throw 'Archive links and special files are not supported.' }
        $total += $entry.Length
        if ($total -gt 6GB -or $zip.Entries.Count -gt 100000) { throw 'Archive exceeds extraction limits.' }
    }
    [void][IO.Directory]::CreateDirectory($root)
    foreach ($entry in $zip.Entries) {
        $target = [IO.Path]::GetFullPath((Join-Path $root $entry.FullName))
        if ($entry.FullName.EndsWith('/')) { [void][IO.Directory]::CreateDirectory($target); continue }
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
    }
} finally { $zip.Dispose() }
