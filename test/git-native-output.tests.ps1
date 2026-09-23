[CmdletBinding()]
param([string]$RepositoryRoot)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) { $RepositoryRoot = Split-Path $PSScriptRoot -Parent }
$Root = [IO.Path]::GetFullPath($RepositoryRoot)
$expectedOutput = @(& git --no-optional-locks -c "safe.directory=$Root" -C $Root rev-parse --verify HEAD)
$expectedExit = $LASTEXITCODE
if ($expectedExit -ne 0 -or $expectedOutput.Count -ne 1) { throw 'Fixture repository is unavailable' }
$expected = [string]$expectedOutput[0]
$production = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\scripts\command-center-kif-production.ps1') -Raw
$preview = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\scripts\command-center-kif-preview.ps1') -Raw
foreach ($source in @($production, $preview)) {
    if ($source -match '(?m)^[^\r\n]*& git[^\r\n]*\|\s*Select-Object\s+-First') { throw 'Native Git output must not feed a truncating pipeline' }
    foreach ($name in @('commit', 'branch')) {
        $pattern = '(?m)^\s*\$' + $name + 'Output\s*=\s*@\(& git[^\r\n]+\)\r?\n\s*\$' + $name + 'ExitCode\s*=\s*\$LASTEXITCODE\s*$'
        if ($source -notmatch $pattern) { throw "Exit code must be saved immediately for $name" }
    }
}
$start = $production.IndexOf('$gitArgs=@')
$end = $production.IndexOf('$health=$null', $start)
if ($start -lt 0 -or $end -lt 0) { throw 'Production Git block was not found' }
$productionBlock = [scriptblock]::Create($production.Substring($start, $end - $start))
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($preview, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Preview parse failed' }
$function = $ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-GitMetadata'}, $true)
. ([scriptblock]::Create($function.Extent.Text))
for ($trial = 1; $trial -le 3; $trial++) {
    . $productionBlock
    if (-not $gitValid -or $commitExitCode -ne 0 -or $commit -cne $expected) { throw "Production native Git regression: trial $trial" }
    $metadata = Get-GitMetadata
    if ($metadata.Commit -cne $expected -or [string]::IsNullOrWhiteSpace($metadata.Branch)) { throw "Preview native Git regression: trial $trial" }
}
# A native failure must never inherit a previous successful commit.
$Root = Join-Path ([IO.Path]::GetTempPath()) ('missing-kif-git-fixture-' + [guid]::NewGuid().ToString('N'))
$gitValid = $false; $commit = $null
try { . $productionBlock } catch { $gitValid = $false }
if ($gitValid) { throw 'Missing repository was accepted by production' }
$metadata = $null
try { $metadata = Get-GitMetadata } catch {}
if ($null -ne $metadata -and -not [string]::IsNullOrWhiteSpace($metadata.Commit)) { throw 'Missing repository was accepted by preview' }
Write-Output ("PASS: native Git collection, immediate exit codes, three live trials and missing-root rejection; PowerShell " + $PSVersionTable.PSVersion)

