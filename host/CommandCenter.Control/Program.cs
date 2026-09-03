using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;

namespace KristianLiverod.CommandCenter.Control
{
    internal static class Program
    {
        private const string InstanceMutexName = "Local\\KristianLiverod.CommandCenter.Control";
        private const string ShowEventName = "Local\\KristianLiverod.CommandCenter.Control.Show";

        [STAThread]
        private static void Main(string[] args)
        {
            CommandCenterRuntime runtime = new CommandCenterRuntime(FindRepositoryRoot());
            string action = GetArgument(args, "--action");
            string resultFile = GetArgument(args, "--result-file");

            if (!String.IsNullOrWhiteSpace(action))
            {
                RunCommand(runtime, action, resultFile);
                return;
            }

            bool createdNew;
            using (Mutex instanceMutex = new Mutex(true, InstanceMutexName, out createdNew))
            {
                if (!createdNew)
                {
                    SignalExistingControl();
                    return;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                runtime.WriteControlPid(Process.GetCurrentProcess().Id);
                try
                {
                    Application.Run(new ServiceControlForm(runtime, FindRepositoryRoot(), HasArgument(args, "--tray")));
                }
                finally
                {
                    runtime.ClearControlPid(Process.GetCurrentProcess().Id);
                    instanceMutex.ReleaseMutex();
                }
            }
        }

        private static void SignalExistingControl()
        {
            try
            {
                using (EventWaitHandle signal = EventWaitHandle.OpenExisting(ShowEventName))
                {
                    signal.Set();
                }
            }
            catch (WaitHandleCannotBeOpenedException) { }
        }

        private static void RunCommand(CommandCenterRuntime runtime, string action, string resultFile)
        {
            bool success = true;
            string message = "Ready";
            try
            {
                runtime.ExecuteActionAsync(action, delegate(string value) { message = value; }).GetAwaiter().GetResult();
            }
            catch (Exception error)
            {
                success = false;
                message = error.Message;
                Environment.ExitCode = 1;
            }

            if (!String.IsNullOrWhiteSpace(resultFile))
            {
                RuntimeSnapshot snapshot = runtime.GetSnapshot();
                string directory = Path.GetDirectoryName(Path.GetFullPath(resultFile));
                if (!String.IsNullOrEmpty(directory))
                {
                    Directory.CreateDirectory(directory);
                }
                File.WriteAllText(resultFile, BuildResultJson(success, action, message, snapshot), Encoding.UTF8);
            }
        }

        private static string BuildResultJson(bool success, string action, string message, RuntimeSnapshot snapshot)
        {
            return "{" +
                "\"success\":" + (success ? "true" : "false") + "," +
                "\"action\":\"" + JsonEscape(action) + "\"," +
                "\"message\":\"" + JsonEscape(message) + "\"," +
                "\"serverOnline\":" + (snapshot.ServerOnline ? "true" : "false") + "," +
                "\"serverProcessRunning\":" + (snapshot.ServerProcessRunning ? "true" : "false") + "," +
                "\"serverPid\":" + (snapshot.ServerPid.HasValue ? snapshot.ServerPid.Value.ToString() : "null") + "," +
                "\"hostRunning\":" + (snapshot.HostRunning ? "true" : "false") + "," +
                "\"hostPid\":" + (snapshot.HostPid.HasValue ? snapshot.HostPid.Value.ToString() : "null") +
                "}";
        }

        private static string JsonEscape(string value)
        {
            return (value ?? String.Empty).Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n");
        }

        private static string FindRepositoryRoot()
        {
            DirectoryInfo current = new DirectoryInfo(AppDomain.CurrentDomain.BaseDirectory);
            for (int depth = 0; current != null && depth < 8; depth++, current = current.Parent)
            {
                if (File.Exists(Path.Combine(current.FullName, "scripts", "start-host.ps1")))
                {
                    return current.FullName;
                }
            }
            throw new InvalidOperationException("Command Center repository root was not found.");
        }

        private static bool HasArgument(string[] args, string name)
        {
            foreach (string argument in args)
            {
                if (String.Equals(argument, name, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }
            return false;
        }

        private static string GetArgument(string[] args, string name)
        {
            for (int index = 0; index < args.Length - 1; index++)
            {
                if (String.Equals(args[index], name, StringComparison.OrdinalIgnoreCase))
                {
                    return args[index + 1];
                }
            }
            return null;
        }
    }

    internal sealed class RuntimeSnapshot
    {
        internal int? ServerPid;
        internal int? HostPid;
        internal bool ServerOnline;
        internal bool ServerProcessRunning;
        internal bool HostRunning;
        internal bool SpotifyHealthy;
        internal bool SpotifyActivationRequired;
    }

    internal sealed class SpotifyBridgeStatus
    {
        internal bool Known;
        internal bool Healthy;
        internal bool ActivationKnown;
        internal bool ActivationRequired;
        internal bool AudioActivated;
        internal bool IsPlaying;
        internal string DeviceId;
    }

    internal sealed class CommandCenterRuntime
    {
        private const int ServerPort = 4337;
        private const uint WmClose = 0x0010;
        private const string AutoStartValueName = "Kristian Liverod Command Center Control";
        private readonly string root;
        private readonly string runtimeDirectory;
        private bool? lastSpotifyActivationRequired;
        private string spotifyAudioCandidateDeviceId;
        private DateTime spotifyAudioCandidateSince;
        private string spotifyAudioVerifiedDeviceId;

        private delegate bool EnumWindowsCallback(IntPtr windowHandle, IntPtr parameter);

        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr parameter);

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr windowHandle, out uint processId);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool PostMessage(IntPtr windowHandle, uint message, IntPtr wParam, IntPtr lParam);

        internal CommandCenterRuntime(string root)
        {
            this.root = root;
            runtimeDirectory = Path.Combine(root, ".runtime");
            Directory.CreateDirectory(runtimeDirectory);
        }

        internal RuntimeSnapshot GetSnapshot()
        {
            int? serverPid = GetOwnedPid("server", "node");
            int? hostPid = GetOwnedPid("host", "CommandCenter.Host");
            SpotifyBridgeStatus spotify = GetSpotifyBridgeStatus();
            return new RuntimeSnapshot
            {
                ServerPid = serverPid,
                HostPid = hostPid,
                ServerProcessRunning = serverPid.HasValue,
                ServerOnline = serverPid.HasValue && IsPortOpen(ServerPort),
                HostRunning = hostPid.HasValue,
                SpotifyHealthy = spotify.Healthy,
                SpotifyActivationRequired = spotify.ActivationRequired,
            };
        }

        internal async Task<string> ToggleAudioOutputAsync()
        {
            string output = await RunPowerShellCaptureAsync(Path.Combine(root, "scripts", "audio-output.ps1"), "-Action Toggle");
            Match name = Regex.Match(output, "\"defaultName\"\\s*:\\s*\"([^\"]+)\"", RegexOptions.CultureInvariant);
            return name.Success ? "Audio output: " + name.Groups[1].Value : "Audio output switched.";
        }

        internal async Task ExecuteActionAsync(string action, Action<string> progress)
        {
            string normalized = (action ?? String.Empty).Trim().ToLowerInvariant();
            if (normalized == "status")
            {
                return;
            }

            using (FileStream operationLock = AcquireOperationLock())
            {
                if (normalized == "start")
                {
                    await StartAsync(progress);
                }
                else if (normalized == "stop")
                {
                    await StopAsync(progress);
                }
                else if (normalized == "restart")
                {
                    SpotifyBridgeStatus spotify = GetSpotifyBridgeStatus();
                    bool preserveSpotify = spotify.Healthy || !spotify.Known;
                    Report(progress, preserveSpotify
                        ? "Restarting Command Center while Spotify audio keeps playing..."
                        : "Restarting Command Center and recovering Spotify audio engine...");
                    await StopAsync(progress, preserveSpotify);
                    await StartAsync(progress);
                }
                else
                {
                    throw new ArgumentException("Unknown action: " + action);
                }
            }
        }

        internal bool IsStartWithWindowsEnabled()
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Run", false))
            {
                return key != null && key.GetValue(AutoStartValueName) != null;
            }
        }

        internal void SetStartWithWindows(bool enabled)
        {
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Run"))
            {
                if (enabled)
                {
                    string executable = Process.GetCurrentProcess().MainModule.FileName;
                    key.SetValue(AutoStartValueName, "\"" + executable + "\" --tray", RegistryValueKind.String);
                }
                else
                {
                    key.DeleteValue(AutoStartValueName, false);
                }
            }
        }

        internal void WriteControlPid(int processId)
        {
            File.WriteAllText(Path.Combine(runtimeDirectory, "control.pid"), processId.ToString());
        }

        internal void ClearControlPid(int processId)
        {
            string path = Path.Combine(runtimeDirectory, "control.pid");
            int recorded;
            if (File.Exists(path) && Int32.TryParse(File.ReadAllText(path).Trim(), out recorded) && recorded == processId)
            {
                File.Delete(path);
            }
        }

        private async Task StartAsync(Action<string> progress)
        {
            RuntimeSnapshot current = GetSnapshot();
            if (current.ServerOnline && current.HostRunning)
            {
                Report(progress, "Command Center is already running.");
                return;
            }

            if ((current.ServerProcessRunning && !current.ServerOnline) || (current.HostRunning && !current.ServerOnline))
            {
                Report(progress, "Cleaning up a partial runtime...");
                await StopAsync(progress);
            }

            Report(progress, "Starting server and Xeneon host...");
            await RunPowerShellAsync(Path.Combine(root, "scripts", "start-host.ps1"));
            bool started = await WaitForAsync(delegate(RuntimeSnapshot value) { return value.ServerOnline && value.HostRunning; }, 12000);
            if (!started)
            {
                throw new InvalidOperationException("Command Center did not become ready in time.");
            }
            Report(progress, "Command Center is running.");
        }

        private async Task StopAsync(Action<string> progress, bool preserveSpotifyEdge = false)
        {
            RuntimeSnapshot current = GetSnapshot();
            if (!current.ServerProcessRunning && !current.HostRunning)
            {
                Report(progress, "Command Center is already stopped.");
                await RunPowerShellAsync(Path.Combine(root, "scripts", "stop.ps1"), preserveSpotifyEdge ? "-PreserveSpotifyEdge" : null);
                return;
            }

            Report(progress, "Stopping Xeneon host...");
            await CloseOwnedHostAsync(current.HostPid);
            Report(progress, "Stopping Command Center server...");
            await RunPowerShellAsync(Path.Combine(root, "scripts", "stop.ps1"), preserveSpotifyEdge ? "-PreserveSpotifyEdge" : null);
            bool stopped = await WaitForAsync(delegate(RuntimeSnapshot value) { return !value.ServerProcessRunning && !value.HostRunning; }, 10000);
            if (!stopped)
            {
                throw new InvalidOperationException("Command Center did not stop cleanly in time.");
            }
            Report(progress, "Command Center is stopped.");
        }

        private async Task CloseOwnedHostAsync(int? hostPid)
        {
            if (!hostPid.HasValue)
            {
                return;
            }

            int exactPid = hostPid.Value;
            bool requested = TrySignalOwnedHost(exactPid);
            EnumWindowsCallback callback = delegate(IntPtr windowHandle, IntPtr parameter)
            {
                uint windowPid;
                GetWindowThreadProcessId(windowHandle, out windowPid);
                if (windowPid == (uint)exactPid && PostMessage(windowHandle, WmClose, IntPtr.Zero, IntPtr.Zero))
                {
                    requested = true;
                }
                return true;
            };
            if (!requested)
            {
                EnumWindows(callback, IntPtr.Zero);
            }

            if (requested && await WaitForAsync(delegate(RuntimeSnapshot value) { return !value.HostRunning; }, 5000))
            {
                return;
            }

            await TerminateExactOwnedHostAsync(exactPid);
            bool closed = await WaitForAsync(delegate(RuntimeSnapshot value) { return !value.HostRunning; }, 5000);
            if (!closed)
            {
                throw new InvalidOperationException("The registered Xeneon host did not close in time.");
            }
        }

        private bool TrySignalOwnedHost(int exactPid)
        {
            int? confirmedPid = GetOwnedPid("host", "CommandCenter.Host");
            if (!confirmedPid.HasValue || confirmedPid.Value != exactPid)
            {
                return false;
            }
            try
            {
                using (EventWaitHandle signal = EventWaitHandle.OpenExisting("Local\\KristianLiverod.CommandCenter.Host.Stop." + exactPid))
                {
                    return signal.Set();
                }
            }
            catch (WaitHandleCannotBeOpenedException)
            {
                return false;
            }
        }

        private async Task TerminateExactOwnedHostAsync(int exactPid)
        {
            int? confirmedPid = GetOwnedPid("host", "CommandCenter.Host");
            if (!confirmedPid.HasValue || confirmedPid.Value != exactPid)
            {
                throw new InvalidOperationException("The registered Xeneon host identity changed during stop.");
            }

            ProcessStartInfo startInfo = new ProcessStartInfo
            {
                FileName = Path.Combine(Environment.SystemDirectory, "taskkill.exe"),
                Arguments = "/PID " + exactPid + " /T /F",
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            using (Process process = Process.Start(startInfo))
            {
                Task<string> standardOutput = process.StandardOutput.ReadToEndAsync();
                Task<string> standardError = process.StandardError.ReadToEndAsync();
                await Task.Run(delegate { process.WaitForExit(); });
                string output = await standardOutput;
                string error = await standardError;
                if (process.ExitCode != 0)
                {
                    string detail = String.IsNullOrWhiteSpace(error) ? output : error;
                    throw new InvalidOperationException("The exact registered Xeneon host could not be stopped: " + detail.Trim());
                }
            }
        }

        internal async Task SynchronizeSpotifyActivationWindowAsync()
        {
            SpotifyBridgeStatus status = GetSpotifyBridgeStatus();
            if (!status.Known || !status.ActivationKnown)
            {
                lastSpotifyActivationRequired = null;
                return;
            }

            if (!status.ActivationRequired && await SpotifyAudioActivationIsRequiredAsync(status))
            {
                await RequestSpotifyActivationAsync();
                status.ActivationRequired = true;
            }

            if (lastSpotifyActivationRequired.HasValue && lastSpotifyActivationRequired.Value == status.ActivationRequired)
            {
                return;
            }

            string arguments = status.ActivationRequired
                ? "-Mode Shown -TargetXeneon -ActivationFlow"
                : "-Mode Hidden -ActivationFlow";
            await RunPowerShellAsync(Path.Combine(root, "scripts", "set-spotify-edge-window.ps1"), arguments);
            lastSpotifyActivationRequired = status.ActivationRequired;
        }

        private SpotifyBridgeStatus GetSpotifyBridgeStatus()
        {
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:4337/api/spotify/bridge/status");
                request.Method = "GET";
                request.Proxy = null;
                request.Timeout = 700;
                request.ReadWriteTimeout = 700;
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                using (StreamReader reader = new StreamReader(response.GetResponseStream()))
                {
                    string json = reader.ReadToEnd();
                    bool available = JsonBooleanIsTrue(json, "available");
                    bool edgeReady = JsonBooleanIsTrue(json, "edgeReady");
                    bool deviceReady = JsonBooleanIsTrue(json, "ready");
                    bool activationKnown = Regex.IsMatch(json, "\\\"activationRequired\\\"\\s*:", RegexOptions.CultureInvariant);
                    bool activationRequired = JsonBooleanIsTrue(json, "activationRequired");
                    bool audioActivated = JsonBooleanIsTrue(json, "audioActivated");
                    Match device = Regex.Match(json, "\\\"device\\\"\\s*:\\s*\\{[^}]*\\\"id\\\"\\s*:\\s*\\\"([^\\\"]*)\\\"", RegexOptions.CultureInvariant);
                    return new SpotifyBridgeStatus
                    {
                        Known = true,
                        ActivationKnown = activationKnown,
                        ActivationRequired = activationRequired,
                        AudioActivated = audioActivated,
                        IsPlaying = JsonBooleanIsTrue(json, "isPlaying"),
                        DeviceId = device.Success ? device.Groups[1].Value : String.Empty,
                        Healthy = available && edgeReady && deviceReady && !activationRequired,
                    };
                }
            }
            catch (WebException) { }
            catch (IOException) { }
            return new SpotifyBridgeStatus();
        }

        private async Task<bool> SpotifyAudioActivationIsRequiredAsync(SpotifyBridgeStatus status)
        {
            if (String.IsNullOrWhiteSpace(status.DeviceId))
            {
                spotifyAudioCandidateDeviceId = null;
                return false;
            }
            if (status.AudioActivated)
            {
                spotifyAudioCandidateDeviceId = null;
                spotifyAudioVerifiedDeviceId = status.DeviceId;
                return false;
            }
            if (String.Equals(spotifyAudioVerifiedDeviceId, status.DeviceId, StringComparison.Ordinal))
            {
                return false;
            }
            if (!String.Equals(spotifyAudioCandidateDeviceId, status.DeviceId, StringComparison.Ordinal))
            {
                spotifyAudioCandidateDeviceId = status.DeviceId;
                spotifyAudioCandidateSince = DateTime.UtcNow;
                return false;
            }
            if ((DateTime.UtcNow - spotifyAudioCandidateSince).TotalMilliseconds < 1800)
            {
                return false;
            }

            string output = await RunPowerShellCaptureAsync(Path.Combine(root, "scripts", "test-spotify-edge-audio.ps1"));
            bool active = JsonBooleanIsTrue(output, "active");
            spotifyAudioCandidateDeviceId = null;
            if (active)
            {
                spotifyAudioVerifiedDeviceId = status.DeviceId;
                return false;
            }
            return true;
        }

        private async Task RequestSpotifyActivationAsync()
        {
            await Task.Run(delegate
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:4337/api/spotify/bridge/activation");
                request.Method = "POST";
                request.Proxy = null;
                request.Timeout = 1500;
                request.ReadWriteTimeout = 1500;
                request.ContentType = "application/json";
                request.Headers["Origin"] = "http://127.0.0.1:4337";
                byte[] body = Encoding.UTF8.GetBytes("{\"required\":true,\"message\":\"Windows audio session mangler etter kaldstart\"}");
                request.ContentLength = body.Length;
                using (Stream stream = request.GetRequestStream()) { stream.Write(body, 0, body.Length); }
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse()) { }
            });
        }

        private static bool JsonBooleanIsTrue(string json, string property)
        {
            return Regex.IsMatch(json, "\\\"" + Regex.Escape(property) + "\\\"\\s*:\\s*true", RegexOptions.CultureInvariant);
        }

        private async Task RunPowerShellAsync(string script, string arguments = null)
        {
            string powershell = Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");
            ProcessStartInfo startInfo = new ProcessStartInfo
            {
                FileName = powershell,
                Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + script.Replace("\"", "\"\"") + "\"" +
                    (String.IsNullOrWhiteSpace(arguments) ? String.Empty : " " + arguments),
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
            };

            using (Process process = new Process())
            {
                process.StartInfo = startInfo;
                process.Start();
                await Task.Run(delegate { process.WaitForExit(); });
                if (process.ExitCode != 0)
                {
                    throw new InvalidOperationException("Command failed with exit code " + process.ExitCode + ".");
                }
            }
        }

        private async Task<string> RunPowerShellCaptureAsync(string script, string scriptArguments = null)
        {
            string powershell = Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");
            ProcessStartInfo startInfo = new ProcessStartInfo
            {
                FileName = powershell,
                Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + script.Replace("\"", "\"\"") + "\"" + (String.IsNullOrWhiteSpace(scriptArguments) ? String.Empty : " " + scriptArguments),
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            using (Process process = Process.Start(startInfo))
            {
                Task<string> standardOutput = process.StandardOutput.ReadToEndAsync();
                Task<string> standardError = process.StandardError.ReadToEndAsync();
                await Task.Run(delegate { process.WaitForExit(); });
                string output = await standardOutput;
                string error = await standardError;
                if (process.ExitCode != 0)
                {
                    throw new InvalidOperationException("Spotify audio-session probe failed: " + error.Trim());
                }
                return output;
            }
        }

        private async Task<bool> WaitForAsync(Func<RuntimeSnapshot, bool> predicate, int timeoutMilliseconds)
        {
            Stopwatch stopwatch = Stopwatch.StartNew();
            while (stopwatch.ElapsedMilliseconds < timeoutMilliseconds)
            {
                if (predicate(GetSnapshot()))
                {
                    return true;
                }
                await Task.Delay(200);
            }
            return predicate(GetSnapshot());
        }

        private FileStream AcquireOperationLock()
        {
            try
            {
                return new FileStream(Path.Combine(runtimeDirectory, "control-operation.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None, 1, FileOptions.DeleteOnClose);
            }
            catch (IOException)
            {
                throw new InvalidOperationException("Another Command Center operation is already running.");
            }
        }

        private int? GetOwnedPid(string pidName, string expectedProcessName)
        {
            string path = Path.Combine(runtimeDirectory, pidName + ".pid");
            int processId;
            if (!File.Exists(path) || !Int32.TryParse(File.ReadAllText(path).Trim(), out processId))
            {
                return null;
            }

            try
            {
                using (Process process = Process.GetProcessById(processId))
                {
                    if (String.Equals(process.ProcessName, expectedProcessName, StringComparison.OrdinalIgnoreCase))
                    {
                        return processId;
                    }
                }
            }
            catch (ArgumentException) { }
            catch (InvalidOperationException) { }
            return null;
        }

        private static bool IsPortOpen(int port)
        {
            try
            {
                using (TcpClient client = new TcpClient())
                {
                    IAsyncResult connection = client.BeginConnect("127.0.0.1", port, null, null);
                    try
                    {
                        if (!connection.AsyncWaitHandle.WaitOne(150))
                        {
                            return false;
                        }
                        client.EndConnect(connection);
                        return true;
                    }
                    finally
                    {
                        connection.AsyncWaitHandle.Close();
                    }
                }
            }
            catch
            {
                return false;
            }
        }

        private static void Report(Action<string> progress, string message)
        {
            if (progress != null)
            {
                progress(message);
            }
        }
    }

    internal sealed class ControlForm : Form
    {
        private const int WmHotkey = 0x0312;
        private const int AudioHotkeyId = 0x4B4C;
        private const uint ModAlt = 0x0001;
        private const uint ModControl = 0x0002;
        private const uint ModNoRepeat = 0x4000;

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool RegisterHotKey(IntPtr windowHandle, int id, uint modifiers, uint virtualKey);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool UnregisterHotKey(IntPtr windowHandle, int id);

        private static readonly Color BackgroundColor = Color.FromArgb(6, 16, 27);
        private static readonly Color CardColor = Color.FromArgb(13, 31, 47);
        private static readonly Color CyanColor = Color.FromArgb(69, 192, 208);
        private static readonly Color GreenColor = Color.FromArgb(112, 214, 163);
        private static readonly Color GoldColor = Color.FromArgb(243, 201, 105);
        private static readonly Color DangerColor = Color.FromArgb(255, 125, 114);
        private static readonly Color TextColor = Color.FromArgb(235, 244, 248);
        private static readonly Color MutedColor = Color.FromArgb(143, 165, 181);

        private readonly CommandCenterRuntime runtime;
        private readonly NotifyIcon trayIcon;
        private readonly Label overallDot;
        private readonly Label overallStatus;
        private readonly Label serverDot;
        private readonly Label serverStatus;
        private readonly Label hostDot;
        private readonly Label hostStatus;
        private readonly Label spotifyDot;
        private readonly Label spotifyStatus;
        private readonly Label activityStatus;
        private readonly Button startButton;
        private readonly Button stopButton;
        private readonly Button restartButton;
        private readonly Button openXeneonButton;
        private readonly CheckBox startWithWindows;
        private readonly System.Windows.Forms.Timer refreshTimer;
        private readonly EventWaitHandle showSignal;
        private readonly RegisteredWaitHandle showRegistration;
        private bool allowExit;
        private bool busy;
        private bool initializingAutoStart;
        private bool spotifyActivationSyncBusy;
        private bool audioHotkeyRegistered;

        internal ControlForm(CommandCenterRuntime runtime, bool startHidden)
        {
            this.runtime = runtime;
            showSignal = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\KristianLiverod.CommandCenter.Control.Show");
            showRegistration = ThreadPool.RegisterWaitForSingleObject(showSignal, delegate
            {
                if (!IsDisposed && IsHandleCreated)
                {
                    BeginInvoke(new Action(RestoreWindow));
                }
            }, null, Timeout.Infinite, false);
            Text = "Command Center Control";
            ClientSize = new Size(520, 482);
            MinimumSize = MaximumSize = new Size(536, 521);
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            BackColor = BackgroundColor;
            ForeColor = TextColor;
            Font = new Font("Segoe UI", 9F);
            Icon applicationIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? SystemIcons.Application;
            Icon = applicationIcon;

            Controls.Add(MakeLabel("KRISTIAN LIVEROD", 30, 22, 320, 18, MutedColor, 9F, FontStyle.Bold));
            Controls.Add(MakeLabel("COMMAND CENTER", 30, 43, 360, 38, TextColor, 25F, FontStyle.Bold));
            Controls.Add(MakeLabel("LOCAL CONTROL", 32, 80, 220, 18, CyanColor, 9F, FontStyle.Bold));

            Panel card = new BorderPanel { Location = new Point(30, 111), Size = new Size(460, 160), BackColor = CardColor };
            overallDot = MakeLabel("\u25CF", 18, 14, 22, 25, GreenColor, 15F, FontStyle.Regular);
            overallStatus = MakeLabel("Checking...", 45, 15, 380, 24, TextColor, 14F, FontStyle.Bold);
            card.Controls.Add(overallDot);
            card.Controls.Add(overallStatus);
            card.Controls.Add(MakeLabel("Server", 20, 56, 160, 22, MutedColor, 10F, FontStyle.Regular));
            serverDot = MakeLabel("\u25CF", 272, 55, 18, 22, MutedColor, 10F, FontStyle.Regular);
            serverStatus = MakeLabel("Checking", 294, 56, 138, 22, TextColor, 10F, FontStyle.Bold);
            card.Controls.Add(serverDot);
            card.Controls.Add(serverStatus);
            card.Controls.Add(MakeLabel("Xeneon Host", 20, 88, 160, 22, MutedColor, 10F, FontStyle.Regular));
            hostDot = MakeLabel("\u25CF", 272, 87, 18, 22, MutedColor, 10F, FontStyle.Regular);
            hostStatus = MakeLabel("Checking", 294, 88, 138, 22, TextColor, 10F, FontStyle.Bold);
            card.Controls.Add(hostDot);
            card.Controls.Add(hostStatus);
            card.Controls.Add(MakeLabel("Spotify Engine", 20, 120, 160, 22, MutedColor, 10F, FontStyle.Regular));
            spotifyDot = MakeLabel("\u25CF", 272, 119, 18, 22, MutedColor, 10F, FontStyle.Regular);
            spotifyStatus = MakeLabel("Checking", 294, 120, 138, 22, TextColor, 10F, FontStyle.Bold);
            card.Controls.Add(spotifyDot);
            card.Controls.Add(spotifyStatus);
            Controls.Add(card);

            startButton = MakeButton("Start", 30, 290, 142, CyanColor, BackgroundColor);
            stopButton = MakeButton("Stop", 189, 290, 142, DangerColor, TextColor);
            restartButton = MakeButton("Restart", 348, 290, 142, GoldColor, BackgroundColor);
            startButton.Tag = "start";
            stopButton.Tag = "stop";
            restartButton.Tag = "restart";
            startButton.Click += OnActionClick;
            stopButton.Click += OnActionClick;
            restartButton.Click += OnActionClick;
            Controls.Add(startButton);
            Controls.Add(stopButton);
            Controls.Add(restartButton);

            openXeneonButton = MakeButton("Open on Xeneon", 30, 353, 220, CyanColor, BackgroundColor);
            openXeneonButton.Tag = "start";
            openXeneonButton.Click += OnActionClick;
            Controls.Add(openXeneonButton);

            startWithWindows = new CheckBox { AutoSize = true, Location = new Point(285, 368), Text = "Start with Windows", ForeColor = MutedColor, BackColor = BackgroundColor, FlatStyle = FlatStyle.Flat };
            startWithWindows.CheckedChanged += OnStartWithWindowsChanged;
            Controls.Add(startWithWindows);

            activityStatus = MakeLabel("Ready · Audio: Ctrl + Alt + F10", 30, 431, 460, 28, MutedColor, 9F, FontStyle.Regular);
            activityStatus.TextAlign = ContentAlignment.MiddleLeft;
            Controls.Add(activityStatus);

            ContextMenuStrip trayMenu = new ContextMenuStrip();
            trayMenu.Items.Add("Open Control", null, delegate { RestoreWindow(); });
            trayMenu.Items.Add(new ToolStripSeparator());
            trayMenu.Items.Add("Start", null, async delegate { await RunActionAsync("start"); });
            trayMenu.Items.Add("Stop", null, async delegate { await RunActionAsync("stop"); });
            trayMenu.Items.Add("Restart", null, async delegate { await RunActionAsync("restart"); });
            trayMenu.Items.Add(new ToolStripSeparator());
            trayMenu.Items.Add("Exit", null, delegate { ExitController(); });
            trayIcon = new NotifyIcon { Icon = applicationIcon, Text = "Command Center Control", ContextMenuStrip = trayMenu, Visible = true };
            trayIcon.DoubleClick += delegate { RestoreWindow(); };

            refreshTimer = new System.Windows.Forms.Timer { Interval = 2000 };
            refreshTimer.Tick += async delegate
            {
                RefreshStatus();
                await RefreshSpotifyActivationAsync();
            };
            refreshTimer.Start();

            FormClosing += OnFormClosing;
            Shown += async delegate
            {
                RefreshAutoStart();
                RefreshStatus();
                if (startHidden) { HideToTray(); }
                await RefreshSpotifyActivationAsync();
            };
        }

        protected override void OnHandleCreated(EventArgs eventArgs)
        {
            base.OnHandleCreated(eventArgs);
            audioHotkeyRegistered = RegisterHotKey(Handle, AudioHotkeyId, ModControl | ModAlt | ModNoRepeat, (uint)Keys.F10);
            if (!audioHotkeyRegistered && activityStatus != null)
            {
                activityStatus.Text = "Ctrl + Alt + F10 is already in use.";
                activityStatus.ForeColor = GoldColor;
            }
        }

        protected override void OnHandleDestroyed(EventArgs eventArgs)
        {
            if (audioHotkeyRegistered)
            {
                UnregisterHotKey(Handle, AudioHotkeyId);
                audioHotkeyRegistered = false;
            }
            base.OnHandleDestroyed(eventArgs);
        }

        protected override void WndProc(ref Message message)
        {
            if (message.Msg == WmHotkey && message.WParam.ToInt32() == AudioHotkeyId)
            {
                BeginInvoke(new Action(ToggleAudioOutput));
            }
            base.WndProc(ref message);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                showRegistration.Unregister(null);
                showSignal.Dispose();
                refreshTimer.Dispose();
                trayIcon.Visible = false;
                trayIcon.Dispose();
            }
            base.Dispose(disposing);
        }

        private async void OnActionClick(object sender, EventArgs eventArgs)
        {
            Button button = sender as Button;
            if (button != null) { await RunActionAsync((string)button.Tag); }
        }

        private async Task RunActionAsync(string action)
        {
            if (busy) { return; }
            busy = true;
            SetButtonsEnabled(false);
            try
            {
                await runtime.ExecuteActionAsync(action, delegate(string message)
                {
                    if (!IsDisposed) { BeginInvoke(new Action(delegate { activityStatus.Text = message; })); }
                });
            }
            catch (Exception error)
            {
                activityStatus.Text = error.Message;
                activityStatus.ForeColor = DangerColor;
            }
            finally
            {
                busy = false;
                RefreshStatus();
            }
        }

        private void RefreshStatus()
        {
            if (busy) { return; }
            RuntimeSnapshot snapshot = runtime.GetSnapshot();
            bool running = snapshot.ServerOnline && snapshot.HostRunning;
            bool partial = snapshot.ServerProcessRunning || snapshot.HostRunning;
            overallStatus.Text = running ? "Running" : (partial ? "Needs attention" : "Stopped");
            overallDot.ForeColor = running ? GreenColor : (partial ? GoldColor : MutedColor);
            serverStatus.Text = snapshot.ServerOnline ? "Online" : (snapshot.ServerProcessRunning ? "Starting" : "Offline");
            serverDot.ForeColor = snapshot.ServerOnline ? GreenColor : (snapshot.ServerProcessRunning ? GoldColor : MutedColor);
            hostStatus.Text = snapshot.HostRunning ? "Running" : "Stopped";
            hostDot.ForeColor = snapshot.HostRunning ? CyanColor : MutedColor;
            spotifyStatus.Text = snapshot.SpotifyActivationRequired ? "Activation needed" : (snapshot.SpotifyHealthy ? "Ready" : (snapshot.ServerOnline ? "Starting" : "Unavailable"));
            spotifyDot.ForeColor = snapshot.SpotifyActivationRequired ? GoldColor : (snapshot.SpotifyHealthy ? GreenColor : MutedColor);
            activityStatus.ForeColor = MutedColor;
            if (activityStatus.Text.Length == 0) { activityStatus.Text = "Ready"; }
            openXeneonButton.Visible = !snapshot.HostRunning;
            SetButtonsEnabled(true);
            startButton.Enabled = !running;
            stopButton.Enabled = partial;
        }

        private async void ToggleAudioOutput()
        {
            try
            {
                activityStatus.Text = "Switching Windows audio output...";
                activityStatus.ForeColor = MutedColor;
                activityStatus.Text = await runtime.ToggleAudioOutputAsync();
            }
            catch (Exception error)
            {
                activityStatus.Text = error.Message;
                activityStatus.ForeColor = DangerColor;
            }
        }

        private async Task RefreshSpotifyActivationAsync()
        {
            if (spotifyActivationSyncBusy) { return; }
            spotifyActivationSyncBusy = true;
            try
            {
                await runtime.SynchronizeSpotifyActivationWindowAsync();
            }
            catch (Exception error)
            {
                activityStatus.Text = "Spotify activation: " + error.Message;
                activityStatus.ForeColor = DangerColor;
            }
            finally
            {
                spotifyActivationSyncBusy = false;
            }
        }

        private void SetButtonsEnabled(bool enabled)
        {
            startButton.Enabled = enabled;
            stopButton.Enabled = enabled;
            restartButton.Enabled = enabled;
            openXeneonButton.Enabled = enabled;
        }

        private void RefreshAutoStart()
        {
            initializingAutoStart = true;
            try { startWithWindows.Checked = runtime.IsStartWithWindowsEnabled(); }
            finally { initializingAutoStart = false; }
        }

        private void OnStartWithWindowsChanged(object sender, EventArgs eventArgs)
        {
            if (initializingAutoStart) { return; }
            try
            {
                runtime.SetStartWithWindows(startWithWindows.Checked);
                activityStatus.Text = startWithWindows.Checked ? "Windows startup enabled." : "Windows startup disabled.";
            }
            catch (Exception error)
            {
                activityStatus.Text = error.Message;
                activityStatus.ForeColor = DangerColor;
                RefreshAutoStart();
            }
        }

        private void OnFormClosing(object sender, FormClosingEventArgs eventArgs)
        {
            if (!allowExit && eventArgs.CloseReason != CloseReason.WindowsShutDown)
            {
                eventArgs.Cancel = true;
                HideToTray();
            }
        }

        private void HideToTray() { Hide(); ShowInTaskbar = false; }
        private void RestoreWindow() { ShowInTaskbar = true; Show(); WindowState = FormWindowState.Normal; Activate(); RefreshStatus(); }
        private void ExitController() { allowExit = true; trayIcon.Visible = false; Application.Exit(); }

        private Label MakeLabel(string text, int x, int y, int width, int height, Color color, float size, FontStyle style)
        {
            return new Label { Text = text, Location = new Point(x, y), Size = new Size(width, height), ForeColor = color, BackColor = Color.Transparent, Font = new Font("Segoe UI", size, style) };
        }

        private Button MakeButton(string text, int x, int y, int width, Color border, Color foreground)
        {
            Button button = new Button { Text = text, Location = new Point(x, y), Size = new Size(width, 48), BackColor = border == DangerColor ? BackgroundColor : border, ForeColor = foreground, FlatStyle = FlatStyle.Flat, Cursor = Cursors.Hand, Font = new Font("Segoe UI", 10F, FontStyle.Bold) };
            button.FlatAppearance.BorderColor = border;
            button.FlatAppearance.BorderSize = 1;
            button.FlatAppearance.MouseOverBackColor = Color.FromArgb(25, border);
            return button;
        }
    }

    internal sealed class BorderPanel : Panel
    {
        internal BorderPanel() { DoubleBuffered = true; }
        protected override void OnPaint(PaintEventArgs eventArgs)
        {
            base.OnPaint(eventArgs);
            using (Pen border = new Pen(Color.FromArgb(42, 75, 96))) { eventArgs.Graphics.DrawRectangle(border, 0, 0, Width - 1, Height - 1); }
        }
    }
}
