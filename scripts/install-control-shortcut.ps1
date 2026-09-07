param([string]$ShortcutName = "Command Center Control")

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$executable = Join-Path $root "build\control\CommandCenter.Control.exe"
$launcher = Join-Path $PSScriptRoot "start-control.vbs"
$icon = Join-Path $root "branding\command-center-control.ico"

foreach ($required in @($launcher, $icon)) {
  if (-not (Test-Path -LiteralPath $required)) { throw "Mangler shortcut-avhengighet: $required" }
}
if (-not (Test-Path -LiteralPath $executable)) {
  & (Join-Path $PSScriptRoot "build-control.ps1") | Out-Host
}

$desktop = [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)
if ([String]::IsNullOrWhiteSpace($desktop)) {
  $desktop = (Get-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders" -Name Desktop).Desktop
  $desktop = [Environment]::ExpandEnvironmentVariables($desktop)
}
if (-not (Test-Path -LiteralPath $desktop)) { New-Item -ItemType Directory -Path $desktop -Force | Out-Null }

$shortcutPath = Join-Path $desktop ($ShortcutName + ".lnk")
$shell = New-Object -ComObject WScript.Shell
try {
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = Join-Path $env:WINDIR "System32\wscript.exe"
  $shortcut.Arguments = '//B "' + $launcher + '"'
  $shortcut.WorkingDirectory = $root
  $shortcut.IconLocation = $icon + ",0"
  $shortcut.Description = "Start Command Center Control"
  $shortcut.Save()
} finally {
  if ($shortcut) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) }
  [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
}
Write-Output $shortcutPath
