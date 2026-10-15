param(
    [ValidateSet("Status", "Set", "Watch")]
    [string]$Action = "Status",
    [string]$DeviceId
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

# Capture uses the same Core Audio notification/policy pattern as audio-output.
# No configuration, recording, volume or mute access is needed.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

namespace KristianLiverod.CommandCenter.AudioInput
{
    internal enum EDataFlow { Render = 0, Capture = 1, All = 2 }
    internal enum ERole { Console = 0, Multimedia = 1, Communications = 2 }
    [StructLayout(LayoutKind.Sequential)]
    internal struct PropertyKey { public Guid formatId; public uint propertyId; }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    internal class MMDeviceEnumeratorComObject { }
    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(EDataFlow flow, uint stateMask, out IMMDeviceCollection devices);
        [PreserveSig] int GetDefaultAudioEndpoint(EDataFlow flow, ERole role, out IMMDevice endpoint);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
        [PreserveSig] int RegisterEndpointNotificationCallback(IMMNotificationClient callback);
        [PreserveSig] int UnregisterEndpointNotificationCallback(IMMNotificationClient callback);
    }
    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceCollection
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int Item(uint index, out IMMDevice device);
    }
    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, uint context, IntPtr parameters, out IntPtr instance);
        [PreserveSig] int OpenPropertyStore(uint access, out IPropertyStore properties);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetState(out uint state);
    }
    [ComImport, Guid("1BE09788-6894-4089-8586-9A2A6C265AC5"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMEndpoint { [PreserveSig] int GetDataFlow(out EDataFlow flow); }
    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IPropertyStore
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int GetAt(uint index, out PropertyKey key);
        [PreserveSig] int GetValue(ref PropertyKey key, IntPtr value);
    }
    [ComImport, Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")]
    internal class PolicyConfigClient { }
    [ComImport, Guid("F8679F50-850A-41CF-9C72-430F290290C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IPolicyConfig
    {
        [PreserveSig] int GetMixFormat([MarshalAs(UnmanagedType.LPWStr)] string id, out IntPtr format);
        [PreserveSig] int GetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string id, int defaultFormat, out IntPtr format);
        [PreserveSig] int ResetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string id);
        [PreserveSig] int SetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr endpointFormat, IntPtr mixFormat);
        [PreserveSig] int GetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string id, int defaultPeriod, out long value, out long minimum);
        [PreserveSig] int SetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string id, ref long period);
        [PreserveSig] int GetShareMode([MarshalAs(UnmanagedType.LPWStr)] string id, out IntPtr mode);
        [PreserveSig] int SetShareMode([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr mode);
        [PreserveSig] int GetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string id, ref IntPtr key, out IntPtr value);
        [PreserveSig] int SetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string id, ref IntPtr key, ref IntPtr value);
        [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id, ERole role);
        [PreserveSig] int SetEndpointVisibility([MarshalAs(UnmanagedType.LPWStr)] string id, int visible);
    }
    [ComVisible(true), Guid("7991EEC9-7E89-4D85-8390-6C703CEC60C0"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMNotificationClient
    {
        [PreserveSig] int OnDeviceStateChanged([MarshalAs(UnmanagedType.LPWStr)] string id, uint state);
        [PreserveSig] int OnDeviceAdded([MarshalAs(UnmanagedType.LPWStr)] string id);
        [PreserveSig] int OnDeviceRemoved([MarshalAs(UnmanagedType.LPWStr)] string id);
        [PreserveSig] int OnDefaultDeviceChanged(EDataFlow flow, ERole role, [MarshalAs(UnmanagedType.LPWStr)] string id);
        [PreserveSig] int OnPropertyValueChanged([MarshalAs(UnmanagedType.LPWStr)] string id, PropertyKey key);
    }
    [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
    internal sealed class CaptureNotificationClient : IMMNotificationClient
    {
        private readonly CaptureWatcher owner;
        internal CaptureNotificationClient(CaptureWatcher owner) { this.owner = owner; }
        // Callbacks only signal: COM enumeration happens outside the callback.
        public int OnDeviceStateChanged(string id, uint state) { owner.Signal(); return 0; }
        public int OnDeviceAdded(string id) { owner.Signal(); return 0; }
        public int OnDeviceRemoved(string id) { owner.Signal(); return 0; }
        public int OnPropertyValueChanged(string id, PropertyKey key) { owner.Signal(); return 0; }
        public int OnDefaultDeviceChanged(EDataFlow flow, ERole role, string id)
        { if (flow == EDataFlow.Capture) owner.Signal(); return 0; }
    }
    public sealed class CaptureWatcher : IDisposable
    {
        private IMMDeviceEnumerator enumerator;
        private CaptureNotificationClient callback;
        private readonly AutoResetEvent changed = new AutoResetEvent(false);
        public CaptureWatcher()
        {
            enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
            callback = new CaptureNotificationClient(this);
            Marshal.ThrowExceptionForHR(enumerator.RegisterEndpointNotificationCallback(callback));
        }
        public WaitHandle ChangeEvent { get { return changed; } }
        internal void Signal() { changed.Set(); }
        public void Dispose()
        {
            if (enumerator != null)
            {
                enumerator.UnregisterEndpointNotificationCallback(callback);
                Marshal.ReleaseComObject(enumerator);
                enumerator = null;
                callback = null;
            }
            changed.Dispose();
        }
    }
    public sealed class CaptureDevice { public string Id; public string Name; public bool Available; }
    public static class AudioInput
    {
        [DllImport("ole32.dll")] private static extern int PropVariantClear(IntPtr value);
        private static string FriendlyName(IMMDevice device)
        {
            IPropertyStore properties = null;
            IntPtr value = Marshal.AllocCoTaskMem(IntPtr.Size == 8 ? 24 : 16);
            for (int i = 0; i < (IntPtr.Size == 8 ? 24 : 16); i++) Marshal.WriteByte(value, i, 0);
            try
            {
                Marshal.ThrowExceptionForHR(device.OpenPropertyStore(0, out properties));
                PropertyKey key = new PropertyKey { formatId = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), propertyId = 14 };
                Marshal.ThrowExceptionForHR(properties.GetValue(ref key, value));
                return Marshal.ReadInt16(value) == 31 ? Marshal.PtrToStringUni(Marshal.ReadIntPtr(value, 8)) : "Microphone";
            }
            finally
            {
                PropVariantClear(value);
                Marshal.FreeCoTaskMem(value);
                if (properties != null) Marshal.ReleaseComObject(properties);
            }
        }
        private static bool IsActiveCapture(IMMDevice device)
        {
            uint state;
            EDataFlow flow;
            return device.GetState(out state) == 0 && (state & 1) == 1 &&
                ((IMMEndpoint)device).GetDataFlow(out flow) == 0 && flow == EDataFlow.Capture;
        }
        public static CaptureDevice[] Devices()
        {
            IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
            IMMDeviceCollection devices = null;
            var result = new List<CaptureDevice>();
            try
            {
                Marshal.ThrowExceptionForHR(enumerator.EnumAudioEndpoints(EDataFlow.Capture, 1, out devices));
                uint count;
                Marshal.ThrowExceptionForHR(devices.GetCount(out count));
                for (uint i = 0; i < count; i++)
                {
                    IMMDevice device = null;
                    try
                    {
                        if (devices.Item(i, out device) != 0 || device == null || !IsActiveCapture(device)) continue;
                        string id;
                        Marshal.ThrowExceptionForHR(device.GetId(out id));
                        result.Add(new CaptureDevice { Id = id, Name = FriendlyName(device), Available = true });
                    }
                    catch (COMException) { /* A device can disappear during enumeration. */ }
                    finally { if (device != null) Marshal.ReleaseComObject(device); }
                }
                return result.ToArray();
            }
            finally
            {
                if (devices != null) Marshal.ReleaseComObject(devices);
                Marshal.ReleaseComObject(enumerator);
            }
        }
        public static string DefaultId(int role)
        {
            IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
            IMMDevice device = null;
            try
            {
                if (enumerator.GetDefaultAudioEndpoint(EDataFlow.Capture, (ERole)role, out device) != 0 || device == null) return "";
                string id;
                Marshal.ThrowExceptionForHR(device.GetId(out id));
                return id;
            }
            finally
            {
                if (device != null) Marshal.ReleaseComObject(device);
                Marshal.ReleaseComObject(enumerator);
            }
        }
        public static void SetDefault(string id)
        {
            IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
            IMMDevice device = null;
            try
            {
                if (enumerator.GetDevice(id, out device) != 0 || device == null || !IsActiveCapture(device))
                    throw new InvalidOperationException("capture_target_unavailable");
                IPolicyConfig policy = (IPolicyConfig)new PolicyConfigClient();
                try
                {
                    Marshal.ThrowExceptionForHR(policy.SetDefaultEndpoint(id, ERole.Console));
                    Marshal.ThrowExceptionForHR(policy.SetDefaultEndpoint(id, ERole.Multimedia));
                    Marshal.ThrowExceptionForHR(policy.SetDefaultEndpoint(id, ERole.Communications));
                }
                finally { Marshal.ReleaseComObject(policy); }
            }
            finally
            {
                if (device != null) Marshal.ReleaseComObject(device);
                Marshal.ReleaseComObject(enumerator);
            }
        }
    }
}
'@

function Get-AudioInputStatus {
    $defaultId = [KristianLiverod.CommandCenter.AudioInput.AudioInput]::DefaultId(1)
    $devices = @([KristianLiverod.CommandCenter.AudioInput.AudioInput]::Devices() | Sort-Object Name,Id | ForEach-Object {
        [pscustomobject]@{ id=$_.Id; name=$_.Name; available=$true; active=$_.Id -eq $defaultId }
    })
    $active = $devices | Where-Object { $_.active } | Select-Object -First 1
    [pscustomobject]@{
        ready = $devices.Count -gt 0
        activeId = if ($null -ne $active) { $active.id } else { "" }
        activeName = if ($null -ne $active) { $active.name } else { "" }
        devices = $devices
    }
}

if ($Action -eq "Set") {
    if ([string]::IsNullOrWhiteSpace($DeviceId)) { throw "capture_target_unavailable" }
    [KristianLiverod.CommandCenter.AudioInput.AudioInput]::SetDefault($DeviceId)
    foreach ($role in @(0,1,2)) {
        $actual = [KristianLiverod.CommandCenter.AudioInput.AudioInput]::DefaultId($role)
        if (-not $actual.Equals($DeviceId, [StringComparison]::OrdinalIgnoreCase)) { throw "capture_switch_unconfirmed" }
    }
}

if ($Action -eq "Watch") {
    $watcher = New-Object KristianLiverod.CommandCenter.AudioInput.CaptureWatcher
    try {
        Get-AudioInputStatus | ConvertTo-Json -Depth 4 -Compress | Write-Output
        [Console]::Out.Flush()
        while ($true) {
            [void]$watcher.ChangeEvent.WaitOne()
            Get-AudioInputStatus | ConvertTo-Json -Depth 4 -Compress | Write-Output
            [Console]::Out.Flush()
        }
    } finally { $watcher.Dispose() }
    return
}
Get-AudioInputStatus | ConvertTo-Json -Depth 4 -Compress
