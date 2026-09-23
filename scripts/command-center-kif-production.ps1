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
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class KifControllerProcessRead {
 [StructLayout(LayoutKind.Sequential)] struct PBI { public IntPtr R1; public IntPtr Peb; public IntPtr R2; public IntPtr R3; public IntPtr Pid; public IntPtr R4; }
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint a,bool i,int p);
 [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h,IntPtr a,byte[] b,IntPtr n,out IntPtr read);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h,int c,out PBI p,int s,out int n);
 static byte[] Read(IntPtr h,long a,int n){var b=new byte[n];IntPtr read;if(!ReadProcessMemory(h,new IntPtr(a),b,new IntPtr(n),out read)||read.ToInt64()!=n)throw new InvalidOperationException();return b;}
 public static string Cwd(int pid){var h=OpenProcess(0x410,false,pid);if(h==IntPtr.Zero)return null;try{PBI p;int n;if(NtQueryInformationProcess(h,0,out p,Marshal.SizeOf(typeof(PBI)),out n)!=0)return null;long pp=BitConverter.ToInt64(Read(h,p.Peb.ToInt64()+0x20,8),0);var u=Read(h,pp+0x38,16);int size=BitConverter.ToUInt16(u,0);if(size==0||size>32768)return null;return Encoding.Unicode.GetString(Read(h,BitConverter.ToInt64(u,8),size));}catch{return null;}finally{CloseHandle(h);}}
}
'@
function Get-Identity {
    $listeners=@(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
    if($listeners.Count -gt 1){throw 'Multiple production listeners; refusing ambiguous identity.'}
    $p=$null;$owned=$false;$owner=$null;$cwd=$null
    if($listeners.Count -eq 1){
        if($listeners[0].LocalAddress -ne '127.0.0.1'){throw 'Unexpected production bind address.'}
        $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$listeners[0].OwningProcess)
        if($null-ne$p){
            $account=Invoke-CimMethod -InputObject $p -MethodName GetOwner -ErrorAction SilentlyContinue
            if($null-ne$account -and $account.ReturnValue-eq0){$owner=$account.Domain+'\'+$account.User}
            $cwd=[KifControllerProcessRead]::Cwd([int]$p.ProcessId)
            $owned=([string]$p.ExecutablePath).Equals($BasePython,[StringComparison]::OrdinalIgnoreCase) -and
                ([string]$p.CommandLine).Trim().Equals($CommandLine,[StringComparison]::OrdinalIgnoreCase) -and
                ([string]$cwd).TrimEnd('\').Equals($Root,[StringComparison]::OrdinalIgnoreCase) -and
                $owner-eq'NT AUTHORITY\LOCAL SERVICE'
        }
    }
    [pscustomobject]@{Process=$p;Owned=[bool]$owned;Owner=$owner;WorkingDirectory=$cwd}
}
function Assert-TaskIdentity {
    $task=Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $actions=@($task.Actions)
    if($actions.Count-ne1){throw 'Production task must have exactly one action.'}
    $a=$actions[0]
    $principal=([string]$task.Principal.UserId).ToUpperInvariant()
    if(-not([string]$a.Execute).Equals($Python,[StringComparison]::OrdinalIgnoreCase) -or
       -not([string]$a.WorkingDirectory).TrimEnd('\').Equals($Root,[StringComparison]::OrdinalIgnoreCase) -or
       ([string]$a.Arguments).Trim()-cne$Arguments -or
       $principal-notin@('LOCAL SERVICE','NT AUTHORITY\LOCAL SERVICE','S-1-5-19')){
        throw 'Production task does not match the explicit root, command and LOCAL SERVICE identity.'
    }
}
function Stop-OwnedProduction {
    $id=Get-Identity
    if($null-ne$id.Process){
        if(-not$id.Owned){throw 'Refusing to stop production without verified root and process ownership.'}
        $again=Get-Identity
        if(-not$again.Owned -or $again.Process.ProcessId-ne$id.Process.ProcessId -or
           [string]$again.Process.CreationDate-cne[string]$id.Process.CreationDate){throw 'Production identity changed before stop.'}
    }
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $after=Get-Identity
    if($null-ne$after.Process){
        if(-not$after.Owned -or $null-eq$id.Process -or $after.Process.ProcessId-ne$id.Process.ProcessId){throw 'Unexpected production process after task stop.'}
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
        if($null-ne$current.Process -and -not$current.Owned){throw 'Production port belongs to an unverified process.'}
        if($null-eq$current.Process){Start-ScheduledTask -TaskName $TaskName}
        $deadline=[DateTime]::UtcNow.AddSeconds(30)
        do{
            $current=Get-Identity
            if($current.Owned){break}
            Start-Sleep -Milliseconds 250
        }while([DateTime]::UtcNow-lt$deadline)
        if(-not$current.Owned){throw 'Production did not start with verified ownership.'}
    }
}
$id=Get-Identity
$gitArgs=@('--no-optional-locks','-c',('safe.directory='+$Root),'-C',$Root)
$commit=(& git @gitArgs rev-parse --verify HEAD 2>$null|Select-Object -First 1)
$branch=(& git @gitArgs symbolic-ref --short --quiet HEAD 2>$null|Select-Object -First 1)
$health=$null
try{$health=Invoke-RestMethod -Uri 'http://127.0.0.1:8000/health' -TimeoutSec 3}catch{}
$healthy=$null-ne$health -and $health.app-eq'ok' -and $health.database-eq'ok'
$matches=$healthy -and $health.environment-eq'stable' -and
    -not[string]::IsNullOrWhiteSpace($commit) -and $health.releaseCommit-eq$commit
$verified=$id.Owned -and $matches
$result=[ordered]@{
    schemaVersion=1;serviceId='kif-production';environment='Production'
    state=$(if($verified){'Running'}elseif($null-ne$id.Process -or $healthy){'Degraded'}else{'Stopped'})
    root=$Root;port=8000;commit=$commit;branch=$branch
    version=$(if($null-ne$health){$health.appVersion}else{$null})
    build=$(if($null-ne$health){$health.releaseCommit}else{$null})
    healthy=[bool]$healthy;ownedProcess=[bool]$id.Owned;identityVerified=[bool]$verified
    processId=$(if($null-ne$id.Process){$id.Process.ProcessId}else{$null})
    executable=$(if($null-ne$id.Process){$id.Process.ExecutablePath}else{$null})
    workingDirectory=$id.WorkingDirectory;owner=$id.Owner
    autoStartPolicy='ExternallyManaged';autoStartAllowed=$false
    action=$Action;success=$true
    messageSafe=$(if($verified){'Root, Git release and LOCAL SERVICE process verified.'}elseif($healthy){'Health reachable; protected process identity requires elevation or does not match.'}else{'Production health unavailable.'})
}
$json=$result|ConvertTo-Json -Depth 6 -Compress
if(-not[string]::IsNullOrWhiteSpace($ResultPath)){[IO.File]::WriteAllText($ResultPath,$json,[Text.UTF8Encoding]::new($false))}
Write-Output $json
