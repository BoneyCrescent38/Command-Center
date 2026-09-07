[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Shown", "Minimized", "Hidden")]
    [string]$Mode,
    [switch]$TargetXeneon,
    [switch]$ActivationFlow
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$playerUrl = "http://127.0.0.1:4337/spotify-edge-player.html"
$profilePath = Join-Path $env:LOCALAPPDATA "KristianLiverod\CommandCenter\SpotifyEdge"
$escapedProfile = [Regex]::Escape($profilePath)
$escapedPlayerUrl = [Regex]::Escape($playerUrl)

$profileProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -and $_.CommandLine -match $escapedProfile
})
$ownedRoot = @($profileProcesses | Where-Object {
    $_.CommandLine -match $escapedPlayerUrl
})

if ($ownedRoot.Count -eq 0) {
    throw "No owned Command Center Spotify Edge root process was found."
}

if (-not ([System.Management.Automation.PSTypeName]'CommandCenterSpotifyWindow').Type) {
    Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class CommandCenterSpotifyWindow
{
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int command);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr SetFocus(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr SetActiveWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint source, uint target, bool attach);

    [DllImport("user32.dll")]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder className, int maximum);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out Rectangle rectangle);

    [StructLayout(LayoutKind.Sequential)]
    private struct Rectangle { public int Left, Top, Right, Bottom; }

    public static int SetMode(int[] processIds, int command, bool targetMonitor, int x, int y, int width, int height)
    {
        var owned = new HashSet<int>(processIds);
        var changed = 0;
        EnumWindows((window, state) =>
        {
            uint processId;
            GetWindowThreadProcessId(window, out processId);
            var className = new StringBuilder(128);
            Rectangle rectangle;
            GetClassName(window, className, className.Capacity);
            GetWindowRect(window, out rectangle);
            var isPlayerWindow = className.ToString() == "Chrome_WidgetWin_1" &&
                rectangle.Right - rectangle.Left > 500 && rectangle.Bottom - rectangle.Top > 300;
            if (owned.Contains((int)processId) && isPlayerWindow)
            {
                if (targetMonitor)
                {
                    uint targetThread;
                    GetWindowThreadProcessId(window, out targetThread);
                    uint foregroundProcess;
                    var foreground = GetForegroundWindow();
                    var foregroundThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, out foregroundProcess);
                    var currentThread = GetCurrentThreadId();
                    if (foregroundThread != 0) AttachThreadInput(currentThread, foregroundThread, true);
                    if (targetThread != 0) AttachThreadInput(currentThread, targetThread, true);
                    ShowWindow(window, 9);
                    SetWindowPos(window, IntPtr.Zero, x, y, width, height, 0x0040);
                    ShowWindow(window, 3);
                    BringWindowToTop(window);
                    SetForegroundWindow(window);
                    SetActiveWindow(window);
                    SetFocus(window);
                    SwitchToThisWindow(window, true);
                    if (targetThread != 0) AttachThreadInput(currentThread, targetThread, false);
                    if (foregroundThread != 0) AttachThreadInput(currentThread, foregroundThread, false);
                }
                else
                {
                    ShowWindow(window, command);
                }
                changed++;
            }
            return true;
        }, IntPtr.Zero);
        return changed;
    }

    public static int SetHostMode(int processId, int command)
    {
        var changed = 0;
        EnumWindows((window, state) =>
        {
            uint windowProcessId;
            GetWindowThreadProcessId(window, out windowProcessId);
            if (windowProcessId == (uint)processId)
            {
                var className = new StringBuilder(128);
                Rectangle rectangle;
                GetClassName(window, className, className.Capacity);
                GetWindowRect(window, out rectangle);
                var isHostWindow = className.ToString().StartsWith("WindowsForms10.Window") &&
                    rectangle.Right - rectangle.Left > 500 && rectangle.Bottom - rectangle.Top > 300;
                if (isHostWindow)
                {
                    ShowWindow(window, command);
                    changed++;
                }
            }
            return true;
        }, IntPtr.Zero);
        return changed;
    }
}
"@
}

$hostPid = 0
if ($ActivationFlow) {
    $hostPidFile = Join-Path $root ".runtime\host.pid"
    if (Test-Path -LiteralPath $hostPidFile) {
        $candidatePid = [int](Get-Content -LiteralPath $hostPidFile -Raw)
        $candidate = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $candidatePid) -ErrorAction SilentlyContinue
        $expectedHost = Join-Path $root "build\host\CommandCenter.Host.exe"
        if ($candidate -and $candidate.ExecutablePath -and
            [String]::Equals(
                [IO.Path]::GetFullPath($candidate.ExecutablePath),
                [IO.Path]::GetFullPath($expectedHost),
                [StringComparison]::OrdinalIgnoreCase)) {
            $hostPid = $candidatePid
        }
    }
}

$showCommand = switch ($Mode) {
    "Hidden" { 0 }
    "Minimized" { 6 }
    default { 9 }
}

$targetMonitor = $false
$targetX = 0
$targetY = 0
$targetWidth = 0
$targetHeight = 0
if ($TargetXeneon -and $Mode -eq "Shown") {
    Add-Type -AssemblyName System.Windows.Forms
    $screen = [System.Windows.Forms.Screen]::AllScreens | Where-Object {
        $_.DeviceName -eq '\\.\DISPLAY5'
    } | Select-Object -First 1
    if (-not $screen) {
        $screen = [System.Windows.Forms.Screen]::AllScreens | Where-Object {
            $_.Bounds.Width -eq 2560 -and $_.Bounds.Height -eq 720
        } | Select-Object -First 1
    }
    if (-not $screen) {
        throw "Xeneon display was not found for Spotify activation."
    }
    $targetMonitor = $true
    $targetX = $screen.Bounds.X
    $targetY = $screen.Bounds.Y
    $targetWidth = $screen.Bounds.Width
    $targetHeight = $screen.Bounds.Height
}

$processIds = @($ownedRoot | ForEach-Object { [int]$_.ProcessId })
if ($ActivationFlow -and $Mode -eq "Shown" -and $hostPid -gt 0) {
    [CommandCenterSpotifyWindow]::SetHostMode($hostPid, 0) | Out-Null
}
$changed = [CommandCenterSpotifyWindow]::SetMode(
    $processIds,
    $showCommand,
    $targetMonitor,
    $targetX,
    $targetY,
    $targetWidth,
    $targetHeight)
if ($ActivationFlow -and $Mode -eq "Hidden" -and $hostPid -gt 0) {
    [CommandCenterSpotifyWindow]::SetHostMode($hostPid, 9) | Out-Null
}
if ($changed -eq 0) {
    throw "The owned Spotify Edge process has no top-level window yet."
}

Write-Output "Set $changed owned Spotify Edge window(s) to $Mode."
