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
    internal enum LocalServiceState
    {
        Offline,
        Online,
        Starting,
        Stopping,
        Partial,
        Error
    }

    internal enum LocalServiceEnvironment
    {
        Production,
        Test,
        Utility
    }

    internal enum ServiceEnvironmentFilter
    {
        Production,
        Test
    }

    internal static class ServiceEnvironmentFilterPolicy
    {
        internal static bool Matches(ServiceEnvironmentFilter filter, LocalServiceEnvironment environment)
        {
            return filter == ServiceEnvironmentFilter.Production
                ? environment == LocalServiceEnvironment.Production
                : environment != LocalServiceEnvironment.Production;
        }
    }

    internal static class ServiceOpenUrls
    {
        internal const string SkaperverkstedRfid = "http://127.0.0.1:8787/";
        internal const string CommandCenter = "http://127.0.0.1:4337/";
        internal const string ProjectDashboard = "https://dashboard.liverod.app/";
        internal const string KifProduction = "https://kif.liverod.app/";
        internal const string KifTest = "http://127.0.0.1:8126/";
    }

    internal enum AutoStartPolicy
    {
        ControlManaged,
        ExternallyManaged,
        ManualOnly
    }

    internal sealed class ServiceComponentSnapshot
    {
        internal string Name;
        internal string Status;
        internal LocalServiceState State;
    }

    internal sealed class ServiceStatusSnapshot
    {
        internal string Id;
        internal string DisplayName;
        internal LocalServiceEnvironment Environment;
        internal string Endpoint;
        internal string Version;
        internal string Branch;
        internal string Detail;
        internal LocalServiceState State;
        internal AutoStartPolicy AutoStartPolicy;
        internal bool AutoStartEnabled;
        internal DateTime CheckedAt;
        internal readonly List<ServiceComponentSnapshot> Components = new List<ServiceComponentSnapshot>();
    }

    internal sealed class ServiceActionAvailability
    {
        internal bool CanStart;
        internal bool CanStop;
        internal bool CanRestart;

        internal static ServiceActionAvailability ForState(LocalServiceState state)
        {
            ServiceActionAvailability value = new ServiceActionAvailability();
            value.CanStart = state == LocalServiceState.Offline || state == LocalServiceState.Error;
            value.CanStop = state == LocalServiceState.Online || state == LocalServiceState.Partial;
            value.CanRestart = state == LocalServiceState.Online || state == LocalServiceState.Partial || state == LocalServiceState.Error;
            return value;
        }
    }

    internal interface IServiceAdapter
    {
        string Id { get; }
        string DisplayName { get; }
        LocalServiceEnvironment Environment { get; }
        string Endpoint { get; }
        string OpenUrl { get; }
        AutoStartPolicy AutoStartPolicy { get; }
        Task<ServiceStatusSnapshot> GetStatusAsync();
        Task ExecuteAsync(string action, Action<string> progress);
    }

    internal sealed class ProcessResult
    {
        internal int ExitCode;
        internal string Output;
        internal string Error;
    }

    internal static class ProcessRunner
    {
        internal static Task<ProcessResult> RunPowerShellAsync(string scriptPath, string arguments, string workingDirectory, bool elevated, int timeoutMilliseconds)
        {
            if (!File.Exists(scriptPath))
            {
                throw new FileNotFoundException("Trusted service script was not found.", scriptPath);
            }

            string powershell = Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");
            string commandArguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " + QuoteArgument(scriptPath);
            if (!String.IsNullOrWhiteSpace(arguments))
            {
                commandArguments += " " + arguments;
            }

            return Task.Run(delegate
            {
                ProcessStartInfo startInfo = new ProcessStartInfo();
                startInfo.FileName = powershell;
                startInfo.Arguments = commandArguments;
                startInfo.WorkingDirectory = workingDirectory;
                startInfo.WindowStyle = ProcessWindowStyle.Hidden;
                startInfo.UseShellExecute = elevated;
                if (elevated)
                {
                    startInfo.Verb = "runas";
                }
                else
                {
                    startInfo.CreateNoWindow = true;
                    startInfo.RedirectStandardOutput = true;
                    startInfo.RedirectStandardError = true;
                }

                using (Process process = Process.Start(startInfo))
                {
                    string output = String.Empty;
                    string error = String.Empty;
                    if (!elevated)
                    {
                        output = process.StandardOutput.ReadToEnd();
                        error = process.StandardError.ReadToEnd();
                    }

                    if (!process.WaitForExit(timeoutMilliseconds))
                    {
                        throw new TimeoutException("The trusted service action did not finish within the allowed time.");
                    }

                    return new ProcessResult
                    {
                        ExitCode = process.ExitCode,
                        Output = output,
                        Error = error
                    };
                }
            });
        }

        internal static Task<string> RunCaptureAsync(string fileName, string arguments, string workingDirectory, int timeoutMilliseconds)
        {
            return Task.Run(delegate
            {
                ProcessStartInfo startInfo = new ProcessStartInfo();
                startInfo.FileName = fileName;
                startInfo.Arguments = arguments;
                startInfo.WorkingDirectory = workingDirectory;
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
                        throw new TimeoutException("Process status probe timed out.");
                    }
                    if (process.ExitCode != 0 && String.IsNullOrWhiteSpace(output))
                    {
                        throw new InvalidOperationException(String.IsNullOrWhiteSpace(error) ? "Process status probe failed." : error.Trim());
                    }
                    return output.Trim();
                }
            });
        }

        internal static string QuoteArgument(string value)
        {
            return "\"" + (value ?? String.Empty).Replace("\"", "\\\"") + "\"";
        }
    }

    internal static class HttpProbe
    {
        internal static string Get(string url, int timeoutMilliseconds)
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
            request.Method = "GET";
            request.Proxy = null;
            request.Timeout = timeoutMilliseconds;
            request.ReadWriteTimeout = timeoutMilliseconds;
            request.CachePolicy = new System.Net.Cache.RequestCachePolicy(System.Net.Cache.RequestCacheLevel.NoCacheNoStore);
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            using (StreamReader reader = new StreamReader(response.GetResponseStream()))
            {
                if ((int)response.StatusCode < 200 || (int)response.StatusCode >= 300)
                {
                    throw new WebException("Health endpoint returned HTTP " + (int)response.StatusCode + ".");
                }
                return reader.ReadToEnd();
            }
        }
    }

    internal static class SafeJson
    {
        internal static string StringValue(string json, string propertyName)
        {
            if (String.IsNullOrWhiteSpace(json))
            {
                return null;
            }
            Match match = Regex.Match(
                json,
                "\"" + Regex.Escape(propertyName) + "\"\\s*:\\s*\"((?:\\\\.|[^\"])*)\"",
                RegexOptions.CultureInvariant);
            if (!match.Success)
            {
                return null;
            }
            return match.Groups[1].Value
                .Replace("\\\"", "\"")
                .Replace("\\r", "\r")
                .Replace("\\n", "\n")
                .Replace("\\\\", "\\");
        }

        internal static bool BooleanValue(string json, string propertyName, bool fallback)
        {
            Match match = Regex.Match(
                json ?? String.Empty,
                "\"" + Regex.Escape(propertyName) + "\"\\s*:\\s*(true|false)",
                RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
            if (!match.Success)
            {
                return fallback;
            }
            return String.Equals(match.Groups[1].Value, "true", StringComparison.OrdinalIgnoreCase);
        }

        internal static int? IntegerValue(string json, string propertyName)
        {
            Match match = Regex.Match(
                json ?? String.Empty,
                "\"" + Regex.Escape(propertyName) + "\"\\s*:\\s*(-?\\d+)",
                RegexOptions.CultureInvariant);
            int parsed;
            if (!match.Success || !Int32.TryParse(match.Groups[1].Value, out parsed))
            {
                return null;
            }
            return parsed;
        }

        internal static string Escape(string value)
        {
            return (value ?? String.Empty)
                .Replace("\\", "\\\\")
                .Replace("\"", "\\\"")
                .Replace("\r", "\\r")
                .Replace("\n", "\\n");
        }
    }
    internal sealed class ServiceAutoStartStore
    {
        private readonly string path;
        private readonly object sync = new object();

        internal ServiceAutoStartStore(string repositoryRoot)
        {
            string directory = Path.Combine(repositoryRoot, ".runtime", "control");
            Directory.CreateDirectory(directory);
            path = Path.Combine(directory, "service-autostart.json");
        }

        internal bool IsEnabled(string serviceId)
        {
            if (!String.Equals(serviceId, "command-center", StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            lock (sync)
            {
                try
                {
                    if (!File.Exists(path))
                    {
                        return false;
                    }
                    return SafeJson.BooleanValue(File.ReadAllText(path), "command-center", false);
                }
                catch
                {
                    return false;
                }
            }
        }

        internal void SetEnabled(string serviceId, bool enabled)
        {
            if (!String.Equals(serviceId, "command-center", StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("Only Control-managed production services can store an auto-start preference.");
            }

            lock (sync)
            {
                string temporary = path + ".tmp";
                string json = "{\r\n  \"schemaVersion\": 1,\r\n  \"command-center\": " +
                    (enabled ? "true" : "false") + "\r\n}\r\n";
                File.WriteAllText(temporary, json, new UTF8Encoding(false));
                if (File.Exists(path))
                {
                    File.Replace(temporary, path, null);
                }
                else
                {
                    File.Move(temporary, path);
                }
            }
        }
    }
    internal sealed class ControlLog
    {
        private const long MaximumBytes = 512 * 1024;
        private readonly string path;
        private readonly object sync = new object();

        internal ControlLog(string repositoryRoot)
        {
            string directory = Path.Combine(repositoryRoot, ".runtime", "control");
            Directory.CreateDirectory(directory);
            path = Path.Combine(directory, "service-control.log");
        }

        internal void Write(string serviceId, string environment, string action, string result, int? processId)
        {
            lock (sync)
            {
                try
                {
                    if (File.Exists(path) && new FileInfo(path).Length > MaximumBytes)
                    {
                        string previous = path + ".1";
                        if (File.Exists(previous))
                        {
                            File.Delete(previous);
                        }
                        File.Move(path, previous);
                    }

                    string line = DateTimeOffset.Now.ToString("o") +
                        " service=" + Sanitize(serviceId) +
                        " environment=" + Sanitize(environment) +
                        " action=" + Sanitize(action) +
                        " result=" + Sanitize(result) +
                        (processId.HasValue ? " pid=" + processId.Value : String.Empty) +
                        Environment.NewLine;
                    File.AppendAllText(path, line, new UTF8Encoding(false));
                }
                catch
                {
                    // Logging must never make service control unavailable.
                }
            }
        }

        private static string Sanitize(string value)
        {
            return Regex.Replace(value ?? String.Empty, "[\r\n\t=]+", "_");
        }
    }

    internal sealed class KifEnvironmentDefinition
    {
        internal readonly bool IsProduction;
        internal readonly string Root;
        internal readonly int Port;
        internal readonly string PidPath;
        internal readonly string LauncherPath;
        internal readonly string ControlScriptPath;

        internal KifEnvironmentDefinition(bool isProduction, string root, int port, string pidPath, string launcherPath, string controlScriptPath)
        {
            IsProduction = isProduction;
            Root = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar);
            Port = port;
            PidPath = String.IsNullOrWhiteSpace(pidPath) ? null : Path.GetFullPath(pidPath);
            LauncherPath = String.IsNullOrWhiteSpace(launcherPath) ? null : Path.GetFullPath(launcherPath);
            ControlScriptPath = Path.GetFullPath(controlScriptPath);
        }
    }

    internal sealed class KifEnvironmentCatalog
    {
        private const string PreviewDirectoryName = "kif-v3.4-bredde-foundation";
        private const string ProductionRoot = @"C:\ChatGPT App\KIF-Vanskebygger-App";

        internal readonly KifEnvironmentDefinition Production;
        internal readonly KifEnvironmentDefinition Test;

        internal KifEnvironmentCatalog(string repositoryRoot)
        {
            string workspaceRoot = FindWorkspaceRoot(repositoryRoot);
            string previewRoot = Path.Combine(workspaceRoot, "Turn", PreviewDirectoryName);
            string productionAdapter = Path.Combine(previewRoot, "scripts", "command-center-service.ps1");
            string previewControl = Path.Combine(repositoryRoot, "scripts", "command-center-kif-preview.ps1");

            Production = new KifEnvironmentDefinition(true, ProductionRoot, 8000, null, null, productionAdapter);
            Test = new KifEnvironmentDefinition(
                false,
                previewRoot,
                8126,
                Path.Combine(previewRoot, "data", "v3-preview", "runtime", "kif-server.pid"),
                Path.Combine(previewRoot, "start_v3_preview.ps1"),
                previewControl);
        }

        internal void Validate()
        {
            ValidateDefinition(Production);
            ValidateDefinition(Test);
            if (String.Equals(Production.Root, Test.Root, StringComparison.OrdinalIgnoreCase) || Production.Port == Test.Port)
            {
                throw new InvalidOperationException("KIF production and preview definitions must remain isolated.");
            }
        }

        private static void ValidateDefinition(KifEnvironmentDefinition definition)
        {
            if (!Directory.Exists(definition.Root))
            {
                throw new DirectoryNotFoundException("KIF environment root was not found: " + definition.Root);
            }
            if (!File.Exists(definition.ControlScriptPath))
            {
                throw new FileNotFoundException("KIF control script was not found.", definition.ControlScriptPath);
            }
            if (!definition.IsProduction && !File.Exists(definition.LauncherPath))
            {
                throw new FileNotFoundException("KIF preview launcher was not found.", definition.LauncherPath);
            }
        }

        private static string FindWorkspaceRoot(string repositoryRoot)
        {
            DirectoryInfo current = new DirectoryInfo(Path.GetFullPath(repositoryRoot));
            while (current != null)
            {
                string candidate = Path.Combine(current.FullName, "Turn", PreviewDirectoryName);
                if (Directory.Exists(candidate))
                {
                    return current.FullName;
                }
                current = current.Parent;
            }
            throw new DirectoryNotFoundException("The canonical Turn workspace containing " + PreviewDirectoryName + " was not found.");
        }
    }
    internal sealed class ServiceRegistry
    {
        private readonly List<IServiceAdapter> services = new List<IServiceAdapter>();
        private readonly Dictionary<string, IServiceAdapter> byId = new Dictionary<string, IServiceAdapter>(StringComparer.OrdinalIgnoreCase);
        private readonly HashSet<string> inFlight = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        private readonly object operationSync = new object();
        private readonly ServiceAutoStartStore autoStartStore;
        private readonly ControlLog log;

        internal ServiceRegistry(string repositoryRoot, CommandCenterRuntime runtime)
        {
            autoStartStore = new ServiceAutoStartStore(repositoryRoot);
            log = new ControlLog(repositoryRoot);
            KifEnvironmentCatalog kifEnvironments = new KifEnvironmentCatalog(repositoryRoot);
            kifEnvironments.Validate();

            Add(new CommandCenterServiceAdapter(runtime, autoStartStore));
            Add(new ProjectDashboardServiceAdapter());
            Add(new KifServiceAdapter(kifEnvironments.Production));
            Add(new KifServiceAdapter(kifEnvironments.Test));
            Add(new SkaperverkstedRfidServiceAdapter());
        }

        internal IList<IServiceAdapter> Services
        {
            get { return services.AsReadOnly(); }
        }

        internal static bool IsAutoStartCandidate(LocalServiceEnvironment environment, AutoStartPolicy policy, bool configuredEnabled)
        {
            return environment == LocalServiceEnvironment.Production &&
                policy == AutoStartPolicy.ControlManaged &&
                configuredEnabled;
        }

        internal bool IsAutoStartEnabled(string serviceId)
        {
            IServiceAdapter adapter = Get(serviceId);
            return IsAutoStartCandidate(adapter.Environment, adapter.AutoStartPolicy, autoStartStore.IsEnabled(serviceId));
        }

        internal void SetAutoStartEnabled(string serviceId, bool enabled)
        {
            IServiceAdapter adapter = Get(serviceId);
            if (adapter.Environment != LocalServiceEnvironment.Production || adapter.AutoStartPolicy != AutoStartPolicy.ControlManaged)
            {
                throw new InvalidOperationException("This service does not allow Control-managed auto-start.");
            }
            autoStartStore.SetEnabled(serviceId, enabled);
            log.Write(serviceId, adapter.Environment.ToString(), "autostart", enabled ? "enabled" : "disabled", null);
        }

        internal async Task<List<ServiceStatusSnapshot>> RefreshAllAsync()
        {
            List<Task<ServiceStatusSnapshot>> pending = new List<Task<ServiceStatusSnapshot>>();
            foreach (IServiceAdapter adapter in services)
            {
                pending.Add(GetSafeStatusAsync(adapter));
            }
            ServiceStatusSnapshot[] results = await Task.WhenAll(pending.ToArray());
            return new List<ServiceStatusSnapshot>(results);
        }

        internal async Task ExecuteAsync(string serviceId, string action, Action<string> progress)
        {
            IServiceAdapter adapter = Get(serviceId);
            lock (operationSync)
            {
                if (inFlight.Contains(serviceId))
                {
                    throw new InvalidOperationException("An action is already running for " + adapter.DisplayName + ".");
                }
                inFlight.Add(serviceId);
            }

            log.Write(adapter.Id, adapter.Environment.ToString(), action, "started", null);
            try
            {
                await adapter.ExecuteAsync(action, progress);
                log.Write(adapter.Id, adapter.Environment.ToString(), action, "ok", null);
            }
            catch (Exception error)
            {
                log.Write(adapter.Id, adapter.Environment.ToString(), action, "error_" + error.GetType().Name, null);
                throw;
            }
            finally
            {
                lock (operationSync)
                {
                    inFlight.Remove(serviceId);
                }
            }
        }

        internal async Task StartConfiguredServicesAsync(Action<string> progress)
        {
            foreach (IServiceAdapter adapter in services)
            {
                bool configured = autoStartStore.IsEnabled(adapter.Id);
                if (!IsAutoStartCandidate(adapter.Environment, adapter.AutoStartPolicy, configured))
                {
                    continue;
                }

                ServiceStatusSnapshot status = await GetSafeStatusAsync(adapter);
                if (status.State == LocalServiceState.Online)
                {
                    continue;
                }

                try
                {
                    await ExecuteAsync(adapter.Id, "start", progress);
                }
                catch
                {
                    // One service failure must not block later eligible services.
                }
                await Task.Delay(700);
            }
        }

        private void Add(IServiceAdapter adapter)
        {
            if (byId.ContainsKey(adapter.Id))
            {
                throw new InvalidOperationException("Duplicate service id: " + adapter.Id);
            }
            services.Add(adapter);
            byId.Add(adapter.Id, adapter);
        }

        private IServiceAdapter Get(string serviceId)
        {
            IServiceAdapter adapter;
            if (!byId.TryGetValue(serviceId, out adapter))
            {
                throw new ArgumentException("Unknown service id: " + serviceId);
            }
            return adapter;
        }

        private async Task<ServiceStatusSnapshot> GetSafeStatusAsync(IServiceAdapter adapter)
        {
            try
            {
                ServiceStatusSnapshot status = await adapter.GetStatusAsync();
                status.AutoStartEnabled = adapter.AutoStartPolicy == AutoStartPolicy.ControlManaged && autoStartStore.IsEnabled(adapter.Id);
                return status;
            }
            catch (Exception error)
            {
                return new ServiceStatusSnapshot
                {
                    Id = adapter.Id,
                    DisplayName = adapter.DisplayName,
                    Environment = adapter.Environment,
                    Endpoint = adapter.Endpoint,
                    State = LocalServiceState.Error,
                    Detail = error.Message,
                    AutoStartPolicy = adapter.AutoStartPolicy,
                    AutoStartEnabled = false,
                    CheckedAt = DateTime.Now
                };
            }
        }
    }
}
