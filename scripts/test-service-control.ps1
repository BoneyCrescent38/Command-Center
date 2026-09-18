[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$sourceRoot = Join-Path $repoRoot 'host\CommandCenter.Control'
$testSource = Join-Path $repoRoot 'test\ServiceControlPolicyTests.cs'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $csc)) {
    throw ('C# compiler not found: {0}' -f $csc)
}

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('command-center-service-tests-' + [Guid]::NewGuid().ToString('N'))
$outputPath = Join-Path $tempRoot 'ServiceControlPolicyTests.exe'
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

try {
    $sources = @(Get-ChildItem -LiteralPath $sourceRoot -Filter '*.cs' -File | Sort-Object Name | ForEach-Object { $_.FullName })
    $sources += $testSource
    $sources += Join-Path $repoRoot 'test\ServiceActionLockTests.cs'
    $compilerArguments = @(
        '/nologo'
        '/target:exe'
        ('/out:{0}' -f $outputPath)
        ('/main:{0}' -f 'CommandCenter.Control.Tests.ServiceControlPolicyTests')
        ('/reference:{0}' -f (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\System.dll'))
        ('/reference:{0}' -f (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\System.Core.dll'))
        ('/reference:{0}' -f (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\System.Drawing.dll'))
        ('/reference:{0}' -f (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\System.Windows.Forms.dll'))
    ) + $sources

    $compilerOutput = @(& $csc $compilerArguments 2>&1)
    $compilerExitCode = $LASTEXITCODE
    if ($compilerExitCode -ne 0 -or -not (Test-Path -LiteralPath $outputPath)) {
        $compilerOutput | ForEach-Object { Write-Error ([string]$_) }
        throw ('Service Control test compilation failed with exit code {0}.' -f $compilerExitCode)
    }

    & $outputPath
    if ($LASTEXITCODE -ne 0) {
        throw ('Service Control policy tests failed with exit code {0}.' -f $LASTEXITCODE)
    }
}
finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}
