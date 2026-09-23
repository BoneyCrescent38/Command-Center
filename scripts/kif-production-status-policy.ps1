function Get-ProductionState {
 param([bool]$ProcessExists,[bool]$Owned,[bool]$AccessDenied,[bool]$Conflict,[bool]$Matches)
 $state='Degraded';$verified=$false
 if($ProcessExists-and$Matches-and-not$Conflict){
  if($Owned){$state='Running';$verified=$true}
  elseif($AccessDenied){$state='RunningProtected'}
 }elseif(-not$ProcessExists-and-not$Matches-and-not$Conflict){$state='Stopped'}
 [pscustomobject]@{State=$state;Owned=($Owned-and$ProcessExists-and-not$Conflict);Verified=$verified}
}
function Assert-ProductionActionPrivilege {
 param([bool]$IsAdministrator)
 if(-not$IsAdministrator){throw 'Production actions require explicit UAC administrative verification.'}
}
