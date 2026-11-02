Set-StrictMode -Version Latest

function Initialize-AgentMemoryEvidenceCapture {
    param([switch]$Utf8, [string]$IdentityPath = '')
    if (-not $Utf8 -and [string]::IsNullOrWhiteSpace($IdentityPath)) { return }
    if (-not $Utf8 -or [string]::IsNullOrWhiteSpace($IdentityPath)) { throw 'Evidence capture requires UTF8 and an explicit identity file together.' }
    $path = [IO.Path]::GetFullPath($IdentityPath)
    if (-not [IO.Path]::IsPathRooted($IdentityPath) -or $IdentityPath.StartsWith('\\') -or $path -ine $IdentityPath) { throw 'Evidence identity path must be an explicit local absolute path.' }
    $parent = Get-Item -LiteralPath ([IO.Path]::GetDirectoryName($path)) -Force
    for ($item=$parent; $null -ne $item; $item=$item.Parent) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Evidence identity parent redirects.' }
    }
    $encoding = [Text.UTF8Encoding]::new($false)
    [Console]::OutputEncoding = $encoding
    $script:OutputEncoding = $encoding
    $current = [Diagnostics.Process]::GetCurrentProcess()
    try {
        $started = [DateTime]::UtcNow.ToString('o')
        $record = [ordered]@{
            pid = $PID
            created_at_utc = $current.StartTime.ToUniversalTime().ToString('o')
            creation_filetime = $current.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()
            started_at_utc = $started
            executable = $current.MainModule.FileName
        }
        $bytes = $encoding.GetBytes(($record | ConvertTo-Json -Compress))
        $stream = [IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
        try { $stream.Write($bytes,0,$bytes.Length);$stream.Flush($true) }
        finally { $stream.Dispose() }
    } finally { $current.Dispose() }
}
