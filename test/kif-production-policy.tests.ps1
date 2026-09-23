$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '..\scripts\kif-production-status-policy.ps1')
$cases=@(
 @{Name='Access Denied + matching';Exists=$true;Owned=$false;Denied=$true;Conflict=$false;Matches=$true;State='RunningProtected';Verified=$false},
 @{Name='Fully elevated verification';Exists=$true;Owned=$true;Denied=$false;Conflict=$false;Matches=$true;State='Running';Verified=$true},
 @{Name='Readable contradiction';Exists=$true;Owned=$false;Denied=$true;Conflict=$true;Matches=$true;State='Degraded';Verified=$false},
 @{Name='Health or Git mismatch';Exists=$true;Owned=$false;Denied=$true;Conflict=$false;Matches=$false;State='Degraded';Verified=$false},
 @{Name='Missing information is not Access Denied';Exists=$true;Owned=$false;Denied=$false;Conflict=$false;Matches=$true;State='Degraded';Verified=$false},
 @{Name='No process with stale health';Exists=$false;Owned=$false;Denied=$false;Conflict=$false;Matches=$true;State='Degraded';Verified=$false},
 @{Name='Stopped';Exists=$false;Owned=$false;Denied=$false;Conflict=$false;Matches=$false;State='Stopped';Verified=$false}
)
foreach($case in $cases){
 $r=Get-ProductionState -ProcessExists $case.Exists -Owned $case.Owned -AccessDenied $case.Denied -Conflict $case.Conflict -Matches $case.Matches
 if($r.State-ne$case.State-or$r.Verified-ne$case.Verified){throw ('Failed: '+$case.Name)}
 if($r.State-eq'RunningProtected'-and($r.Owned-or$r.Verified)){throw 'Protected must never claim ownership or verification'}
 Write-Output ('PASS: '+$case.Name)
}
$rejected=$false
try{Assert-ProductionActionPrivilege -IsAdministrator $false}catch{$rejected=$_.Exception.Message-like'*UAC*'}
if(-not$rejected){throw 'Unprivileged production action was accepted'}
Assert-ProductionActionPrivilege -IsAdministrator $true
Write-Output 'PASS: production actions require explicit administrative verification'
