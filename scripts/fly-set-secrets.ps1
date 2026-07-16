# Load secrets from local .env and set them on Fly (does not print secret values).
# Usage:  powershell -File scripts/fly-set-secrets.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$envFile = Join-Path $root '.env'
if (-not (Test-Path $envFile)) {
  throw ".env not found at $envFile"
}

$vars = @{}
Get-Content $envFile | ForEach-Object {
  $line = $_.Trim()
  if (-not $line -or $line.StartsWith('#')) { return }
  $i = $line.IndexOf('=')
  if ($i -lt 1) { return }
  $key = $line.Substring(0, $i).Trim()
  $val = $line.Substring($i + 1).Trim()
  if (($val.StartsWith('"') -and $val.EndsWith('"')) -or ($val.StartsWith("'") -and $val.EndsWith("'"))) {
    $val = $val.Substring(1, $val.Length - 2)
  }
  $vars[$key] = $val
}

$required = @('DISCORD_TOKEN', 'DISCORD_CLIENT_SECRET')
foreach ($k in $required) {
  if (-not $vars[$k]) { throw "Missing $k in .env" }
}

$session = $vars['SESSION_SECRET']
if (-not $session -or $session -eq 'change-me-to-long-random') {
  $session = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 48 | ForEach-Object { [char]$_ })
}

$argsList = @(
  'secrets', 'set',
  "DISCORD_TOKEN=$($vars['DISCORD_TOKEN'])",
  "DISCORD_CLIENT_SECRET=$($vars['DISCORD_CLIENT_SECRET'])",
  "SESSION_SECRET=$session"
)

if ($vars['SPOTIFY_CLIENT_ID']) {
  $argsList += "SPOTIFY_CLIENT_ID=$($vars['SPOTIFY_CLIENT_ID'])"
}
if ($vars['SPOTIFY_CLIENT_SECRET']) {
  $argsList += "SPOTIFY_CLIENT_SECRET=$($vars['SPOTIFY_CLIENT_SECRET'])"
}

Write-Host "Setting Fly secrets (values hidden)..."
& flyctl @argsList
if ($LASTEXITCODE -ne 0) { throw "fly secrets set failed" }
Write-Host "Done. Secrets: DISCORD_TOKEN, DISCORD_CLIENT_SECRET, SESSION_SECRET$(if ($vars['SPOTIFY_CLIENT_ID']) { ', SPOTIFY_*' })"
