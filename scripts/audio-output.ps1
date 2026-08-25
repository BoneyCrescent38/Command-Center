param(
    [ValidateSet("Status", "Toggle", "Set", "Watch")]
    [string]$Action = "Status",
    [ValidateSet("speakers", "headset")]
    [string]$Target
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $root ".runtime\audio-output.json"
if (-not (Test-Path -LiteralPath $configPath)) {
    throw "Audio output configuration is not configured."
}

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

namespace KristianLiverod.CommandCenter.Audio
{
    internal enum EDataFlow { Render = 0, Capture = 1, All = 2 }
    internal enum ERole { Console = 0, Multimedia = 1, Communications = 2 }

    [StructLayout(LayoutKind.Sequential)]
    internal struct PropertyKey
    {
        public Guid formatId;
        public uint propertyId;
    }

    [ComVisible(true), Guid("7991EEC9-7E89-4D85-8390-6C703CEC60C0"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMNotificationClient
    {
        [PreserveSig] int OnDeviceStateChanged([MarshalAs(UnmanagedType.LPWStr)] string deviceId, uint newState);
        [PreserveSig] int OnDeviceAdded([MarshalAs(UnmanagedType.LPWStr)] string deviceId);
        [PreserveSig] int OnDeviceRemoved([MarshalAs(UnmanagedType.LPWStr)] string deviceId);
        [PreserveSig] int OnDefaultDeviceChanged(EDataFlow flow, ERole role, [MarshalAs(UnmanagedType.LPWStr)] string defaultDeviceId);
        [PreserveSig] int OnPropertyValueChanged([MarshalAs(UnmanagedType.LPWStr)] string deviceId, PropertyKey key);
    }
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    internal class MMDeviceEnumeratorComObject { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(EDataFlow dataFlow, uint stateMask, out IMMDeviceCollection devices);
        [PreserveSig] int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice endpoint);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
        [PreserveSig] int RegisterEndpointNotificationCallback(IMMNotificationClient callback);
        [PreserveSig] int UnregisterEndpointNotificationCallback(IMMNotificationClient callback);
    }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-C0A4D7A9C0F3"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceCollection
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int Item(uint index, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, uint context, IntPtr activationParameters, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
        [PreserveSig] int OpenPropertyStore(uint access, out IntPtr properties);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetState(out uint state);
    }

    [ComImport, Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")]
    internal class PolicyConfigClient { }

    [ComImport, Guid("F8679F50-850A-41CF-9C72-430F290290C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IPolicyConfig
    {
        [PreserveSig] int GetMixFormat([MarshalAs(UnmanagedType.LPWStr)] string deviceId, out IntPtr format);
        [PreserveSig] int GetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string deviceId, int defaultFormat, out IntPtr format);
        [PreserveSig] int ResetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string deviceId);
        [PreserveSig] int SetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string deviceId, IntPtr endpointFormat, IntPtr mixFormat);
        [PreserveSig] int GetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string deviceId, int defaultPeriod, out long defaultValue, out long minimumValue);
        [PreserveSig] int SetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string deviceId, ref long period);
        [PreserveSig] int GetShareMode([MarshalAs(UnmanagedType.LPWStr)] string deviceId, out IntPtr mode);
        [PreserveSig] int SetShareMode([MarshalAs(UnmanagedType.LPWStr)] string deviceId, IntPtr mode);
        [PreserveSig] int GetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string deviceId, ref IntPtr key, out IntPtr value);
        [PreserveSig] int SetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string deviceId, ref IntPtr key, ref IntPtr value);
        [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string deviceId, ERole role);
        [PreserveSig] int SetEndpointVisibility([MarshalAs(UnmanagedType.LPWStr)] string deviceId, int visible);
    }

    [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
    internal sealed class EndpointNotificationClient : IMMNotificationClient
    {
        private readonly DefaultEndpointWatcher owner;
        internal EndpointNotificationClient(DefaultEndpointWatcher owner) { this.owner = owner; }
        public int OnDeviceStateChanged(string deviceId, uint newState) { return 0; }
        public int OnDeviceAdded(string deviceId) { return 0; }
        public int OnDeviceRemoved(string deviceId) { return 0; }
        public int OnPropertyValueChanged(string deviceId, PropertyKey key) { return 0; }
        public int OnDefaultDeviceChanged(EDataFlow flow, ERole role, string defaultDeviceId)
        {
            if (flow == EDataFlow.Render && role == ERole.Multimedia) owner.Signal(defaultDeviceId);
            return 0;
        }
    }

    public sealed class DefaultEndpointWatcher : IDisposable
    {
        private IMMDeviceEnumerator enumerator;
        private EndpointNotificationClient callback;
        private readonly AutoResetEvent changed = new AutoResetEvent(false);
        private string lastDeviceId = String.Empty;

        internal DefaultEndpointWatcher()
        {
            enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
            callback = new EndpointNotificationClient(this);
            int result = enumerator.RegisterEndpointNotificationCallback(callback);
            if (result != 0) Marshal.ThrowExceptionForHR(result, new IntPtr(-1));
        }

        public WaitHandle ChangeEvent { get { return changed; } }
        public string LastDeviceId { get { return lastDeviceId; } }
        internal void Signal(string deviceId)
        {
            lastDeviceId = deviceId ?? String.Empty;
            changed.Set();
        }
        public void Dispose()
        {
            if (enumerator != null)
            {
                if (callback != null) enumerator.UnregisterEndpointNotificationCallback(callback);
                Marshal.ReleaseComObject(enumerator);
                enumerator = null;
                callback = null;
            }
            changed.Dispose();
        }
    }
    public static class AudioOutput
    {
        private static void ThrowIfFailed(int result, string operation)
        {
            if (result != 0) Marshal.ThrowExceptionForHR(result, new IntPtr(-1));
        }

        public static string GetDefaultId()
        {
            IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
            IMMDevice endpoint = null;
            try
            {
                ThrowIfFailed(enumerator.GetDefaultAudioEndpoint(EDataFlow.Render, ERole.Multimedia, out endpoint), "GetDefaultAudioEndpoint");
                string id;
                ThrowIfFailed(endpoint.GetId(out id), "GetId");
                return id;
            }
            finally
            {
                if (endpoint != null) Marshal.ReleaseComObject(endpoint);
                Marshal.ReleaseComObject(enumerator);
            }
        }

        public static bool IsActive(string endpointId)
        {
            IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
            IMMDevice endpoint = null;
            try
            {
                if (enumerator.GetDevice(endpointId, out endpoint) != 0 || endpoint == null) return false;
                uint state;
                ThrowIfFailed(endpoint.GetState(out state), "GetState");
                return (state & 1) == 1;
            }
            finally
            {
                if (endpoint != null) Marshal.ReleaseComObject(endpoint);
                Marshal.ReleaseComObject(enumerator);
            }
        }

        public static void SetDefault(string endpointId)
        {
            IPolicyConfig policy = (IPolicyConfig)(new PolicyConfigClient());
            try
            {
                ThrowIfFailed(policy.SetDefaultEndpoint(endpointId, ERole.Console), "SetDefaultEndpoint Console");
                ThrowIfFailed(policy.SetDefaultEndpoint(endpointId, ERole.Multimedia), "SetDefaultEndpoint Multimedia");
                ThrowIfFailed(policy.SetDefaultEndpoint(endpointId, ERole.Communications), "SetDefaultEndpoint Communications");
            }
            finally
            {
                Marshal.ReleaseComObject(policy);
            }
        }
        public static DefaultEndpointWatcher WatchDefaultEndpoint()
        {
            return new DefaultEndpointWatcher();
        }
    }
}
'@

$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$speakersId = [string]$config.speakers.endpointId
$headsetId = [string]$config.headset.endpointId
if ([string]::IsNullOrWhiteSpace($speakersId) -or [string]::IsNullOrWhiteSpace($headsetId)) {
    throw "Audio endpoint IDs are not configured."
}

function Get-AudioOutputStatus {
    $speakersAvailable = [KristianLiverod.CommandCenter.Audio.AudioOutput]::IsActive($speakersId)
    $headsetAvailable = [KristianLiverod.CommandCenter.Audio.AudioOutput]::IsActive($headsetId)
    if (-not $speakersAvailable -or -not $headsetAvailable) {
        throw "One or more configured audio endpoints are unavailable."
    }
    $defaultId = [KristianLiverod.CommandCenter.Audio.AudioOutput]::GetDefaultId()
    $active = if ($defaultId.Equals($speakersId, [System.StringComparison]::OrdinalIgnoreCase)) { "speakers" } elseif ($defaultId.Equals($headsetId, [System.StringComparison]::OrdinalIgnoreCase)) { "headset" } else { "other" }
    $defaultName = if ($active -eq "speakers") { [string]$config.speakers.name } elseif ($active -eq "headset") { [string]$config.headset.name } else { "Annen Windows-lydutgang" }
    [pscustomobject]@{
        configured = $true
        active = $active
        defaultId = $defaultId
        defaultName = $defaultName
        speakersAvailable = $speakersAvailable
        headsetAvailable = $headsetAvailable
        speakersName = [string]$config.speakers.name
        headsetName = [string]$config.headset.name
    }
}

if ($Action -eq "Toggle" -or $Action -eq "Set") {
    $current = Get-AudioOutputStatus
    $next = if ($Action -eq "Set") { $Target } elseif ($current.active -eq "speakers") { "headset" } else { "speakers" }
    $targetId = if ($next -eq "headset") { $headsetId } else { $speakersId }
    [KristianLiverod.CommandCenter.Audio.AudioOutput]::SetDefault($targetId)
    Start-Sleep -Milliseconds 300
    $defaultId = [KristianLiverod.CommandCenter.Audio.AudioOutput]::GetDefaultId()
    if (-not $defaultId.Equals($targetId, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Windows did not confirm the requested default audio endpoint."
    }
}

if ($Action -eq "Watch") {
    $watcher = [KristianLiverod.CommandCenter.Audio.AudioOutput]::WatchDefaultEndpoint()
    try {
        Get-AudioOutputStatus | ConvertTo-Json -Compress | Write-Output
        [Console]::Out.Flush()
        while ($true) {
            [void]$watcher.ChangeEvent.WaitOne()
            Get-AudioOutputStatus | ConvertTo-Json -Compress | Write-Output
            [Console]::Out.Flush()
        }
    } finally {
        $watcher.Dispose()
    }
    return
}

Get-AudioOutputStatus | ConvertTo-Json -Compress