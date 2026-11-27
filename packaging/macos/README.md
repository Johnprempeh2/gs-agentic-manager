# GSAM for Mac

A small Mac app that installs GS Agentic Manager for someone who is not a developer, keeps it running in the background, and updates it to each new release.

## Build

```sh
cd packaging/macos
GSAM_HUB_URL=https://<Greatstone hub> ./build.sh
```

`GSAM_HUB_URL` is where licence keys are checked; it is built into the app. Without it the app cannot activate a licence. This makes `dist/GSAM.app` and `dist/GSAM-Installer.dmg` (with its `.sha256`). It needs Python 3.11 or newer (`brew install python`): the disk image is laid out by [dmgbuild](https://pypi.org/project/dmgbuild/), installed into `build/venv` at a pinned version with its hashes checked (`assets/dmgbuild-requirements.txt`).

- **One download for every Mac**: `GSAM.app` is an AppleScript applet, which is universal (Apple silicon and Intel); the build stops if that ever changes.
- **The disk image**: a branded window (Greatstone void `#121212`, the wordmark, a lime arrow) with GSAM on the left and an Applications alias on the right, and the GSAM stone as the volume icon. The background is `assets/dmg-background.png` (and `@2x`), drawn by `assets/make-dmg-background.py`; the window is exactly the 1x image's size (`assets/dmg-settings.py` reads it). Finder draws the icon labels black or white depending on the Mac, so each sits on a `#767676` pill that both pass AA on.
- **Signing**: see "Signing" below. Until Greatstone's Developer ID is set up the app is ad hoc signed, so **the first time, right-click GSAM in Applications and choose Open**, then Open again in the dialog. The disk image window says so too.

Every `live-*` release gets `GSAM-Installer.dmg` built by `.github/workflows/release-assets.yml` (with the hub address from the repository variable `GSAM_HUB_URL`) and attached to the GitHub release, so `https://github.com/Johnprempeh2/gs-agentic-manager/releases/latest/download/GSAM-Installer.dmg` is always the newest.

## Signing

`build.sh` signs with whatever it is given:

| Set | Result |
|---|---|
| nothing | Ad hoc signature. The first open needs right-click, Open. |
| `GSAM_SIGN_IDENTITY` (and `GSAM_SIGN_KEYCHAIN`) | `GSAM.app` is signed with that "Developer ID Application" identity under the hardened runtime (`assets/entitlements.plist`: Apple events only, for the Terminal sign-in window), and the disk image is signed too. |
| also `GSAM_NOTARY_KEY`, `GSAM_NOTARY_KEY_ID`, `GSAM_NOTARY_ISSUER` | Apple notarises the disk image (one submission covers the app inside) and the ticket is stapled to it. A double-click then opens GSAM with no warning. |

In CI (`.github/workflows/release-assets.yml`) these come from repository secrets, on tag builds and runs by hand only. Pull requests never sign.

| Secret | What it is |
|---|---|
| `MACOS_CERT_P12` | base64 of a `.p12` holding the Developer ID Application certificate, its private key and Apple's "Developer ID Certification Authority" (G2) intermediate |
| `MACOS_CERT_PASSWORD` | the `.p12` password |
| `MACOS_NOTARY_KEY_P8` | base64 of the App Store Connect API key (`AuthKey_<id>.p8`, role Developer) |
| `MACOS_NOTARY_KEY_ID`, `MACOS_NOTARY_ISSUER_ID` | that key's ID and the team's issuer ID |

Make the `.p12` with the system OpenSSL (`/usr/bin/openssl pkcs12 -export -inkey developer-id.key -in developer_id.pem -certfile DeveloperIDG2CA.pem`): the keychain cannot read the newer encryption Homebrew's OpenSSL 3 writes by default. `scripts/release/macos-signing-keychain.sh` imports it into a throwaway keychain and prints the identity.

The two Mac runner binaries are signed with the same identity (no hardened runtime, not notarised): installs download them with `curl`, which Gatekeeper does not check.

Once the first notarised release is out, redraw the disk image background (`assets/make-dmg-background.py`) without the "right-click, Open" step, and drop it from the website's download page.

## What the app does

The first time the user opens it, the app asks for their licence key (`gsamlk_...`, from the email or the website), then runs these steps with a progress bar. Each step lives in `src/gsam.sh` and is safe to run again.

| Step | What it does |
|---|---|
| `xcode` | Asks macOS to install the Apple command line tools if they are missing (git, compilers). |
| `node` | Downloads Node.js 24 from nodejs.org, checks its SHA-256, and keeps it in `~/Library/Application Support/GSAM/runtime`. |
| `activate` | Checks the licence key with the hub (`src/mac-setup.mjs`, no dependencies). A wrong, used or expired key asks again. Writes `~/GSAM-data/instances/default/fleet/` (the install's key, the hub's pinned key, the operator log-in until it is made) and the first signed entitlement document. |
| `code` | Clones this repository into `~/GSAM` and checks out the newest `live-*` release tag, never unreleased work on `main`. |
| `runner` | Downloads the prebuilt native runner for that release (`paperclip-runnerd`, attached to every live release by `.github/workflows/release-assets.yml`), checks it against the release's `SHA256SUMS`, and keeps it in `runtime/runner/<tag>`; the service hands it to GSAM as `GSAM_RUNNER_BINARY`. Only when there is none (a test build) does it fall back to `rust`: a minimal Rust toolchain with rustup in the same folder, so the first start builds the runner from source. |
| `deps` | `pnpm install --frozen-lockfile`. |
| `tools` | Installs the Claude Code and Codex command line apps, which agents use to sign in with the user's own subscription. |
| `config` | Log-ins on: authenticated mode, this Mac only (loopback), sign-up closed (invites still work). Backups every hour, kept 30 days. An existing config keeps every other value and is saved as `config.json.before-licence`. |
| `service` | Adds two LaunchAgents: one runs GSAM (`pnpm dev:once`, data in `~/GSAM-data`) at login and restarts it if it stops; one checks for a new release at 03:30. |
| `wait` | Waits for `/api/health`. The first start compiles the runner, so it can take several minutes. |
| `tailscale` | Optional remote help. Only when the hub sent a Tailscale auth key at activation; otherwise it is skipped quietly. Builds `tailscale` and `tailscaled` from source at a pinned release with Go from go.dev (pinned SHA-256), runs `tailscaled` in userspace networking mode as the user from a third LaunchAgent (`<label>.tailscale`; no system extension, no sudo), joins Greatstone's tailnet as `tag:gsam-customer`, serves GSAM on tailnet port 3100, and records its tailnet name. If it fails, setup carries on. |

Then the owner makes their own log-in in the GSAM window: GSAM keeps a one-time set-up link (a bootstrap invite) in `fleet/owner-invite.json` and the `owner` step opens it. When the owner exists, GSAM makes Greatstone's operator log-in (instance admin) and sets backups to 30 days. Last, the app offers sign-in to Claude (`claude`, then `/login`) and to ChatGPT (`codex login`) in Terminal, with the bundled Node.js on the PATH.

Every later open checks for a new release (and offers to install it), makes sure GSAM is running, and opens it in its own window (Chrome app mode if Chrome is installed, else the default browser).

While it runs, GSAM checks in with the hub every 5 minutes. The answer carries the newest signed entitlement document, which applies at once when it is signed by the pinned hub key, and any signed orders from Greatstone: pause, resume, stop (agents stop, GSAM shows "Service stopped by Greatstone", data is kept and can be exported) and update now (starts the updater LaunchAgent at once). When the paid period ends, GSAM shows "Your GSAM subscription has ended" with a renew link. See `doc/CLIENT-INSTANCES.md`, "GSAM for Mac: licence keys" and "admin controls, orders and remote access".

Logs: `~/Library/Application Support/GSAM/setup.log` (setup and updates) and `~/GSAM-data/gsam.log` (the server).

## An install from before licences

An install made before licences runs without log-ins. On the next open after the app is updated it says so, asks for a licence key and runs: `code`, `deps`, `wait`, `activate`, `config`, `service`, `wait`. `config` first asks the running GSAM for a database backup and changes nothing if that fails. The database, files and settings stay where they are. The owner then makes their log-in from the set-up link; because the old local board is the only admin, accepting it hands the install to them exactly as the board claim does: instance admin, owner of every organisation, and the AI accounts connected before.

## Updates

The app follows `live-*` tags. Publishing a new live release reaches every Mac install that night, or the next time the Mac wakes. Migrations run on the next start, as usual.

## Remove

```sh
launchctl bootout gui/$(id -u)/co.greatstone.gsam
launchctl bootout gui/$(id -u)/co.greatstone.gsam.update
launchctl bootout gui/$(id -u)/co.greatstone.gsam.tailscale   # only there when remote help was set up
rm ~/Library/LaunchAgents/co.greatstone.gsam*.plist
rm -rf ~/GSAM "$HOME/Library/Application Support/GSAM" /Applications/GSAM.app
```

`~/GSAM-data` holds the user's data. Delete it only if they want everything gone.

## Testing without touching a real install

Every path, the port and the service name can be overridden, so a full run can sit beside a real install:

```sh
export GSAM_APP_HOME=/tmp/t/app GSAM_CODE_DIR=/tmp/t/GSAM GSAM_DATA_DIR=/tmp/t/data GSAM_PORT=3479 GSAM_LABEL=co.greatstone.gsam.test
export GSAM_DB_PORT=54379                      # the database port written into a new config
export GSAM_HUB_URL=http://127.0.0.1:3491      # a sandbox hub (http only on loopback)
export GSAM_CODE_SOURCE=$PWD/../.. GSAM_CODE_REF=<branch>   # a local checkout and branch instead of the live tag
export GSAM_NO_WINDOW=1                        # do not open the GSAM window
export GSAM_FLEET_CHECK_IN_SECONDS=20          # check in every 20 seconds instead of 5 minutes (written into the test LaunchAgent)
GSAM_LICENCE_KEY=<key from the sandbox hub> bash src/gsam.sh activate
for s in xcode node code runner deps tools config service wait owner; do bash src/gsam.sh $s || break; done
```

The set-up link is then in `$GSAM_DATA_DIR/instances/default/fleet/owner-invite.json`.

`GSAM_TAILSCALE_DRY_RUN=1 bash src/gsam.sh tailscale` prints the commands the `tailscale` step would run (download, build, LaunchAgent, `tailscale up` with the key as a file path, `tailscale serve`) without running them. It still skips when the hub sent no key.

Remove the test LaunchAgents afterwards with the commands above, using the test label.
