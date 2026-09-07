param([string]$TaskName = "Kristian Liverod Command Center")

$ErrorActionPreference = "Stop"
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Output ("Autostart fjernet: " + $TaskName)
} else {
  Write-Output ("Autostart var ikke installert: " + $TaskName)
}