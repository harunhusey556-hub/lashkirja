<#
.SYNOPSIS
  Helpers shared by the LashKirja ops scripts. Dot-sourced, never run on its own.

.DESCRIPTION
  Read-DotEnv and Notify live here so the Telegram token is read from one place at run time (the
  hermes .env) and is never copied into another script or a Scheduled Task definition.

  Notify reports through the calling script's own Log function, so a script must define Log before
  it calls Notify. A script whose real job must not depend on alerting (backup-local.ps1,
  run-cron.ps1) loads this file inside a try and falls back to a Notify that only logs.

  ASCII only on purpose: Windows PowerShell 5.1 reads a .ps1 without a BOM as Windows-1252, and
  non-ASCII characters in this file would break its string terminators.
#>

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

# One Telegram line to the owner. Never throws: an alert that cannot be sent is logged, not fatal.
function Notify([string]$Text) {
  try {
    $hermes = Read-DotEnv (Join-Path $env:LOCALAPPDATA 'hermes\.env')
    $token = $hermes['TELEGRAM_BOT_TOKEN']
    $chat = $hermes['TELEGRAM_HOME_CHANNEL']
    # The text goes into the log too: without a token it is the only trace of what would have been sent.
    if (-not $token -or -not $chat) { Log ('notify skipped (no telegram token/chat configured): ' + $Text); return }
    # Exception text from a failed job can be long; Telegram refuses more than 4096 characters.
    if ($Text.Length -gt 1000) { $Text = $Text.Substring(0, 1000) }
    $body = @{ chat_id = $chat; text = $Text } | ConvertTo-Json -Compress
    Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot$token/sendMessage" `
      -ContentType 'application/json; charset=utf-8' -Body $body -TimeoutSec 20 | Out-Null
    Log 'notified owner'
  } catch {
    Log ('notify failed: ' + $_.Exception.Message)
  }
}
