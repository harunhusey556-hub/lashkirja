<#
.SYNOPSIS
  Registers the LashKirja production Scheduled Tasks for the current user.

.DESCRIPTION
  Idempotent: re-running replaces both tasks with the same definition.
  No administrator rights are needed; both tasks run as the signed-in user,
  only while that user is logged on (a locked screen is fine).

    "LashKirja prod"    at logon: run-prod.ps1 (the supervisor). No time
                        limit, one instance, restarted by Task Scheduler if
                        the supervisor itself exits with an error.
    "LashKirja backup"  daily at 03:00: backup-local.ps1. Runs late if the
                        PC was off at 03:00.
    "LashKirja cron"    hourly: run-cron.ps1, which calls the
                        recurring-invoices and cleanup routes on
                        127.0.0.1:3300 (see run-cron.ps1 for why those two
                        and not sync-bank/sync-email, which the worker
                        already covers). CRON_SECRET is read from the prod
                        .env by run-cron.ps1 at run time -- it is never
                        passed as a task argument, so it never appears in
                        this task's definition or in Task Scheduler's own
                        history/logs.

  The scripts are taken from the production checkout
  (C:\LashKirja\prod\app\scripts\ops), never from a dev checkout.

  Also sets "sleep after" on AC power to never
  (powercfg /change standby-timeout-ac 0). If that is refused, the step is
  skipped with a warning.

  -RunWhenLoggedOff (opt-in; without it nothing above changes) registers the
  same tasks with the S4U logon type: "run whether the user is logged on or
  not", no password stored. Prod, the backup and the cron calls then keep
  running while nobody is signed in (beta audit S9: on 2026-10-21 nothing ran
  for 270 minutes). 'LashKirja prod' also starts at boot, not only at logon. A
  second start does nothing: the task is MultipleInstances IgnoreNew, and
  run-prod.ps1 exits while a supervisor is alive. Run it from an elevated
  prompt as the account that owns C:\LashKirja; that account needs the "Log on
  as a batch job" right (Administrators have it).
  An S4U task has no network credentials (UNC shares, mapped drives), no EFS
  or DPAPI/Credential Manager secrets and no window. None of the four task scripts
  uses those. What does depend on the environment the S4U token gets is
  LOCALAPPDATA (Notify in lk-common.ps1 reads the Telegram token from
  %LOCALAPPDATA%\hermes\.env) and OneDrive (backup-local.ps1 mirrors to
  $env:OneDrive and only logs a line when it is empty). See app/docs/ops-windows.md,
  "Running while nobody is signed in".
  The task 'LashKirja watchdog' (install-watchdog-task.ps1) adds a 5-minute
  repetition to 'LashKirja prod'. Registering prod here replaces its triggers,
  so run install-watchdog-task.ps1 again afterwards.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File install-tasks.ps1

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File install-tasks.ps1 -RunWhenLoggedOff
#>
[CmdletBinding()]
param(
  [string]$Root = 'C:\LashKirja',
  [string]$BackupTime = '03:00',
  [switch]$RunWhenLoggedOff
)

$ErrorActionPreference = 'Stop'

# S4U runs the task whether or not the user is signed in and stores no password; the default
# Interactive type only runs while the user is signed in.
function New-LkPrincipal([string]$User, [bool]$LoggedOff) {
  $logonType = if ($LoggedOff) { 'S4U' } else { 'Interactive' }
  New-ScheduledTaskPrincipal -UserId $User -LogonType $logonType -RunLevel Limited
}

# AtLogOn alone leaves the server down after a reboot until someone signs in. Both triggers can
# fire for one boot (auto sign-in); the second start is dropped by the task's IgnoreNew setting.
function New-LkProdTriggers([string]$User, [bool]$LoggedOff) {
  $triggers = @(New-ScheduledTaskTrigger -AtLogOn -User $User)
  if ($LoggedOff) { $triggers += New-ScheduledTaskTrigger -AtStartup }
  $triggers
}

$OpsDir = Join-Path $Root 'prod\app\scripts\ops'
foreach ($script in @('run-prod.ps1', 'backup-local.ps1', 'run-cron.ps1')) {
  if (-not (Test-Path (Join-Path $OpsDir $script))) {
    throw "$OpsDir\$script not found. Deploy a commit that contains the ops scripts first (deploy-local.ps1)."
  }
}

$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-LkPrincipal $user $RunWhenLoggedOff.IsPresent
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

function Register-LkTask([string]$Name, [string]$Script, $Trigger, $Settings, [string]$Description) {
  $arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $OpsDir $Script)`" -Root `"$Root`""
  $action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $Root
  Register-ScheduledTask -TaskName $Name -Action $action -Trigger $Trigger -Settings $Settings `
    -Principal $principal -Description $Description -Force | Out-Null
  Write-Output "registered '$Name' -> $Script"
}

$prodSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-LkTask -Name 'LashKirja prod' -Script 'run-prod.ps1' `
  -Trigger (New-LkProdTriggers $user $RunWhenLoggedOff.IsPresent) -Settings $prodSettings `
  -Description 'LashKirja production supervisor (next start on 127.0.0.1:3300 + worker). See app/docs/ops-windows.md.'

$backupSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -WakeToRun
Register-LkTask -Name 'LashKirja backup' -Script 'backup-local.ps1' `
  -Trigger (New-ScheduledTaskTrigger -Daily -At $BackupTime) -Settings $backupSettings `
  -Description 'LashKirja daily backup to C:\LashKirja\backups (+ OneDrive mirror). See app/docs/ops-windows.md.'

# Recurring invoices and expired-upload cleanup (api/cron/recurring-invoices,
# api/cron/cleanup) have no other scheduler in this deployment -- see
# run-cron.ps1. Hourly is comfortably inside both routes' date-granularity
# and their own catch-up handling; StartWhenAvailable covers the PC being
# off or asleep at any given run.
$cronSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 20) -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
# No -RepetitionDuration: Task Scheduler's XML duration field overflows on
# [TimeSpan]::MaxValue ("P99999999DT23H59M59S" is rejected as out of
# range). Omitting it is the documented way to repeat a -Once trigger
# indefinitely.
$cronTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Hours 1)
Register-LkTask -Name 'LashKirja cron' -Script 'run-cron.ps1' `
  -Trigger $cronTrigger -Settings $cronSettings `
  -Description 'LashKirja hourly recurring-invoices + cleanup cron calls to 127.0.0.1:3300. CRON_SECRET is read from .env at run time, never stored in this task. See app/docs/ops-windows.md.'

if ($RunWhenLoggedOff) {
  Write-Output "S4U: the tasks run as $user whether or not that user is logged on (no password stored); 'LashKirja prod' also starts at boot"
}

# Keep the PC awake on AC power so the server and the 03:00 backup run.
try {
  $out = & powercfg.exe /change standby-timeout-ac 0 2>&1
  if ($LASTEXITCODE -ne 0) { throw ($out -join ' ') }
  Write-Output 'powercfg: sleep on AC power set to never'
} catch {
  Write-Warning "powercfg standby-timeout-ac 0 was refused ($($_.Exception.Message)). Run it once from an elevated prompt, or set Settings > System > Power > Sleep (plugged in) to Never."
}
