[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Shown", "Minimized", "Hidden")]
    [string]$Mode
)

$ErrorActionPreference = "Stop"

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

public static class CommandCenterSpotifyWindow
{
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int command);

    public static int SetMode(int[] processIds, int command)
    {
        var owned = new HashSet<int>(processIds);
        var changed = 0;
        EnumWindows((window, state) =>
        {
            uint processId;
            GetWindowThreadProcessId(window, out processId);
            if (owned.Contains((int)processId))
            {
                ShowWindow(window, command);
                changed++;
            }
            return true;
        }, IntPtr.Zero);
        return changed;
    }
}
"@
}

$showCommand = switch ($Mode) {
    "Hidden" { 0 }
    "Minimized" { 6 }
    default { 9 }
}

$processIds = @($profileProcesses | ForEach-Object { [int]$_.ProcessId })
$changed = [CommandCenterSpotifyWindow]::SetMode($processIds, $showCommand)
if ($changed -eq 0) {
    throw "The owned Spotify Edge process has no top-level window yet."
}

Write-Output "Set $changed owned Spotify Edge window(s) to $Mode."
