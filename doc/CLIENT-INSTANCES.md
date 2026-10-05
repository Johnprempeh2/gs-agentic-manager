# Client instances: run-book

One client, one instance (John, 28 Sep 2026, GRE-86). The edition is the pair
of values the instance starts with: `GSAM_MANAGED_CONFIG` and
`GSAM_HIDDEN_SETTINGS`, as in section 5 of the product brief on GRE-83.
Owner: Bedrock.

Script: `scripts/client-instance.sh` (code in `scripts/client-instance/`).
Run it from the release folder the instance must run (see "Where the code
runs"). The server runs from the same folder as the script you call.

## Rules

- Until John names on an issue where real client instances run and approves
  the first client, use sandbox folders and sandbox data only.
- Never use a folder under `~/GSAM/` or `~/.gsam/`, or port 3100, 3200 or
  54329. The script refuses them.
- Never write client names, client data, passwords or tokens into code,
  issues, pull requests or logs. Use a code, not a client name, for the folder.

## What one instance is

Everything is in one folder, `<root>`:

| Path | What |
| --- | --- |
| `client-instance.json` | edition, passed beta features, server port, database port |
| `instances/default/config.json` | app config: `authenticated` mode, loopback only |
| `instances/default/.env` | the instance's own auth secret (mode 600) |
| `instances/default/db/` | its own embedded database, on its own port |
| `instances/default/data/backups/` | its own backups (hourly, kept 30 days) |
| `instances/default/data/storage/`, `secrets/`, `logs/` | files, secrets key, logs |
| `server.log`, `server.pid` | the running server |

The server gets a clean environment: nothing from your shell (agent tokens,
`DATABASE_URL`, `GSAM_HOME`) reaches it. It does keep your `HOME`, `PATH` and
`TMPDIR`, so call the script through `env -i` (below). An agent run has a
`TMPDIR` that is deleted when the run ends, and a `PATH` into `~/GSAM/live`.

## Where the code runs

Each release tag gets its own clone, next to the instance folders, never in
`.gsam/worktrees/` (a worktree can be cleaned up and the instance then stops):

```sh
REL=/path/to/instances/releases/<tag>
git clone --branch <tag> /Users/johnprempeh/Desktop/Code/gs-clip "$REL"
git -C "$REL" remote set-url --push origin DISABLED
(cd "$REL" && pnpm install --frozen-lockfile && pnpm --filter @greatstone/plugin-sdk build)
```

`upgrade` makes this folder itself (below). Instances on the same tag share
its folder. Do not edit or `git pull` in it; a new release gets a new folder.
Call the script with a clean environment:

```sh
env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" LANG=en_US.UTF-8 \
  PATH=/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/bin:/bin \
  "$REL/scripts/client-instance.sh" status --root <root>
```

Check which folder an instance runs from:
`lsof -a -d cwd -p "$(cat <root>/server.pid)"`.

## Start a new instance

```sh
# Managed
scripts/client-instance.sh create --root /path/to/instances/c001 --edition managed

# Managed plus: list ONLY features whose Beacon verdict on GRE-81 has passed
scripts/client-instance.sh create --root /path/to/instances/c002 \
  --edition managed-plus --passed-features enablePipelines,enableCases

# Greatstone's own install (no edition values; never for a client)
scripts/client-instance.sh create --root /path/to/instances/pilot01 --edition internal
```

Managed and Managed plus pin `enableManagedSandboxOnly` off (GRE-160: with it
on and no sandbox provider, every run is refused). `internal` sets no
edition values. `verify` then checks only health,
the one company, the client log-in and closed sign-up.

Options: `--port` (default: first free from 3300), `--db-port` (default: first
free from 55400), `--company-name`, `--client-email`, the install limits
and the AI access settings below.
`create` also skips the ports in each sibling folder's `client-instance.json`
(stopped instances too), and refuses a `--port` or `--db-port` that a sibling claims.

### Install limits (GRE-141)

Every new instance gets install limits. They are settings of that instance,
kept in `<root>/client-instance.json` and given to the server as
`GSAM_INSTALL_LIMITS` at every start. They are spend and run caps, not prices.
`scripts/client-instance.sh --help` shows the defaults.

| Flag | Meaning |
| --- | --- |
| `--agent-budget-cents N` | Monthly budget of each new agent that has none (hard stop on). |
| `--agent-daily-runs N` | Runs a day for each new agent that names no cap. |
| `--max-concurrent-runs N` | Runs at the same time on the whole install. Replaces the Run limits cap in Instance → General. |

When an agent spends its budget, it is paused, its runs stop, and it says so
in a comment on each task it holds (`todo` or `in_progress`). The task keeps
its assignee. The board raises the budget on the Costs page (the agent then
starts again) or gives the task to another agent.

The budget and daily cap go on agents made after the start that uses them.
An agent's own budget, set by the board, stays. `verify` checks that every
agent has a monthly budget.

Show or change the limits of an instance (the next start uses them):

```sh
scripts/client-instance.sh limits --root <root>
scripts/client-instance.sh limits --root <root> --agent-budget-cents N
scripts/client-instance.sh stop --root <root> && scripts/client-instance.sh start --root <root>
```

An instance made before GRE-141 has no limits until `limits` sets them.

The memory and disk floors are not set by the script: new runs wait while free
memory is below 2048 MB or free disk (data dir and home volume) is below
20 GB (GRE-207). The OS memory-pressure level does not hold runs (GRE-198).
Change them in Instance → General → Run limits; 0 turns a floor off.

### AI access route and board approval (GRE-667)

The script sets both. There is no hand step after `create`.

| Flag | Meaning |
| --- | --- |
| `--ai-route R` | The AI access route of the install: `claude_api_key` (default; GRE-142 marks it as clearly allowed for unattended agents), `claude_subscription`, `codex_api_key` or `codex_subscription`. Kept in `<root>/client-instance.json` and written to the instance settings (`general.aiAccessRoute`) at every start. |
| `--board-approval on\|off` | Board approval for new agents in the company (`requireBoardApprovalForNewAgents`). Default `on`. Set once at create. |

Show or change the route (the next start writes it):

```sh
scripts/client-instance.sh ai-route --root <root>
scripts/client-instance.sh ai-route --root <root> --ai-route codex_api_key
scripts/client-instance.sh stop --root <root> && scripts/client-instance.sh start --root <root>
```

A change made in the app is put back at the next start: the route in
`client-instance.json` wins. An instance made before GRE-667 has no route
until `ai-route` sets it, and `verify` fails until then. If the board turns
board approval off in the app, `verify` fails; turn it on again in Company →
Settings.

`create` does, in order:

1. Checks the edition against this build (unknown or wrong-tier features stop it).
2. Writes the folder, then starts the server once **without** either
   edition value (the app refuses company creation while
   `GSAM_MANAGED_CONFIG` is set, and invites while `company.invites` is
   hidden) and makes: one operator log-in (instance admin, for Greatstone), one
   company (board approval for new agents on), one client log-in (board owner
   of that company, not instance admin).
3. Stops, closes sign-up (`auth.disableSignUp: true`), then starts with both
   edition values and writes the AI access route.
4. Runs every check (below) and writes the first backup.
5. Prints both log-ins **once** to the terminal. Give them to John. They are
   not stored anywhere else.

It stops with an error if any check fails; the instance stays up so you can look.

## Start, stop, status

```sh
scripts/client-instance.sh start  --root <root>   # always with both edition values and the AI route
scripts/client-instance.sh stop   --root <root>   # server and its database
scripts/client-instance.sh status --root <root>
```

The same `--root` always gives the same edition, ports and data.

`status` also shows the newest backup and its age, the last restore-check,
the last off-host backup, the current release tag, and the last upgrade and restore. It prints a `WARNING` line when there is no
backup or the newest is older than 2 hours; the exit code stays 0. Run
`status` before and after each upgrade.

## Check an instance

```sh
CLIENT_INSTANCE_OPERATOR_PASSWORD=... scripts/client-instance.sh verify --root <root>
```

It checks: health; every hidden setting is reported hidden; each section 5
"on" feature is on and each "off" feature is off; a change request to each
floored hidden setting returns 403; exactly one company; the AI access route
is the one in `client-instance.json`; board approval for new agents is on (or
off when created with `--board-approval off`); the client log-in
gets 403 on the release API (`instance.releases`, no Releases page on a client
edition); every agent has a monthly budget (when the instance has install
limits); new sign-ups are refused. A refused request
changes nothing. If one is accepted, the script puts the old value back and
fails.

`instance.environments`, `company.secrets`, `company.export` and
`company.invites` also return 403 since GRE-107. `verify` proves they are
hidden; it does not yet send a change request to each of them.

## Back up

```sh
scripts/client-instance.sh backup --root <root>    # the instance must be running
```

The file goes to `<root>/instances/default/data/backups/`. The script fails if
the file lands anywhere else. Scheduled backups go to the same folder.

### Prove a backup restores (GRE-616)

```sh
scripts/client-instance.sh restore-check --root <root> [backup file]   # newest backup if none named
```

It restores the backup into a throwaway database under `$TMPDIR` on a free
port, applies this release's migrations, counts companies, users and issues,
then deletes the throwaway database. It prints one line, for example
`restore-check OK: <file>, 1 company, 2 users, 0 issues`, or
`restore-check FAILED: <file>: <reason>` with exit code 1. It reads only the
backup file: the instance's database, ports and process are not touched, and
it can run while the instance runs. The result is kept as `lastRestoreCheck`
in `client-instance.json`; `status` shows it and prints a `WARNING` when there
is no check, the last one failed, or it is older than 7 days. Run it at least
once a week. Sandbox test: `scripts/client-instance/restore-check.sandbox-test.sh <empty dir>`.

### Off-host backups (GRE-666)

Every night the host copies `client-instance.json` and the backups folder to
an encrypted [restic](https://restic.net) repository off the host (the
Storage Box in "Client hosting options" on GRE-664). One instance code has
its own repository, its own key and its own target account, so one client's
host cannot read another client's copies.

The config is one file per code, mode 600, outside `<root>`. It names the
repository and the key file; it never holds the key:

```sh
# /etc/gsam/offsite/c001.env  (chmod 600)
RESTIC_REPOSITORY=sftp:<sub-account for c001>@<storage box>:/home/c001
RESTIC_PASSWORD_FILE=/etc/gsam/offsite/c001.key   # chmod 600
```

The repository must end in `/<code>`, and the code is the `<root>` folder
name; the script refuses anything else. A local folder (`/srv/offsite/c001`)
works the same way for tests. Give the sub-account an SSH key in the host's
`~/.ssh/config`, never a password.

```sh
scripts/client-instance.sh offsite-init   --root <root> --offsite-config <file>   # once
scripts/client-instance.sh offsite-backup --root <root> --offsite-config <file>   # every night
```

`offsite-init` makes the repository; run twice, it changes nothing. Keep a
copy of the key file somewhere other than the host (John's password
manager): without it the copies cannot be read. `offsite-backup` takes one
snapshot, then keeps 30 daily and 12 weekly ones and deletes the rest. It
prints `offsite-backup OK: snapshot <id>, <n> files` or
`offsite-backup FAILED: <reason>` with exit code 1, and keeps the result as
`lastOffsiteBackup` in `client-instance.json`. `status` prints a `WARNING`
when there is none, the last one failed, or it is older than 26 hours. Add
`--restic <path>` when `restic` is not on the `PATH`.

**Prove the off-host copy restores.** Once a month, on a sandbox machine (not
the client's host), with the same config file:

```sh
scripts/client-instance.sh offsite-check --code c001 --offsite-config <file> --sandbox <empty dir>
```

It restores the newest snapshot of that code into the sandbox, runs
`restore-check` on that copy, then deletes the copy (it holds client data).
It prints `offsite-check OK: c001, snapshot <id> of <time>: restore-check OK: ...`
or `offsite-check FAILED: ...` with exit code 1. Put the line on the
instance's issue.

### Host watch (GRE-666)

Every 5 minutes the host runs one pass of the watch:

```sh
scripts/client-instance.sh watch --root <root> --watch-config <file>
```

It checks: the app runs and health is `ok`; the newest backup is under 2 h
old; the last restore-check passed and is under 7 days old; the last
off-host backup passed and is under 26 h old; free disk is at least 20 GB and
free memory at least 2048 MB (the floors below which the app holds runs,
GRE-207); and AI access, read through the operator log-in (GRE-15): each AI
connection is `connected`, no token expires in under 7 days, and no run was
refused by the AI provider in the last hour. The run check also covers a
client's personal AI log-in, which the operator cannot list.

It prints one `PASS` or `FAIL` line per check, keeps them in
`<root>/watch-state.json` (the same signals the health check-in, GRE-144,
will send), and exits 1 when any check fails. Then:

- **Dead-man check.** It pings `WATCH_PING_URL` (a healthchecks.io check, one
  per instance code, period 5 min, grace 10 min) when all pass, and
  `<url>/fail` with the report when not. healthchecks.io mails its alert
  address when a `/fail` arrives or the pings stop (the host or the timer is
  down).
- **Mail.** With `WATCH_ALERT_EMAIL` and `WATCH_MAIL_COMMAND` (any command
  that reads a mail with `To:` and `Subject:` lines on stdin, for example
  `/usr/sbin/sendmail -t`), it mails that address when the set of failing
  checks changes, again every 24 h while it stays failing, and once when all
  pass again. A mail that fails to send is tried again at the next pass.

The alert address is the Greatstone person on call; until the support rota
exists (GRE-665) that is John. The config file, mode 600, outside `<root>`:

```sh
# /etc/gsam/watch/c001.env  (chmod 600)
WATCH_OPERATOR_PASSWORD=<operator log-in password from create>
WATCH_PING_URL=https://hc-ping.com/<check uuid>
WATCH_ALERT_EMAIL=<on-call address>
WATCH_MAIL_COMMAND=/usr/sbin/sendmail -t
```

It needs the ping URL, or the mail pair, or both: a watch that tells no one
is refused.

**On a hosted server** (`doc/CLIENT-HOSTING.md`), timers run all three
through `instance-ctl.sh`, from the release folder the instance last started
from. The config files are `/etc/gsam/offsite/<code>.env` and
`/etc/gsam/watch/<code>.env` (owner `gsam`, mode 600), the key file next to
the off-host one. The units are in `scripts/client-instance/host/`.
`setup-host.sh` installs them and makes the two config folders; run the
`install` lines below again only after an upgrade changes the units.

| Timer | Runs | When |
| --- | --- | --- |
| `gsam-watch@<code>.timer` | `watch` | every 5 minutes |
| `gsam-offsite@<code>.timer` | `offsite-backup` | every night, 02:30 to 03:00 |
| `gsam-restore-check@<code>.timer` | `restore-check` | every Sunday, 03:30 to 04:00 |

```sh
install -m 0644 "$REL"/scripts/client-instance/host/gsam-{watch,offsite,restore-check}@.{service,timer} /etc/systemd/system/
install -m 0755 "$REL"/scripts/client-instance/host/instance-ctl.sh /usr/local/lib/gsam/
systemctl daemon-reload
systemctl enable --now gsam-watch@<code>.timer gsam-offsite@<code>.timer gsam-restore-check@<code>.timer
```

Run `offsite-init` once by hand (as `gsam`) before the first night.

Sandbox test of off-host backups and the watch (a local repository, a stand-in
dead-man endpoint and mail command, a refused AI run, a wrong operator
password, the app down, and recovery):

```sh
RESTIC=/path/to/restic scripts/client-instance/offsite-watch.sandbox-test.sh <empty scratch dir>
node cli/node_modules/tsx/dist/cli.mjs --test scripts/client-instance/offsite.test.ts scripts/client-instance/watch.test.ts
```

## Agree the update time with the client

Clients run only `stable-*` tags (`stable-YYYY-MM-DD.N`), made by John with
"Promote to Stable" on the Releases page. Until the first client, and until
the in-app slot picker (GRE-131) exists, Greatstone agrees each update time
with the client directly:

1. When John promotes a new `stable-*` tag, Greatstone tells the client
   "Version X is ready" with the client notes (the tag message) and offers
   one or two slots outside the client's working hours.
2. The client picks a slot. Record the instance code, the tag and the slot on
   the issue. No client name.
3. Tell the client the instance is down for a few minutes in that slot.
4. In the slot, Bedrock runs `upgrade` (below), then says on the issue which
   instance moved and to which tag.

## Upgrade (after John promotes a Stable release)

One instance at a time, in the agreed slot, with John's go-ahead on the issue
for a real client instance:

```sh
scripts/client-instance.sh upgrade <root> <stable tag> \
  [--repo /Users/johnprempeh/Desktop/Code/gs-clip] [--releases <dir>]
```

Run it with a clean environment (see "Where the code runs"). It refuses any
tag that is not a `stable-*` tag, or a tag that is not in `--repo` (default:
the `origin` of the folder the script runs from). `--releases` defaults to
`releases/` next to the instance folder. It does, in order, and stops with a
clear error at the first failure:

1. Makes the release folder `<releases>/<tag>` (clone, `pnpm install
   --frozen-lockfile`, plugin SDK build), or reuses it if it is a clean
   checkout of that tag. This is before the backup, so the instance keeps
   running while it installs.
2. `backup` (file `pre-upgrade-*` in the instance's own backups folder). It
   writes the old and new release and the backup file to `lastUpgrade` in
   `client-instance.json`.
3. `stop`.
4. `start` with the script from the new release folder (migrations apply at
   start). The instance is down only between stop and start.
5. Health check: health is `ok`, mode is `authenticated`, and the server
   process runs from the new release folder.

When a step after the backup fails, it prints the `restore` command to move
back. After it passes, run `verify`. `verify` writes `lastVerify` to
`client-instance.json`; `status` shows `edition check: passed on <tag>` or
warns `NOT VERIFIED since upgrade/restore to <tag>` until a `verify` after the
move passes (GRE-783).

Release folders are never removed by a script. To see which ones are still in
use (GRE-833), run:

```sh
scripts/client-instance.sh releases <instances dir> [--releases <dir>]
```

It reads every `client-instance.json` in the instances folder and lists each
release folder with its size and the instances that use it: `runs` (the
instance runs from it, `release.dir`) or `restore needs it` (`restore` moves
back to it, `lastUpgrade.from.dir`). It writes and deletes nothing. Remove by
hand only folders marked `not used`; this also frees disk for the 20 GB floor
that `watch` checks.

## Restore (move back after an upgrade; Greatstone only)

```sh
scripts/client-instance.sh restore <root> <backup file>
```

The backup must be the one `upgrade` made just before (the script prints it;
it is also `lastUpgrade.backupFile` in `client-instance.json`). Any other file
is refused. It does, in order:

1. If the instance runs: a safety backup (`pre-restore-*`) of the data made
   since the upgrade. Keep it; it is the only copy of that data.
2. `stop`.
3. Restores the backup into a fresh database of this instance only.
4. `start` with the script from the release folder before the upgrade.
5. Health check, as for `upgrade`.

Then run `verify`, and say on the issue which instance moved back, to which
tag. Files uploaded after the upgrade stay in `storage/`; only the database
goes back. A restore cannot turn a feature back on: `GSAM_MANAGED_CONFIG` is
never stored in the database.

Tested on a sandbox instance (upgrade, then restore, then health check and
`verify`):

```sh
scripts/client-instance/upgrade-restore.sandbox-test.sh <empty scratch dir> [from ref] [to ref]
```

## Change the edition values

Edit only when section 5 of the product brief changes:
`scripts/client-instance/editions.ts`. Run its tests:

```sh
node cli/node_modules/tsx/dist/cli.mjs --test scripts/client-instance/editions.test.ts
```

The tag rules for `upgrade` and `restore`, and the `releases` listing, have their own tests:

```sh
node cli/node_modules/tsx/dist/cli.mjs --test scripts/client-instance/releases.test.ts
```

## The edition values for a Docker image

A client install from the Stable image (GRE-138, see "Stable image" in
`doc/GREATSTONE-WAY-OF-WORKING.md`) gets the same two values. Print them as
`KEY=VALUE` lines for `docker run --env-file`:

```sh
scripts/client-instance.sh edition-env --edition managed
scripts/client-instance.sh edition-env --edition managed-plus --passed-features enableCases
```
