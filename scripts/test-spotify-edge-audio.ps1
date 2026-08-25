[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$profilePath = Join-Path $env:LOCALAPPDATA "KristianLiverod\CommandCenter\SpotifyEdge"
$playerUrl = "http://127.0.0.1:4337/spotify-edge-player.html"
$escapedProfile = [Regex]::Escape($profilePath)
$escapedPlayerUrl = [Regex]::Escape($playerUrl)
$profileProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -and $_.CommandLine -match $escapedProfile
})
$ownedRoot = @($profileProcesses | Where-Object { $_.CommandLine -match $escapedPlayerUrl })
if ($ownedRoot.Count -eq 0) {
    throw "No owned Command Center Spotify Edge root process was found."
}

if (-not ([System.Management.Automation.PSTypeName]'CommandCenterSpotifyAudioProbe').Type) {
    Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class CommandCenterSpotifyAudioProbe
{
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] private class DeviceEnumerator { }
    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
    private interface IDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int flow, uint state, out IntPtr devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IntPtr device);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, [MarshalAs(UnmanagedType.Interface)] out IDevice device);
    }
    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("D666063F-1587-4E43-81F1-B948E807363F")]
    private interface IDevice
    {
        [PreserveSig] int Activate(ref Guid id, uint context, IntPtr parameters, [MarshalAs(UnmanagedType.Interface)] out object instance);
        [PreserveSig] int OpenPropertyStore(uint access, out IntPtr properties);
        [PreserveSig] int GetId(out IntPtr id);
        [PreserveSig] int GetState(out uint state);
    }
    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F")]
    private interface ISessionManager
    {
        [PreserveSig] int GetAudioSessionControl(out IntPtr control);
        [PreserveSig] int GetSimpleAudioVolume(out IntPtr volume);
        [PreserveSig] int GetSessionEnumerator([MarshalAs(UnmanagedType.Interface)] out ISessionEnumerator sessions);
    }
    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8")]
    private interface ISessionEnumerator
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int GetSession(int index, [MarshalAs(UnmanagedType.Interface)] out ISessionControl control);
    }
    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD")]
    private interface ISessionControl
    {
        [PreserveSig] int GetState(out int state);
        [PreserveSig] int GetDisplayName(out IntPtr name);
        [PreserveSig] int SetDisplayName(IntPtr name, ref Guid context);
        [PreserveSig] int GetIconPath(out IntPtr path);
        [PreserveSig] int SetIconPath(IntPtr path, ref Guid context);
        [PreserveSig] int GetGroupingParam(out Guid group);
        [PreserveSig] int SetGroupingParam(ref Guid group, ref Guid context);
        [PreserveSig] int RegisterAudioSessionNotification(IntPtr client);
        [PreserveSig] int UnregisterAudioSessionNotification(IntPtr client);
    }
    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D")]
    private interface ISessionControl2
    {
        [PreserveSig] int GetState(out int state);
        [PreserveSig] int GetDisplayName(out IntPtr name);
        [PreserveSig] int SetDisplayName(IntPtr name, ref Guid context);
        [PreserveSig] int GetIconPath(out IntPtr path);
        [PreserveSig] int SetIconPath(IntPtr path, ref Guid context);
        [PreserveSig] int GetGroupingParam(out Guid group);
        [PreserveSig] int SetGroupingParam(ref Guid group, ref Guid context);
        [PreserveSig] int RegisterAudioSessionNotification(IntPtr client);
        [PreserveSig] int UnregisterAudioSessionNotification(IntPtr client);
        [PreserveSig] int GetSessionIdentifier(out IntPtr id);
        [PreserveSig] int GetSessionInstanceIdentifier(out IntPtr id);
        [PreserveSig] int GetProcessId(out uint processId);
    }
    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8")]
    private interface ISimpleVolume
    {
        [PreserveSig] int SetMasterVolume(float level, ref Guid context);
        [PreserveSig] int GetMasterVolume(out float level);
        [PreserveSig] int SetMute(bool muted, ref Guid context);
        [PreserveSig] int GetMute(out bool muted);
    }

    public static bool HasActiveSession(string endpointId, int[] processIds)
    {
        var owned = new HashSet<int>(processIds);
        var enumerator = (IDeviceEnumerator)new DeviceEnumerator();
        IDevice device;
        var result = enumerator.GetDevice(endpointId, out device);
        if (result != 0) Marshal.ThrowExceptionForHR(result);
        var managerId = typeof(ISessionManager).GUID;
        object managerObject;
        result = device.Activate(ref managerId, 23, IntPtr.Zero, out managerObject);
        if (result != 0) Marshal.ThrowExceptionForHR(result);
        ISessionEnumerator sessions;
        result = ((ISessionManager)managerObject).GetSessionEnumerator(out sessions);
        if (result != 0) Marshal.ThrowExceptionForHR(result);
        int count;
        sessions.GetCount(out count);
        for (var index = 0; index < count; index++)
        {
            ISessionControl control;
            if (sessions.GetSession(index, out control) != 0 || control == null) continue;
            var control2 = (ISessionControl2)control;
            var volume = (ISimpleVolume)control;
            uint processId;
            int state;
            float level;
            bool muted;
            control2.GetProcessId(out processId);
            control.GetState(out state);
            volume.GetMasterVolume(out level);
            volume.GetMute(out muted);
            if (owned.Contains((int)processId) && state == 1 && !muted && level > 0) return true;
        }
        return false;
    }
}
"@
}

$processIds = @($profileProcesses | ForEach-Object { [int]$_.ProcessId })
$active = $false
$renderRoot = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render"
foreach ($endpoint in @(Get-ChildItem -LiteralPath $renderRoot | Where-Object {
    (Get-ItemProperty -LiteralPath $_.PSPath).DeviceState -eq 1
})) {
    $endpointId = "{0.0.0.00000000}." + $endpoint.PSChildName
    if ([CommandCenterSpotifyAudioProbe]::HasActiveSession($endpointId, $processIds)) {
        $active = $true
        break
    }
}

[pscustomobject]@{ active = $active; processCount = $processIds.Count } | ConvertTo-Json -Compress
