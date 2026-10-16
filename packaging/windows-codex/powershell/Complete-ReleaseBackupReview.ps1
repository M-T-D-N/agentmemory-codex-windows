function Complete-ReleaseBackupReview {
    param([Parameter(Mandatory)][string]$InstallRoot,
          [Parameter(Mandatory)]$Review,
          [string]$DecisionPath = '',
          [switch]$Execute)

    $unresolved = @($Review.entries | Where-Object { $_.disposition -in @('protected_unknown', 'distinct_candidate_predecessor_unknown') } | ForEach-Object path)
    $reviewStatus = $Review.PSObject.Properties['status']
    $identityIncomplete = ($null -ne $reviewStatus -and $reviewStatus.Value -eq 'protected_unknown') -or $unresolved.Count -gt 0 -or -not $Review.predecessor_known
    $result = [ordered]@{ status = 'needs_disposition'; attempted = @(); recycled = @(); retained = @(); pending = @(); unresolved = $unresolved; omitted_protected = $Review.omitted_count }
    $candidates = @($Review.entries | Where-Object disposition -eq 'older_distinct_maintenance_candidate')
    foreach ($entry in @($Review.entries | Where-Object disposition -ne 'older_distinct_maintenance_candidate')) {
        $result.retained += [pscustomobject]@{ path = $entry.path; reason = $entry.disposition }
    }
    if (-not $DecisionPath) {
        $result.pending = @($candidates | ForEach-Object path)
        if ($identityIncomplete) { $result.status = 'needs_identity_review' }
        elseif ($candidates.Count -eq 0 -and $Review.omitted_count -eq 0) { $result.status = 'protected_only' }
        return [pscustomobject]$result
    }
    $handles = @()
    $lock = $null
    try {
        function Assert-PhysicalBackupPath([string]$Path) {
            $item = Get-Item -Force -LiteralPath $Path
            while ($null -ne $item) {
                if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse path is protected: $Path" }
                $item = if ($item -is [IO.DirectoryInfo]) { $item.Parent } else { $item.Directory }
            }
        }
        function Test-ReleaseIdentity($Left, $Right) {
            return ($null -ne $Left -and $null -ne $Right -and
                $Left.release_revision -ceq $Right.release_revision -and
                $Left.data_contract_version -eq $Right.data_contract_version -and
                $Left.source_package -ceq $Right.source_package)
        }
        $root = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
        $backupRoot = [IO.Path]::GetFullPath((Join-Path $root 'backups\releases'))
        if ($backupRoot -ine [IO.Path]::GetFullPath($Review.backup_root)) { throw 'Backup review root mismatch.' }
        Assert-PhysicalBackupPath $root
        Assert-PhysicalBackupPath $DecisionPath
        if ((Get-Item -LiteralPath $DecisionPath).Length -gt 1MB) { throw 'Backup decisions exceed size limit.' }
        $plan = Get-Content -Encoding UTF8 -Raw -LiteralPath $DecisionPath | ConvertFrom-Json
        if ($plan.schema_version -ne 1 -or -not $Review.predecessor_known -or
            -not (Test-ReleaseIdentity $plan.current_release $Review.current_release) -or
            -not (Test-ReleaseIdentity $plan.immediate_predecessor $Review.immediate_predecessor)) {
            throw 'Disposition needs the exact current release and actual predecessor.'
        }
        foreach ($scope in @('code_data_recovery', 'consumers_and_publication')) {
            if ($plan.$scope.completed -isnot [bool] -or $plan.$scope.completed -ne $true -or [string]::IsNullOrWhiteSpace($plan.$scope.evidence)) {
                throw "Missing completed $scope review and evidence reference."
            }
        }
        $decisions = @($plan.decisions)
        $seen = @{}
        foreach ($decision in $decisions) {
            if (-not [IO.Path]::IsPathRooted([string]$decision.path)) { throw 'Backup decisions require exact absolute paths.' }
            $path = [IO.Path]::GetFullPath([string]$decision.path)
            if ($seen.ContainsKey($path) -or [string]::IsNullOrWhiteSpace($decision.reason) -or
                $decision.action -notin @('retain', 'recycle')) { throw 'Invalid or repeated backup decision.' }
            $seen[$path] = $decision
            $matches = @($candidates | Where-Object { $_.path -ieq $path })
            if ($matches.Count -ne 1) { throw "Decision is not an older reviewed candidate: $path" }
            if ($decision.action -eq 'recycle') {
                if ([IO.Path]::GetDirectoryName($path) -ine $backupRoot -or
                    [IO.Path]::GetFileName($path) -notmatch '^[0-9]{8}T[0-9]{9}Z\.zip$') {
                    throw 'Only exact direct-child completed ZIP backups can be recycled.'
                }
                foreach ($scope in @('code_data_recovery', 'consumers_and_publication')) {
                    foreach ($pin in @($plan.$scope.protected_paths)) {
                        $protected = [IO.Path]::GetFullPath([string]$pin).TrimEnd('\')
                        if ($path -ieq $protected -or $path.StartsWith($protected + '\', [StringComparison]::OrdinalIgnoreCase)) {
                            throw "Backup is pinned by $scope`: $path"
                        }
                    }
                }
                Assert-PhysicalBackupPath $path
                $handle = [IO.File]::Open($path, 'Open', 'Read', ([IO.FileShare]::Read -bor [IO.FileShare]::Delete))
                $handles += $handle
                if ($decision.sha256 -notmatch '^[A-Fa-f0-9]{64}$' -or
                    (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ine $decision.sha256) { throw 'Approved backup bytes changed.' }
            }
        }
        foreach ($candidate in $candidates) {
            if (-not $seen.ContainsKey([string]$candidate.path)) { $result.pending += $candidate.path }
        }
        if ($result.pending.Count -gt 0) { throw 'All reviewed older candidates need an explicit retain or recycle decision.' }
        $lockPath = Join-Path $root 'data\startup.lock'
        Assert-PhysicalBackupPath (Join-Path $root 'data')
        Assert-PhysicalBackupPath (Join-Path $root 'config\install-manifest.json')
        if (Test-Path -LiteralPath $lockPath) { Assert-PhysicalBackupPath $lockPath }
        $lock = [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None')
        $live = Get-Content -Encoding UTF8 -Raw -LiteralPath (Join-Path $root 'config\install-manifest.json') | ConvertFrom-Json
        $liveIdentity = [pscustomobject]@{ release_revision = $live.release_revision; data_contract_version = $live.data_contract_version; source_package = $live.package_relative_path }
        if (-not (Test-ReleaseIdentity $liveIdentity $Review.current_release)) { throw 'Installation changed after retention review.' }
        foreach ($decision in $decisions) {
            if ($decision.action -eq 'retain') {
                $result.retained += [pscustomobject]@{ path = $decision.path; reason = $decision.reason }
                continue
            }
            if (-not $Execute) { $result.pending += $decision.path; continue }
            Assert-PhysicalBackupPath $decision.path
            $attempt = [pscustomobject]@{ path = $decision.path; original_present = $true; verified = $false }
            $result.attempted += $attempt
            $recycledPath = Send-CompletedBackupToRecycleBin -Path $decision.path
            $result.recycled += [pscustomobject]@{ path = $decision.path; recycle_path = $recycledPath; bytes = $null; reason = $decision.reason; verified = $false }
            if ((Test-Path -LiteralPath $decision.path) -or -not (Test-Path -LiteralPath $backupRoot -PathType Container) -or
                -not (Test-Path -LiteralPath $recycledPath -PathType Leaf) -or
                (Get-FileHash -LiteralPath $recycledPath -Algorithm SHA256).Hash -ine $decision.sha256) {
                throw "Recycle verification failed; stop after $($decision.path)"
            }
            $result.recycled[-1].bytes = (Get-Item -LiteralPath $recycledPath).Length
            $recycleName = [IO.Path]::GetFileName($recycledPath)
            if (-not $recycleName.StartsWith('$R', [StringComparison]::Ordinal)) { throw 'Unexpected recycle payload name.' }
            $receiptPath = Join-Path ([IO.Path]::GetDirectoryName($recycledPath)) ('$I' + $recycleName.Substring(2))
            $receipt = [IO.File]::ReadAllBytes($receiptPath)
            $version = [BitConverter]::ToInt64($receipt, 0)
            if ($version -eq 2) {
                $original = [Text.Encoding]::Unicode.GetString($receipt, 28, [BitConverter]::ToInt32($receipt, 24) * 2).TrimEnd([char]0)
            } elseif ($version -eq 1) {
                $original = [Text.Encoding]::Unicode.GetString($receipt, 24, $receipt.Length - 24).TrimEnd([char]0)
            } else { throw 'Unknown recycle receipt version.' }
            if ($original -ine [IO.Path]::GetFullPath($decision.path) -or
                [BitConverter]::ToInt64($receipt, 8) -ne $result.recycled[-1].bytes) { throw 'Recycle receipt identity mismatch.' }
            $result.recycled[-1] | Add-Member -NotePropertyName receipt_path -NotePropertyValue $receiptPath
            $result.recycled[-1].verified = $true
            $attempt.original_present = $false
            $attempt.verified = $true
        }
        $result.status = if (-not $Execute) { 'planned' } elseif ($identityIncomplete) { 'disposed_reviewed_scope_identity_pending' } elseif ($Review.omitted_count -gt 0) { 'disposed_reviewed_scope_omitted_protected' } else { 'disposed' }
    }
    catch {
        $result.status = 'incomplete'; $result.error = $_.Exception.Message
        foreach ($attempt in $result.attempted) { $attempt.original_present = Test-Path -LiteralPath $attempt.path }
    }
    finally {
        if ($lock) { $lock.Dispose() }
        foreach ($handle in $handles) { $handle.Dispose() }
    }
    return [pscustomobject]$result
}

function Send-CompletedBackupToRecycleBin {
    param([Parameter(Mandatory)][string]$Path)
    if (-not ('AgentMemory.BackupRecycle' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace AgentMemory {
 [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 public interface IShellItem {
  void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
  void GetParent(out IShellItem parent);
  void GetDisplayName(uint sigdn, [MarshalAs(UnmanagedType.LPWStr)] out string name);
  void GetAttributes(uint mask, out uint attrs);
  void Compare(IShellItem other, uint hint, out int order);
 }
 [ComImport, Guid("947aab5f-0a5c-4c13-b4d6-4bf7836fc9f8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 public interface IFileOperation {
  void Advise(IProgress sink, out uint cookie); void Unadvise(uint cookie);
  void SetOperationFlags(uint flags); void SetProgressMessage([MarshalAs(UnmanagedType.LPWStr)] string text);
  void SetProgressDialog(IntPtr dialog); void SetProperties(IntPtr props); void SetOwnerWindow(IntPtr hwnd);
  void ApplyPropertiesToItem(IShellItem item); void ApplyPropertiesToItems(IntPtr items);
  void RenameItem(IShellItem item, [MarshalAs(UnmanagedType.LPWStr)] string name, IProgress sink); void RenameItems(IntPtr items, IntPtr name);
  void MoveItem(IShellItem item, IShellItem dest, IntPtr name, IProgress sink); void MoveItems(IntPtr items, IShellItem dest);
  void CopyItem(IShellItem item, IShellItem dest, IntPtr name, IProgress sink); void CopyItems(IntPtr items, IShellItem dest);
  void DeleteItem(IShellItem item, IProgress sink); void DeleteItems(IntPtr items);
  void NewItem(IShellItem dest, uint attrs, IntPtr name, IntPtr template, IProgress sink);
  void PerformOperations(); void GetAnyOperationsAborted([MarshalAs(UnmanagedType.Bool)] out bool aborted);
 }
 [Guid("04b0f1a7-9490-44bc-96e1-4296a31252e2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 public interface IProgress {
  [PreserveSig] int StartOperations(); [PreserveSig] int FinishOperations(int hr);
  [PreserveSig] int PreRenameItem(uint f, IShellItem i, IntPtr n); [PreserveSig] int PostRenameItem(uint f, IShellItem i, IntPtr n, int h, IShellItem x);
  [PreserveSig] int PreMoveItem(uint f, IShellItem i, IShellItem d, IntPtr n); [PreserveSig] int PostMoveItem(uint f, IShellItem i, IShellItem d, IntPtr n, int h, IShellItem x);
  [PreserveSig] int PreCopyItem(uint f, IShellItem i, IShellItem d, IntPtr n); [PreserveSig] int PostCopyItem(uint f, IShellItem i, IShellItem d, IntPtr n, int h, IShellItem x);
  [PreserveSig] int PreDeleteItem(uint f, IShellItem i); [PreserveSig] int PostDeleteItem(uint f, IShellItem i, int h, IShellItem x);
  [PreserveSig] int PreNewItem(uint f, IShellItem d, IntPtr n); [PreserveSig] int PostNewItem(uint f, IShellItem d, IntPtr n, IntPtr t, uint a, int h, IShellItem x);
  [PreserveSig] int UpdateProgress(uint total, uint done); [PreserveSig] int ResetTimer(); [PreserveSig] int PauseTimer(); [PreserveSig] int ResumeTimer();
 }
 [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
 public class RecycleSink : IProgress {
  public string Destination; public int Result = unchecked((int)0x80004004);
  public int StartOperations(){return 0;} public int FinishOperations(int h){return 0;}
  public int PreRenameItem(uint f,IShellItem i,IntPtr n){return unchecked((int)0x80004004);} public int PostRenameItem(uint f,IShellItem i,IntPtr n,int h,IShellItem x){return 0;}
  public int PreMoveItem(uint f,IShellItem i,IShellItem d,IntPtr n){return unchecked((int)0x80004004);} public int PostMoveItem(uint f,IShellItem i,IShellItem d,IntPtr n,int h,IShellItem x){return 0;}
  public int PreCopyItem(uint f,IShellItem i,IShellItem d,IntPtr n){return unchecked((int)0x80004004);} public int PostCopyItem(uint f,IShellItem i,IShellItem d,IntPtr n,int h,IShellItem x){return 0;}
  public int PreDeleteItem(uint f,IShellItem i){return (f & 0x80)!=0 ? 0 : unchecked((int)0x80004004);}
  public int PostDeleteItem(uint f,IShellItem i,int h,IShellItem x){Result=h; if(h>=0 && x!=null){try{x.GetDisplayName(0x80058000,out Destination);}catch{return unchecked((int)0x80004005);}} return h;}
  public int PreNewItem(uint f,IShellItem d,IntPtr n){return unchecked((int)0x80004004);} public int PostNewItem(uint f,IShellItem d,IntPtr n,IntPtr t,uint a,int h,IShellItem x){return 0;}
  public int UpdateProgress(uint t,uint d){return 0;} public int ResetTimer(){return 0;} public int PauseTimer(){return 0;} public int ResumeTimer(){return 0;}
 }
 public static class BackupRecycle {
  [DllImport("shell32.dll",CharSet=CharSet.Unicode,PreserveSig=false)] static extern void SHCreateItemFromParsingName(string path,IntPtr pbc,ref Guid iid,out IShellItem item);
  public static string Recycle(string path) {
   IShellItem item=null; IFileOperation op=null;
   try {
    Guid iid=typeof(IShellItem).GUID; SHCreateItemFromParsingName(path,IntPtr.Zero,ref iid,out item);
    op=(IFileOperation)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("3ad05575-8857-4850-9277-11b85bdb8e09")));
    var sink=new RecycleSink(); op.SetOperationFlags(0x80000|0x100000|0x400|0x10|0x4);
    op.DeleteItem(item,sink); op.PerformOperations(); bool aborted; op.GetAnyOperationsAborted(out aborted);
    if(aborted || sink.Result<0 || String.IsNullOrEmpty(sink.Destination)) throw new InvalidOperationException("Recycle-only operation failed or was refused.");
    return sink.Destination;
   } finally {if(op!=null)Marshal.ReleaseComObject(op); if(item!=null)Marshal.ReleaseComObject(item);}
  }
 }
}
'@
    }
    return [AgentMemory.BackupRecycle]::Recycle($Path)
}
