# Registers the LashKirja health watchdog and makes the supervisor self-healing.
# Run elevated (Hermes_Admin_Runner). Idempotent: re-running replaces both tasks.
$ErrorActionPreference = 'Stop'
$shell = 'C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe'
$watchdog = 'C:\LashKirja\prod\app\scripts\ops\watchdog-prod.ps1'

# ---- 1) watchdog task: every 5 minutes and at logon ----
$action = New-ScheduledTaskAction -Execute $shell `
  -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $watchdog) `
  -WorkingDirectory 'C:\LashKirja'

$every5 = New-ScheduledTaskTrigger -Once -At ((Get-Date).Date.AddMinutes(2)) `
  -RepetitionInterval (New-TimeSpan -Minutes 5)
$atLogon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"

$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -StartWhenAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName 'LashKirja watchdog' -Action $action `
  -Trigger @($every5, $atLogon) -Settings $settings -Force `
  -Description 'Health watchdog for the LashKirja prod instance: probes /api/health every 5 minutes and restarts the app when it stops answering, or when the supervisor is not running.' | Out-Null
"registered: LashKirja watchdog"

# ---- 2) make 'LashKirja prod' self-healing: a 5-minute repetition re-runs the supervisor ----
$prod = Get-ScheduledTask -TaskName 'LashKirja prod'
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
  foreach ($tr in $t.Triggers) {
    $rep = if ($tr.Repetition -and $tr.Repetition.Interval) { $tr.Repetition.Interval } else { 'none' }
    "  trigger: $($tr.CimClass.CimClassName) repetition=$rep"
  }
  "  next run: $($info.NextRunTime)  last result: $($info.LastTaskResult)"
}
