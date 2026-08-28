# ==========================================================================
# POST-REBOOT GPO CHECK  (Task 2)
# Run this AFTER: reboot -> leave laptop idle & untouched 30 min -> run this.
# It tells you in plain English whether Group Policy reverted the power
# settings and whether the database survived.
# ==========================================================================

Write-Host "`n=== 1. POWER SETTINGS (did GPO revert them?) ===" -ForegroundColor Cyan

function Get-Idx($sub, $setting) {
  $out = powercfg /query SCHEME_CURRENT SUB_SLEEP $setting
  $ac = ($out | Select-String "Current AC").ToString() -replace '.*:\s*',''
  $dc = ($out | Select-String "Current DC").ToString() -replace '.*:\s*',''
  return @([Convert]::ToInt32($ac,16), [Convert]::ToInt32($dc,16))
}

$sb = Get-Idx 'SUB_SLEEP' 'STANDBYIDLE'
$hb = Get-Idx 'SUB_SLEEP' 'HIBERNATEIDLE'
Write-Host ("Standby   AC={0}  DC={1}" -f $sb[0], $sb[1])
Write-Host ("Hibernate AC={0}  DC={1}" -f $hb[0], $hb[1])

$powerOk = ($sb[0] -eq 0 -and $sb[1] -eq 0 -and $hb[0] -eq 0 -and $hb[1] -eq 0)
if ($powerOk) {
  Write-Host "POWER: OK - settings held through reboot + idle. You are safe." -ForegroundColor Green
} else {
  Write-Host "POWER: REVERTED - Group Policy put the laptop back to sleep on idle." -ForegroundColor Red
  Write-Host "       -> Do NOT rely on this machine for the live demo without a mitigation." -ForegroundColor Red
  Write-Host "       -> Options: demo from another machine you control, ask IT for a" -ForegroundColor Yellow
  Write-Host "          power-policy exception, or run a wake-lock during the demo." -ForegroundColor Yellow
}

Write-Host "`n=== 2. DOCKER + DATABASE (did they survive the reboot?) ===" -ForegroundColor Cyan
docker ps --format "  {{.Names}}  {{.Status}}  {{.Ports}}" 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host "DOCKER: engine not responding yet. Open Docker Desktop, wait ~30s, re-run." -ForegroundColor Yellow
} else {
  $rows = docker exec mission-mysql mysql -uroot -pdevpass -N -e "SELECT COUNT(*) FROM mission_demo.missions;" 2>$null
  if ($LASTEXITCODE -eq 0) {
    Write-Host "DATABASE: OK - mission-mysql is up and holds $rows missions." -ForegroundColor Green
  } else {
    Write-Host "DATABASE: container not ready. Give it 20s and re-run, or check Docker Desktop." -ForegroundColor Yellow
  }
}

Write-Host "`n=== SUMMARY ===" -ForegroundColor Cyan
if ($powerOk) { Write-Host "Green light: reboot did not break the power settings." -ForegroundColor Green }
else          { Write-Host "Red light: sort out the power/GPO issue before demo day." -ForegroundColor Red }
Write-Host ""
