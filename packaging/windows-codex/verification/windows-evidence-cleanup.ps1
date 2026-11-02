param([string]$ContractPath,[ValidateSet('preflight','inspect','stop-watchdog','cleanup-retain','cleanup-remove')][string]$Operation='inspect',[string]$EvidenceIdentityPath)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
function Assert-PhysicalPath([string]$Path) {
    if ($Path -notmatch '^[A-Za-z]:\\' -or $Path -match '[\x00-\x1f"`$*?]' -or $Path.Split('\') -contains '..') { throw 'Explicit local physical path required.' }
    $cursor=[IO.Path]::GetFullPath($Path)
    while ($cursor) {
        try { $item=Get-Item -Force -LiteralPath $cursor -ErrorAction Stop; if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Redirected ownership path.' } }
        catch [System.Management.Automation.ItemNotFoundException] { }
        $parent=Split-Path -Parent $cursor; if ($parent -eq $cursor) { break };$cursor=$parent
    }
}
function Read-Object([string]$Path) { Assert-PhysicalPath $Path; return (Get-Content -LiteralPath $Path -Encoding UTF8 -Raw -ErrorAction Stop | ConvertFrom-Json) }
function Has-Path([string]$Path) { try { [void](Get-Item -LiteralPath $Path -Force -ErrorAction Stop);return $true } catch [System.Management.Automation.ItemNotFoundException] { return $false } }
function Same-Path([string]$A,[string]$B) { return [StringComparer]::OrdinalIgnoreCase.Equals([IO.Path]::GetFullPath($A).TrimEnd('\'),[IO.Path]::GetFullPath($B).TrimEnd('\')) }
function Assert-Hash([string]$Path,[string]$Expected) { Assert-PhysicalPath $Path;if ($Expected -notmatch '^[a-fA-F0-9]{64}$' -or (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash -ine $Expected) { throw 'Pinned qualification tool or installed script changed.' } }
function Text-Hash([string]$Value) { $h=[Security.Cryptography.SHA256]::Create();try{return [BitConverter]::ToString($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()} }
function Assert-Contract($C) {
    if ($C.schema_version -ne 1 -or $C.execution_id -notmatch '^[a-f0-9-]{36}$' -or $C.owner_sid -notmatch '^S-1-' -or $C.candidate_manifest_sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Incomplete ownership contract.' }
    Assert-PhysicalPath $C.raw_root
    $capture=[IO.Path]::GetFullPath($C.raw_root).TrimEnd('\')+'\';if ($capture.Length -le 3 -or -not ([IO.Path]::GetFullPath($ContractPath)).StartsWith($capture,[StringComparison]::OrdinalIgnoreCase) -or -not ([IO.Path]::GetFullPath($EvidenceIdentityPath)).StartsWith($capture,[StringComparison]::OrdinalIgnoreCase)) {throw 'Ownership evidence output escapes capture root.'}
    foreach($path in @($C.isolation_root,$C.install_root,$C.node_path,$C.powershell_path,$C.evidence_path,$C.lifecycle_path)) { Assert-PhysicalPath $path }
    $prefix=[IO.Path]::GetFullPath($C.isolation_root).TrimEnd('\')+'\';$full=[IO.Path]::GetFullPath($C.install_root).TrimEnd('\')
    if ($prefix.Length -le 3 -or -not $full.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)) { throw 'Installation is outside its exact isolation root.' }
    if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -cne $C.owner_sid) { throw 'Execution account is not the planned owner.' }
    if ($C.expected_rest_port -lt 1 -or $C.expected_rest_port -gt 19512) { throw 'Unsupported isolated port.' }
}
function Assert-InstalledScripts($C,$Installed) {
    $hashes=if ($Installed.release_manifest_sha256 -ieq $C.candidate_manifest_sha256) {$C.candidate_hashes} else {$C.predecessor_hashes}
    if ($null -eq $hashes) { throw 'Pinned predecessor inventory is required.' }
    foreach($entry in $hashes.PSObject.Properties) {
        if ($entry.Name -notlike 'scripts\*') { continue }
        if ($entry.Name.Split('\') -contains '..' -or [IO.Path]::IsPathRooted($entry.Name)) { throw 'Inventory escapes installation.' }
        Assert-Hash (Join-Path $C.install_root $entry.Name) ([string]$entry.Value)
    }
}
function Get-TaskOrAbsent([string]$Name) {
    try { return Get-ScheduledTask -TaskPath '\' -TaskName $Name -ErrorAction Stop }
    catch { if ($_.FullyQualifiedErrorId -like 'CmdletizationQuery_NotFound*' -or $_.FullyQualifiedErrorId -like 'NoMatchingMSFT_ScheduledTask*') { return $null };throw }
}
function Assert-ProcessCreationIdentity([DateTimeOffset]$CurrentCreation,[DateTimeOffset]$RecordedCreation,$CimCreation) {
    # Keep the stored Process.StartTime identity exact at 100ns, before aligning the other API.
    $currentTicks=$CurrentCreation.UtcDateTime.Ticks
    if ($currentTicks -ne $RecordedCreation.UtcDateTime.Ticks) { throw 'Recorded PID was reused; no process will be signalled.' }
    if ($CimCreation -isnot [DateTime] -or $CimCreation.Kind -eq [DateTimeKind]::Unspecified) { throw 'Unknown CIM creation time type or zone.' }
    $cimTicks=([DateTimeOffset]$CimCreation).UtcDateTime.Ticks
    # CIM_DATETIME has six microsecond digits; DateTime ticks are 100ns.
    # https://learn.microsoft.com/en-us/windows/win32/wmisdk/cim-datetime
    # Integer division avoids PowerShell / choosing Double for one operand and Int64 for the other.
    [long]$currentRemainder=0;[long]$cimRemainder=0
    $currentMicroseconds=[Math]::DivRem([long]$currentTicks,[long]10,[ref]$currentRemainder)
    $cimMicroseconds=[Math]::DivRem([long]$cimTicks,[long]10,[ref]$cimRemainder)
    if ($cimRemainder -ne 0 -or $currentMicroseconds -ne $cimMicroseconds) { throw 'Process observation raced PID reuse or unsupported CIM precision.' }
}
function Assert-SameManagedPathIdentity([string]$Actual,[string]$Expected) {
    foreach($path in @($Actual,$Expected)){if($path -notmatch '^[A-Za-z]:[\\/]' -or @($path -split '[\\/]' | Where-Object {$_ -in @('.','..')}).Count){throw 'Managed argv path must be explicit and canonical.'}}
    if(-not (Same-Path $Actual $Expected)){throw 'Managed process argv path differs.'}
    Assert-PhysicalPath $Actual;Assert-PhysicalPath $Expected
    if(-not ('AgentMemoryQualification.PathIdentity' -as [type])) {
        Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;using Microsoft.Win32.SafeHandles;
namespace AgentMemoryQualification {public static class PathIdentity {
 [StructLayout(LayoutKind.Sequential)] public struct Info {public uint attributes;public System.Runtime.InteropServices.ComTypes.FILETIME creation,access,write;public uint volume,sizeHigh,sizeLow,links,indexHigh,indexLow;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern SafeFileHandle CreateFile(string p,uint a,uint s,IntPtr x,uint d,uint f,IntPtr t);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info i);
 public static string Id(string path){using(var h=CreateFile(path,0,7,IntPtr.Zero,3,0x02000000,IntPtr.Zero)){if(h.IsInvalid)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());Info i;if(!GetFileInformationByHandle(h,out i))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());return i.volume+":"+i.indexHigh+":"+i.indexLow;}}
}}
'@
    }
    if([AgentMemoryQualification.PathIdentity]::Id($Actual) -cne [AgentMemoryQualification.PathIdentity]::Id($Expected)){throw 'Managed argv physical file identity differs.'}
}
function Assert-ManagedProcessArguments($Tokens,[string]$Role,$Record,$C) {
    if($Role -notin @('daemon','watchdog')){throw 'Unsupported managed argv role.'}
    $script=if ($Role -eq 'daemon') {'agentmemory-task.ps1'} else {'agentmemory-watch.ps1'}
    $expected=@([string]$C.powershell_path,'-NoLogo','-NoProfile','-NonInteractive','-WindowStyle','Hidden','-File',(Join-Path $C.install_root ('scripts\'+$script)),'-Root',[string]$C.install_root)
    if ($Role -eq 'daemon') { $expected+=@('-HiddenLauncherPid',[string]$Record.parent_pid) }
    if (@($Tokens).Count -ne $expected.Count) { throw 'Unexpected managed process argument count.' }
    for($i=0;$i -lt $expected.Count;$i++) {
        if($i -in @(0,7,9)){Assert-SameManagedPathIdentity ([string]$Tokens[$i]) ([string]$expected[$i])}
        elseif($Tokens[$i] -cne $expected[$i]){throw 'Managed process argv differs.'}
    }
}
function Get-RecordedProcess($Record,[string]$Role,$C) {
    if ($null -eq $Record -or [int]$Record.pid -le 0 -or -not $Record.creation_date) { throw 'Incomplete recorded process identity.' }
    $process=$null
    try {
        try { $process=[Diagnostics.Process]::GetProcessById([int]$Record.pid) } catch [ArgumentException] { return [ordered]@{role=$Role;pid=[int]$Record.pid;state='absent';creation_date=[string]$Record.creation_date} }
        $created=$process.StartTime.ToUniversalTime().ToString('o')
        if (([DateTimeOffset]$created).UtcDateTime.Ticks -ne ([DateTimeOffset]$Record.creation_date).UtcDateTime.Ticks) { throw 'Recorded PID was reused; no process will be signalled.' }
        $actual=Get-CimInstance Win32_Process -Filter ('ProcessId = '+[int]$Record.pid) -ErrorAction Stop
        if ($null -eq $actual -or $process.HasExited) { throw 'Process changed during ownership observation.' }
        Assert-ProcessCreationIdentity ([DateTimeOffset]$created) ([DateTimeOffset]$Record.creation_date) $actual.CreationDate
        if (-not (Same-Path ([string]$actual.ExecutablePath) ([string]$Record.executable_path)) -or [int]$actual.ParentProcessId -ne [int]$Record.parent_pid) { throw 'Recorded executable/parent differs.' }
        if ($Role -in @('engine','worker')) {
            if ($null -ne $Record.PSObject.Properties['command_line']) {
                if (-not $Record.command_line -or [string]$actual.CommandLine -cne [string]$Record.command_line) { throw 'Recorded command differs.' }
            } elseif ($null -eq $Record.PSObject.Properties['command_sha256'] -or (Text-Hash ([string]$actual.CommandLine)) -cne $Record.command_sha256) { throw 'Previously observed command differs.' }
        } else {
            # Inspect existing launcher argv only. This helper never issues an ExecutionPolicy override.
            $tokens=@([AgentMemoryQualification.Arguments]::Split([string]$actual.CommandLine))
            Assert-ManagedProcessArguments $tokens $Role $Record $C
        }
        return [ordered]@{role=$Role;pid=[int]$Record.pid;state='present';creation_date=$created;parent_pid=[int]$actual.ParentProcessId;executable_path=[string]$actual.ExecutablePath;command_sha256=(Text-Hash ([string]$actual.CommandLine))}
    } finally { if ($null -ne $process) {$process.Dispose()} }
}
function Observe-RecordedProcesses($Records,$Previous,$C) {
    $current=@{};$observed=@{}
    foreach($entry in $Records) {
        if ($entry.role -notin @('daemon','engine','worker','watchdog') -or $current.ContainsKey($entry.role) -or $null -eq $entry.record) {throw 'Unknown/duplicate process role.'}
        $current[$entry.role]=$entry.record
    }
    if ($null -ne $Previous) {
        foreach($old in $Previous.processes) {
            if ($old.role -notin @('daemon','engine','worker','watchdog') -or $observed.ContainsKey($old.role)) {throw 'Unknown/duplicate prior process role.'}
            # Re-observe every prior PID even when runtime state no longer mentions it.
            $seen=Get-RecordedProcess $old $old.role $C
            if ($seen.state -notin @('present','absent')) {throw 'Prior process outcome unknown.'}
            if ($current.ContainsKey($old.role)) {
                $record=$current[$old.role]
                if ($record.pid -ne $old.pid -or $record.creation_date -cne $old.creation_date) {throw 'Prior process identity changed.'}
            }
            $observed[$old.role]=$seen
        }
    }
    foreach($role in $current.Keys) {
        if (-not $observed.ContainsKey($role)) {$observed[$role]=Get-RecordedProcess $current[$role] $role $C}
    }
    return @($observed.Keys | Sort-Object | ForEach-Object {$observed[$_]})
}
function Observe-Owned($C) {
    Assert-Contract $C
    $owner=Read-Object (Join-Path $C.install_root '.agentmemory-install-owner.json');$installed=Read-Object (Join-Path $C.install_root 'config\install-manifest.json')
    if (-not (Same-Path $owner.intended_root $C.install_root) -or -not (Same-Path $installed.install_root $C.install_root) -or $owner.install_nonce -cne $C.install_nonce -or $installed.install_nonce -cne $C.install_nonce -or $installed.owner_sid -cne $C.owner_sid) { throw 'Root/nonce/owner mismatch.' }
    if ($installed.release_manifest_sha256 -ine $C.candidate_manifest_sha256 -and $installed.release_manifest_sha256 -ine $C.predecessor_manifest_sha256) { throw 'Unknown installed candidate.' }
    Assert-InstalledScripts $C $installed
    $cfg=Read-Object (Join-Path $C.install_root 'config\codex-workspace.json');if ([int]$cfg.service_ports.rest -ne [int]$C.expected_rest_port) {throw 'Installation port changed.'}
    $tasks=@();$taskObjects=@()
    foreach($pair in @(@('daemon','task-registration.json'),@('watchdog','watchdog-task-registration.json'))) {
        $registration=Read-Object (Join-Path $C.install_root ('config\'+$pair[1]));Assert-AgentMemoryTaskRegistration -Root $C.install_root -OwnerSid $C.owner_sid -InstallNonce $C.install_nonce -Kind $pair[0] -Registration $registration
        $task=Get-TaskOrAbsent $registration.task_name
        if ($null -ne $task) { [void](Assert-AgentMemoryScheduledTaskOwnership -Root $C.install_root -OwnerSid $C.owner_sid -InstallNonce $C.install_nonce -Kind $pair[0] -Registration $registration -Task $task);if([string]$task.State -notin @('Ready','Running','Disabled')){throw 'Unknown or queued task state.'};$taskObjects+=$task }
        elseif ($installed.installation_status -ne 'prepared') { throw 'Activated installation task is absent.' }
        $tasks+=@([ordered]@{kind=$pair[0];name=$registration.task_name;path=$registration.task_path;state=$(if($null -eq $task){'Absent'}else{[string]$task.State});registration=$registration;actual_action=$(if($null -eq $task){$null}else{[ordered]@{execute=[string]$task.Actions[0].Execute;arguments=[string]$task.Actions[0].Arguments;working_directory=[string]$task.Actions[0].WorkingDirectory;owner_sid=(Resolve-AgentMemoryTaskPrincipalSid -UserId ([string]$task.Principal.UserId))}});identity_sha256=(Text-Hash ($registration | ConvertTo-Json -Depth 8 -Compress))})
    }
    $records=@();$runtime=$null;$watchdogActive=$false
    $runtimePath=Join-Path $C.install_root 'data\runtime-state.json'
    if (Has-Path $runtimePath) {
        $runtime=Read-Object $runtimePath;if (-not (Same-Path $runtime.root $C.install_root) -or -not $runtime.run_id -or $runtime.status -notin @('active','inactive','failed')) {throw 'Unknown runtime state.'}
        foreach($role in @('daemon','engine','worker')) {if ($null -ne $runtime.PSObject.Properties[$role] -and $null -ne $runtime.$role) {$records+=@([pscustomobject]@{role=$role;record=$runtime.$role})}}
    } elseif ($installed.installation_status -ne 'prepared') {throw 'Missing runtime evidence.'}
    $watchPath=Join-Path $C.install_root 'data\watchdog-state.json'
    if (Has-Path $watchPath) {
        $watch=Read-Object $watchPath
        if ($watch.status -notin @('active','inactive')) {throw 'Unknown watchdog state.'}
        $watchdogActive=$watch.status -eq 'active'
        $watchRecord=[pscustomobject]@{pid=$watch.watcher_pid;creation_date=$watch.watcher_process_started_at_utc;executable_path=$C.powershell_path;parent_pid=0}
        $live=Get-CimInstance Win32_Process -Filter ('ProcessId = '+[int]$watchRecord.pid) -ErrorAction Stop
        if ($null -ne $live) {
            $parent=Get-CimInstance Win32_Process -Filter ('ProcessId = '+[int]$live.ParentProcessId) -ErrorAction Stop
            if ($null -eq $parent -or -not (Same-Path ([string]$parent.ExecutablePath) (Join-Path $C.install_root 'bin\agentmemory-hidden-launcher.exe'))) {throw 'Watchdog parent is not the owned launcher.'}
            $argv=@([AgentMemoryQualification.Arguments]::Split([string]$parent.CommandLine));if ($argv.Count -ne 2 -or $argv[1] -cne 'watch') {throw 'Watchdog launcher argv differs.'}
            $watchRecord.parent_pid=[int]$live.ParentProcessId
        }
        $records+=@([pscustomobject]@{role='watchdog';record=$watchRecord})
    }
    $processes=@(Observe-RecordedProcesses $records $C.previous $C)
    if ($null -ne $runtime -and $runtime.status -eq 'active') {foreach($role in @('daemon','engine','worker')) {if (@($processes | Where-Object {$_.role -ceq $role -and $_.state -ceq 'present'}).Count -ne 1) {throw 'Active runtime process is not present.'}}}
    $model='other';if ($null -ne $cfg.PSObject.Properties['local_qwen'] -and $null -ne $cfg.local_qwen.PSObject.Properties['base_url'] -and $cfg.local_qwen.base_url -ceq 'http://127.0.0.1:1/v1' -and $null -eq $cfg.local_qwen.PSObject.Properties['lifecycle_script']) {$model='http://127.0.0.1:1/v1'}
    return [pscustomobject]@{proof=[ordered]@{execution_id=$C.execution_id;installation_id=$C.installation_id;install_root=$C.install_root;owner_sid=$C.owner_sid;install_nonce=$C.install_nonce;operation=$Operation;observed_at_utc=[DateTime]::UtcNow.ToString('o');status=$(if($null -ne $runtime){$runtime.status}else{'prepared'});model_origin=$model;watchdog_active=$watchdogActive;installed_manifest_sha256=$installed.release_manifest_sha256;tasks=@($tasks);processes=@($processes)};task_objects=@($taskObjects)}
}
function Assert-Previous($Previous,$Current) {
    if ($null -eq $Previous -or $Previous.execution_id -cne $Current.execution_id -or $Previous.installation_id -cne $Current.installation_id -or $Previous.install_nonce -cne $Current.install_nonce -or -not (Same-Path $Previous.install_root $Current.install_root)) {throw 'Missing owned prior observation.'}
    if (@($Previous.tasks).Count -ne @($Current.tasks).Count -or @($Previous.processes).Count -ne @($Current.processes).Count) {throw 'Prior role/task coverage changed.'}
    foreach($old in $Previous.processes) {if (@($Current.processes | Where-Object {$_.role -ceq $old.role -and $_.pid -eq $old.pid}).Count -ne 1) {throw 'Prior process was not re-observed.'}}
    foreach($task in $Current.tasks) {$old=@($Previous.tasks | Where-Object {$_.name -ceq $task.name});if($old.Count -ne 1 -or $old[0].identity_sha256 -cne $task.identity_sha256){throw 'Task identity changed.'}}
    foreach($proc in $Current.processes) {
        if ($proc.state -notin @('present','absent')) {throw 'Process observation unknown.'}
        $old=@($Previous.processes | Where-Object {$_.role -ceq $proc.role -and $_.pid -eq $proc.pid});if($old.Count -ne 1 -or $old[0].creation_date -cne $proc.creation_date){throw 'Process identity changed.'}
        if($proc.state -eq 'present' -and ($old[0].state -cne 'present' -or $old[0].parent_pid -ne $proc.parent_pid -or $old[0].command_sha256 -cne $proc.command_sha256 -or -not (Same-Path $old[0].executable_path $proc.executable_path))){throw 'Process binding changed.'}
    }
}
function Assert-InactiveObservation($Value) {
    if (@($Value.processes | Where-Object {$_.state -ne 'absent'}).Count -or @($Value.tasks | Where-Object {$_.state -notin @('Ready','Disabled','Absent')}).Count) {throw 'Recorded process/task still active or unknown; no cleanup performed.'}
}
if ($MyInvocation.InvocationName -eq '.') {return}
if (-not $ContractPath -or -not $EvidenceIdentityPath) {throw 'Explicit owned contract and identity output required.'}
$c=Read-Object $ContractPath;Assert-Contract $c;Assert-Hash $c.evidence_path $c.evidence_sha256;Assert-Hash $c.lifecycle_path $c.lifecycle_sha256
. $c.evidence_path
Initialize-AgentMemoryEvidenceCapture -Utf8 -IdentityPath $EvidenceIdentityPath
if ($Operation -eq 'preflight') {
    if (Has-Path $c.install_root) {throw 'Fresh root already exists.'}
    $ports=@([int]$c.expected_rest_port,([int]$c.expected_rest_port+1),([int]$c.expected_rest_port+2),([int]$c.expected_rest_port+3),([int]$c.expected_rest_port+46023))
    if (@([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object {$_.Port -in $ports}).Count -ne 0) {throw 'Isolated port collision.'}
    [ordered]@{execution_id=$c.execution_id;installation_id=$c.installation_id;install_root=$c.install_root;owner_sid=$c.owner_sid;operation=$Operation;status='absent';observed_at_utc=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Depth 8;exit 0
}
. $c.lifecycle_path
if (-not ('AgentMemoryQualification.Arguments' -as [type])) {
    Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;namespace AgentMemoryQualification { public static class Arguments {[DllImport("shell32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr CommandLineToArgvW(string s,out int n);[DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);public static string[] Split(string s){int n;IntPtr p=CommandLineToArgvW(s,out n);if(p==IntPtr.Zero)throw new System.ComponentModel.Win32Exception();try{string[] r=new string[n];for(int i=0;i<n;i++)r[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(p,i*IntPtr.Size));return r;}finally{LocalFree(p);}}} }'
}
$observed=Observe-Owned $c
if ($Operation -eq 'inspect') {$observed.proof | ConvertTo-Json -Depth 12;exit 0}
Assert-Previous $c.previous $observed.proof
if ($Operation -eq 'stop-watchdog') {
    if (-not $observed.proof.watchdog_active) {throw 'Watchdog is not active; duplicate stop refused.'}
    $script=Join-Path $c.install_root 'scripts\agentmemory-watch-stop.ps1';Assert-Hash $script $c.candidate_hashes.'scripts\agentmemory-watch-stop.ps1'
    & $script -Root $c.install_root
    if (-not $?) {throw 'Normal watchdog stop failed.'}
    $after=Observe-Owned $c;if ($after.proof.watchdog_active -or @($after.proof.processes | Where-Object {$_.role -eq 'watchdog' -and $_.state -ne 'absent'}).Count) {throw 'Watchdog stop remains unconfirmed.'}
    $after.proof | ConvertTo-Json -Depth 12;exit 0
}
Assert-InactiveObservation $observed.proof
if ($Operation -eq 'cleanup-remove') {
    if (-not $c.allow_root_removal) {throw 'Root removal is not in the explicit contract.'}
    $pending=New-Object 'Collections.Generic.Stack[string]';$pending.Push($c.install_root)
    while($pending.Count){$dir=$pending.Pop();foreach($entry in Get-ChildItem -LiteralPath $dir -Force -ErrorAction Stop){if($entry.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Cleanup retains redirected tree; no tasks/files removed.'};if($entry.PSIsContainer){$pending.Push($entry.FullName)}}}
}
$last=Observe-Owned $c;Assert-Previous $observed.proof $last.proof
Assert-InactiveObservation $last.proof
foreach($task in $last.task_objects){Unregister-ScheduledTask -InputObject $task -Confirm:$false -ErrorAction Stop}
foreach($task in $last.proof.tasks){if($null -ne (Get-TaskOrAbsent $task.name)){throw 'Task removal remains unconfirmed; root retained.'}}
$removed=$false
if($Operation -eq 'cleanup-remove'){Assert-Contract $c;$marker=Read-Object (Join-Path $c.install_root '.agentmemory-install-owner.json');if($marker.install_nonce -cne $c.install_nonce -or -not(Same-Path $marker.intended_root $c.install_root)){throw 'Owner changed before removal.'};Remove-Item -LiteralPath $c.install_root -Recurse -Force -ErrorAction Stop;if(Has-Path $c.install_root){throw 'Root removal unconfirmed.'};$removed=$true}
$last.proof.operation=$Operation;$last.proof.status='retired';$last.proof['root_removed']=$removed;$last.proof['auth_retained']=(-not $removed);$last.proof['tasks_removed']=@($last.proof.tasks | ForEach-Object {$_.name});$last.proof | ConvertTo-Json -Depth 12
