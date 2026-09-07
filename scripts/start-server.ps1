param([switch]$Foreground)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $root ".runtime"
$pidFile = Join-Path $runtime "server.pid"
$stdout = Join-Path $runtime "server.stdout.log"
$stderr = Join-Path $runtime "server.stderr.log"
New-Item -ItemType Directory -Path $runtime -Force | Out-Null

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$node = if ($nodeCommand) { $nodeCommand.Source } else {
  Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
}
if (-not (Test-Path -LiteralPath $node)) { throw "Node.js ble ikke funnet" }

if ($Foreground) {
  Push-Location $root
  try { & $node "server/index.mjs" } finally { Pop-Location }
  exit $LASTEXITCODE
}

if (Test-Path -LiteralPath $pidFile) {
  $existingPid = [int](Get-Content -LiteralPath $pidFile -Raw)
  if (Get-Process -Id $existingPid -ErrorAction SilentlyContinue) {
    Write-Output ("Command Center-server kjører allerede med PID " + $existingPid)
    exit 0
  }
}

$process = Start-Process -FilePath $node -ArgumentList @("server/index.mjs") -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
[System.IO.File]::WriteAllText($pidFile, [string]$process.Id)

for ($attempt = 0; $attempt -lt 30; $attempt++) {
  Start-Sleep -Milliseconds 250
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:4337/health" -TimeoutSec 1
    if ($health.status -eq "ok") {
      Write-Output ("Command Center-server PID " + $process.Id + ", build " + $health.build)
      exit 0
    }
  } catch {}
  if ($process.HasExited) { throw "Command Center-serveren stoppet under oppstart" }
}
throw "Command Center-serveren ble ikke klar på port 4337"