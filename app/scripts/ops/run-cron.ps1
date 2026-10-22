<#
.SYNOPSIS
  Calls the LashKirja recurring-invoices and cleanup cron routes on the
  running production instance.

.DESCRIPTION
  Nothing else calls app/src/app/api/cron/recurring-invoices and
  app/src/app/api/cron/cleanup in this deployment (sync-bank and sync-email
  are already covered by the always-on worker, scripts/worker.ts, on a 10
  minute loop -- see final review I4). Without a scheduler, recurring
  invoices never generate or send, and expired uploads never get purged.

  Reads CRON_SECRET from the production .env at run time and sends it only
  as the Authorization header of the two requests. The secret is never
  written to the Scheduled Task definition (install-tasks.ps1 registers
  this script with no secret argument), never logged, and never echoed to
  the console.

  Both routes are date-granular (recurring invoices compare against
  "today"; expired uploads compare against an expiry timestamp) and each
  has its own catch-up/best-effort handling server-side, so an hourly cycle
  with StartWhenAvailable is enough to survive the PC being off or asleep
  at the scheduled time without ever missing a day.

  Logs to C:\LashKirja\logs\cron-YYYY-MM-DD.log. Exits non-zero if either
  call fails or returns a non-2xx status, but always attempts both calls
  regardless of the other's outcome.

  A failing run also sends the owner a Telegram line (Notify from lk-common.ps1, the path the
  watchdog uses). The task runs hourly, so while a failure lasts the line goes out at most once per
  AlertGapHours; a run that succeeds resets that, and the next failure alerts at once.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File run-cron.ps1
#>
[CmdletBinding()]
param(
  [string]$Root = 'C:\LashKirja',
  [int]$Port = 3300,
  [int]$AlertGapHours = 12
)

$ErrorActionPreference = 'Stop'
$AppDir = Join-Path $Root 'prod\app'
$LogDir = Join-Path $Root 'logs'
$RunDir = Join-Path $Root 'run'
foreach ($dir in @($LogDir, $RunDir)) {
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
}
$LogFile = Join-Path $LogDir ("cron-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))
$AlertStamp = Join-Path $RunDir 'cron-alert.txt'

function Log([string]$Message) {
  $line = "{0} {1}" -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss'), $Message
  Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
  # Not Write-Output: Invoke-CronRoute logs and then returns its verdict, and anything it writes to the
  # output stream becomes part of that return value. The array was always truthy, so the exit code
  # was 0 even when both routes answered 500.
  Write-Host $line
}

# An alert that cannot be sent must never change what this script does or its exit code, so a
# missing or broken helper only costs the alert.
try { . (Join-Path $PSScriptRoot 'lk-common.ps1') }
catch {
  Log ('alerting unavailable: ' + $_.Exception.Message)
  function Notify([string]$Text) { Log ('notify unavailable: ' + $Text) }
}

# True when no alert went out in the last AlertGapHours.
function Test-AlertDue {
  if (-not (Test-Path -LiteralPath $AlertStamp)) { return $true }
  try {
    $last = [datetime](Get-Content -LiteralPath $AlertStamp -ErrorAction Stop | Select-Object -First 1)
    return (((Get-Date) - $last).TotalHours -ge $AlertGapHours)
  } catch {
    Log ('cron-alert.txt is unreadable (' + $_.Exception.Message + '); alerting again')
    return $true
  }
}

function Get-CronSecret {
  $envFile = Join-Path $AppDir '.env'
  if (-not (Test-Path -LiteralPath $envFile)) { return '' }
  foreach ($line in Get-Content -LiteralPath $envFile -Encoding UTF8) {
    if ($line -match '^\s*CRON_SECRET\s*=\s*"?([^"]*)"?\s*$') { return $Matches[1] }
  }
  return ''
}

function Invoke-CronRoute([string]$Name, [string]$Secret) {
  $uri = "http://127.0.0.1:$Port/api/cron/$Name"
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $uri -Headers @{ Authorization = "Bearer $Secret" } -TimeoutSec 300
    Log "$Name -> HTTP $($response.StatusCode)"
    return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300)
  } catch {
    $status = $_.Exception.Response.StatusCode.value__
    if ($status) { Log "$Name -> HTTP $status" } else { Log "$Name -> unreachable: $($_.Exception.Message)" }
    return $false
  }
}

$secret = Get-CronSecret
if (-not $secret) {
  Log 'CRON_SECRET is not set in the production .env; both routes will refuse the request (see app/src/lib/cron-auth.ts). Fix .env and re-run.'
}

# Both attempted regardless of the other's result, same principle as
# backup-local.ps1's per-account error isolation: one job's failure must
# not silently skip the other.
$okInvoices = Invoke-CronRoute 'recurring-invoices' $secret
$okCleanup = Invoke-CronRoute 'cleanup' $secret

if ($okInvoices -and $okCleanup) {
  Remove-Item -LiteralPath $AlertStamp -Force -ErrorAction SilentlyContinue
  exit 0
}

$failed = @()
if (-not $okInvoices) { $failed += 'recurring-invoices' }
if (-not $okCleanup) { $failed += 'cleanup' }
Log ('failed: ' + ($failed -join ', '))
if (Test-AlertDue) {
  # Route names and the log path only: the secret and the response bodies stay out of Telegram.
  Notify ("LashKirja HATA: ajastettu ajo epaonnistui ({0}). Loki: {1}" -f ($failed -join ', '), $LogFile)
  try { Set-Content -LiteralPath $AlertStamp -Value (Get-Date).ToString('o') -Encoding ASCII }
  catch { Log ('could not record the alert time in cron-alert.txt: ' + $_.Exception.Message) }
}
exit 1
