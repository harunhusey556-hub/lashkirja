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

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File run-cron.ps1
#>
[CmdletBinding()]
param(
  [string]$Root = 'C:\LashKirja',
  [int]$Port = 3300
)

$ErrorActionPreference = 'Stop'
$AppDir = Join-Path $Root 'prod\app'
$LogDir = Join-Path $Root 'logs'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }
$LogFile = Join-Path $LogDir ("cron-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))

function Log([string]$Message) {
  $line = "{0} {1}" -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss'), $Message
  Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
  Write-Output $line
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

if ($okInvoices -and $okCleanup) { exit 0 } else { exit 1 }
