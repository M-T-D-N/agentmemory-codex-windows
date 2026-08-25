Set-StrictMode -Version Latest

if (-not ('AgentMemory.CodexPackageProbe' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

namespace AgentMemory {
    public sealed class DesktopWindowProbeResult {
        public string State;
        public string WindowStationName;
        public string DesktopName;
        public string ErrorSource;
        public int ErrorCode;
        public int[] VisibleProcessIds;
    }

    public static class CodexPackageProbe {
        private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        private const uint SYNCHRONIZE = 0x00100000;
        private const uint TOKEN_QUERY = 0x0008;
        private const int TokenUser = 1;
        private const int ERROR_ACCESS_DENIED = 5;
        private const int ERROR_INVALID_PARAMETER = 87;
        private const int ERROR_INSUFFICIENT_BUFFER = 122;
        private const int APPMODEL_ERROR_NO_PACKAGE = 15700;
        private const int UOI_NAME = 2;
        private const string ExpectedFamily = "OpenAI.Codex_2p2nqsd0c76g0";

        private delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);

        [StructLayout(LayoutKind.Sequential)]
        private struct SID_AND_ATTRIBUTES {
            public IntPtr Sid;
            public uint Attributes;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct TOKEN_USER {
            public SID_AND_ATTRIBUTES User;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, int processId);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool ProcessIdToSessionId(uint processId, out uint sessionId);

        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentThreadId();

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder path, ref int size);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetPackageFamilyName(IntPtr process, ref uint length, StringBuilder packageFamilyName);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetPackageFullName(IntPtr process, ref uint length, StringBuilder packageFullName);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetPackagePathByFullName(string packageFullName, ref uint pathLength, StringBuilder path);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool OpenProcessToken(IntPtr processHandle, uint desiredAccess, out IntPtr tokenHandle);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool GetTokenInformation(IntPtr tokenHandle, int tokenInformationClass, IntPtr tokenInformation, int tokenInformationLength, out int returnLength);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr GetProcessWindowStation();

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr GetThreadDesktop(uint threadId);

        [DllImport("user32.dll", EntryPoint = "GetUserObjectInformationW", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool GetUserObjectInformation(IntPtr handle, int index, IntPtr information, uint length, out uint needed);

        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr window);

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

        public static DesktopWindowProbeResult ProbeVisibleTopLevelWindows() {
            DesktopWindowProbeResult result = new DesktopWindowProbeResult();
            result.State = "Indeterminate";
            result.ErrorCode = 0;
            result.VisibleProcessIds = new int[0];
            IntPtr windowStation = GetProcessWindowStation();
            if (windowStation == IntPtr.Zero) {
                result.ErrorSource = "GetProcessWindowStation";
                result.ErrorCode = Marshal.GetLastWin32Error();
                return result;
            }
            IntPtr desktop = GetThreadDesktop(GetCurrentThreadId());
            if (desktop == IntPtr.Zero) {
                result.ErrorSource = "GetThreadDesktop";
                result.ErrorCode = Marshal.GetLastWin32Error();
                return result;
            }
            try {
                result.WindowStationName = GetUserObjectName(windowStation);
                result.DesktopName = GetUserObjectName(desktop);
            }
            catch (Win32Exception exception) {
                result.ErrorSource = "GetUserObjectInformation";
                result.ErrorCode = exception.NativeErrorCode;
                return result;
            }
            catch {
                result.ErrorSource = "GetUserObjectInformation";
                return result;
            }
            if (!string.Equals(result.WindowStationName, "WinSta0", StringComparison.OrdinalIgnoreCase) ||
                !string.Equals(result.DesktopName, "Default", StringComparison.OrdinalIgnoreCase)) {
                result.ErrorSource = "UnexpectedDesktopScope";
                return result;
            }

            HashSet<int> processIds = new HashSet<int>();
            bool incomplete = false;
            bool enumerated = EnumWindows(delegate(IntPtr window, IntPtr parameter) {
                try {
                    if (!IsWindowVisible(window)) return true;
                    uint processId;
                    if (GetWindowThreadProcessId(window, out processId) == 0 || processId == 0) incomplete = true;
                    else processIds.Add((int)processId);
                }
                catch { incomplete = true; }
                return true;
            }, IntPtr.Zero);
            if (!enumerated) {
                result.ErrorSource = "EnumWindows";
                result.ErrorCode = Marshal.GetLastWin32Error();
                return result;
            }
            if (incomplete) {
                result.ErrorSource = "GetWindowThreadProcessId";
                result.ErrorCode = Marshal.GetLastWin32Error();
                return result;
            }
            int[] visibleProcessIds = new int[processIds.Count];
            processIds.CopyTo(visibleProcessIds);
            result.State = "Complete";
            result.VisibleProcessIds = visibleProcessIds;
            return result;
        }

        public static string Probe(int processId, string expectedOwnerSid, int expectedSessionId) {
            uint sessionId;
            if (!ProcessIdToSessionId((uint)processId, out sessionId)) {
                int sessionError = Marshal.GetLastWin32Error();
                return sessionError == ERROR_INVALID_PARAMETER ? "Gone" : "Indeterminate";
            }
            if (sessionId != (uint)expectedSessionId) return "NotRelevant";

            IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, false, processId);
            if (process == IntPtr.Zero) {
                int openError = Marshal.GetLastWin32Error();
                if (openError == ERROR_INVALID_PARAMETER) return "Gone";
                return openError == ERROR_ACCESS_DENIED ? "Indeterminate" : "Indeterminate";
            }
            try {
                string imagePath = GetImagePath(process);
                if (imagePath == null) return "Indeterminate";

                string family = GetPackageIdentity(process, true);
                if (family == null) return "Indeterminate";
                if (family == string.Empty || !string.Equals(family, ExpectedFamily, StringComparison.OrdinalIgnoreCase)) return "NotTrusted";

                string fullName = GetPackageIdentity(process, false);
                if (string.IsNullOrEmpty(fullName)) return "Indeterminate";
                string packagePath = GetPackagePath(fullName);
                if (string.IsNullOrEmpty(packagePath)) return "Indeterminate";

                string ownerSid = GetOwnerSid(process);
                if (string.IsNullOrEmpty(ownerSid)) return "Indeterminate";
                if (!string.Equals(ownerSid, expectedOwnerSid, StringComparison.OrdinalIgnoreCase)) return "NotTrusted";

                string expectedImage = System.IO.Path.GetFullPath(System.IO.Path.Combine(packagePath, "app", "ChatGPT.exe"));
                string actualImage = System.IO.Path.GetFullPath(imagePath);
                return string.Equals(actualImage, expectedImage, StringComparison.OrdinalIgnoreCase) ? "Trusted" : "NotTrusted";
            }
            catch {
                return "Indeterminate";
            }
            finally {
                CloseHandle(process);
            }
        }

        private static string GetImagePath(IntPtr process) {
            int size = 32768;
            var value = new StringBuilder(size);
            return QueryFullProcessImageName(process, 0, value, ref size) ? value.ToString() : null;
        }

        private static string GetUserObjectName(IntPtr handle) {
            uint needed = 0;
            GetUserObjectInformation(handle, UOI_NAME, IntPtr.Zero, 0, out needed);
            if (needed == 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "GetUserObjectInformation size query failed");
            IntPtr buffer = Marshal.AllocHGlobal(checked((int)needed));
            try {
                if (!GetUserObjectInformation(handle, UOI_NAME, buffer, needed, out needed)) {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "GetUserObjectInformation failed");
                }
                string value = Marshal.PtrToStringUni(buffer);
                if (string.IsNullOrEmpty(value)) throw new InvalidOperationException("The window object name was empty.");
                return value;
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }

        private static string GetPackageIdentity(IntPtr process, bool family) {
            uint length = 0;
            int first = family
                ? GetPackageFamilyName(process, ref length, null)
                : GetPackageFullName(process, ref length, null);
            if (first == APPMODEL_ERROR_NO_PACKAGE) return string.Empty;
            if (first != ERROR_INSUFFICIENT_BUFFER || length == 0) return null;
            var value = new StringBuilder((int)length);
            int second = family
                ? GetPackageFamilyName(process, ref length, value)
                : GetPackageFullName(process, ref length, value);
            return second == 0 ? value.ToString() : null;
        }

        private static string GetPackagePath(string fullName) {
            uint length = 0;
            int first = GetPackagePathByFullName(fullName, ref length, null);
            if (first != ERROR_INSUFFICIENT_BUFFER || length == 0) return null;
            var value = new StringBuilder((int)length);
            int second = GetPackagePathByFullName(fullName, ref length, value);
            return second == 0 ? value.ToString() : null;
        }

        private static string GetOwnerSid(IntPtr process) {
            IntPtr token;
            if (!OpenProcessToken(process, TOKEN_QUERY, out token)) return null;
            try {
                int required;
                GetTokenInformation(token, TokenUser, IntPtr.Zero, 0, out required);
                if (required <= 0) return null;
                IntPtr buffer = Marshal.AllocHGlobal(required);
                try {
                    if (!GetTokenInformation(token, TokenUser, buffer, required, out required)) return null;
                    TOKEN_USER user = (TOKEN_USER)Marshal.PtrToStructure(buffer, typeof(TOKEN_USER));
                    return new SecurityIdentifier(user.User.Sid).Value;
                }
                finally {
                    Marshal.FreeHGlobal(buffer);
                }
            }
            finally {
                CloseHandle(token);
            }
        }
    }
}
'@
}

function New-CodexDesktopState {
    param(
        [Parameter(Mandatory = $true)][string]$State,
        [Parameter(Mandatory = $true)][string]$ProcessState,
        [Parameter(Mandatory = $true)][string]$ProcessProbeState,
        [Parameter(Mandatory = $true)][string]$WindowProbeState,
        [Parameter(Mandatory = $true)][string]$ClassificationReason,
        [Parameter(Mandatory = $true)][int]$ProbeSessionId,
        [int[]]$TrustedProcessPids = @(),
        [int[]]$VisibleOfficialPids = @(),
        [string]$ProbeWindowStation = $null,
        [string]$ProbeDesktop = $null,
        [string]$WindowProbeErrorSource = $null,
        [int]$WindowProbeErrorCode = 0
    )
    $desktopScope = if ($ProbeWindowStation -and $ProbeDesktop) { "$ProbeWindowStation\$ProbeDesktop" } else { $null }
    return [pscustomobject]@{
        State = $State
        ProcessState = $ProcessState
        ProcessProbeState = $ProcessProbeState
        WindowProbeState = $WindowProbeState
        ClassificationReason = $ClassificationReason
        ProbeSessionId = $ProbeSessionId
        DesktopScope = $desktopScope
        ProbeWindowStation = $ProbeWindowStation
        ProbeDesktop = $ProbeDesktop
        TrustedProcessPids = @($TrustedProcessPids)
        VisibleOfficialPids = @($VisibleOfficialPids)
        Pids = @($VisibleOfficialPids)
        WindowPids = @($VisibleOfficialPids)
        WindowProbeError = $WindowProbeErrorSource
        WindowProbeErrorSource = $WindowProbeErrorSource
        WindowProbeErrorCode = $WindowProbeErrorCode
    }
}

function Get-CodexDesktopState {
    $expectedSessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
    $windowProbe = $null
    $probeWindowStation = $null
    $probeDesktop = $null
    $windowProbeErrorSource = $null
    $windowProbeErrorCode = 0
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        $windowProbe = [AgentMemory.CodexPackageProbe]::ProbeVisibleTopLevelWindows()
        $probeWindowStation = [string]$windowProbe.WindowStationName
        $probeDesktop = [string]$windowProbe.DesktopName
        $windowProbeErrorSource = [string]$windowProbe.ErrorSource
        $windowProbeErrorCode = [int]$windowProbe.ErrorCode
        if ([string]$windowProbe.State -eq 'Complete') { break }
        if ($attempt -lt 3) { Start-Sleep -Milliseconds 50 }
    }
    $windowProbeState = if ($windowProbe -and [string]$windowProbe.State -eq 'Complete') { 'Complete' } else { 'Indeterminate' }
    $scopeArguments = @{
        ProbeWindowStation = $probeWindowStation
        ProbeDesktop = $probeDesktop
        WindowProbeErrorSource = $windowProbeErrorSource
        WindowProbeErrorCode = $windowProbeErrorCode
    }

    $processEnumerationFailed = $false
    try {
        $processes = @([System.Diagnostics.Process]::GetProcessesByName('ChatGPT'))
    }
    catch {
        $processes = @()
        $processEnumerationFailed = $true
    }

    $trustedPids = New-Object System.Collections.Generic.List[int]
    $processIndeterminate = $processEnumerationFailed
    if (-not $processEnumerationFailed) {
        $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
        $expectedOwnerSid = $identity.User.Value
        foreach ($process in $processes) {
            try {
                $result = [AgentMemory.CodexPackageProbe]::Probe([int]$process.Id, $expectedOwnerSid, $expectedSessionId)
                if ($result -eq 'Trusted') {
                    $trustedPids.Add([int]$process.Id)
                }
                elseif ($result -eq 'Indeterminate') {
                    $processIndeterminate = $true
                }
            }
            finally {
                $process.Dispose()
            }
        }
    }
    $processProbeState = if ($processIndeterminate) { 'Indeterminate' } else { 'Complete' }
    $processState = if ($trustedPids.Count -gt 0) { 'Present' } elseif ($processIndeterminate) { 'Unknown' } else { 'Absent' }
    $visibleWindowPids = New-Object 'System.Collections.Generic.HashSet[int]'
    if ($windowProbeState -eq 'Complete') {
        foreach ($windowPid in @($windowProbe.VisibleProcessIds)) { [void]$visibleWindowPids.Add([int]$windowPid) }
    }
    $trustedWindowPids = @()
    if ($windowProbeState -eq 'Complete') {
        $trustedWindowPids = @($trustedPids | Where-Object { $visibleWindowPids.Contains([int]$_) })
    }
    if ($trustedWindowPids.Count -gt 0) {
        return New-CodexDesktopState -State 'Present' -ProcessState 'Present' -ProcessProbeState $processProbeState -WindowProbeState $windowProbeState -ClassificationReason 'visible_official_window_present' -ProbeSessionId $expectedSessionId -TrustedProcessPids @($trustedPids) -VisibleOfficialPids $trustedWindowPids @scopeArguments
    }
    if ($windowProbeState -ne 'Complete') {
        $reason = if ($windowProbeErrorSource -eq 'UnexpectedDesktopScope') { 'unexpected_desktop_scope' } else { 'visible_window_probe_failed' }
        return New-CodexDesktopState -State 'Unknown' -ProcessState $processState -ProcessProbeState $processProbeState -WindowProbeState $windowProbeState -ClassificationReason $reason -ProbeSessionId $expectedSessionId -TrustedProcessPids @($trustedPids) @scopeArguments
    }
    if ($processIndeterminate) {
        $reason = if ($processEnumerationFailed) { 'process_enumeration_failed' } else { 'visible_indeterminate_candidate_possible' }
        return New-CodexDesktopState -State 'Unknown' -ProcessState $processState -ProcessProbeState $processProbeState -WindowProbeState $windowProbeState -ClassificationReason $reason -ProbeSessionId $expectedSessionId -TrustedProcessPids @($trustedPids) @scopeArguments
    }
    $reason = if ($trustedPids.Count -gt 0) { 'official_processes_have_no_visible_windows' } elseif ($processes.Count -eq 0) { 'no_chatgpt_processes' } else { 'no_trusted_official_processes' }
    return New-CodexDesktopState -State 'Absent' -ProcessState $processState -ProcessProbeState $processProbeState -WindowProbeState $windowProbeState -ClassificationReason $reason -ProbeSessionId $expectedSessionId -TrustedProcessPids @($trustedPids) @scopeArguments
}

function Get-AgentMemoryMcpLeaseState {
    param([Parameter(Mandatory = $true)][string]$Root)

    $leaseDirectory = Join-Path ([System.IO.Path]::GetFullPath($Root)) 'data\mcp-leases'
    try {
        if (-not (Test-Path -LiteralPath $leaseDirectory -PathType Container -ErrorAction Stop)) {
            return [pscustomobject]@{ State = 'Absent'; ActiveCount = 0; StaleCount = 0 }
        }
        $leaseFiles = @(Get-ChildItem -LiteralPath $leaseDirectory -Filter 'mcp-*.lease' -File -ErrorAction Stop)
    }
    catch {
        return [pscustomobject]@{ State = 'Unknown'; ActiveCount = 0; StaleCount = 0 }
    }

    $activeCount = 0
    $staleCount = 0
    $indeterminate = $false
    foreach ($lease in $leaseFiles) {
        $probe = $null
        try {
            $probe = [System.IO.File]::Open($lease.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
            $staleCount++
        }
        catch [System.IO.IOException] {
            $activeCount++
        }
        catch [System.UnauthorizedAccessException] {
            $indeterminate = $true
        }
        finally {
            if ($probe) { $probe.Dispose() }
        }
    }
    if ($activeCount -gt 0) {
        return [pscustomobject]@{ State = 'Present'; ActiveCount = $activeCount; StaleCount = $staleCount }
    }
    if ($indeterminate) {
        return [pscustomobject]@{ State = 'Unknown'; ActiveCount = 0; StaleCount = $staleCount }
    }
    return [pscustomobject]@{ State = 'Absent'; ActiveCount = 0; StaleCount = $staleCount }
}

function Get-AgentMemoryConsumerState {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [AllowNull()][object]$LeaseState = $null
    )

    $desktop = Get-CodexDesktopState
    $leases = if ($null -ne $LeaseState) { $LeaseState } else { Get-AgentMemoryMcpLeaseState -Root $Root }
    return [pscustomobject]@{
        # The Windows Codex desktop package is the lifecycle authority. MCP leases are
        # diagnostic/race evidence only and never keep AgentMemory alive after app exit.
        State = [string]$desktop.State
        DesktopState = [string]$desktop.State
        DesktopProcessState = [string]$desktop.ProcessState
        DesktopProcessProbeState = [string]$desktop.ProcessProbeState
        DesktopWindowProbeState = [string]$desktop.WindowProbeState
        DesktopClassificationReason = [string]$desktop.ClassificationReason
        DesktopProbeSessionId = [int]$desktop.ProbeSessionId
        DesktopScope = [string]$desktop.DesktopScope
        DesktopProbeWindowStation = [string]$desktop.ProbeWindowStation
        DesktopProbeDesktop = [string]$desktop.ProbeDesktop
        DesktopPids = @($desktop.Pids)
        DesktopProcessPids = @($desktop.TrustedProcessPids)
        DesktopWindowPids = @($desktop.WindowPids)
        DesktopWindowProbeError = [string]$desktop.WindowProbeError
        DesktopWindowProbeErrorSource = [string]$desktop.WindowProbeErrorSource
        DesktopWindowProbeErrorCode = [int]$desktop.WindowProbeErrorCode
        LeaseState = [string]$leases.State
        ActiveLeaseCount = [int]$leases.ActiveCount
        StaleLeaseCount = [int]$leases.StaleCount
    }
}

