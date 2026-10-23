# Registers the LashKirja health watchdog and makes the supervisor self-healing.
# Run elevated (Hermes_Admin_Runner). Idempotent: re-running replaces both tasks.
#
# -RunWhenLoggedOff (opt-in; without it nothing here changes) registers the watchdog with the S4U
# logon type: it runs whether or not the user is signed in and no password is stored, so it keeps
# probing while nobody is signed in. install-tasks.ps1 -RunWhenLoggedOff does the same for
# 'LashKirja prod', 'LashKirja backup' and 'LashKirja cron'; run it first, because registering
# 'LashKirja prod' there replaces the 5-minute repetition that step 2 below adds.
[CmdletBinding()]
param(
  [switch]$RunWhenLoggedOff
)

$ErrorActionPreference = 'Stop'

# Same helper as in install-tasks.ps1; the two installers are separate files run on their own.
function New-LkPrincipal([string]$User, [bool]$LoggedOff) {
  $logonType = if ($LoggedOff) { 'S4U' } else { 'Interactive' }
  New-ScheduledTaskPrincipal -UserId $User -LogonType $logonType -RunLevel Limited
}

$shell = 'C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe'
$watchdog = 'C:\LashKirja\prod\app\scripts\ops\watchdog-prod.ps1'

# ---- 1) watchdog task: every 5 minutes and at logon ----
$action = New-ScheduledTaskAction -Execute $shell `
  -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $watchdog) `
  -WorkingDirectory 'C:\LashKirja'

$every5 = New-ScheduledTaskTrigger -Once -At ((Get-Date).Date.AddMinutes(2)) `
  -RepetitionInterval (New-TimeSpan -Minutes 5)
$user = "$env:USERDOMAIN\$env:USERNAME"
$atLogon = New-ScheduledTaskTrigger -AtLogOn -User $user

$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -StartWhenAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

# Without the switch no principal is passed: Task Scheduler then registers the current user, as before.
$principalArgs = @{}
if ($RunWhenLoggedOff) { $principalArgs.Principal = New-LkPrincipal $user $true }
Register-ScheduledTask -TaskName 'LashKirja watchdog' -Action $action `
  -Trigger @($every5, $atLogon) -Settings $settings -Force `
  -Description 'Health watchdog for the LashKirja prod instance: probes /api/health every 5 minutes and restarts the app when it stops answering, or when the supervisor is not running.' @principalArgs | Out-Null
"registered: LashKirja watchdog"

# ---- 2) make 'LashKirja prod' self-healing: a 5-minute repetition re-runs the supervisor ----
$prod = Get-ScheduledTask -TaskName 'LashKirja prod'
if ($RunWhenLoggedOff -and "$($prod.Principal.LogonType)" -ne 'S4U') {
  Write-Warning "'LashKirja prod' has the $($prod.Principal.LogonType) logon type and stops when nobody is signed in. Run install-tasks.ps1 -RunWhenLoggedOff, then this script again."
}
$existing = @($prod.Triggers)
$already = $existing | Where-Object { $_.Repetition -and $_.Repetition.Interval -eq 'PT5M' }
if ($already) {
  "LashKirja prod already has a 5-minute repetition"
} else {
  $repeating = New-ScheduledTaskTrigger -Once -At ((Get-Date).Date.AddMinutes(1)) `
    -RepetitionInterval (New-TimeSpan -Minutes 5)
  Set-ScheduledTask -TaskName 'LashKirja prod' -Trigger @($existing + $repeating) | Out-Null
  "added a 5-minute repetition to LashKirja prod"
}

# ---- 3) report what is registered ----
foreach ($name in @('LashKirja prod', 'LashKirja watchdog')) {
  $t = Get-ScheduledTask -TaskName $name
  $info = Get-ScheduledTaskInfo -TaskName $name
  "--- $name : $($t.State) ---"
  if ($RunWhenLoggedOff) { "  principal: $($t.Principal.UserId) logon=$($t.Principal.LogonType)" }
  foreach ($tr in $t.Triggers) {
    $rep = if ($tr.Repetition -and $tr.Repetition.Interval) { $tr.Repetition.Interval } else { 'none' }
    "  trigger: $($tr.CimClass.CimClassName) repetition=$rep"
  }
  "  next run: $($info.NextRunTime)  last result: $($info.LastTaskResult)"
}
