<#
.SYNOPSIS
  Deploys a git ref to the LashKirja production instance on this PC.

.DESCRIPTION
  Runs from anywhere. Works on C:\LashKirja\prod (a plain git clone) and logs
  to C:\LashKirja\logs\deploy-<timestamp>.log.

    1. git fetch <Remote>, resolve <Ref>
    2. PREPARE, while the live server keeps serving: C:\LashKirja\stage (a
       git worktree of prod) is checked out at the commit, gets prod's .env,
       npm ci, prisma generate and next build. A failure here leaves
       production untouched.
    3. stop the supervisor (downtime starts)
    4. backup-local.ps1 -Tag predeploy (skipped only when prod.db does not exist yet)
    5. SWAP: prod is checked out at the commit; app
ode_modules and app\.next
       are renamed to node_modules.prev / .next.prev and the staged ones are
       moved in (a rename on the same disk). Turbopack keeps junctions with
       absolute paths in .next
ode_modules; they are re-pointed from stage
       to prod (rehearsed 2026-10-08: without that, prisma and pino fail).
    6. prisma migrate deploy against C:\LashKirja\data\prod.db
    7. start the supervisor (the "LashKirja prod" Scheduled Task when registered)
    8. poll http://127.0.0.1:3300/api/health for up to 60 s. The app counts
       as up when the database and disk checks pass: a 503 caused only by
       the bank-job or mail checks (a user's failed bank sync in the last
       24 h, say) is logged as degraded, not treated as a failed deploy.

  Downtime is steps 3-8, about half a minute (2026-10-08: LashKirja is in
  live use). Before, install and build ran with the server stopped: 1.5 to 6
  minutes per deploy. On Windows npm ci cannot replace native modules the
  running server has loaded, and next build writes to the .next that next
  start serves, hence the separate stage directory.

  Failure handling -- production ends up on the previous version in every case:
    - fetch or prepare fails: the live server was never stopped; nothing to undo.
    - backup, swap, migrate or health fails: the previous commit is checked out
      again and node_modules.prev / .next.prev are renamed back (seconds, no
      reinstall). If migrate deploy has run (or may have), data\prod.db is also
      restored from the predeploy backup this run just took (verified against
      its MANIFEST.txt sha256); the migrated database is kept alongside as
      data\prod.db.post-migrate-failure-<timestamp>, never deleted. The previous
      version is then started and health-checked. If the database restore
      itself fails, the app is left STOPPED and the failure is logged -- do not
      start it until data\prod.db is confirmed restored (ops-windows.md, "Restore").

  Folders holding junctions (.next, .next.prev) are deleted with cmd's rmdir /s,
  which removes a junction without following it; a recursive Remove-Item
  could delete the live node_modules files a junction points to.

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
  [int]$HealthTimeoutSeconds = 60,
  # Another name only for a rehearsal on a copy (-Root elsewhere), so it never starts the live task.
  [string]$TaskName = 'LashKirja prod'
)

$ErrorActionPreference = 'Stop'
$ProdDir = Join-Path $Root 'prod'
$AppDir = Join-Path $ProdDir 'app'
$LogDir = Join-Path $Root 'logs'
$RunDir = Join-Path $Root 'run'
$OpsDir = $PSScriptRoot
$StageDir = Join-Path $Root 'stage'
$StageApp = Join-Path $StageDir 'app'
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

# The JSON body of a failed health request, under Windows PowerShell 5.1
# (WebException with a response stream) and PowerShell 7 (ErrorDetails).
function Get-HealthErrorBody($ErrorRecord) {
  try {
    $text = $null
    if ($ErrorRecord.ErrorDetails -and $ErrorRecord.ErrorDetails.Message) {
      $text = $ErrorRecord.ErrorDetails.Message
    } elseif ($ErrorRecord.Exception.Response -and ($ErrorRecord.Exception.Response | Get-Member -Name GetResponseStream)) {
      $reader = New-Object System.IO.StreamReader($ErrorRecord.Exception.Response.GetResponseStream())
      try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() }
    }
    if ($text) { return ($text | ConvertFrom-Json) }
  } catch {}
  return $null
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
      # 503 with the database and disk fine means the app serves; only the
      # bank-job or mail checks are red (a user's failed bank sync keeps
      # bankJobs red for 24 h). That must not roll a good deploy back.
      if ($status -eq 503) {
        $body = Get-HealthErrorBody $_
        if ($body -and $body.checks -and $body.checks.db.ok -and $body.checks.disk.ok) {
          $red = @('bankJobs', 'mail') | Where-Object { -not $body.checks.$_.ok }
          Log ("health: HTTP 503 but db and disk are ok; serving, degraded: " + ($red -join ', '))
          return $true
        }
      }
    }
    Start-Sleep -Seconds 2
  }
  Log "health: gave up after $TimeoutSeconds s (last: $last)"
  return $false
}

function Stop-Supervisor {
  Log 'stopping supervisor'
  # PS 5.1 turns a child process's stderr lines into ErrorRecords when
  # captured with 2>&1; under $ErrorActionPreference='Stop' (set globally
  # above) the first one throws instead of just being collected. Relax the
  # preference for the call, exactly like Exec() already does for native
  # commands, and check $LASTEXITCODE instead of relying on a thrown error.
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $OpsDir 'run-prod.ps1') -Stop -Root $Root 2>&1
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $old
  }
  foreach ($line in $out) { Log ("    " + (Format-Line $line)) }
  if ($code -ne 0) { Log "run-prod.ps1 -Stop exited with code $code (continuing; it may already be stopped)" }
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

# Deletes a folder without following the junctions inside it (see the header).
function Remove-Tree([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  & cmd.exe /d /c "rmdir /s /q `"$Path`""
  if (Test-Path -LiteralPath $Path) { throw "could not delete $Path" }
}

# Junctions under .next\node_modules (Turbopack's external packages) that point
# into $FromApp are pointed at the same place under $ToApp.
function Repoint-Junctions([string]$NextDir, [string]$FromApp, [string]$ToApp) {
  $root = Join-Path $NextDir 'node_modules'
  if (-not (Test-Path -LiteralPath $root)) { return }
  $count = 0
  Get-ChildItem -LiteralPath $root -Force -Recurse -Depth 1 | Where-Object { $_.LinkType -eq 'Junction' } | ForEach-Object {
    $target = [string]$_.Target
    if ($target.StartsWith($FromApp, [StringComparison]::OrdinalIgnoreCase)) {
      $fixed = $ToApp + $target.Substring($FromApp.Length)
      [System.IO.Directory]::Delete($_.FullName, $false)
      New-Item -ItemType Junction -Path $_.FullName -Target $fixed | Out-Null
      $count++
    }
  }
  Log "re-pointed $count junctions in $root"
}

# The swap of step 5: prod's node_modules and .next become *.prev, the staged ones move in.
function Swap-InStagedRelease {
  foreach ($name in @('node_modules', '.next')) {
    $live = Join-Path $AppDir $name
    $prev = Join-Path $AppDir "$name.prev"
    Remove-Tree $prev
    if (Test-Path -LiteralPath $live) { Rename-Item -LiteralPath $live -NewName "$name.prev" }
    Move-Item -LiteralPath (Join-Path $StageApp $name) -Destination $live
  }
  Repoint-Junctions (Join-Path $AppDir '.next') $StageApp $AppDir
  if (-not (Test-Path (Join-Path $AppDir '.next\BUILD_ID'))) { throw 'swapped release has no .next\BUILD_ID' }
}

# Puts the previous release back: commit, node_modules and .next (renames only).
function Restore-PreviousRelease([string]$PrevSha) {
  $ok = $true
  try {
    if ($PrevSha) { Exec 'git' @('-C', $ProdDir, 'checkout', '--force', '--detach', $PrevSha) $ProdDir }
  } catch {
    Log "restoring the previous commit FAILED: $($_.Exception.Message)"
    $ok = $false
  }
  foreach ($name in @('node_modules', '.next')) {
    $live = Join-Path $AppDir $name
    $prev = Join-Path $AppDir "$name.prev"
    if (-not (Test-Path -LiteralPath $prev)) { continue }
    try {
      Remove-Tree $live
      Rename-Item -LiteralPath $prev -NewName $name
      Log "restored $name.prev as $name"
    } catch {
      Log "restoring $name FAILED: $($_.Exception.Message)"
      $ok = $false
    }
  }
  return $ok
}

# Restores data\prod.db from the predeploy backup zip this run took, for use
# when a migration has run (or may have run) against the database and the
# deploy is being rolled back. Verifies the zip's own MANIFEST.txt sha256
# before touching the live file, and never deletes the migrated database --
# it is kept alongside as prod.db.post-migrate-failure-<timestamp> so it can
# be inspected later.
function Restore-PredeployDb([string]$ZipPath) {
  if (-not $ZipPath -or -not (Test-Path -LiteralPath $ZipPath)) {
    Log 'no predeploy backup zip recorded; cannot restore data\prod.db automatically'
    return $false
  }
  $dbPath = Join-Path $Root 'data\prod.db'
  $temp = Join-Path $RunDir ("restore-predeploy-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($ZipPath, $temp)
    $manifest = Get-Content -LiteralPath (Join-Path $temp 'MANIFEST.txt') -Encoding UTF8
    $dbLine = $manifest | Where-Object { $_ -like 'db=*' } | Select-Object -First 1
    $restoredDb = Join-Path $temp 'prod.db'
    if (-not $dbLine) { throw 'MANIFEST.txt has no db= line' }
    if (-not (Test-Path -LiteralPath $restoredDb)) { throw 'zip has no prod.db' }
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $restoredDb).Hash.ToLowerInvariant()
    if ($hash -ne $dbLine.Substring(3)) { throw 'restored database sha256 does not match MANIFEST.txt' }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    if (Test-Path -LiteralPath $dbPath) {
      $quarantine = "$dbPath.post-migrate-failure-$stamp"
      Move-Item -LiteralPath $dbPath -Destination $quarantine -Force
      Log "kept the migrated (failed) database at $quarantine"
    }
    # The migrated database's write-ahead log and shared-memory index belong
    # to it, not to the backup: left beside the restored file, SQLite replays
    # them into it and reports SQLITE_CORRUPT. They go with the quarantined copy.
    foreach ($suffix in @('-wal', '-shm', '-journal')) {
      $side = "$dbPath$suffix"
      if (Test-Path -LiteralPath $side) {
        Move-Item -LiteralPath $side -Destination "$dbPath.post-migrate-failure-$stamp$suffix" -Force
        Log "moved $side aside with the failed database"
      }
    }
    Copy-Item -LiteralPath $restoredDb -Destination $dbPath -Force
    Log "restored data\prod.db from predeploy backup $ZipPath"
    return $true
  } catch {
    Log "restoring data\prod.db from predeploy backup FAILED: $($_.Exception.Message)"
    return $false
  } finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# Full rollback used after migrate deploy has run (or may have): the previous
# release AND database. Returns $true only if every step succeeded.
function Restore-FullPreviousVersion([string]$PrevSha, [string]$PredeployZip) {
  $ok = Restore-PreviousRelease $PrevSha
  if (-not (Restore-PredeployDb $PredeployZip)) { $ok = $false }
  return $ok
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

  # 2. prepare in the stage worktree while the live server keeps serving.
  $stage = 'prepare'
  if (-not (Test-Path (Join-Path $StageDir '.git'))) {
    if (Test-Path -LiteralPath $StageDir) { Remove-Tree $StageDir }
    Exec 'git' @('-C', $ProdDir, 'worktree', 'prune') $ProdDir
    Exec 'git' @('-C', $ProdDir, 'worktree', 'add', '--force', '--detach', $StageDir, $sha) $ProdDir
  } else {
    Exec 'git' @('-C', $StageDir, 'checkout', '--force', '--detach', $sha) $StageDir
  }
  # A failed earlier run may have left a build behind; npm ci replaces node_modules itself.
  Remove-Tree (Join-Path $StageApp '.next')
  Copy-Item -LiteralPath (Join-Path $AppDir '.env') -Destination (Join-Path $StageApp '.env') -Force
  # NODE_ENV stays unset so npm ci keeps the dev dependencies the build and the worker (tsx) need.
  Remove-Item Env:NODE_ENV -ErrorAction SilentlyContinue
  $env:NEXT_TELEMETRY_DISABLED = '1'
  Exec 'npm.cmd' @('ci', '--prefer-offline', '--no-audit', '--no-fund') $StageApp
  Exec 'node' @('node_modules\prisma\build\index.js', 'generate') $StageApp
  Exec 'node' @('node_modules\next\dist\bin\next', 'build') $StageApp
  if (-not (Test-Path (Join-Path $StageApp '.next\BUILD_ID'))) { throw 'build finished without .next\BUILD_ID' }
  Log 'prepared; stopping the live server for the swap'

  # 3. stop
  $stage = 'stop'
  $downAt = Get-Date
  Stop-Supervisor
  $stopped = $true

  # 4. backup, after the stop so nothing written before it can be lost to a restore
  $stage = 'backup'
  $predeployZip = $null
  if (Test-Path (Join-Path $Root 'data\prod.db')) {
    # Same PS 5.1 stderr-under-Stop issue as Stop-Supervisor: scope the
    # preference around the capture, then decide success from $LASTEXITCODE.
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $OpsDir 'backup-local.ps1') -Root $Root -Tag predeploy 2>&1
      $backupCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $old
    }
    foreach ($line in $out) { Log ("    " + (Format-Line $line)) }
    if ($backupCode -ne 0) { throw "backup-local.ps1 exited with code $backupCode" }
    $predeployZip = Get-ChildItem -LiteralPath (Join-Path $Root 'backups') -Filter 'lashkirja-*-predeploy.zip' -File -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1 | ForEach-Object { $_.FullName }
    if (-not $predeployZip) { Log 'WARNING: predeploy backup reported success but the zip could not be located afterward; an automatic database restore will not be possible if migrate deploy fails' }
    else { Log "predeploy backup: $predeployZip" }
  } else {
    Log 'no prod.db yet (first deploy); backup skipped, migrate deploy creates it'
  }

  # 5. swap
  $stage = 'swap'
  if ($isBranch) { Exec 'git' @('-C', $ProdDir, 'checkout', '--force', '-B', $Ref, $sha) $ProdDir }
  else { Exec 'git' @('-C', $ProdDir, 'checkout', '--force', '--detach', $sha) $ProdDir }
  Swap-InStagedRelease

  # 6. migrate. From here on, a failure must restore the database too.
  $stage = 'migrate'
  Exec 'node' @('node_modules\prisma\build\index.js', 'migrate', 'deploy')

  # 7-8. start and verify
  $stage = 'health'
  Start-Supervisor
  $stopped = $false
  if (-not (Test-Health $HealthTimeoutSeconds)) {
    Log 'new build is not healthy; rolling back to the previous release and database'
    Stop-Supervisor
    $stopped = $true
    if (Restore-FullPreviousVersion $prevSha $predeployZip) {
      Start-Supervisor
      $stopped = $false
      if (Test-Health $HealthTimeoutSeconds) { Log 'rollback healthy (previous code and database)' }
      else { Log 'rollback ALSO unhealthy; check logs\web-*.log. The app is left STOPPED to avoid serving a broken rollback.' }
    } else {
      Log 'rollback could not be completed safely; the app is left STOPPED. Check the log and restore manually (ops-windows.md, "Restore") before starting it.'
    }
    throw 'deploy failed health check'
  }
  Log ("deploy OK: $sha (server down {0:N0} s)" -f ((Get-Date) - $downAt).TotalSeconds)
} catch {
  $exitCode = 1
  Log "deploy FAILED at stage '$stage': $($_.Exception.Message)"
  if ($stage -in @('fetch', 'prepare')) {
    # The live server was never stopped.
    if ($stopped) { Start-Supervisor }
  } elseif ($stage -in @('stop', 'backup', 'swap')) {
    # migrate deploy has not run: the database is untouched, only the release is put back.
    if (Restore-PreviousRelease $prevSha) {
      Start-Supervisor
      $stopped = $false
      if (Test-Health $HealthTimeoutSeconds) { Log 'previous version is back up' } else { Log 'previous version did not come back healthy' }
    } else {
      Log 'restoring the previous release failed; the app is left STOPPED. Check the log before starting it.'
    }
  } elseif ($stage -eq 'migrate') {
    # migrate deploy failed (or was interrupted) partway -- the database may
    # be on a partial/new schema. Restore release AND database, then bring
    # the previous version back up rather than leaving it stopped.
    Log 'migration failed; restoring the previous release and database'
    if (Restore-FullPreviousVersion $prevSha $predeployZip) {
      Start-Supervisor
      $stopped = $false
      if (Test-Health $HealthTimeoutSeconds) { Log 'previous version (code + database) is back up' }
      else { Log 'previous version did not come back healthy after restore; check logs\web-*.log' }
    } else {
      Log 'automatic restore after the migration failure could not be completed safely. The app is left STOPPED -- do not start it until data\prod.db is confirmed restored (ops-windows.md, "Restore").'
    }
  }
} finally {
  Remove-Item -LiteralPath $LockFile -Force -ErrorAction SilentlyContinue
  Log "log: $LogFile"
}
exit $exitCode
