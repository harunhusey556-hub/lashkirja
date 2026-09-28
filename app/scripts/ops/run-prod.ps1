<#
.SYNOPSIS
  Supervisor for the LashKirja production instance on Windows.

.DESCRIPTION
  Keeps two processes alive:
    web     node next start <app> -p 3300 -H 127.0.0.1
    worker  node tsx scripts/worker.ts
  Both run with the working directory set to the instance root
  (C:\LashKirja by default). The app keeps its data under
  process.cwd()\data, so the database, uploads and account packages live
  in C:\LashKirja\data and never inside the git checkout.

  The production .env (C:\LashKirja\prod\app\.env) is loaded into the
  child environment. Values are never written to a log.

  A crashed child is restarted after 1 s, 5 s, then 30 s (capped). The
  backoff resets once a child has stayed up for two minutes.

  Logs rotate daily: logs\web-YYYY-MM-DD.log, logs\worker-YYYY-MM-DD.log,
  logs\supervisor-YYYY-MM-DD.log. Files older than 30 days are deleted.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File run-prod.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File run-prod.ps1 -Stop
  powershell -NoProfile -ExecutionPolicy Bypass -File run-prod.ps1 -Status

  Normally started by the "LashKirja prod" Scheduled Task (install-tasks.ps1).
  Restart it through the task, not by killing node:
    run-prod.ps1 -Stop; Start-ScheduledTask -TaskName "LashKirja prod"
#>
[CmdletBinding()]
param(
  [switch]$Stop,
  [switch]$Status,
  [string]$Root = 'C:\LashKirja',
  [int]$Port = 3300,
  [int]$LogRetentionDays = 30
)

$ErrorActionPreference = 'Stop'
$AppDir = Join-Path $Root 'prod\app'
$LogDir = Join-Path $Root 'logs'
$RunDir = Join-Path $Root 'run'
$PidFile = Join-Path $RunDir 'supervisor.pid'
$StopFlag = Join-Path $RunDir 'supervisor.stop'
$EnvFile = Join-Path $AppDir '.env'

foreach ($dir in @($LogDir, $RunDir)) {
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
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

function Get-SupervisorProcess {
  if (-not (Test-Path $PidFile)) { return $null }
  $raw = (Get-Content -LiteralPath $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  $supervisorPid = 0
  if (-not [int]::TryParse("$raw".Trim(), [ref]$supervisorPid)) { return $null }
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $supervisorPid" -ErrorAction SilentlyContinue
  if ($proc -and $proc.CommandLine -and $proc.CommandLine -match 'run-prod\.ps1' -and $proc.CommandLine -notmatch '-Stop|-Status') {
    return $proc
  }
  return $null
}

# Only node processes started from the production checkout. The dev
# checkout (C:\Users\...\lashkirja) and every other node process are left alone.
function Get-ProdNodeProcesses {
  $needle = $AppDir.ToLowerInvariant()
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($needle) }
}

function Stop-Tree([int]$ProcessId) {
  & taskkill.exe /T /F /PID $ProcessId 2>&1 | Out-Null
}

function Invoke-Health {
  $envValues = Read-DotEnv $EnvFile
  $headers = @{}
  if ($envValues.Contains('HEALTH_TOKEN') -and $envValues['HEALTH_TOKEN']) {
    $headers['Authorization'] = 'Bearer ' + $envValues['HEALTH_TOKEN']
  }
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/health" -Headers $headers -TimeoutSec 5
    return "HTTP $($response.StatusCode)"
  } catch {
    $status = $_.Exception.Response.StatusCode.value__
    if ($status) { return "HTTP $status" }
    return 'unreachable'
  }
}

if ($Status) {
  $supervisor = Get-SupervisorProcess
  if ($supervisor) { "supervisor: running (pid $($supervisor.ProcessId))" } else { 'supervisor: not running' }
  foreach ($proc in Get-ProdNodeProcesses) {
    $kind = if ($proc.CommandLine -match 'worker\.ts') { 'worker' } else { 'web' }
    "  node $kind pid $($proc.ProcessId)"
  }
  "health: $(Invoke-Health)"
  return
}

if ($Stop) {
  $supervisor = Get-SupervisorProcess
  if ($supervisor) {
    Set-Content -LiteralPath $StopFlag -Value (Get-Date -Format o)
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline -and (Get-Process -Id $supervisor.ProcessId -ErrorAction SilentlyContinue)) {
      Start-Sleep -Milliseconds 500
    }
    if (Get-Process -Id $supervisor.ProcessId -ErrorAction SilentlyContinue) {
      Write-Output "supervisor $($supervisor.ProcessId) did not exit in 30 s; killing its process tree"
      Stop-Tree $supervisor.ProcessId
    }
    Write-Output "supervisor $($supervisor.ProcessId) stopped"
  } else {
    Write-Output 'supervisor not running'
  }
  # Orphans (for example after the supervisor itself was killed).
  foreach ($proc in Get-ProdNodeProcesses) {
    Write-Output "stopping leftover production node pid $($proc.ProcessId)"
    Stop-Tree $proc.ProcessId
  }
  Remove-Item -LiteralPath $PidFile, $StopFlag -Force -ErrorAction SilentlyContinue
  return
}

# ---------------------------------------------------------------- supervise

$existing = Get-SupervisorProcess
if ($existing -and $existing.ProcessId -ne $PID) {
  Write-Output "supervisor already running (pid $($existing.ProcessId))"
  return
}

if (-not ('LkLogPump' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Text;

public class LkLogPump {
  private readonly object _lock = new object();
  private readonly string _dir;
  private readonly string _prefix;
  private string _day;
  private StreamWriter _writer;

  public LkLogPump(string dir, string prefix) { _dir = dir; _prefix = prefix; }

  public void Write(string line) {
    if (line == null) return;
    lock (_lock) {
      DateTime now = DateTime.Now;
      string day = now.ToString("yyyy-MM-dd");
      if (_writer == null || day != _day) {
        if (_writer != null) _writer.Dispose();
        _day = day;
        FileStream stream = new FileStream(Path.Combine(_dir, _prefix + "-" + day + ".log"),
          FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete);
        _writer = new StreamWriter(stream, new UTF8Encoding(false));
        _writer.AutoFlush = true;
      }
      _writer.WriteLine(now.ToString("yyyy-MM-ddTHH:mm:ss.fff") + " " + line);
    }
  }

  public void Attach(Process process) {
    process.OutputDataReceived += (sender, e) => Write(e.Data);
    process.ErrorDataReceived += (sender, e) => { if (e.Data != null) Write("[stderr] " + e.Data); };
  }

  public void Close() {
    lock (_lock) { if (_writer != null) { _writer.Dispose(); _writer = null; } }
  }
}
'@
}

$supervisorLog = New-Object LkLogPump($LogDir, 'supervisor')
function Log([string]$Message) { $supervisorLog.Write($Message) }

Set-Content -LiteralPath $PidFile -Value $PID
Remove-Item -LiteralPath $StopFlag -Force -ErrorAction SilentlyContinue
Log "supervisor start pid=$PID root=$Root port=$Port"

$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { Log 'node.exe not found on PATH; exiting'; Remove-Item $PidFile -Force; exit 1 }
if (-not (Test-Path $EnvFile)) { Log "missing $EnvFile; exiting"; Remove-Item $PidFile -Force; exit 1 }
if (-not (Test-Path (Join-Path $AppDir '.next\BUILD_ID'))) { Log 'no production build (.next\BUILD_ID); run deploy-local.ps1 first; exiting'; Remove-Item $PidFile -Force; exit 1 }

$dotenv = Read-DotEnv $EnvFile
Log ("loaded .env keys: " + (($dotenv.Keys | Sort-Object) -join ','))
New-Item -ItemType Directory -Force -Path (Join-Path $Root 'data\uploads') | Out-Null

$nextBin = Join-Path $AppDir 'node_modules\next\dist\bin\next'
$tsxBin = Join-Path $AppDir 'node_modules\tsx\dist\cli.mjs'
$children = @(
  @{ Name = 'web'; Args = "`"$nextBin`" start `"$AppDir`" -p $Port -H 127.0.0.1" },
  @{ Name = 'worker'; Args = "`"$tsxBin`" --tsconfig `"$(Join-Path $AppDir 'tsconfig.json')`" `"$(Join-Path $AppDir 'scripts\worker.ts')`"" }
)
$backoff = @(1, 5, 30)
foreach ($child in $children) {
  $child.Process = $null
  $child.Failures = 0
  $child.NextStart = Get-Date
  $child.StartedAt = $null
  $child.Pump = New-Object LkLogPump($LogDir, $child.Name)
}

function Start-Child($child) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $node
  $psi.Arguments = $child.Args
  $psi.WorkingDirectory = $Root
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
  foreach ($key in $dotenv.Keys) { $psi.EnvironmentVariables[$key] = [string]$dotenv[$key] }
  $psi.EnvironmentVariables['NODE_ENV'] = 'production'
  $psi.EnvironmentVariables['NEXT_TELEMETRY_DISABLED'] = '1'
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $psi
  $child.Pump.Attach($process)
  [void]$process.Start()
  $process.BeginOutputReadLine()
  $process.BeginErrorReadLine()
  $child.Process = $process
  $child.StartedAt = Get-Date
  Log "$($child.Name) started pid=$($process.Id)"
}

function Stop-Children {
  foreach ($child in $children) {
    if ($child.Process -and -not $child.Process.HasExited) {
      Log "$($child.Name) stopping pid=$($child.Process.Id)"
      Stop-Tree $child.Process.Id
    }
  }
}

$lastPrune = [datetime]::MinValue
try {
  while ($true) {
    if (Test-Path $StopFlag) { Log 'stop requested'; break }

    foreach ($child in $children) {
      $process = $child.Process
      if ($process -and $process.HasExited) {
        $uptime = (Get-Date) - $child.StartedAt
        if ($uptime.TotalSeconds -ge 120) { $child.Failures = 0 }
        $delay = $backoff[[Math]::Min($child.Failures, $backoff.Count - 1)]
        $child.Failures++
        Log ("{0} exited code={1} after {2:N0} s; restart in {3} s" -f $child.Name, $process.ExitCode, $uptime.TotalSeconds, $delay)
        $child.Process = $null
        $child.NextStart = (Get-Date).AddSeconds($delay)
      }
      if (-not $child.Process -and (Get-Date) -ge $child.NextStart) {
        try { Start-Child $child } catch {
          Log "$($child.Name) failed to start: $($_.Exception.Message)"
          $child.NextStart = (Get-Date).AddSeconds(30)
        }
      }
    }

    if (((Get-Date) - $lastPrune).TotalHours -ge 12) {
      $lastPrune = Get-Date
      Get-ChildItem -LiteralPath $LogDir -Filter '*.log' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$LogRetentionDays) } |
        Remove-Item -Force -ErrorAction SilentlyContinue
    }

    Start-Sleep -Seconds 1
  }
} finally {
  Stop-Children
  Log "supervisor exit pid=$PID"
  Remove-Item -LiteralPath $PidFile, $StopFlag -Force -ErrorAction SilentlyContinue
  foreach ($child in $children) { $child.Pump.Close() }
  $supervisorLog.Close()
}
