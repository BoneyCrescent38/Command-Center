using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace KristianLiverod.CommandCenter.Host
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            string diagnosticsFile = ArgumentValue(args, "--diagnostics-file");
            MonitorSelection selection = MonitorSelector.Select(
                Environment.GetEnvironmentVariable("COMMAND_CENTER_DISPLAY_HINT") ?? "CORSAIR|XENEON");

            if (!String.IsNullOrEmpty(diagnosticsFile))
            {
                File.WriteAllText(diagnosticsFile, selection.ToJson(), new UTF8Encoding(false));
                return;
            }

            string url = ArgumentValue(args, "--url");
            if (String.IsNullOrEmpty(url))
            {
                url = Environment.GetEnvironmentVariable("COMMAND_CENTER_URL") ?? "http://127.0.0.1:4337";
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new CommandCenterForm(selection, url));
        }

        private static string ArgumentValue(string[] args, string name)
        {
            for (int index = 0; index < args.Length - 1; index++)
            {
                if (String.Equals(args[index], name, StringComparison.OrdinalIgnoreCase))
                {
                    return args[index + 1];
                }
            }
            return "";
        }
    }

    internal sealed class CommandCenterForm : Form
    {
        private const int WsExToolWindow = 0x00000080;
        private const int WsExAppWindow = 0x00040000;

        private readonly MonitorSelection selection;
        private readonly string targetUrl;
        private readonly WebView2 webView;
        private readonly Panel fallbackPanel;

        internal CommandCenterForm(MonitorSelection selection, string targetUrl)
        {
            this.selection = selection;
            this.targetUrl = targetUrl;

            Text = "Kristian Liverød Command Center";
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            Bounds = selection.Selected.Screen.Bounds;
            ShowInTaskbar = false;
            TopMost = false;
            KeyPreview = true;
            BackColor = Color.FromArgb(6, 16, 27);

            webView = new WebView2();
            webView.Dock = DockStyle.Fill;
            webView.DefaultBackgroundColor = Color.FromArgb(6, 16, 27);

            fallbackPanel = BuildFallbackPanel();
            Controls.Add(webView);
            Controls.Add(fallbackPanel);
            fallbackPanel.Visible = false;

            Shown += OnShown;
            KeyDown += OnKeyDown;
        }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams parameters = base.CreateParams;
                parameters.ExStyle = (parameters.ExStyle | WsExToolWindow) & ~WsExAppWindow;
                return parameters;
            }
        }

        private async void OnShown(object sender, EventArgs eventArgs)
        {
            Bounds = selection.Selected.Screen.Bounds;
            await StartWebViewAsync();
        }

        private async Task StartWebViewAsync()
        {
            try
            {
                string userDataFolder = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "KristianLiverod", "CommandCenter", "WebView2");
                Directory.CreateDirectory(userDataFolder);

                CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(null, userDataFolder);
                await webView.EnsureCoreWebView2Async(environment);

                CoreWebView2Settings settings = webView.CoreWebView2.Settings;
                settings.AreDefaultContextMenusEnabled = false;
                settings.AreDevToolsEnabled = false;
                settings.AreBrowserAcceleratorKeysEnabled = false;
                settings.IsStatusBarEnabled = false;
                settings.IsZoomControlEnabled = false;

                webView.CoreWebView2.NavigationCompleted += OnNavigationCompleted;
                webView.CoreWebView2.Navigate(targetUrl);
            }
            catch
            {
                ShowFallback("Command Center kunne ikke starte WebView2.", "Kontroller at WebView2 Runtime og loopback-serveren kjører.");
            }
        }

        private void OnNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs eventArgs)
        {
            if (!eventArgs.IsSuccess)
            {
                ShowFallback("Command Center-serveren svarer ikke.", "Start serveren og trykk Prøv igjen.");
            }
        }

        private void ShowFallback(string heading, string detail)
        {
            fallbackPanel.Controls.Clear();
            Label title = new Label();
            title.AutoSize = true;
            title.ForeColor = Color.White;
            title.Font = new Font("Bahnschrift", 26, FontStyle.Bold);
            title.Text = heading;
            title.Location = new Point(70, 70);

            Label body = new Label();
            body.AutoSize = true;
            body.ForeColor = Color.FromArgb(145, 166, 183);
            body.Font = new Font("Bahnschrift", 14, FontStyle.Regular);
            body.Text = detail;
            body.Location = new Point(73, 125);

            Button retry = new Button();
            retry.Text = "Prøv igjen";
            retry.Size = new Size(190, 58);
            retry.Location = new Point(73, 185);
            retry.FlatStyle = FlatStyle.Flat;
            retry.FlatAppearance.BorderColor = Color.FromArgb(65, 199, 217);
            retry.ForeColor = Color.White;
            retry.BackColor = Color.FromArgb(18, 58, 73);
            retry.Click += delegate
            {
                fallbackPanel.Visible = false;
                webView.Visible = true;
                if (webView.CoreWebView2 != null) webView.CoreWebView2.Navigate(targetUrl);
                else StartWebViewAsync();
            };

            fallbackPanel.Controls.Add(title);
            fallbackPanel.Controls.Add(body);
            fallbackPanel.Controls.Add(retry);
            webView.Visible = false;
            fallbackPanel.Visible = true;
            fallbackPanel.BringToFront();
        }

        private Panel BuildFallbackPanel()
        {
            Panel panel = new Panel();
            panel.Dock = DockStyle.Fill;
            panel.BackColor = Color.FromArgb(6, 16, 27);
            return panel;
        }

        private void OnKeyDown(object sender, KeyEventArgs eventArgs)
        {
            if (eventArgs.Control && eventArgs.Shift && eventArgs.KeyCode == Keys.Q)
            {
                Close();
            }
        }
    }

    internal sealed class DisplayInfo
    {
        internal Screen Screen;
        internal string FriendlyName;
        internal string DeviceId;
    }

    internal sealed class MonitorSelection
    {
        internal DisplayInfo Selected;
        internal string Reason;
        internal List<DisplayInfo> Displays;

        internal string ToJson()
        {
            StringBuilder json = new StringBuilder();
            json.Append("{\"selected\":");
            AppendDisplay(json, Selected);
            json.Append(",\"reason\":\"").Append(Escape(Reason)).Append("\",\"displays\":[");
            for (int index = 0; index < Displays.Count; index++)
            {
                if (index > 0) json.Append(",");
                AppendDisplay(json, Displays[index]);
            }
            json.Append("]}");
            return json.ToString();
        }

        private static void AppendDisplay(StringBuilder json, DisplayInfo display)
        {
            Rectangle bounds = display.Screen.Bounds;
            json.Append("{\"deviceName\":\"").Append(Escape(display.Screen.DeviceName))
                .Append("\",\"friendlyName\":\"").Append(Escape(display.FriendlyName))
                .Append("\",\"deviceId\":\"").Append(Escape(display.DeviceId))
                .Append("\",\"width\":").Append(bounds.Width)
                .Append(",\"height\":").Append(bounds.Height)
                .Append(",\"x\":").Append(bounds.X)
                .Append(",\"y\":").Append(bounds.Y)
                .Append(",\"primary\":").Append(display.Screen.Primary ? "true" : "false")
                .Append("}");
        }

        private static string Escape(string value)
        {
            return (value ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"");
        }
    }

    internal static class MonitorSelector
    {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
        private struct DisplayDevice
        {
            public int cb;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
            public string DeviceName;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
            public string DeviceString;
            public int StateFlags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
            public string DeviceID;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
            public string DeviceKey;
        }

        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        private static extern bool EnumDisplayDevices(
            string lpDevice,
            uint deviceIndex,
            ref DisplayDevice displayDevice,
            uint flags);

        internal static MonitorSelection Select(string hints)
        {
            List<DisplayInfo> displays = Enumerate();
            string[] tokens = (hints ?? "").Split(new[] { '|', ',', ';' }, StringSplitOptions.RemoveEmptyEntries);

            DisplayInfo selected = displays.Find(delegate(DisplayInfo display)
            {
                string metadata = (display.FriendlyName + " " + display.DeviceId).ToUpperInvariant();
                foreach (string token in tokens)
                {
                    if (metadata.Contains(token.Trim().ToUpperInvariant())) return true;
                }
                return false;
            });
            string reason = "device-metadata";

            if (selected == null)
            {
                selected = displays.Find(delegate(DisplayInfo display)
                {
                    return display.Screen.Bounds.Width == 2560 && display.Screen.Bounds.Height == 720;
                });
                reason = "exact-resolution";
            }

            if (selected == null)
            {
                selected = displays.Find(delegate(DisplayInfo display)
                {
                    return String.Equals(display.Screen.DeviceName, @"\\.\DISPLAY5", StringComparison.OrdinalIgnoreCase);
                });
                reason = "display5-fallback";
            }

            if (selected == null)
            {
                selected = displays.Find(delegate(DisplayInfo display) { return display.Screen.Primary; }) ?? displays[0];
                reason = "primary-fallback";
            }

            return new MonitorSelection { Selected = selected, Reason = reason, Displays = displays };
        }

        private static List<DisplayInfo> Enumerate()
        {
            List<DisplayInfo> displays = new List<DisplayInfo>();
            foreach (Screen screen in Screen.AllScreens)
            {
                DisplayDevice monitor = new DisplayDevice();
                monitor.cb = Marshal.SizeOf(typeof(DisplayDevice));
                string friendlyName = "";
                string deviceId = "";
                if (EnumDisplayDevices(screen.DeviceName, 0, ref monitor, 0))
                {
                    friendlyName = monitor.DeviceString ?? "";
                    deviceId = monitor.DeviceID ?? "";
                }

                displays.Add(new DisplayInfo
                {
                    Screen = screen,
                    FriendlyName = friendlyName,
                    DeviceId = deviceId
                });
            }
            return displays;
        }
    }
}