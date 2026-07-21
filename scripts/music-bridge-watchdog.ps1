# Ensures the home music bridge is running. Safe to run every few minutes.
#   powershell -ExecutionPolicy Bypass -File scripts\music-bridge-watchdog.ps1

$ErrorActionPreference = 'SilentlyContinue'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
$Node = if ($NodeCmd) { $NodeCmd.Source } else { 'C:\Program Files\nodejs\node.exe' }
$Bridge = Join-Path $Root 'scripts\music-bridge.mjs'
$LogDir = Join-Path $Root 'data'
$LogFile = Join-Path $LogDir 'music-bridge-watchdog.log'
$Port = 8790
$Secret = 'dzbanek-home-free-2026'

function Write-Log([string]$msg) {
  try {
    if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg"
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
  } catch {}
}

function Test-WorkerHealth {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec 3
    return $r.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Get-BridgePids {
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -match 'music-bridge\.mjs|music-worker\.mjs' } |
    Select-Object -ExpandProperty ProcessId
}

if (-not (Test-Path $Bridge)) {
  Write-Log "ERROR: bridge not found at $Bridge"
  exit 1
}
if (-not (Test-Path $Node)) {
  Write-Log 'ERROR: node not found'
  exit 1
}

if (Test-WorkerHealth) {
  exit 0
}

Write-Log 'Worker unhealthy - restarting music bridge'

foreach ($procId in (Get-BridgePids)) {
  try {
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    Write-Log "Killed PID $procId"
  } catch {}
}

Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" |
  ForEach-Object {
    try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
  }

Start-Sleep -Seconds 2

$env:MUSIC_WORKER_SECRET = $Secret
$env:MUSIC_WORKER_PORT = "$Port"
Start-Process -FilePath $Node -ArgumentList "`"$Bridge`"" -WorkingDirectory $Root -WindowStyle Hidden
Write-Log 'Started music-bridge.mjs'

$ok = $false
for ($i = 0; $i -lt 15; $i++) {
  Start-Sleep -Seconds 3
  if (Test-WorkerHealth) { $ok = $true; break }
}

if ($ok) {
  Write-Log 'Worker healthy after restart'
  exit 0
}

Write-Log 'WARN: worker still unhealthy after restart'
exit 2
