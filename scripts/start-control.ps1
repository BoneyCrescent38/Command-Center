param([switch]$Rebuild, [switch]$Tray)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $root ".runtime"
$pidFile = Join-Path $runtime "control.pid"
$executable = Join-Path $root "build\control\CommandCenter.Control.exe"
New-Item -ItemType Directory -Path $runtime -Force | Out-Null

if (Test-Path -LiteralPath $pidFile) {
  $existingPid = [int](Get-Content -LiteralPath $pidFile -Raw)
  $existing = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
  if ($existing -and $existing.ProcessName -eq "CommandCenter.Control") {
    Write-Output ("Command Center Control kjører allerede med PID " + $existingPid)
    exit 0
  }
  Remove-Item -LiteralPath $pidFile -Force
}

if ($Rebuild -or -not (Test-Path -LiteralPath $executable)) {
  & (Join-Path $PSScriptRoot "build-control.ps1") -Force:$Rebuild | Out-Host
}

$arguments = if ($Tray) { @("--tray") } else { @() }
$process = Start-Process -FilePath $executable -ArgumentList $arguments -WorkingDirectory (Split-Path -Parent $executable) -PassThru
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  Start-Sleep -Milliseconds 100
  if ($process.HasExited) { throw "Command Center Control stoppet under oppstart" }
  if (Test-Path -LiteralPath $pidFile) {
    $registeredPid = [int](Get-Content -LiteralPath $pidFile -Raw)
    if ($registeredPid -eq $process.Id) {
      Write-Output ("Command Center Control PID " + $process.Id)
      exit 0
    }
  }
}
throw "Command Center Control ble ikke klar"
