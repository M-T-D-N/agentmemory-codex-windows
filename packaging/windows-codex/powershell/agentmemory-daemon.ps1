param(
    [string]$Root = '',
    [string]$NodePath = '',
    [int]$LauncherPid = 0,
    [ValidateRange(2, 60)][int]$CodexExitGraceSeconds = 5,
    [ValidateRange(1, 30)][int]$ConsumerProbeSeconds = 5,
    [ValidateRange(10, 300)][int]$LeaseDiagnosticSeconds = 30
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

. (Join-Path $PSScriptRoot 'agentmemory-layout.ps1')
$layout = Resolve-AgentMemoryLayout -Root $Root -NodePath $NodePath
$resolvedRoot = $layout.Root
$NodePath = $layout.NodePath
$envScript = Join-Path $resolvedRoot 'scripts\agentmemory-env.ps1'
$lifecycleScript = Join-Path $resolvedRoot 'scripts\agentmemory-lifecycle.ps1'
$enginePath = Join-Path $resolvedRoot 'bin\iii.exe'
$engineConfig = Join-Path $resolvedRoot 'config\iii-config.yaml'
$installManifestPath = Join-Path $resolvedRoot 'config\install-manifest.json'
$workerWrapper = Join-Path $resolvedRoot 'bin\agentmemory-worker.mjs'
$workerCli = Join-Path $layout.PackageRoot 'dist\cli.mjs'
$statePath = Join-Path $resolvedRoot 'data\runtime-state.json'
$stopPath = Join-Path $resolvedRoot 'data\stop-request.json'
$startupLockPath = Join-Path $resolvedRoot 'data\startup.lock'
$logsPath = Join-Path $resolvedRoot 'logs'
$reservedPorts = @(3111, 3112, 3113, 3114, 49134)

foreach ($requiredFile in @($envScript, $lifecycleScript, $enginePath, $engineConfig, $installManifestPath, $NodePath, $workerWrapper, $workerCli)) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw "Required AgentMemory file is missing: $requiredFile"
    }
}
foreach ($directory in @((Join-Path $resolvedRoot 'data'), (Join-Path $resolvedRoot 'home'), $logsPath)) {
    [void](New-Item -ItemType Directory -Path $directory -Force)
}

. $envScript -Root $resolvedRoot
. $lifecycleScript

if (-not ('AgentMemory.NativeProcessIdentity' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace AgentMemory {
    public static class NativeProcessIdentity {
        [StructLayout(LayoutKind.Sequential)]
        private struct ProcessBasicInformation {
            public IntPtr Reserved1;
            public IntPtr PebBaseAddress;
            public IntPtr Reserved2_0;
            public IntPtr Reserved2_1;
            public IntPtr UniqueProcessId;
            public IntPtr InheritedFromUniqueProcessId;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct UnicodeString {
            public UInt16 Length;
            public UInt16 MaximumLength;
            public IntPtr Buffer;
        }

        [DllImport("ntdll.dll")]
        private static extern int NtQueryInformationProcess(
            IntPtr processHandle,
            int processInformationClass,
            IntPtr processInformation,
            int processInformationLength,
            out int returnLength);

        public static int GetParentProcessId(IntPtr processHandle) {
            int size = Marshal.SizeOf(typeof(ProcessBasicInformation));
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try {
                int returned;
                int status = NtQueryInformationProcess(processHandle, 0, buffer, size, out returned);
                if (status != 0) throw new Win32Exception(status, "NtQueryInformationProcess(ProcessBasicInformation) failed");
                ProcessBasicInformation info = (ProcessBasicInformation)Marshal.PtrToStructure(buffer, typeof(ProcessBasicInformation));
                return info.InheritedFromUniqueProcessId.ToInt32();
            }
            finally {
                Marshal.FreeHGlobal(buffer);
            }
        }

        public static string GetCommandLine(IntPtr processHandle) {
            int required;
            NtQueryInformationProcess(processHandle, 60, IntPtr.Zero, 0, out required);
            if (required <= 0) throw new InvalidOperationException("Could not determine the process command-line buffer size.");
            IntPtr buffer = Marshal.AllocHGlobal(required);
            try {
                int returned;
                int status = NtQueryInformationProcess(processHandle, 60, buffer, required, out returned);
                if (status != 0) throw new Win32Exception(status, "NtQueryInformationProcess(ProcessCommandLineInformation) failed");
                UnicodeString value = (UnicodeString)Marshal.PtrToStructure(buffer, typeof(UnicodeString));
                return Marshal.PtrToStringUni(value.Buffer, value.Length / 2);
            }
            finally {
                Marshal.FreeHGlobal(buffer);
            }
        }
    }

    public sealed class NoWindowProcess : IDisposable {
        private readonly StreamWriter output;
        private readonly StreamWriter error;
        private readonly object outputLock = new object();
        private readonly object errorLock = new object();
        private bool disposed;

        public Process Process { get; private set; }

        private NoWindowProcess(Process process, StreamWriter output, StreamWriter error) {
            this.Process = process;
            this.output = output;
            this.error = error;
        }

        public static NoWindowProcess Start(string filePath, string[] arguments, string workingDirectory, string outputPath, string errorPath) {
            var output = new StreamWriter(new FileStream(outputPath, FileMode.CreateNew, FileAccess.Write, FileShare.Read), new UTF8Encoding(false));
            var error = new StreamWriter(new FileStream(errorPath, FileMode.CreateNew, FileAccess.Write, FileShare.Read), new UTF8Encoding(false));
            output.AutoFlush = true;
            error.AutoFlush = true;
            Process process = null;
            try {
                var start = new ProcessStartInfo {
                    FileName = filePath,
                    Arguments = BuildArguments(arguments),
                    WorkingDirectory = workingDirectory,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden,
                    ErrorDialog = false,
                    RedirectStandardInput = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                };
                process = new Process { StartInfo = start, EnableRaisingEvents = true };
                var launched = new NoWindowProcess(process, output, error);
                process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs eventArgs) {
                    if (eventArgs.Data == null) return;
                    lock (launched.outputLock) launched.output.WriteLine(eventArgs.Data);
                };
                process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs eventArgs) {
                    if (eventArgs.Data == null) return;
                    lock (launched.errorLock) launched.error.WriteLine(eventArgs.Data);
                };
                if (!process.Start()) throw new InvalidOperationException("The no-window child process did not start.");
                process.StandardInput.Close();
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                return launched;
            }
            catch {
                if (process != null) process.Dispose();
                output.Dispose();
                error.Dispose();
                throw;
            }
        }

        private static string BuildArguments(string[] arguments) {
            var commandLine = new StringBuilder();
            foreach (string argument in arguments) {
                if (commandLine.Length > 0) commandLine.Append(' ');
                commandLine.Append(Quote(argument));
            }
            return commandLine.ToString();
        }

        private static string Quote(string value) {
            if (value == null) throw new ArgumentNullException("value");
            if (value.IndexOf('\0') >= 0) throw new InvalidOperationException("A process argument contains NUL.");
            if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return value;
            var result = new StringBuilder("\"");
            int backslashes = 0;
            foreach (char character in value) {
                if (character == '\\') backslashes++;
                else if (character == '"') {
                    result.Append('\\', backslashes * 2 + 1).Append('"');
                    backslashes = 0;
                }
                else {
                    result.Append('\\', backslashes).Append(character);
                    backslashes = 0;
                }
            }
            result.Append('\\', backslashes * 2).Append('"');
            return result.ToString();
        }

        public void Dispose() {
            if (disposed) return;
            disposed = true;
            if (Process.HasExited) Process.WaitForExit();
            lock (outputLock) output.Dispose();
            lock (errorLock) error.Dispose();
        }
    }
}
'@
}

$daemonProcess = Get-Process -Id $PID -ErrorAction Stop
$actualLauncherPid = [AgentMemory.NativeProcessIdentity]::GetParentProcessId($daemonProcess.Handle)
$hiddenLauncherPath = Join-Path $resolvedRoot 'bin\agentmemory-hidden-launcher.exe'
if ($LauncherPid -le 0 -or $actualLauncherPid -ne $LauncherPid) {
    throw "AgentMemory daemon launcher parent mismatch: expected $LauncherPid, got $actualLauncherPid"
}
$hiddenLauncher = Get-Process -Id $LauncherPid -ErrorAction Stop
$hiddenLauncherCommandLine = [AgentMemory.NativeProcessIdentity]::GetCommandLine($hiddenLauncher.Handle)
if (
    [System.IO.Path]::GetFullPath([string]$hiddenLauncher.Path) -ne $hiddenLauncherPath -or
    $hiddenLauncherCommandLine -notmatch '(?i)\s+task\s*$'
) {
    throw 'AgentMemory daemon must be contained by the owned hidden task launcher.'
}
$installManifest = Get-Content -Raw -LiteralPath $installManifestPath | ConvertFrom-Json
$expectedHiddenLauncherHash = [string]$installManifest.source_hashes.'bin\agentmemory-hidden-launcher.exe'
if (
    $expectedHiddenLauncherHash -notmatch '^[A-Fa-f0-9]{64}$' -or
    (Get-FileHash -Algorithm SHA256 -LiteralPath $hiddenLauncherPath).Hash -ne $expectedHiddenLauncherHash.ToUpperInvariant()
) {
    throw 'AgentMemory hidden launcher hash does not match the protected install manifest.'
}

function Get-ReservedConnections {
    $netstatPath = Join-Path $env:SystemRoot 'System32\netstat.exe'
    $connections = foreach ($line in @(& $netstatPath -ano -p TCP)) {
        if ($line -match '^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$') {
            $port = [int]$Matches[2]
            if ($port -in $reservedPorts) {
                [pscustomobject]@{
                    LocalAddress = [string]$Matches[1]
                    LocalPort = $port
                    OwningProcess = [int]$Matches[3]
                }
            }
        }
    }
    return @($connections)
}

function Test-IPv4LoopbackAddress {
    param([Parameter(Mandatory = $true)][string]$Address)
    $parsed = $null
    if (-not [System.Net.IPAddress]::TryParse($Address, [ref]$parsed)) { return $false }
    if ($parsed.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { return $false }
    return $parsed.GetAddressBytes()[0] -eq 127
}

function Assert-LoopbackOnly {
    $unsafe = @(Get-ReservedConnections | Where-Object { -not (Test-IPv4LoopbackAddress -Address $_.LocalAddress) })
    if ($unsafe.Count -gt 0) {
        throw "A reserved AgentMemory port is exposed beyond IPv4 loopback: $($unsafe.LocalPort -join ', ')"
    }
}

function Test-AgentMemoryHealth {
    try {
        $headers = @{ Authorization = "Bearer $($env:AGENTMEMORY_SECRET)" }
        $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3111/agentmemory/health' -Headers $headers -TimeoutSec 2
        return $response.StatusCode -eq 200
    }
    catch {
        return $false
    }
}

function Wait-Condition {
    param(
        [Parameter(Mandatory = $true)][scriptblock]$Condition,
        [Parameter(Mandatory = $true)][int]$TimeoutSeconds,
        [Parameter(Mandatory = $true)][string]$FailureMessage
    )
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        if (& $Condition) {
            return
        }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    throw $FailureMessage
}

function Get-StopToken {
    param(
        [Parameter(Mandatory = $true)][string]$RunId,
        [Parameter(Mandatory = $true)][int]$DaemonPid
    )
    $keyBytes = [System.Text.Encoding]::UTF8.GetBytes($env:AGENTMEMORY_SECRET)
    $messageBytes = [System.Text.Encoding]::UTF8.GetBytes("Codex.AgentMemory.Stop.v1|$DaemonPid|$RunId")
    $hmac = New-Object System.Security.Cryptography.HMACSHA256(,$keyBytes)
    try {
        return [Convert]::ToBase64String($hmac.ComputeHash($messageBytes))
    }
    finally {
        $hmac.Dispose()
        [System.Array]::Clear($keyBytes, 0, $keyBytes.Length)
        [System.Array]::Clear($messageBytes, 0, $messageBytes.Length)
    }
}

function Test-StopRequest {
    param(
        [Parameter(Mandatory = $true)][int]$WorkerPid,
        [Parameter(Mandatory = $true)][string]$ExpectedToken
    )
    if (-not [System.IO.File]::Exists($stopPath)) {
        return $false
    }
    try {
        $request = Get-Content -Raw -LiteralPath $stopPath | ConvertFrom-Json
        return (
            [int]$request.worker_pid -eq $WorkerPid -and
            [string]$request.token -eq $ExpectedToken
        )
    }
    catch {
        return $false
    }
}

function Start-OwnedProcess {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$StandardOutputPath,
        [Parameter(Mandatory = $true)][string]$StandardErrorPath
    )
    $expectedPath = [System.IO.Path]::GetFullPath($FilePath)
    $launch = [AgentMemory.NoWindowProcess]::Start($expectedPath, $Arguments, $resolvedRoot, $StandardOutputPath, $StandardErrorPath)
    $process = $launch.Process
    $identity = $null
    try {
        $actualPath = $null
        $startTime = $null
        $identityDeadline = [DateTime]::UtcNow.AddSeconds(2)
        do {
            $process.Refresh()
            if ($process.HasExited) {
                throw "Started process exited before identity capture (PID $($process.Id), code $($process.ExitCode)): $expectedPath"
            }
            try {
                [void]$process.Handle
                $candidatePath = [string]$process.Path
                if (-not [string]::IsNullOrWhiteSpace($candidatePath)) {
                    $actualPath = [System.IO.Path]::GetFullPath($candidatePath)
                    $startTime = $process.StartTime
                    break
                }
            }
            catch {
                if ($process.HasExited) {
                    throw "Started process exited during identity capture (PID $($process.Id), code $($process.ExitCode)): $expectedPath"
                }
            }
            Start-Sleep -Milliseconds 50
        } while ([DateTime]::UtcNow -lt $identityDeadline)
        if (-not $actualPath -or -not $startTime) {
            throw "Could not capture the started process identity: $expectedPath"
        }
        if ($actualPath -ne $expectedPath) {
            throw "Started process executable mismatch: $actualPath"
        }
        $actualParentPid = [AgentMemory.NativeProcessIdentity]::GetParentProcessId($process.Handle)
        if ($actualParentPid -ne $PID) {
            throw "Started process parent mismatch: expected $PID, got $actualParentPid"
        }
        $actualCommandLine = [AgentMemory.NativeProcessIdentity]::GetCommandLine($process.Handle)
        if ([string]::IsNullOrWhiteSpace($actualCommandLine)) {
            throw 'Started process command line is empty.'
        }
        foreach ($argument in $Arguments) {
            if ($actualCommandLine.IndexOf([string]$argument, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
                throw "Started process command line is missing an expected argument: $argument"
            }
        }
        $identity = [ordered]@{
            pid = $process.Id
            parent_pid = $actualParentPid
            executable_path = $actualPath
            arguments = @($Arguments)
            command_line = $actualCommandLine
            expected_command_line = ((@('"' + $expectedPath + '"') + $Arguments) -join ' ')
            creation_date = $startTime.ToUniversalTime().ToString('o')
            handle = $process.Handle.ToInt64()
        }
        return [pscustomobject]@{ Process = $process; Identity = $identity; Launch = $launch }
    }
    catch {
        $captureError = $_
        if ($identity -and (Test-OwnedProcess -Process $process -Identity $identity)) {
            $process.Kill()
            [void]$process.WaitForExit(5000)
        }
        elseif (-not $process.HasExited) {
            Write-Warning "A started process did not reach a complete owned identity and was not terminated (PID $($process.Id))."
        }
        if ($process.HasExited) {
            $launch.Dispose()
            $process.Dispose()
        }
        throw $captureError
    }
}

function Test-OwnedProcess {
    param(
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
        [Parameter(Mandatory = $true)]$Identity
    )
    try {
        $Process.Refresh()
        if ($Process.HasExited) {
            return $false
        }
        $expectedIdentityCommandLine = ((@('"' + [string]$Identity.executable_path + '"') + @($Identity.arguments)) -join ' ')
        return (
            $Process.Id -eq [int]$Identity.pid -and
            $Process.Handle.ToInt64() -eq [long]$Identity.handle -and
            [System.IO.Path]::GetFullPath([string]$Process.Path) -eq [string]$Identity.executable_path -and
            $Process.StartTime.ToUniversalTime().ToString('o') -eq [string]$Identity.creation_date -and
            [int]$Identity.parent_pid -eq $PID -and
            [AgentMemory.NativeProcessIdentity]::GetParentProcessId($Process.Handle) -eq [int]$Identity.parent_pid -and
            [AgentMemory.NativeProcessIdentity]::GetCommandLine($Process.Handle) -eq [string]$Identity.command_line -and
            [string]$Identity.expected_command_line -eq $expectedIdentityCommandLine
        )
    }
    catch {
        return $false
    }
}

function Stop-OwnedProcess {
    param(
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
        [Parameter(Mandatory = $true)]$Identity,
        [string]$GracefulStopPath,
        [string]$GracefulStopToken
    )
    if (-not (Test-OwnedProcess -Process $Process -Identity $Identity)) {
        return
    }
    if ($GracefulStopPath -and $GracefulStopToken) {
        $requestTemporaryPath = "$GracefulStopPath.$PID.tmp"
        $requestJson = [ordered]@{
            schema_version = 1
            token = $GracefulStopToken
            worker_pid = [int]$Identity.pid
            requested_at_utc = [DateTime]::UtcNow.ToString('o')
        } | ConvertTo-Json
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($requestTemporaryPath, $requestJson, $utf8NoBom)
        Move-Item -LiteralPath $requestTemporaryPath -Destination $GracefulStopPath -Force
        if ($Process.WaitForExit(10000)) {
            return
        }
    }
    else {
        [void]$Process.CloseMainWindow()
        if ($Process.WaitForExit(2000)) {
            return
        }
    }
    if (Test-OwnedProcess -Process $Process -Identity $Identity) {
        $Process.Kill()
        [void]$Process.WaitForExit(5000)
    }
}

function Test-EngineReady {
    param([int]$EnginePid)
    try {
        Assert-LoopbackOnly
        $connections = Get-ReservedConnections
        foreach ($port in @(3111, 3112, 49134)) {
            if (-not @($connections | Where-Object { $_.LocalPort -eq $port -and $_.OwningProcess -eq $EnginePid })) {
                return $false
            }
        }
        return $true
    }
    catch {
        return $false
    }
}

function Test-ServiceReady {
    param([int]$EnginePid, [int]$WorkerPid)
    try {
        if (-not (Test-AgentMemoryHealth)) {
            return $false
        }
        if (-not (Test-AgentMemoryMcpHttp -VerifyFailClosed)) {
            return $false
        }
        Assert-LoopbackOnly
        $connections = Get-ReservedConnections
        foreach ($port in @(3111, 3112, 49134)) {
            if (-not @($connections | Where-Object { $_.LocalPort -eq $port -and $_.OwningProcess -eq $EnginePid })) {
                return $false
            }
        }
        $viewerConnections = @($connections | Where-Object { $_.LocalPort -eq 3113 })
        if ($viewerConnections.Count -gt 0 -and @($viewerConnections | Where-Object { $_.OwningProcess -ne $WorkerPid }).Count -gt 0) {
            return $false
        }
        if (-not @($connections | Where-Object { $_.LocalPort -eq 3114 -and $_.OwningProcess -eq $WorkerPid })) {
            return $false
        }
        return $true
    }
    catch {
        return $false
    }
}

function Test-RuntimeResponsive {
    try {
        foreach ($path in @('http://127.0.0.1:3111/agentmemory/livez', 'http://127.0.0.1:3114/.well-known/oauth-protected-resource')) {
            $request = [System.Net.HttpWebRequest]::Create($path)
            $request.Proxy = $null
            $request.Timeout = 3000
            $request.ReadWriteTimeout = 3000
            $response = $null
            $reader = $null
            try {
                $response = $request.GetResponse()
                $reader = [System.IO.StreamReader]::new($response.GetResponseStream())
                $body = $reader.ReadToEnd() | ConvertFrom-Json
                if ($path.EndsWith('/livez')) {
                    if ($body.status -cne 'ok' -or $body.service -cne 'agentmemory') { return $false }
                }
                elseif ($body.resource -cne 'http://127.0.0.1:3114/mcp') { return $false }
            }
            finally {
                if ($reader) { $reader.Dispose() }
                if ($response) { $response.Dispose() }
            }
        }
        return $true
    }
    catch { return $false }
}

function Get-StallProcessSample {
    param([Diagnostics.Process]$Process, $Identity)
    if (-not (Test-OwnedProcess -Process $Process -Identity $Identity)) { return @{ available=$false; reason='identity_mismatch' } }
    try {
        $Process.Refresh()
        $threads = @($Process.Threads | Sort-Object Id | Select-Object -First 32 | ForEach-Object {
            $reason = 'not_waiting'
            try { if ($_.ThreadState -eq [Diagnostics.ThreadState]::Wait) { $reason = [string]$_.WaitReason } } catch { $reason='unavailable' }
            @{ tid=$_.Id; state=[string]$_.ThreadState; wait_reason=$reason }
        })
        return @{ available=$true; pid=$Process.Id; created_at_utc=$Process.StartTime.ToUniversalTime().ToString('o');
            cpu_ms=$Process.TotalProcessorTime.TotalMilliseconds; working_set_bytes=$Process.WorkingSet64;
            private_bytes=$Process.PrivateMemorySize64; thread_count=$Process.Threads.Count; threads=$threads }
    } catch { return @{ available=$false; reason='sample_failed' } }
}

function Save-RuntimeStallEvidence {
    param([string]$LogsPath, [string]$RunId, [Diagnostics.Process]$Worker, $WorkerIdentity,
        [Diagnostics.Process]$Engine, $EngineIdentity)
    try {
        if ($RunId -notmatch '^\d{8}T\d{9}Z$') { return }
        $snapshot = $null; $snapshotStatus = 'unavailable'
        $path = Join-Path $LogsPath "worker-diagnostics-$RunId.json"
        try {
        if ((Test-Path -LiteralPath $path -PathType Leaf) -and (Get-Item -LiteralPath $path).Length -le 131072) {
            $raw = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
            if ($raw.schema -eq 1 -and $raw.runId -ceq $RunId -and $raw.pid -eq $WorkerIdentity.pid) {
                $cleanEntries = {
                    param($entries, [switch]$Recent)
                    @($entries | Select-Object -First $(if($Recent){64}else{128}) | ForEach-Object {
                        if ($_.name -match '^(?:other|(?:mem|api)::[a-zA-Z0-9:_-]{1,90}|mcp::(?:tools::(?:list|call)|resources::(?:list|read)|prompts::(?:list|get))|state::(?:get|set|update|delete|list|list_groups))$' -and $_.kind -in @('function','state')) {
                            $entry=@{id=[long]$_.id;parent=$(if($null -ne $_.parent){[long]$_.parent}else{$null});kind=[string]$_.kind;name=[string]$_.name;started_at_ms=[long]$_.startedAt}
                            if ($Recent) { $entry.duration_ms=[long]$_.durationMs; $entry.outcome=if($_.outcome -eq 'ok'){'ok'}else{'error'} }
                            else { $entry.age_ms=[long]$_.ageMs }
                            $entry
                        }
                    })
                }
                $snapshot=@{snapshot_age_ms=([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()-[long]$raw.observedAt);observed_at_ms=[long]$raw.observedAt;heartbeat_at_ms=$(if($null -ne $raw.heartbeatAt){[long]$raw.heartbeatAt}else{$null});heartbeat_age_ms=$(if($null -ne $raw.heartbeatAgeMs){[long]$raw.heartbeatAgeMs}else{$null});
                    dropped_events=[long]$raw.droppedEvents;dropped_active=[long]$raw.droppedActive;
                    active=@(& $cleanEntries $raw.active);recent=@(& $cleanEntries $raw.recent -Recent)}
                if ($raw.memory) { $snapshot.memory=@{rss=[long]$raw.memory.rss;heap_used=[long]$raw.memory.heapUsed;heap_total=[long]$raw.memory.heapTotal;external=[long]$raw.memory.external} }
                $snapshotStatus='available'
            } else { $snapshotStatus='identity_mismatch' }
        }
        } catch { $snapshot=$null; $snapshotStatus='invalid' }
        $evidence=@{schema_version=1;run_id=$RunId;reason='runtime_unresponsive';captured_at_utc=[DateTime]::UtcNow.ToString('o');
            snapshot_status=$snapshotStatus;snapshot=$snapshot;
            worker=(Get-StallProcessSample $Worker $WorkerIdentity);engine=(Get-StallProcessSample $Engine $EngineIdentity)}
        $destination=Join-Path $LogsPath "stall-$RunId.json"
        $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($evidence | ConvertTo-Json -Depth 8))
        $stream=[IO.File]::Open($destination,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
        try { $stream.Write($bytes,0,$bytes.Length) } finally { $stream.Dispose() }
    } catch { Write-Warning 'Runtime stall evidence was unavailable; owned recovery will continue.' }
}


function Test-RuntimeRecoveryDue {
    param(
        [Parameter(Mandatory = $true)][hashtable]$State,
        [Parameter(Mandatory = $true)][DateTime]$Now,
        [scriptblock]$Probe = { Test-RuntimeResponsive }
    )
    if (($Now - $State.LastProbeUtc).TotalSeconds -lt 30) { return $false }
    $State.LastProbeUtc = $Now
    $responsive = $false
    try { $responsive = [bool](& $Probe) } catch { $responsive = $false }
    if ($responsive) { $State.ConsecutiveFailures = 0 }
    else { $State.ConsecutiveFailures++ }
    return $State.ConsecutiveFailures -ge 3
}

function Write-RuntimeState {
    param(
        [Parameter(Mandatory = $true)][string]$Status,
        $EngineIdentity,
        $WorkerIdentity,
        [string]$ErrorMessage,
        [string]$TerminalReason
    )
    $daemonProcess = Get-Process -Id $PID -ErrorAction Stop
    $state = [ordered]@{
        schema_version = 1
        run_id = $runId
        status = $Status
        lifecycle_mode = 'windows_codex_desktop_window'
        terminal_reason = $TerminalReason
        root = $resolvedRoot
        updated_at_utc = [DateTime]::UtcNow.ToString('o')
        daemon = [ordered]@{
            pid = $PID
            parent_pid = $LauncherPid
            executable_path = $daemonProcess.Path
            script_path = $PSCommandPath
            creation_date = $daemonProcess.StartTime.ToUniversalTime().ToString('o')
        }
        engine = $EngineIdentity
        worker = $WorkerIdentity
        error_message = $ErrorMessage
    }
    $temporaryPath = "$statePath.$PID.tmp"
    $state | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath $temporaryPath -Encoding UTF8
    Move-Item -LiteralPath $temporaryPath -Destination $statePath -Force
}

function Get-SafeConsumerState {
    param([AllowNull()][object]$LeaseState = $null)
    try {
        return Get-AgentMemoryConsumerState -Root $resolvedRoot -LeaseState $LeaseState
    }
    catch {
        return [pscustomobject]@{
            State = 'Unknown'
            DesktopState = 'Unknown'
            DesktopClassificationReason = 'daemon_probe_exception'
        }
    }
}

function Get-SafeLeaseState {
    try {
        return Get-AgentMemoryMcpLeaseState -Root $resolvedRoot
    }
    catch {
        return [pscustomobject]@{
            State = 'Unknown'
            ActiveCount = 0
            StaleCount = 0
        }
    }
}

$runId = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
$engineOut = Join-Path $logsPath "engine-$runId.stdout.log"
$engineErr = Join-Path $logsPath "engine-$runId.stderr.log"
$workerOut = Join-Path $logsPath "worker-$runId.stdout.log"
$workerErr = Join-Path $logsPath "worker-$runId.stderr.log"
$engine = $null
$worker = $null
$engineLaunch = $null
$workerLaunch = $null
$engineIdentity = $null
$workerIdentity = $null
$terminalStatus = 'inactive'
$terminalError = $null
$terminalReason = $null
$explicitStopRequested = $false
$stopToken = Get-StopToken -RunId $runId -DaemonPid $PID

if (Test-Path -LiteralPath $stopPath -PathType Leaf) {
    Remove-Item -Force -LiteralPath $stopPath
}

$initialConsumerState = Get-SafeConsumerState
if ($initialConsumerState.State -ne 'Present') {
    $withheldReason = if ($initialConsumerState.State -eq 'Unknown') {
        'codex_desktop_window_indeterminate_before_start'
    } else {
        'codex_desktop_window_absent_before_start'
    }
    Write-RuntimeState -Status 'inactive' -EngineIdentity $null -WorkerIdentity $null -ErrorMessage $null -TerminalReason $withheldReason
    exit 0
}

try {
    $occupiedPorts = @(Get-ReservedConnections)
    if ($occupiedPorts.Count -gt 0) {
        throw "Reserved AgentMemory ports are already in use: $($occupiedPorts.LocalPort -join ', ')"
    }

    $engineStart = Start-OwnedProcess -FilePath $enginePath -Arguments @('--config', $engineConfig, '--no-update-check') -StandardOutputPath $engineOut -StandardErrorPath $engineErr
    $engine = $engineStart.Process
    $engineLaunch = $engineStart.Launch
    $engineIdentity = $engineStart.Identity
    Wait-Condition -Condition { -not $engine.HasExited -and (Test-EngineReady -EnginePid $engine.Id) } -TimeoutSeconds 20 -FailureMessage 'The iii engine did not become loopback-ready.'

    $previousDiagnosticsFile = [Environment]::GetEnvironmentVariable('AGENTMEMORY_DIAGNOSTICS_FILE', 'Process')
    $previousDiagnosticsRun = [Environment]::GetEnvironmentVariable('AGENTMEMORY_DIAGNOSTICS_RUN_ID', 'Process')
    $previousStopFile = [Environment]::GetEnvironmentVariable('AGENTMEMORY_STOP_FILE', 'Process')
    $previousStopToken = [Environment]::GetEnvironmentVariable('AGENTMEMORY_STOP_TOKEN', 'Process')
    try {
        [Environment]::SetEnvironmentVariable('AGENTMEMORY_DIAGNOSTICS_FILE', (Join-Path $logsPath "worker-diagnostics-$runId.json"), 'Process')
        [Environment]::SetEnvironmentVariable('AGENTMEMORY_DIAGNOSTICS_RUN_ID', $runId, 'Process')
        [Environment]::SetEnvironmentVariable('AGENTMEMORY_STOP_FILE', $stopPath, 'Process')
        [Environment]::SetEnvironmentVariable('AGENTMEMORY_STOP_TOKEN', $stopToken, 'Process')
        $workerStart = Start-OwnedProcess -FilePath $NodePath -Arguments @($workerWrapper, '--no-engine', '--tools', 'all', '--port', '3111') -StandardOutputPath $workerOut -StandardErrorPath $workerErr
    }
    finally {
        [Environment]::SetEnvironmentVariable('AGENTMEMORY_DIAGNOSTICS_FILE', $previousDiagnosticsFile, 'Process')
        [Environment]::SetEnvironmentVariable('AGENTMEMORY_DIAGNOSTICS_RUN_ID', $previousDiagnosticsRun, 'Process')
        [Environment]::SetEnvironmentVariable('AGENTMEMORY_STOP_FILE', $previousStopFile, 'Process')
        [Environment]::SetEnvironmentVariable('AGENTMEMORY_STOP_TOKEN', $previousStopToken, 'Process')
    }
    $worker = $workerStart.Process
    $workerLaunch = $workerStart.Launch
    $workerIdentity = $workerStart.Identity
    Wait-Condition -Condition { -not $worker.HasExited -and (Test-ServiceReady -EnginePid $engine.Id -WorkerPid $worker.Id) } -TimeoutSeconds 30 -FailureMessage 'AgentMemory did not become authenticated and loopback-ready.'
    Write-RuntimeState -Status 'active' -EngineIdentity $engineIdentity -WorkerIdentity $workerIdentity

    $consumerAbsentSince = $null
    $lastConsumerProbe = [DateTime]::MinValue
    $lastLeaseDiagnostic = [DateTime]::MinValue
    $cachedLeaseState = $null
    $runtimeHealth = @{ LastProbeUtc = [DateTime]::UtcNow; ConsecutiveFailures = 0 }
    while (-not $worker.WaitForExit(250)) {
        if (Test-StopRequest -WorkerPid $worker.Id -ExpectedToken $stopToken) {
            $explicitStopRequested = $true
            $terminalReason = 'authenticated_external_stop'
            Stop-OwnedProcess -Process $worker -Identity $workerIdentity -GracefulStopPath $stopPath -GracefulStopToken $stopToken
            if (-not $worker.HasExited) { throw 'The owned worker did not stop after an authenticated request.' }
            break
        }
        if (Test-RuntimeRecoveryDue -State $runtimeHealth -Now ([DateTime]::UtcNow)) {
            Save-RuntimeStallEvidence -LogsPath $logsPath -RunId $runId -Worker $worker -WorkerIdentity $workerIdentity -Engine $engine -EngineIdentity $engineIdentity
            $terminalReason = 'runtime_unresponsive'
            throw 'AgentMemory failed three consecutive runtime responsiveness checks at 30-second intervals.'
        }
        $consumerProbeNow = [DateTime]::UtcNow
        if (($consumerProbeNow - $lastConsumerProbe).TotalSeconds -ge $ConsumerProbeSeconds) {
            $lastConsumerProbe = $consumerProbeNow
            if ($null -eq $cachedLeaseState -or ($consumerProbeNow - $lastLeaseDiagnostic).TotalSeconds -ge $LeaseDiagnosticSeconds) {
                $cachedLeaseState = Get-SafeLeaseState
                $lastLeaseDiagnostic = [DateTime]::UtcNow
            }
            $consumerState = Get-SafeConsumerState -LeaseState $cachedLeaseState
            if ($consumerState.State -in @('Present', 'Unknown')) {
                # Unknown is fail-open: never stop when the official app/window state cannot be classified.
                $consumerAbsentSince = $null
            }
            elseif (-not $consumerAbsentSince) {
                $consumerAbsentSince = $consumerProbeNow
            }
            elseif (($consumerProbeNow - $consumerAbsentSince).TotalSeconds -ge $CodexExitGraceSeconds) {
                $lifecycleLock = $null
                try {
                    try {
                        $lifecycleLock = [System.IO.File]::Open(
                            $startupLockPath,
                            [System.IO.FileMode]::OpenOrCreate,
                            [System.IO.FileAccess]::ReadWrite,
                            [System.IO.FileShare]::None
                        )
                    }
                    catch [System.IO.IOException] {}
                    if ($lifecycleLock) {
                        $consumerRecheck = Get-SafeConsumerState
                        if ($consumerRecheck.State -eq 'Absent') {
                            $explicitStopRequested = $true
                            $terminalReason = 'codex_desktop_window_absent'
                            Stop-OwnedProcess -Process $worker -Identity $workerIdentity -GracefulStopPath $stopPath -GracefulStopToken $stopToken
                            if (-not $worker.HasExited) {
                                throw 'AgentMemory did not stop after all Codex consumers exited.'
                            }
                            break
                        }
                        $consumerAbsentSince = $null
                    }
                }
                finally {
                    if ($lifecycleLock) { $lifecycleLock.Dispose() }
                }
            }
        }
        if ($engine.HasExited) {
            throw "The iii engine exited unexpectedly with code $($engine.ExitCode)."
        }
    }
    if (-not $explicitStopRequested -and (Test-StopRequest -WorkerPid $worker.Id -ExpectedToken $stopToken)) {
        $explicitStopRequested = $true
        $terminalReason = 'authenticated_external_stop'
    }
    if ($worker.ExitCode -ne 0) {
        throw "AgentMemory worker exited with code $($worker.ExitCode)."
    }
    if (-not $explicitStopRequested) {
        throw 'AgentMemory worker exited without an authenticated stop request.'
    }
}
catch {
    $terminalStatus = 'failed'
    $terminalError = $_.Exception.Message
    throw
}
finally {
    if ($worker -and $workerIdentity) {
        Stop-OwnedProcess -Process $worker -Identity $workerIdentity -GracefulStopPath $stopPath -GracefulStopToken $stopToken
    }
    if ($engine -and $engineIdentity) {
        Stop-OwnedProcess -Process $engine -Identity $engineIdentity
    }
    if ($workerLaunch -and $worker -and $worker.HasExited) {
        $workerLaunch.Dispose()
    }
    if ($engineLaunch -and $engine -and $engine.HasExited) {
        $engineLaunch.Dispose()
    }
    if ($engineIdentity -or $workerIdentity) {
        Write-RuntimeState -Status $terminalStatus -EngineIdentity $engineIdentity -WorkerIdentity $workerIdentity -ErrorMessage $terminalError -TerminalReason $terminalReason
    }
    if (Test-Path -LiteralPath $stopPath -PathType Leaf) {
        Remove-Item -Force -LiteralPath $stopPath
    }
}
