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
        public int OnDeviceStateChanged(string deviceId, uint newState) { owner.Signal(deviceId); return 0; }
        public int OnDeviceAdded(string deviceId) { owner.Signal(deviceId); return 0; }
        public int OnDeviceRemoved(string deviceId) { owner.Signal(deviceId); return 0; }
        public int OnPropertyValueChanged(string deviceId, PropertyKey key) { owner.Signal(deviceId); return 0; }
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
if ($null -eq $config.speakers -or $null -eq $config.headset) {
    throw "Audio output configuration is not configured."
}

$renderRegistryPath = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render"
$endpointTypeProperty = "{a45c254e-df1c-4efd-8020-67d146a850e0},2"
$deviceNameProperty = "{b3f8fa53-0004-438e-9003-51a46e139bfc},6"
$deviceInstanceProperty = "{b3f8fa53-0004-438e-9003-51a46e139bfc},2"
$hardwareIdsProperty = "{9dad2fed-3c19-4cde-b3c9-1bd56be25698},0"
$legacyEndpointIdsProperty = "{4b416b7d-8501-40c1-acfd-97aa9bdc17c8},1"
$script:speakersId = [string]$config.speakers.endpointId
$script:headsetId = [string]$config.headset.endpointId

function Get-RegistryPropertyValue {
    param($Properties, [string]$Key)
    if ($null -eq $Properties) { return $null }
    $property = $Properties.PSObject.Properties | Where-Object { $_.Name -eq $Key } | Select-Object -First 1
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Normalize-AudioName {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return "" }
    $normalized = [regex]::Replace($Value.Trim().ToLowerInvariant(), '\(\d+\-\s*', '(')
    return [regex]::Replace($normalized, '\s+', ' ')
}

function Get-ActiveRenderEndpoints {
    if (-not (Test-Path -LiteralPath $renderRegistryPath)) { return @() }
    $result = @()
    foreach ($key in Get-ChildItem -LiteralPath $renderRegistryPath -ErrorAction SilentlyContinue) {
        $state = Get-ItemPropertyValue -LiteralPath $key.PSPath -Name "DeviceState" -ErrorAction SilentlyContinue
        if ($null -eq $state -or (([int]$state -band 1) -ne 1)) { continue }
        $properties = Get-ItemProperty -LiteralPath (Join-Path $key.PSPath "Properties") -ErrorAction SilentlyContinue
        if ($null -eq $properties) { continue }
        $endpointType = [string](Get-RegistryPropertyValue $properties $endpointTypeProperty)
        $deviceName = [string](Get-RegistryPropertyValue $properties $deviceNameProperty)
        $displayName = if ([string]::IsNullOrWhiteSpace($deviceName)) { $endpointType } else { "$endpointType ($deviceName)" }
        $result += [pscustomobject]@{
            endpointId = "{0.0.0.00000000}.$($key.PSChildName)"
            displayName = $displayName
            normalizedName = Normalize-AudioName $displayName
            endpointType = $endpointType
            deviceName = $deviceName
            deviceInstanceId = [string](Get-RegistryPropertyValue $properties $deviceInstanceProperty)
            hardwareIds = @((Get-RegistryPropertyValue $properties $hardwareIdsProperty) | ForEach-Object { [string]$_ })
            legacyEndpointIds = @((Get-RegistryPropertyValue $properties $legacyEndpointIdsProperty) | ForEach-Object { [string]$_ })
        }
    }
    return @($result)
}

function Select-UniqueEndpoint {
    param([array]$Candidates)
    $items = @($Candidates)
    if ($items.Count -eq 1) { return $items[0] }
    return $null
}

function Resolve-ConfiguredEndpoint {
    param($Entry, [array]$Endpoints)
    $configuredId = [string]$Entry.endpointId
    if (-not [string]::IsNullOrWhiteSpace($configuredId)) {
        $match = Select-UniqueEndpoint @($Endpoints | Where-Object { $_.endpointId.Equals($configuredId, [System.StringComparison]::OrdinalIgnoreCase) })
        if ($null -ne $match) { return $match }
        $match = Select-UniqueEndpoint @($Endpoints | Where-Object {
            @($_.legacyEndpointIds | Where-Object { $_.Equals($configuredId, [System.StringComparison]::OrdinalIgnoreCase) }).Count -gt 0
        })
        if ($null -ne $match) { return $match }
    }

    $deviceInstanceId = [string]$Entry.deviceInstanceId
    if (-not [string]::IsNullOrWhiteSpace($deviceInstanceId)) {
        $match = Select-UniqueEndpoint @($Endpoints | Where-Object { $_.deviceInstanceId.Equals($deviceInstanceId, [System.StringComparison]::OrdinalIgnoreCase) })
        if ($null -ne $match) { return $match }
    }

    $configuredHardwareIds = @($Entry.hardwareIds | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($configuredHardwareIds.Count -gt 0) {
        $match = Select-UniqueEndpoint @($Endpoints | Where-Object {
            $candidate = $_
            @($configuredHardwareIds | Where-Object {
                $configuredHardwareId = $_
                @($candidate.hardwareIds | Where-Object { $_.Equals($configuredHardwareId, [System.StringComparison]::OrdinalIgnoreCase) }).Count -gt 0
            }).Count -gt 0
        })
        if ($null -ne $match) { return $match }
    }

    $normalizedName = Normalize-AudioName ([string]$Entry.name)
    if (-not [string]::IsNullOrWhiteSpace($normalizedName)) {
        return Select-UniqueEndpoint @($Endpoints | Where-Object { $_.normalizedName -eq $normalizedName })
    }
    return $null
}

function Set-ConfigProperty {
    param($Entry, [string]$Name, $Value)
    $existing = $Entry.PSObject.Properties | Where-Object { $_.Name -eq $Name } | Select-Object -First 1
    $before = if ($null -eq $existing) { $null } else { $existing.Value | ConvertTo-Json -Compress }
    $after = $Value | ConvertTo-Json -Compress
    if ($before -eq $after) { return $false }
    $Entry | Add-Member -NotePropertyName $Name -NotePropertyValue $Value -Force
    return $true
}

function Update-ResolvedEndpointConfig {
    param($Entry, $Endpoint)
    if ($null -eq $Endpoint) { return $false }
    $changed = $false
    if (Set-ConfigProperty $Entry "endpointId" $Endpoint.endpointId) { $changed = $true }
    if (Set-ConfigProperty $Entry "deviceInstanceId" $Endpoint.deviceInstanceId) { $changed = $true }
    if (Set-ConfigProperty $Entry "hardwareIds" @($Endpoint.hardwareIds)) { $changed = $true }
    return $changed
}

function Save-AudioOutputConfig {
    $temporaryPath = "$configPath.tmp"
    $json = $config | ConvertTo-Json -Depth 6
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($temporaryPath, $json + [Environment]::NewLine, $encoding)
    Move-Item -LiteralPath $temporaryPath -Destination $configPath -Force
}

function Resolve-AudioOutputConfiguration {
    $endpoints = @(Get-ActiveRenderEndpoints)
    $speakers = Resolve-ConfiguredEndpoint $config.speakers $endpoints
    $headset = Resolve-ConfiguredEndpoint $config.headset $endpoints
    $changed = $false
    if (Update-ResolvedEndpointConfig $config.speakers $speakers) { $changed = $true }
    if (Update-ResolvedEndpointConfig $config.headset $headset) { $changed = $true }
    if ($changed) { Save-AudioOutputConfig }
    if ($null -ne $speakers) { $script:speakersId = [string]$speakers.endpointId }
    if ($null -ne $headset) { $script:headsetId = [string]$headset.endpointId }
    return [pscustomobject]@{ speakers = $speakers; headset = $headset }
}

function Get-AudioOutputStatus {
    $resolved = Resolve-AudioOutputConfiguration
    $speakersAvailable = $null -ne $resolved.speakers -and -not [string]::IsNullOrWhiteSpace($script:speakersId) -and [KristianLiverod.CommandCenter.Audio.AudioOutput]::IsActive($script:speakersId)
    $headsetAvailable = $null -ne $resolved.headset -and -not [string]::IsNullOrWhiteSpace($script:headsetId) -and [KristianLiverod.CommandCenter.Audio.AudioOutput]::IsActive($script:headsetId)
    $defaultId = ""
    try {
        $defaultId = [KristianLiverod.CommandCenter.Audio.AudioOutput]::GetDefaultId()
    } catch {
        $defaultId = ""
    }
    $active = if (-not [string]::IsNullOrWhiteSpace($defaultId) -and $defaultId.Equals($script:speakersId, [System.StringComparison]::OrdinalIgnoreCase)) { "speakers" } elseif (-not [string]::IsNullOrWhiteSpace($defaultId) -and $defaultId.Equals($script:headsetId, [System.StringComparison]::OrdinalIgnoreCase)) { "headset" } else { "other" }
    $defaultName = if ($active -eq "speakers") { [string]$config.speakers.name } elseif ($active -eq "headset") { [string]$config.headset.name } else { "Annen Windows-lydutgang" }
    $availability = if ($speakersAvailable -and $headsetAvailable) { "ready" } elseif (-not $speakersAvailable -and -not $headsetAvailable) { "waiting_for_outputs" } elseif (-not $speakersAvailable) { "waiting_for_speakers" } else { "waiting_for_headset" }
    [pscustomobject]@{
        configured = $true
        ready = $speakersAvailable -and $headsetAvailable
        availability = $availability
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
    $targetAvailable = if ($next -eq "headset") { $current.headsetAvailable } else { $current.speakersAvailable }
    if (-not $targetAvailable) { throw "$next audio endpoint is unavailable." }
    $targetId = if ($next -eq "headset") { $script:headsetId } else { $script:speakersId }
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
