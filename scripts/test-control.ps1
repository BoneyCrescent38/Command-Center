param([switch]$ExerciseRuntime)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$executable = Join-Path $root "build\control\CommandCenter.Control.exe"
$runtime = Join-Path $root ".runtime"
& (Join-Path $PSScriptRoot "build-control.ps1") | Out-Host

function Invoke-ControlAction([string]$Action) {
  $resultFile = Join-Path $env:TEMP ("command-center-control-" + [guid]::NewGuid().ToString("N") + ".json")
  try {
    $process = Start-Process -FilePath $executable -ArgumentList @("--action", $Action, "--result-file", $resultFile) -WorkingDirectory (Split-Path -Parent $executable) -WindowStyle Hidden -PassThru -Wait
    if (-not (Test-Path -LiteralPath $resultFile)) { throw "Controller action manglet resultat: $Action" }
    $result = Get-Content -LiteralPath $resultFile -Raw | ConvertFrom-Json
    if ($process.ExitCode -ne 0 -or -not $result.success) { throw "Controller action feilet ($Action): $($result.message)" }
    return $result
  } finally {
    if (Test-Path -LiteralPath $resultFile) { Remove-Item -LiteralPath $resultFile -Force }
  }
}

$autoStart = Get-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "Kristian Liverod Command Center Control" -ErrorAction SilentlyContinue
if ($autoStart) { throw "Controller-autostart skal være av før fysisk godkjenning" }
$status = Invoke-ControlAction "status"
Write-Output ("Controller status OK: server=" + $status.serverOnline + ", host=" + $status.hostRunning)

if ($ExerciseRuntime) {
  $before = Invoke-ControlAction "status"
  $startExisting = Invoke-ControlAction "start"
  if ($before.serverOnline -and $before.hostRunning -and ($startExisting.serverPid -ne $before.serverPid -or $startExisting.hostPid -ne $before.hostPid)) { throw "Start opprettet duplikat mens runtime allerede kjørte" }
  $stopped = Invoke-ControlAction "stop"
  if ($stopped.serverProcessRunning -or $stopped.hostRunning) { throw "Stop lot runtime kjøre" }
  $stoppedAgain = Invoke-ControlAction "stop"
  if ($stoppedAgain.serverProcessRunning -or $stoppedAgain.hostRunning) { throw "Idempotent stop feilet" }
  & (Join-Path $PSScriptRoot "build-host.ps1") | Out-Host
  $started = Invoke-ControlAction "start"
  if (-not $started.serverOnline -or -not $started.hostRunning) { throw "Start gjorde ikke runtime klar" }
  $restarted = Invoke-ControlAction "restart"
  if (-not $restarted.serverOnline -or -not $restarted.hostRunning) { throw "Restart gjorde ikke runtime klar" }
  if ($restarted.serverPid -eq $started.serverPid -or $restarted.hostPid -eq $started.hostPid) { throw "Restart beholdt en gammel runtime-PID" }
  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 4337 -ErrorAction SilentlyContinue)
  $hosts = @(Get-Process -Name "CommandCenter.Host" -ErrorAction SilentlyContinue)
  if ($listeners.Count -ne 1 -or $hosts.Count -ne 1) { throw "Forventet én server-listener og én host-instans" }
  Write-Output ("Runtime actions OK: server PID " + $restarted.serverPid + ", host PID " + $restarted.hostPid)
}

$controller = Start-Process -FilePath $executable -WorkingDirectory (Split-Path -Parent $executable) -PassThru
try {
  if (-not $controller.WaitForInputIdle(5000)) { throw "Controlleren ble ikke klar for input" }
  Start-Sleep -Milliseconds 300
  $windowHandle = [IntPtr]::Zero
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 100
    $controller.Refresh()
    $windowHandle = $controller.MainWindowHandle
    if ($windowHandle -ne [IntPtr]::Zero) { break }
  }
  if ($windowHandle -eq [IntPtr]::Zero) { throw "Controller-vinduet ble ikke synlig" }
  $native = Add-Type -MemberDefinition '[DllImport("user32.dll", SetLastError=true)] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);' -Name "ControlWindowTest" -Namespace "CommandCenter.Tests" -PassThru
  if (-not $native::PostMessage($windowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) { throw "WM_CLOSE til controller feilet" }
  Start-Sleep -Milliseconds 700
  if ($controller.HasExited) { throw "X lukket controlleren i stedet for å minimere til tray" }
  Write-Output "Tray close OK: controller forble kjørende"
} finally {
  if (-not $controller.HasExited -and $controller.ProcessName -eq "CommandCenter.Control") {
    Stop-Process -Id $controller.Id
    Wait-Process -Id $controller.Id -Timeout 5 -ErrorAction SilentlyContinue
  }
  $controlPidFile = Join-Path $runtime "control.pid"
  if (Test-Path -LiteralPath $controlPidFile) {
    $recorded = [int](Get-Content -LiteralPath $controlPidFile -Raw)
    if (-not (Get-Process -Id $recorded -ErrorAction SilentlyContinue)) { Remove-Item -LiteralPath $controlPidFile -Force }
  }
}
Write-Output "Command Center Control test OK"
