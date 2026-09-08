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
        private const int RedirectedOutputDrainMilliseconds = 1000;

        private sealed class RedirectedOutputCapture
        {
            private readonly object sync = new object();
            private readonly StringBuilder output = new StringBuilder();
            private readonly StringBuilder error = new StringBuilder();
            private bool outputStarted;
            private bool errorStarted;
            private bool outputEnded;
            private bool errorEnded;
            private bool outputHasLine;
            private bool errorHasLine;
            private bool accepting = true;
            private bool detached;

            internal string Output
            {
                get
                {
                    lock (sync) { return output.ToString(); }
                }
            }

            internal string Error
            {
                get
                {
                    lock (sync) { return error.ToString(); }
                }
            }

            internal void Begin(Process process)
            {
                process.OutputDataReceived += OnOutputDataReceived;
                process.ErrorDataReceived += OnErrorDataReceived;
                try
                {
                    process.BeginOutputReadLine();
                    outputStarted = true;
                    process.BeginErrorReadLine();
                    errorStarted = true;
                }
                catch
                {
                    CancelAndDetach(process);
                    throw;
                }
            }

            internal void DrainAndDetach(Process process, int timeoutMilliseconds)
            {
                Stopwatch stopwatch = Stopwatch.StartNew();
                bool complete;
                lock (sync)
                {
                    while (!outputEnded || !errorEnded)
                    {
                        int remaining = timeoutMilliseconds - (int)stopwatch.ElapsedMilliseconds;
                        if (remaining <= 0)
                        {
                            break;
                        }
                        System.Threading.Monitor.Wait(sync, remaining);
                    }
                    complete = outputEnded && errorEnded;
                    accepting = false;
                }

                if (!complete)
                {
                    // Preserve complete lines already delivered. A fragment held
                    // open by a descendant is not complete output without EOF.
                    CancelReads(process);
                }
                Detach(process);
            }

            internal void CancelAndDetach(Process process)
            {
                lock (sync)
                {
                    if (detached)
                    {
                        return;
                    }
                    accepting = false;
                    System.Threading.Monitor.PulseAll(sync);
                }
                CancelReads(process);
                Detach(process);
            }

            private void OnOutputDataReceived(object sender, DataReceivedEventArgs eventArgs)
            {
                CaptureLine(output, ref outputHasLine, ref outputEnded, eventArgs.Data);
            }

            private void OnErrorDataReceived(object sender, DataReceivedEventArgs eventArgs)
            {
                CaptureLine(error, ref errorHasLine, ref errorEnded, eventArgs.Data);
            }

            private void CaptureLine(StringBuilder target, ref bool hasLine, ref bool ended, string line)
            {
                lock (sync)
                {
                    if (!accepting)
                    {
                        return;
                    }
                    if (line == null)
                    {
                        ended = true;
                    }
                    else
                    {
                        if (hasLine)
                        {
                            target.Append(Environment.NewLine);
                        }
                        target.Append(line);
                        hasLine = true;
                    }
                    System.Threading.Monitor.PulseAll(sync);
                }
            }

            private void CancelReads(Process process)
            {
                if (outputStarted)
                {
                    try { process.CancelOutputRead(); } catch (InvalidOperationException) { }
                }
                if (errorStarted)
                {
                    try { process.CancelErrorRead(); } catch (InvalidOperationException) { }
                }
            }

            private void Detach(Process process)
            {
                lock (sync)
                {
                    if (detached)
                    {
                        return;
                    }
                    detached = true;
                }
                process.OutputDataReceived -= OnOutputDataReceived;
                process.ErrorDataReceived -= OnErrorDataReceived;
            }
        }

        internal static Task<ProcessResult> RunPowerShellAsync(string scriptPath, string arguments, string workingDirectory, bool elevated, int timeoutMilliseconds)
        {
            return RunPowerShellAsync(scriptPath, arguments, workingDirectory, elevated, timeoutMilliseconds, false);
        }

        internal static Task<ProcessResult> RunPowerShellAsync(string scriptPath, string arguments, string workingDirectory, bool elevated, int timeoutMilliseconds, bool cliXml)
        {
            if (!File.Exists(scriptPath))
            {
                throw new FileNotFoundException("Trusted service script was not found.", scriptPath);
            }

            string powershell = Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");
            string commandArguments = BuildPowerShellArguments(scriptPath, arguments, cliXml);

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
                    RedirectedOutputCapture capture = null;
                    try
                    {
                        if (!elevated)
                        {
                            // Drain both redirected streams concurrently so neither
                            // can block the child before the bounded wait below.
                            capture = new RedirectedOutputCapture();
                            capture.Begin(process);
                        }

                        if (!process.WaitForExit(timeoutMilliseconds))
                        {
                            try { process.Kill(); } catch { }
                            try { process.WaitForExit(5000); } catch { }
                            throw new TimeoutException("The trusted service action did not finish within the allowed time.");
                        }
                        int exitCode = process.ExitCode;
                        if (capture != null)
                        {
                            // A launched service can inherit these pipe handles after
                            // the PowerShell parent exits. Bound EOF draining so the
                            // completed action cannot remain in-flight indefinitely.
                            capture.DrainAndDetach(process, RedirectedOutputDrainMilliseconds);
                            output = capture.Output;
                            error = capture.Error;
                        }

                        return new ProcessResult
                        {
                            ExitCode = exitCode,
                            Output = output,
                            Error = error
                        };
                    }
                    finally
                    {
                        if (capture != null)
                        {
                            capture.CancelAndDetach(process);
                        }
                    }
                }
            });
        }

        internal static string BuildPowerShellArguments(string scriptPath, string arguments, bool cliXml)
        {
            string commandArguments = "-NoLogo -NoProfile -NonInteractive " +
                (cliXml ? "-OutputFormat XML " : String.Empty) +
                "-ExecutionPolicy Bypass -File " + QuoteArgument(scriptPath);
            if (!String.IsNullOrWhiteSpace(arguments))
            {
                commandArguments += " " + arguments;
            }
            return commandArguments;
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

    internal sealed class KifAdapterLocator
    {
        private readonly string configurationPath;
        private readonly string allowedTurnRoot;
        private readonly string defaultRoot;

        internal KifAdapterLocator(string repositoryRoot)
        {
            string commandCenterParent = Directory.GetParent(repositoryRoot).FullName;
            allowedTurnRoot = Path.GetFullPath(Path.Combine(commandCenterParent, "Turn")).TrimEnd(Path.DirectorySeparatorChar);
            defaultRoot = Path.Combine(allowedTurnRoot, "kif-v3.4-bredde-foundation");
            string controlDirectory = Path.Combine(repositoryRoot, ".runtime", "control");
            Directory.CreateDirectory(controlDirectory);
            configurationPath = Path.Combine(controlDirectory, "kif-adapter.json");
        }

        internal string Resolve()
        {
            string root = null;
            if (File.Exists(configurationPath))
            {
                root = SafeJson.StringValue(File.ReadAllText(configurationPath), "root");
            }
            if (String.IsNullOrWhiteSpace(root))
            {
                root = defaultRoot;
                string json = "{\r\n  \"schemaVersion\": 1,\r\n  \"root\": \"" + SafeJson.Escape(root) + "\"\r\n}\r\n";
                File.WriteAllText(configurationPath, json, new UTF8Encoding(false));
            }

            string resolvedRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar);
            string allowedPrefix = allowedTurnRoot + Path.DirectorySeparatorChar;
            if (!resolvedRoot.StartsWith(allowedPrefix, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("KIF adapter root is outside the trusted Turn workspace.");
            }

            string adapter = Path.GetFullPath(Path.Combine(resolvedRoot, "scripts", "command-center-service.ps1"));
            string expectedParent = Path.GetFullPath(Path.Combine(resolvedRoot, "scripts")).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            if (!adapter.StartsWith(expectedParent, StringComparison.OrdinalIgnoreCase) ||
                !String.Equals(Path.GetFileName(adapter), "command-center-service.ps1", StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("KIF adapter path did not resolve to the fixed trusted script contract.");
            }
            if (!File.Exists(adapter))
            {
                throw new FileNotFoundException("Trusted KIF adapter is missing.", adapter);
            }
            return adapter;
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
            KifAdapterLocator locator = new KifAdapterLocator(repositoryRoot);
            string kifAdapter = locator.Resolve();

            Add(new CommandCenterServiceAdapter(runtime, autoStartStore));
            Add(new ProjectDashboardServiceAdapter());
            Add(new KifServiceAdapter(true, kifAdapter));
            Add(new KifServiceAdapter(false, kifAdapter));
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
