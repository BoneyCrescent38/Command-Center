param([switch]$Open)

$ErrorActionPreference = "Stop"
& (Join-Path $PSScriptRoot "start-server.ps1")
$url = "http://127.0.0.1:4337/preview"
Write-Output ("Preview: " + $url)
if ($Open) {
  Start-Process $url
}