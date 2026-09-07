param([switch]$Rebuild, [switch]$Tray)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $root ".runtime"
$pidFile = Join-Path $runtime "control.pid"
$logFile = Join-Path $runtime "control-startup.log"
$executable = Join-Path $root "build\control\CommandCenter.Control.exe"
New-Item -ItemType Directory -Path $runtime -Force | Out-Null

function Write-ControlStartupLog([string]$Message) {
  $line = "[{0}] {1}{2}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss.fff"), $Message, [Environment]::NewLine
  [IO.File]::AppendAllText($logFile, $line, [Text.Encoding]::UTF8)
}

function Show-ExistingControl {
  try {
    $signal = [Threading.EventWaitHandle]::OpenExisting("Local\KristianLiverod.CommandCenter.Control.Show")
    try { [void]$signal.Set() } finally { $signal.Dispose() }
    return $true
  } catch [Threading.WaitHandleCannotBeOpenedException] {
    return $false
  }
}

try {
  Write-ControlStartupLog ("Launcher invoked. Rebuild={0}; Tray={1}" -f $Rebuild.IsPresent, $Tray.IsPresent)
  if (Test-Path -LiteralPath $pidFile) {
    $existingPid = [int](Get-Content -LiteralPath $pidFile -Raw)
    $existing = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
    if ($existing -and $existing.ProcessName -eq "CommandCenter.Control") {
      if (-not $Tray) { [void](Show-ExistingControl) }
      Write-ControlStartupLog ("Existing controller reused. PID=" + $existingPid)
      exit 0
    }
    Remove-Item -LiteralPath $pidFile -Force
    Write-ControlStartupLog ("Removed stale control.pid for PID=" + $existingPid)
  }

  if ($Rebuild -or -not (Test-Path -LiteralPath $executable)) {
    Write-ControlStartupLog "Building controller executable."
    & (Join-Path $PSScriptRoot "build-control.ps1") -Force:$Rebuild | ForEach-Object { Write-ControlStartupLog ([string]$_) }
  }
  if (-not (Test-Path -LiteralPath $executable)) { throw "Controller executable was not produced: $executable" }

  if ($Tray) {
    $process = Start-Process -FilePath $executable -ArgumentList "--tray" -WorkingDirectory (Split-Path -Parent $executable) -PassThru
  } else {
    $process = Start-Process -FilePath $executable -WorkingDirectory (Split-Path -Parent $executable) -PassThru
  }

  for ($attempt = 0; $attempt -lt 50; $attempt++) {
    Start-Sleep -Milliseconds 100
    $process.Refresh()
    if ($process.HasExited) { throw "Command Center Control exited during startup with code $($process.ExitCode)" }
    if (Test-Path -LiteralPath $pidFile) {
      $registeredPid = [int](Get-Content -LiteralPath $pidFile -Raw)
      if ($registeredPid -eq $process.Id -and ($Tray -or $process.MainWindowHandle -ne [IntPtr]::Zero)) {
        Write-ControlStartupLog ("Controller ready. PID=" + $process.Id + "; Visible=" + (-not $Tray))
        Write-Output ("Command Center Control PID " + $process.Id)
        exit 0
      }
    }
  }
  throw "Command Center Control did not expose the expected PID/window within 5 seconds"
} catch {
  $details = ($_ | Out-String).Trim()
  Write-ControlStartupLog ("STARTUP FAILED: " + $details)
  try {
    Add-Type -AssemblyName System.Windows.Forms
    $message = "Command Center Control kunne ikke starte.`r`n`r`nDiagnostisk logg:`r`n$logFile"
    [void][Windows.Forms.MessageBox]::Show($message, "Command Center Control", [Windows.Forms.MessageBoxButtons]::OK, [Windows.Forms.MessageBoxIcon]::Error)
  } catch {}
  exit 1
}
