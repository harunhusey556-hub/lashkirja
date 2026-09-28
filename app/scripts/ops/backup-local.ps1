<#
.SYNOPSIS
  Daily backup of the LashKirja production instance on Windows.

.DESCRIPTION
  1. Takes a consistent SQLite snapshot with VACUUM INTO through the app's
     own @libsql/client (the sqlite3 CLI is not required). The live file is
     never copied while it is being written. The snapshot must pass
     PRAGMA integrity_check.
  2. Copies data\uploads after the snapshot, so every upload the snapshot
     references is already on disk.
  3. Writes MANIFEST.txt (db sha256, user count, one sha256 per upload) and
     zips everything to backups\lashkirja-YYYY-MM-DD.zip. A second run on the
     same day, or a tagged run (deploy), gets a time suffix.
  4. Retention: every backup from the 30 most recent backup days, plus the
     first backup of every month for 10 years (kirjanpitolaki). The monthly
     rule covers the "12 monthly copies" requirement and keeps more.
  5. If $env:OneDrive exists, mirrors the zip to
     $env:OneDrive\LashKirja-backups\ with the same retention.

  The production .env is NOT in the zip. SESSION_SECRET also encrypts the
  stored mailbox and bank secrets, so keep a copy of that file in a
  password manager (see app/docs/ops-windows.md).

  -RestoreTest restores the newest zip into a temp directory, checks every
  manifest hash, runs PRAGMA integrity_check and counts the User rows.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File backup-local.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File backup-local.ps1 -RestoreTest
#>
[CmdletBinding()]
param(
  [switch]$RestoreTest,
  [string]$Tag = '',
  [string]$Root = 'C:\LashKirja',
  # Where node_modules\@libsql\client comes from. Defaults to the production checkout.
  [string]$AppDir = '',
  [int]$KeepDays = 30,
  [int]$KeepMonthlyYears = 10,
  [switch]$NoMirror
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

if (-not $AppDir) { $AppDir = Join-Path $Root 'prod\app' }
$DataDir = Join-Path $Root 'data'
$DbPath = Join-Path $DataDir 'prod.db'
$UploadsDir = Join-Path $DataDir 'uploads'
$BackupDir = Join-Path $Root 'backups'
$LogDir = Join-Path $Root 'logs'
$RunDir = Join-Path $Root 'run'
foreach ($dir in @($BackupDir, $LogDir, $RunDir)) {
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
}
$LogFile = Join-Path $LogDir ("backup-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))

function Log([string]$Message) {
  $line = "{0} {1}" -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss'), $Message
  Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
  Write-Output $line
}

# One small Node helper, run with the production checkout's @libsql/client.
$Helper = Join-Path $RunDir 'lk-sqlite-helper.cjs'
Set-Content -LiteralPath $Helper -Encoding ASCII -Value @'
const path = require("path");
const { createClient } = require(path.join(process.env.LK_APP_DIR, "node_modules", "@libsql", "client"));
const fileUrl = (p) => "file:" + path.resolve(p).replace(/\\/g, "/");
async function check(dbPath) {
  const db = createClient({ url: fileUrl(dbPath) });
  try {
    const integrity = (await db.execute("PRAGMA integrity_check")).rows.map((r) => Object.values(r)[0]).join(";");
    const users = Number((await db.execute('SELECT COUNT(*) AS n FROM "User"')).rows[0].n);
    return { integrity, users };
  } finally { db.close(); }
}
(async () => {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === "snapshot") {
    const src = createClient({ url: fileUrl(a) });
    try { await src.execute("VACUUM INTO '" + path.resolve(b).replace(/'/g, "''") + "'"); } finally { src.close(); }
    console.log(JSON.stringify(await check(b)));
  } else if (cmd === "check") {
    console.log(JSON.stringify(await check(a)));
  } else { throw new Error("usage: snapshot <db> <out> | check <db>"); }
})().catch((e) => { console.error(e && e.message ? e.message : String(e)); process.exit(1); });
'@

function Invoke-Helper([string[]]$HelperArgs) {
  $node = (Get-Command node.exe).Source
  $env:LK_APP_DIR = $AppDir
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $out = & $node $Helper @HelperArgs 2>&1 } finally { $ErrorActionPreference = $old }
  if ($LASTEXITCODE -ne 0) { throw "sqlite helper failed: $($out -join ' ')" }
  return ($out | Select-Object -Last 1 | ConvertFrom-Json)
}

function Get-FileSha256([string]$Path) { (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() }

function Invoke-Retention([string]$Dir, [string]$Protect) {
  $pattern = '^lashkirja-(\d{4}-\d{2}-\d{2})(-.+)?\.zip$'
  $items = @(Get-ChildItem -LiteralPath $Dir -Filter 'lashkirja-*.zip' -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match $pattern } |
    ForEach-Object {
      $null = $_.Name -match $pattern
      [pscustomobject]@{ File = $_; Day = [datetime]::ParseExact($Matches[1], 'yyyy-MM-dd', $null) }
    } | Sort-Object Day, @{ Expression = { $_.File.Name } })
  if ($items.Count -eq 0) { return }
  $keepDays = @($items | Select-Object -ExpandProperty Day -Unique | Sort-Object -Descending | Select-Object -First $KeepDays)
  $monthlyCutoff = (Get-Date).Date.AddYears(-$KeepMonthlyYears)
  $monthly = @{}
  foreach ($item in $items) {
    $month = $item.Day.ToString('yyyy-MM')
    if (-not $monthly.ContainsKey($month)) { $monthly[$month] = $item.File.FullName }
  }
  foreach ($item in $items) {
    $path = $item.File.FullName
    if ($path -eq $Protect) { continue }
    if ($keepDays -contains $item.Day) { continue }
    if ($monthly[$item.Day.ToString('yyyy-MM')] -eq $path -and $item.Day -ge $monthlyCutoff) { continue }
    Log "retention: delete $path"
    Remove-Item -LiteralPath $path -Force
  }
}

# ------------------------------------------------------------ restore test
if ($RestoreTest) {
  $latest = Get-ChildItem -LiteralPath $BackupDir -Filter 'lashkirja-*.zip' -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $latest) { Log 'restore test FAILED: no backup zip found'; exit 1 }
  $temp = Join-Path ([System.IO.Path]::GetTempPath()) ("lashkirja-restoretest-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  Log "restore test: $($latest.Name) -> $temp"
  $failed = $false
  try {
    [System.IO.Compression.ZipFile]::ExtractToDirectory($latest.FullName, $temp)
    $manifest = Get-Content -LiteralPath (Join-Path $temp 'MANIFEST.txt') -Encoding UTF8
    $dbLine = $manifest | Where-Object { $_ -like 'db=*' } | Select-Object -First 1
    $restoredDb = Join-Path $temp 'prod.db'
    if (-not $dbLine -or (Get-FileSha256 $restoredDb) -ne $dbLine.Substring(3)) { throw 'database sha256 does not match MANIFEST.txt' }
    $fileLines = @($manifest | Where-Object { $_ -like "file`t*" })
    foreach ($line in $fileLines) {
      $parts = $line.Split("`t")
      $restored = Join-Path $temp $parts[2]
      if (-not (Test-Path -LiteralPath $restored) -or (Get-FileSha256 $restored) -ne $parts[1]) { throw "upload hash mismatch: $($parts[2])" }
    }
    $uploadsLine = $manifest | Where-Object { $_ -like 'uploads=*' } | Select-Object -First 1
    if ($uploadsLine -and [int]$uploadsLine.Substring(8) -ne $fileLines.Count) { throw 'upload count does not match MANIFEST.txt' }
    $result = Invoke-Helper @('check', $restoredDb)
    if ($result.integrity -ne 'ok') { throw "integrity_check: $($result.integrity)" }
    Log ("restore test PASSED: {0} integrity=ok users={1} uploads={2} (hashes verified)" -f $latest.Name, $result.users, $fileLines.Count)
  } catch {
    $failed = $true
    Log "restore test FAILED: $($_.Exception.Message)"
  } finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
  }
  if ($failed) { exit 1 }
  exit 0
}

# ------------------------------------------------------------------ backup
if (-not (Test-Path $DbPath)) { Log "backup FAILED: $DbPath does not exist"; exit 1 }
$stamp = Get-Date
$day = $stamp.ToString('yyyy-MM-dd')
$name = "lashkirja-$day.zip"
if ($Tag -or (Test-Path (Join-Path $BackupDir $name))) {
  $suffix = $stamp.ToString('HHmmss')
  if ($Tag) { $suffix += '-' + ($Tag -replace '[^A-Za-z0-9_-]', '') }
  $name = "lashkirja-$day-$suffix.zip"
}
$zipPath = Join-Path $BackupDir $name
$staging = Join-Path $RunDir ("backup-staging-" + $stamp.ToString('yyyyMMdd-HHmmss'))
Log "backup start -> $zipPath"

$exitCode = 0
try {
  New-Item -ItemType Directory -Force -Path $staging | Out-Null
  $snapshot = Join-Path $staging 'prod.db'
  $result = Invoke-Helper @('snapshot', $DbPath, $snapshot)
  if ($result.integrity -ne 'ok') { throw "snapshot integrity_check: $($result.integrity)" }
  Log "database snapshot ok (VACUUM INTO), users=$($result.users)"

  $uploadsCopy = Join-Path $staging 'uploads'
  New-Item -ItemType Directory -Force -Path $uploadsCopy | Out-Null
  if (Test-Path $UploadsDir) {
    & robocopy.exe $UploadsDir $uploadsCopy /E /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy uploads failed with code $LASTEXITCODE" }
  }

  $files = @(Get-ChildItem -LiteralPath $uploadsCopy -Recurse -File)
  $manifest = New-Object System.Collections.Generic.List[string]
  $manifest.Add("created=$($stamp.ToString('o'))")
  $manifest.Add("db=$(Get-FileSha256 $snapshot)")
  $manifest.Add("users=$($result.users)")
  $manifest.Add("uploads=$($files.Count)")
  foreach ($file in $files) {
    $relative = 'uploads/' + $file.FullName.Substring($uploadsCopy.Length + 1).Replace('\', '/')
    $manifest.Add("file`t$(Get-FileSha256 $file.FullName)`t$relative")
  }
  [System.IO.File]::WriteAllLines((Join-Path $staging 'MANIFEST.txt'), $manifest, (New-Object System.Text.UTF8Encoding($false)))

  $partial = "$zipPath.partial"
  Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
  [System.IO.Compression.ZipFile]::CreateFromDirectory($staging, $partial, [System.IO.Compression.CompressionLevel]::Optimal, $false)
  Move-Item -LiteralPath $partial -Destination $zipPath -Force
  Log ("backup written: {0} ({1:N0} KB, uploads={2})" -f $name, ((Get-Item $zipPath).Length / 1KB), $files.Count)

  Invoke-Retention $BackupDir $zipPath

  if (-not $NoMirror -and $env:OneDrive -and (Test-Path $env:OneDrive)) {
    $mirror = Join-Path $env:OneDrive 'LashKirja-backups'
    New-Item -ItemType Directory -Force -Path $mirror | Out-Null
    Copy-Item -LiteralPath $zipPath -Destination (Join-Path $mirror $name) -Force
    Log "mirrored to $mirror"
    Invoke-Retention $mirror (Join-Path $mirror $name)
  } elseif (-not $NoMirror) {
    Log 'no OneDrive folder; off-machine copy skipped'
  }
} catch {
  Log "backup FAILED: $($_.Exception.Message)"
  $exitCode = 1
} finally {
  Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
}
exit $exitCode
