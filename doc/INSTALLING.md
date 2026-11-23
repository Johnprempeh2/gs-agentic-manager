# Installing GS Agentic Manager

There are two ways to run GS Agentic Manager: the macOS installer from a GitHub
Release of this repo, or a source checkout (see the README).

The npm package, `npx` tryout and managed-install sections further down come
from the upstream project. GS Agentic Manager is not published to npm, so those
commands do not work for it yet.

## Install on a Mac

Releases live at <https://github.com/Johnprempeh2/gs-agentic-manager/releases>.
Each release carries:

- `GSAM-macOS-arm64.pkg`: the installer most people use. Double-click it.
- `gsam-macos-arm64.tar.gz` and its `.sha256`: the same prebuilt bundle, for
  `scripts/install.sh`.

The bundle ships its own Node runtime, built server and runner, so the Mac needs
no Node, pnpm, Xcode command line tools or Rust. Setup sets GSAM to start on
login, puts a GSAM shortcut on the desktop and opens the first-run screen.

From Terminal instead of the package:

```sh
curl -fsSLO https://raw.githubusercontent.com/Johnprempeh2/gs-agentic-manager/main/scripts/install.sh
bash install.sh                    # latest release
bash install.sh --version <tag>    # one release
bash install.sh --file ~/Downloads/gsam-macos-arm64.tar.gz
```

`install.sh` checks the bundle's SHA-256 before it runs the bundle's `setup.sh`.
Apple silicon only for now.

## Uninstall on a Mac

In Terminal:

```sh
bash "$HOME/Library/Application Support/GSAM/uninstall.sh"
```

It stops GSAM, removes the login item, the desktop shortcut and the app files.
It asks before it deletes your data and backups.

## Agent runtime notes

Codex ACP workspace sessions enable networking so agents can report task outcomes.
To disable it explicitly, set `extraArgs` to
`["-c", "sandbox_workspace_write.network_access=false"]`, or set
`env.GSAM_CODEX_ACP_NETWORK_ACCESS="false"`. Execution-target network denial
also remains enforced. Read-only ACP mode remains read-only.

## Node runtime used by background services

Check the Node executable used by the running service, not only `node --version`
in an interactive shell. Systemd and launchd do not load shell version-manager
configuration. A newer Node installed elsewhere does not upgrade a running
service or change a custom startup script's `PATH`.

Managed installs pin the validated Node executable in the `gsam` shim
and prepend its directory to `PATH` for child tools, including ACP servers with
an `/usr/bin/env node` shebang. Re-run the installer using the supported
Node runtime after changing runtime installations, then restart the service.
For example, put the supported Node's bin directory first on `PATH` and run
`npx gsam@latest install --yes`. Do not use the old managed shim to
re-pin Node: it intentionally continues launching its previously pinned runtime.
Installs and updates refresh existing managed shims in place. Updates reject an
unsupported running Node before installing or activating a payload; read-only
update checks and rollback remain available for recovery. Global npm installs and
source checkout services must configure their own executable and child-process `PATH`.

For custom service wrappers, use an absolute, supported Node executable and put
that executable's directory first on `PATH`. Keep required existing PATH entries.
On Linux, verify the running executable with `/proc/<server-pid>/exe`; an
interactive shell version check alone is insufficient. Use the guarded restart
procedure in [DEVELOPING.md](DEVELOPING.md#hot-restart-deploys) when jobs are active.

Legacy local adapters default to ACP, including configurations with no `engine`
field or the old `auto` value. An unavailable ACP runtime fails the run and the
agent environment test with a setup error; it never silently changes engines.
Repair the reported prerequisite or explicitly select `engine: cli`. Local
filesystem/network confinement and in-place Codex workspaces require explicit
CLI selection. CLI sandbox defaults and explicit restrictions are described in
the adapter configuration documentation.

## Managed Install Layout

Managed code is separate from instance data:

```text
~/.gsam/cli/
├── install.json
├── current -> installs/npm/2026.720.0
└── installs/
    ├── npm/<version>/
    └── git/<sha12>/

~/.local/bin/paperclipai
```

The `gsam` shim remains stable while `current` switches atomically
between complete payloads. GS Agentic Manager keeps the two previous managed payloads
for rollback. Configuration, databases, uploads, logs, secrets, and workspaces
remain under `~/.gsam/instances/` and are not stored inside CLI payloads.

If `~/.local/bin` is not on `PATH`, the installer offers to update the relevant
shell startup file when running interactively. Non-interactive installs print
the exact `export PATH` command instead of editing shell files silently.

## Install Sources

Install the current stable release:

```sh
npx --registry https://registry.npmjs.org gsam install
```

Install canary or pin an exact published version:

```sh
npx --registry https://registry.npmjs.org gsam install --canary
npx --registry https://registry.npmjs.org gsam install --version 2026.720.0
```

Install a branch, tag, or commit from GitHub:

```sh
npx --registry https://registry.npmjs.org gsam install --ref master
npx --registry https://registry.npmjs.org gsam install --ref v2026.720.0
npx --registry https://registry.npmjs.org gsam install --ref <commit-sha>
```

Use a fork by adding `--repo owner/repository`:

```sh
npx --registry https://registry.npmjs.org gsam install \
  --repo your-org/paperclip \
  --ref your-branch
```

Git-ref installs resolve the requested ref to an exact commit before building.
Review and trust the repository and ref: installing a git ref executes that
revision's package installation and release build scripts on your machine.

## Onboarding And The Service

Run onboarding after a non-interactive installation:

```sh
gsam onboard
```

Interactive onboarding asks whether GS Agentic Manager should run as a background
service when the platform supports one. Automated onboarding deliberately does
not install a service unless explicitly requested:

```sh
gsam onboard --yes                    # configure only; no service install
gsam onboard --yes --install-service  # explicit automation opt-in
gsam onboard --yes --no-install-service
```

After onboarding installs and starts the service, it waits for the service to
report its selected runtime port and then prints the dashboard URL. Interactive
terminals open that URL in the default browser; headless and non-interactive
runs print the URL without trying to launch a browser.

Service commands are namespaced:

```sh
gsam service install
gsam service status
gsam service start
gsam service stop
gsam service restart
gsam service logs -f
gsam service uninstall
```

GS Agentic Manager uses a systemd user service on Linux and WSL2 systems with user
systemd, and a LaunchAgent on macOS. Containers, WSL1, and systems without a
supported user service manager receive foreground `gsam run` guidance
instead of a hard failure.

The service uses the stable managed-install shim, restarts after crashes, and
can start on login. On Linux, service installation may offer to enable user
lingering so it can continue without an active login session. The command
explains and confirms that system-level action before running it.

Use one server process per instance. `gsam run` refuses to start when
the same instance is already supervised; stop the service first or use
`--force` only when you intentionally accept the single-writer risk.

## Update And Rollback

Update according to the source and channel recorded in the install manifest:

```sh
gsam update
```

Select a different release source explicitly:

```sh
gsam update --latest
gsam update --canary
gsam update --version 2026.720.0
```

Managed updates create a database backup before switching payloads, verify the
new CLI, atomically flip `current`, and restart an installed service. A failed
install or verification leaves the previous payload active.

If the service is stopped, start it with `gsam service start` before
updating so GS Agentic Manager can take the safety backup. Use
`gsam update --no-backup` only when you intentionally accept updating
without that rollback safeguard. A never-onboarded instance with no config or
instance data skips the backup automatically because there is nothing to save.

Roll back to the previous retained payload:

```sh
gsam update --rollback
```

The `upgrade` command is an alias for `update`. Exact versions and commit SHAs
are pinned; provide a new target when you want them to move.

## Other Installation Methods

Ephemeral tryout with no managed install:

```sh
npx --registry https://registry.npmjs.org gsam onboard --yes
```

Traditional global npm install:

```sh
npm install --global --registry https://registry.npmjs.org gsam
gsam onboard
```

Source checkout for development:

```sh
git clone https://github.com/paperclipai/paperclip.git
cd paperclip
pnpm install
pnpm dev
```

The managed `gsam update` command can update managed and global npm
installs. For source checkouts it reports the appropriate git workflow instead
of modifying the checkout automatically.

## Diagnose An Installation

Run:

```sh
gsam doctor
gsam service status
```

`doctor` checks the managed install store, manifest, `current` link, shim,
`PATH`, Node.js version, and service state. Service diagnostics cover unit-file
presence and drift, running state, configured port ownership, and the running
server version.

The CLI and server also print a non-blocking startup warning when Node.js is
below the supported minimum. Upgrade Node.js with a version manager or follow
the downloaded `install.sh` workflow under **Recommended Install**. Do not use
the piped form for this repair because it requires a supported Node.js runtime
before it starts.

## Uninstall

Remove the background service and managed CLI payloads:

```sh
gsam service uninstall
gsam uninstall
```

`gsam uninstall` removes the managed shim, manifest, and CLI payloads.
It deliberately preserves `~/.gsam/instances/`, including configuration,
databases, uploads, logs, secrets, backups, and workspaces. Back up and remove
that data separately only when you intend to delete the GS Agentic Manager instance.
