# Installs the permanent Dzbanek music bridge as a Windows logon task.
# Run once (from repo root):
#   powershell -ExecutionPolicy Bypass -File scripts\install-music-bridge.ps1

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Node = (Get-Command node -ErrorAction Stop).Source
$Bridge = Join-Path $Root 'scripts\music-bridge.mjs'
$TaskName = 'DzbanekMusicBridge'

if (-not (Test-Path $Bridge)) {
  throw "Bridge script not found: $Bridge"
}

# Ensure secret is fixed on Railway (idempotent)
$env:MUSIC_WORKER_SECRET = 'dzbanek-home-free-2026'
try {
  Push-Location $Root
  & railway variable set "MUSIC_WORKER_SECRET=dzbanek-home-free-2026" --service bot 2>$null
} catch {
  Write-Host "Note: could not set Railway secret now (ok if offline). Bridge will set URL when it starts."
} finally {
  Pop-Location
}

$action = New-ScheduledTaskAction `
  -Execute $Node `
  -Argument "`"$Bridge`"" `
  -WorkingDirectory $Root

$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Force | Out-Null

Write-Host ""
Write-Host "Installed scheduled task: $TaskName"
Write-Host "  Runs at logon: node scripts/music-bridge.mjs"
Write-Host "  Working dir:   $Root"
Write-Host ""
Write-Host "Starting bridge now…"
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 2
Write-Host "Done. Keep this PC powered on for YouTube music."
Write-Host "Check status:  Get-ScheduledTask -TaskName $TaskName"
Write-Host "Stop:          Stop-ScheduledTask -TaskName $TaskName"
Write-Host "Uninstall:     Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
Write-Host ""
