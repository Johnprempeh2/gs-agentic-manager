# Windows code signing for the release workflow (packaging/windows/README.md, "Signing").
#
#   windows-signing.ps1 [-SelfSigned] [file ...]
#
# Signs each file given, and puts the same command into GSAM_SIGN_COMMAND (through
# GITHUB_ENV) in the form Inno Setup wants, so packaging\windows\build.ps1 signs the
# installer and its uninstaller as they are built.
#
# Default: Azure Artifact Signing. Reads AZURE_SIGNING_ENDPOINT, AZURE_SIGNING_ACCOUNT and
# AZURE_SIGNING_PROFILE; signtool's Azure plug-in logs in from AZURE_TENANT_ID,
# AZURE_CLIENT_ID and AZURE_CLIENT_SECRET in the environment.
# -SelfSigned: a throwaway certificate made on the spot. Pull requests use it to prove
# the plumbing (signtool found, Inno's quoting, the uninstaller); nobody trusts it.
param([switch]$SelfSigned, [Parameter(ValueFromRemainingArguments = $true)][string[]]$Files)
$ErrorActionPreference = "Stop"

# The Azure plug-in needs signtool from Windows SDK 10.0.22621 or newer, x64.
$signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\10.*\x64\signtool.exe" -ErrorAction SilentlyContinue |
  Where-Object { [version]$_.Directory.Parent.Name -ge [version]"10.0.22621.0" } |
  Sort-Object { [version]$_.Directory.Parent.Name } | Select-Object -Last 1 -ExpandProperty FullName
if (-not $signtool) { throw "No signtool.exe from Windows SDK 10.0.22621 or newer on this machine." }

if ($SelfSigned) {
  $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=GSAM pull request test (not Greatstone)" `
    -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddDays(1)
  $signArgs = @("sign", "/fd", "SHA256", "/sha1", $cert.Thumbprint)
} else {
  foreach ($name in "AZURE_SIGNING_ENDPOINT", "AZURE_SIGNING_ACCOUNT", "AZURE_SIGNING_PROFILE", "AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET") {
    if (-not [Environment]::GetEnvironmentVariable($name)) { throw "$name is not set." }
  }
  $tmp = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
  $work = Join-Path $tmp "gsam-signing"
  New-Item -ItemType Directory -Force -Path $work | Out-Null

  # Microsoft's signtool plug-in, pinned by version and hash. To move to a newer one, change both.
  $version = "1.0.151"
  $sha256 = "35375a4bc4e1102da729fc3d8d9925f774c3baae6b8b7ff6398d948ca9ab0d8a"
  $zip = Join-Path $work "client.zip"
  Invoke-WebRequest -UseBasicParsing -OutFile $zip "https://api.nuget.org/v3-flatcontainer/microsoft.artifactsigning.client/$version/microsoft.artifactsigning.client.$version.nupkg"
  if ((Get-FileHash -Algorithm SHA256 $zip).Hash -ne $sha256) { throw "Microsoft.ArtifactSigning.Client $version does not match its pinned hash." }
  Expand-Archive -Force -Path $zip -DestinationPath (Join-Path $work "client")
  $dlib = Join-Path $work "client\bin\x64\Azure.CodeSigning.Dlib.dll"
  if (-not (Test-Path $dlib)) { throw "Azure.CodeSigning.Dlib.dll is not where version $version keeps it." }

  # The plug-in is a .NET 10 program.
  $runtimes = & dotnet --list-runtimes 2>$null
  if (-not ($runtimes | Where-Object { $_ -match '^Microsoft\.NETCore\.App (\d+)\.' -and [int]$Matches[1] -ge 10 })) {
    throw "The signing plug-in needs the .NET 10 runtime (x64), which this machine does not have."
  }

  # Only the environment log-in: the secrets above, never whatever else the machine is logged in as.
  $metadata = Join-Path $work "metadata.json"
  @{
    Endpoint = $env:AZURE_SIGNING_ENDPOINT
    CodeSigningAccountName = $env:AZURE_SIGNING_ACCOUNT
    CertificateProfileName = $env:AZURE_SIGNING_PROFILE
    ExcludeCredentials = @("ManagedIdentityCredential", "WorkloadIdentityCredential", "SharedTokenCacheCredential",
      "VisualStudioCredential", "VisualStudioCodeCredential", "AzureCliCredential", "AzurePowerShellCredential",
      "AzureDeveloperCliCredential", "InteractiveBrowserCredential")
  } | ConvertTo-Json | Set-Content -Encoding ASCII $metadata
  # Azure's certificates last three days, so the timestamp is what keeps a signature valid.
  $signArgs = @("sign", "/fd", "SHA256", "/tr", "http://timestamp.acs.microsoft.com", "/td", "SHA256", "/dlib", $dlib, "/dmdf", $metadata)
}

foreach ($file in $Files) {
  & $signtool @signArgs $file
  if ($LASTEXITCODE -ne 0) { throw "signtool could not sign $file ($LASTEXITCODE)." }
}

# Inno Setup's form: $q is a quotation mark and $f the file, already quoted.
$inno = (@($signtool) + $signArgs | ForEach-Object { if ($_ -match '\s') { '$q' + $_ + '$q' } else { $_ } }) -join " "
$inno += ' $f'
if ($env:GITHUB_ENV) { "GSAM_SIGN_COMMAND=$inno" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append }
Write-Output "Signing with: $inno"
