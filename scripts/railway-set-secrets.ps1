# Load secrets from local .env into Railway (does not print secret values).
# Usage:  powershell -File scripts/railway-set-secrets.ps1
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

foreach ($k in @('DISCORD_TOKEN', 'DISCORD_CLIENT_SECRET')) {
  if (-not $vars[$k]) { throw "Missing $k in .env" }
}

$session = $vars['SESSION_SECRET']
if (-not $session -or $session -eq 'change-me-to-long-random') {
  $session = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 48 | ForEach-Object { [char]$_ })
}

# Domain is filled after `railway domain`; placeholders updated on second run if needed.
$publicBase = $vars['PUBLIC_BASE_URL']
if (-not $publicBase) {
  $publicBase = 'https://PLACEHOLDER.up.railway.app'
}

$pairs = @(
  "DISCORD_TOKEN=$($vars['DISCORD_TOKEN'])",
  "DISCORD_CLIENT_SECRET=$($vars['DISCORD_CLIENT_SECRET'])",
  "SESSION_SECRET=$session",
  "API_ENABLED=true",
  "API_HOST=0.0.0.0",
  "NODE_ENV=production",
  "WEBSITE_ORIGIN=https://kingvojtas.github.io,https://dzbanek-bot.vojtas.io,http://127.0.0.1:3848,http://localhost:3848",
  "WEBSITE_PRIMARY_ORIGIN=https://kingvojtas.github.io/dzbanek-bot-website",
  "PUBLIC_BASE_URL=$publicBase",
  "OAUTH_REDIRECT_URI=$publicBase/api/auth/callback"
)

if ($vars['SPOTIFY_CLIENT_ID']) {
  $pairs += "SPOTIFY_CLIENT_ID=$($vars['SPOTIFY_CLIENT_ID'])"
}
if ($vars['SPOTIFY_CLIENT_SECRET']) {
  $pairs += "SPOTIFY_CLIENT_SECRET=$($vars['SPOTIFY_CLIENT_SECRET'])"
}

Write-Host "Setting Railway variables (values hidden)..."
& npx --yes @railway/cli variable set @pairs --skip-deploys
if ($LASTEXITCODE -ne 0) { throw "railway variable set failed" }
Write-Host "Done."
