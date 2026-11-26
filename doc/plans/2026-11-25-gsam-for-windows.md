# GSAM for Windows (native)

25 Nov 2026. Decision: GSAM runs natively on Windows (no WSL, no Docker), so a
customer can install it on a Windows PC beside the Mac app in `packaging/macos`.
This plan covers the phases. W1 and W2 landed in #1223; W3 to W5 and the two
known gaps are in #1224.

| Phase | What | State |
| --- | --- | --- |
| W1 | Windows CI that proves GSAM runs natively | done (`.github/workflows/windows-ci.yml`) |
| W2 | Porting fixes the CI found | done for the install path, remaining items below |
| W3 | Prebuilt runner binaries on `live-*` releases | built (`release-assets.yml`) |
| W4 | Windows installer | built (`packaging/windows`), see the proof below |
| W5 | Cross-platform fleet orders, OS column, download picker | built (hub, Fleet page, website #330) |

## W1: what the Windows CI proves

`windows-ci.yml` runs on `windows-latest` for pull requests that touch code the
Windows build runs, and by hand. It uses the same setup as Fork CI (Node from
`.nvmrc`, pnpm 9.15.4, a frozen-lockfile install, the pinned Rust toolchain;
the pnpm store and the cargo build are cached), then:

1. **Builds the native runner**, `paperclip-runnerd.exe`, with cargo and MSVC
   from the runner image (`build:binary`, the same binary `pnpm dev:once`
   builds on first start).
2. **Install smoke test**, `scripts/native-install-smoke.mjs`, run as a
   freshly created **standard (non-administrator) Windows user**, as a
   customer's copy runs: starts GSAM exactly as the Mac app's background
   service does, `pnpm dev:once --data-dir <fresh folder>`, then
   - waits for `/api/health` (embedded PostgreSQL 18 initialised its cluster
     and started, migrations applied),
   - checks the UI answers on `/`,
   - creates a company and an agent through the API (local_trusted mode, the
     installed default),
   - stops the whole process tree and checks the port is free,
   - starts again on the same data folder and reads the company and agent
     back (PostgreSQL restarted on an existing cluster and kept the data),
   - stops again,
   - and fails if any process the smoke user started is still running.

   Green on 25 Nov 2026 (run 45699245241): health in local_trusted mode,
   UI 200, company and agent created, data kept across the restart, nothing
   left running. The smoke step (two starts, the first applying 426 migrations
   and building the runner's TypeScript) takes about 12 minutes; the whole
   job about 27.
3. **Unit tests** that cover the Windows-sensitive code: home paths (shared and
   CLI), process groups, the dev runner (options, paths, native binary staging,
   process tree stop, local service supervisor), adapter utilities (spawning,
   process kill guards, child output capture, environment), the Claude and
   Codex adapters (config, home folders, arguments, parsing). 295 pass, 17
   skip on Windows (POSIX-only behaviour, each listed under Known gaps or
   behind an existing platform check).
4. **Runner Rust tests**: the conformance and replay parity checks.

The job is not part of the `Fork CI` result yet, so it does not block merges
or releases while it settles. Making it required is a one-line change in
branch protection once it has been green for a week.

## W2: what was fixed

Found by the Windows job or by reading the code paths it runs.

- **Dev runner left the server running when it stopped it.** On Windows
  `process.kill()` ends only the process it is given, and the dev runner's
  server child is `cmd.exe` behind the `pnpm.cmd` shim. Stopping it (restart
  for migrations, Ctrl+C, the runner exiting) orphaned pnpm, tsx, the server
  and embedded PostgreSQL, which kept the port and the data folder.
  `scripts/dev-runner-process.ts` now ends the whole tree with
  `taskkill /T /F` on Windows. Mac and Linux unchanged (process groups and
  SIGTERM). Test: `dev-runner-process.test.ts`, Windows only.
- **The native runner orphaned provider processes.** `process_supervisor.rs`
  used `Child::kill` on Windows, which ends only the direct child (for a
  provider CLI behind a `.cmd` shim, `cmd.exe`), leaving node and its children
  running. It now ends the tree with `taskkill /T /F`.

- **PostgreSQL will not run with administrator rights.** The first Windows
  run found that embedded PostgreSQL refuses to start in an elevated process
  ("Execution of PostgreSQL by a user with administrative permissions is not
  permitted"). `initdb` copes (it drops its own rights), but the server is
  started directly, not through `pg_ctl`, so it does not. A customer's GSAM
  runs as a standard user, so the smoke test now runs as a freshly created
  standard user, and the startup error now tells an administrator to start
  GSAM as a standard user (`packages/db/src/embedded-postgres-error.ts`).

- **Embedded PostgreSQL left workers behind when stopped.** The library
  stopped PostgreSQL on Windows with `taskkill /f /t`, which ended the
  postmaster before its workers; an `io_worker` outlived it, held the data
  folder, and the next start on the same folder (the dev runner checks
  migration status again straight after migrating) hung with no output. The
  embedded-postgres patch now stops it with `pg_ctl stop -m fast`, the
  Windows equivalent of the SIGINT it gets elsewhere, with `taskkill` only as
  a fallback (`patches/embedded-postgres@18.1.0-beta.16.patch`). Mac and Linux
  unchanged.
- **Windows checkouts had CRLF line endings.** Git for Windows defaults to
  `core.autocrlf=true`, so every text file checked out with CRLF and every
  generated-file check failed (first the runner's protocol types, inside
  `pnpm dev:once`). `.gitattributes` now checks text out with LF on every OS.
  Every text file was already LF in the repository, so Mac and Linux
  checkouts do not change.

- **Package scripts used POSIX shell commands.** pnpm runs package scripts
  with cmd.exe on Windows. The plugin SDK build that `pnpm dev:once` runs
  builds `@greatstone/shared`, whose script used `mkdir -p` and `cp`; it now
  copies with Node.
- **The server scripts begin with `exec`.** On POSIX `exec` keeps a shell out
  of the server's process tree, so signals reach the server; cmd.exe has no
  `exec`. On Windows the dev runner now runs the script's command through
  `pnpm exec` (read from `server/package.json`, so there is one source of
  truth). POSIX unchanged. Test: `dev-runner-process.test.ts`.

- **Stopping a workspace service left it running.** `terminateLocalService`
  used `process.kill` on Windows, which ends only the shell that wraps an
  agent's workspace service (a dev server, for example). It now ends the
  whole tree with `taskkill /T /F`. POSIX unchanged.
- **Tests with POSIX absolute paths.** `dev-runner-options.test.ts` compared
  results with `/isolated/home`; the code correctly resolves that to
  `D:\isolated\home` on Windows, so the tests now resolve their expectations.
- **Adapter tests.** The Codex home tests now assert POSIX file modes only
  off Windows (the staging itself is still checked); the process kill guard's
  POSIX path tests are skipped on Windows, where the guard is already off;
  the Claude probe test's fake `claude` is `claude.cmd` on Windows, which is
  what an install has and what the code's PATHEXT lookup finds (the code
  needed no change).

Already Windows-aware before this work (about 40 files): `pnpm.cmd` with
`shell: true` in the dev runner, `paperclip-runnerd.exe` naming, no process
groups on Windows, file permission bits (`0600`, `0700`) behind `#[cfg(unix)]`
in the runner, home paths through `os.homedir()`.

## What remains on Windows, with sizes

Sizes: S is under a day, M one to three days, L a week or more.

| Item | Effect on Windows today | Proposed fix | Size |
| --- | --- | --- | --- |
| Starting GSAM elevated | Fails at startup with a clear message ("start GSAM as a standard user"). Matters for someone who uses "Run as administrator" or has UAC switched off. | On Windows, start PostgreSQL through `pg_ctl start -w`, which runs it with a restricted token, and stop it with `pg_ctl stop -m fast` (which also gives Windows a polite PostgreSQL stop). Needs the embedded PostgreSQL supervisor to watch the postmaster PID instead of a child process. | M |
| Polite server stop | No ordered shutdown: the hot-restart snapshot is skipped and PostgreSQL is stopped hard. PostgreSQL recovers from its WAL on the next start (the smoke test proves the data survives), and runs in flight are picked up by the normal crash recovery. | The dev runner already shares a secret with its server (`GSAM_DEV_SERVER_STATUS_TOKEN`). Add a loopback-only, token-checked stop request the runner sends before `taskkill`; the server runs its existing `shutdown("SIGTERM")` path. The Windows service wrapper (W4) calls the same request. | M |
| Runner process supervision | Provider trees are killed with `taskkill /T`, which misses a descendant that re-parented itself, and nothing stops providers if `paperclip-runnerd.exe` itself is killed. | Put each supervised process in a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (through `windows-sys`, already in `Cargo.lock` through tokio), and runnerd itself in one owned by the server. Same guarantees as the POSIX process group plus parent death signal. | M |
| Private file permissions | Files the runner and server write with mode `0600` get the default ACL of their folder instead. Under the user's profile that is already private to the user and administrators. | Keep data under the user profile (the installer does). Optional: set an owner-only ACL on the data folder at install time. | S |
| Agent secret shield | Off (it uses bubblewrap, Linux only; also off on Mac). The health page already reports it as unavailable. | None planned; a Windows equivalent would be an AppContainer, which is L. | L |
| Codex app server Unix proxy | `paperclip-runner-codex-proxy` takes a Unix socket path. Not exercised on Windows yet. | Pass a named pipe path (`\\.\pipe\...`), which Node's `net` accepts on Windows, and add it to the Windows job. | S |
| Other POSIX-only package scripts | `pnpm build` (the full release build) and the `clean` and `prepack` scripts use `rm -rf`, `mkdir -p`, `cp` and `chmod` in about 40 package scripts (`packages/db`, `server`, `cli`, the Codex and Grok adapters, the sandbox providers). None of them runs when GSAM is installed and started; they matter for building releases on Windows. | Replace with Node one-liners or a shared `scripts/fs-tool.mjs`; or set pnpm's `script-shell` to Git Bash on developer machines only. | S to M |
| POSIX shell for workspace services | Agents' workspace runtime services (dev servers an agent starts) run through `sh -lc`. Git for Windows' full or portable build provides `sh`; MinGit does not. | Done in W4: the installer ships PortableGit and puts its `usr\bin` on GSAM's PATH. | done |
| Full test suite on Windows | Only the curated set runs. Many tests assume `/bin/sh`, POSIX signals or `/tmp`. | Grow the curated list file by file as features are confirmed; never block on the whole suite. | L, ongoing |

Features off on Windows until those land: the agent secret shield, the
hot-restart snapshot on stop, the Codex app server Unix proxy. (The process
kill guard is now built; see Known gaps.)

## Known gaps (security and correctness)

Each was found while porting; none is hidden by a green job. Status at the
end of W3 to W5 (pull request #1224):

### 1. Process kill guard on Windows: built

On Linux and macOS, `packages/adapter-utils/src/process-kill-guard.ts` wraps
`pkill` and `killall` for every agent run so a broad pattern cannot stop the
live GSAM server or anything running from the install or data folders (it
stopped live for 8.5 hours on 4 Oct 2026). Windows had none.

Now `process-kill-guard-windows.ts` puts a `taskkill` guard first on a Windows
run's PATH: `taskkill.cmd` (found by cmd.exe and PowerShell through PATHEXT)
and an extensionless `taskkill` (Git Bash, which Claude Code's shell uses),
both running `gsam-process-guard.cjs`. The guard:

- lists every process with `Get-CimInstance Win32_Process` (PID, parent,
  command line, executable) and fails closed when it cannot;
- works out what `taskkill` would end (`/PID`, `/IM` with wildcards, and with
  `/T` every descendant);
- leaves alone the live server, every process above it, and any process
  whose command line or executable names a protected folder (the install and
  data folders), unless that is inside the run's own workspace; with `/T` a
  target whose tree holds a live process is left alone whole;
- ends the rest through the real `taskkill.exe`, one `/PID` at a time, and
  refuses options it cannot check (`/FI`, `/S`, `/U`, `/P`);
- never uses a drive root (`C:\`) or `%USERPROFILE%` (or anything above it)
  as a protected marker, the same rule as `/` and `$HOME` on POSIX.

Also fixed on the way: the run launcher joined its PATH with `:` and
exported it from shell profiles on Windows too, which would have broken a
local Windows run's PATH, so no guard could have been first on it.

Proof (Windows CI, real processes, `process-kill-guard-windows.test.ts`):
the guard is first on the run's PATH; a `taskkill /F` over the server, a
process in the live folder, the agent's own process and an unrelated one
ends only the last two; a **planted failure** runs the real `taskkill.exe`
on the live process and it dies, so the survival is the guard's doing; `/T`
over a tree holding a live process leaves it alone; `/FI` is refused.

Limits, as on POSIX: it covers the command it wraps. PowerShell's
`Stop-Process` (a cmdlet, which no PATH shim can reach) and direct Win32
calls are not covered. Job Objects for agent runs (below) narrow that.

### 2. Credential files rely on the folder ACL, not 0600: handled

On POSIX the Codex adapter writes `auth.json` and `config.toml` (which holds
the MCP bearer token) with mode `0600`. Windows has no mode bits: files take
the ACL of their folder.

- The **staged sync home** is in `os.tmpdir()` (`%LOCALAPPDATA%\Temp`),
  private to the user. A Windows-only test reads the ACL of the staged
  `auth.json` and `config.toml` with `icacls` and fails if `Users`,
  `Everyone` or `Authenticated Users` can read them, with a planted file
  granted to `Users` proving the check goes red.
- The **managed Codex home** is under the data folder. The installer keeps
  the data folder in `%USERPROFILE%\GSAM-data` (private by default); a data
  folder placed anywhere else gets an owner-only ACL from the engine
  (`icacls <data> /inheritance:r /grant:r <user>:(OI)(CI)F SYSTEM:(OI)(CI)F`)
  before anything is written there.

### 3. Codex managed home and file symlinks

**Proven broken, now fixed.** `ensureSymlink` links the managed Codex home's
`auth.json` to the shared credential so rotating, single-use refresh tokens
stay one copy (#5028). Windows lets a standard user make a file symlink only
with Developer Mode on. GitHub's Windows image has Developer Mode on, which
first made the tests pass as the standard user; with it off, as on a
customer's PC, 22 of the 54 Codex home tests failed with `EPERM`. The Codex
adapter would have failed on its first run.

Fix (Windows only; POSIX unchanged), in `codex-home.ts`:

- When Windows refuses the symlink, the home's `auth.json` is a **hard link**
  to the shared credential (no privilege needed). A credential written in
  place is shared at once, exactly as through the symlink.
- A writer that replaces the file splits the link. The next seed (before
  every probe and run) carries a strictly newer same-identity credential back
  to the shared file through the existing `copyBackCodexAuth` (the same
  decision script, directory lock and atomic rename as the sandbox
  copy-back); a home behind the shared file is relinked by the existing
  freshness rule. Another account's credential never goes to the shared file.
- Another volume cannot hold a hard link; there it falls back to a copy kept
  in step the same way.

Proof: `codex-home-windows.test.ts` runs in CI as the standard user with
Developer Mode off, and first checks (a planted environment check) that
Windows really refuses the symlink there; then: the link shares an in-place
refresh, a split home's newer credential reaches the shared file, and another
account's credential does not. The existing 54 Codex home tests still run
with the symlink privilege.

Residual: between a split and the next seed, another home could start with
the older token. Every run seeds first, so the window is one run; a Codex
writer that rewrites in place never splits the link.

## What remains on Windows, with sizes

See the table above for the runtime items (polite server stop, Job Objects,
the secret shield, the Codex app server proxy, POSIX package scripts, the
full test suite). Added by W3 to W5:

| Item | Why | Size |
| --- | --- | --- |
| Run the installer on a real Windows 11 PC | CI cannot sign a user in, so the scheduled task's start at sign-in (Interactive log-on) and "update now" through `schtasks /Run` are proven only up to registration; the CI test starts what the task runs directly (`GSAM_SERVICE_DIRECT`). | S (an hour on a clean VM) |
| Tailscale remote help on Windows | The step is written (tailscaled built from source, userspace networking, its own sign-in task), but userspace networking as a standard user on Windows is not proven, and CI cannot join a tailnet. | M |
| Installer progress UI | The wizard waits while a console window shows each step; a native progress page would look better. | S |
| Release back-fill | `release-assets.yml` publishes on each new `live-*` tag. The current live tag needs one run by hand (Actions, Release assets, Run workflow, tag) before `releases/latest/download/...` serves anything; to be done with John (it publishes to the public repository). Set the repository variable `GSAM_HUB_URL` first. | S |
| Code signing | Unsigned: SmartScreen warns (More info, then Run anyway). The hook is in place (`GSAM_SIGN_COMMAND`, Inno's `SignTool`). | S once a certificate exists |

## Release assets: both installers on every live release

`.github/workflows/release-assets.yml` builds everything a customer downloads
and, on each `live-*` tag, attaches it to that tag's GitHub release with one
`SHA256SUMS`: the three runner binaries, **`GSAM-Installer.dmg`** (Mac) and
**`GSAM-Setup.exe`** (Windows). The release is marked latest only when it is
the newest `live-*` tag, so
`https://github.com/Johnprempeh2/gs-agentic-manager/releases/latest/download/<file>`
always serves the newest installers, and the website links there. A run by
hand with a tag back-fills a tag made before the workflow (not run yet: to be
done with John, since it publishes to the public repository). Pull requests
build everything as workflow artifacts, plus screenshots of the mounted DMG
window (Light and Dark Mode) and of the Windows wizard. The installers take
the hub address from the repository variable `GSAM_HUB_URL`; unset, they
still build, with a warning, and say at activation that they do not know
where Greatstone's service is.

The Mac installer was polished at the same time (`packaging/macos`): a
branded disk image laid out by dmgbuild (pinned, hashes checked; no Finder
needed, so it builds in CI), Greatstone void background with the wordmark and
a lime arrow from GSAM to the Applications alias, the stone as the volume
icon, the window exactly the size of the background, icon labels on
`#767676` pills (Finder draws them black or white depending on the Mac; both
pass AA on that grey), and the first-open step (right-click, then Open) on
the background and in the README. `GSAM.app` is an AppleScript applet, which
is universal; the build fails if it ever is not. Still ad hoc signed and not
notarised.

## W3: prebuilt runner binaries (built)

`.github/workflows/release-assets.yml` builds `paperclip-runnerd` with the
pinned toolchain and locked dependencies for Windows x64 (MSVC), macOS arm64
and macOS x64 (cross-built on the Apple silicon runner). On a `live-*` tag it
attaches the three binaries and `SHA256SUMS` to that tag's GitHub release
(made if missing, never marked latest); pull requests only build, as proof.
`scripts/fetch-runner-binary.mjs` (no dependencies) downloads the binary for
an install's release and checks it against `SHA256SUMS`; its test serves a
fake release and plants a tampered download, which is refused. The Mac app's
new `runner` step uses it (Rust only as the fallback, for a build with no
binary); the Windows installer has no fallback (building needs Microsoft's
build tools). Both hand the binary to GSAM as `GSAM_RUNNER_BINARY`, which the
dev runner and the server already honour, so no install compiles Rust.

Proof: all three binaries build in CI (run 45721453052).

## W4: Windows installer (built)

`packaging/windows` (README there): `src/gsam.ps1` mirrors
`packaging/macos/src/gsam.sh` step for step (`node`, `activate`, `git`,
`code`, `runner`, `deps`, `tools`, `config`, `service`, `wait`, `tailscale`,
`owner`, plus `update`, `stop`, `uninstall`), and `gsam.iss` wraps it in an
Inno Setup `.exe`:

- **No administrator rights**: per-user install in `%LOCALAPPDATA%\GSAM`, data
  in `%USERPROFILE%\GSAM-data`, scheduled tasks for the user only, run level
  Limited.
- **Node**: the official `win-x64` zip, checked against `SHASUMS256.txt`.
- **Git**: PortableGit 2.56.1, pinned SHA-256 (it brings the `sh` agents'
  workspace services need; MinGit has none); long paths on.
- **Code**: the newest `live-*` tag. **Runner**: the prebuilt binary (W3).
- **Licence**: the wizard asks for the key; activation reuses
  `packaging/macos/src/mac-setup.mjs` unchanged except that it reports
  `os: windows` (the hub's activation facts now accept it). The key reaches
  the engine through the environment, never a file or command line.
- **Service**: a task at sign-in running `gsam.ps1 run`, which keeps
  `pnpm dev:once --data-dir` running (started again 30 seconds after it
  stops, as launchd's KeepAlive), with `GSAM_SCHEDULED_TASK` set for "update
  now"; and `<label>.update` daily at 03:30, run as soon as possible if
  missed.
- **Owner**: the one-time set-up link opens in an Edge app window.
- **Unsigned**: SmartScreen shows "Windows protected your PC"; customers
  choose More info, then Run anyway (the website says so). Signing later is
  one setting (`GSAM_SIGN_COMMAND`, for example Azure Trusted Signing).
- **Uninstall** removes the tasks and the app; the data folder stays.

Proof (Windows CI, job "Windows installer"): builds `GSAM-Setup.exe` (kept
as a sandbox artifact, hub 127.0.0.1, never to be handed out), then as a
freshly made standard user with Developer Mode off: a sandbox hub makes a
licence, the installer runs silently with it, and the test checks:

all green (run 45753443815, about 45 minutes): setup finished every step;
GSAM answers in authenticated mode; both scheduled tasks exist and run
without administrator rights; the updater runs at 03:30; the owner's set-up
link was made; status says licensed and waiting for the owner; the install
checked in with the hub as a Windows install (check-in v4); the uninstaller
removed the tasks, kept the data folder, and GSAM stopped.

Found on the way, by running it as a standard user with Developer Mode off:

- **Inno Setup's Redirection Guard.** Setup enables Windows' Redirection
  Guard by default and the processes it starts inherit it; under it Node
  refuses the folder junctions pnpm makes for a standard user, so
  `pnpm install` failed with "unknown error" reading `node_modules`. The
  logged policy confirmed it. `gsam.iss` sets `RedirectionGuard=no`: the
  mitigation guards elevated installers, and this one is never elevated.
- **Directory symlinks.** The repository's own `postinstall`
  (`link-plugin-dev-sdk`) made a directory symlink, which a standard user
  cannot. Directory links now go through one helper, `linkDirectory`
  (`adapter-utils/server-utils`): a junction on Windows, a symlink elsewhere.
  It serves the plugin SDK link, workspace package links and every adapter's
  skill links. POSIX unchanged.
- The engine also runs in 64-bit PowerShell whatever starts it, ignores npm
  and pnpm settings it inherits, keeps its own package store beside the app,
  and retries an install by copying files.

## W5: cross-platform fleet and website (built)

- **Check-in v4** (closed schema): v3 plus `platform { os: macos | windows |
  linux, arch: arm64 | x64 | other }`. The app spoke sends v4; the hub takes
  v1 to v4 and records order results from v3 and v4. A free-text OS is
  refused (test).
- **Update now**: `updaterCommand()` picks the platform's way:
  `launchctl kickstart gui/<uid>/<label>.update` on a Mac (unchanged),
  `schtasks /Run /TN <label>.update` on Windows; nothing elsewhere. Labels are
  checked against `^[A-Za-z0-9.-]{1,120}$` (test).
- **Fleet page**: an OS column (and a phone-card row) from the newest
  check-in; installs on older releases show Not reported (test).
- **Website** (greatstone-website #330): My GSAM offers the Mac or Windows
  download first from the visitor's browser (`userAgentData`, else the user
  agent), with a switch; the Windows note explains SmartScreen. New optional
  setting `GSAM_WINDOWS_INSTALLER_URL`.

## Needs John

- The hub's public address for the release build of the installer
  (`GSAM_HUB_URL`, as for the Mac `build.sh`), and where to host
  `GSAM-Setup.exe` (then set `GSAM_WINDOWS_INSTALLER_URL` on the website).
- Later: an Azure Trusted Signing account (or another code-signing
  certificate) to remove the SmartScreen warning.
- When the Windows jobs have been green for a week: whether to make them
  required checks.
