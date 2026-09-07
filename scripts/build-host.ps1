param([switch]$Force)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$sdkVersion = "1.0.4129.50"
$tools = Join-Path $root ".tools"
$packageRoot = Join-Path $tools ("microsoft.web.webview2\" + $sdkVersion)
$archive = Join-Path $tools ("microsoft.web.webview2." + $sdkVersion + ".nupkg")
$output = Join-Path $root "build\host"
$source = Join-Path $root "host\CommandCenter.Host\Program.cs"
$manifest = Join-Path $root "host\CommandCenter.Host\app.manifest"
$executable = Join-Path $output "CommandCenter.Host.exe"

if ($Force -and (Test-Path -LiteralPath $output)) {
  Remove-Item -LiteralPath $output -Recurse -Force
}
New-Item -ItemType Directory -Path $tools -Force | Out-Null
New-Item -ItemType Directory -Path $output -Force | Out-Null

if (-not (Test-Path -LiteralPath $packageRoot)) {
  if (-not (Test-Path -LiteralPath $archive)) {
    $uri = "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/" + $sdkVersion + "/microsoft.web.webview2." + $sdkVersion + ".nupkg"
    Invoke-WebRequest -Uri $uri -OutFile $archive
  }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::ExtractToDirectory($archive, $packageRoot)
}

$framework = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319"
$csc = Join-Path $framework "csc.exe"
$core = Join-Path $packageRoot "lib\net462\Microsoft.Web.WebView2.Core.dll"
$winForms = Join-Path $packageRoot "lib\net462\Microsoft.Web.WebView2.WinForms.dll"
$loader = Join-Path $packageRoot "runtimes\win-x64\native\WebView2Loader.dll"

foreach ($required in @($csc, $core, $winForms, $loader)) {
  if (-not (Test-Path -LiteralPath $required)) { throw "Mangler build-avhengighet: $required" }
}

$arguments = @(
  "/nologo",
  "/target:winexe",
  "/platform:x64",
  "/optimize+",
  "/win32manifest:$manifest",
  "/out:$executable",
  ("/reference:" + (Join-Path $framework "System.dll")),
  ("/reference:" + (Join-Path $framework "System.Core.dll")),
  ("/reference:" + (Join-Path $framework "System.Drawing.dll")),
  ("/reference:" + (Join-Path $framework "System.Windows.Forms.dll")),
  ("/reference:" + $core),
  ("/reference:" + $winForms),
  $source
)
& $csc $arguments
if ($LASTEXITCODE -ne 0) { throw "Host-kompilering feilet med exit code $LASTEXITCODE" }

Copy-Item -LiteralPath $core -Destination $output -Force
Copy-Item -LiteralPath $winForms -Destination $output -Force
Copy-Item -LiteralPath $loader -Destination $output -Force

Write-Output $executable