[CmdletBinding()]
param(
 [ValidateSet('Status','Start','Stop','Restart')][string]$Action='Status',
 [ValidateSet('Production')][string]$Environment='Production',
 [Parameter(Mandatory=$true)][string]$Root,
 [string]$ResultPath
)
Set-StrictMode -Version 2.0
$ErrorActionPreference='Stop'
$Root=[IO.Path]::GetFullPath($Root).TrimEnd('\')
$Port=8000
$TaskName='KIF Vanskebygger Server'
$Python=Join-Path $Root '.venv\Scripts\python.exe'
$BasePython=Join-Path $Root '.python-runtime\python.exe'
$Arguments='-I -B -X utf8 scripts\run_server.py'
$CommandLine='"'+$Python+'" '+$Arguments
if(-not(Test-Path -LiteralPath $Root -PathType Container)){throw 'Production root is unavailable.'}
. (Join-Path $PSScriptRoot 'kif-production-status-policy.ps1')
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices; using System.ComponentModel;
public sealed class KifReadResult { public string Value; public int Error; }
public static class KifControllerProcessRead {
 [StructLayout(LayoutKind.Sequential)] struct PBI { public IntPtr R1,Peb,R2,R3,Pid,R4; }
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint a,bool i,int p);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool ReadProcessMemory(IntPtr h,IntPtr a,byte[] b,IntPtr n,out IntPtr read);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr h,uint f,StringBuilder s,ref int n);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h,int c,out PBI p,int s,out int n);
 static byte[] Read(IntPtr h,long a,int n){var b=new byte[n];IntPtr read;if(!ReadProcessMemory(h,new IntPtr(a),b,new IntPtr(n),out read))throw new Win32Exception(Marshal.GetLastWin32Error());if(read.ToInt64()!=n)throw new Win32Exception(299);return b;}
 public static KifReadResult Image(int pid){var h=OpenProcess(0x1000,false,pid);if(h==IntPtr.Zero)return new KifReadResult{Error=Marshal.GetLastWin32Error()};try{var s=new StringBuilder(32768);int n=s.Capacity;if(!QueryFullProcessImageName(h,0,s,ref n))return new KifReadResult{Error=Marshal.GetLastWin32Error()};return new KifReadResult{Value=s.ToString()};}finally{CloseHandle(h);}}
 public static KifReadResult Parameter(int pid,int offset){var h=OpenProcess(0x410,false,pid);if(h==IntPtr.Zero)return new KifReadResult{Error=Marshal.GetLastWin32Error()};try{PBI p;int n;int status=NtQueryInformationProcess(h,0,out p,Marshal.SizeOf(typeof(PBI)),out n);if(status!=0)return new KifReadResult{Error=status==unchecked((int)0xC0000022)?5:status};long pp=BitConverter.ToInt64(Read(h,p.Peb.ToInt64()+0x20,8),0);var u=Read(h,pp+offset,16);int size=BitConverter.ToUInt16(u,0);if(size==0||size>32768)return new KifReadResult{Error=13};return new KifReadResult{Value=Encoding.Unicode.GetString(Read(h,BitConverter.ToInt64(u,8),size))};}catch(Win32Exception e){return new KifReadResult{Error=e.NativeErrorCode};}catch{return new KifReadResult{Error=13};}finally{CloseHandle(h);}}
}
'@
function Get-Identity {
 $listeners=@(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
 $p=$null;$owner=$null;$exe=$null;$cwd=$null;$cmd=$null
 $conflict=$listeners.Count-gt1;$accessDenied=$false;$missingOnlyDenied=$true;$errors=@{}
 if($listeners.Count-eq1){
  if($listeners[0].LocalAddress-ne'127.0.0.1'){$conflict=$true}
  $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$listeners[0].OwningProcess)
  if($null-ne$p){
   if($p.Name-ne'python.exe'-or[string]::IsNullOrWhiteSpace([string]$p.CreationDate)){$conflict=$true}
   $image=[KifControllerProcessRead]::Image([int]$p.ProcessId)
   $directory=[KifControllerProcessRead]::Parameter([int]$p.ProcessId,0x38)
   $command=[KifControllerProcessRead]::Parameter([int]$p.ProcessId,0x70)
   $exe=if($image.Value){$image.Value}else{[string]$p.ExecutablePath}
   $cwd=$directory.Value
   $cmd=if($command.Value){$command.Value}else{[string]$p.CommandLine}
   $errors=@{executable=$image.Error;workingDirectory=$directory.Error;commandLine=$command.Error;owner=13}
   try{
    $account=Invoke-CimMethod -InputObject $p -MethodName GetOwner -ErrorAction Stop
    if($account.ReturnValue-eq0){$owner=$account.Domain+'\'+$account.User;$errors.owner=0}
    elseif($account.ReturnValue-eq2){$errors.owner=5}
    else{$errors.owner=[int]$account.ReturnValue+1000}
   }catch{if($_.Exception.HResult-eq-2147024891){$errors.owner=5}}
   $checks=@(
    @{Key='executable';Actual=$exe;Expected=$BasePython},
    @{Key='workingDirectory';Actual=([string]$cwd).TrimEnd('\');Expected=$Root},
    @{Key='commandLine';Actual=([string]$cmd).Trim();Expected=$CommandLine},
    @{Key='owner';Actual=$owner;Expected='NT AUTHORITY\LOCAL SERVICE'}
   )
   foreach($check in $checks){
    if([string]::IsNullOrWhiteSpace($check.Actual)){
     if($errors[$check.Key]-eq5){$accessDenied=$true}else{$missingOnlyDenied=$false}
    }elseif(-not([string]$check.Actual).Equals($check.Expected,[StringComparison]::OrdinalIgnoreCase)){$conflict=$true}
   }
   # A readable CIM value is evidence too, even if another API returns a different result.
   if($p.ExecutablePath -and -not([string]$p.ExecutablePath).Equals($BasePython,[StringComparison]::OrdinalIgnoreCase)){$conflict=$true}
   if($p.CommandLine -and -not([string]$p.CommandLine).Trim().Equals($CommandLine,[StringComparison]::OrdinalIgnoreCase)){$conflict=$true}
  }
 }
 $owned=$null-ne$p -and -not$conflict -and $exe -and $cwd -and $cmd -and $owner
 [pscustomobject]@{Process=$p;Owned=[bool]$owned;Owner=$owner;Executable=$exe;WorkingDirectory=$cwd;Conflict=[bool]$conflict;AccessDenied=([bool]$accessDenied-and$missingOnlyDenied);ReadErrors=$errors}
}
function Assert-TaskIdentity {
 $admin=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
 Assert-ProductionActionPrivilege -IsAdministrator $admin
 $task=Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
 $actions=@($task.Actions)
 if($actions.Count-ne1){throw 'Production task must have exactly one action.'}
 $a=$actions[0];$principal=([string]$task.Principal.UserId).ToUpperInvariant()
 if(-not([string]$a.Execute).Equals($Python,[StringComparison]::OrdinalIgnoreCase) -or
  -not([string]$a.WorkingDirectory).TrimEnd('\').Equals($Root,[StringComparison]::OrdinalIgnoreCase) -or
  ([string]$a.Arguments).Trim()-cne$Arguments -or $principal-notin@('LOCAL SERVICE','NT AUTHORITY\LOCAL SERVICE','S-1-5-19')){
  throw 'Production task does not match explicit root, command and LOCAL SERVICE.'
 }
}
function Stop-OwnedProduction {
 $id=Get-Identity
 if($null-ne$id.Process){
  if(-not$id.Owned){throw 'Refusing to stop production without administrative process verification.'}
  $again=Get-Identity
  if(-not$again.Owned-or$again.Process.ProcessId-ne$id.Process.ProcessId-or[string]$again.Process.CreationDate-cne[string]$id.Process.CreationDate){throw 'Production identity changed before stop.'}
 }
 Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
 $after=Get-Identity
 if($null-ne$after.Process){
  if(-not$after.Owned-or$null-eq$id.Process-or$after.Process.ProcessId-ne$id.Process.ProcessId){throw 'Unexpected production process after task stop.'}
  Stop-Process -Id $after.Process.ProcessId -ErrorAction Stop
 }
 $deadline=[DateTime]::UtcNow.AddSeconds(20)
 while(@(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue).Count){
  if([DateTime]::UtcNow-ge$deadline){throw 'Production port did not close.'}
  Start-Sleep -Milliseconds 200
 }
}
if($Action-ne'Status'){
 Assert-TaskIdentity
 if($Action-in@('Stop','Restart')){Stop-OwnedProduction}
 if($Action-in@('Start','Restart')){
  $current=Get-Identity
  if($null-ne$current.Process-and-not$current.Owned){throw 'Production port belongs to an unverified process.'}
  if($null-eq$current.Process){Start-ScheduledTask -TaskName $TaskName}
  $deadline=[DateTime]::UtcNow.AddSeconds(30)
  do{$current=Get-Identity;if($current.Owned){break};Start-Sleep -Milliseconds 250}while([DateTime]::UtcNow-lt$deadline)
  if(-not$current.Owned){throw 'Production did not start with verified ownership.'}
 }
}
$id=Get-Identity
$gitArgs=@('--no-optional-locks','-c',('safe.directory='+$Root),'-C',$Root)
$commit=(& git @gitArgs rev-parse --verify HEAD 2>$null|Select-Object -First 1)
$gitValid=$LASTEXITCODE-eq0
$branch=(& git @gitArgs symbolic-ref --short --quiet HEAD 2>$null|Select-Object -First 1)
$health=$null
try{$health=Invoke-RestMethod -Uri 'http://127.0.0.1:8000/health' -TimeoutSec 3}catch{}
$h=@{app='';database='';environment='';releaseCommit='';appVersion=''}
foreach($key in @($h.Keys)){if($null-ne$health-and$null-ne$health.PSObject.Properties[$key]){$h[$key]=[string]$health.$key}}
$healthy=$h.app-eq'ok'-and$h.database-eq'ok'
$matches=$gitValid-and$healthy-and$h.environment-eq'stable'-and$commit-match'^[0-9a-f]{40}$'-and$h.releaseCommit-eq$commit
$decision=Get-ProductionState -ProcessExists ($null-ne$id.Process) -Owned $id.Owned -AccessDenied $id.AccessDenied -Conflict $id.Conflict -Matches $matches
$result=[ordered]@{
 schemaVersion=1;serviceId='kif-production';environment='Production';healthEnvironment=$h.environment
 state=$decision.State;root=$Root;port=8000;commit=$commit;branch=$branch;version=$h.appVersion;build=$h.releaseCommit
 healthy=[bool]$healthy;ownedProcess=$decision.Owned;identityVerified=$decision.Verified
 accessDenied=$id.AccessDenied;identityConflict=$id.Conflict;readErrors=$id.ReadErrors
 processId=$(if($null-ne$id.Process){$id.Process.ProcessId}else{$null})
 processStartTime=$(if($null-ne$id.Process){([datetime]$id.Process.CreationDate).ToUniversalTime().ToString('o')}else{$null})
 executable=$id.Executable;workingDirectory=$id.WorkingDirectory;owner=$id.Owner
 autoStartPolicy='ExternallyManaged';autoStartAllowed=$false;action=$Action;success=$true
 messageSafe=$(if($decision.State-eq'RunningProtected'){'Kjorer - beskyttet. Prosesseierskap krever administrativ kontroll.'}elseif($decision.Verified){'Root, Git release and LOCAL SERVICE process verified.'}else{'Process or release identity is missing or inconsistent.'})
}
$json=$result|ConvertTo-Json -Depth 6 -Compress
if(-not[string]::IsNullOrWhiteSpace($ResultPath)){[IO.File]::WriteAllText($ResultPath,$json,[Text.UTF8Encoding]::new($false))}
Write-Output $json
