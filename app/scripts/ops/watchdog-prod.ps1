<#
.SYNOPSIS
  Health watchdog for the LashKirja production instance.

.DESCRIPTION
  Why this exists (2026-10-12 outage): the supervisor keeps a CRASHED child alive, but it cannot
  see a child that is still alive and no longer answers - the web process kept the TCP port open
  and never replied. The supervisor itself had also died, so nothing restarted anything, and the
  app stayed wedged for about six hours until the owner noticed.

  This watchdog closes both gaps:
    * health probe of http://127.0.0.1:<Port>/api/health (Bearer HEALTH_TOKEN from the app .env);
      a 503 whose db and disk checks are ok still counts as serving (a failed bank sync keeps
      bankJobs red for 24 h and must not trigger a restart);
    * a second probe after a short wait, so a single slow moment is not a restart;
    * the supervisor itself: if it is not running, the scheduled task is started (it is
      idempotent - run-prod.ps1 exits when a supervisor is already alive);
    * a restart storm guard: at most one restart per MinRestartGapMinutes, recorded in a state file;
    * one Telegram line to the owner when it acts or recovers, a log line on every run.

  Added after the 2026-10-21 deploy, where the watchdog restarted the app in the middle of a swap and
  the rollback then failed ("file is being used by another process"):
    * while deploy-local.ps1 holds run\deploy.lock the watchdog exits at once: no probe, no restart.
      A lock whose process is gone, or that is older than DeployLockStaleMinutes, is stale: it no
      longer blocks anything, but the owner is told once per lock file;
    * the newest backup zip older than BackupMaxAgeHours (backup-local.ps1 runs daily at 03:00)
      is a Telegram line, at most one per AlertGapHours;
    * a 503 whose only red check is the disk's low-space is a warning, not a restart: freeing space
      is not something a restart does. The owner gets one Telegram line per AlertGapHours.

  ASCII only on purpose: Windows PowerShell 5.1 reads a .ps1 without a BOM as Windows-1252, and
  non-ASCII characters in this file would break its string terminators.

  Exit codes: 0 = healthy, recovered, or a deploy holds the lock, 1 = still unhealthy, 2 = watchdog itself failed.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File watchdog-prod.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File watchdog-prod.ps1 -DryRun
#>
[CmdletBinding()]
param(
  [string]$Root = 'C:\LashKirja',
  [int]$Port = 3300,
  [int]$TimeoutSec = 10,
  [int]$ConfirmWaitSeconds = 20,
  [int]$RestartWaitSeconds = 120,
  [int]$MinRestartGapMinutes = 10,
  # A deploy takes minutes; a lock this old belongs to a deploy that hung or died.
  [int]$DeployLockStaleMinutes = 120,
  [int]$BackupMaxAgeHours = 36,
  [int]$AlertGapHours = 24,
  [string]$TaskName = 'LashKirja prod',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$AppDir = Join-Path $Root 'prod\app'
$EnvFile = Join-Path $AppDir '.env'
$LogDir = Join-Path $Root 'logs'
$RunDir = Join-Path $Root 'run'
$BackupDir = Join-Path $Root 'backups'
$StateFile = Join-Path $RunDir 'watchdog-state.json'
$LockFile = Join-Path $RunDir 'deploy.lock'
$OpsDir = $PSScriptRoot
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }
if (-not (Test-Path $RunDir)) { New-Item -ItemType Directory -Force -Path $RunDir | Out-Null }
$LogFile = Join-Path $LogDir ("watchdog-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))

function Log([string]$Message) {
  $line = "{0} {1}" -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss'), $Message
  Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
}

# Read-DotEnv and Notify; backup-local.ps1 and run-cron.ps1 alert through the same file.
. (Join-Path $OpsDir 'lk-common.ps1')

$appEnv = Read-DotEnv $EnvFile

# Set by Probe-Health when the 503 it saw was the disk's low-space.
$script:LowSpace = $false

# 'ok' | 'degraded' | 'down_<status>' | 'unreachable'
function Probe-Health {
  $script:LowSpace = $false
  $headers = @{}
  if ($appEnv.Contains('HEALTH_TOKEN') -and $appEnv['HEALTH_TOKEN']) {
    $headers['Authorization'] = 'Bearer ' + $appEnv['HEALTH_TOKEN']
  }
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/health" -Headers $headers -TimeoutSec $TimeoutSec
    if ($response.StatusCode -eq 200) { return 'ok' }
    return "down_$($response.StatusCode)"
  } catch {
    $status = $_.Exception.Response.StatusCode.value__
    if ($status -eq 503) {
      try {
        $text = $null
        if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $text = $_.ErrorDetails.Message }
        elseif ($_.Exception.Response) {
          $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
          try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() }
        }
        $json = $text | ConvertFrom-Json
        # Low free space (health.ts LOW_SPACE_BYTES) is only a warning: the app still serves, and a
        # restart does not free any disk, so it would just repeat every MinRestartGapMinutes.
        $lowSpace = (-not $json.checks.disk.ok) -and $json.checks.disk.detail -eq 'low-space'
        if ($json.checks.db.ok -and ($json.checks.disk.ok -or $lowSpace)) {
          $script:LowSpace = $lowSpace
          return 'degraded'
        }
      } catch { }
      return 'down_503'
    }
    if ($status) { return "down_$status" }
    return 'unreachable'
  }
}

function Get-SupervisorRunning {
  $pidFile = Join-Path $RunDir 'supervisor.pid'
  if (-not (Test-Path $pidFile)) { return $false }
  $raw = (Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  $supervisorPid = 0
  if (-not [int]::TryParse("$raw".Trim(), [ref]$supervisorPid)) { return $false }
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $supervisorPid" -ErrorAction SilentlyContinue
  return [bool]($proc -and $proc.CommandLine -and $proc.CommandLine -match 'run-prod\.ps1' -and $proc.CommandLine -notmatch '-Stop|-Status')
}

function Read-State {
  if (Test-Path $StateFile) {
    try { return Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json } catch { }
  }
  return [pscustomobject]@{ lastRestart = $null; consecutiveFailures = 0; lastStatus = 'unknown' }
}

function Write-State($State) {
  $State | ConvertTo-Json -Compress | Set-Content -LiteralPath $StateFile -Encoding UTF8
}

# A state file written by an older watchdog lacks the newer fields, and assigning to a missing
# property of a PSCustomObject throws.
function Set-StateField($State, [string]$Name, $Value) {
  if ($State.PSObject.Properties[$Name]) { $State.$Name = $Value }
  else { $State | Add-Member -NotePropertyName $Name -NotePropertyValue $Value }
}

function Get-StateField($State, [string]$Name) {
  $property = $State.PSObject.Properties[$Name]
  if ($property) { return $property.Value }
  return $null
}

# True when the alert under this state field has not gone out in the last AlertGapHours. The watchdog
# runs every 5 minutes, so an alert about a condition that lasts would otherwise repeat 288 times a day.
function Test-AlertDue($State, [string]$Name) {
  $last = Get-StateField $State $Name
  if (-not $last) { return $true }
  try { return (((Get-Date) - [datetime]$last).TotalHours -ge $AlertGapHours) }
  catch { Log ("state field $Name is not a date ($last); alerting again"); return $true }
}

# One alert, recorded in the state file so the next run stays quiet (Value defaults to the time it went
# out). A dry run says so in the message and leaves the record alone, like the restart budget.
function Send-Alert($State, [string]$Name, [string]$Text, $Value = $null) {
  $prefix = if ($DryRun) { '[TEST] ' } else { '' }
  Notify ($prefix + $Text)
  if (-not $DryRun) {
    $recorded = if ($null -ne $Value) { $Value } else { (Get-Date).ToString('o') }
    Set-StateField $State $Name $recorded
    Write-State $State
  }
}

# deploy-local.ps1 writes its PID to run\deploy.lock when it starts and removes the file in a finally.
# Held means that deploy is still running: the process exists, it started before the lock was written
# (a PID reused after a reboot started later), and the lock is younger than DeployLockStaleMinutes.
# A lock that fails any of those is stale: a crashed or killed deploy, or one that hangs.
function Get-DeployLock {
  $lock = [pscustomobject]@{ Present = $false; Held = $false; ProcessId = 0; Stamp = ''; AgeMinutes = 0; Reason = '' }
  if (-not (Test-Path -LiteralPath $LockFile)) { return $lock }
  $lock.Present = $true
  try {
    $item = Get-Item -LiteralPath $LockFile -ErrorAction Stop
    $lock.Stamp = [string]$item.LastWriteTimeUtc.Ticks
    $lock.AgeMinutes = [int]((Get-Date) - $item.LastWriteTime).TotalMinutes
    $raw = Get-Content -LiteralPath $LockFile -ErrorAction Stop | Select-Object -First 1
    $lockPid = 0
    if (-not [int]::TryParse("$raw".Trim(), [ref]$lockPid)) { $lock.Reason = 'the lock file holds no process id'; return $lock }
    $lock.ProcessId = $lockPid
    $proc = Get-Process -Id $lockPid -ErrorAction SilentlyContinue
    if (-not $proc) { $lock.Reason = "process $lockPid is not running"; return $lock }
    if ($proc.StartTime -gt $item.LastWriteTime.AddSeconds(5)) { $lock.Reason = "process $lockPid started after the lock was written"; return $lock }
    if ($lock.AgeMinutes -ge $DeployLockStaleMinutes) { $lock.Reason = "process $lockPid has held it for $($lock.AgeMinutes) min"; return $lock }
    $lock.Held = $true
  } catch {
    # A deploy that is writing the lock right now has it open; an unreadable lock is treated as held
    # until it is old enough to be called stale, because a wrong "stale" restarts the app mid-swap.
    $lock.Reason = 'the lock file could not be read: ' + $_.Exception.Message
    $lock.Held = ($lock.AgeMinutes -lt $DeployLockStaleMinutes)
  }
  return $lock
}

# Once per lock file, so a lock left behind is one message, not one every 5 minutes.
function Report-StaleDeployLock($Lock, $State) {
  Log ("stale deploy.lock ({0}); not blocking the watchdog" -f $Lock.Reason)
  if ((Get-StateField $State 'staleLockAlerted') -eq $Lock.Stamp) { return }
  $text = "LashKirja: deploy.lock on jaanyt paalle ({0}, {1} min vanha). Deploy on todennakoisesti kaatunut tai jumissa; watchdog jatkaa normaalisti. Tarkista viimeisin deploy-loki: {2}" -f $Lock.Reason, $Lock.AgeMinutes, $LogDir
  Send-Alert $State 'staleLockAlerted' $text $Lock.Stamp
}

# backup-local.ps1 runs daily at 03:00. A newest zip older than BackupMaxAgeHours means a run was
# missed or keeps failing, and BACKUP-FAILED.txt is a file nobody opens. Any zip counts, a predeploy one too.
function Test-BackupFresh($State) {
  try {
    $newest = $null
    if (Test-Path -LiteralPath $BackupDir) {
      $newest = Get-ChildItem -LiteralPath $BackupDir -Filter 'lashkirja-*.zip' -File |
        Where-Object { $_.Name -match '^lashkirja-\d{4}-\d{2}-\d{2}.*\.zip$' } |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    }
    if ($newest) {
      $ageHours = ((Get-Date) - $newest.LastWriteTime).TotalHours
      if ($ageHours -le $BackupMaxAgeHours) {
        if (Get-StateField $State 'backupAlerted') { Set-StateField $State 'backupAlerted' $null; if (-not $DryRun) { Write-State $State } }
        return
      }
      $what = "uusin varmuuskopio on {0:N0} h vanha ({1})" -f $ageHours, $newest.Name
    } else {
      $what = "varmuuskopioita ei loydy kansiosta $BackupDir"
    }
    Log "backup stale: $what"
    if (Test-AlertDue $State 'backupAlerted') {
      Send-Alert $State 'backupAlerted' "LashKirja HATA: $what (raja $BackupMaxAgeHours h). Tarkista C:\LashKirja\logs\BACKUP-FAILED.txt ja backup-lokit."
    }
  } catch {
    Log ('backup age check failed: ' + $_.Exception.Message)
  }
}

function Warn-LowSpace($State) {
  Log 'disk: low-space (health 503, db and the rest still serving); not restarting'
  if (Test-AlertDue $State 'lowSpaceAlerted') {
    Send-Alert $State 'lowSpaceAlerted' 'LashKirja: levytila on vahissa (health: low-space). Vapauta tilaa ennen kuin tallennus ja varmuuskopiot alkavat epaonnistua.'
  }
}

function Restart-App([string]$Reason) {
  Log "restarting: $Reason"
  if ($DryRun) { Log 'dry run: restart suppressed'; return $false }
  try {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $OpsDir 'run-prod.ps1') -Stop -Root $Root 2>&1
    foreach ($line in $out) { Log ('    ' + "$line") }
  } catch { Log ('stop failed: ' + $_.Exception.Message) }
  Start-Sleep -Seconds 2
  try {
    Start-ScheduledTask -TaskName $TaskName
    Log "started scheduled task '$TaskName'"
  } catch {
    Log ('Start-ScheduledTask failed: ' + $_.Exception.Message + '; starting the supervisor directly')
    Start-Process -FilePath powershell.exe -WindowStyle Hidden -ArgumentList @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $OpsDir 'run-prod.ps1'), '-Root', $Root) | Out-Null
  }
  $deadline = (Get-Date).AddSeconds($RestartWaitSeconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 5
    $state = Probe-Health
    if ($state -eq 'ok' -or $state -eq 'degraded') { Log "recovered after restart ($state)"; return $true }
  }
  Log 'still unhealthy after restart'
  return $false
}

$exitCode = 0
try {
  $state = Read-State

  # Nothing below may run while a deploy swaps the release: a restart then ends with "file is being
  # used by another process" and a failed rollback (2026-10-21).
  $deployLock = Get-DeployLock
  if ($deployLock.Held) {
    Log ("deploy in progress (lock {0} min old, process {1}): not probing, not restarting" -f $deployLock.AgeMinutes, $deployLock.ProcessId)
    exit 0
  }
  if ($deployLock.Present) { Report-StaleDeployLock $deployLock $state }

  Test-BackupFresh $state

  $first = Probe-Health
  $supervisorRunning = Get-SupervisorRunning

  if ($first -eq 'ok' -or $first -eq 'degraded') {
    if ($state.lastStatus -ne 'healthy' -and $state.lastStatus -ne 'unknown') {
      Notify "LashKirja: palvelin vastaa taas (health $first)."
    }
    Log "healthy ($first)"
    if ($script:LowSpace) { Warn-LowSpace $state }
    $state.consecutiveFailures = 0
    $state.lastStatus = 'healthy'
    Write-State $state
    if (-not $supervisorRunning) {
      Log 'health is fine but the supervisor is not running; starting the scheduled task'
      if (-not $DryRun) {
        try { Start-ScheduledTask -TaskName $TaskName; Log "started scheduled task '$TaskName'" }
        catch { Log ('Start-ScheduledTask failed: ' + $_.Exception.Message) }
      }
    }
    exit 0
  }

  Log "health not ok: $first (supervisor running: $supervisorRunning)"
  Start-Sleep -Seconds $ConfirmWaitSeconds
  $second = Probe-Health
  Log "second probe: $second"
  if ($second -eq 'ok' -or $second -eq 'degraded') {
    Log 'recovered on its own; no restart'
    if ($script:LowSpace) { Warn-LowSpace $state }
    $state.consecutiveFailures = 0
    $state.lastStatus = 'healthy'
    Write-State $state
    exit 0
  }

  $state.consecutiveFailures = [int]$state.consecutiveFailures + 1
  $state.lastStatus = 'unhealthy'
  Write-State $state

  $tooSoon = $false
  $since = $null
  if ($state.lastRestart) {
    $since = (Get-Date) - [datetime]$state.lastRestart
    if ($since.TotalMinutes -lt $MinRestartGapMinutes) { $tooSoon = $true }
  }
  if ($tooSoon -and -not $DryRun) {
    Log ("unhealthy, but a restart ran {0:N1} min ago (< {1} min): not restarting again" -f $since.TotalMinutes, $MinRestartGapMinutes)
    exit 1
  }

  # The probes took at least ConfirmWaitSeconds; a deploy may have taken the lock meanwhile.
  if ((Get-DeployLock).Held) {
    Log 'a deploy took the lock while the probes ran: not restarting'
    exit 0
  }

  $reason = if ($supervisorRunning) { "health $second (supervisor alive, child wedged)" } else { "health $second and the supervisor is not running" }
  $ok = Restart-App $reason
  # A dry run must not consume the restart budget: leave lastRestart alone.
  if (-not $DryRun) { $state.lastRestart = (Get-Date).ToString('o') }
  $state.lastStatus = if ($ok) { 'healthy' } elseif ($DryRun) { 'unhealthy' } else { 'unhealthy' }
  Write-State $state

  $prefix = if ($DryRun) { '[TEST] ' } else { '' }
  if ($ok) { Notify ($prefix + "LashKirja: palvelin ei vastannut ($second), aloitin sen uudelleen - nyt kunnossa.") }
  else { Notify ($prefix + "LashKirja HATA: palvelin ei vastaa ($second) eika uudelleenaloitus auttanut. Lokit: C:\LashKirja\logs") }
  if (-not $ok) { $exitCode = 1 }
} catch {
  Log ('watchdog failed: ' + $_.Exception.Message)
  $exitCode = 2
}
exit $exitCode
