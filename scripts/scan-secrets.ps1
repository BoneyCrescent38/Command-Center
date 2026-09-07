$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  $trackedFiles = @(git ls-files)
  $untrackedFiles = @(git ls-files --others --exclude-standard)
  $files = @($trackedFiles + $untrackedFiles | Sort-Object -Unique)
  $patterns = @(
    "-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----",
    '"private_key"\s*:',
    '"client_email"\s*:',
    "(PIN|PASSWORD|SECRET|TOKEN)\s*=\s*['""][^<][^'""]{5,}['""]"
  )
  $findings = @()
  foreach ($file in $files) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { continue }
    foreach ($pattern in $patterns) {
      $matches = Select-String -LiteralPath $file -Pattern $pattern -AllMatches
      if ($matches) { $findings += $matches }
    }
  }
  if ($findings.Count -gt 0) {
    $findings | ForEach-Object { Write-Output ($_.Path + ":" + $_.LineNumber) }
    throw "Secrets scan fant mulig sensitivt innhold"
  }
  Write-Output ("Secrets scan OK (" + $files.Count + " trackede filer)")
} finally {
  Pop-Location
}