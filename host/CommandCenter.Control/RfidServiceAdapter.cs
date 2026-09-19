using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace KristianLiverod.CommandCenter.Control
{
    internal sealed class RfidHealthResult
    {
        internal string Status;
        internal string Detail;
        internal string Address;
        internal int? Port;
        internal int? ProcessId;
        internal string ProcessName;
        internal string Executable;
        internal string Ownership;
        internal string ListenerOwnership;
        internal int? ListenerProcessId;
        internal string LaunchMode;

        internal bool Healthy
        {
            get { return String.Equals(Status, "Healthy", StringComparison.OrdinalIgnoreCase); }
        }

        internal bool ManualTestOwnershipVerified
        {
            get
            {
                return Healthy &&
                    String.Equals(Address, "127.0.0.1", StringComparison.OrdinalIgnoreCase) &&
                    Port == 8787 &&
                    ProcessId.HasValue && ProcessId.Value > 0 &&
                    ListenerProcessId == ProcessId &&
                    String.Equals(Ownership, "Verified", StringComparison.OrdinalIgnoreCase) &&
                    String.Equals(ListenerOwnership, "Verified", StringComparison.OrdinalIgnoreCase) &&
                    String.Equals(LaunchMode, "manual-test", StringComparison.OrdinalIgnoreCase) &&
                    !String.IsNullOrWhiteSpace(ProcessName) &&
                    !String.IsNullOrWhiteSpace(Executable);
            }
        }

        internal static RfidHealthResult Parse(string cliXml)
        {
            return new RfidHealthResult
            {
                Status = PropertyValue(cliXml, "Status"),
                Detail = PropertyValue(cliXml, "Detail"),
                Address = PropertyValue(cliXml, "Address"),
                Port = IntegerPropertyValue(cliXml, "Port"),
                ProcessId = IntegerPropertyValue(cliXml, "PID"),
                ProcessName = PropertyValue(cliXml, "Process"),
                Executable = PropertyValue(cliXml, "Executable"),
                Ownership = PropertyValue(cliXml, "Ownership"),
                ListenerOwnership = PropertyValue(cliXml, "ListenerOwnership"),
                ListenerProcessId = IntegerPropertyValue(cliXml, "ListenerPID"),
                LaunchMode = PropertyValue(cliXml, "LaunchMode")
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

    internal static class RfidPowerShellRunner
    {
        private const int OutputDrainMilliseconds = 1000;

        internal static string BuildArguments(string scriptPath, string arguments, bool cliXml)
        {
            string value = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass";
            if (cliXml)
            {
                value += " -OutputFormat XML";
            }
            value += " -File " + ProcessRunner.QuoteArgument(scriptPath);
            if (!String.IsNullOrWhiteSpace(arguments))
            {
                value += " " + arguments;
            }
            return value;
        }

        internal static Task<ProcessResult> RunAsync(string scriptPath, string arguments, string workingDirectory, int timeoutMilliseconds, bool cliXml)
        {
            if (!File.Exists(scriptPath))
            {
                throw new FileNotFoundException("Trusted Skaperverksted RFID script was not found.", scriptPath);
            }

            return Task.Run(delegate
            {
                ProcessStartInfo startInfo = new ProcessStartInfo();
                startInfo.FileName = Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");
                startInfo.Arguments = BuildArguments(scriptPath, arguments, cliXml);
                startInfo.WorkingDirectory = workingDirectory;
                startInfo.UseShellExecute = false;
                startInfo.CreateNoWindow = true;
                startInfo.WindowStyle = ProcessWindowStyle.Hidden;
                startInfo.RedirectStandardOutput = true;
                startInfo.RedirectStandardError = true;

                StringBuilder output = new StringBuilder();
                StringBuilder error = new StringBuilder();
                object captureSync = new object();
                using (ManualResetEvent outputComplete = new ManualResetEvent(false))
                using (ManualResetEvent errorComplete = new ManualResetEvent(false))
                using (Process process = new Process())
                {
                    process.StartInfo = startInfo;
                    DataReceivedEventHandler outputHandler = delegate(object sender, DataReceivedEventArgs eventArgs)
                    {
                        if (eventArgs.Data == null)
                        {
                            outputComplete.Set();
                            return;
                        }
                        lock (captureSync) { output.AppendLine(eventArgs.Data); }
                    };
                    DataReceivedEventHandler errorHandler = delegate(object sender, DataReceivedEventArgs eventArgs)
                    {
                        if (eventArgs.Data == null)
                        {
                            errorComplete.Set();
                            return;
                        }
                        lock (captureSync) { error.AppendLine(eventArgs.Data); }
                    };
                    process.OutputDataReceived += outputHandler;
                    process.ErrorDataReceived += errorHandler;
                    try
                    {
                        if (!process.Start())
                        {
                            throw new InvalidOperationException("Windows PowerShell did not start.");
                        }
                        process.BeginOutputReadLine();
                        process.BeginErrorReadLine();
                        if (!process.WaitForExit(timeoutMilliseconds))
                        {
                            throw new TimeoutException("The trusted RFID action did not finish within the allowed time.");
                        }
                        WaitHandle.WaitAll(new WaitHandle[] { outputComplete, errorComplete }, OutputDrainMilliseconds);
                        lock (captureSync)
                        {
                            return new ProcessResult
                            {
                                ExitCode = process.ExitCode,
                                Output = output.ToString().TrimEnd(),
                                Error = error.ToString().TrimEnd()
                            };
                        }
                    }
                    finally
                    {
                        try { process.CancelOutputRead(); } catch (InvalidOperationException) { }
                        try { process.CancelErrorRead(); } catch (InvalidOperationException) { }
                        process.OutputDataReceived -= outputHandler;
                        process.ErrorDataReceived -= errorHandler;
                    }
                }
            });
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
        public string OpenUrl { get { return ServiceOpenUrls.SkaperverkstedRfid; } }
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

            bool identityHealthy = scriptResult.ExitCode == 0 && verified.ManualTestOwnershipVerified;
            if (identityHealthy && endpointHealthy)
            {
                status.State = LocalServiceState.Online;
                status.Detail = "TEST / LOCAL · verified PID " + verified.ProcessId.Value;
                status.Components.Add(Component("Runtime", "Running · verified", LocalServiceState.Online));
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

            ProcessResult result;
            try
            {
                result = await RunScriptAsync(scriptName, false, normalized == "restart" ? 120000 : 90000);
            }
            catch (Exception error)
            {
                throw new InvalidOperationException(CategorizeActionFailure(error.Message));
            }

            if (result.ExitCode != 0)
            {
                string diagnostic = (result.Error ?? String.Empty) + "\n" + (result.Output ?? String.Empty);
                throw new InvalidOperationException(CategorizeActionFailure(diagnostic));
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

            return RfidPowerShellRunner.RunAsync(scriptPath, "-ManualTest", SourceRoot, timeoutMilliseconds, cliXml);
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

        internal static string CategorizeActionFailure(string value)
        {
            string diagnostic = value ?? String.Empty;
            if (Regex.IsMatch(
                diagnostic,
                @"ManualTest\s+process\s+command\s+line\s+did\s+not\s+match\s+expected\s+runtime\s+contract\b",
                RegexOptions.IgnoreCase | RegexOptions.CultureInvariant) ||
                Regex.IsMatch(
                    diagnostic,
                    @"\bPID\s+\d+\s+command\s+line\s+does\s+not\s+exactly\s+match\s+(?:the\s+)?(?:requested\s+owned|expected\s+Skaperverksted)\s+runtime\b",
                    RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))
            {
                return "ManualTest process command line did not match expected runtime contract.";
            }

            return "ManualTest action failed. Review protected logs.";
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
}
