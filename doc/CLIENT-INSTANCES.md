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

### Prove two instances cannot reach each other (GRE-1362)

One sandbox test makes a sandbox hub and two Managed instances with the same
`create` command, then proves AT-3.1, AT-3.5 and AT-3.6 (GRE-1357): the two
differ only in root, ports, database, secrets and keys; neither port,
log-in, session, database password, backup, master key, off-host key or
fleet key of one works on the other; `/api/fleet` is 404 on a client
instance; and no signed check-in holds seeded business text or ids.

```sh
RESTIC=/path/to/restic scripts/client-instance/isolation.sandbox-test.sh <empty scratch dir>
```

The test needs restic. If it is not on the host, use the release binary
(tested with 0.17.3; pick the file for your OS and CPU):

```sh
curl -sSL -o restic.bz2 https://github.com/restic/restic/releases/download/v0.17.3/restic_0.17.3_linux_amd64.bz2
bunzip2 restic.bz2 && chmod +x restic && ./restic version
```

It ends with `ALL PASSED`, and stops all three instances. Run it after any
change to `create`, the backups, the off-host backups or the fleet channel.

Local backups are plain database dumps. On a host where every instance runs
as the same user (`gsam`), they are kept apart by folder and by the script's
path checks, not by a key. Secrets inside them stay encrypted with the
instance's own master key.

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

### Add board, Exco and owner log-ins (GRE-1189)

`create` makes one client log-in, and invites stay hidden for clients. To add
the rest (about 35 for a Strategy Board client), write a list and run `users`
on the running instance:

```sh
# list.csv: keep it off the app, issues and pull requests; delete it when done
name,email,role
Ada Board,ada@example.test,board
"Kofi, Exco",kofi@example.test,exco
Ola Owner,ola@example.test,owner

scripts/client-instance.sh users --root <root> --file list.csv --dry-run   # what it would do
scripts/client-instance.sh users --root <root> --file list.csv
```

| role | company role | board right (GRE-1135) |
| --- | --- | --- |
| `board` | Viewer | `strategy:board_member`: reads the strategy, asks "Why?", makes board packs; cannot edit goals, run agents or change settings |
| `exco` (or `admin`) | Admin | acts on the board through the Admin role |
| `owner` | Owner | acts on the board through the Owner role; chooses the board and the chair |

- The whole list is checked first. With any bad row (no name, bad email,
  unknown role, an email listed twice) it prints each one and writes nothing.
- It makes a backup (`pre-users-*`) before the first change.
- Safe to run again: a log-in that is already as the list says is `unchanged`.
  A log-in with the membership but without a right gets the right (`added`).
- It never changes a role. A log-in that has another role, or a membership that
  is not active, is `REFUSED`; the exit code is then 1. Change that role in the
  app (owners do it in Company settings > Members).
- New log-ins get a random password, printed **once** to the terminal. Give
  them to John. The chair is chosen in the app by an owner.

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

`status` also shows the lifecycle: active, paused or archived (see "Pause,
resume, archive, delete"). An archive past its retention end shows
`DUE FOR DELETION`.

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

## Billing account (GRE-1369)

Each instance has one billing account record: plan, modules, fees, AI
allowance, term, renewal, cancel state and invoice lines. The operator log-in
(instance admin) sets it. Every board user of the instance can read it; any
other write gets 403 `settings_operator_managed`. No price, allowance or end
policy is built in: every value comes from the signed order form.

```sh
# as the operator log-in; the whole record each time
curl -X PUT <base>/api/instance/billing-account -H 'Content-Type: application/json' -d '{
  "planKind": "modules",                 # or "all_inclusive"
  "planName": "<name on the order form>",
  "catalogueVersion": "packaging-v2-d2-2026-10-11",
  "currency": "GBP",
  "serviceFeeCents": N,                  # Foundation and service fee per term period
  "modules": [{"key": "crm", "feeCents": N}, {"key": "crm_write_back", "feeCents": N, "scope": "<agreed scope>"}],
  "allowanceMonthlyCents": N,            # AI allowance included in the fee
  "termKind": "monthly",                 # or "annual"
  "termStartsOn": "YYYY-MM-DD",
  "autoRenew": true,
  "endAction": "pause",                  # or "archive" (John's policy); null until decided
  "reason": "<why>"
}'
# one invoice line; sending the same reference again corrects it
curl -X POST <base>/api/instance/billing-account/invoices -H 'Content-Type: application/json' \
  -d '{"reference": "<invoice no>", "periodStart": "YYYY-MM-DD", "periodEnd": "YYYY-MM-DD",
       "amountCents": N, "currency": "GBP", "status": "issued", "url": "https://<invoice link>", "issuedOn": "YYYY-MM-DD"}'
```

- **Modules** follow packaging v2 with John's D2 choices (11 Oct 2026):
  `board` is an add-on that needs `strategy`; `crm_write_back`,
  `crm_two_way_sync` and `crm_migration` each need `crm` and a `scope`;
  pipelines and cases are in `crm`; development environments are in
  `software_development` only. `feeCents: null` means included in the plan
  fee. An all-inclusive plan lists its modules: a module added later does not
  join it. The list is in `packages/shared/src/billing-account.ts`.
- **Invoices** keep a reference, period, amount, status and link. No card or
  bank data: any other field is refused.
- **Cancel.** A client owner or admin cancels with
  `POST /api/instance/billing-account/cancel` (`{"reason": "..."}`). The
  next renewal stops and access stays to the end of the paid period that holds
  that day. The day after, the status is `ended` and shows `endAction`; the
  operator then pauses or archives the instance on the host. Nothing is
  refunded automatically. A second cancel changes nothing.
- **Auto-renew off** (operator) stops renewal the same way, without a cancel.
- **Undo.** Only the operator lifts a cancel:
  `POST /api/instance/billing-account/resume-renewal` with a reason.
- Every change writes one activity row (`billing.account_updated`,
  `billing.invoice_recorded`, `billing.cancel_requested`,
  `billing.renewal_resumed`) with the old and new values.

## Copy a drafted plan to the client (GRE-1190)

The strategy plan is drafted in the practice (workshop) instance. This step
copies it to the client's instance. Both instances must be running. Add the
client's users first (F11), so that owners can be matched.

```sh
scripts/client-instance.sh plan-copy --from <practice root> --to <client root>              # report only
scripts/client-instance.sh plan-copy --from <practice root> --to <client root> --apply on   # copy
```

- What moves: every goal with a strategy kind (vision, value, CSF, pillar,
  objective, KPI, initiative) with its plan fields: KPI target, baseline,
  direction and thresholds, due dates, done-when, initiative budget, benchmark
  note. Nothing else moves: no plain goals, issues, comments, check-ins, KPI
  readings, agents, secrets or research-pack links.
- Owners: a person owner is matched by email to an active member of the client
  company. An owner with no match, and every agent owner, is listed; the goal
  moves without that owner. Add the user, then run again.
- `--apply on` backs up the client instance first (`pre-plan-copy-*`), then
  writes the whole plan in one transaction.
- Run it again after a workshop change: each goal keeps its id, so a re-run
  updates the copied goals and makes no duplicates. It never deletes a goal in
  the client instance, and it does not clear an owner set there.
- The practice instance needs `--from-company <id>` when it has more than one
  company. The client instance must have exactly one company.
- Owner emails are printed to the terminal only. Do not paste them into issues.

The company export/import is not used: it does not carry goals, and a client
edition refuses import.

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
# Hosted only: probe /api/health through DNS, Caddy and TLS.
WATCH_PUBLIC_URL=https://<hostname>
# WATCH_ALERT_EMAIL=<on-call address>
# WATCH_MAIL_COMMAND=/usr/sbin/sendmail -t
```

It needs the ping URL, or the mail pair, or both: a watch that tells no one
is refused. **On a hosted server, use the ping URL alone** and let
healthchecks.io send the mail to the alert address. The host has no mail
server, and Hetzner blocks outgoing port 25 on new accounts, so `sendmail`
would fail at every pass. Set the mail pair only with a working SMTP relay.
On the first server, prove that a person gets the alert: stop the app once
and check that the mail arrives (readiness plan on GRE-664, gap G-e).

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

## Report to the Greatstone hub (GRE-1082)

A client instance can report to a Greatstone hub: a GS Agentic Manager that
oversees all client instances. The channel is in the app. Each message is
signed with the instance's own key; the network (Tailscale or other) is not
chosen yet and is never the only lock. The hub cannot send commands.

**On the hub.** Start the hub with `GSAM_FLEET_HUB=true`. Without it, every
fleet route answers 404 (a client instance is never a hub). An instance
admin of the hub makes a one-time code for an instance code:

```sh
curl -X POST <hub>/api/fleet/instances -d '{"code":"c001"}'   # as a hub instance admin
```

The answer holds `registrationCode`, shown once and good for 24 h. The hub
keeps only its hash. Give it to the person who runs `create`; never put it
in an issue or a log.

**On the client host.** Register at create, or later:

```sh
CLIENT_INSTANCE_FLEET_CODE=<code> scripts/client-instance.sh create --root <root> --edition managed --fleet-hub https://<hub>
CLIENT_INSTANCE_FLEET_CODE=<code> scripts/client-instance.sh fleet-register --root <root> --fleet-hub https://<hub>
```

The instance makes its own Ed25519 key pair in `<root>/fleet/key.json` (mode
600) and sends only the public key. The hub URL must be https (http only on
loopback, for sandbox tests). The key is not in the backups: after a restore
on a new host, revoke and register again.

**Check-in.** Each `watch` pass (every 5 minutes) sends one signed check-in
when the instance is registered. `fleet-check-in --root <root> --watch-config
<file>` sends one now. A failed check-in prints a `WARNING` and does not
change the watch exit code; `status` shows the last one. The check-in has a
fixed schema (`packages/shared/src/fleet.ts`): edition; health (app up,
backup age, last restore-check and off-host backup); version (release tag,
app version, last upgrade); usage totals over the whole instance (companies,
active agents, runs in 24 h, failed runs in 24 h, spend and budget this month,
storage bytes); and
one alert per watch check as key and pass/fail only; lifecycle (`active`,
`paused` or `archived`, from `lifecycle` in `client-instance.json`, absent
means active); and connection health as four counts over the whole instance
(AI log-ins healthy / needs attention, tool connections active / disabled),
or null when the app is down. Per-company signals fold
into one key for the whole instance (it fails when any company fails), so no
company id leaves the host; the hub refuses a key with a `:` suffix. The
signal detail text stays on the host. Runs in 24 h are counted page by page,
so the count is not capped at 1000. Failed runs are those that ended
`failed`, `timed_out` or `interrupted` (the failure-rate rule). No names, emails, titles or client records. A new field needs a
code change and review; the hub refuses any field it does not know.

**Revoke.** From the hub: `POST <hub>/api/fleet/instances/<id>/revoke`. From
the client host: `fleet-revoke --root <root>` (signed; then the key is
deleted). After a hub revoke the next check-in fails with "the hub revoked
this instance"; run `fleet-revoke --root <root> --local-only yes` to delete
the old key, ask the hub for a new code
(`POST <hub>/api/fleet/instances/<id>/registration-code`), and register again.

The hub refuses a bad signature, a revoked key, a message older than 5
minutes, and any message it has seen (each carries a growing `seq`). One
instance's key cannot write as another, and no route lets an instance read
anything back. Read check-ins on the hub (instance admins only):
`GET <hub>/api/fleet/instances` and `GET <hub>/api/fleet/instances/<id>/check-ins`.
The hub keeps 7 days of check-ins.

Each instance in the hub list has a `state`. A paused or archived instance
shows `paused` or `archived`, never `stale` or `down`, also when it sends
nothing more. An active one shows `ok`, `stale` after
`GSAM_FLEET_STALE_AFTER_MINUTES` (default 15) with no check-in, and `down`
after `GSAM_FLEET_DOWN_AFTER_MINUTES` (default 60) or when its last check-in
said the app was down. Set both on the hub. The hub still takes the v1
check-in from an instance that is not yet upgraded; it keeps the last
lifecycle it knows.

Tests:

```sh
node cli/node_modules/tsx/dist/cli.mjs --test scripts/client-instance/fleet.test.ts
(cd server && npx vitest run src/__tests__/fleet-routes.test.ts)
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

## Pause, resume, archive, delete (GRE-1367)

Use these when a client stops, takes a break or leaves. Each is a named act:
`--operator` is the Greatstone person who runs it. Run them only with John's
go-ahead on the issue for a real client.

**Cost.** A paused or archived instance makes no new AI use, no runs and no
pause or archive fee. It still uses disk, backups and admin time. Those are
allocated costs: they stay in active-client economics and are not billed to
the client as a fee.

### Pause

```sh
CLIENT_INSTANCE_OPERATOR_PASSWORD=... scripts/client-instance.sh pause --root <root> \
  --operator <name> --reason "<why>"
```

The instance must run. In this order it:

1. pauses each active company in the app (GRE-1364): live runs and queued
   wakes are cancelled, timers and routines stop, every connection and AI
   grant is suspended. A company that was paused already is left as it is;
2. counts runs, cost events, finance events and invoices;
3. makes a backup (`pre-pause-*`);
4. records the pause in `client-instance.json` (`lifecycle: paused`);
5. sends a check-in that says `paused` (when registered with a hub);
6. stops the app.

Data, local backups and the off-host repository stay. While paused, `start`
is refused with exit code 3 (the systemd unit does not restart on it),
`offsite-backup` and `restore-check` say `skipped` and change nothing, and
`watch` reports `paused` and fails only if the app runs.

If `pause` stops after step 1 and before step 4, the companies are paused
but no pause is recorded, and `resume` refuses (`no pause record`). To
recover: sign in as the operator and resume each company in the app
(`POST /api/companies/<id>/resume` with `operator` and `reason`). Then run
`pause` again if the instance must still pause.

On a hosted server, after `pause`, stop the unit so systemd does not try to
start it: `sudo systemctl disable --now gsam-client@<code>`. Leave the watch
timer on; it keeps sending check-ins that say `paused`.

### Resume

```sh
CLIENT_INSTANCE_OPERATOR_PASSWORD=... scripts/client-instance.sh resume --root <root> \
  --operator <name> --reason "<why>"
```

It starts the app with the companies still paused, then counts the same rows
again. `PASS no new use while paused` means no run, cost event, finance event
or invoice was added (AT-4.6). If a row was added, it says `FAIL`, finishes
the resume and exits 1: find out why before the client uses the instance.
Then it resumes only the companies that `pause` paused, with the operator and
reason. Missed routine ticks are not replayed. Connections stay off until
each one is turned on again in the app and passes its health check. Run
`verify` next. On a hosted server: `sudo systemctl enable --now gsam-client@<code>`.

An archived instance can be resumed the same way. If another instance took
its ports, it gets new ones; the script says which.

### Archive (dormant)

```sh
scripts/client-instance.sh archive --root <root> --operator <name> \
  --retention-days <N> --offsite-config <file> --sandbox <empty dir> [--restic <bin>]
```

Only from `paused`. `<N>` is John's retention setting; there is no default
and the script holds no value. It:

1. starts the app only for a final backup (`archive-*`; the companies stay
   paused), then stops it;
2. sends the backups off the host (`offsite-backup`);
3. pulls the newest off-host copy into `--sandbox`, runs restore-check on it
   and deletes the copy. If this fails, nothing is archived and the instance
   stays paused;
4. checks both ports are free. Other instances may use them now;
5. records the archive date, the retention days and the retention end
   (`lifecycle: archived`), and sends a check-in that says `archived`.

The local data stays until a delete. When the retention end passes, `status`
shows `DUE FOR DELETION`. Nothing is deleted automatically.

### Delete

```sh
scripts/client-instance.sh delete --root <root> --confirm-code <code> \
  --approval <issue or ticket> --operator <name> \
  [--offsite-config <file>] [--watch-config <file>] [--fleet-local-only yes] [--restic <bin>]
```

Only from `paused` or `archived`, with the app stopped. `--confirm-code` is
the instance code typed again. `--approval` is the issue or ticket where John
approved the deletion. Deletion follows John's approved retention and legal
policy; do not delete before it allows.

In this order it:

1. **Billing records (AT-4.10).** Greatstone's billing records are not
   deleted with the instance. Until `billing-export` (B11, GRE-1372) is in,
   `delete` stops with `billing-export missing` when the instance holds any
   billing account or invoice, and removes nothing. With no billing record it
   says so and goes on;
2. **Hub.** Sends a signed `delete` to the hub. The hub removes this
   instance's record and its check-ins, then the local hub key is deleted.
   If the hub refuses or cannot be reached, `delete` stops and removes
   nothing. If the hub had revoked the key, the spoke cannot ask: the key is
   deleted and the record says a hub admin must run
   `DELETE /api/fleet/instances/<id>` on the hub. With `--fleet-local-only yes`
   (the hub is gone), only the local key is deleted, with the same note;
3. removes every off-host snapshot of the code (`restic forget --prune`), the
   repository folder when it is local, the off-host key file and config
   file. On a Storage Box the empty repository folder stays: remove it there
   by hand;
4. removes the watch config file, when given (it holds the operator password);
5. removes the instance folder: database, data, local backups, logs, keys.

It leaves one record at `<instances dir>/deletions/<code>.json`: code, date,
operator, approval reference, what was removed and what was not. No client
data. A second run finds nothing to delete and says when it was deleted.
On a hosted server, also `sudo systemctl disable --now gsam-watch@<code>.timer
gsam-offsite@<code>.timer gsam-restore-check@<code>.timer`.

### Prove it on a sandbox

```sh
RESTIC=/path/to/restic scripts/client-instance/lifecycle.sandbox-test.sh <empty scratch dir>
```

It makes a Managed sandbox instance and runs pause, resume (AT-4.6 PASS),
pause again, archive, the due-for-deletion line, the delete refusals and a
delete, then a second delete.

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
