# Builds dist\GSAM-Setup.exe with Inno Setup 6.
#   $env:GSAM_HUB_URL = "https://<Greatstone hub>"; powershell -File packaging\windows\build.ps1
# GSAM_HUB_URL is where licence keys are checked; it is built into the installer.
# GSAM_SIGN_COMMAND (optional) signs the installer, for example Azure Trusted
# Signing's signtool line with $f for the file; unset, the installer is unsigned.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
# Unset: it still builds (as the Mac build.sh does), and activation then says the
# installer does not know where Greatstone's service is.
if (-not $env:GSAM_HUB_URL) { Write-Warning "GSAM_HUB_URL is not set; this installer cannot activate a licence until the hub address is built in." }
New-Item -ItemType Directory -Force -Path build | Out-Null
Set-Content -Path build\hub-url -Value "$env:GSAM_HUB_URL" -NoNewline

$iscc = @(
  (Get-Command iscc.exe -ErrorAction SilentlyContinue).Source,
  "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
  "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
  "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $iscc) { throw "Inno Setup 6 is not installed (https://jrsoftware.org/isdl.php)." }

$version = if ($env:GSAM_INSTALLER_VERSION) { $env:GSAM_INSTALLER_VERSION } else { "0.0.0" }
$isccArgs = @("/Qp", "/DAppVersion=$version")
if ($env:GSAM_SIGN_COMMAND) { $isccArgs += @("/DSignTool", "/Sgsamsign=$($env:GSAM_SIGN_COMMAND)") }
& $iscc @isccArgs gsam.iss
if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed ($LASTEXITCODE)." }
$exe = Join-Path $PSScriptRoot "dist\GSAM-Setup.exe"
"{0}  {1}" -f (Get-FileHash -Algorithm SHA256 $exe).Hash.ToLower(), (Split-Path $exe -Leaf) | Set-Content (Join-Path $PSScriptRoot "dist\GSAM-Setup.exe.sha256")
Write-Output $exe
