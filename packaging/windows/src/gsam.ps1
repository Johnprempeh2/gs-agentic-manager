# GSAM for Windows: the engine behind the installer, step for step the same as
# packaging/macos/src/gsam.sh. Each step is safe to run again. No administrator
# rights: everything lives in the user's own folders and runs as the user.
#   gsam.ps1 setup | status | node | git | activate | code | runner | deps | tools | config | service
#            | wait | tailscale | owner | owner-done | open | newer | update | log | run | stop | uninstall
#
# A step's answer for the installer is printed on stdout; everything else goes
# to the setup log. A message for the person is in $AppHome\last-error.txt when
# a step fails (exit code 1).
param([Parameter(Position = 0)][string]$Step = "", [Parameter(Position = 1)][string]$Arg = "")
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # Invoke-WebRequest is many times slower with the progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$NodeVersion = "24.22.3"
# PortableGit: git plus the sh that agents' workspace services run through (MinGit has no sh).
$GitVersion = "2.56.1"
$GitUrl = "https://github.com/git-for-windows/git/releases/download/v2.56.1.windows.1/PortableGit-2.56.1-64-bit.7z.exe"
$GitSha256 = "9dd04a608ceb5f6ab32a73709e0ecb159d211da71b697c45ff81f6dd0c6b49c7"
# Remote help (the tailscale step): tailscaled built from source at a pinned release, as on the Mac.
$TsVersion = "1.106.0"
$GoVersion = "1.27.4"
$GoSha256 = "178ab98950ac69ab25069307dc6ade79f3816e414cce95b4da166a115cde1e7e"   # go1.27.4.windows-amd64.zip
$TsTag = "tag:gsam-customer"
$TsRemotePort = 3100
$Repo = "https://github.com/Johnprempeh2/gs-agentic-manager.git"

$AppHome = if ($env:GSAM_APP_HOME) { $env:GSAM_APP_HOME } else { Join-Path $env:LOCALAPPDATA "GSAM" }
$Runtime = Join-Path $AppHome "runtime"
# Short paths: pnpm's node_modules nest deeply.
$Code = if ($env:GSAM_CODE_DIR) { $env:GSAM_CODE_DIR } else { Join-Path $AppHome "app" }
$Data = if ($env:GSAM_DATA_DIR) { $env:GSAM_DATA_DIR } else { Join-Path $env:USERPROFILE "GSAM-data" }
$Port = if ($env:GSAM_PORT) { $env:GSAM_PORT } else { "3100" }
$Label = if ($env:GSAM_LABEL) { $env:GSAM_LABEL } else { "co.greatstone.gsam" }
$DbPort = if ($env:GSAM_DB_PORT) { $env:GSAM_DB_PORT } else { "54329" }
$Inst = Join-Path $Data "instances\default"
$Here = $PSScriptRoot
$HubUrl = if ($env:GSAM_HUB_URL) { $env:GSAM_HUB_URL } elseif (Test-Path (Join-Path $Here "hub-url")) { (Get-Content (Join-Path $Here "hub-url") -Raw).Trim() } else { "" }
# Tests only: clone from a local checkout and check out a ref instead of the newest live-* tag,
# and install a runner binary from a file instead of the release.
$CodeSource = $env:GSAM_CODE_SOURCE
$CodeRef = $env:GSAM_CODE_REF
$Log = Join-Path $AppHome "setup.log"
$ErrorFile = Join-Path $AppHome "last-error.txt"
$NodeDir = Join-Path $Runtime "node"
$GitDir = Join-Path $Runtime "git"
$TsDir = Join-Path $Runtime "tailscale"
$env:Path = "$NodeDir;$GitDir\cmd;$GitDir\usr\bin;$env:SystemRoot\System32;$env:SystemRoot;$env:SystemRoot\System32\WindowsPowerShell\v1.0"
$env:COREPACK_ENABLE_DOWNLOAD_PROMPT = "0"
New-Item -ItemType Directory -Force -Path $AppHome, $Runtime, $Data | Out-Null

function Say([string]$Text) { Add-Content -Path $Log -Value $Text }
Say "=== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Step $Arg"

# A message the person sees in the installer's error box.
function Fail([string]$Message) {
  Say $Message
  Set-Content -Path $ErrorFile -Value $Message
  exit 1
}

# Runs a program with its output in the setup log; fails the step when it fails.
function Run([string]$File, [string[]]$Arguments, [string]$Message = "") {
  $quoted = ($Arguments | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join " "
  Say "> $File $quoted"
  $p = Start-Process -FilePath $File -ArgumentList $quoted -NoNewWindow -Wait -PassThru `
    -RedirectStandardOutput "$Log.out" -RedirectStandardError "$Log.err"
  foreach ($f in "$Log.out", "$Log.err") { if (Test-Path $f) { Get-Content $f | Add-Content -Path $Log; Remove-Item $f } }
  if ($p.ExitCode -ne 0) { if ($Message) { Fail $Message } else { Fail "A setup step failed ($File, exit $($p.ExitCode)). Send $Log to Greatstone." } }
}

# Output of a program (for values such as a tag, or a message for the person), with its
# errors in the log. Windows PowerShell turns a program's stderr into errors, so not "Stop" here.
function Capture([string]$File, [string[]]$Arguments, [switch]$EvenOnFailure) {
  $ErrorActionPreference = "Continue"
  $out = & $File @Arguments 2>> $Log
  $script:CaptureExit = $LASTEXITCODE
  if ($LASTEXITCODE -ne 0 -and -not $EvenOnFailure) { return $null }
  return (($out | ForEach-Object { "$_" }) -join "`n").Trim()
}

function Healthy {
  try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://127.0.0.1:$Port/api/health").StatusCode -eq 200 } catch { $false }
}

function Download([string]$Url, [string]$File, [string]$Sha256) {
  Say "download $Url"
  Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $File
  if ($Sha256) {
    $actual = (Get-FileHash -Algorithm SHA256 $File).Hash.ToLower()
    if ($actual -ne $Sha256.ToLower()) { Remove-Item $File -Force; Fail "A download did not match its checksum ($Url). Nothing was installed. Try again later." }
  }
}

function LatestRelease {
  $refs = Capture "git" @("ls-remote", "--tags", "--refs", $Repo, "live-*")
  if (-not $refs) { return $null }
  $tags = $refs -split "`n" | ForEach-Object { ($_ -split "refs/tags/")[1] } | Where-Object { $_ -match '^live-\d{4}-\d{2}-\d{2}\.\d+$' }
  # live-YYYY-MM-DD.N: sort by date, then by the number.
  return $tags | Sort-Object { $p = $_ -split '[-.]'; "{0}{1}{2}{3:D6}" -f $p[1], $p[2], $p[3], [int]$p[4] } | Select-Object -Last 1
}
function CurrentRelease { $f = Join-Path $AppHome "version"; if (Test-Path $f) { (Get-Content $f -Raw).Trim() } else { "none" } }
function CheckoutRelease([string]$Tag) {
  Run "git" @("-C", $Code, "fetch", "--depth", "1", "origin", "tag", $Tag)
  Run "git" @("-C", $Code, "checkout", "-q", "--force", $Tag)
  Set-Content -Path (Join-Path $AppHome "version") -Value $Tag
}

# The data folder holds credentials (fleet keys, the operator log-in, AI log-ins). Under the
# user's profile it is private to the user already; anywhere else it gets an owner-only ACL.
function LockDataFolder {
  $userHome = [IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\') + '\'
  $dataPath = [IO.Path]::GetFullPath($Data).TrimEnd('\') + '\'
  if ($dataPath.StartsWith($userHome, [StringComparison]::OrdinalIgnoreCase)) { return }
  Say "data folder outside the user profile: owner-only ACL on $Data"
  Run "icacls.exe" @($Data, "/inheritance:r", "/grant:r", "${env:USERNAME}:(OI)(CI)F", "*S-1-5-18:(OI)(CI)F", "/Q") "GSAM could not make its data folder private ($Data). Choose a folder inside your user folder."
}

function ServiceEnvFile { Join-Path $AppHome "service.json" }

# Starts GSAM's log-on task. Tests: a task with an interactive log-on runs only for a
# signed-in user, and a CI user never signs in, so the test starts what the task runs.
function StartGsam {
  Start-ScheduledTask -TaskName $Label -ErrorAction SilentlyContinue
  if ($env:GSAM_SERVICE_DIRECT) {
    $ps = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    Start-Process -FilePath $ps -WindowStyle Hidden -ArgumentList "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$(Join-Path $AppHome 'gsam.ps1')`" run"
  }
}

switch ($Step) {
  "status" {
    # new: nothing installed. setup: licensed, owner not made yet. installed: ready.
    $task = Get-ScheduledTask -TaskName $Label -ErrorAction SilentlyContinue
    if (-not ((Test-Path (Join-Path $Code "node_modules")) -and $task -and (Test-Path (Join-Path $NodeDir "node.exe")))) { "new" }
    elseif (-not (Test-Path (Join-Path $Inst "fleet\spoke.json"))) { "unlicensed" }
    elseif (Test-Path (Join-Path $Inst "fleet\operator.json")) { "setup" }
    else { "installed" }
  }

  "node" {
    $exe = Join-Path $NodeDir "node.exe"
    if (-not (Test-Path $exe) -or (Capture $exe @("-v")) -ne "v$NodeVersion") {
      $file = "node-v$NodeVersion-win-x64.zip"
      $tmp = Join-Path $Runtime "download"
      New-Item -ItemType Directory -Force -Path $tmp | Out-Null
      Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt" -OutFile (Join-Path $tmp "sums")
      $line = Get-Content (Join-Path $tmp "sums") | Where-Object { $_ -match "\s$([regex]::Escape($file))$" } | Select-Object -First 1
      if (-not $line) { Fail "Node.js $NodeVersion has no Windows download listed. Try again later." }
      Download "https://nodejs.org/dist/v$NodeVersion/$file" (Join-Path $tmp $file) ($line -split '\s+')[0]
      if (Test-Path $NodeDir) { Remove-Item -Recurse -Force $NodeDir }
      Run (Join-Path $env:SystemRoot "System32\tar.exe") @("-xf", (Join-Path $tmp $file), "-C", $tmp)
      Move-Item (Join-Path $tmp "node-v$NodeVersion-win-x64") $NodeDir
      Remove-Item -Recurse -Force $tmp
    }
    Run (Join-Path $NodeDir "corepack.cmd") @("enable")
  }

  "git" {
    if ((Capture (Join-Path $GitDir "cmd\git.exe") @("--version")) -notmatch [regex]::Escape($GitVersion)) {
      $file = Join-Path $Runtime "PortableGit.7z.exe"
      Download $GitUrl $file $GitSha256
      if (Test-Path $GitDir) { Remove-Item -Recurse -Force $GitDir }
      # A self-extracting archive: -o is where, -y answers yes.
      Run $file @("-o$GitDir", "-y") "Git could not be unpacked. Try again later."
      Remove-Item -Force $file
    }
    # pnpm's node_modules go deeper than Windows' old 260-character path limit.
    Run (Join-Path $GitDir "cmd\git.exe") @("config", "--global", "core.longpaths", "true")
  }

  "activate" {
    # Licence key (GSAM_LICENCE_KEY) -> fleet registration, signed entitlement document, operator log-in.
    if (-not $HubUrl) { Fail "This copy of GSAM does not know where Greatstone's service is. Ask Greatstone for a new download." }
    New-Item -ItemType Directory -Force -Path $Inst | Out-Null
    LockDataFolder
    $env:GSAM_RELEASE_TAG = CurrentRelease
    $out = Capture (Join-Path $NodeDir "node.exe") @((Join-Path $Here "mac-setup.mjs"), "activate", $Inst, $HubUrl) -EvenOnFailure
    if ($CaptureExit -ne 0) { Fail $out }
    Say $out
  }

  "code" {
    if ($CodeSource) {
      # Tests: a local checkout and ref, never the live release. The checkout belongs to
      # another Windows account, which git refuses unless told otherwise (this run only).
      $env:GIT_CONFIG_COUNT = "1"; $env:GIT_CONFIG_KEY_0 = "safe.directory"; $env:GIT_CONFIG_VALUE_0 = "*"
      if (-not (Test-Path (Join-Path $Code ".git"))) { Run "git" @("clone", "-q", "--no-checkout", $CodeSource, $Code) }
      Run "git" @("-C", $Code, "fetch", "-q", "--depth", "1", "origin", $(if ($CodeRef) { $CodeRef } else { "HEAD" }))
      Run "git" @("-C", $Code, "checkout", "-q", "--force", "FETCH_HEAD")
      Set-Content -Path (Join-Path $AppHome "version") -Value "test-$(if ($CodeRef) { $CodeRef.Substring(0, [Math]::Min(12, $CodeRef.Length)) } else { 'HEAD' })"
    } else {
      # Always the newest released version (live-* tag), never unreleased work on main.
      if (-not (Test-Path (Join-Path $Code ".git"))) { Run "git" @("clone", "-q", "--depth", "1", $Repo, $Code) }
      $latest = LatestRelease
      if (-not $latest) { Fail "Could not find a GSAM release to install. Check the internet connection and try again." }
      CheckoutRelease $latest
    }
  }

  "runner" {
    # The prebuilt native runner for this release, checked against the release's SHA256SUMS.
    # Windows has no fallback: building it needs Microsoft's build tools.
    $tag = CurrentRelease
    $dest = Join-Path $Runtime "runner\$tag"
    if ($env:GSAM_RUNNER_BINARY_FILE) {
      New-Item -ItemType Directory -Force -Path $dest | Out-Null
      Copy-Item $env:GSAM_RUNNER_BINARY_FILE (Join-Path $dest "paperclip-runnerd.exe") -Force
    } else {
      Run (Join-Path $NodeDir "node.exe") @((Join-Path $Code "scripts\fetch-runner-binary.mjs"), "--tag", $tag, "--dest", $dest) `
        "GSAM's runner for $tag could not be downloaded. Check the internet connection and try again."
    }
    Get-ChildItem (Join-Path $Runtime "runner") -Directory | Where-Object { $_.Name -ne $tag } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  }

  "deps" {
    # Once more on failure: antivirus scanning thousands of new files can lock one for a moment,
    # and a second install only fills in what the first missed.
    Push-Location $Code
    try {
      $pnpm = Join-Path $NodeDir "corepack.cmd"
      $first = Start-Process -FilePath $pnpm -ArgumentList "pnpm install --frozen-lockfile" -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput "$Log.out" -RedirectStandardError "$Log.err"
      foreach ($f in "$Log.out", "$Log.err") { if (Test-Path $f) { Get-Content $f | Add-Content -Path $Log; Remove-Item $f } }
      if ($first.ExitCode -ne 0) {
        Say "deps: pnpm install failed ($($first.ExitCode)); once more"
        Run $pnpm @("pnpm", "install", "--frozen-lockfile") "GSAM's components could not be installed. Check the internet connection and try again."
      }
    }
    finally { Pop-Location }
  }

  "tools" {
    # The Claude and ChatGPT command line apps; GSAM's agents sign in through them.
    if ($env:GSAM_SKIP_TOOLS) { Say "tools: skipped (test run)"; break }
    if (-not (Test-Path (Join-Path $NodeDir "claude.cmd"))) { Run (Join-Path $NodeDir "npm.cmd") @("install", "-g", "@anthropic-ai/claude-code") }
    if (-not (Test-Path (Join-Path $NodeDir "codex.cmd"))) { Run (Join-Path $NodeDir "npm.cmd") @("install", "-g", "@openai/codex") }
  }

  "config" {
    # Log-ins on (authenticated, this PC only, sign-up closed), hourly backups kept 30 days.
    LockDataFolder
    $cfg = Join-Path $Inst "config.json"
    if (((Test-Path (Join-Path $Inst "db")) -or (Test-Path $cfg)) -and -not (Select-String -Path $cfg -Pattern '"deploymentMode": "authenticated"' -Quiet -ErrorAction SilentlyContinue)) {
      if (-not (Healthy)) { Fail "GSAM is not running, so it cannot make a backup before switching to log-ins. Nothing was changed. Open GSAM again to retry." }
      try {
        Invoke-WebRequest -UseBasicParsing -Method Post -TimeoutSec 600 -ContentType "application/json" -Body "{}" `
          -Headers @{ Origin = "http://127.0.0.1:$Port" } "http://127.0.0.1:$Port/api/instance/database-backups" | Out-Null
      } catch { Fail "GSAM could not make a backup before switching to log-ins, so nothing was changed. Try again, or send the log to Greatstone." }
    }
    $out = Capture (Join-Path $NodeDir "node.exe") @((Join-Path $Here "mac-setup.mjs"), "config", $Inst, $DbPort) -EvenOnFailure
    if ($CaptureExit -ne 0) { Fail $out }
    Say $out
  }

  "service" {
    # Two scheduled tasks for this user only (no administrator rights): GSAM at log-on, kept
    # running by the run step, and the updater at 03:30 (or as soon as the PC is on after that).
    $engine = Join-Path $AppHome "gsam.ps1"
    foreach ($f in "gsam.ps1", "mac-setup.mjs", "hub-url") {
      $src = Join-Path $Here $f
      if ((Test-Path $src) -and ([IO.Path]::GetFullPath($src) -ne [IO.Path]::GetFullPath((Join-Path $AppHome $f)))) { Copy-Item $src (Join-Path $AppHome $f) -Force }
    }
    # What the run step sets for GSAM (the test overrides too, so a test install stays a test install).
    $svc = @{ GSAM_PORT = $Port; GSAM_DATA_DIR = $Data; GSAM_CODE_DIR = $Code; GSAM_APP_HOME = $AppHome; GSAM_LABEL = $Label }
    foreach ($k in "GSAM_FLEET_CHECK_IN_SECONDS", "GSAM_CODE_SOURCE", "GSAM_CODE_REF", "GSAM_HUB_URL", "GSAM_RUNNER_BINARY_FILE", "GSAM_SERVICE_DIRECT", "GSAM_NO_WINDOW") {
      $v = [Environment]::GetEnvironmentVariable($k); if ($v) { $svc[$k] = $v }
    }
    $svc | ConvertTo-Json | Set-Content -Path (ServiceEnvFile)
    $ps = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    $taskArgs = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$engine`""
    $me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
      -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
    $runTask = New-ScheduledTask -Action (New-ScheduledTaskAction -Execute $ps -Argument "$taskArgs run") `
      -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $me) -Principal $principal -Settings $settings
    $updateTask = New-ScheduledTask -Action (New-ScheduledTaskAction -Execute $ps -Argument "$taskArgs update") `
      -Trigger (New-ScheduledTaskTrigger -Daily -At "03:30") -Principal $principal -Settings $settings
    & $engine stop | Out-Null
    try {
      Register-ScheduledTask -TaskName $Label -InputObject $runTask -Force | Out-Null
      Register-ScheduledTask -TaskName "$Label.update" -InputObject $updateTask -Force | Out-Null
    } catch { Fail "GSAM could not set itself to run in the background ($($_.Exception.Message))." }
    StartGsam
  }

  "run" {
    # What the log-on task runs: GSAM, started again 30 seconds after it stops (as launchd's KeepAlive).
    $svc = Get-Content (ServiceEnvFile) -Raw | ConvertFrom-Json
    foreach ($p in $svc.PSObject.Properties) { [Environment]::SetEnvironmentVariable($p.Name, [string]$p.Value) }
    $env:PORT = $Port
    $env:GSAM_TELEMETRY_DISABLED = "1"
    $env:GSAM_SCHEDULED_TASK = $Label   # update now: the server runs the <label>.update task
    Set-Content -Path (Join-Path $AppHome "run.pid") -Value $PID
    while ($true) {
      $runner = Join-Path $Runtime "runner\$(CurrentRelease)\paperclip-runnerd.exe"
      if (Test-Path $runner) { $env:GSAM_RUNNER_BINARY = $runner } else { Remove-Item Env:GSAM_RUNNER_BINARY -ErrorAction SilentlyContinue }
      Push-Location $Code
      # /s and the outer quotes: cmd.exe then keeps the inner quotes as they are.
      & cmd.exe /d /s /c "`"`"$NodeDir\corepack.cmd`" pnpm dev:once --data-dir `"$Data`" >> `"$Data\gsam.log`" 2>&1`""
      Pop-Location
      if (Test-Path (Join-Path $AppHome "stopping")) { break }
      Start-Sleep -Seconds 30
    }
  }

  "stop" {
    # Stops GSAM and everything it started (Task Scheduler's own stop leaves the node tree).
    New-Item -ItemType File -Force -Path (Join-Path $AppHome "stopping") | Out-Null
    Stop-ScheduledTask -TaskName $Label -ErrorAction SilentlyContinue
    $pidFile = Join-Path $AppHome "run.pid"
    if (Test-Path $pidFile) {
      & taskkill.exe /PID ((Get-Content $pidFile -Raw).Trim()) /T /F 2>&1 | Out-Null
      Remove-Item $pidFile -Force
    }
    # Anything of this install still running (pnpm dev:once for this data folder, its PostgreSQL).
    Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($Data) } |
      ForEach-Object { & taskkill.exe /PID $_.ProcessId /T /F 2>&1 | Out-Null }
    Remove-Item (Join-Path $AppHome "stopping") -Force -ErrorAction SilentlyContinue
  }

  "wait" {
    # The first start builds GSAM's TypeScript, so allow up to 10 minutes.
    if (-not (Healthy) -and -not (Test-Path (Join-Path $AppHome "run.pid"))) { StartGsam }
    for ($i = 0; $i -lt 120; $i++) { if (Healthy) { exit 0 }; Start-Sleep -Seconds 5 }
    Fail "GSAM did not answer on port $Port. Send $Data\gsam.log to Greatstone."
  }

  "tailscale" {
    # Optional remote help: joins Greatstone's tailnet as $TsTag and serves GSAM to it.
    # tailscaled runs as this user in userspace networking mode: no driver, no administrator.
    $keyFile = Join-Path $Inst "fleet\tailscale.json"
    $tsTask = "$Label.tailscale"
    if (-not (Test-Path $keyFile) -and -not (Get-ScheduledTask -TaskName $tsTask -ErrorAction SilentlyContinue)) {
      Say "tailscale: the hub sent no auth key, skipped"; "skipped"; break
    }
    $dry = [bool]$env:GSAM_TAILSCALE_DRY_RUN
    $bin = Join-Path $TsDir "bin"
    $sock = "\\.\pipe\$Label.tailscaled"
    if (((Get-Content (Join-Path $TsDir "version") -ErrorAction SilentlyContinue) -join "") -ne $TsVersion) {
      $zip = Join-Path $Runtime "go.zip"
      if ($dry) { "would download https://go.dev/dl/go$GoVersion.windows-amd64.zip (SHA-256 $GoSha256) and build tailscale $TsVersion into $bin" }
      else {
        Download "https://go.dev/dl/go$GoVersion.windows-amd64.zip" $zip $GoSha256
        Expand-Archive -Path $zip -DestinationPath $Runtime -Force
        $env:GOTOOLCHAIN = "local"; $env:GOPATH = Join-Path $Runtime "gopath"; $env:GOCACHE = Join-Path $Runtime "gocache"; $env:GOBIN = $bin
        Run (Join-Path $Runtime "go\bin\go.exe") @("install", "-modcacherw", "tailscale.com/cmd/tailscale@v$TsVersion", "tailscale.com/cmd/tailscaled@v$TsVersion") `
          "GSAM could not set up remote help. Everything else works."
        Remove-Item -Recurse -Force $zip, (Join-Path $Runtime "go"), $env:GOPATH, $env:GOCACHE -ErrorAction SilentlyContinue
        Set-Content -Path (Join-Path $TsDir "version") -Value $TsVersion
      }
    }
    $state = Join-Path $TsDir "state"
    $daemonArgs = "--tun=userspace-networking --statedir=`"$state`" --socket=$sock --port=0"
    if ($dry) { "would register task $tsTask at log-on: $bin\tailscaled.exe $daemonArgs" }
    else {
      New-Item -ItemType Directory -Force -Path $state | Out-Null
      $me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
      $task = New-ScheduledTask -Action (New-ScheduledTaskAction -Execute (Join-Path $bin "tailscaled.exe") -Argument $daemonArgs) `
        -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $me) -Principal (New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited) `
        -Settings (New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1))
      Register-ScheduledTask -TaskName $tsTask -InputObject $task -Force | Out-Null
      Start-ScheduledTask -TaskName $tsTask
      Start-Sleep -Seconds 5
    }
    $code = (Get-Content (Join-Path $Inst "fleet\spoke.json") -Raw | ConvertFrom-Json).code
    $ts = Join-Path $bin "tailscale.exe"
    if (Test-Path $keyFile) {
      # The key goes to tailscale as a file path (never on a command line other users can see), then is deleted.
      $authFile = Join-Path $TsDir "authkey"
      if ($dry) { "would run: tailscale --socket=$sock up --auth-key=file:$authFile --hostname=gsam-$code --advertise-tags=$TsTag --accept-dns=false" }
      else {
        Set-Content -Path $authFile -Value (Get-Content $keyFile -Raw | ConvertFrom-Json).authKey -NoNewline
        try { Run $ts @("--socket=$sock", "up", "--auth-key=file:$authFile", "--hostname=gsam-$code", "--advertise-tags=$TsTag", "--accept-dns=false") "GSAM could not join Greatstone's network for remote help. Everything else works." }
        finally { Remove-Item $authFile -Force -ErrorAction SilentlyContinue }
        Remove-Item $keyFile -Force
      }
    }
    if ($dry) { "would run: tailscale --socket=$sock serve --bg --tcp=$TsRemotePort tcp://127.0.0.1:$Port"; break }
    Run $ts @("--socket=$sock", "serve", "--bg", "--tcp=$TsRemotePort", "tcp://127.0.0.1:$Port")
    $name = ((Capture $ts @("--socket=$sock", "status", "--json")) | ConvertFrom-Json).Self.DNSName.TrimEnd('.')
    if (-not $name) { Fail "GSAM joined Greatstone's network but has no name there yet. Open GSAM again to retry." }
    @{ name = $name } | ConvertTo-Json -Compress | Set-Content -Path (Join-Path $Inst "fleet\tailnet.json")
    # Log-ins over the tailnet arrive with that name, so GSAM must allow it.
    if ((Capture (Join-Path $NodeDir "node.exe") @((Join-Path $Here "mac-setup.mjs"), "allow-host", $Inst, $name)) -eq "changed") {
      & $PSCommandPath stop | Out-Null; StartGsam
    }
    "joined"
  }

  "owner" {
    # The owner's one-time set-up link, made by the server once it is licensed. Opens it in the GSAM window.
    for ($i = 0; $i -lt 60; $i++) {
      if (-not (Test-Path (Join-Path $Inst "fleet\operator.json"))) { "done"; exit 0 }
      if (Test-Path (Join-Path $Inst "fleet\owner-invite.json")) { break }
      Start-Sleep -Seconds 2
    }
    $invite = Join-Path $Inst "fleet\owner-invite.json"
    if (-not (Test-Path $invite)) { Fail "GSAM did not make the set-up link. Open GSAM again to retry." }
    & $PSCommandPath open ((Get-Content $invite -Raw | ConvertFrom-Json).url)
    "opened"
  }

  "owner-done" {
    for ($i = 0; $i -lt 15; $i++) { if (-not (Test-Path (Join-Path $Inst "fleet\operator.json"))) { "yes"; exit 0 }; Start-Sleep -Seconds 2 }
    "no"
  }

  "open" {
    $url = if ($Arg) { $Arg } else { "http://localhost:$Port" }
    if ($env:GSAM_NO_WINDOW) { Say "open: no window (test run)"; break }
    # Edge in app mode (every Windows 10 and 11 PC has it), in its own profile; else the default browser.
    try { Start-Process "msedge" -ArgumentList "--app=$url", "--user-data-dir=`"$(Join-Path $AppHome 'window')`"" }
    catch { Start-Process $url }
  }

  "newer" {
    $latest = LatestRelease
    if ($latest -and $latest -ne (CurrentRelease)) { $latest }
  }

  "update" {
    # Nightly at 03:30, or at once when Greatstone sends an "update now" order (the server runs this task).
    if ($CodeSource) {
      $before = Capture "git" @("-C", $Code, "rev-parse", "HEAD")
      & $PSCommandPath code
      if ((Capture "git" @("-C", $Code, "rev-parse", "HEAD")) -eq $before) { Say "update: already on the newest test commit"; exit 0 }
    } else {
      $latest = LatestRelease
      if (-not $latest -or $latest -eq (CurrentRelease)) { Say "update: already on $latest"; exit 0 }
      & $PSCommandPath stop
      CheckoutRelease $latest
    }
    & $PSCommandPath stop
    & $PSCommandPath deps; if ($LASTEXITCODE -ne 0) { exit 1 }
    & $PSCommandPath runner; if ($LASTEXITCODE -ne 0) { exit 1 }
    StartGsam
  }

  "setup" {
    # The whole first install, as the Mac app's progress bar: each step in turn, in the console
    # window the installer opens. A wrong licence key asks again (never in a silent install).
    $steps = @(
      @("node", "Installing Node.js"),
      @("activate", "Checking your licence key"),
      @("git", "Installing Git"),
      @("code", "Downloading GSAM"),
      @("runner", "Downloading GSAM's runner"),
      @("deps", "Installing GSAM's components (about 5 minutes)"),
      @("tools", "Installing the Claude and ChatGPT sign-in apps"),
      @("config", "Turning on log-ins and hourly backups"),
      @("service", "Setting GSAM to run in the background"),
      @("wait", "Starting GSAM for the first time (up to 10 minutes)"),
      @("tailscale", "Setting up remote help from Greatstone"),
      @("owner", "Opening GSAM so you can make your log-in"))
    $interactive = [Environment]::UserInteractive -and -not $env:GSAM_NONINTERACTIVE
    $setupResult = Join-Path $AppHome "setup-result.txt"
    Set-Content -Path $setupResult -Value "running"
    for ($i = 0; $i -lt $steps.Count; $i++) {
      $name = $steps[$i][0]
      if ($name -eq "activate" -and (Test-Path (Join-Path $Inst "fleet\spoke.json"))) { continue }
      Write-Host ("[{0}/{1}] {2}" -f ($i + 1), $steps.Count, $steps[$i][1])
      while ($true) {
        Remove-Item $ErrorFile -ErrorAction SilentlyContinue
        & $PSCommandPath $name | Out-Null
        if ($LASTEXITCODE -eq 0) { break }
        $why = if (Test-Path $ErrorFile) { (Get-Content $ErrorFile -Raw).Trim() } else { "Step $name failed." }
        Write-Host "  $why" -ForegroundColor Yellow
        # Remote help is optional: everything else works without it.
        if ($name -eq "tailscale") { break }
        if ($name -eq "activate" -and $interactive) {
          $env:GSAM_LICENCE_KEY = (Read-Host "  Licence key (starts with gsamlk_)").Trim()
          continue
        }
        Set-Content -Path $setupResult -Value "failed: $name"
        if ($interactive) { Write-Host "The setup log is $Log."; Read-Host "Press Enter to close" | Out-Null }
        exit 1
      }
    }
    Remove-Item Env:GSAM_LICENCE_KEY -ErrorAction SilentlyContinue
    Set-Content -Path $setupResult -Value "ok"
    Write-Host "GSAM is ready. It starts when you sign in to Windows, and updates itself at night."
  }

  "uninstall" {
    # Removes GSAM's background tasks. The data folder ($Data) stays: it is the customer's.
    & $PSCommandPath stop | Out-Null
    foreach ($t in $Label, "$Label.update", "$Label.tailscale") {
      Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction SilentlyContinue
    }
  }

  "log" { Start-Process notepad.exe (Join-Path $Data "gsam.log") }

  default { Fail "unknown step: $Step" }
}
exit 0
