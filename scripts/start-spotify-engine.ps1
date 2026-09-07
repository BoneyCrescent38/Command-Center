[CmdletBinding()]
param(
    [ValidateSet("Shown", "Minimized", "Hidden")]
    [string]$WindowMode = "Hidden"
)

$ErrorActionPreference = "Stop"

$healthUrl = "http://127.0.0.1:4337/health"
$deadline = [DateTime]::UtcNow.AddSeconds(15)
$healthy = $false

do {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 2
        $healthy = $response.StatusCode -eq 200
    } catch {
        $healthy = $false
    }

    if (-not $healthy) {
        Start-Sleep -Milliseconds 300
    }
} while (-not $healthy -and [DateTime]::UtcNow -lt $deadline)

if (-not $healthy) {
    throw "Command Center server did not become healthy before Spotify engine startup."
}

& (Join-Path $PSScriptRoot "start-spotify-edge.ps1") -WindowMode $WindowMode
