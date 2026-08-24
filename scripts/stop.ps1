$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $root ".runtime"

function Stop-OwnedProcess([string]$Name, [string]$PidFile) {
  if (-not (Test-Path -LiteralPath $PidFile)) { return }
  $processId = [int](Get-Content -LiteralPath $PidFile -Raw)
  $process = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $processId) -ErrorAction SilentlyContinue
  if (-not $process) {
    Remove-Item -LiteralPath $PidFile -Force
    return
  }

  $expected = if ($Name -eq "host") {
    Join-Path $root "build\host\CommandCenter.Host.exe"
  } else {
    Join-Path $root "server\index.mjs"
  }
  $identity = (($process.ExecutablePath ?? "") + " " + ($process.CommandLine ?? ""))
  $absoluteOwnerMatch =
    $identity.IndexOf($expected, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
    $identity.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0
  $isNode = [String]::Equals(
    [System.IO.Path]::GetFileName($process.ExecutablePath),
    "node.exe",
    [StringComparison]::OrdinalIgnoreCase)
  $relativeServerMatch =
    $Name -eq "server" -and
    $isNode -and
    $process.CommandLine -match '(?i)(?:^|\s)server[\\/]index\.mjs(?:\s|$)'

  if (-not $absoluteOwnerMatch -and -not $relativeServerMatch) {
    throw "Nekter å stoppe PID ${processId}: prosessen tilhører ikke dette repositoriet"
  }

  Stop-Process -Id $processId
  Remove-Item -LiteralPath $PidFile -Force
  Write-Output ("Stoppet Command Center-" + $Name + " PID " + $processId)
}

Stop-OwnedProcess "host" (Join-Path $runtime "host.pid")
Stop-OwnedProcess "server" (Join-Path $runtime "server.pid")