$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$buildOutput = @(& (Join-Path $PSScriptRoot "build-host.ps1"))
$buildOutput | ForEach-Object { Write-Output $_ }
$executable = [string]($buildOutput | Select-Object -Last 1)
$diagnostics = Join-Path $root ".runtime\host-diagnostics.json"
New-Item -ItemType Directory -Path (Split-Path -Parent $diagnostics) -Force | Out-Null
if (Test-Path -LiteralPath $diagnostics) { Remove-Item -LiteralPath $diagnostics -Force }

$process = Start-Process -FilePath $executable -ArgumentList @("--diagnostics-file", $diagnostics) -WorkingDirectory (Split-Path -Parent $executable) -WindowStyle Hidden -PassThru -Wait
if ($process.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $diagnostics)) {
  throw "Host diagnostics feilet"
}

$result = Get-Content -LiteralPath $diagnostics -Raw | ConvertFrom-Json
if ($result.selected.width -ne 2560 -or $result.selected.height -ne 720) {
  throw "Forventet 2560x720, fikk $($result.selected.width)x$($result.selected.height)"
}
if ($result.reason -notin @("device-metadata", "exact-resolution", "display5-fallback")) {
  throw "Uventet monitorvalg: $($result.reason)"
}

Write-Output ("Host monitor OK: " + $result.selected.deviceName + " via " + $result.reason)