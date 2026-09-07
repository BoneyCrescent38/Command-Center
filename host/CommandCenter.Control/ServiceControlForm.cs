using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace KristianLiverod.CommandCenter.Control
{
    internal static class ControlPalette
    {
        internal static readonly Color Background = Color.FromArgb(6, 16, 27);
        internal static readonly Color Card = Color.FromArgb(13, 31, 47);
        internal static readonly Color CardRaised = Color.FromArgb(17, 38, 56);
        internal static readonly Color Border = Color.FromArgb(42, 75, 96);
        internal static readonly Color Cyan = Color.FromArgb(69, 192, 208);
        internal static readonly Color Green = Color.FromArgb(112, 214, 163);
        internal static readonly Color Gold = Color.FromArgb(243, 201, 105);
        internal static readonly Color Danger = Color.FromArgb(255, 125, 114);
        internal static readonly Color Text = Color.FromArgb(235, 244, 248);
        internal static readonly Color Muted = Color.FromArgb(143, 165, 181);
        internal static readonly Color Offline = Color.FromArgb(92, 113, 128);

        internal static Color ForState(LocalServiceState state)
        {
            if (state == LocalServiceState.Online) { return Green; }
            if (state == LocalServiceState.Starting || state == LocalServiceState.Stopping || state == LocalServiceState.Partial) { return Gold; }
            if (state == LocalServiceState.Error) { return Danger; }
            return Offline;
        }
    }

    internal sealed class ServiceActionEventArgs : EventArgs
    {
        internal readonly string ServiceId;
        internal readonly string Action;

        internal ServiceActionEventArgs(string serviceId, string action)
        {
            ServiceId = serviceId;
            Action = action;
        }
    }

    internal sealed class ServiceAutoStartEventArgs : EventArgs
    {
        internal readonly string ServiceId;
        internal readonly bool Enabled;

        internal ServiceAutoStartEventArgs(string serviceId, bool enabled)
        {
            ServiceId = serviceId;
            Enabled = enabled;
        }
    }

    internal sealed class ServiceCardControl : Panel
    {
        private readonly string serviceId;
        private readonly Label nameLabel;
        private readonly Label environmentLabel;
        private readonly Label stateDot;
        private readonly Label stateLabel;
        private readonly Label metaLabel;
        private readonly Label componentLabel;
        private readonly Button startButton;
        private readonly Button stopButton;
        private readonly Button restartButton;
        private readonly Button openButton;
        private readonly CheckBox autoStartCheckBox;
        private readonly Label policyLabel;
        private readonly string openUrl;
        private readonly bool supportsOpen;
        private bool updatingAutoStart;

        internal event EventHandler<ServiceActionEventArgs> ActionRequested;
        internal event EventHandler<ServiceAutoStartEventArgs> AutoStartChanged;

        internal ServiceCardControl(IServiceAdapter adapter)
        {
            serviceId = adapter.Id;
            openUrl = adapter.Endpoint;
            supportsOpen = String.Equals(serviceId, "skaperverksted-rfid", StringComparison.OrdinalIgnoreCase);
            Size = new Size(786, 112);
            Margin = new Padding(0, 0, 0, 9);
            BackColor = ControlPalette.Card;
            DoubleBuffered = true;

            nameLabel = MakeLabel(adapter.DisplayName, 18, 10, 330, 25, ControlPalette.Text, 13.5F, FontStyle.Bold);
            environmentLabel = MakeLabel(EnvironmentText(adapter.Environment, serviceId), 350, 12, supportsOpen ? 102 : 58, 20, adapter.Environment == LocalServiceEnvironment.Test ? ControlPalette.Gold : ControlPalette.Cyan, 8F, FontStyle.Bold);
            environmentLabel.TextAlign = ContentAlignment.MiddleCenter;
            stateDot = MakeLabel("●", 631, 11, 18, 22, ControlPalette.Offline, 11F, FontStyle.Regular);
            stateLabel = MakeLabel("CHECKING", 651, 11, 115, 22, ControlPalette.Muted, 9F, FontStyle.Bold);
            stateLabel.TextAlign = ContentAlignment.MiddleRight;
            metaLabel = MakeLabel(adapter.Endpoint, 18, 38, 748, 19, ControlPalette.Muted, 8.5F, FontStyle.Regular);
            componentLabel = MakeLabel("Checking service state...", 18, 58, 748, 18, ControlPalette.Muted, 8.5F, FontStyle.Regular);

            startButton = MakeButton("Start", 18, 78, 75, ControlPalette.Cyan, ControlPalette.Background);
            stopButton = MakeButton("Stop", 101, 78, 75, ControlPalette.Danger, ControlPalette.Text);
            restartButton = MakeButton("Restart", 184, 78, 82, ControlPalette.Gold, ControlPalette.Background);
            openButton = MakeButton("Open", 274, 78, 75, ControlPalette.Cyan, ControlPalette.Background);
            startButton.Tag = "start";
            stopButton.Tag = "stop";
            restartButton.Tag = "restart";
            startButton.Click += OnActionClick;
            stopButton.Click += OnActionClick;
            restartButton.Click += OnActionClick;
            openButton.Click += OnOpenClick;
            openButton.Visible = supportsOpen;

            autoStartCheckBox = new CheckBox
            {
                Text = "Auto-start",
                Location = new Point(619, 82),
                Size = new Size(147, 22),
                TextAlign = ContentAlignment.MiddleRight,
                CheckAlign = ContentAlignment.MiddleRight,
                ForeColor = ControlPalette.Muted,
                BackColor = Color.Transparent,
                FlatStyle = FlatStyle.Flat,
                Font = new Font("Segoe UI", 8.5F, FontStyle.Bold)
            };
            autoStartCheckBox.CheckedChanged += OnAutoStartChanged;

            policyLabel = MakeLabel(PolicyText(adapter.AutoStartPolicy), 516, 82, 250, 22, ControlPalette.Muted, 8.5F, FontStyle.Bold);
            policyLabel.TextAlign = ContentAlignment.MiddleRight;

            Controls.Add(nameLabel);
            Controls.Add(environmentLabel);
            Controls.Add(stateDot);
            Controls.Add(stateLabel);
            Controls.Add(metaLabel);
            Controls.Add(componentLabel);
            Controls.Add(startButton);
            Controls.Add(stopButton);
            Controls.Add(restartButton);
            Controls.Add(openButton);
            Controls.Add(autoStartCheckBox);
            Controls.Add(policyLabel);

            autoStartCheckBox.Visible = adapter.AutoStartPolicy == AutoStartPolicy.ControlManaged;
            policyLabel.Visible = !autoStartCheckBox.Visible;
            SetActionState(LocalServiceState.Offline, false);
        }

        internal void Apply(ServiceStatusSnapshot status)
        {
            SuspendLayout();
            try
            {
                nameLabel.Text = status.DisplayName;
                environmentLabel.Text = EnvironmentText(status.Environment, status.Id);
                Color stateColor = ControlPalette.ForState(status.State);
                stateDot.ForeColor = stateColor;
                stateLabel.ForeColor = stateColor;
                stateLabel.Text = StateText(status.State);
                string metadata = status.Endpoint;
                if (!String.IsNullOrWhiteSpace(status.Version))
                {
                    metadata += "  ·  v" + status.Version.TrimStart('v', 'V');
                }
                if (!String.IsNullOrWhiteSpace(status.Branch))
                {
                    metadata += "  ·  " + status.Branch;
                }
                if (!String.IsNullOrWhiteSpace(status.Detail))
                {
                    metadata += "  ·  " + status.Detail;
                }
                metaLabel.Text = metadata;
                componentLabel.Text = BuildComponents(status.Components);
                componentLabel.ForeColor = status.State == LocalServiceState.Error ? ControlPalette.Danger : ControlPalette.Muted;

                updatingAutoStart = true;
                try
                {
                    autoStartCheckBox.Checked = status.AutoStartEnabled;
                }
                finally
                {
                    updatingAutoStart = false;
                }

                if (status.AutoStartPolicy == AutoStartPolicy.ExternallyManaged)
                {
                    policyLabel.Text = "Autostart: Windows managed";
                    policyLabel.ForeColor = ControlPalette.Green;
                }
                else if (status.AutoStartPolicy == AutoStartPolicy.ManualOnly)
                {
                    policyLabel.Text = supportsOpen ? "Autostart: Off · Manual only" : "Manual only";
                    policyLabel.ForeColor = ControlPalette.Gold;
                }
                SetActionState(status.State, false);
            }
            finally
            {
                ResumeLayout();
            }
        }

        internal void SetPending(string action)
        {
            LocalServiceState state = String.Equals(action, "stop", StringComparison.OrdinalIgnoreCase)
                ? LocalServiceState.Stopping
                : LocalServiceState.Starting;
            stateDot.ForeColor = ControlPalette.Gold;
            stateLabel.ForeColor = ControlPalette.Gold;
            stateLabel.Text = StateText(state);
            SetActionState(state, true);
        }

        internal void SetActionState(LocalServiceState state, bool busy)
        {
            ServiceActionAvailability availability = ServiceActionAvailability.ForState(state);
            startButton.Enabled = !busy && availability.CanStart;
            stopButton.Enabled = !busy && availability.CanStop;
            restartButton.Enabled = !busy && availability.CanRestart;
            openButton.Enabled = !busy;
            autoStartCheckBox.Enabled = !busy;
        }

        protected override void OnPaint(PaintEventArgs eventArgs)
        {
            base.OnPaint(eventArgs);
            using (Pen pen = new Pen(ControlPalette.Border))
            {
                eventArgs.Graphics.DrawRectangle(pen, 0, 0, Width - 1, Height - 1);
            }
        }

        private void OnActionClick(object sender, EventArgs eventArgs)
        {
            Button button = sender as Button;
            EventHandler<ServiceActionEventArgs> handler = ActionRequested;
            if (button != null && handler != null)
            {
                handler(this, new ServiceActionEventArgs(serviceId, (string)button.Tag));
            }
        }

        private void OnAutoStartChanged(object sender, EventArgs eventArgs)
        {
            if (updatingAutoStart)
            {
                return;
            }
            EventHandler<ServiceAutoStartEventArgs> handler = AutoStartChanged;
            if (handler != null)
            {
                handler(this, new ServiceAutoStartEventArgs(serviceId, autoStartCheckBox.Checked));
            }
        }

        private void OnOpenClick(object sender, EventArgs eventArgs)
        {
            if (!supportsOpen)
            {
                return;
            }
            try
            {
                Process.Start(new ProcessStartInfo { FileName = openUrl, UseShellExecute = true });
            }
            catch (Exception error)
            {
                MessageBox.Show(this, error.Message, "Could not open Skaperverksted RFID", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private static string BuildComponents(IList<ServiceComponentSnapshot> components)
        {
            if (components == null || components.Count == 0)
            {
                return "No component details";
            }
            List<string> values = new List<string>();
            foreach (ServiceComponentSnapshot component in components)
            {
                values.Add(component.Name + " " + ComponentMarker(component.State) + " " + component.Status);
            }
            return String.Join("     ", values.ToArray());
        }

        private static string ComponentMarker(LocalServiceState state)
        {
            if (state == LocalServiceState.Online) { return "●"; }
            if (state == LocalServiceState.Partial || state == LocalServiceState.Starting || state == LocalServiceState.Stopping) { return "◐"; }
            if (state == LocalServiceState.Error) { return "!"; }
            return "○";
        }

        private static string EnvironmentText(LocalServiceEnvironment environment, string serviceId)
        {
            if (String.Equals(serviceId, "skaperverksted-rfid", StringComparison.OrdinalIgnoreCase)) { return "TEST / LOCAL"; }
            if (environment == LocalServiceEnvironment.Test) { return "TEST"; }
            if (environment == LocalServiceEnvironment.Utility) { return "UTIL"; }
            return "PROD";
        }

        private static string StateText(LocalServiceState state)
        {
            return state.ToString().ToUpperInvariant();
        }

        private static string PolicyText(AutoStartPolicy policy)
        {
            if (policy == AutoStartPolicy.ManualOnly) { return "Manual only"; }
            if (policy == AutoStartPolicy.ExternallyManaged) { return "Autostart: Windows managed"; }
            return "Auto-start";
        }

        private static Label MakeLabel(string text, int x, int y, int width, int height, Color color, float size, FontStyle style)
        {
            return new Label
            {
                Text = text,
                Location = new Point(x, y),
                Size = new Size(width, height),
                ForeColor = color,
                BackColor = Color.Transparent,
                Font = new Font("Segoe UI", size, style),
                AutoEllipsis = true
            };
        }

        private static Button MakeButton(string text, int x, int y, int width, Color border, Color foreground)
        {
            Button button = new Button
            {
                Text = text,
                Location = new Point(x, y),
                Size = new Size(width, 27),
                BackColor = border == ControlPalette.Danger ? ControlPalette.Card : border,
                ForeColor = foreground,
                FlatStyle = FlatStyle.Flat,
                Cursor = Cursors.Hand,
                Font = new Font("Segoe UI", 8.5F, FontStyle.Bold),
                TabStop = true
            };
            button.FlatAppearance.BorderColor = border;
            button.FlatAppearance.BorderSize = 1;
            button.FlatAppearance.MouseOverBackColor = ControlPalette.CardRaised;
            button.FlatAppearance.MouseDownBackColor = ControlPalette.Background;
            return button;
        }
    }

    internal sealed class ServiceControlForm : Form
    {
        private const int WmHotkey = 0x0312;
        private const int AudioHotkeyId = 0x4B4C;
        private const uint ModAlt = 0x0001;
        private const uint ModControl = 0x0002;
        private const uint ModNoRepeat = 0x4000;
        private const string ShowEventName = "Local\\KristianLiverod.CommandCenter.Control.Show";

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool RegisterHotKey(IntPtr windowHandle, int id, uint modifiers, uint virtualKey);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool UnregisterHotKey(IntPtr windowHandle, int id);

        private readonly CommandCenterRuntime runtime;
        private readonly ServiceRegistry registry;
        private readonly Dictionary<string, ServiceCardControl> cards = new Dictionary<string, ServiceCardControl>(StringComparer.OrdinalIgnoreCase);
        private readonly Label onlineSummary;
        private readonly Label overallDot;
        private readonly Label overallStatus;
        private readonly Label refreshedLabel;
        private readonly Label activityLabel;
        private readonly CheckBox controlAutoStart;
        private readonly NotifyIcon trayIcon;
        private readonly System.Windows.Forms.Timer refreshTimer;
        private readonly EventWaitHandle showSignal;
        private readonly RegisteredWaitHandle showRegistration;
        private bool allowExit;
        private bool refreshing;
        private bool initializingControlAutoStart;
        private bool spotifyActivationSyncBusy;
        private bool audioHotkeyRegistered;

        internal ServiceControlForm(CommandCenterRuntime runtime, string repositoryRoot, bool startHidden)
        {
            this.runtime = runtime;
            registry = new ServiceRegistry(repositoryRoot, runtime);
            showSignal = new EventWaitHandle(false, EventResetMode.AutoReset, ShowEventName);
            showRegistration = ThreadPool.RegisterWaitForSingleObject(showSignal, delegate
            {
                if (!IsDisposed && IsHandleCreated)
                {
                    BeginInvoke(new Action(RestoreWindow));
                }
            }, null, Timeout.Infinite, false);

            Text = "Command Center Control";
            ClientSize = new Size(838, 691);
            MinimumSize = MaximumSize = new Size(854, 730);
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            BackColor = ControlPalette.Background;
            ForeColor = ControlPalette.Text;
            Font = new Font("Segoe UI", 9F);
            AutoScaleMode = AutoScaleMode.Dpi;

            Icon applicationIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? SystemIcons.Application;
            Icon = applicationIcon;

            Controls.Add(MakeLabel("KRISTIAN LIVEROD", 25, 16, 340, 18, ControlPalette.Muted, 8.5F, FontStyle.Bold));
            Controls.Add(MakeLabel("COMMAND CENTER CONTROL", 24, 34, 500, 35, ControlPalette.Text, 21F, FontStyle.Bold));
            Controls.Add(MakeLabel("LOCAL SERVICE HUD", 26, 69, 260, 18, ControlPalette.Cyan, 8.5F, FontStyle.Bold));

            overallDot = MakeLabel("●", 608, 23, 21, 23, ControlPalette.Gold, 12F, FontStyle.Regular);
            overallStatus = MakeLabel("CHECKING", 631, 23, 177, 23, ControlPalette.Gold, 10F, FontStyle.Bold);
            overallStatus.TextAlign = ContentAlignment.MiddleRight;
            onlineSummary = MakeLabel("0 / " + registry.Services.Count + " online", 608, 47, 200, 20, ControlPalette.Text, 10F, FontStyle.Bold);
            onlineSummary.TextAlign = ContentAlignment.MiddleRight;
            refreshedLabel = MakeLabel("Waiting for first refresh", 535, 68, 273, 18, ControlPalette.Muted, 8F, FontStyle.Regular);
            refreshedLabel.TextAlign = ContentAlignment.MiddleRight;
            Controls.Add(overallDot);
            Controls.Add(overallStatus);
            Controls.Add(onlineSummary);
            Controls.Add(refreshedLabel);

            FlowLayoutPanel serviceList = new FlowLayoutPanel
            {
                Location = new Point(24, 96),
                Size = new Size(808, 475),
                FlowDirection = FlowDirection.TopDown,
                WrapContents = false,
                AutoScroll = true,
                BackColor = ControlPalette.Background,
                Margin = Padding.Empty,
                Padding = Padding.Empty
            };

            foreach (IServiceAdapter adapter in registry.Services)
            {
                ServiceCardControl card = new ServiceCardControl(adapter);
                card.ActionRequested += OnServiceActionRequested;
                card.AutoStartChanged += OnServiceAutoStartChanged;
                cards.Add(adapter.Id, card);
                serviceList.Controls.Add(card);
            }
            Controls.Add(serviceList);

            Panel footer = new Panel
            {
                Location = new Point(24, 582),
                Size = new Size(790, 84),
                BackColor = ControlPalette.Card
            };
            footer.Paint += delegate(object sender, PaintEventArgs eventArgs)
            {
                using (Pen pen = new Pen(ControlPalette.Border))
                {
                    eventArgs.Graphics.DrawRectangle(pen, 0, 0, footer.Width - 1, footer.Height - 1);
                }
            };

            controlAutoStart = new CheckBox
            {
                Text = "Start Control with Windows",
                Location = new Point(16, 12),
                Size = new Size(245, 25),
                ForeColor = ControlPalette.Text,
                BackColor = Color.Transparent,
                FlatStyle = FlatStyle.Flat,
                Font = new Font("Segoe UI", 9F, FontStyle.Bold)
            };
            controlAutoStart.CheckedChanged += OnControlAutoStartChanged;
            footer.Controls.Add(controlAutoStart);
            footer.Controls.Add(MakeLabel("Starts this HUD in tray. Service policies remain separate.", 278, 13, 494, 22, ControlPalette.Muted, 8.5F, FontStyle.Regular));

            activityLabel = MakeLabel("Ready  ·  Audio toggle: Ctrl + Alt + F10", 16, 47, 756, 25, ControlPalette.Muted, 8.5F, FontStyle.Regular);
            activityLabel.TextAlign = ContentAlignment.MiddleLeft;
            footer.Controls.Add(activityLabel);
            Controls.Add(footer);

            ContextMenuStrip trayMenu = new ContextMenuStrip();
            trayMenu.Items.Add("Open Control", null, delegate { RestoreWindow(); });
            trayMenu.Items.Add("Start configured services", null, async delegate { await StartConfiguredServicesAsync(); });
            trayMenu.Items.Add(new ToolStripSeparator());
            trayMenu.Items.Add("Exit Control", null, delegate { ExitController(); });
            trayIcon = new NotifyIcon
            {
                Icon = applicationIcon,
                Text = "Command Center Control",
                ContextMenuStrip = trayMenu,
                Visible = true
            };
            trayIcon.DoubleClick += delegate { RestoreWindow(); };

            refreshTimer = new System.Windows.Forms.Timer { Interval = 3000 };
            refreshTimer.Tick += async delegate { await RefreshAllAsync(); };
            refreshTimer.Start();

            FormClosing += OnFormClosing;
            Shown += async delegate
            {
                RefreshControlAutoStart();
                await RefreshAllAsync();
                if (startHidden)
                {
                    HideToTray();
                    await Task.Delay(5000);
                    await StartConfiguredServicesAsync();
                }
            };
        }

        protected override void OnHandleCreated(EventArgs eventArgs)
        {
            base.OnHandleCreated(eventArgs);
            audioHotkeyRegistered = RegisterHotKey(Handle, AudioHotkeyId, ModControl | ModAlt | ModNoRepeat, (uint)Keys.F10);
            if (!audioHotkeyRegistered && activityLabel != null)
            {
                activityLabel.Text = "Ctrl + Alt + F10 is already in use.";
                activityLabel.ForeColor = ControlPalette.Gold;
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

        private async void OnServiceActionRequested(object sender, ServiceActionEventArgs eventArgs)
        {
            await RunServiceActionAsync(eventArgs.ServiceId, eventArgs.Action);
        }

        private void OnServiceAutoStartChanged(object sender, ServiceAutoStartEventArgs eventArgs)
        {
            try
            {
                registry.SetAutoStartEnabled(eventArgs.ServiceId, eventArgs.Enabled);
                activityLabel.ForeColor = ControlPalette.Muted;
                activityLabel.Text = eventArgs.Enabled
                    ? "Command Center service auto-start enabled."
                    : "Command Center service auto-start disabled.";
            }
            catch (Exception error)
            {
                activityLabel.ForeColor = ControlPalette.Danger;
                activityLabel.Text = error.Message;
                BeginInvoke(new Action(async delegate { await RefreshAllAsync(); }));
            }
        }

        private async Task RunServiceActionAsync(string serviceId, string action)
        {
            ServiceCardControl card;
            if (!cards.TryGetValue(serviceId, out card))
            {
                return;
            }

            card.SetPending(action);
            activityLabel.ForeColor = ControlPalette.Muted;
            try
            {
                await registry.ExecuteAsync(serviceId, action, delegate(string message)
                {
                    if (!IsDisposed && IsHandleCreated)
                    {
                        BeginInvoke(new Action(delegate { activityLabel.Text = message; }));
                    }
                });
                activityLabel.Text = "Service action completed.";
            }
            catch (Exception error)
            {
                activityLabel.ForeColor = ControlPalette.Danger;
                activityLabel.Text = error.Message;
            }
            await RefreshAllAsync();
        }

        private async Task RefreshAllAsync()
        {
            if (refreshing || IsDisposed)
            {
                return;
            }
            refreshing = true;
            try
            {
                List<ServiceStatusSnapshot> statuses = await registry.RefreshAllAsync();
                int online = 0;
                int attention = 0;
                foreach (ServiceStatusSnapshot status in statuses)
                {
                    if (status.State == LocalServiceState.Online) { online++; }
                    if (status.State == LocalServiceState.Partial || status.State == LocalServiceState.Error) { attention++; }
                    ServiceCardControl card;
                    if (cards.TryGetValue(status.Id, out card))
                    {
                        card.Apply(status);
                    }
                }

                onlineSummary.Text = online + " / " + statuses.Count + " online";
                if (attention > 0)
                {
                    overallStatus.Text = "ATTENTION";
                    overallStatus.ForeColor = ControlPalette.Gold;
                    overallDot.ForeColor = ControlPalette.Gold;
                }
                else if (online == statuses.Count)
                {
                    overallStatus.Text = "ALL ONLINE";
                    overallStatus.ForeColor = ControlPalette.Green;
                    overallDot.ForeColor = ControlPalette.Green;
                }
                else
                {
                    overallStatus.Text = "READY";
                    overallStatus.ForeColor = ControlPalette.Cyan;
                    overallDot.ForeColor = ControlPalette.Cyan;
                }
                refreshedLabel.Text = "Updated " + DateTime.Now.ToString("HH:mm:ss");
                string trayText = "Command Center Control - " + online + "/" + statuses.Count + " online";
                trayIcon.Text = trayText.Length <= 63 ? trayText : trayText.Substring(0, 63);
                await RefreshSpotifyActivationAsync();
            }
            finally
            {
                refreshing = false;
            }
        }

        private async Task StartConfiguredServicesAsync()
        {
            try
            {
                activityLabel.ForeColor = ControlPalette.Muted;
                activityLabel.Text = "Checking configured service auto-start...";
                await registry.StartConfiguredServicesAsync(delegate(string message)
                {
                    if (!IsDisposed && IsHandleCreated)
                    {
                        BeginInvoke(new Action(delegate { activityLabel.Text = message; }));
                    }
                });
                activityLabel.Text = "Configured service startup complete.";
                await RefreshAllAsync();
            }
            catch (Exception error)
            {
                activityLabel.ForeColor = ControlPalette.Danger;
                activityLabel.Text = error.Message;
            }
        }

        private async void ToggleAudioOutput()
        {
            try
            {
                activityLabel.Text = "Switching Windows audio output...";
                activityLabel.ForeColor = ControlPalette.Muted;
                activityLabel.Text = await runtime.ToggleAudioOutputAsync();
            }
            catch (Exception error)
            {
                activityLabel.Text = error.Message;
                activityLabel.ForeColor = ControlPalette.Danger;
            }
        }

        private async Task RefreshSpotifyActivationAsync()
        {
            if (spotifyActivationSyncBusy)
            {
                return;
            }
            spotifyActivationSyncBusy = true;
            try
            {
                await runtime.SynchronizeSpotifyActivationWindowAsync();
            }
            catch (Exception error)
            {
                activityLabel.Text = "Spotify activation: " + error.Message;
                activityLabel.ForeColor = ControlPalette.Danger;
            }
            finally
            {
                spotifyActivationSyncBusy = false;
            }
        }

        private void RefreshControlAutoStart()
        {
            initializingControlAutoStart = true;
            try
            {
                controlAutoStart.Checked = runtime.IsStartWithWindowsEnabled();
            }
            finally
            {
                initializingControlAutoStart = false;
            }
        }

        private void OnControlAutoStartChanged(object sender, EventArgs eventArgs)
        {
            if (initializingControlAutoStart)
            {
                return;
            }
            try
            {
                runtime.SetStartWithWindows(controlAutoStart.Checked);
                activityLabel.ForeColor = ControlPalette.Muted;
                activityLabel.Text = controlAutoStart.Checked
                    ? "Control will start in tray at Windows login."
                    : "Control Windows startup is off.";
            }
            catch (Exception error)
            {
                activityLabel.ForeColor = ControlPalette.Danger;
                activityLabel.Text = error.Message;
                RefreshControlAutoStart();
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

        private void HideToTray()
        {
            Hide();
            ShowInTaskbar = false;
        }

        private void RestoreWindow()
        {
            ShowInTaskbar = true;
            Show();
            WindowState = FormWindowState.Normal;
            Activate();
            BeginInvoke(new Action(async delegate { await RefreshAllAsync(); }));
        }

        private void ExitController()
        {
            allowExit = true;
            trayIcon.Visible = false;
            Application.Exit();
        }

        private static Label MakeLabel(string text, int x, int y, int width, int height, Color color, float size, FontStyle style)
        {
            return new Label
            {
                Text = text,
                Location = new Point(x, y),
                Size = new Size(width, height),
                ForeColor = color,
                BackColor = Color.Transparent,
                Font = new Font("Segoe UI", size, style),
                AutoEllipsis = true
            };
        }
    }
}
