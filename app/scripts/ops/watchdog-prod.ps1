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

  ASCII only on purpose: Windows PowerShell 5.1 reads a .ps1 without a BOM as Windows-1252, and
  non-ASCII characters in this file would break its string terminators.

  Exit codes: 0 = healthy or recovered, 1 = still unhealthy, 2 = watchdog itself failed.

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
  [string]$TaskName = 'LashKirja prod',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$AppDir = Join-Path $Root 'prod\app'
$EnvFile = Join-Path $AppDir '.env'
$LogDir = Join-Path $Root 'logs'
$RunDir = Join-Path $Root 'run'
$StateFile = Join-Path $RunDir 'watchdog-state.json'
$OpsDir = $PSScriptRoot
$HermesEnv = Join-Path $env:LOCALAPPDATA 'hermes\.env'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }
if (-not (Test-Path $RunDir)) { New-Item -ItemType Directory -Force -Path $RunDir | Out-Null }
$LogFile = Join-Path $LogDir ("watchdog-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))

function Log([string]$Message) {
  $line = "{0} {1}" -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss'), $Message
  Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
}

function Read-DotEnv([string]$Path) {
  $values = [ordered]@{}
  if (-not (Test-Path $Path)) { return $values }
  foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
    if ($line -match '^\s*#' -or $line -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$') { continue }
    $key = $Matches[1]
    $value = $Matches[2].Trim()
    if ($value.Length -ge 2 -and (($value[0] -eq '"' -and $value[-1] -eq '"') -or ($value[0] -eq "'" -and $value[-1] -eq "'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    $values[$key] = $value
  }
  return $values
}

$appEnv = Read-DotEnv $EnvFile

function Notify([string]$Text) {
  try {
    $hermes = Read-DotEnv $HermesEnv
    $token = $hermes['TELEGRAM_BOT_TOKEN']
    $chat = $hermes['TELEGRAM_HOME_CHANNEL']
    if (-not $token -or -not $chat) { Log 'notify skipped (no telegram token/chat configured)'; return }
    $body = @{ chat_id = $chat; text = $Text } | ConvertTo-Json -Compress
    Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot$token/sendMessage" `
      -ContentType 'application/json; charset=utf-8' -Body $body -TimeoutSec 20 | Out-Null
    Log 'notified owner'
  } catch {
    Log ('notify failed: ' + $_.Exception.Message)
  }
}

# 'ok' | 'degraded' | 'down_<status>' | 'unreachable'
function Probe-Health {
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
        if ($json.checks.db.ok -and $json.checks.disk.ok) { return 'degraded' }
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
  $first = Probe-Health
  $supervisorRunning = Get-SupervisorRunning

  if ($first -eq 'ok' -or $first -eq 'degraded') {
    if ($state.lastStatus -ne 'healthy' -and $state.lastStatus -ne 'unknown') {
      Notify "LashKirja: palvelin vastaa taas (health $first)."
    }
    Log "healthy ($first)"
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
