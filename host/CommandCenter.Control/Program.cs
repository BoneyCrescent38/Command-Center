using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
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
                    Application.Run(new ControlForm(runtime, HasArgument(args, "--tray")));
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
    }

    internal sealed class CommandCenterRuntime
    {
        private const int ServerPort = 4337;
        private const uint WmClose = 0x0010;
        private const string AutoStartValueName = "Kristian Liverod Command Center Control";
        private readonly string root;
        private readonly string runtimeDirectory;

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
            return new RuntimeSnapshot
            {
                ServerPid = serverPid,
                HostPid = hostPid,
                ServerProcessRunning = serverPid.HasValue,
                ServerOnline = serverPid.HasValue && IsPortOpen(ServerPort),
                HostRunning = hostPid.HasValue,
            };
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
                    await StopAsync(progress);
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

        private async Task StopAsync(Action<string> progress)
        {
            RuntimeSnapshot current = GetSnapshot();
            if (!current.ServerProcessRunning && !current.HostRunning)
            {
                Report(progress, "Command Center is already stopped.");
                await RunPowerShellAsync(Path.Combine(root, "scripts", "stop.ps1"));
                return;
            }

            Report(progress, "Stopping Xeneon host...");
            await CloseOwnedHostAsync(current.HostPid);
            Report(progress, "Stopping Command Center server...");
            await RunPowerShellAsync(Path.Combine(root, "scripts", "stop.ps1"));
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

        private async Task RunPowerShellAsync(string script)
        {
            string powershell = Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");
            ProcessStartInfo startInfo = new ProcessStartInfo
            {
                FileName = powershell,
                Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + script.Replace("\"", "\"\"") + "\"",
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
            ClientSize = new Size(520, 450);
            MinimumSize = MaximumSize = new Size(536, 489);
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

            Panel card = new BorderPanel { Location = new Point(30, 111), Size = new Size(460, 128), BackColor = CardColor };
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
            Controls.Add(card);

            startButton = MakeButton("Start", 30, 258, 142, CyanColor, BackgroundColor);
            stopButton = MakeButton("Stop", 189, 258, 142, DangerColor, TextColor);
            restartButton = MakeButton("Restart", 348, 258, 142, GoldColor, BackgroundColor);
            startButton.Tag = "start";
            stopButton.Tag = "stop";
            restartButton.Tag = "restart";
            startButton.Click += OnActionClick;
            stopButton.Click += OnActionClick;
            restartButton.Click += OnActionClick;
            Controls.Add(startButton);
            Controls.Add(stopButton);
            Controls.Add(restartButton);

            openXeneonButton = MakeButton("Open on Xeneon", 30, 321, 220, CyanColor, BackgroundColor);
            openXeneonButton.Tag = "start";
            openXeneonButton.Click += OnActionClick;
            Controls.Add(openXeneonButton);

            startWithWindows = new CheckBox { AutoSize = true, Location = new Point(285, 336), Text = "Start with Windows", ForeColor = MutedColor, BackColor = BackgroundColor, FlatStyle = FlatStyle.Flat };
            startWithWindows.CheckedChanged += OnStartWithWindowsChanged;
            Controls.Add(startWithWindows);

            activityStatus = MakeLabel("Ready", 30, 399, 460, 28, MutedColor, 9F, FontStyle.Regular);
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
            refreshTimer.Tick += delegate { RefreshStatus(); };
            refreshTimer.Start();

            FormClosing += OnFormClosing;
            Shown += delegate
            {
                RefreshAutoStart();
                RefreshStatus();
                if (startHidden) { HideToTray(); }
            };
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
            activityStatus.ForeColor = MutedColor;
            if (activityStatus.Text.Length == 0) { activityStatus.Text = "Ready"; }
            openXeneonButton.Visible = !snapshot.HostRunning;
            SetButtonsEnabled(true);
            startButton.Enabled = !running;
            stopButton.Enabled = partial;
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
