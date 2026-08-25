using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Globalization;

namespace AgentMemoryCodex
{
    internal static class HiddenLauncher
    {
        private const uint CREATE_SUSPENDED = 0x00000004;
        private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
        private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
        private const uint CREATE_NO_WINDOW = 0x08000000;
        private const uint STARTF_USESTDHANDLES = 0x00000100;
        private const uint DUPLICATE_SAME_ACCESS = 0x00000002;
        private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
        private const int JobObjectExtendedLimitInformation = 9;
        private const int STD_INPUT_HANDLE = -10;
        private const int STD_OUTPUT_HANDLE = -11;
        private const int STD_ERROR_HANDLE = -12;
        private const uint GENERIC_READ = 0x80000000;
        private const uint GENERIC_WRITE = 0x40000000;
        private const uint FILE_SHARE_READ = 0x00000001;
        private const uint FILE_SHARE_WRITE = 0x00000002;
        private const uint OPEN_EXISTING = 3;
        private const uint INFINITE = 0xFFFFFFFF;
        private const uint PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002;
        private static readonly IntPtr InvalidHandle = new IntPtr(-1);

        [StructLayout(LayoutKind.Sequential)]
        private struct SECURITY_ATTRIBUTES
        {
            public int nLength;
            public IntPtr lpSecurityDescriptor;
            public int bInheritHandle;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct STARTUPINFO
        {
            public int cb;
            public string lpReserved;
            public string lpDesktop;
            public string lpTitle;
            public int dwX;
            public int dwY;
            public int dwXSize;
            public int dwYSize;
            public int dwXCountChars;
            public int dwYCountChars;
            public int dwFillAttribute;
            public uint dwFlags;
            public short wShowWindow;
            public short cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct STARTUPINFOEX
        {
            public STARTUPINFO StartupInfo;
            public IntPtr lpAttributeList;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct PROCESS_INFORMATION
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public int dwProcessId;
            public int dwThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CreateProcessW(
            string applicationName,
            StringBuilder commandLine,
            IntPtr processAttributes,
            IntPtr threadAttributes,
            bool inheritHandles,
            uint creationFlags,
            IntPtr environment,
            string currentDirectory,
            ref STARTUPINFOEX startupInfo,
            out PROCESS_INFORMATION processInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool InitializeProcThreadAttributeList(IntPtr attributeList, int attributeCount, int flags, ref IntPtr size);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool UpdateProcThreadAttribute(IntPtr attributeList, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previousValue, IntPtr returnSize);

        [DllImport("kernel32.dll")]
        private static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(IntPtr job, int informationClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION information, int informationLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint ResumeThread(IntPtr thread);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateProcess(IntPtr process, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll")]
        private static extern IntPtr GetCurrentProcess();

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GetStdHandle(int standardHandle);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr sourceHandle, IntPtr targetProcess, out IntPtr targetHandle, uint desiredAccess, bool inheritHandle, uint options);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateFile(string fileName, uint desiredAccess, uint shareMode, ref SECURITY_ATTRIBUTES securityAttributes, uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

        [DataContract]
        private sealed class InstallManifest
        {
            [DataMember(Name = "schema_version", IsRequired = true)] public int SchemaVersion;
            [DataMember(Name = "install_root", IsRequired = true)] public string InstallRoot;
            [DataMember(Name = "status", IsRequired = true)] public string Status;
            [DataMember(Name = "node_path", IsRequired = true)] public string NodePath;
            [DataMember(Name = "package_relative_path", IsRequired = true)] public string PackageRelativePath;
            [DataMember(Name = "release_revision", IsRequired = true)] public string ReleaseRevision;
            [DataMember(Name = "source_hashes", IsRequired = true)] public Dictionary<string, string> SourceHashes;
        }

        [DataContract]
        private sealed class EnvironmentContract
        {
            [DataMember(Name = "schema_version", IsRequired = true)] public int SchemaVersion;
            [DataMember(Name = "secret_relative_path", IsRequired = true)] public string SecretRelativePath;
            [DataMember(Name = "dpapi_entropy", IsRequired = true)] public string DpapiEntropy;
            [DataMember(Name = "synthetic_home_relative_path", IsRequired = true)] public string SyntheticHomeRelativePath;
            [DataMember(Name = "workspace_config_relative_path", IsRequired = true)] public string WorkspaceConfigRelativePath;
            [DataMember(Name = "scrub_exact", IsRequired = true)] public string[] ScrubExact;
            [DataMember(Name = "scrub_name_pattern", IsRequired = true)] public string ScrubNamePattern;
            [DataMember(Name = "forbidden_environment_file_keys", IsRequired = true)] public string[] ForbiddenEnvironmentFileKeys;
            [DataMember(Name = "fixed_environment", IsRequired = true)] public Dictionary<string, string> FixedEnvironment;
        }

        [DataContract]
        private sealed class WorkspaceConfig
        {
            [DataMember(Name = "schema_version", IsRequired = true)] public int SchemaVersion;
            [DataMember(Name = "workspace_root", IsRequired = true)] public string WorkspaceRoot;
            [DataMember(Name = "project_registry", IsRequired = true)] public string ProjectRegistry;
        }

        private sealed class DirectMcpEnvironment : IDisposable
        {
            public readonly Dictionary<string, string> Variables;
            public char[] Secret;

            public DirectMcpEnvironment(Dictionary<string, string> variables, char[] secret)
            {
                Variables = variables;
                Secret = secret;
            }

            public void Dispose()
            {
                char[] owned = Interlocked.Exchange(ref Secret, null);
                ClearChars(owned);
            }
        }

        private static int Main(string[] args)
        {
            string mode = args.Length == 1 ? (args[0] ?? string.Empty).Trim().ToLowerInvariant() : string.Empty;
            if (mode != "mcp" && mode != "task" && mode != "watch") return 64;
            string root = GetInstallRoot();
            string scriptName = mode == "mcp"
                ? "agentmemory-mcp.ps1"
                : mode == "task" ? "agentmemory-task.ps1" : "agentmemory-watch.ps1";
            string scriptPath = Path.Combine(root, "scripts", scriptName);
            string powershellPath = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.Windows),
                "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

            McpLease lease = null;
            try
            {
                RequireFile(powershellPath);
                RequireFile(scriptPath);
                if (mode == "mcp") lease = McpLease.Create(root);
                if (mode == "mcp") return RunMcp(root, powershellPath);
                string[] baseArguments = new[] {
                    "-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
                    "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-Root", root
                };
                string[] childArguments;
                if (mode == "task")
                {
                    childArguments = new string[baseArguments.Length + 2];
                    Array.Copy(baseArguments, childArguments, baseArguments.Length);
                    childArguments[baseArguments.Length] = "-HiddenLauncherPid";
                    childArguments[baseArguments.Length + 1] = Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture);
                }
                else childArguments = baseArguments;
                return RunOwnedChild(mode, root, powershellPath, childArguments, null);
            }
            catch (Exception ex)
            {
                string message = "AgentMemory hidden launcher failed (" + mode + "): " + Sanitize(ex.Message);
                if (mode == "mcp") TryWriteStderr(message);
                else TryWritePrivateLog(root, mode, message);
                return 1;
            }
            finally
            {
                if (lease != null) lease.Dispose();
            }
        }

        private static int RunMcp(string root, string powershellPath)
        {
            string manifestPath = Path.Combine(root, "config", "install-manifest.json");
            string contractPath = Path.Combine(root, "config", "mcp-launcher-environment.json");
            InstallManifest manifest = ReadJson<InstallManifest>(manifestPath);
            EnvironmentContract contract = ReadJson<EnvironmentContract>(contractPath);
            ValidateInstallManifest(manifest, root);
            ValidateEnvironmentContract(contract);

            string nodePath = RequireAbsoluteFile(manifest.NodePath, "Node executable");
            string packageRoot = ResolveContainedDirectory(root, manifest.PackageRelativePath, "AgentMemory package root");
            string cliPath = ResolveContainedFile(packageRoot, "dist\\cli.mjs", "AgentMemory CLI");
            string validationScript = ResolveContainedFile(root, "scripts\\agentmemory-mcp.ps1", "MCP validation script");
            string layoutScript = ResolveContainedFile(root, "scripts\\agentmemory-layout.ps1", "layout script");
            string environmentScript = ResolveContainedFile(root, "scripts\\agentmemory-env.ps1", "environment script");
            VerifyManifestFile(root, manifest, cliPath, "AgentMemory CLI");
            VerifyManifestFile(root, manifest, validationScript, "MCP validation script");
            VerifyManifestFile(root, manifest, layoutScript, "layout script");
            VerifyManifestFile(root, manifest, environmentScript, "environment script");
            VerifyManifestFile(root, manifest, contractPath, "MCP environment config");

            string[] validationArguments = new[] {
                "-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
                "-ExecutionPolicy", "Bypass", "-File", validationScript,
                "-Root", root, "-NodePath", nodePath, "-ValidateOnly"
            };
            int validationExitCode = RunOwnedChild("mcp", root, powershellPath, validationArguments, null);
            if (validationExitCode != 0) return validationExitCode;

            DirectMcpEnvironment childEnvironment = BuildDirectMcpEnvironment(root, contract);
            return RunOwnedChild(
                "mcp",
                root,
                nodePath,
                new[] { cliPath, "mcp", "--no-engine", "--tools", "all" },
                childEnvironment);
        }

        private static int RunOwnedChild(string mode, string root, string application, string[] arguments, DirectMcpEnvironment childEnvironment)
        {
            IntPtr job = IntPtr.Zero;
            IntPtr attributeList = IntPtr.Zero;
            IntPtr handleList = IntPtr.Zero;
            IntPtr environmentBlock = IntPtr.Zero;
            char[] environmentCharacters = null;
            IntPtr stdin = IntPtr.Zero;
            IntPtr stdout = IntPtr.Zero;
            IntPtr stderr = IntPtr.Zero;
            PROCESS_INFORMATION child = new PROCESS_INFORMATION();
            bool childCreated = false;
            bool childAssigned = false;
            bool childResumed = false;

            try
            {
                job = CreateKillOnCloseJob();
                CreateChildStandardHandles(mode, out stdin, out stdout, out stderr);

                IntPtr attributeSize = IntPtr.Zero;
                InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeSize);
                attributeList = Marshal.AllocHGlobal(attributeSize);
                if (!InitializeProcThreadAttributeList(attributeList, 1, 0, ref attributeSize)) ThrowLastWin32("InitializeProcThreadAttributeList failed");

                handleList = Marshal.AllocHGlobal(IntPtr.Size * 3);
                Marshal.WriteIntPtr(handleList, 0, stdin);
                Marshal.WriteIntPtr(handleList, IntPtr.Size, stdout);
                Marshal.WriteIntPtr(handleList, IntPtr.Size * 2, stderr);
                if (!UpdateProcThreadAttribute(
                    attributeList,
                    0,
                    new IntPtr(PROC_THREAD_ATTRIBUTE_HANDLE_LIST),
                    handleList,
                    new IntPtr(IntPtr.Size * 3),
                    IntPtr.Zero,
                    IntPtr.Zero)) ThrowLastWin32("UpdateProcThreadAttribute(handle list) failed");

                var startup = new STARTUPINFOEX();
                startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
                startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
                startup.StartupInfo.hStdInput = stdin;
                startup.StartupInfo.hStdOutput = stdout;
                startup.StartupInfo.hStdError = stderr;
                startup.lpAttributeList = attributeList;

                var commandLine = new StringBuilder(BuildCommandLine(application, arguments));
                uint creationFlags = CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT;
                if (childEnvironment != null)
                {
                    try { environmentCharacters = BuildEnvironmentBlock(childEnvironment); }
                    finally
                    {
                        childEnvironment.Dispose();
                        childEnvironment = null;
                    }
                    environmentBlock = Marshal.AllocHGlobal(environmentCharacters.Length * sizeof(char));
                    Marshal.Copy(environmentCharacters, 0, environmentBlock, environmentCharacters.Length);
                    creationFlags |= CREATE_UNICODE_ENVIRONMENT;
                }
                bool created;
                try
                {
                    created = CreateProcessW(
                        application,
                        commandLine,
                        IntPtr.Zero,
                        IntPtr.Zero,
                        true,
                        creationFlags,
                        environmentBlock,
                        root,
                        ref startup,
                        out child);
                }
                finally
                {
                    ClearChars(environmentCharacters);
                    environmentCharacters = null;
                    if (environmentBlock != IntPtr.Zero)
                    {
                        Marshal.FreeHGlobal(environmentBlock);
                        environmentBlock = IntPtr.Zero;
                    }
                }
                if (!created) ThrowLastWin32("CreateProcessW failed");
                childCreated = true;

                if (!AssignProcessToJobObject(job, child.hProcess)) ThrowLastWin32("AssignProcessToJobObject failed");
                childAssigned = true;
                if (ResumeThread(child.hThread) == 0xFFFFFFFF) ThrowLastWin32("ResumeThread failed");
                childResumed = true;
                CloseHandle(child.hThread);
                child.hThread = IntPtr.Zero;

                uint wait = WaitForSingleObject(child.hProcess, INFINITE);
                if (wait != 0) ThrowLastWin32("WaitForSingleObject failed");
                uint exitCode;
                if (!GetExitCodeProcess(child.hProcess, out exitCode)) ThrowLastWin32("GetExitCodeProcess failed");
                return unchecked((int)exitCode);
            }
            finally
            {
                if (child.hThread != IntPtr.Zero) CloseHandle(child.hThread);
                if (childCreated && !childResumed && child.hProcess != IntPtr.Zero)
                {
                    // This is the exact suspended process returned by CreateProcessW; it has not executed user code.
                    TerminateProcess(child.hProcess, 1);
                    WaitForSingleObject(child.hProcess, 5000);
                }
                if (child.hProcess != IntPtr.Zero) CloseHandle(child.hProcess);
                if (job != IntPtr.Zero)
                {
                    // If the launcher is interrupted, closing this handle terminates only its assigned child tree.
                    CloseHandle(job);
                }
                if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
                if (childEnvironment != null) childEnvironment.Dispose();
                ClearChars(environmentCharacters);
                if (environmentBlock != IntPtr.Zero) Marshal.FreeHGlobal(environmentBlock);
                if (attributeList != IntPtr.Zero)
                {
                    DeleteProcThreadAttributeList(attributeList);
                    Marshal.FreeHGlobal(attributeList);
                }
                CloseIfValid(stdin);
                CloseIfValid(stdout);
                CloseIfValid(stderr);
                GC.KeepAlive(childAssigned);
            }
        }

        private static IntPtr CreateKillOnCloseJob()
        {
            IntPtr job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) ThrowLastWin32("CreateJobObject failed");
            var information = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref information, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
            {
                int error = Marshal.GetLastWin32Error();
                CloseHandle(job);
                throw new Win32Exception(error, "SetInformationJobObject failed");
            }
            return job;
        }

        private static void CreateChildStandardHandles(string mode, out IntPtr stdin, out IntPtr stdout, out IntPtr stderr)
        {
            if (mode == "mcp")
            {
                stdin = DuplicateInheritedStandardHandle(STD_INPUT_HANDLE);
                try
                {
                    stdout = DuplicateInheritedStandardHandle(STD_OUTPUT_HANDLE);
                    try
                    {
                        stderr = DuplicateInheritedStandardHandle(STD_ERROR_HANDLE);
                    }
                    catch
                    {
                        CloseIfValid(stdout);
                        throw;
                    }
                }
                catch
                {
                    CloseIfValid(stdin);
                    throw;
                }
                return;
            }

            var security = new SECURITY_ATTRIBUTES {
                nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)),
                lpSecurityDescriptor = IntPtr.Zero,
                bInheritHandle = 1
            };
            stdin = CreateFile("NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, ref security, OPEN_EXISTING, 0, IntPtr.Zero);
            if (!IsValid(stdin)) ThrowLastWin32("Opening NUL stdin failed");
            stdout = CreateFile("NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, ref security, OPEN_EXISTING, 0, IntPtr.Zero);
            if (!IsValid(stdout))
            {
                CloseIfValid(stdin);
                ThrowLastWin32("Opening NUL stdout failed");
            }
            stderr = CreateFile("NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, ref security, OPEN_EXISTING, 0, IntPtr.Zero);
            if (!IsValid(stderr))
            {
                CloseIfValid(stdin);
                CloseIfValid(stdout);
                ThrowLastWin32("Opening NUL stderr failed");
            }
        }

        private static IntPtr DuplicateInheritedStandardHandle(int standardHandle)
        {
            IntPtr source = GetStdHandle(standardHandle);
            if (!IsValid(source)) throw new InvalidOperationException("The MCP standard stream handle is unavailable.");
            IntPtr duplicate;
            IntPtr current = GetCurrentProcess();
            if (!DuplicateHandle(current, source, current, out duplicate, 0, true, DUPLICATE_SAME_ACCESS))
                ThrowLastWin32("DuplicateHandle for an MCP standard stream failed");
            return duplicate;
        }

        private static string BuildCommandLine(string application, string[] arguments)
        {
            var value = new StringBuilder(QuoteWindowsArgument(application));
            foreach (string argument in arguments)
            {
                value.Append(' ').Append(QuoteWindowsArgument(argument));
            }
            return value.ToString();
        }

        private static string QuoteWindowsArgument(string value)
        {
            if (value == null) throw new ArgumentNullException("value");
            if (value.IndexOf('\0') >= 0) throw new InvalidOperationException("A launcher argument contains NUL.");
            if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return value;

            var result = new StringBuilder("\"");
            int backslashes = 0;
            foreach (char character in value)
            {
                if (character == '\\')
                {
                    backslashes++;
                }
                else if (character == '"')
                {
                    result.Append('\\', backslashes * 2 + 1).Append('"');
                    backslashes = 0;
                }
                else
                {
                    result.Append('\\', backslashes).Append(character);
                    backslashes = 0;
                }
            }
            result.Append('\\', backslashes * 2).Append('"');
            return result.ToString();
        }

        private static char[] BuildEnvironmentBlock(DirectMcpEnvironment environment)
        {
            if (environment == null || environment.Secret == null) throw new InvalidOperationException("The MCP child environment is incomplete.");
            if (environment.Variables.ContainsKey("AGENTMEMORY_SECRET")) throw new InvalidOperationException("The MCP secret must not be stored in the launcher environment dictionary.");
            var names = new List<string>(environment.Variables.Keys);
            names.Add("AGENTMEMORY_SECRET");
            names.Sort(StringComparer.OrdinalIgnoreCase);

            long required = 1;
            foreach (string name in names)
            {
                ValidateEnvironmentName(name);
                int valueLength;
                if (string.Equals(name, "AGENTMEMORY_SECRET", StringComparison.OrdinalIgnoreCase))
                {
                    valueLength = environment.Secret.Length;
                }
                else
                {
                    string value = environment.Variables[name] ?? string.Empty;
                    if (value.IndexOf('\0') >= 0) throw new InvalidOperationException("An MCP child environment value contains NUL.");
                    valueLength = value.Length;
                }
                required = checked(required + name.Length + 1L + valueLength + 1L);
            }
            if (required > int.MaxValue) throw new InvalidOperationException("The MCP child environment is too large.");

            char[] block = new char[(int)required];
            int offset = 0;
            foreach (string name in names)
            {
                name.CopyTo(0, block, offset, name.Length);
                offset += name.Length;
                block[offset++] = '=';
                if (string.Equals(name, "AGENTMEMORY_SECRET", StringComparison.OrdinalIgnoreCase))
                {
                    Array.Copy(environment.Secret, 0, block, offset, environment.Secret.Length);
                    offset += environment.Secret.Length;
                }
                else
                {
                    string value = environment.Variables[name] ?? string.Empty;
                    value.CopyTo(0, block, offset, value.Length);
                    offset += value.Length;
                }
                block[offset++] = '\0';
            }
            block[offset] = '\0';
            return block;
        }

        private static void ValidateEnvironmentName(string name)
        {
            if (string.IsNullOrEmpty(name) || name.IndexOf('\0') >= 0) throw new InvalidOperationException("An MCP child environment name is invalid.");
            int equals = name.IndexOf('=');
            if (equals > 0 || (equals == 0 && name.IndexOf('=', 1) >= 0))
                throw new InvalidOperationException("An MCP child environment name is invalid.");
        }

        private static DirectMcpEnvironment BuildDirectMcpEnvironment(string root, EnvironmentContract contract)
        {
            string syntheticHome = ResolveContainedDirectory(root, contract.SyntheticHomeRelativePath, "synthetic home");
            string workspaceConfigPath = ResolveContainedFile(root, contract.WorkspaceConfigRelativePath, "workspace config");
            WorkspaceConfig workspace = ReadJson<WorkspaceConfig>(workspaceConfigPath);
            if (workspace.SchemaVersion != 1) throw new InvalidOperationException("The AgentMemory workspace config schema is unsupported.");
            string workspaceRoot = RequireAbsoluteDirectory(workspace.WorkspaceRoot, "workspace root");
            string projectRegistry = RequireAbsoluteFile(workspace.ProjectRegistry, "project registry");
            if (!IsContainedPath(workspaceRoot, projectRegistry))
                throw new InvalidOperationException("The AgentMemory project registry must be inside the workspace root.");

            var scrubExact = new HashSet<string>(contract.ScrubExact, StringComparer.OrdinalIgnoreCase);
            var scrubPattern = new Regex(contract.ScrubNamePattern, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
            var variables = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables())
            {
                string name = Convert.ToString(entry.Key, CultureInfo.InvariantCulture);
                if (string.IsNullOrEmpty(name) || scrubExact.Contains(name) || scrubPattern.IsMatch(name)) continue;
                variables[name] = Convert.ToString(entry.Value, CultureInfo.InvariantCulture) ?? string.Empty;
            }

            variables["USERPROFILE"] = syntheticHome;
            variables["HOME"] = syntheticHome;
            variables["PSModuleAnalysisCachePath"] = Path.Combine(syntheticHome, "PowerShell", "ModuleAnalysisCache");
            variables["POWERSHELL_TELEMETRY_OPTOUT"] = "1";
            foreach (KeyValuePair<string, string> entry in contract.FixedEnvironment)
                variables[entry.Key] = entry.Value;
            variables["AGENTMEMORY_LOCAL_QWEN_COORDINATION_DIR"] = Path.Combine(root, "data", "qwen-coordination");
            variables["AGENTMEMORY_WORKSPACE_ROOT"] = workspaceRoot;
            variables["AGENTMEMORY_PROJECT_REGISTRY"] = projectRegistry;

            AssertProviderEnvironmentFileIsClean(syntheticHome, contract.ForbiddenEnvironmentFileKeys);
            string secretPath = ResolveContainedFile(root, contract.SecretRelativePath, "DPAPI secret");
            char[] secret = UnprotectSecret(secretPath, contract.DpapiEntropy);
            return new DirectMcpEnvironment(variables, secret);
        }

        private static void ValidateInstallManifest(InstallManifest manifest, string root)
        {
            if (manifest == null || manifest.SchemaVersion != 3 ||
                !string.Equals(manifest.Status, "active", StringComparison.Ordinal) ||
                string.IsNullOrWhiteSpace(manifest.ReleaseRevision) || manifest.SourceHashes == null)
                throw new InvalidOperationException("The AgentMemory install manifest is incomplete or unsupported.");
            string manifestRoot = RequireAbsoluteDirectory(manifest.InstallRoot, "install manifest root");
            if (!string.Equals(manifestRoot, root, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("The AgentMemory install manifest does not match this launcher.");
            ResolveContainedDirectory(root, manifest.PackageRelativePath, "AgentMemory package root");
        }

        private static void VerifyManifestFile(string root, InstallManifest manifest, string path, string label)
        {
            string relative = Path.GetFullPath(path).Substring(root.Length).TrimStart(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            string expected;
            if (!manifest.SourceHashes.TryGetValue(relative.Replace('/', '\\'), out expected))
                throw new InvalidOperationException("The AgentMemory install manifest is missing the " + label + " hash.");
            VerifySha256(path, expected, label);
        }

        private static void ValidateEnvironmentContract(EnvironmentContract contract)
        {
            if (contract == null || contract.SchemaVersion != 1) throw new InvalidOperationException("The MCP environment contract schema is unsupported.");
            if (string.IsNullOrWhiteSpace(contract.DpapiEntropy) || contract.DpapiEntropy != "Codex.AgentMemory.v1")
                throw new InvalidOperationException("The MCP environment contract has an unsupported DPAPI entropy identifier.");
            if (contract.ScrubExact == null || contract.ForbiddenEnvironmentFileKeys == null || contract.FixedEnvironment == null)
                throw new InvalidOperationException("The MCP environment contract is incomplete.");
            if (contract.FixedEnvironment.ContainsKey("AGENTMEMORY_SECRET") ||
                contract.FixedEnvironment.ContainsKey("AGENTMEMORY_WORKSPACE_ROOT") ||
                contract.FixedEnvironment.ContainsKey("AGENTMEMORY_PROJECT_REGISTRY") ||
                contract.FixedEnvironment.ContainsKey("AGENTMEMORY_LOCAL_QWEN_COORDINATION_DIR"))
                throw new InvalidOperationException("The MCP environment contract contains a dynamic or secret value.");
            RequireFixed(contract, "AGENTMEMORY_PROVIDER", "local-qwen");
            RequireFixed(contract, "AGENTMEMORY_PROVIDER_CAPABILITIES", "graph");
            RequireFixed(contract, "AGENTMEMORY_LOCAL_QWEN_MODEL", "auto");
            RequireFixed(contract, "AGENTMEMORY_LOCAL_QWEN_MAX_INPUT_TOKENS", "auto");
            RequireFixed(contract, "FALLBACK_PROVIDERS", "none");
            RequireFixed(contract, "AGENTMEMORY_AUTO_COMPRESS", "false");
            RequireFixed(contract, "AGENTMEMORY_SUMMARY_ENABLED", "false");
            RequireFixed(contract, "CONSOLIDATION_ENABLED", "false");
            RequireFixed(contract, "GRAPH_EXTRACTION_ENABLED", "true");
            RequireFixed(contract, "AGENTMEMORY_INJECT_CONTEXT", "false");
            RequireFixed(contract, "AGENTMEMORY_FORCE_PROXY", "true");
            RequireFixed(contract, "AGENTMEMORY_TOOLS", "all");
            RequireFixed(contract, "NO_PROXY", "127.0.0.1,127.0.0.2,localhost");
            RequireLoopbackUri(contract.FixedEnvironment, "AGENTMEMORY_URL", "http");
            RequireLoopbackUri(contract.FixedEnvironment, "AGENTMEMORY_LOCAL_QWEN_BASE_URL", "http");
            RequireLoopbackUri(contract.FixedEnvironment, "III_ENGINE_URL", "ws");
            foreach (string key in new[] { "III_ENGINE_PORT", "III_REST_PORT", "III_STREAM_PORT" })
            {
                int port;
                string value;
                if (!contract.FixedEnvironment.TryGetValue(key, out value) ||
                    !int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out port) || port < 1 || port > 65535)
                    throw new InvalidOperationException("The MCP environment contract contains an invalid port.");
            }
            var scrubPattern = new Regex(contract.ScrubNamePattern, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
            if (!scrubPattern.IsMatch("SAMPLE_SECRET")) throw new InvalidOperationException("The MCP environment scrub pattern is unsafe.");
            RequireUniqueNames(contract.ScrubExact, "scrub list");
            RequireUniqueNames(contract.ForbiddenEnvironmentFileKeys, "provider environment denylist");
        }

        private static void RequireFixed(EnvironmentContract contract, string name, string expected)
        {
            string actual;
            if (!contract.FixedEnvironment.TryGetValue(name, out actual) || !string.Equals(actual, expected, StringComparison.Ordinal))
                throw new InvalidOperationException("The MCP environment contract violates a required security setting.");
        }

        private static void RequireLoopbackUri(Dictionary<string, string> values, string name, string scheme)
        {
            string text;
            Uri uri;
            System.Net.IPAddress address;
            if (!values.TryGetValue(name, out text) || !Uri.TryCreate(text, UriKind.Absolute, out uri) ||
                !string.Equals(uri.Scheme, scheme, StringComparison.OrdinalIgnoreCase) ||
                !System.Net.IPAddress.TryParse(uri.Host, out address) || !System.Net.IPAddress.IsLoopback(address))
                throw new InvalidOperationException("The MCP environment contract contains a non-loopback endpoint.");
        }

        private static void RequireUniqueNames(string[] values, string label)
        {
            var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (string value in values)
            {
                if (string.IsNullOrWhiteSpace(value) || !names.Add(value))
                    throw new InvalidOperationException("The MCP environment " + label + " is invalid.");
            }
        }

        private static void AssertProviderEnvironmentFileIsClean(string syntheticHome, string[] forbiddenKeys)
        {
            string path = Path.Combine(syntheticHome, ".agentmemory", ".env");
            if (!File.Exists(path)) return;
            var forbidden = new HashSet<string>(forbiddenKeys, StringComparer.OrdinalIgnoreCase);
            using (var reader = new StreamReader(path, Encoding.UTF8, true))
            {
                string rawLine;
                while ((rawLine = reader.ReadLine()) != null)
                {
                    string line = rawLine.Trim();
                    if (line.Length == 0 || line.StartsWith("#", StringComparison.Ordinal)) continue;
                    int separator = line.IndexOf('=');
                    if (separator <= 0) continue;
                    string key = line.Substring(0, separator).Trim();
                    string value = line.Substring(separator + 1).Trim().Trim('"', '\'');
                    if (forbidden.Contains(key) && value.Length > 0)
                        throw new InvalidOperationException("External provider configuration is forbidden: " + key);
                }
            }
        }

        private static char[] UnprotectSecret(string path, string entropyText)
        {
            byte[] entropy = Encoding.UTF8.GetBytes(entropyText);
            byte[] protectedBytes = File.ReadAllBytes(path);
            byte[] plainBytes = null;
            byte[] decodedBytes = null;
            char[] characters = null;
            bool success = false;
            try
            {
                plainBytes = ProtectedData.Unprotect(protectedBytes, entropy, DataProtectionScope.CurrentUser);
                characters = Encoding.UTF8.GetChars(plainBytes);
                if (characters.Length != 44 || characters[43] != '=')
                    throw new InvalidOperationException("AgentMemory secret has an invalid format.");
                for (int index = 0; index < 43; index++)
                {
                    char value = characters[index];
                    if (!((value >= 'A' && value <= 'Z') || (value >= 'a' && value <= 'z') ||
                          (value >= '0' && value <= '9') || value == '+' || value == '/'))
                        throw new InvalidOperationException("AgentMemory secret has an invalid format.");
                }
                decodedBytes = Convert.FromBase64CharArray(characters, 0, characters.Length);
                if (decodedBytes.Length != 32) throw new InvalidOperationException("AgentMemory secret has an invalid length.");
                success = true;
                return characters;
            }
            finally
            {
                if (!success) ClearChars(characters);
                ClearBytes(decodedBytes);
                ClearBytes(plainBytes);
                ClearBytes(protectedBytes);
                ClearBytes(entropy);
            }
        }

        private static T ReadJson<T>(string path)
        {
            RequireFile(path);
            try
            {
                var settings = new DataContractJsonSerializerSettings { UseSimpleDictionaryFormat = true, MaxItemsInObjectGraph = 65536 };
                var serializer = new DataContractJsonSerializer(typeof(T), settings);
                using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
                {
                    object value = serializer.ReadObject(stream);
                    if (value == null) throw new SerializationException();
                    return (T)value;
                }
            }
            catch (Exception ex)
            {
                if (ex is IOException || ex is UnauthorizedAccessException) throw;
                throw new InvalidOperationException("A required AgentMemory JSON config is malformed.");
            }
        }

        private static string RequireAbsoluteDirectory(string value, string label)
        {
            if (string.IsNullOrWhiteSpace(value) || !Path.IsPathRooted(value))
                throw new InvalidOperationException("The " + label + " path must be absolute.");
            string full = Path.GetFullPath(value);
            if (!Directory.Exists(full)) throw new DirectoryNotFoundException("The " + label + " directory is missing.");
            return full.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        }

        private static string RequireAbsoluteFile(string value, string label)
        {
            if (string.IsNullOrWhiteSpace(value) || !Path.IsPathRooted(value))
                throw new InvalidOperationException("The " + label + " path must be absolute.");
            string full = Path.GetFullPath(value);
            RequireFile(full);
            if ((File.GetAttributes(full) & FileAttributes.ReparsePoint) != 0)
                throw new InvalidOperationException("The " + label + " path must not be a reparse point.");
            return full;
        }

        private static string ResolveContainedFile(string root, string relative, string label)
        {
            string path = ResolveContainedPath(root, relative, label);
            RequireFile(path);
            if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
                throw new InvalidOperationException("The " + label + " path must not be a reparse point.");
            return path;
        }

        private static string ResolveContainedDirectory(string root, string relative, string label)
        {
            string path = ResolveContainedPath(root, relative, label);
            if (!Directory.Exists(path)) throw new DirectoryNotFoundException("The " + label + " directory is missing.");
            return path;
        }

        private static string ResolveContainedPath(string root, string relative, string label)
        {
            if (string.IsNullOrWhiteSpace(relative) || Path.IsPathRooted(relative))
                throw new InvalidOperationException("The " + label + " path must be relative.");
            string fullRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            string full = Path.GetFullPath(Path.Combine(fullRoot, relative));
            if (!IsContainedPath(fullRoot, full)) throw new InvalidOperationException("The " + label + " path escapes its root.");
            return full;
        }

        private static bool IsContainedPath(string root, string path)
        {
            string prefix = root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
            return path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase);
        }

        private static void VerifySha256(string path, string expected, string label)
        {
            if (string.IsNullOrWhiteSpace(expected) || !Regex.IsMatch(expected, "^[A-Fa-f0-9]{64}$", RegexOptions.CultureInvariant))
                throw new InvalidOperationException("The expected " + label + " hash is invalid.");
            string actual;
            using (SHA256 sha = SHA256.Create())
            using (FileStream stream = File.OpenRead(path))
                actual = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", string.Empty);
            if (!string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException(label + " hash mismatch.");
        }

        private static void ClearBytes(byte[] value)
        {
            if (value != null && value.Length > 0) Array.Clear(value, 0, value.Length);
        }

        private static void ClearChars(char[] value)
        {
            if (value != null && value.Length > 0) Array.Clear(value, 0, value.Length);
        }

        private static string GetInstallRoot()
        {
            string executablePath = Path.GetFullPath(Assembly.GetExecutingAssembly().Location);
            string binDirectory = Path.GetDirectoryName(executablePath);
            DirectoryInfo parent = Directory.GetParent(binDirectory);
            if (parent == null) throw new InvalidOperationException("Could not resolve the AgentMemory install root.");
            return Path.GetFullPath(parent.FullName);
        }

        private static void RequireFile(string path)
        {
            if (!File.Exists(path)) throw new FileNotFoundException("Required launcher file is missing.", path);
        }

        private static bool IsValid(IntPtr handle)
        {
            return handle != IntPtr.Zero && handle != InvalidHandle;
        }

        private static void CloseIfValid(IntPtr handle)
        {
            if (IsValid(handle)) CloseHandle(handle);
        }

        private static void ThrowLastWin32(string message)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), message);
        }

        private static string Sanitize(string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return "unspecified failure";
            return value.Replace('\r', ' ').Replace('\n', ' ').Trim();
        }

        private static void TryWriteStderr(string message)
        {
            try
            {
                using (var writer = new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false)))
                {
                    writer.WriteLine(message);
                    writer.Flush();
                }
            }
            catch { }
        }

        private static void TryWritePrivateLog(string root, string mode, string message)
        {
            try
            {
                string logs = Path.Combine(root, "logs");
                Directory.CreateDirectory(logs);
                string path = Path.Combine(logs, "launcher-" + mode + "-" + DateTime.UtcNow.ToString("yyyyMMddTHHmmssfffZ") + ".stderr.log");
                File.WriteAllText(path, message, new UTF8Encoding(false));
            }
            catch { }
        }

        private sealed class McpLease : IDisposable
        {
            private FileStream stream;
            private readonly string path;

            private McpLease(FileStream stream, string path)
            {
                this.stream = stream;
                this.path = path;
            }

            public static McpLease Create(string root)
            {
                string dataDirectory = Path.Combine(root, "data");
                string leaseDirectory = Path.Combine(dataDirectory, "mcp-leases");
                Directory.CreateDirectory(leaseDirectory);
                string startupLockPath = Path.Combine(dataDirectory, "startup.lock");
                using (FileStream startupLock = AcquireExclusive(startupLockPath, TimeSpan.FromSeconds(65)))
                {
                    using (Process current = Process.GetCurrentProcess())
                    {
                        string fileName = "mcp-" + current.Id + "-" + current.StartTime.ToUniversalTime().Ticks + "-" + Guid.NewGuid().ToString("N") + ".lease";
                        string leasePath = Path.Combine(leaseDirectory, fileName);
                        var lease = new FileStream(
                            leasePath,
                            FileMode.CreateNew,
                            FileAccess.ReadWrite,
                            FileShare.Read | FileShare.Delete,
                            4096,
                            FileOptions.DeleteOnClose | FileOptions.WriteThrough);
                        string ownerSid = WindowsIdentity.GetCurrent().User.Value;
                        string payload = "{\"schema_version\":1,\"pid\":" + current.Id
                            + ",\"creation_time_utc\":\"" + current.StartTime.ToUniversalTime().ToString("o")
                            + "\",\"owner_sid\":\"" + ownerSid + "\"}";
                        byte[] bytes = new UTF8Encoding(false).GetBytes(payload);
                        lease.Write(bytes, 0, bytes.Length);
                        lease.Flush(true);
                        lease.Position = 0;
                        return new McpLease(lease, leasePath);
                    }
                }
            }

            private static FileStream AcquireExclusive(string path, TimeSpan timeout)
            {
                DateTime deadline = DateTime.UtcNow.Add(timeout);
                do
                {
                    try
                    {
                        return new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
                    }
                    catch (IOException)
                    {
                        Thread.Sleep(100);
                    }
                } while (DateTime.UtcNow < deadline);
                throw new TimeoutException("Timed out waiting for the AgentMemory lifecycle lock.");
            }

            public void Dispose()
            {
                FileStream owned = Interlocked.Exchange(ref stream, null);
                if (owned == null) return;
                owned.Dispose();
                try { File.Delete(path); } catch { }
            }
        }
    }
}
