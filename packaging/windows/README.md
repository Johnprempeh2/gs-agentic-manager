# GSAM for Windows

An installer that sets up GS Agentic Manager on a Windows 10 or 11 PC for someone who is not a developer, keeps it running in the background, and updates it to each new release. It mirrors the Mac app (`packaging/macos`) step for step. No administrator rights are needed.

## Build

```powershell
$env:GSAM_HUB_URL = "https://<Greatstone hub>"
powershell -File packaging\windows\build.ps1
```

Needs Inno Setup 6. Makes `packaging\windows\dist\GSAM-Setup.exe` and its `.sha256`. `GSAM_HUB_URL` is where licence keys are checked; it is built into the installer.

The installer is **not signed** yet. Windows SmartScreen then shows "Windows protected your PC". Tell customers: choose **More info**, then **Run anyway**. To sign it later (Azure Trusted Signing, or any code-signing certificate), set `GSAM_SIGN_COMMAND` to the signing command with `$f` where the file goes, for example `signtool sign /fd SHA256 /tr http://timestamp.acs.microsoft.com /td SHA256 /dlib Azure.CodeSigning.Dlib.dll /dmdf metadata.json $f`; the installer and its uninstaller are then signed as they are built.

Every `live-*` release gets `GSAM-Setup.exe` built by `.github/workflows/release-assets.yml` (hub address from the repository variable `GSAM_HUB_URL`) and attached to the GitHub release, so `https://github.com/Johnprempeh2/gs-agentic-manager/releases/latest/download/GSAM-Setup.exe` is always the newest.

## What the installer does

The wizard asks for the licence key (`gsamlk_...`), then runs `gsam.ps1 setup`, which shows each step in a window. Every step lives in `src/gsam.ps1` and is safe to run again.

| Step | What it does |
|---|---|
| `node` | Downloads Node.js 24 for Windows from nodejs.org, checks its SHA-256 against `SHASUMS256.txt`, keeps it in `%LOCALAPPDATA%\GSAM\runtime`. |
| `activate` | Checks the licence key with the hub (`packaging/macos/src/mac-setup.mjs`, shared with the Mac). A wrong key asks again. |
| `git` | PortableGit (pinned version and SHA-256), which also brings the `sh` agents' workspace services run through. Turns on long paths. |
| `code` | Clones this repository into `%LOCALAPPDATA%\GSAM\app` and checks out the newest `live-*` release tag. |
| `runner` | Downloads the prebuilt native runner for that release and checks it against the release's `SHA256SUMS`. No Rust or Microsoft build tools. |
| `deps` | `pnpm install --frozen-lockfile`. |
| `tools` | Installs the Claude Code and Codex command line apps. |
| `config` | Log-ins on (authenticated, this PC only, sign-up closed), backups every hour kept 30 days. |
| `service` | Two scheduled tasks for this user only: GSAM at sign-in (kept running), and the updater at 03:30 (or as soon as the PC is on after that). |
| `wait` | Waits for `/api/health` (the first start takes a few minutes). |
| `tailscale` | Optional remote help, only when the hub sent a Tailscale key: builds `tailscaled` from source (Go pinned by SHA-256) and runs it in userspace mode as the user. Not proven on a real PC yet. |
| `owner` | Opens the owner's one-time set-up link in an Edge app window. |

Data lives in `%USERPROFILE%\GSAM-data`, which only the user can read. A data folder anywhere else (`GSAM_DATA_DIR`) gets an owner-only ACL. Logs: `%LOCALAPPDATA%\GSAM\setup.log` and `%USERPROFILE%\GSAM-data\gsam.log`.

Uninstall (Settings, Apps) removes the scheduled tasks and the app; the data folder stays.

## Testing

CI builds a sandbox installer and installs it as a standard Windows user against a sandbox hub: `scripts/windows/installer-smoke.ps1` (job "Windows installer" in `.github/workflows/windows-ci.yml`). The same test overrides as the Mac engine work here (`GSAM_APP_HOME`, `GSAM_CODE_DIR`, `GSAM_DATA_DIR`, `GSAM_PORT`, `GSAM_DB_PORT`, `GSAM_LABEL`, `GSAM_HUB_URL`, `GSAM_CODE_SOURCE`/`GSAM_CODE_REF`, `GSAM_NO_WINDOW`, `GSAM_FLEET_CHECK_IN_SECONDS`), plus `GSAM_RUNNER_BINARY_FILE` (a runner binary to install instead of the release's), `GSAM_SERVICE_DIRECT` (start GSAM directly, since a CI user never signs in) and `GSAM_NONINTERACTIVE`.
