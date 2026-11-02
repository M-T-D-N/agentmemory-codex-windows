param([Parameter(Mandatory=$true)][string]$ContractPath,[Parameter(Mandatory=$true)][string]$ContractSha256,[Parameter(Mandatory=$true)][string]$IdentityPath,
    [ValidateSet('configure','configure-retained','credential','inspect-prepared','inspect-active','inspect-existing')][string]$Operation,[switch]$Execute)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
# Explicit opt-in backend only. Import-safe JS never invokes this while constructing a plan.
# No credential creation, ACL mutation, task registration, installation or network operation.
if (-not $Execute) { throw 'Explicit preparation action required.' }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class EvidencePreparationHandles {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
 static extern SafeFileHandle CreateFile(string p,uint access,uint share,IntPtr sa,uint disposition,uint flags,IntPtr template);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
 static extern uint GetFinalPathNameByHandle(SafeFileHandle h,StringBuilder b,uint n,uint flags);
 public static SafeFileHandle LockDirectory(string path) {
   var h=CreateFile(path,0,1,IntPtr.Zero,3,0x02000000,IntPtr.Zero);
   if(h.IsInvalid)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
   return h;
 }

 [StructLayout(LayoutKind.Sequential)] public struct FileInfo {
  public uint attributes; public System.Runtime.InteropServices.ComTypes.FILETIME creation,access,write;
  public uint volume,sizeHigh,sizeLow,links,indexHigh,indexLow;
 }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct RenameInfo {
  [MarshalAs(UnmanagedType.U1)] public bool replace; public IntPtr root; public uint length; public char first;
 }
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out FileInfo info);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle h,int kind,IntPtr info,uint size);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetKernelObjectSecurity(SafeFileHandle h,uint info,byte[] bytes,uint size,out uint needed);
 static byte[] Security(SafeFileHandle h) {
  uint n;GetKernelObjectSecurity(h,7,null,0,out n);if(n==0||n>65536)throw new InvalidOperationException("Security identity unavailable");
  var b=new byte[n];if(!GetKernelObjectSecurity(h,7,b,n,out n))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());return b;
 }
 public static bool SameSecurity(SafeFileHandle a,SafeFileHandle b) {
  var x=Security(a);var y=Security(b);if(x.Length!=y.Length)return false;for(int i=0;i<x.Length;i++)if(x[i]!=y[i])return false;return true;
 }
 public static FileInfo Info(SafeFileHandle h) {
  FileInfo i;if(!GetFileInformationByHandle(h,out i))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());return i;
 }
 public static string Id(SafeFileHandle h) {var i=Info(h);return i.volume+":"+i.indexHigh+":"+i.indexLow;}
 public static System.IO.FileStream ReplacementFile(string path,bool source) {
  // Only this source handle can delete/rename it. Neither open permits a competing writer.
  var h=CreateFile(path,0x80000000U|(source?0x10000U:0U),source?1U:5U,IntPtr.Zero,3,0,IntPtr.Zero);
  if(h.IsInvalid)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
  try{return new System.IO.FileStream(h,System.IO.FileAccess.Read);}catch{h.Dispose();throw;}
 }
 public static void ReplaceOwnedSource(SafeFileHandle source,string destination) {
  byte[] name=System.Text.Encoding.Unicode.GetBytes(destination);int offset=(int)Marshal.OffsetOf(typeof(RenameInfo),"first");
  IntPtr b=Marshal.AllocHGlobal(offset+name.Length+2);
  try {
   for(int i=0;i<offset+name.Length+2;i++)Marshal.WriteByte(b,i,0);
   Marshal.WriteByte(b,0,1);Marshal.WriteInt32(b,(int)Marshal.OffsetOf(typeof(RenameInfo),"length"),name.Length);
   Marshal.Copy(name,0,IntPtr.Add(b,offset),name.Length);
   if(!SetFileInformationByHandle(source,3,b,(uint)(offset+name.Length+2)))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
  }finally{Marshal.FreeHGlobal(b);}
 }
 public static string Final(SafeFileHandle h) {
   var b=new StringBuilder(32768);uint n=GetFinalPathNameByHandle(h,b,(uint)b.Capacity,0);
   if(n==0||n>=b.Capacity)throw new InvalidOperationException("Physical path unavailable");
   string s=b.ToString();return s.StartsWith(@"\\?\")?s.Substring(4):s;
 }
}
'@
$locks=New-Object 'System.Collections.Generic.List[System.IDisposable]'
$plain=$null;$cipher=$null;$temp=$null;$stage='initial'
function Full([string]$Path) {
    if ($Path -notmatch '^[A-Za-z]:\\' -or $Path -match '[\x00-\x1f"`$*?]' -or $Path.Split('\') -contains '..') {throw 'Explicit local path required.'}
    return [IO.Path]::GetFullPath($Path).TrimEnd('\')
}
function EqualPath([string]$A,[string]$B) {return [StringComparer]::OrdinalIgnoreCase.Equals((Full $A),(Full $B))}
function Under([string]$Root,[string]$Path) {return (Full $Path).StartsWith((Full $Root)+'\',[StringComparison]::OrdinalIgnoreCase)}
function LockParents([string]$Path) {
    $paths=New-Object 'System.Collections.Generic.List[string]';$cursor=Split-Path -Parent $Path
    while($cursor){$paths.Add($cursor);$next=Split-Path -Parent $cursor;if($next -eq $cursor){break};$cursor=$next}
    for($i=$paths.Count-1;$i -ge 0;$i--){
        $p=$paths[$i];$item=Get-Item -LiteralPath $p -Force -ErrorAction Stop
        if(-not $item.PSIsContainer -or $item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Redirected preparation parent.'}
        $handle=[EvidencePreparationHandles]::LockDirectory($p);$locks.Add($handle)
        if(-not (EqualPath ([EvidencePreparationHandles]::Final($handle)) $p)){throw 'Preparation parent identity changed.'}
    }
}
function Assert-PreparationFileSize([long]$Length,[long]$MaximumBytes) {
    if($MaximumBytes -notin @(1048576,33554432) -or $Length -lt 0 -or $Length -gt $MaximumBytes){throw 'Unsafe or oversized preparation input.'}
}
function ReadLocked([string]$Path,[long]$MaximumBytes=1048576) {
    $path=Full $Path;LockParents $path
    $item=Get-Item -LiteralPath $path -Force -ErrorAction Stop
    if($item.PSIsContainer -or $item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Unsafe preparation input.'}
    Assert-PreparationFileSize $item.Length $MaximumBytes
    $stream=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);$locks.Add($stream)
    if(-not (EqualPath ([EvidencePreparationHandles]::Final($stream.SafeFileHandle)) $path)){throw 'Preparation input identity changed.'}
    $bytes=New-Object byte[] ([int]$stream.Length);$at=0
    while($at -lt $bytes.Length){$n=$stream.Read($bytes,$at,$bytes.Length-$at);if($n -le 0){throw 'Incomplete preparation input.'};$at+=$n}
    return ,$bytes
}
function Sha([byte[]]$Bytes) {$h=[Security.Cryptography.SHA256]::Create();try{return [BitConverter]::ToString($h.ComputeHash($Bytes)).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}}
function Json([byte[]]$Bytes) {return ([Text.UTF8Encoding]::new($false,$true)).GetString($Bytes)|ConvertFrom-Json}
function Assert-SlotIdentity($C,$Owner,$Installed) {
    # SHA256 hex case is a representation detail; reject nonhex/length/padding before comparing.
    $installedHash=[string]$Installed.release_manifest_sha256;$candidateHash=[string]$C.candidate_manifest_sha256
    if($C.PSObject.Properties.Name -contains 'expected_installed_manifest_sha256') {
        if($C.operation -notin @('inspect-existing','credential')){throw 'Existing manifest binding is read-only.'}
        $candidateHash=[string]$C.expected_installed_manifest_sha256
    }
    if ($installedHash -cnotmatch '^[a-fA-F0-9]{64}$' -or $candidateHash -cnotmatch '^[a-fA-F0-9]{64}$' -or -not [StringComparer]::OrdinalIgnoreCase.Equals($installedHash,$candidateHash)) { throw 'Preparation candidate hash mismatch.' }
    if(-not (EqualPath $Owner.intended_root $C.install_root) -or -not (EqualPath $Installed.install_root $C.install_root) -or $Owner.install_nonce -cne $C.install_nonce -or $Installed.install_nonce -cne $C.install_nonce -or $Installed.owner_sid -cne $C.owner_sid){throw 'Preparation owner/nonce/candidate mismatch.'}
}
function Assert-ConfigBinding($C,$Config) {
    if($Config.schema_version -ne 1 -or -not (EqualPath $Config.workspace_root $C.workspace_root) -or -not (EqualPath $Config.project_registry $C.project_registry) -or [int]$Config.service_ports.rest -ne [int]$C.expected_rest_port){throw 'Configuration target mismatch.'}
}
function New-IsolatedConfiguration($C,$Installed,$Config) {
    Assert-ConfigBinding $C $Config
    if($Installed.installation_status -cne 'prepared' -or @($Config.PSObject.Properties.Name|Where-Object {$_ -notin @('schema_version','workspace_root','project_registry','service_ports')}).Count -ne 0){throw 'Only unconfigured prepared slot may be configured.'}
    # Clone rather than changing the caller's object on a failed later check.
    $copy=$Config|ConvertTo-Json -Depth 8|ConvertFrom-Json
    $copy|Add-Member -NotePropertyName codex_source_root -NotePropertyValue (Join-Path $C.install_root 'home\.codex')
    $copy|Add-Member -NotePropertyName local_qwen -NotePropertyValue ([ordered]@{base_url='http://127.0.0.1:1/v1'})
    return $copy
}
function Assert-IsolatedActivatedConfiguration($C,$Installed,$Config) {
    Assert-ConfigBinding $C $Config
    if($Installed.installation_status -cne 'activated' -or -not (EqualPath $Config.codex_source_root (Join-Path $C.install_root 'home\.codex')) -or $Config.local_qwen.base_url -cne 'http://127.0.0.1:1/v1' -or @($Config.local_qwen.PSObject.Properties.Name|Where-Object {$_ -ne 'base_url'}).Count -ne 0){throw 'Credential reader requires the exact activated isolated configuration.'}
}
function Assert-ResumeAdmission($C,$Installed,$Config,$TempNames,[string]$WriterState) {
    $null=New-IsolatedConfiguration $C $Installed $Config
    # The pinned fresh installer writes this RestPort-relative profile into codex-workspace, not install-manifest.
    $rest=[int]$C.expected_rest_port;$profile=[pscustomobject]@{rest=$rest;stream=$rest+1;viewer=$rest+2;mcp=$rest+3;engine=$rest+46023}
    $expected=@($profile.PSObject.Properties.Name|Sort-Object);$actual=@($Config.service_ports.PSObject.Properties.Name|Sort-Object)
    if(($expected -join '|') -cne ($actual -join '|')){throw 'Prepared port profile changed.'}
    foreach($name in $expected){if($profile.$name -cne $Config.service_ports.$name){throw 'Prepared port value changed.'}}
    if(@($TempNames).Count -ne 0 -or $WriterState -cne 'absent'){throw 'Prepared resume state is partial or writer absence is unknown.'}
}

function Assert-ActiveWriterAbsence($Writers,$Observations) {
    if(@($Writers).Count -ne 2 -or @($Observations).Count -ne 2){throw 'Both original writer observations required.'}
    $seen=@{}
    for($i=0;$i -lt 2;$i++){
        $w=@($Writers)[$i];$o=@($Observations)[$i]
        if($w.pid -le 0 -or $seen.ContainsKey([string]$w.pid) -or [string]$w.creation_filetime -notmatch '^\d{17,20}$' -or [string]::IsNullOrWhiteSpace($w.executable) -or $o.pid -ne $w.pid -or [string]$o.creation_filetime -cne [string]$w.creation_filetime -or $o.state -cne 'absent'){throw 'Original writer identity or explicit absence unavailable; HOLD.'}
        $seen[[string]$w.pid]=$true
    }
}

function Read-StreamBytes([IO.FileStream]$Stream) {
    Assert-PreparationFileSize $Stream.Length 1048576;$Stream.Position=0
    $value=New-Object byte[] ([int]$Stream.Length);$at=0
    while($at -lt $value.Length){$n=$Stream.Read($value,$at,$value.Length-$at);if($n -le 0){throw 'Incomplete locked configuration.'};$at+=$n}
    return ,$value
}
function Assert-RetainedDescriptor($C,$ConfigBytes,$ExpectedBytes,$TempNames) {
    $d=$C.retained_temp;$directory=Join-Path $C.install_root 'config'
    if(@($d.PSObject.Properties.Name).Count -ne 3 -or $d.sha256 -cnotmatch '^[a-f0-9]{64}$' -or $d.bytes -isnot [int] -or $d.bytes -le 0 -or $d.bytes -gt 1048576 -or -not (EqualPath (Split-Path -Parent $d.path) $directory) -or (Split-Path -Leaf $d.path) -cnotmatch '^evidence-config-[a-f0-9]{32}\.tmp$'){throw 'Invalid retained configuration descriptor.'}
    if(@($TempNames).Count -ne 1 -or @($TempNames)[0] -cne (Split-Path -Leaf $d.path) -or $C.expected_config_sha256 -cne (Sha $ConfigBytes) -or $ExpectedBytes.Length -ne $d.bytes -or (Sha $ExpectedBytes) -cne $d.sha256){throw 'Retained configuration is not the exact admitted transformation.'}
}
function Replace-RetainedConfiguration([string]$ConfigPath,[string]$Temp,[byte[]]$ConfigBytes,[byte[]]$Bytes) {
    $source=$null;$destination=$null
    try {
        LockParents $Temp;$item=Get-Item -LiteralPath $Temp -Force -ErrorAction Stop
        if($item.PSIsContainer -or $item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Redirected retained source.'}
        $source=[EvidencePreparationHandles]::ReplacementFile($Temp,$true)
        if(-not (EqualPath ([EvidencePreparationHandles]::Final($source.SafeFileHandle)) $Temp) -or (Sha (Read-StreamBytes $source)) -cne (Sha $Bytes) -or [EvidencePreparationHandles]::Info($source.SafeFileHandle).links -ne 1){throw 'Retained source identity or bytes changed.'}
        $sourceId=[EvidencePreparationHandles]::Id($source.SafeFileHandle);$configId=$null
        for($i=$locks.Count-1;$i -ge 0;$i--){$s=$locks[$i];if($s -is [IO.FileStream] -and (EqualPath ([EvidencePreparationHandles]::Final($s.SafeFileHandle)) $ConfigPath)){$configId=[EvidencePreparationHandles]::Id($s.SafeFileHandle);$s.Dispose();$locks.RemoveAt($i);break}}
        if(-not $configId){throw 'Original configuration handle missing.'}
        $destination=[EvidencePreparationHandles]::ReplacementFile($ConfigPath,$false)
        if(-not (EqualPath ([EvidencePreparationHandles]::Final($destination.SafeFileHandle)) $ConfigPath) -or [EvidencePreparationHandles]::Id($destination.SafeFileHandle) -cne $configId -or [EvidencePreparationHandles]::Info($destination.SafeFileHandle).links -ne 1 -or (Sha (Read-StreamBytes $destination)) -cne (Sha $ConfigBytes)){throw 'Original configuration entry changed.'}
        if(-not [EvidencePreparationHandles]::SameSecurity($source.SafeFileHandle,$destination.SafeFileHandle)){throw 'Retained source owner/group/DACL differs; HOLD.'}
        # Normal Windows rename requires the destination closed. Release only our validated handle.
        # The source DELETE/read handle remains held and denies competing write/rename throughout.
        $destination.Dispose();$destination=$null
        [EvidencePreparationHandles]::ReplaceOwnedSource($source.SafeFileHandle,$ConfigPath)
        if(-not (EqualPath ([EvidencePreparationHandles]::Final($source.SafeFileHandle)) $ConfigPath) -or [EvidencePreparationHandles]::Id($source.SafeFileHandle) -cne $sourceId -or [EvidencePreparationHandles]::Info($source.SafeFileHandle).links -ne 1 -or [IO.File]::Exists($Temp) -or (Sha (Read-StreamBytes $source)) -cne (Sha $Bytes)){throw 'Atomic retained replacement outcome unknown; HOLD.'}
        return ,(Read-StreamBytes $source)
    } finally {if($destination){$destination.Dispose()};if($source){$source.Dispose()}}
}

try {
    $stage='read-contract';$contractBytes=ReadLocked $ContractPath
    if($ContractSha256 -notmatch '^[a-f0-9]{64}$' -or (Sha $contractBytes) -cne $ContractSha256){throw 'Contract changed.'}
    $stage='validate-contract';$c=Json $contractBytes
    if($c.schema_version -ne 1 -or $c.operation -cne $Operation -or $c.execution_id -notmatch '^[a-f0-9-]{36}$' -or $c.install_nonce -notmatch '^[a-f0-9-]{32,36}$' -or $c.candidate_manifest_sha256 -notmatch '^[a-f0-9]{64}$'){throw 'Invalid preparation contract.'}
    if([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -cne $c.owner_sid){throw 'Wrong execution owner.'}
    $root=Full $c.install_root
    if(-not (Under $c.isolation_root $root) -or -not (Under $c.raw_root $ContractPath) -or -not (Under $c.raw_root $IdentityPath)){throw 'Foreign preparation root.'}
    $stage='write-identity';LockParents $IdentityPath
    $self=[Diagnostics.Process]::GetCurrentProcess()
    try {$identity=[ordered]@{pid=$self.Id;created_at_utc=$self.StartTime.ToUniversalTime().ToString('o');executable=$self.MainModule.FileName}}
    finally {$self.Dispose()}
    $identityBytes=([Text.UTF8Encoding]::new($false)).GetBytes(($identity|ConvertTo-Json -Compress))
    $identityFile=[IO.File]::Open($IdentityPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$identityFile.Write($identityBytes,0,$identityBytes.Length);$identityFile.Flush($true)}finally{$identityFile.Dispose()}
    foreach($path in @($c.workspace_root,$c.project_registry)){if(-not (Under $c.isolation_root $path) -or (Under $root $path)){throw 'Foreign support path.'}}
    $stage='read-owner';$owner=Json (ReadLocked (Join-Path $root '.agentmemory-install-owner.json'))
    $stage='read-installed';$installedBytes=ReadLocked (Join-Path $root 'config\install-manifest.json') 33554432;$installed=Json $installedBytes
    if($c.PSObject.Properties.Name -contains 'prepared_manifest_sha256'){if($c.prepared_manifest_sha256 -notmatch '^[a-f0-9]{64}$' -or (Sha $installedBytes) -cne $c.prepared_manifest_sha256){throw 'Original prepared manifest changed.'}}
    $stage='validate-identity';Assert-SlotIdentity $c $owner $installed
    $configPath=Join-Path $root 'config\codex-workspace.json'
    $stage='read-config';$configBytes=ReadLocked $configPath;$cfg=Json $configBytes
    Assert-ConfigBinding $c $cfg
    if($c.PSObject.Properties.Name -contains 'expected_config_sha256'){if($c.expected_config_sha256 -notmatch '^[a-f0-9]{64}$' -or (Sha $configBytes) -cne $c.expected_config_sha256){throw 'Configuration changed after resume admission.'}}
    if($Operation -eq 'inspect-active') {
        $stage='inspect-active';Assert-IsolatedActivatedConfiguration $c $installed $cfg
        if(@($c.closed_writers).Count -ne 2){throw 'Original producer and activation identities required.'}
        $closed=@();$seen=@{}
        foreach($w in $c.closed_writers){
            if($w.pid -le 0 -or $seen.ContainsKey([string]$w.pid) -or [string]$w.creation_filetime -notmatch '^\d{17,20}$' -or [string]::IsNullOrWhiteSpace($w.executable)){throw 'Original closed writer identity missing.'}
            $seen[[string]$w.pid]=$true;$process=$null;$absent=$false
            try{$process=[Diagnostics.Process]::GetProcessById([int]$w.pid)}catch [ArgumentException]{$absent=$true}finally{if($process){$process.Dispose()}}
            if(-not $absent){throw 'Original writer remains present or PID is reused; HOLD.'}
            $closed+=,[ordered]@{pid=[int]$w.pid;creation_filetime=[string]$w.creation_filetime;state='absent'}
        }
        Assert-ActiveWriterAbsence $c.closed_writers $closed
        [Console]::Out.Write(([ordered]@{operation='inspect-active';active=$true;execution_id=$c.execution_id;install_root=$root;owner_sid=$c.owner_sid;install_nonce=$c.install_nonce;candidate_manifest_sha256=$c.candidate_manifest_sha256;config_sha256=(Sha $configBytes);closed_writers=$closed;observed_at_utc=[DateTime]::UtcNow.ToString('o');production_qualified=$false}|ConvertTo-Json -Depth 4 -Compress))
    } elseif($Operation -eq 'inspect-existing') {
        $stage='inspect-existing';Assert-IsolatedActivatedConfiguration $c $installed $cfg
        [Console]::Out.Write(([ordered]@{operation='inspect-existing';active=$true;execution_id=$c.execution_id;install_root=$root;owner_sid=$c.owner_sid;install_nonce=$c.install_nonce;candidate_manifest_sha256=$c.candidate_manifest_sha256;installed_manifest_sha256=$c.expected_installed_manifest_sha256;config_sha256=(Sha $configBytes);observed_at_utc=[DateTime]::UtcNow.ToString('o');production_qualified=$false}|ConvertTo-Json -Compress))
    } elseif($Operation -eq 'inspect-prepared') {
        $stage='inspect-prepared'
        if($c.closed_writer.pid -le 0 -or [string]$c.closed_writer.creation_filetime -notmatch '^\d{17,20}$' -or -not (EqualPath $c.closed_writer.executable $installed.node_path)){throw 'Closed writer identity unavailable.'}
        $writer=$null;$writerState='unknown'
        try{$writer=[Diagnostics.Process]::GetProcessById([int]$c.closed_writer.pid);$writerState='present_or_reused'}catch [ArgumentException]{$writerState='absent'}finally{if($writer){$writer.Dispose()}}
        $temps=@(Get-ChildItem -LiteralPath (Split-Path -Parent $configPath) -Filter 'evidence-config-*.tmp' -Force -ErrorAction Stop|ForEach-Object {$_.Name})
        if($c.PSObject.Properties.Name -contains 'retained_temp') {
            Assert-ResumeAdmission $c $installed $cfg @() $writerState
            $expected=([Text.UTF8Encoding]::new($false)).GetBytes(((New-IsolatedConfiguration $c $installed $cfg)|ConvertTo-Json -Depth 8))
            Assert-RetainedDescriptor $c $configBytes $expected $temps
            $retained=ReadLocked $c.retained_temp.path
            if($retained.Length -ne $expected.Length -or (Sha $retained) -cne (Sha $expected)){throw 'Retained source changed before admission.'}
        } else {Assert-ResumeAdmission $c $installed $cfg $temps $writerState}
        [Console]::Out.Write(([ordered]@{execution_id=$c.execution_id;owner_sid=$c.owner_sid;observed_at_utc=[DateTime]::UtcNow.ToString('o');production_qualified=$false;operation='inspect-prepared';prepared=$true;unconfigured=$true;writer_absent=$true;install_root=$root;install_nonce=$c.install_nonce;candidate_manifest_sha256=$c.candidate_manifest_sha256;config_sha256=(Sha $configBytes)}|ConvertTo-Json -Compress))
    } elseif($Operation -eq 'configure-retained') {
        $stage='configure-build';$bytes=([Text.UTF8Encoding]::new($false)).GetBytes(((New-IsolatedConfiguration $c $installed $cfg)|ConvertTo-Json -Depth 8))
        $temps=@(Get-ChildItem -LiteralPath (Split-Path -Parent $configPath) -Filter 'evidence-config-*.tmp' -Force -ErrorAction Stop|ForEach-Object {$_.Name})
        Assert-ResumeAdmission $c $installed $cfg @() 'absent'
        Assert-RetainedDescriptor $c $configBytes $bytes $temps
        $stage='configure-replace';$actual=Replace-RetainedConfiguration $configPath $c.retained_temp.path $configBytes $bytes
        [Console]::Out.Write(([ordered]@{configured=$true;install_root=$root;install_nonce=$c.install_nonce;candidate_manifest_sha256=$c.candidate_manifest_sha256;config_sha256=(Sha $actual)}|ConvertTo-Json -Compress))
    } elseif($Operation -eq 'configure') {
        $stage='configure-build';$cfg=New-IsolatedConfiguration $c $installed $cfg
        $bytes=([Text.UTF8Encoding]::new($false)).GetBytes(($cfg|ConvertTo-Json -Depth 8))
        # No in-place write: preserve original bytes on failure; no unsafe overwrite fallback.
        $temp=Join-Path (Split-Path -Parent $configPath) ('evidence-config-'+[Guid]::NewGuid().ToString('N')+'.tmp')
        $stage='configure-temp-write';$f=[IO.File]::Open($temp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try{$f.Write($bytes,0,$bytes.Length);$f.Flush($true)}finally{$f.Dispose()}
        # Release the config file lock only; parent-directory/owner/manifest locks remain held.
        $stage='configure-release';for($i=$locks.Count-1;$i -ge 0;$i--){$s=$locks[$i];if($s -is [IO.FileStream] -and (EqualPath ([EvidencePreparationHandles]::Final($s.SafeFileHandle)) $configPath)){$s.Dispose();$locks.RemoveAt($i);break}}
        $stage='configure-check';if((Sha ([IO.File]::ReadAllBytes($configPath))) -cne (Sha $configBytes)){throw 'Concurrent configuration writer; HOLD.'}
        $stage='configure-replace';[IO.File]::Replace($temp,$configPath,[NullString]::Value);$temp=$null
        $stage='configure-verify';$actual=ReadLocked $configPath;if((Sha $actual) -cne (Sha $bytes)){throw 'Configuration changed after replacement.'}
        [Console]::Out.Write(([ordered]@{configured=$true;install_root=$root;install_nonce=$c.install_nonce;candidate_manifest_sha256=$c.candidate_manifest_sha256;config_sha256=(Sha $actual)}|ConvertTo-Json -Compress))
    } else {
        Assert-IsolatedActivatedConfiguration $c $installed $cfg
        $cipher=ReadLocked (Join-Path $root 'config\secret.dpapi')
        Add-Type -AssemblyName System.Security
        $plain=[Security.Cryptography.ProtectedData]::Unprotect($cipher,[Text.Encoding]::UTF8.GetBytes('Codex.AgentMemory.v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser)
        if($plain.Length -ne 44 -or ([Text.Encoding]::ASCII.GetString($plain)) -notmatch '^[A-Za-z0-9+/]{43}=$'){throw 'Unexpected credential envelope.'}
        # Anonymous stdout pipe only; caller must never persist this stream or its hash.
        $stdout=[Console]::OpenStandardOutput();$stdout.Write($plain,0,$plain.Length);$stdout.Flush()
    }
} catch {
    if($Operation -in @('configure','configure-retained','inspect-prepared','inspect-active','inspect-existing')) {
        $failure=$_.Exception.GetBaseException();$type=$failure.GetType().FullName
        if($type -notin @('System.ArgumentException','System.ArgumentNullException','System.IO.IOException','System.IO.FileNotFoundException','System.IO.DirectoryNotFoundException','System.UnauthorizedAccessException','System.Security.SecurityException','System.InvalidOperationException','System.NotSupportedException','System.ComponentModel.Win32Exception','System.FormatException','System.Exception','System.Management.Automation.MethodInvocationException','System.Management.Automation.RuntimeException','System.Management.Automation.PSArgumentException')){$type='System.Exception'}
        [Console]::Error.Write(([ordered]@{schema_version=1;stage=$stage;exception_type=$type;hresult=$failure.HResult.ToString('X8')}|ConvertTo-Json -Compress))
    } else {[Console]::Error.Write('Scoped preparation failed; no credential or exception text emitted.')}
    exit 1
} finally {
    if($plain){[Array]::Clear($plain,0,$plain.Length)};if($cipher){[Array]::Clear($cipher,0,$cipher.Length)}
    for($i=$locks.Count-1;$i -ge 0;$i--){$locks[$i].Dispose()}
    # Failed config temp is retained as task-owned nonsecret diagnostic material; no automatic cleanup.
}
