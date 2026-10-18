Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function Get-AgentMemoryMarkerProperty($Value, [string]$Name) {
    if ($null -eq $Value) { return $null }
    $property = $Value.PSObject.Properties[$Name]
    if ($property) { return $property.Value }
    return $null
}
function Get-AgentMemoryProcessIdentity([int]$ProcessId, [scriptblock]$ProcessLookup) {
    try {
        $process = if ($ProcessLookup) { & $ProcessLookup $ProcessId } else { Get-Process -Id $ProcessId -ErrorAction Stop }
        if (-not $process) { return @{ state = 'missing' } }
        $start = ([DateTime]$process.StartTime).ToUniversalTime()
        return @{ state = 'alive'; pid = $ProcessId; processStartUtc = $start.ToString('O'); started_filetime_utc = $start.ToFileTimeUtc().ToString() }
    } catch {
        if ($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId*') { return @{ state = 'missing' } }
        return @{ state = 'unknown' }
    }
}
function Get-AgentMemoryQwenMarker([string]$Path, [scriptblock]$ProcessLookup) {
    try {
        $attributes = [IO.File]::GetAttributes($Path)
        $item = [IO.FileInfo]::new($Path)
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -gt 16384) { return 'unknown' }
        $record = [IO.File]::ReadAllText($Path) | ConvertFrom-Json
        $value = Get-AgentMemoryMarkerProperty $record 'pid'
        if ($value -isnot [ValueType] -or [long]$value -ne $value -or [long]$value -le 0 -or [long]$value -gt [int]::MaxValue) { return 'unknown' }
        $actual = Get-AgentMemoryProcessIdentity ([int]$value) $ProcessLookup
        if ($actual.state -eq 'missing') { return 'stale' }
        if ($actual.state -ne 'alive') { return 'unknown' }
        $filetime = Get-AgentMemoryMarkerProperty $record 'started_filetime_utc'
        if ($filetime) {
            if ([string]$filetime -cne $actual.started_filetime_utc) { return 'stale' }
            return 'active'
        }
        $recorded = Get-AgentMemoryMarkerProperty $record 'processStartUtc'
        if (-not $recorded) { $recorded = Get-AgentMemoryMarkerProperty $record 'started_utc' }
        if (-not $recorded) { return 'unknown' }
        $start = [DateTime]::Parse([string]$recorded, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
        if ($start.ToFileTimeUtc().ToString() -ceq $actual.started_filetime_utc) { return 'active' }
        # Earlier AgentMemory releases used an approximate JS uptime timestamp.
        $actualStart = [DateTime]::FromFileTimeUtc([long]$actual.started_filetime_utc)
        if ([Math]::Abs(($actualStart - $start).TotalSeconds) -le 2) { return 'unknown' }
        return 'stale'
    } catch {
        if ($_.Exception.InnerException -is [IO.FileNotFoundException] -or $_.Exception.InnerException -is [IO.DirectoryNotFoundException]) { return 'missing' }
        return 'unknown'
    }
}
function Invoke-AgentMemoryQwenCoordination {
    param([Parameter(Mandatory = $true)]$Request, [scriptblock]$ProcessLookup)
    $operation = [string]$Request.operation
    if ($operation -eq 'identity') {
        $identity = Get-AgentMemoryProcessIdentity ([int]$Request.pid) $ProcessLookup
        if ($identity.state -ne 'alive') { return @{ ok = $false; reason = 'owner_identity_unknown' } }
        return @{ ok = $true; identity = $identity }
    }
    if ($operation -notin @('publish', 'release', 'inspect')) { return @{ ok = $false; reason = 'invalid_operation' } }
    if (-not [IO.Path]::IsPathRooted([string]$Request.directory)) { return @{ ok = $false; reason = 'invalid_directory' } }
    $directory = [IO.Path]::GetFullPath([string]$Request.directory)
    $null = [IO.Directory]::CreateDirectory($directory)
    $lease = Join-Path $directory 'qwen-use.lock'
    $foreground = Join-Path $directory 'foreground-request.json'
    $guard = $null
    $deadline = [DateTime]::UtcNow.AddMilliseconds(1000)
    try {
        while (-not $guard) {
            try { $guard = [IO.FileStream]::new("$lease.lifecycle.lock", [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
            catch [IO.IOException] {
                if ([DateTime]::UtcNow -ge $deadline) { return @{ ok = $false; reason = 'coordination_busy'; errorCode = 'EBUSY' } }
                Start-Sleep -Milliseconds 25
            }
        }
        if ($operation -eq 'inspect') { return @{ ok = $true; lease = (Get-AgentMemoryQwenMarker $lease $ProcessLookup); foreground = (Get-AgentMemoryQwenMarker $foreground $ProcessLookup) } }
        $record = $Request.record
        if ([string]$record.token -notmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' -or [string]$record.owner -cne 'agentmemory-background' -or [string]$record.started_filetime_utc -notmatch '^[0-9]{1,19}$') { return @{ ok = $false; reason = 'invalid_owner_record' } }
        if ($operation -eq 'release') {
            try { $attributes = [IO.File]::GetAttributes($lease); $item = [IO.FileInfo]::new($lease) }
            catch {
                if ($_.Exception.InnerException -is [IO.FileNotFoundException] -or $_.Exception.InnerException -is [IO.DirectoryNotFoundException]) { return @{ ok = $true; removed = $false } }
                throw
            }
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return @{ ok = $false; reason = 'marker_unknown' } }
            $current = [IO.File]::ReadAllText($lease) | ConvertFrom-Json
            foreach ($field in @('token', 'pid', 'owner', 'processStartUtc', 'started_filetime_utc')) {
                if ([string](Get-AgentMemoryMarkerProperty $current $field) -cne [string](Get-AgentMemoryMarkerProperty $record $field)) { return @{ ok = $true; removed = $false } }
            }
            [IO.File]::Delete($lease)
            return @{ ok = $true; removed = $true }
        }
        $actual = Get-AgentMemoryProcessIdentity ([int]$record.pid) $ProcessLookup
        if ($actual.state -ne 'alive' -or $actual.started_filetime_utc -cne [string]$record.started_filetime_utc) { return @{ ok = $false; reason = 'owner_identity_unknown' } }
        $declaredStart = [DateTime]::Parse([string]$record.processStartUtc, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
        if ($declaredStart.ToFileTimeUtc().ToString() -cne $actual.started_filetime_utc) { return @{ ok = $false; reason = 'owner_identity_unknown' } }
        $priority = Get-AgentMemoryQwenMarker $foreground $ProcessLookup
        if ($priority -in @('active', 'unknown')) { return @{ ok = $false; reason = 'foreground_requested' } }
        $state = Get-AgentMemoryQwenMarker $lease $ProcessLookup
        if ($state -in @('active', 'unknown')) { return @{ ok = $false; reason = 'lease_busy' } }
        $candidate = Join-Path $directory ("qwen-use.lock.pending-" + [string]$record.token)
        $attributes = [IO.File]::GetAttributes($candidate)
        $prepared = [IO.FileInfo]::new($candidate)
        if ($prepared.Attributes -band [IO.FileAttributes]::ReparsePoint -or -not ($prepared -is [IO.FileInfo]) -or
            [IO.File]::ReadAllText($candidate) -cne [string]$Request.recordBytes) { return @{ ok = $false; reason = 'lease_prepare_replaced' } }
        $preparedRecord = [string]$Request.recordBytes | ConvertFrom-Json
        foreach ($field in @('token', 'pid', 'owner', 'processStartUtc', 'started_filetime_utc')) {
            if ([string](Get-AgentMemoryMarkerProperty $preparedRecord $field) -cne [string](Get-AgentMemoryMarkerProperty $record $field)) { return @{ ok = $false; reason = 'lease_prepare_replaced' } }
        }
        if ($priority -eq 'stale') { [IO.File]::Delete($foreground) }
        if ($state -eq 'stale') { [IO.File]::Delete($lease) }
        if (-not ('AgentMemory.NativeLeaseLink' -as [type])) {
            $env:TEMP = $directory; $env:TMP = $directory; $env:TMPDIR = $directory
            Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
namespace AgentMemory {
    public static class NativeLeaseLink {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool CreateHardLink(string path, string target, IntPtr reserved);
    }
}
"@
        }
        if (-not [AgentMemory.NativeLeaseLink]::CreateHardLink($lease, $candidate, [IntPtr]::Zero)) {
            $nativeError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
            throw [ComponentModel.Win32Exception]::new($nativeError)
        }
        return @{ ok = $true; published = $true }
    } catch {
        $exception = $_.Exception
        while ($exception.InnerException) { $exception = $exception.InnerException }
        $code = if ($exception -is [ComponentModel.Win32Exception]) { $exception.NativeErrorCode } else { $exception.HResult -band 65535 }
        $name = if ($code -eq 5) { 'EPERM' } elseif ($code -in @(32, 33)) { 'EBUSY' } elseif ($code -in @(80, 183)) { 'EEXIST' } else { 'EIO' }
        return @{ ok = $false; reason = 'coordination_io_failed'; errorCode = $name }
    } finally { if ($guard) { $guard.Dispose() } }
}
if ($MyInvocation.InvocationName -ne '.') {
    [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    try {
        $inputText = [Console]::In.ReadToEnd()
        if ($inputText.Length -gt 16384) { throw 'Invalid coordination request size' }
        $request = $inputText | ConvertFrom-Json
        $result = Invoke-AgentMemoryQwenCoordination -Request $request
    } catch { $result = @{ ok = $false; reason = 'coordination_request_failed' } }
    [Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 5 -Compress))
}
