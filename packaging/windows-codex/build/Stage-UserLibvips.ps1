Set-StrictMode -Version Latest

function Assert-UserLibraryPhysicalDirectory([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'user_library_directory_redirect' }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
}

function Initialize-UserLibraryReader {
    if ('AgentMemory.UserLibraryReader' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
namespace AgentMemory {
  public static class UserLibraryReader {
    [StructLayout(LayoutKind.Sequential)] struct Info {
      public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
      public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint length, uint flags);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
    public static string Physical(SafeFileHandle handle) {
      var text = new StringBuilder(32768);
      uint length = GetFinalPathNameByHandleW(handle, text, (uint)text.Capacity, 0);
      if (length == 0 || length >= text.Capacity) throw new IOException("user_library_physical_path_failed");
      string path = text.ToString();
      if (!path.StartsWith(@"\\?\") || path.StartsWith(@"\\?\UNC\")) throw new IOException("user_library_nonlocal_path");
      return path.Substring(4).TrimEnd('\\');
    }
    static SafeFileHandle Open(string path, bool directory) {
      var handle = CreateFileW(path, directory ? 0x80U : 0x80000000U, directory ? 3U : 1U, IntPtr.Zero, 3, 0x00200000U | (directory ? 0x02000000U : 0U), IntPtr.Zero);
      if (handle.IsInvalid) { handle.Dispose(); throw new Win32Exception(Marshal.GetLastWin32Error(), "user_library_locked_read_failed"); }
      Info info;
      if (!GetFileInformationByHandle(handle, out info) || (info.Attributes & 0x400) != 0 || ((info.Attributes & 0x10) != 0) != directory) {
        handle.Dispose(); throw new IOException("user_library_not_regular");
      }
      if (!String.Equals(Physical(handle), Path.GetFullPath(path).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) {
        handle.Dispose(); throw new IOException("user_library_path_changed");
      }
      return handle;
    }
    public static SafeFileHandle Directory(string path) { return Open(path, true); }
    public static FileStream File(string path) { return new FileStream(Open(path, false), FileAccess.Read); }
  }
}
'@
}

function Get-UserLibraryStreamHash([IO.Stream]$Stream) {
    $Stream.Position = 0
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($Stream))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose(); $Stream.Position = 0 }
}

function Assert-UserLibraryKeys($Value, [string[]]$Required) {
    if ($Value -isnot [pscustomobject]) { throw 'user_library_invalid_object' }
    $names = @($Value.PSObject.Properties.Name)
    if ($names.Count -ne $Required.Count) { throw 'user_library_unknown_or_missing_field' }
    foreach ($name in $Required) { if (-not ($names -ccontains $name)) { throw 'user_library_unknown_or_missing_field' } }
}

function Assert-UserLibraryUrl($Value) {
    $uri = $null
    if ($Value -isnot [string] -or -not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -cne 'https' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.IsLoopback) { throw 'user_library_invalid_source_url' }
}

function Assert-UserLibraryDescriptor($Descriptor) {
    Assert-UserLibraryKeys $Descriptor @('schema_version','kind','platform','sharp_version','libvips_version','files','sources')
    if ($Descriptor.schema_version -isnot [int] -or $Descriptor.schema_version -ne 1 -or $Descriptor.kind -cne 'user-built-libvips' -or $Descriptor.platform -cne 'win32-x64' -or $Descriptor.sharp_version -cne '0.35.5' -or $Descriptor.libvips_version -cne '8.18.7') { throw 'user_library_unsupported_profile' }
    $allowed = @{ 'vips-c'='libvips-42.dll'; 'vips-cpp-msvc'='libvips-cpp-8.18.7.dll' }
    if ($Descriptor.files -isnot [array] -or $Descriptor.files.Count -lt 1 -or $Descriptor.files.Count -gt 2 -or $Descriptor.sources -isnot [array]) { throw 'user_library_invalid_files' }
    $seen = @{}
    foreach ($file in $Descriptor.files) {
        Assert-UserLibraryKeys $file @('component','file','size_bytes','sha256')
        if ($file.component -isnot [string] -or -not (@($allowed.Keys) -ccontains $file.component) -or $file.file -cne $allowed[$file.component] -or $seen.ContainsKey($file.component)) { throw 'user_library_invalid_or_duplicate_component' }
        if (($file.size_bytes -isnot [int] -and $file.size_bytes -isnot [long]) -or $file.size_bytes -le 0 -or $file.sha256 -isnot [string] -or $file.sha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'user_library_invalid_hash_or_size' }
        $seen[$file.component] = $true
    }
    if ($Descriptor.sources.Count -ne $Descriptor.files.Count) { throw 'user_library_source_mapping' }
    $sourceSeen = @{}
    foreach ($source in $Descriptor.sources) {
        Assert-UserLibraryKeys $source @('component','version','source_url','source_revision','recipe_url','recipe_revision','patches','verification')
        if ($source.component -isnot [string] -or -not (@($seen.Keys) -ccontains $source.component) -or $sourceSeen.ContainsKey($source.component) -or $source.version -cne '8.18.7' -or $source.verification -cne 'declared' -or $source.patches -isnot [array]) { throw 'user_library_source_mapping' }
        $sourceSeen[$source.component] = $true
        Assert-UserLibraryUrl $source.source_url; Assert-UserLibraryUrl $source.recipe_url
        foreach ($revision in @($source.source_revision,$source.recipe_revision)) {
            if ($revision -isnot [string] -or $revision -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._/@+-]*$') { throw 'user_library_invalid_revision' }
        }
        foreach ($patch in $source.patches) {
            Assert-UserLibraryKeys $patch @('url','sha256'); Assert-UserLibraryUrl $patch.url
            if ($patch.sha256 -isnot [string] -or $patch.sha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'user_library_invalid_patch_hash' }
        }
    }
}

function Set-UserLibraryAtomicFile([string]$Temporary, [string]$Destination) {
    Assert-UserLibraryPhysicalDirectory ([IO.Path]::GetDirectoryName($Destination))
    [IO.File]::Replace($Temporary, $Destination, [NullString]::Value)
}

function Write-UserLibraryNewFile([string]$Path, [byte[]]$Bytes) {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($Bytes,0,$Bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}

function Stage-AgentMemoryUserLibvips {
    param([Parameter(Mandatory=$true)][string]$InputDirectory, [Parameter(Mandatory=$true)][string]$RuntimePackageRoot)
    foreach ($path in @($InputDirectory,$RuntimePackageRoot)) {
        if ($path -notmatch '^[A-Za-z]:[\\/]' -or $path.IndexOfAny([char[]]'*?[]') -ge 0) { throw 'user_library_nonliteral_path' }
        Assert-UserLibraryPhysicalDirectory $path
    }
    Initialize-UserLibraryReader
    $inputRoot = [IO.Path]::GetFullPath($InputDirectory).TrimEnd('\')
    $package = [IO.Path]::GetFullPath($RuntimePackageRoot).TrimEnd('\')
    if ($inputRoot.StartsWith($package+'\',[StringComparison]::OrdinalIgnoreCase) -or $package.StartsWith($inputRoot+'\',[StringComparison]::OrdinalIgnoreCase) -or $package -ieq $inputRoot) { throw 'user_library_overlapping_roots' }
    $lib = Join-Path $package 'node_modules\@img\sharp-win32-x64\lib'
    Assert-UserLibraryPhysicalDirectory $lib
    $handles = [Collections.Generic.List[IDisposable]]::new()
    try {
        foreach ($dir in @($inputRoot,$package,$lib)) { $handles.Add([AgentMemory.UserLibraryReader]::Directory($dir)) }
        $descriptorStream = [AgentMemory.UserLibraryReader]::File((Join-Path $inputRoot 'libvips-input.json')); $handles.Add($descriptorStream)
        if ($descriptorStream.Length -gt 64MB) { throw 'user_library_descriptor_too_large' }
        $raw = [IO.MemoryStream]::new(); $descriptorStream.CopyTo($raw); $descriptorBytes = $raw.ToArray(); $raw.Dispose()
        $descriptor = ([Text.UTF8Encoding]::new($false,$true)).GetString($descriptorBytes) | ConvertFrom-Json
        Assert-UserLibraryDescriptor $descriptor
        $inputDigest = Get-UserLibraryStreamHash $descriptorStream
        $descriptorOut = Join-Path $package 'user-libvips-input.json'
        $provenanceOut = Join-Path $package 'user-libvips-provenance.json'
        if ((Test-Path -LiteralPath $descriptorOut) -or (Test-Path -LiteralPath $provenanceOut)) { throw 'user_library_provenance_already_exists' }
        $baseline = [Collections.Generic.List[object]]::new()
        foreach ($name in @('libvips-42.dll','libvips-cpp-8.18.7.dll','sharp-win32-x64-0.35.5.node')) {
            $path = Join-Path $lib $name
            $stream = [AgentMemory.UserLibraryReader]::File($path)
            $baseline.Add([ordered]@{file=$name;sha256=(Get-UserLibraryStreamHash $stream);size_bytes=$stream.Length})
            if (@($descriptor.files | Where-Object { $_.file -ceq $name }).Count -eq 0) { $handles.Add($stream) } else { $stream.Dispose() }
        }
        foreach ($metadata in @(@{path='node_modules\sharp\package.json';name='sharp'},@{path='node_modules\@img\sharp-win32-x64\package.json';name='@img/sharp-win32-x64'})) {
            $stream = [AgentMemory.UserLibraryReader]::File((Join-Path $package $metadata.path))
            try {
                $reader = [IO.StreamReader]::new($stream); $body = $reader.ReadToEnd() | ConvertFrom-Json
                if ($body.name -cne $metadata.name -or $body.version -cne '0.35.5') { throw 'user_library_installed_profile_mismatch' }
            } finally { $stream.Dispose() }
        }
        $selected = @{}
        foreach ($file in $descriptor.files) {
            $stream = [AgentMemory.UserLibraryReader]::File((Join-Path $inputRoot $file.file)); $handles.Add($stream)
            if ($stream.Length -ne $file.size_bytes -or (Get-UserLibraryStreamHash $stream) -cne $file.sha256) { throw 'user_library_input_bytes_changed' }
            $selected[$file.component] = $stream
        }
        $copied = [Collections.Generic.List[object]]::new()
        foreach ($file in $descriptor.files) {
            $temporary = Join-Path $lib ('.user-libvips-'+[guid]::NewGuid().ToString('N')+'.tmp')
            $output = [IO.File]::Open($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
            try { $selected[$file.component].CopyTo($output); $output.Flush($true) } finally { $output.Dispose() }
            $check = [AgentMemory.UserLibraryReader]::File($temporary)
            try { if ($check.Length -ne $file.size_bytes -or (Get-UserLibraryStreamHash $check) -cne $file.sha256) { throw 'user_library_staged_bytes_changed' } } finally { $check.Dispose() }
            $destination = Join-Path $lib $file.file
            Set-UserLibraryAtomicFile $temporary $destination
            $check = [AgentMemory.UserLibraryReader]::File($destination)
            try { if ((Get-UserLibraryStreamHash $check) -cne $file.sha256) { throw 'user_library_replacement_changed' } } finally { $check.Dispose() }
            $copied.Add([ordered]@{component=$file.component;file=$file.file;size_bytes=$file.size_bytes;sha256=$file.sha256})
        }
        $provenance = [ordered]@{schema_version=1;kind='user-built-libvips';input_digest=$inputDigest;files=@($copied.ToArray());baseline=@($baseline.ToArray());native_api_abi='not-verified';source_verification='declared'}
        Write-UserLibraryNewFile $descriptorOut $descriptorBytes
        $encoded = ([Text.UTF8Encoding]::new($false)).GetBytes(($provenance | ConvertTo-Json -Depth 12))
        Write-UserLibraryNewFile $provenanceOut $encoded
        return [pscustomobject]@{input_digest=$inputDigest;provenance_sha256=(Get-FileHash -LiteralPath $provenanceOut -Algorithm SHA256).Hash.ToLowerInvariant()}
    } finally { for ($i=$handles.Count-1;$i -ge 0;$i--) { $handles[$i].Dispose() } }
}
