# GSAM for Mac

A small Mac app that installs GS Agentic Manager for someone who is not a developer, keeps it running in the background, and updates it to each new release.

## Build

```sh
cd packaging/macos
./build.sh
```

This makes `dist/GSAM.app` and `dist/GSAM-Installer.dmg`. Hand out the `.dmg`. It is signed ad hoc, not notarised, so the first open is right-click, then Open.

## What the app does

The first time the user opens it, the app asks to set up, then runs these steps with a progress bar. Each step lives in `src/gsam.sh` and is safe to run again.

| Step | What it does |
|---|---|
| `xcode` | Asks macOS to install the Apple command line tools if they are missing (git, compilers). |
| `node` | Downloads Node.js 24 from nodejs.org, checks its SHA-256, and keeps it in `~/Library/Application Support/GSAM/runtime`. |
| `rust` | Installs a minimal Rust toolchain with rustup into the same folder. Nothing goes on the system PATH. |
| `code` | Clones this repository into `~/GSAM` and checks out the newest `live-*` release tag, never unreleased work on `main`. |
| `deps` | `pnpm install --frozen-lockfile`. |
| `tools` | Installs the Claude Code and Codex command line apps, which agents use to sign in with the user's own subscription. |
| `service` | Adds two LaunchAgents: one runs GSAM (`pnpm dev:once`, data in `~/GSAM-data`) at login and restarts it if it stops; one checks for a new release at 03:30. |
| `wait` | Waits for `/api/health`. The first start compiles the runner, so it can take several minutes. |

Every later open checks for a new release (and offers to install it), makes sure GSAM is running, and opens it in its own window (Chrome app mode if Chrome is installed, else the default browser).

Logs: `~/Library/Application Support/GSAM/setup.log` (setup and updates) and `~/GSAM-data/gsam.log` (the server).

## Updates

The app follows `live-*` tags. Publishing a new live release reaches every Mac install that night, or the next time the Mac wakes. Migrations run on the next start, as usual.

## Remove

```sh
launchctl bootout gui/$(id -u)/co.greatstone.gsam
launchctl bootout gui/$(id -u)/co.greatstone.gsam.update
rm ~/Library/LaunchAgents/co.greatstone.gsam*.plist
rm -rf ~/GSAM "$HOME/Library/Application Support/GSAM" /Applications/GSAM.app
```

`~/GSAM-data` holds the user's data. Delete it only if they want everything gone.

## Testing without touching a real install

Every path, the port and the service name can be overridden, so a full run can sit beside a real install:

```sh
export GSAM_APP_HOME=/tmp/t/app GSAM_CODE_DIR=/tmp/t/GSAM GSAM_DATA_DIR=/tmp/t/data GSAM_PORT=3479 GSAM_LABEL=co.greatstone.gsam.test
for s in xcode node rust code deps tools service wait; do bash src/gsam.sh $s || break; done
```

Remove the test LaunchAgents afterwards with the commands above, using the test label.
