# End to end test of the Windows installer, as a standard user (run it through
# run-as-standard-user.ps1). The same proof the Mac app had in P1, on Windows:
#
#   1. a sandbox hub from this checkout (127.0.0.1:3491, its own data folder)
#      makes a licence key,
#   2. GSAM-Setup.exe installs silently with that key (code from this checkout,
#      the runner binary built in this job, ports 3479 and 54379),
#   3. checks: setup finished, GSAM answers in authenticated mode, both
#      scheduled tasks exist and run without administrator rights, the owner's
#      set-up link was made, and the install checked in with the hub as a
#      Windows install (check-in v4),
#   4. the uninstaller removes the tasks and keeps the data folder.
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [Parameter(Mandatory = $true)][string]$RunnerBinary,
  [Parameter(Mandatory = $true)][string]$CodeRef
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$repo = (Get-Location).Path
$work = Join-Path $env:TEMP "gsam-installer-smoke"
New-Item -ItemType Directory -Force -Path $work | Out-Null
$hubPort = 3491
$hub = "http://127.0.0.1:$hubPort"
$failures = @()
function Check([bool]$Ok, [string]$What) {
  if ($Ok) { Write-Output "[installer-smoke] ok: $What" } else { Write-Output "[installer-smoke] FAIL: $What"; $script:failures += $What }
}
function WaitFor([scriptblock]$Test, [int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) { try { if (& $Test) { return $true } } catch {}; Start-Sleep -Seconds 5 }
  return $false
}
function Health([int]$Port) { Invoke-RestMethod -TimeoutSec 5 "http://127.0.0.1:$Port/api/health" }

# 1. The sandbox hub, with a throwaway signing key made here.
$seed = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($seed)
$env:GSAM_ENTITLEMENT_SIGN_PRIVATE_KEY = [Convert]::ToBase64String($seed).TrimEnd('=').Replace('+', '-').Replace('/', '_')
$env:GSAM_FLEET_HUB = "true"
$env:PORT = "$hubPort"
$env:GSAM_TELEMETRY_DISABLED = "1"
$hubData = Join-Path $work "hub-data"
$hubProc = Start-Process -FilePath "cmd.exe" -PassThru -WindowStyle Hidden `
  -ArgumentList "/d /s /c "" pnpm dev:once --data-dir ""$hubData"" > ""$work\hub.log"" 2>&1 """
$hubUp = WaitFor { (Health $hubPort).status } 900
Check $hubUp "the sandbox hub started"
foreach ($k in "GSAM_ENTITLEMENT_SIGN_PRIVATE_KEY", "GSAM_FLEET_HUB", "PORT") { Remove-Item "Env:$k" }

try {
  if (-not $hubUp) { throw "no hub" }
  $body = @{ features = @{}; validUntil = (Get-Date).ToUniversalTime().AddDays(30).ToString("yyyy-MM-ddTHH:mm:ssZ") } | ConvertTo-Json
  $licence = Invoke-RestMethod -Method Post -ContentType "application/json" -Body $body -Headers @{ Origin = $hub } "$hub/api/fleet/licences"
  Check ($licence.licenceKey -like "gsamlk_*") "the hub made a licence key"

  # 2. The installer, silent, as this standard user. Test overrides keep it off the real ports and the network code.
  $env:GSAM_LICENCE_KEY = $licence.licenceKey
  $env:GSAM_PORT = "3479"; $env:GSAM_DB_PORT = "54379"
  $env:GSAM_CODE_SOURCE = $repo; $env:GSAM_CODE_REF = $CodeRef
  $env:GSAM_RUNNER_BINARY_FILE = $RunnerBinary
  $env:GSAM_NO_WINDOW = "1"; $env:GSAM_NONINTERACTIVE = "1"; $env:GSAM_SERVICE_DIRECT = "1"
  $env:GSAM_FLEET_CHECK_IN_SECONDS = "20"
  $setup = Start-Process -FilePath $Installer -PassThru -ArgumentList "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /LOG=""$work\install.log"""
  $null = $setup.Handle
  $finished = $setup.WaitForExit(60 * 60 * 1000)
  Remove-Item Env:GSAM_LICENCE_KEY
  Check $finished "the installer finished within an hour"

  # 3. What the install left.
  $appHome = Join-Path $env:LOCALAPPDATA "GSAM"
  $result = (Get-Content (Join-Path $appHome "setup-result.txt") -Raw -ErrorAction SilentlyContinue)
  Check ("$result".Trim() -eq "ok") "setup finished every step (setup-result: $("$result".Trim()))"
  $health = $null
  $up = WaitFor { $script:health = Health 3479; $true } 300
  Check ($up -and $health.deploymentMode -eq "authenticated") "GSAM answers on 3479 in authenticated mode ($($health.deploymentMode))"
  foreach ($t in "co.greatstone.gsam", "co.greatstone.gsam.update") {
    $task = Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
    Check ($task -and $task.Principal.RunLevel -eq "Limited") "scheduled task $t exists and runs without administrator rights"
  }
  $update = Get-ScheduledTask -TaskName "co.greatstone.gsam.update" -ErrorAction SilentlyContinue
  Check ($update -and ($update.Triggers | Where-Object { $_.StartBoundary -like "*T03:30:00*" })) "the updater runs at 03:30"
  $inst = Join-Path $env:USERPROFILE "GSAM-data\instances\default"
  Check (Test-Path (Join-Path $inst "fleet\owner-invite.json")) "the owner's set-up link was made"
  $status = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $appHome "gsam.ps1") status
  Check ("$status".Trim() -eq "setup") "status says licensed, waiting for the owner ($status)"
  $seen = WaitFor {
    $row = (Invoke-RestMethod "$hub/api/fleet/instances" -Headers @{ Origin = $hub }) | Where-Object { $_.id -eq $licence.instance.id }
    $row.latestCheckIn.checkIn.platform.os -eq "windows"
  } 240
  Check $seen "the install checked in with the hub as a Windows install (check-in v4)"

  # 4. Uninstall: the tasks go, the data stays.
  $uninstaller = Get-ChildItem $appHome -Filter "unins*.exe" | Select-Object -First 1
  if ($uninstaller) {
    $u = Start-Process -FilePath $uninstaller.FullName -PassThru -ArgumentList "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART"
    $null = $u.Handle; $null = $u.WaitForExit(10 * 60 * 1000)
  }
  Check (-not (Get-ScheduledTask -TaskName "co.greatstone.gsam" -ErrorAction SilentlyContinue)) "the uninstaller removed the scheduled tasks"
  Check (Test-Path (Join-Path $inst "fleet\spoke.json")) "the uninstaller kept the data folder"
  Check (-not (WaitFor { (Health 3479).status } 15)) "GSAM stopped with the uninstall"
} catch {
  Check $false "unexpected error: $($_.Exception.Message)"
} finally {
  & taskkill.exe /PID $hubProc.Id /T /F 2>&1 | Out-Null
  foreach ($f in "$work\install.log", "$env:LOCALAPPDATA\GSAM\setup.log", "$env:USERPROFILE\GSAM-data\gsam.log", "$work\hub.log") {
    if ($failures.Count -gt 0 -and (Test-Path $f)) {
      Write-Output "---- ${f}: error lines"
      Select-String -Path $f -Pattern 'ERR_|ERROR|Error:|error |Failed|EPERM|EBUSY|ENOENT|UNKNOWN|unknown error' | Select-Object -Last 60 | ForEach-Object { $_.Line }
      Write-Output "---- $f (last 60 lines)"; Get-Content $f -Tail 60
    }
  }
}
if ($failures.Count -gt 0) { Write-Output "[installer-smoke] $($failures.Count) check(s) failed"; exit 1 }
Write-Output "[installer-smoke] PASS"
