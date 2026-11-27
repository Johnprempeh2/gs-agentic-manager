# Runs a command as a standard (non-administrator) Windows user, the way a
# customer's GSAM runs, and fails if it fails or leaves a process running.
# CI only: GitHub's Windows runner account is an elevated administrator, and
# embedded PostgreSQL (and Windows file symlinks) behave differently there.
#
#   powershell -File scripts/windows/run-as-standard-user.ps1 -Command "<cmd.exe command line>" [-TimeoutMinutes 40]
#
# The user (gsamsmoke) is made on first use with a random password that never
# leaves this job; it gets the checkout and the tools on PATH. The command runs
# in the checkout with this step's PATH.
param(
  [Parameter(Mandatory = $true)][string]$Command,
  [int]$TimeoutMinutes = 40,
  [string]$Name = "run"
)
$ErrorActionPreference = "Stop"
$user = "gsamsmoke"
$passwordFile = Join-Path $env:RUNNER_TEMP "gsamsmoke.secret"

if (-not (Get-LocalUser -Name $user -ErrorAction SilentlyContinue)) {
  $password = "Gs1!" + [guid]::NewGuid().ToString("N")
  Write-Output "::add-mask::$password"
  $secret = ConvertTo-SecureString $password -AsPlainText -Force
  New-LocalUser -Name $user -Password $secret -PasswordNeverExpires | Out-Null
  Add-LocalGroupMember -Group Users -Member $user -ErrorAction SilentlyContinue
  # Kept for later steps, readable only by the runner account (DPAPI).
  $secret | ConvertFrom-SecureString | Set-Content -Path $passwordFile
  $node = (Get-Command node).Source
  icacls $env:GITHUB_WORKSPACE /grant "${user}:(OI)(CI)M" /T /C /Q | Out-Null
  $dirs = @((Split-Path $node))
  if ($env:PNPM_HOME) { $dirs += (Split-Path (Split-Path $env:PNPM_HOME)) }
  foreach ($dir in $dirs) { icacls $dir /grant "${user}:(OI)(CI)RX" /T /C /Q | Out-Null }
}
$secret = Get-Content -Path $passwordFile | ConvertTo-SecureString
$credential = New-Object System.Management.Automation.PSCredential("$env:COMPUTERNAME\$user", $secret)

# A process started for another user gets that user's environment, so hand it
# this step's PATH (node, pnpm, git) through a wrapper.
$wrapper = Join-Path $env:RUNNER_TEMP "$Name.cmd"
Set-Content -Path $wrapper -Encoding Ascii -Value @("@set ""PATH=$env:PATH""", "@$Command")
icacls $wrapper /grant "${user}:RX" /Q | Out-Null
$out = Join-Path $env:RUNNER_TEMP "$Name.out"
$err = Join-Path $env:RUNNER_TEMP "$Name.err"
# Not -Wait: that also waits for every descendant, so one leftover process
# would hang the step with no output.
$proc = Start-Process -FilePath "cmd.exe" -ArgumentList "/d", "/c", $wrapper `
  -WorkingDirectory $env:GITHUB_WORKSPACE -Credential $credential -LoadUserProfile -NoNewWindow `
  -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
$null = $proc.Handle  # keeps ExitCode readable after the process ends
$finished = $proc.WaitForExit($TimeoutMinutes * 60 * 1000)
Get-Content $out, $err
# Nothing the command started may outlive it.
$left = @(Get-CimInstance Win32_Process | Where-Object {
  try { (Invoke-CimMethod -InputObject $_ -MethodName GetOwner).User -eq $user } catch { $false }
})
if ($left.Count -gt 0) {
  Write-Output "Processes left running by the standard user:"
  $left | ForEach-Object { Write-Output ("  {0} {1} {2}" -f $_.ProcessId, $_.Name, $_.CommandLine) }
  $left | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
if (-not $finished) { Write-Output "$Name did not finish within $TimeoutMinutes minutes"; exit 1 }
if ($proc.ExitCode -ne 0) { exit $proc.ExitCode }
if ($left.Count -gt 0) { exit 1 }
