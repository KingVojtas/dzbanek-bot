# Installs permanent Dzbanek music bridge + watchdog so music survives reboots.
# No admin required (user Startup + user Scheduled Task).
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-music-bridge.ps1

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Node = (Get-Command node -ErrorAction Stop).Source
$ErrorActionPreference = 'Continue'
$Bridge = Join-Path $Root 'scripts\music-bridge.mjs'
$Watchdog = Join-Path $Root 'scripts\music-bridge-watchdog.ps1'
$StartupDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$CmdPath = Join-Path $StartupDir 'DzbanekMusicBridge.cmd'
$VbsPath = Join-Path $StartupDir 'DzbanekMusicBridge.vbs'
$TaskName = 'DzbanekMusicBridgeWatchdog'
$TaskLogon = 'DzbanekMusicBridgeWatchdogOnLogon'

if (-not (Test-Path $Bridge)) {
  throw "Bridge script not found: $Bridge"
}
if (-not (Test-Path $Watchdog)) {
  throw "Watchdog script not found: $Watchdog"
}

# Startup folder (at logon) - hidden via VBS
$cmdLines = @(
  '@echo off'
  "cd /d `"$Root`""
  'set MUSIC_WORKER_SECRET=dzbanek-home-free-2026'
  'set MUSIC_WORKER_PORT=8790'
  "`"$Node`" `"$Bridge`""
)
Set-Content -Path $CmdPath -Value $cmdLines -Encoding ASCII

$vbsLines = @(
  'Set WshShell = CreateObject("WScript.Shell")'
  "WshShell.CurrentDirectory = `"$Root`""
  "WshShell.Run chr(34) & `"$CmdPath`" & chr(34), 0, False"
)
Set-Content -Path $VbsPath -Value $vbsLines -Encoding ASCII

Write-Host "Installed Startup entry:"
Write-Host "  $VbsPath"

# Scheduled Task: every 3 minutes + at logon (watchdog restarts bridge if dead)
$ps = (Get-Command powershell -ErrorAction Stop).Source
$watchTr = "`"$ps`" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Watchdog`""

schtasks /Delete /TN $TaskName /F 2>$null | Out-Null
schtasks /Delete /TN $TaskLogon /F 2>$null | Out-Null

$r1 = schtasks /Create /TN $TaskName /TR $watchTr /SC MINUTE /MO 3 /F /RL LIMITED 2>&1
Write-Host "Minute task: $r1"
$r2 = schtasks /Create /TN $TaskLogon /TR $watchTr /SC ONLOGON /F /RL LIMITED 2>&1
Write-Host "Logon task: $r2"

try {
  Push-Location $Root
  railway variable set "MUSIC_WORKER_SECRET=dzbanek-home-free-2026" --service bot 2>$null | Out-Null
} catch {
  Write-Host "Note: Railway secret will be set when the bridge starts."
} finally {
  Pop-Location
}

Write-Host ""
Write-Host "Starting bridge now..."
$env:MUSIC_WORKER_SECRET = 'dzbanek-home-free-2026'
$env:MUSIC_WORKER_PORT = '8790'
Start-Process -FilePath $Node -ArgumentList "`"$Bridge`"" -WorkingDirectory $Root -WindowStyle Hidden
Start-Sleep -Seconds 3
& $ps -NoProfile -ExecutionPolicy Bypass -File $Watchdog
Start-Sleep -Seconds 10

$healthy = $false
try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:8790/health" -UseBasicParsing -TimeoutSec 5
  if ($r.StatusCode -eq 200) { $healthy = $true }
} catch {}

if ($healthy) {
  Write-Host "OK: local music worker is healthy."
} else {
  Write-Host "WARN: worker not healthy yet - wait 30s or check data\music-bridge-watchdog.log"
}

Write-Host ""
Write-Host "IMPORTANT: keep this PC on and logged in (no hibernation) for YouTube music."
Write-Host "Watchdog checks every 3 minutes and restarts the bridge if it dies."
Write-Host "Uninstall:"
Write-Host "  - Delete DzbanekMusicBridge.* from Startup folder"
Write-Host "  - schtasks /Delete /TN $TaskName /F"
Write-Host "  - schtasks /Delete /TN $TaskLogon /F"
Write-Host ""
