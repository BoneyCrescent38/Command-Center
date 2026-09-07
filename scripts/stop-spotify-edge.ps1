[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$playerUrl = "http://127.0.0.1:4337/spotify-edge-player.html"
$profilePath = Join-Path $env:LOCALAPPDATA "KristianLiverod\CommandCenter\SpotifyEdge"
$escapedProfile = [Regex]::Escape($profilePath)
$escapedPlayerUrl = [Regex]::Escape($playerUrl)

function Get-ProfileProcesses {
    @(Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'" -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandLine -and $_.CommandLine -match $escapedProfile
    })
}

$profileProcesses = Get-ProfileProcesses
$ownedRoot = @($profileProcesses | Where-Object { $_.CommandLine -match $escapedPlayerUrl })
if ($ownedRoot.Count -eq 0) {
    Write-Output "Command Center Spotify Edge is already stopped."
    exit 0
}

if (-not ([System.Management.Automation.PSTypeName]'CommandCenterSpotifyShutdown').Type) {
    Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class CommandCenterSpotifyShutdown
{
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool PostMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);

    public static int Close(int[] processIds)
    {
        var owned = new HashSet<int>(processIds);
        var closed = 0;
        EnumWindows((window, state) =>
        {
            uint processId;
            GetWindowThreadProcessId(window, out processId);
            if (owned.Contains((int)processId))
            {
                PostMessage(window, 0x0010, IntPtr.Zero, IntPtr.Zero);
                closed++;
            }
            return true;
        }, IntPtr.Zero);
        return closed;
    }
}
"@
}

$processIds = @($profileProcesses | ForEach-Object { [int]$_.ProcessId })
[CommandCenterSpotifyShutdown]::Close($processIds) | Out-Null

$deadline = [DateTime]::UtcNow.AddSeconds(6)
do {
    Start-Sleep -Milliseconds 200
    $remaining = Get-ProfileProcesses
} while ($remaining.Count -gt 0 -and [DateTime]::UtcNow -lt $deadline)

if ($remaining.Count -gt 0) {
    $remaining | ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

Write-Output "Command Center Spotify Edge stopped."
