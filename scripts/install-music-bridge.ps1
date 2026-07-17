# Installs the permanent Dzbanek music bridge so it starts at Windows logon.
# No admin required (uses the user Startup folder).
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-music-bridge.ps1

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Node = (Get-Command node -ErrorAction Stop).Source
$Bridge = Join-Path $Root 'scripts\music-bridge.mjs'
$StartupDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$CmdPath = Join-Path $StartupDir 'DzbanekMusicBridge.cmd'
$VbsPath = Join-Path $StartupDir 'DzbanekMusicBridge.vbs'

if (-not (Test-Path $Bridge)) {
  throw "Bridge script not found: $Bridge"
}

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
Write-Host "  (runs at logon, hidden)"

try {
  Push-Location $Root
  railway variable set "MUSIC_WORKER_SECRET=dzbanek-home-free-2026" --service bot 2>$null | Out-Null
} catch {
  Write-Host "Note: Railway secret will be set when the bridge starts."
} finally {
  Pop-Location
}

Write-Host ""
Write-Host "Starting bridge now in background..."
$env:MUSIC_WORKER_SECRET = 'dzbanek-home-free-2026'
$env:MUSIC_WORKER_PORT = '8790'
Start-Process -FilePath $Node -ArgumentList "`"$Bridge`"" -WorkingDirectory $Root -WindowStyle Hidden
Start-Sleep -Seconds 5
Write-Host "Done. Keep this PC powered on for YouTube music."
Write-Host "Uninstall: remove DzbanekMusicBridge files from your Startup folder."
Write-Host ""
