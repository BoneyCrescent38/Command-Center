[CmdletBinding()]
param(
    [ValidateSet('Status', 'Start', 'Stop', 'Restart')]
    [string]$Action = 'Status',

    [ValidateSet('Test')]
    [string]$Environment = 'Test',

    [Parameter(Mandatory = $true)]
    [string]$Root,

    [Parameter(Mandatory = $true)]
    [int]$Port,

    [Parameter(Mandatory = $true)]
    [string]$PidPath,

    [Parameter(Mandatory = $true)]
    [string]$LauncherPath,

    [string]$ResultPath
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$Root = [IO.Path]::GetFullPath($Root).TrimEnd('\')
$PidPath = [IO.Path]::GetFullPath($PidPath)
$LauncherPath = [IO.Path]::GetFullPath($LauncherPath)
$ExpectedPidPath = [IO.Path]::GetFullPath((Join-Path $Root 'data\v3-preview\runtime\kif-server.pid'))
$ExpectedLauncherPath = [IO.Path]::GetFullPath((Join-Path $Root 'start_v3_preview.ps1'))
$ExpectedPython = [IO.Path]::GetFullPath((Join-Path $Root '.venv\Scripts\python.exe'))
$ExpectedCommandLine = '"' + $ExpectedPython + '" -I -B -X utf8 scripts\run_server.py'

if ($Port -ne 8126) { throw 'KIF Test control requires canonical preview port 8126.' }
if (-not $PidPath.Equals($ExpectedPidPath, [StringComparison]::OrdinalIgnoreCase)) { throw 'KIF Test PID path does not match the canonical preview root.' }
if (-not $LauncherPath.Equals($ExpectedLauncherPath, [StringComparison]::OrdinalIgnoreCase)) { throw 'KIF Test launcher does not match the canonical preview root.' }
if ($Root.Equals('C:\ChatGPT App\KIF-Vanskebygger-App', [StringComparison]::OrdinalIgnoreCase)) { throw 'KIF Test cannot target the production root.' }
if (-not (Test-Path -LiteralPath $Root -PathType Container)) { throw 'KIF Test root is unavailable.' }
if (-not (Test-Path -LiteralPath $LauncherPath -PathType Leaf)) { throw 'KIF Test launcher is unavailable.' }

function Get-ListenerPid {
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalAddress -eq '127.0.0.1' })
    if ($listeners.Count -gt 1) { throw 'Multiple listeners were found on the canonical KIF Test endpoint.' }
    if ($listeners.Count -eq 1) { return [Nullable[int]]([int]$listeners[0].OwningProcess) }
    return $null
}

function Get-PidFileValue {
    if (-not (Test-Path -LiteralPath $PidPath -PathType Leaf)) { return $null }
    $value = 0
    $raw = (Get-Content -LiteralPath $PidPath -Raw -Encoding ASCII).Trim()
    if (-not [int]::TryParse($raw, [ref]$value) -or $value -le 0) { throw 'KIF Test PID file is invalid.' }
    return [Nullable[int]]$value
}

function Get-ProcessDetails([Nullable[int]]$ProcessId) {
    if ($null -eq $ProcessId) { return $null }
    return Get-CimInstance Win32_Process -Filter ('ProcessId={0}' -f ([int]$ProcessId)) -ErrorAction SilentlyContinue
}

function Get-BasePython {
    if (-not (Test-Path -LiteralPath $ExpectedPython -PathType Leaf)) { return $null }
    $value = (& $ExpectedPython -I -B -X utf8 -c 'import sys; print(sys._base_executable)' 2>$null | Select-Object -Last 1)
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($value)) { return $null }
    return [IO.Path]::GetFullPath(([string]$value).Trim())
}

function Get-PreviewIdentity {
    $listenerPid = Get-ListenerPid
    $pidFilePid = Get-PidFileValue
    $process = Get-ProcessDetails -ProcessId $listenerPid
    $owned = $false
    $detail = 'Stopped'

    if ($null -ne $listenerPid -or $null -ne $pidFilePid) {
        $detail = 'Preview identity is incomplete'
        if ($null -ne $listenerPid -and $null -ne $pidFilePid -and ([int]$listenerPid) -eq ([int]$pidFilePid) -and $null -ne $process) {
            $basePython = Get-BasePython
            $actualExecutable = if ($process.ExecutablePath) { [IO.Path]::GetFullPath([string]$process.ExecutablePath) } else { '' }
            $actualCommandLine = ([string]$process.CommandLine).Trim()
            $listeners = @(Get-NetTCPConnection -State Listen -OwningProcess ([int]$listenerPid) -ErrorAction SilentlyContinue)
            $previewListeners = @($listeners | Where-Object { $_.LocalAddress -eq '127.0.0.1' -and [int]$_.LocalPort -eq $Port })
            $ownsProductionPort = @($listeners | Where-Object { [int]$_.LocalPort -eq 8000 }).Count -gt 0
            $owned = $null -ne $basePython -and
                $actualExecutable.Equals($basePython, [StringComparison]::OrdinalIgnoreCase) -and
                $actualCommandLine.Equals($ExpectedCommandLine, [StringComparison]::OrdinalIgnoreCase) -and
                $previewListeners.Count -eq 1 -and
                -not $ownsProductionPort
            $detail = if ($owned) { 'Ownership verified' } else { 'Preview process ownership mismatch' }
        }
    }

    return [pscustomobject]@{
        ListenerPid = $listenerPid
        PidFilePid = $pidFilePid
        Process = $process
        Owned = [bool]$owned
        Detail = $detail
    }
}

function Get-GitMetadata {
    $commit = (& git -C $Root rev-parse HEAD 2>$null | Select-Object -First 1)
    $branch = (& git -C $Root rev-parse --abbrev-ref HEAD 2>$null | Select-Object -First 1)
    return [pscustomobject]@{ Commit = [string]$commit; Branch = [string]$branch }
}

function Get-Health {
    try {
        $response = Invoke-RestMethod -Uri ('http://127.0.0.1:{0}/health' -f $Port) -Method Get -TimeoutSec 3 -Headers @{ 'Cache-Control' = 'no-cache' }
        $version = if ($response.appVersion) { [string]$response.appVersion } else { [string]$response.version }
        $build = if ($response.releaseCommit) { [string]$response.releaseCommit } else { [string]$response.build }
        return [pscustomobject]@{ Reachable = $true; Healthy = ([string]$response.app -eq 'ok' -or [string]$response.status -eq 'ok'); Version = $version; Build = $build; Error = $null }
    }
    catch {
        return [pscustomobject]@{ Reachable = $false; Healthy = $false; Version = $null; Build = $null; Error = $_.Exception.Message }
    }
}

function Stop-Preview {
    $identity = Get-PreviewIdentity
    if ($null -eq $identity.ListenerPid -and $null -eq $identity.PidFilePid) { return }
    if (-not $identity.Owned) { throw 'Refusing to stop a KIF Test process without exact ownership verification.' }

    $process = $identity.Process
    $creationIdentity = [string]$process.CreationDate
    $confirmed = Get-ProcessDetails -ProcessId $identity.ListenerPid
    if ($null -eq $confirmed -or [string]$confirmed.CreationDate -cne $creationIdentity -or ([string]$confirmed.CommandLine).Trim() -cne $ExpectedCommandLine) {
        throw 'KIF Test process identity changed during stop verification.'
    }

    Stop-Process -Id ([int]$identity.ListenerPid) -ErrorAction Stop
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while ((Get-Process -Id ([int]$identity.ListenerPid) -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 250 }
    if (Get-Process -Id ([int]$identity.ListenerPid) -ErrorAction SilentlyContinue) { throw 'KIF Test process did not stop in time.' }
    if ((Test-Path -LiteralPath $PidPath) -and (Get-Content -LiteralPath $PidPath -Raw -Encoding ASCII).Trim() -eq [string]$identity.PidFilePid) {
        Remove-Item -LiteralPath $PidPath -Force
    }
}

function Start-Preview {
    $identity = Get-PreviewIdentity
    if ($null -ne $identity.ListenerPid) {
        if ($identity.Owned) { return }
        throw 'KIF Test port is occupied by an unverified process.'
    }
    if ($null -ne $identity.PidFilePid) {
        $staleProcess = Get-ProcessDetails -ProcessId $identity.PidFilePid
        if ($null -ne $staleProcess) { throw 'KIF Test PID file identifies a live process without the canonical listener.' }
        Remove-Item -LiteralPath $PidPath -Force
    }

    $git = Get-GitMetadata
    if ([string]::IsNullOrWhiteSpace($git.Commit)) { throw 'Could not resolve the KIF Test checkout commit.' }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $LauncherPath -Port $Port -ExpectedReleaseCommit $git.Commit
    if ($LASTEXITCODE -ne 0) { throw ('KIF Test launcher exited with code {0}.' -f $LASTEXITCODE) }
    $started = Get-PreviewIdentity
    if (-not $started.Owned) { throw 'KIF Test started without canonical ownership verification.' }
}

if ($Action -eq 'Stop' -or $Action -eq 'Restart') { Stop-Preview }
if ($Action -eq 'Start' -or $Action -eq 'Restart') { Start-Preview }

$identity = Get-PreviewIdentity
$health = Get-Health
$git = Get-GitMetadata
$state = if ($health.Healthy -and $identity.Owned) { 'Running' } elseif ($null -ne $identity.ListenerPid -or $health.Reachable) { 'Degraded' } else { 'Stopped' }
$result = [ordered]@{
    schemaVersion = 1
    serviceId = 'kif-test'
    displayName = 'KIF Test'
    environment = 'Test'
    state = $state
    healthy = [bool]$health.Healthy
    reachable = [bool]$health.Reachable
    ownedProcess = [bool]$identity.Owned
    processId = $identity.ListenerPid
    port = $Port
    healthUrl = ('http://127.0.0.1:{0}/health' -f $Port)
    root = $Root
    version = $health.Version
    build = $health.Build
    commit = $git.Commit
    branch = $git.Branch
    error = $health.Error
    autoStartPolicy = 'ManualOnly'
    autoStartEnabled = $false
    autoStartAllowed = $false
    elevatedActionRequired = $false
    checkedAt = [DateTime]::UtcNow.ToString('o')
    action = $Action
    success = $true
    messageSafe = if ($Action -eq 'Status') { $identity.Detail } else { ('{0} completed.' -f $Action) }
}
$json = $result | ConvertTo-Json -Depth 6 -Compress
if (-not [string]::IsNullOrWhiteSpace($ResultPath)) {
    $parent = Split-Path -Parent $ResultPath
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    [IO.File]::WriteAllText($ResultPath, $json, [Text.UTF8Encoding]::new($false))
}
Write-Output $json
