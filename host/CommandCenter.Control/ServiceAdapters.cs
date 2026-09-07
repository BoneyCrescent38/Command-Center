using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

namespace KristianLiverod.CommandCenter.Control
{
    internal sealed class CommandCenterServiceAdapter : IServiceAdapter
    {
        private readonly CommandCenterRuntime runtime;
        private readonly ServiceAutoStartStore autoStartStore;

        internal CommandCenterServiceAdapter(CommandCenterRuntime runtime, ServiceAutoStartStore autoStartStore)
        {
            this.runtime = runtime;
            this.autoStartStore = autoStartStore;
        }

        public string Id { get { return "command-center"; } }
        public string DisplayName { get { return "Command Center"; } }
        public LocalServiceEnvironment Environment { get { return LocalServiceEnvironment.Production; } }
        public string Endpoint { get { return "http://127.0.0.1:4337"; } }
        public AutoStartPolicy AutoStartPolicy { get { return AutoStartPolicy.ControlManaged; } }

        public Task<ServiceStatusSnapshot> GetStatusAsync()
        {
            return Task.Run(delegate
            {
                RuntimeSnapshot runtimeStatus = runtime.GetSnapshot();
                bool online = runtimeStatus.ServerOnline && runtimeStatus.HostRunning;
                bool partial = runtimeStatus.ServerProcessRunning || runtimeStatus.HostRunning;
                ServiceStatusSnapshot status = NewStatus();
                status.State = online ? LocalServiceState.Online : (partial ? LocalServiceState.Partial : LocalServiceState.Offline);
                status.Detail = online ? "Server and Xeneon host are ready" : (partial ? "Runtime needs recovery" : "Stopped");
                status.AutoStartEnabled = autoStartStore.IsEnabled(Id);
                status.Components.Add(Component("Server", runtimeStatus.ServerOnline ? "Online" : (runtimeStatus.ServerProcessRunning ? "Starting" : "Offline"), runtimeStatus.ServerOnline ? LocalServiceState.Online : (runtimeStatus.ServerProcessRunning ? LocalServiceState.Starting : LocalServiceState.Offline)));
                status.Components.Add(Component("Xeneon", runtimeStatus.HostRunning ? "Running" : "Stopped", runtimeStatus.HostRunning ? LocalServiceState.Online : LocalServiceState.Offline));
                status.Components.Add(Component("Spotify", runtimeStatus.SpotifyActivationRequired ? "Activation" : (runtimeStatus.SpotifyHealthy ? "Ready" : "Unavailable"), runtimeStatus.SpotifyActivationRequired ? LocalServiceState.Partial : (runtimeStatus.SpotifyHealthy ? LocalServiceState.Online : LocalServiceState.Offline)));
                return status;
            });
        }

        public Task ExecuteAsync(string action, Action<string> progress)
        {
            return runtime.ExecuteActionAsync(action, progress);
        }

        private ServiceStatusSnapshot NewStatus()
        {
            return new ServiceStatusSnapshot
            {
                Id = Id,
                DisplayName = DisplayName,
                Environment = Environment,
                Endpoint = Endpoint,
                AutoStartPolicy = AutoStartPolicy,
                CheckedAt = DateTime.Now
            };
        }

        private static ServiceComponentSnapshot Component(string name, string status, LocalServiceState state)
        {
            return new ServiceComponentSnapshot { Name = name, Status = status, State = state };
        }
    }

    internal sealed class RfidHealthResult
    {
        internal string Status;
        internal string Detail;
        internal int? Port;
        internal int? ProcessId;

        internal bool Healthy
        {
            get { return String.Equals(Status, "Healthy", StringComparison.OrdinalIgnoreCase); }
        }

        internal static RfidHealthResult Parse(string cliXml)
        {
            return new RfidHealthResult
            {
                Status = PropertyValue(cliXml, "Status"),
                Detail = PropertyValue(cliXml, "Detail"),
                Port = IntegerPropertyValue(cliXml, "Port"),
                ProcessId = IntegerPropertyValue(cliXml, "PID")
            };
        }

        private static int? IntegerPropertyValue(string cliXml, string propertyName)
        {
            int value;
            string raw = PropertyValue(cliXml, propertyName);
            return Int32.TryParse(raw, out value) ? (int?)value : null;
        }

        private static string PropertyValue(string cliXml, string propertyName)
        {
            Match match = Regex.Match(
                cliXml ?? String.Empty,
                "<(?<tag>S|I32|I64|U32|U64)\\s+N=\"" + Regex.Escape(propertyName) + "\"[^>]*>(?<value>.*?)</\\k<tag>>",
                RegexOptions.IgnoreCase | RegexOptions.Singleline | RegexOptions.CultureInvariant);
            return match.Success ? WebUtility.HtmlDecode(match.Groups["value"].Value) : null;
        }
    }

    internal sealed class SkaperverkstedRfidServiceAdapter : IServiceAdapter
    {
        private const string SourceRoot = @"C:\Skaperverksted\source";
        private const string ScriptsRoot = @"C:\Skaperverksted\source\scripts";
        private const string HealthScript = "Test-SkaperverkstedHealth.ps1";

        public string Id { get { return "skaperverksted-rfid"; } }
        public string DisplayName { get { return "Skaperverksted RFID"; } }
        public LocalServiceEnvironment Environment { get { return LocalServiceEnvironment.Test; } }
        public string Endpoint { get { return "http://127.0.0.1:8787/"; } }
        public AutoStartPolicy AutoStartPolicy { get { return AutoStartPolicy.ManualOnly; } }

        public async Task<ServiceStatusSnapshot> GetStatusAsync()
        {
            ServiceStatusSnapshot status = NewStatus();
            ProcessResult scriptResult;
            try
            {
                scriptResult = await RunScriptAsync(HealthScript, true, 12000);
            }
            catch (Exception error)
            {
                status.State = LocalServiceState.Error;
                status.Detail = "TEST / LOCAL · status script unavailable";
                status.Components.Add(Component("Runtime", "Unverified", LocalServiceState.Error));
                status.Components.Add(Component("Health", SafeMessage(error.Message), LocalServiceState.Error));
                status.Components.Add(Component("Port", "8787", LocalServiceState.Offline));
                return status;
            }

            RfidHealthResult verified = RfidHealthResult.Parse(scriptResult.Output);
            bool endpointHealthy = false;
            try
            {
                string healthJson = HttpProbe.Get(Endpoint + "health", 1500);
                endpointHealthy = String.Equals(SafeJson.StringValue(healthJson, "status"), "ok", StringComparison.OrdinalIgnoreCase);
            }
            catch
            {
                endpointHealthy = false;
            }

            bool identityHealthy = scriptResult.ExitCode == 0 && verified.Healthy &&
                verified.Port == 8787 && verified.ProcessId.HasValue && verified.ProcessId.Value > 0;
            if (identityHealthy && endpointHealthy)
            {
                status.State = LocalServiceState.Online;
                status.Detail = "TEST / LOCAL · PID " + verified.ProcessId.Value;
                status.Components.Add(Component("Runtime", "Running", LocalServiceState.Online));
                status.Components.Add(Component("Health", "OK", LocalServiceState.Online));
                status.Components.Add(Component("PID", verified.ProcessId.Value.ToString(), LocalServiceState.Online));
                status.Components.Add(Component("Port", "8787", LocalServiceState.Online));
                return status;
            }

            if (!endpointHealthy)
            {
                status.State = LocalServiceState.Offline;
                status.Detail = "TEST / LOCAL · stopped";
                status.Components.Add(Component("Runtime", "Stopped", LocalServiceState.Offline));
                status.Components.Add(Component("Health", "Unavailable", LocalServiceState.Offline));
                status.Components.Add(Component("Port", "8787", LocalServiceState.Offline));
                return status;
            }

            status.State = LocalServiceState.Error;
            status.Detail = "TEST / LOCAL · ownership not verified";
            status.Components.Add(Component("Runtime", "Unverified", LocalServiceState.Error));
            status.Components.Add(Component("Health", "HTTP OK", LocalServiceState.Partial));
            status.Components.Add(Component("Port", "8787", LocalServiceState.Online));
            if (!String.IsNullOrWhiteSpace(verified.Detail))
            {
                status.Components.Add(Component("Check", SafeMessage(verified.Detail), LocalServiceState.Error));
            }
            return status;
        }

        public async Task ExecuteAsync(string action, Action<string> progress)
        {
            string normalized = (action ?? String.Empty).Trim().ToLowerInvariant();
            string scriptName = ScriptNameForAction(normalized);
            if (progress != null)
            {
                progress(Char.ToUpperInvariant(normalized[0]) + normalized.Substring(1) + " Skaperverksted RFID...");
            }

            ProcessResult result = await RunScriptAsync(scriptName, false, normalized == "restart" ? 120000 : 90000);
            if (result.ExitCode != 0)
            {
                string detail = String.IsNullOrWhiteSpace(result.Error) ? result.Output : result.Error;
                throw new InvalidOperationException("Skaperverksted RFID action failed: " + SafeMessage(detail));
            }
        }

        internal static string ScriptNameForAction(string action)
        {
            if (String.Equals(action, "start", StringComparison.OrdinalIgnoreCase)) { return "Start-Skaperverksted.ps1"; }
            if (String.Equals(action, "stop", StringComparison.OrdinalIgnoreCase)) { return "Stop-Skaperverksted.ps1"; }
            if (String.Equals(action, "restart", StringComparison.OrdinalIgnoreCase)) { return "Restart-Skaperverksted.ps1"; }
            throw new ArgumentException("Unknown Skaperverksted RFID action: " + action);
        }

        private static Task<ProcessResult> RunScriptAsync(string scriptName, bool cliXml, int timeoutMilliseconds)
        {
            string scriptPath = Path.GetFullPath(Path.Combine(ScriptsRoot, scriptName));
            string trustedPrefix = Path.GetFullPath(ScriptsRoot).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            if (!scriptPath.StartsWith(trustedPrefix, StringComparison.OrdinalIgnoreCase) || !File.Exists(scriptPath))
            {
                throw new FileNotFoundException("Trusted Skaperverksted RFID script was not found.", scriptPath);
            }

            return Task.Run(delegate
            {
                ProcessStartInfo startInfo = new ProcessStartInfo();
                startInfo.FileName = ResolvePwshExecutable();
                startInfo.Arguments = "-NoLogo -NoProfile -NonInteractive " +
                    (cliXml ? "-OutputFormat XML " : String.Empty) +
                    "-File " + ProcessRunner.QuoteArgument(scriptPath);
                startInfo.WorkingDirectory = SourceRoot;
                startInfo.UseShellExecute = false;
                startInfo.CreateNoWindow = true;
                startInfo.WindowStyle = ProcessWindowStyle.Hidden;
                startInfo.RedirectStandardOutput = true;
                startInfo.RedirectStandardError = true;
                using (Process process = Process.Start(startInfo))
                {
                    string output = process.StandardOutput.ReadToEnd();
                    string error = process.StandardError.ReadToEnd();
                    if (!process.WaitForExit(timeoutMilliseconds))
                    {
                        throw new TimeoutException("Skaperverksted RFID script did not finish within the allowed time.");
                    }
                    return new ProcessResult { ExitCode = process.ExitCode, Output = output, Error = error };
                }
            });
        }

        private static string ResolvePwshExecutable()
        {
            List<string> candidates = new List<string>();
            string programFiles = System.Environment.GetFolderPath(System.Environment.SpecialFolder.ProgramFiles);
            string localAppData = System.Environment.GetFolderPath(System.Environment.SpecialFolder.LocalApplicationData);
            string userProfile = System.Environment.GetFolderPath(System.Environment.SpecialFolder.UserProfile);
            candidates.Add(Path.Combine(programFiles, "PowerShell", "7", "pwsh.exe"));
            candidates.Add(Path.Combine(localAppData, "Microsoft", "WindowsApps", "pwsh.exe"));
            candidates.Add(Path.Combine(userProfile, ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "native", "powershell", "pwsh.exe"));

            string pathValue = System.Environment.GetEnvironmentVariable("PATH") ?? String.Empty;
            foreach (string directory in pathValue.Split(Path.PathSeparator))
            {
                if (!String.IsNullOrWhiteSpace(directory))
                {
                    candidates.Add(Path.Combine(directory.Trim(), "pwsh.exe"));
                }
            }

            foreach (string candidate in candidates)
            {
                try
                {
                    if (File.Exists(candidate))
                    {
                        return Path.GetFullPath(candidate);
                    }
                }
                catch { }
            }
            throw new FileNotFoundException("PowerShell 7 (pwsh.exe) is required for Skaperverksted RFID control.");
        }

        private ServiceStatusSnapshot NewStatus()
        {
            return new ServiceStatusSnapshot
            {
                Id = Id,
                DisplayName = DisplayName,
                Environment = Environment,
                Endpoint = Endpoint,
                AutoStartPolicy = AutoStartPolicy,
                AutoStartEnabled = false,
                CheckedAt = DateTime.Now
            };
        }

        private static string SafeMessage(string value)
        {
            string compact = Regex.Replace(value ?? String.Empty, "[\\r\\n\\t]+", " ").Trim();
            if (String.IsNullOrWhiteSpace(compact))
            {
                return "No diagnostic detail";
            }
            return compact.Length <= 120 ? compact : compact.Substring(0, 117) + "...";
        }

        private static ServiceComponentSnapshot Component(string name, string value, LocalServiceState state)
        {
            return new ServiceComponentSnapshot { Name = name, Status = value, State = state };
        }
    }

    internal sealed class ProjectDashboardServiceAdapter : IServiceAdapter
    {
        private const string DashboardRoot = @"C:ChatGPT AppDashboard";
        private static readonly object CloudflareSync = new object();
        private static DateTime cloudflareCheckedAt = DateTime.MinValue;
        private static bool cloudflareRunning;

        public string Id { get { return "project-dashboard"; } }
        public string DisplayName { get { return "Project Dashboard"; } }
        public LocalServiceEnvironment Environment { get { return LocalServiceEnvironment.Production; } }
        public string Endpoint { get { return "http://127.0.0.1:4317"; } }
        public AutoStartPolicy AutoStartPolicy { get { return AutoStartPolicy.ExternallyManaged; } }

        public Task<ServiceStatusSnapshot> GetStatusAsync()
        {
            return Task.Run(delegate
            {
                ServiceStatusSnapshot status = NewStatus();
                string json;
                try
                {
                    json = HttpProbe.Get(Endpoint + "/health", 1200);
                    bool online = String.Equals(SafeJson.StringValue(json, "status"), "ok", StringComparison.OrdinalIgnoreCase);
                    status.State = online ? LocalServiceState.Online : LocalServiceState.Partial;
                    status.Version = SafeJson.StringValue(json, "version");
                    string build = SafeJson.StringValue(json, "buildId");
                    status.Detail = online ? "Local dashboard ready" : "Health returned a partial state";
                    if (!String.IsNullOrWhiteSpace(build))
                    {
                        status.Detail += " · build " + build;
                    }
                    status.Components.Add(Component("Dashboard", online ? "Online" : "Partial", online ? LocalServiceState.Online : LocalServiceState.Partial));
                    bool sheetFresh = json.IndexOf("\"source\":\"google_sheets\"", StringComparison.OrdinalIgnoreCase) >= 0 &&
                        json.IndexOf("\"status\":\"fresh\"", StringComparison.OrdinalIgnoreCase) >= 0;
                    status.Components.Add(Component("Google Sheet", sheetFresh ? "Fresh" : "Check", sheetFresh ? LocalServiceState.Online : LocalServiceState.Partial));
                }
                catch (Exception error)
                {
                    bool processRunning = RegisteredProcessExists(Path.Combine(DashboardRoot, "run", "dashboard.pid"), "node");
                    status.State = processRunning ? LocalServiceState.Partial : LocalServiceState.Offline;
                    status.Detail = processRunning ? "Process is running, health unavailable" : "Offline";
                    if (processRunning)
                    {
                        status.Components.Add(Component("Dashboard", "Health unavailable", LocalServiceState.Partial));
                    }
                    status.Version = null;
                    if (error is FileNotFoundException)
                    {
                        status.State = LocalServiceState.Error;
                        status.Detail = error.Message;
                    }
                }

                bool tunnel = IsCloudflareRunning();
                status.Components.Add(Component("Cloudflare", tunnel ? "Running" : "Unavailable", tunnel ? LocalServiceState.Online : LocalServiceState.Partial));
                return status;
            });
        }

        public async Task ExecuteAsync(string action, Action<string> progress)
        {
            string normalized = (action ?? String.Empty).Trim().ToLowerInvariant();
            string scriptName;
            if (normalized == "start") { scriptName = "start.ps1"; }
            else if (normalized == "stop") { scriptName = "stop.ps1"; }
            else if (normalized == "restart") { scriptName = "restart.ps1"; }
            else { throw new ArgumentException("Unknown Project Dashboard action: " + action); }

            if (progress != null)
            {
                progress(Char.ToUpperInvariant(normalized[0]) + normalized.Substring(1) + " Project Dashboard...");
            }

            string script = Path.Combine(DashboardRoot, "scripts", scriptName);
            ProcessResult result = await ProcessRunner.RunPowerShellAsync(script, String.Empty, DashboardRoot, false, 60000);
            if (result.ExitCode != 0)
            {
                string detail = String.IsNullOrWhiteSpace(result.Error) ? result.Output : result.Error;
                throw new InvalidOperationException("Project Dashboard action failed: " + detail.Trim());
            }
        }

        private ServiceStatusSnapshot NewStatus()
        {
            return new ServiceStatusSnapshot
            {
                Id = Id,
                DisplayName = DisplayName,
                Environment = Environment,
                Endpoint = Endpoint,
                AutoStartPolicy = AutoStartPolicy,
                AutoStartEnabled = true,
                CheckedAt = DateTime.Now
            };
        }

        private static bool RegisteredProcessExists(string pidPath, string expectedName)
        {
            try
            {
                int processId;
                if (!File.Exists(pidPath) || !Int32.TryParse(File.ReadAllText(pidPath).Trim(), out processId))
                {
                    return false;
                }
                using (Process process = Process.GetProcessById(processId))
                {
                    return String.Equals(process.ProcessName, expectedName, StringComparison.OrdinalIgnoreCase);
                }
            }
            catch
            {
                return false;
            }
        }

        private static bool IsCloudflareRunning()
        {
            lock (CloudflareSync)
            {
                if ((DateTime.UtcNow - cloudflareCheckedAt).TotalSeconds < 15)
                {
                    return cloudflareRunning;
                }

                try
                {
                    string sc = Path.Combine(System.Environment.SystemDirectory, "sc.exe");
                    string output = ProcessRunner.RunCaptureAsync(sc, "query cloudflared", System.Environment.SystemDirectory, 2500).GetAwaiter().GetResult();
                    cloudflareRunning = output.IndexOf("RUNNING", StringComparison.OrdinalIgnoreCase) >= 0;
                }
                catch
                {
                    cloudflareRunning = false;
                }
                cloudflareCheckedAt = DateTime.UtcNow;
                return cloudflareRunning;
            }
        }

        private static ServiceComponentSnapshot Component(string name, string status, LocalServiceState state)
        {
            return new ServiceComponentSnapshot { Name = name, Status = status, State = state };
        }
    }

    internal sealed class KifContractResult
    {
        internal bool Success;
        internal string ServiceId;
        internal string State;
        internal string Message;
        internal string Branch;
        internal string Commit;
        internal string Version;
        internal int? Port;

        internal static KifContractResult Parse(string json)
        {
            return new KifContractResult
            {
                Success = SafeJson.BooleanValue(json, "success", false),
                ServiceId = SafeJson.StringValue(json, "serviceId"),
                State = SafeJson.StringValue(json, "state"),
                Message = SafeJson.StringValue(json, "messageSafe"),
                Branch = SafeJson.StringValue(json, "branch"),
                Commit = SafeJson.StringValue(json, "commit"),
                Version = SafeJson.StringValue(json, "version"),
                Port = SafeJson.IntegerValue(json, "port")
            };
        }
    }

    internal sealed class KifServiceAdapter : IServiceAdapter
    {
        private readonly bool production;
        private readonly string adapterPath;
        private readonly object metadataSync = new object();
        private DateTime metadataCheckedAt = DateTime.MinValue;
        private KifContractResult cachedMetadata;

        internal KifServiceAdapter(bool production, string adapterPath)
        {
            this.production = production;
            this.adapterPath = adapterPath;
        }

        public string Id { get { return production ? "kif-production" : "kif-test"; } }
        public string DisplayName { get { return "KIF Vanskebygger"; } }
        public LocalServiceEnvironment Environment { get { return production ? LocalServiceEnvironment.Production : LocalServiceEnvironment.Test; } }
        public string Endpoint { get { return production ? "http://127.0.0.1:8000" : "http://127.0.0.1:8126"; } }
        public AutoStartPolicy AutoStartPolicy { get { return production ? AutoStartPolicy.ExternallyManaged : AutoStartPolicy.ManualOnly; } }

        public Task<ServiceStatusSnapshot> GetStatusAsync()
        {
            return Task.Run(delegate
            {
                KifContractResult metadata = GetMetadata();
                ServiceStatusSnapshot status = NewStatus();
                status.Version = metadata == null ? null : metadata.Version;
                status.Branch = metadata == null ? null : metadata.Branch;
                try
                {
                    string json = HttpProbe.Get(Endpoint + "/health", 1200);
                    bool appOk = String.Equals(SafeJson.StringValue(json, "app"), "ok", StringComparison.OrdinalIgnoreCase);
                    bool databaseOk = String.Equals(SafeJson.StringValue(json, "database"), "ok", StringComparison.OrdinalIgnoreCase);
                    status.State = appOk && databaseOk ? LocalServiceState.Online : LocalServiceState.Partial;
                    status.Version = SafeJson.StringValue(json, "appVersion") ?? status.Version;
                    string releaseCommit = SafeJson.StringValue(json, "releaseCommit");
                    if (!String.IsNullOrWhiteSpace(releaseCommit))
                    {
                        status.Detail = "Release " + ShortCommit(releaseCommit);
                    }
                    else
                    {
                        status.Detail = production ? "Stable runtime" : "Preview runtime";
                    }
                    status.Components.Add(Component("App", appOk ? "OK" : "Check", appOk ? LocalServiceState.Online : LocalServiceState.Partial));
                    status.Components.Add(Component("Database", databaseOk ? "OK" : "Check", databaseOk ? LocalServiceState.Online : LocalServiceState.Partial));
                }
                catch
                {
                    status.State = LocalServiceState.Offline;
                    status.Detail = production ? "Production health unavailable" : "Ready for manual start";
                }
                return status;
            });
        }

        public async Task ExecuteAsync(string action, Action<string> progress)
        {
            string normalized = (action ?? String.Empty).Trim().ToLowerInvariant();
            if (normalized != "start" && normalized != "stop" && normalized != "restart")
            {
                throw new ArgumentException("Unknown KIF action: " + action);
            }

            string resultPath = Path.Combine(Path.GetTempPath(), "command-center-kif-" + Guid.NewGuid().ToString("N") + ".json");
            string environment = production ? "Production" : "Test";
            string arguments =
                "-Action " + Char.ToUpperInvariant(normalized[0]) + normalized.Substring(1) +
                " -Environment " + environment +
                " -ResultPath " + ProcessRunner.QuoteArgument(resultPath);
            if (progress != null)
            {
                progress(Char.ToUpperInvariant(normalized[0]) + normalized.Substring(1) + " KIF " + (production ? "production" : "test") + "...");
            }

            try
            {
                ProcessResult process = await ProcessRunner.RunPowerShellAsync(
                    adapterPath,
                    arguments,
                    Path.GetDirectoryName(adapterPath),
                    production,
                    production ? 90000 : 75000);

                if (!File.Exists(resultPath))
                {
                    string processDetail = String.IsNullOrWhiteSpace(process.Error) ? process.Output : process.Error;
                    throw new InvalidOperationException("KIF adapter returned no result. " + processDetail.Trim());
                }

                string json = File.ReadAllText(resultPath);
                KifContractResult result = KifContractResult.Parse(json);
                if (!String.Equals(result.ServiceId, Id, StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidOperationException("KIF adapter returned an unexpected service identity.");
                }
                if (process.ExitCode != 0 || !result.Success)
                {
                    throw new InvalidOperationException(String.IsNullOrWhiteSpace(result.Message) ? "KIF action failed." : result.Message);
                }

                lock (metadataSync)
                {
                    cachedMetadata = result;
                    metadataCheckedAt = DateTime.UtcNow;
                }
                if (progress != null)
                {
                    progress(String.IsNullOrWhiteSpace(result.Message) ? "KIF action complete." : result.Message);
                }
            }
            finally
            {
                try
                {
                    if (File.Exists(resultPath))
                    {
                        File.Delete(resultPath);
                    }
                }
                catch { }
            }
        }

        private KifContractResult GetMetadata()
        {
            lock (metadataSync)
            {
                if (cachedMetadata != null && (DateTime.UtcNow - metadataCheckedAt).TotalSeconds < 30)
                {
                    return cachedMetadata;
                }
            }

            string resultPath = Path.Combine(Path.GetTempPath(), "command-center-kif-status-" + Guid.NewGuid().ToString("N") + ".json");
            try
            {
                string arguments = "-Action Status -Environment " + (production ? "Production" : "Test") +
                    " -ResultPath " + ProcessRunner.QuoteArgument(resultPath);
                ProcessResult process = ProcessRunner.RunPowerShellAsync(
                    adapterPath,
                    arguments,
                    Path.GetDirectoryName(adapterPath),
                    false,
                    8000).GetAwaiter().GetResult();
                if (process.ExitCode == 0 && File.Exists(resultPath))
                {
                    KifContractResult parsed = KifContractResult.Parse(File.ReadAllText(resultPath));
                    if (String.Equals(parsed.ServiceId, Id, StringComparison.OrdinalIgnoreCase))
                    {
                        lock (metadataSync)
                        {
                            cachedMetadata = parsed;
                            metadataCheckedAt = DateTime.UtcNow;
                        }
                        return parsed;
                    }
                }
            }
            catch
            {
                // Health remains independently observable if metadata is protected.
            }
            finally
            {
                try
                {
                    if (File.Exists(resultPath))
                    {
                        File.Delete(resultPath);
                    }
                }
                catch { }
            }

            lock (metadataSync)
            {
                metadataCheckedAt = DateTime.UtcNow;
                return cachedMetadata;
            }
        }

        private ServiceStatusSnapshot NewStatus()
        {
            return new ServiceStatusSnapshot
            {
                Id = Id,
                DisplayName = DisplayName,
                Environment = Environment,
                Endpoint = Endpoint,
                AutoStartPolicy = AutoStartPolicy,
                AutoStartEnabled = production,
                CheckedAt = DateTime.Now
            };
        }

        private static string ShortCommit(string value)
        {
            if (String.IsNullOrWhiteSpace(value))
            {
                return null;
            }
            return value.Length <= 10 ? value : value.Substring(0, 10);
        }

        private static ServiceComponentSnapshot Component(string name, string status, LocalServiceState state)
        {
            return new ServiceComponentSnapshot { Name = name, Status = status, State = state };
        }
    }
}
