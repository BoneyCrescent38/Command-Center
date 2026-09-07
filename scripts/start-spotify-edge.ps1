[CmdletBinding()]
param(
    [ValidateSet("Shown", "Minimized", "Hidden")]
    [string]$WindowMode = "Shown"
)

$ErrorActionPreference = "Stop"

$playerUrl = "http://127.0.0.1:4337/spotify-edge-player.html"
$profilePath = Join-Path $env:LOCALAPPDATA "KristianLiverod\CommandCenter\SpotifyEdge"
$windowScript = Join-Path $PSScriptRoot "set-spotify-edge-window.ps1"
$edgeCandidates = @(
    (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"),
    (Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe"),
    (Join-Path $env:LOCALAPPDATA "Microsoft\Edge\Application\msedge.exe")
)

function Get-OwnedSpotifyEdgeRoot {
    $escapedProfile = [Regex]::Escape($profilePath)
    $escapedPlayerUrl = [Regex]::Escape($playerUrl)

    @(Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'" -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandLine -and
        $_.CommandLine -match $escapedProfile -and
        $_.CommandLine -match $escapedPlayerUrl
    })
}

function Set-PlayerWindowMode {
    param([string]$Mode)

    if ($Mode -eq "Shown") {
        return
    }

    if (-not (Test-Path -LiteralPath $windowScript)) {
        throw "Window controller is missing: $windowScript"
    }

    & $windowScript -Mode $Mode | Out-Null
}

$ownedRoot = Get-OwnedSpotifyEdgeRoot | Select-Object -First 1
if ($ownedRoot) {
    Set-PlayerWindowMode -Mode $WindowMode
    Write-Output "Command Center Spotify Edge is already running (PID $($ownedRoot.ProcessId))."
    exit 0
}

$edgePath = $edgeCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $edgePath) {
    throw "Microsoft Edge was not found."
}

New-Item -ItemType Directory -Path $profilePath -Force | Out-Null

$arguments = @(
    "--user-data-dir=$profilePath",
    "--app=$playerUrl",
    "--no-first-run",
    "--no-default-browser-check"
)

Start-Process -FilePath $edgePath -ArgumentList $arguments | Out-Null

$deadline = [DateTime]::UtcNow.AddSeconds(12)
do {
    Start-Sleep -Milliseconds 250
    $ownedRoot = Get-OwnedSpotifyEdgeRoot | Select-Object -First 1
} while (-not $ownedRoot -and [DateTime]::UtcNow -lt $deadline)

if (-not $ownedRoot) {
    throw "The dedicated Spotify Edge process did not register with the expected profile and player URL."
}

Set-PlayerWindowMode -Mode $WindowMode
Write-Output "Command Center Spotify Edge started (PID $($ownedRoot.ProcessId), mode $WindowMode)."
