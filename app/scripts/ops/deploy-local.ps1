<#
.SYNOPSIS
  Deploys a git ref to the LashKirja production instance on this PC.

.DESCRIPTION
  Runs from anywhere. Works on C:\LashKirja\prod (a plain git clone) and logs
  to C:\LashKirja\logs\deploy-<timestamp>.log.

    1. git fetch <Remote>, resolve <Ref>
    2. stop the supervisor (see "Why the app stops" below)
    3. git checkout of the resolved commit
    4. npm ci --prefer-offline
    5. prisma generate
    6. backup-local.ps1 -Tag predeploy (skipped only when prod.db does not exist yet)
    7. prisma migrate deploy against C:\LashKirja\data\prod.db
    8. keep the previous build as .next.prev, then next build into a fresh .next
    9. start the supervisor (the "LashKirja prod" Scheduled Task when registered)
   10. poll http://127.0.0.1:3300/api/health for up to 60 s

  Failure handling:
    - install, generate, backup or build fails: the previous build (.next.prev) and the
      previous commit are put back, and the old version is started again.
    - migrate deploy fails: the app stays stopped. Do not serve a database a
      failed migration touched; restore the predeploy zip (ops-windows.md).
    - health fails after start: .next.prev is swapped back and restarted.

  Why the app stops: on Windows, npm ci cannot replace native modules
  (.node files) that the running server has loaded, and next build always
  writes to the .next directory that next start serves from (distDir is fixed
  in next.config.ts). So the swap happens with the server stopped. Downtime
  is the install plus the build: 1.5 to 6 minutes, longer when the PC is busy.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File deploy-local.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File deploy-local.ps1 -Remote github -Ref main
#>
[CmdletBinding()]
param(
  [string]$Remote = 'origin',
  [string]$Ref = 'feat/real-app-phase01',
  [string]$Root = 'C:\LashKirja',
  [int]$Port = 3300,
  [int]$HealthTimeoutSeconds = 60
)

$ErrorActionPreference = 'Stop'
$ProdDir = Join-Path $Root 'prod'
$AppDir = Join-Path $ProdDir 'app'
$LogDir = Join-Path $Root 'logs'
$RunDir = Join-Path $Root 'run'
$OpsDir = $PSScriptRoot
$TaskName = 'LashKirja prod'
foreach ($dir in @($LogDir, $RunDir)) {
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
}
$LogFile = Join-Path $LogDir ("deploy-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
$LockFile = Join-Path $RunDir 'deploy.lock'

function Log([string]$Message) {
  $line = "{0} {1}" -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss'), $Message
  Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
  Write-Host $line
}

# Native stderr arrives as ErrorRecords; an empty one would print its type name.
function Format-Line($Item) {
  if ($Item -is [System.Management.Automation.ErrorRecord]) { return $Item.Exception.Message }
  return "$Item"
}

# Runs a native command, streams its output into the deploy log, throws on a
# non-zero exit. PowerShell 5.1 turns native stderr into error records, so the
# preference is relaxed for the call.
function Exec([string]$File, [string[]]$ArgList, [string]$Cwd = $AppDir) {
  Log ("> {0} {1}" -f $File, ($ArgList -join ' '))
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  Push-Location $Cwd
  try {
    & $File @ArgList 2>&1 | ForEach-Object {
      $text = Format-Line $_
      Log ("    " + $text)
    }
    $code = $LASTEXITCODE
  } finally {
    Pop-Location
    $ErrorActionPreference = $old
  }
  if ($code -ne 0) { throw "$File $($ArgList -join ' ') exited with code $code" }
}

function Get-HealthToken {
  $envFile = Join-Path $AppDir '.env'
  foreach ($line in Get-Content -LiteralPath $envFile -Encoding UTF8) {
    if ($line -match '^\s*HEALTH_TOKEN\s*=\s*"?([^"]*)"?\s*$') { return $Matches[1] }
  }
  return ''
}

function Test-Health([int]$TimeoutSeconds) {
  $token = Get-HealthToken
  $headers = @{}
  if ($token) { $headers['Authorization'] = "Bearer $token" }
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $last = ''
  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/health" -Headers $headers -TimeoutSec 5
      if ($response.StatusCode -eq 200) { Log "health: HTTP 200"; return $true }
      $last = "HTTP $($response.StatusCode)"
    } catch {
      $status = $_.Exception.Response.StatusCode.value__
      $last = if ($status) { "HTTP $status" } else { 'unreachable' }
    }
    Start-Sleep -Seconds 2
  }
  Log "health: gave up after $TimeoutSeconds s (last: $last)"
  return $false
}

function Stop-Supervisor {
  Log 'stopping supervisor'
  $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $OpsDir 'run-prod.ps1') -Stop -Root $Root 2>&1
  foreach ($line in $out) { Log ("    " + (Format-Line $line)) }
}

function Start-Supervisor {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) {
    Log "starting Scheduled Task '$TaskName'"
    Start-ScheduledTask -TaskName $TaskName
    return
  }
  $script = Join-Path $AppDir 'scripts\ops\run-prod.ps1'
  if (-not (Test-Path $script)) { $script = Join-Path $OpsDir 'run-prod.ps1' }
  Log "no Scheduled Task '$TaskName'; starting $script directly (run install-tasks.ps1 to survive logon)"
  Start-Process -FilePath powershell.exe -WindowStyle Hidden -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$script`"", '-Root', "`"$Root`"", '-Port', $Port)
}

function Restore-PreviousBuild {
  $next = Join-Path $AppDir '.next'
  $prev = Join-Path $AppDir '.next.prev'
  if (-not (Test-Path $prev)) { Log 'no .next.prev to restore'; return $false }
  if (Test-Path $next) { Remove-Item -LiteralPath $next -Recurse -Force }
  Rename-Item -LiteralPath $prev -NewName '.next'
  Log 'restored .next.prev as .next'
  return $true
}

if (Test-Path $LockFile) {
  $lockPid = 0
  [void][int]::TryParse(((Get-Content $LockFile -ErrorAction SilentlyContinue) -join ''), [ref]$lockPid)
  if ($lockPid -and (Get-Process -Id $lockPid -ErrorAction SilentlyContinue)) {
    Write-Error "another deploy is running (pid $lockPid)"
    exit 1
  }
}
Set-Content -LiteralPath $LockFile -Value $PID

$exitCode = 0
$stage = 'start'
$prevSha = ''
$stopped = $false
try {
  Log "deploy start remote=$Remote ref=$Ref prod=$ProdDir log=$LogFile"
  if (-not (Test-Path (Join-Path $ProdDir '.git'))) { throw "$ProdDir is not a git checkout (see ops-windows.md, first-time setup)" }
  if (-not (Test-Path (Join-Path $AppDir '.env'))) { throw "$AppDir\.env is missing (see ops-windows.md, first-time setup)" }

  # 1. fetch and resolve
  $stage = 'fetch'
  Exec 'git' @('-C', $ProdDir, 'fetch', $Remote, '--prune', '--tags') $ProdDir
  $prevSha = (& git -C $ProdDir rev-parse HEAD).Trim()
  $isBranch = $true
  $sha = (& git -C $ProdDir rev-parse --verify --quiet "refs/remotes/$Remote/$Ref^{commit}")
  if (-not $sha) {
    $isBranch = $false
    $sha = (& git -C $ProdDir rev-parse --verify --quiet "$Ref^{commit}")
  }
  if (-not $sha) { throw "cannot resolve $Ref on $Remote" }
  $sha = $sha.Trim()
  Log "current $prevSha -> target $sha"

  # 2. stop
  $stage = 'stop'
  Stop-Supervisor
  $stopped = $true

  # 3. checkout
  $stage = 'checkout'
  if ($isBranch) { Exec 'git' @('-C', $ProdDir, 'checkout', '--force', '-B', $Ref, $sha) $ProdDir }
  else { Exec 'git' @('-C', $ProdDir, 'checkout', '--force', '--detach', $sha) $ProdDir }

  # 4-5. install and generate. NODE_ENV stays unset here so npm ci keeps the
  # dev dependencies the build and the worker (tsx) need.
  $stage = 'install'
  Remove-Item Env:NODE_ENV -ErrorAction SilentlyContinue
  Exec 'npm.cmd' @('ci', '--prefer-offline', '--no-audit', '--no-fund')
  $stage = 'generate'
  Exec 'node' @('node_modules\prisma\build\index.js', 'generate')

  # 6. backup
  $stage = 'backup'
  if (Test-Path (Join-Path $Root 'data\prod.db')) {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $OpsDir 'backup-local.ps1') -Root $Root -Tag predeploy 2>&1
    $backupCode = $LASTEXITCODE
    foreach ($line in $out) { Log ("    " + (Format-Line $line)) }
    if ($backupCode -ne 0) { throw "backup-local.ps1 exited with code $backupCode" }
  } else {
    Log 'no prod.db yet (first deploy); backup skipped, migrate deploy creates it'
  }

  # 7. migrate
  $stage = 'migrate'
  Exec 'node' @('node_modules\prisma\build\index.js', 'migrate', 'deploy')

  # 8. build into a fresh .next, previous kept as .next.prev
  $stage = 'build'
  $next = Join-Path $AppDir '.next'
  $prev = Join-Path $AppDir '.next.prev'
  if (Test-Path $prev) { Remove-Item -LiteralPath $prev -Recurse -Force }
  if (Test-Path $next) { Rename-Item -LiteralPath $next -NewName '.next.prev' }
  $env:NEXT_TELEMETRY_DISABLED = '1'
  Exec 'node' @('node_modules\next\dist\bin\next', 'build')
  if (-not (Test-Path (Join-Path $next 'BUILD_ID'))) { throw 'build finished without .next\BUILD_ID' }

  # 9-10. start and verify
  $stage = 'health'
  Start-Supervisor
  $stopped = $false
  if (-not (Test-Health $HealthTimeoutSeconds)) {
    Log 'new build is not healthy; rolling back to .next.prev'
    Stop-Supervisor
    if (Restore-PreviousBuild) {
      Start-Supervisor
      if (Test-Health $HealthTimeoutSeconds) { Log 'rollback healthy (previous build, current database)' }
      else { Log 'rollback ALSO unhealthy; check logs\web-*.log' }
    }
    throw 'deploy failed health check'
  }
  Log "deploy OK: $sha"
} catch {
  $exitCode = 1
  Log "deploy FAILED at stage '$stage': $($_.Exception.Message)"
  if ($stage -in @('checkout', 'install', 'generate', 'backup', 'build')) {
    try {
      Log "restoring previous commit $prevSha"
      if ($prevSha) { Exec 'git' @('-C', $ProdDir, 'checkout', '--force', '--detach', $prevSha) $ProdDir }
      if ($stage -ne 'checkout') {
        Exec 'npm.cmd' @('ci', '--prefer-offline', '--no-audit', '--no-fund')
        Exec 'node' @('node_modules\prisma\build\index.js', 'generate')
      }
      if ($stage -eq 'build') {
        $partial = Join-Path $AppDir '.next'
        if ((Test-Path (Join-Path $AppDir '.next.prev')) -and (Test-Path $partial)) { Remove-Item -LiteralPath $partial -Recurse -Force }
        [void](Restore-PreviousBuild)
      }
      Start-Supervisor
      $stopped = $false
      if (Test-Health $HealthTimeoutSeconds) { Log 'previous version is back up' } else { Log 'previous version did not come back healthy' }
    } catch {
      Log "restore of the previous version failed: $($_.Exception.Message)"
    }
  } elseif ($stage -eq 'migrate') {
    Log 'migration failed: the app stays STOPPED. Restore the predeploy backup (ops-windows.md, "Restore") before starting it again.'
  } elseif ($stage -in @('fetch', 'stop')) {
    if ($stopped) { Start-Supervisor }
  }
} finally {
  Remove-Item -LiteralPath $LockFile -Force -ErrorAction SilentlyContinue
  Log "log: $LogFile"
}
exit $exitCode
