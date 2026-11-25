# GSAM for Windows (native)

25 Nov 2026. Decision: GSAM runs natively on Windows (no WSL, no Docker), so a
customer can install it on a Windows PC beside the Mac app in `packaging/macos`.
This plan covers the phases. W1 and W2 are done in the pull request that adds
this file; W3 to W5 are later.

| Phase | What | State |
| --- | --- | --- |
| W1 | Windows CI that proves GSAM runs natively | done (`.github/workflows/windows-ci.yml`) |
| W2 | Porting fixes the CI found | done for the install path, remaining items below |
| W3 | Prebuilt runner binaries on `live-*` releases | planned |
| W4 | Windows installer | planned |
| W5 | Cross-platform fleet orders, OS column, download picker | planned |

## W1: what the Windows CI proves

`windows-ci.yml` runs on `windows-latest` for pull requests that touch code the
Windows build runs, and by hand. It uses the same setup as Fork CI (Node from
`.nvmrc`, pnpm 9.15.4, a frozen-lockfile install, the pinned Rust toolchain;
the pnpm store and the cargo build are cached), then:

1. **Builds the native runner**, `paperclip-runnerd.exe`, with cargo and MSVC
   from the runner image (`build:binary`, the same binary `pnpm dev:once`
   builds on first start).
2. **Install smoke test**, `scripts/native-install-smoke.mjs`: starts GSAM
   exactly as the Mac app's background service does, `pnpm dev:once
   --data-dir <fresh folder>`, then
   - waits for `/api/health` (embedded PostgreSQL 18 initialised its cluster
     and started, migrations applied),
   - checks the UI answers on `/`,
   - creates a company and an agent through the API (local_trusted mode, the
     installed default),
   - stops the whole process tree and checks the port is free,
   - starts again on the same data folder and reads the company and agent
     back (PostgreSQL restarted on an existing cluster and kept the data),
   - stops again.
3. **Unit tests** that cover the Windows-sensitive code: home paths (shared and
   CLI), process groups, the dev runner (options, paths, native binary staging,
   process tree stop, local service supervisor), adapter utilities (spawning,
   process kill guards, child output capture, environment), the Claude and
   Codex adapters (config, home folders, arguments, parsing).
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
| POSIX shell for workspace services | Agents' workspace runtime services (dev servers an agent starts) run through `sh -lc`. Git for Windows' full or portable build provides `sh`; MinGit does not. | The installer ships PortableGit (which includes `sh` and bash) instead of MinGit, or sets `SHELL` to it. Decide in W4. | S |
| Full test suite on Windows | Only the curated set runs. Many tests assume `/bin/sh`, POSIX signals or `/tmp`. | Grow the curated list file by file as features are confirmed; never block on the whole suite. | L, ongoing |

Features off on Windows until those land: the agent secret shield, the
process kill guard (see Known gaps), the hot-restart snapshot on stop, the
Codex app server Unix proxy.

## Known gaps (security and correctness)

These are not hidden by the green Windows job: some of its tests skip on
Windows because of them, and each needs its own work before Windows customers
rely on the feature.

### 1. No process kill guard on Windows (W2 follow-up, size M)

On Linux and macOS, `packages/adapter-utils/src/process-kill-guard.ts` wraps
`pkill` and `killall` for every agent run so a broad pattern cannot stop the
live GSAM server or anything running from the install or data folders (it
stopped live for 8.5 hours on 4 Oct 2026). On Windows
`processKillGuardSupported()` is false, so **nothing stops an agent's
commands from killing the live server**, and its POSIX path tests are
skipped there.

Proposed Windows equivalent:

- Wrap `taskkill` and PowerShell's `Stop-Process` (the two ways an agent
  kills on Windows; `pkill` does not exist there) with `.cmd` and PowerShell
  shims on the run's PATH ahead of the system ones, as the POSIX wrappers are.
- Before passing a kill through, resolve its targets with
  `Get-CimInstance Win32_Process` (PID, parent PID, command line, executable
  path) and refuse when a target is the live server's PID, one of its
  ancestors, a process in its tree, or a process whose command line or
  executable sits under a protected folder.
- Protected markers: the install and data folders as today, plus the drive
  roots (`C:\` and the other fixed drives) and `%USERPROFILE%` themselves,
  never used as a "live" marker in their own right (the same rule as `/` and
  `$HOME` on POSIX), with the run's own workspace exempt when it lies strictly
  inside a protected folder.
- Port the existing path tests with Windows paths, and add a real-process
  test like the Linux one (start a fake live server, run the shimmed
  `taskkill /IM node.exe /F`, assert it survives).
- Limit: like the POSIX guard, it covers the commands it wraps; an agent can
  still call the Win32 API directly. Job Objects for agent runs (the runner
  item above) narrow that further.

Size: M (about 3 days with tests).

### 2. Credential files rely on the folder ACL, not 0600

On POSIX the Codex adapter writes `auth.json` and `config.toml` (which holds
the MCP bearer token) with mode `0600` and their folders `0700`. Windows has
no mode bits: those files take the ACL of the folder they are written in.

- **Staged sync home**: `stageCodexHomeForSync` stages into `os.tmpdir()`,
  which on Windows is `%LOCALAPPDATA%\Temp`, private to the user (the user,
  SYSTEM and Administrators). A new Windows-only test
  (`codex-home.test.ts`, "stages credentials that Users and Everyone cannot
  read") reads the ACL of the staged `auth.json` and `config.toml` with
  `icacls` and fails if `Users`, `Everyone` or `Authenticated Users` can read
  them; it also proves the check goes red on a file granted to `Users`.
- **Managed Codex home**: lives under the instance root,
  `<data folder>\instances\<id>\[companies\<id>\]codex-home`. With the
  data folder under `%USERPROFILE%` or `%LOCALAPPDATA%` (the installer's
  default, as `~/GSAM-data` is on the Mac) it is private to the user by
  default. **A data folder elsewhere is not**: the root of a second drive
  (`D:\`), for example, grants `Authenticated Users` modify by default. The
  installer (W4) must therefore keep the data folder under the user profile,
  or, if the customer picks another place, lock that folder once with
  `icacls <data> /inheritance:r /grant:r "%USERNAME%:(OI)(CI)F" "SYSTEM:(OI)(CI)F"`
  so everything under it, credentials included, is user-only. Size: S, part
  of W4.

### 3. Codex managed home uses file symlinks (likely broken for standard users)

`ensureSymlink` links the managed Codex home's `auth.json` to the shared
source so rotating refresh tokens stay single-copy (#5028). Windows only lets
a standard user create file symlinks with Developer Mode switched on; the CI
tests pass because the runner account is an administrator. On a customer's
PC the Codex adapter's first run would most likely fail with `EPERM`. This
is not yet proven in CI (the smoke test does not run Codex). Hard links are
not a fix (Codex replaces `auth.json` by rename, which leaves a stale copy,
the exact bug #5028 fixed). Options: point `CODEX_HOME` at the shared folder
on Windows, or copy on start and copy back after each run under the existing
auth merge (`codex-auth-merge-*`). Size: M. Prove it first by running the
managed home tests as the standard smoke user.

## W3: prebuilt runner binaries

Today the first start compiles `paperclip-runnerd` with cargo, so a customer
needs Rust (and on Windows the MSVC build tools, a 2 GB download that needs
admin). Instead:

- A release workflow builds `paperclip-runnerd` for Windows x64, Mac arm64
  and Mac x64 when a `live-*` tag is pushed and attaches them to the GitHub
  release with a `SHA256SUMS` file.
- The installer (and the nightly updater) downloads the binary for its
  platform, checks the SHA-256, and sets `GSAM_RUNNER_BINARY` to it. The dev
  runner already skips its own cargo build when `GSAM_RUNNER_BINARY` is set
  (`scripts/dev-runner-native-binary.mjs`).
- Rust stays a fallback for developers only.

Size: M. Needs: nothing from John (public repo, standard runners).

## W4: Windows installer

Mirror `packaging/macos/src/gsam.sh` step by step, so both apps behave the
same:

- **Engine**: `gsam.ps1` (PowerShell 5.1, which every Windows 10 and 11 PC
  has) with the same subcommands: `status`, `node`, `git`, `code`, `deps`,
  `runner`, `tools`, `service`, `wait`, `open`, `update`, `log`. Each step is
  safe to run again.
- **Node**: the official Node zip for `win-x64`, checked against
  `SHASUMS256.txt` (SHA-256) before it is unpacked into
  `%LOCALAPPDATA%\GSAM\runtime\node`; `corepack enable`.
- **Git**: MinGit was the plan, but agents' workspace services run through
  `sh -lc` (see the table above) and MinGit has no `sh`. Use PortableGit
  (the self-extracting portable Git for Windows, which includes bash and
  `sh`) into the runtime folder, with its own SHA-256 check, and put its
  `usr\bin` on the service's PATH. MinGit remains possible if those services
  move to cmd.exe on Windows.
- **Code**: clone, then check out the newest `live-*` tag, as on the Mac.
- **Runner**: the prebuilt binary from W3 (no Rust, no MSVC).
- **Licence activation**: reuse `packaging/macos/src/mac-setup.mjs` from branch
  `gsam-product-p1`. It has no dependencies and only needs Node, so it runs
  unchanged on Windows; rename it to `setup.mjs` when it moves to a shared
  folder.
- **Service**: Task Scheduler instead of launchd. One task runs
  `pnpm dev:once --data-dir` at log-on (restart on failure), one runs the
  updater at 03:30 (run as soon as possible if missed). Both run as the
  signed-in user, so no admin rights are needed.
- **Package**: an Inno Setup `.exe` that installs per user (no admin), puts
  a Start menu shortcut that opens `http://localhost:3100` as an app window
  in Edge, and runs the engine steps with a progress page.
- **Remote access**: Tailscale for Windows (its own installer, needs admin
  once); the same tailnet setup as the Mac.
- **Signing**: an unsigned `.exe` shows a SmartScreen warning ("Windows
  protected your PC") until it builds reputation. A code-signing certificate
  (OV or EV) removes it. **Needs John**: buying the certificate (EV needs a
  hardware token or a cloud signing service) and the company verification.

Size: L (about two weeks with testing on a clean Windows 11 machine).

## W5: cross-platform fleet and website

- **Spoke orders**: `server/src/services/fleet-spoke.ts` on branch
  `gsam-product-p3` runs `launchctl kickstart` for "update now". Add a Windows
  branch that runs `schtasks /Run /TN "GSAM Update"` (S), behind one
  `platformServiceManager()` helper so the order code stays the same.
- **Fleet OS column**: spokes report `process.platform` and `os.release()` in
  their heartbeat; the fleet table shows it (S).
- **Website download picker**: detect the visitor's OS and offer the Mac app
  or the Windows installer, with the other one a click away (S).

## Needs John

- A code-signing certificate for the Windows installer (W4), or a decision to
  ship unsigned at first and accept the SmartScreen warning.
- When the Windows job has been green for a week: whether to make it a
  required check.
