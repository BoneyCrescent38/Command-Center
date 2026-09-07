param([switch]$Rebuild)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $root ".runtime"
$pidFile = Join-Path $runtime "host.pid"
$executable = Join-Path $root "build\host\CommandCenter.Host.exe"

& (Join-Path $PSScriptRoot "start-server.ps1")

# Keep the isolated Spotify audio engine aligned with controller Start/Restart.
try {
  & (Join-Path $PSScriptRoot "start-spotify-engine.ps1") -WindowMode Hidden | Out-Null
} catch {
  Write-Warning ("Spotify audio engine did not start: " + $_.Exception.Message)
}
if ($Rebuild -or -not (Test-Path -LiteralPath $executable)) {
  $executable = & (Join-Path $PSScriptRoot "build-host.ps1") -Force:$Rebuild
}

if (Test-Path -LiteralPath $pidFile) {
  $existingPid = [int](Get-Content -LiteralPath $pidFile -Raw)
  if (Get-Process -Id $existingPid -ErrorAction SilentlyContinue) {
    Write-Output ("Command Center-host kjører allerede med PID " + $existingPid)
    exit 0
  }
}

$process = Start-Process -FilePath $executable -ArgumentList @("--url", "http://127.0.0.1:4337") -WorkingDirectory (Split-Path -Parent $executable) -PassThru
[System.IO.File]::WriteAllText($pidFile, [string]$process.Id)
Write-Output ("Command Center-host PID " + $process.Id)