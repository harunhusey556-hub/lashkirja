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

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File install-tasks.ps1
#>
[CmdletBinding()]
param(
  [string]$Root = 'C:\LashKirja',
  [string]$BackupTime = '03:00'
)

$ErrorActionPreference = 'Stop'
$OpsDir = Join-Path $Root 'prod\app\scripts\ops'
foreach ($script in @('run-prod.ps1', 'backup-local.ps1', 'run-cron.ps1')) {
  if (-not (Test-Path (Join-Path $OpsDir $script))) {
    throw "$OpsDir\$script not found. Deploy a commit that contains the ops scripts first (deploy-local.ps1)."
  }
}

$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
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
  -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $user) -Settings $prodSettings `
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

# Keep the PC awake on AC power so the server and the 03:00 backup run.
try {
  $out = & powercfg.exe /change standby-timeout-ac 0 2>&1
  if ($LASTEXITCODE -ne 0) { throw ($out -join ' ') }
  Write-Output 'powercfg: sleep on AC power set to never'
} catch {
  Write-Warning "powercfg standby-timeout-ac 0 was refused ($($_.Exception.Message)). Run it once from an elevated prompt, or set Settings > System > Power > Sleep (plugged in) to Never."
}
