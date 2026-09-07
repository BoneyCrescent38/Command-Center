param([switch]$Force)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$output = Join-Path $root "build\control"
$sources = @(Get-ChildItem -LiteralPath (Join-Path $root "host\CommandCenter.Control") -Filter "*.cs" -File | Sort-Object Name | ForEach-Object { $_.FullName })
$manifest = Join-Path $root "host\CommandCenter.Control\app.manifest"
$icon = Join-Path $root "branding\command-center-control.ico"
$executable = Join-Path $output "CommandCenter.Control.exe"
$framework = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319"
$csc = Join-Path $framework "csc.exe"

foreach ($required in @($csc, $manifest, $icon) + $sources) {
  if (-not (Test-Path -LiteralPath $required)) { throw "Mangler build-avhengighet: $required" }
}

New-Item -ItemType Directory -Path $output -Force | Out-Null
$arguments = @(
  "/nologo", "/target:winexe", "/platform:x64", "/optimize+",
  "/win32manifest:$manifest", "/win32icon:$icon", "/out:$executable",
  ("/reference:" + (Join-Path $framework "System.dll")),
  ("/reference:" + (Join-Path $framework "System.Core.dll")),
  ("/reference:" + (Join-Path $framework "System.Drawing.dll")),
  ("/reference:" + (Join-Path $framework "System.Windows.Forms.dll"))
)
$arguments += $sources
& $csc $arguments
if ($LASTEXITCODE -ne 0) { throw "Controller-kompilering feilet med exit code $LASTEXITCODE" }
Write-Output $executable
