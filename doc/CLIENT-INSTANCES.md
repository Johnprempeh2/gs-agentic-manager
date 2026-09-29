# Client instances: run-book

One client, one instance (John, 28 Sep 2026, GRE-86). The edition is the pair
of values the instance starts with: `GSAM_MANAGED_CONFIG` and
`GSAM_HIDDEN_SETTINGS`, as in section 5 of the product brief on GRE-83.
Owner: Bedrock.

Script: `scripts/client-instance.sh` (code in `scripts/client-instance/`).
Run it from the checkout of the release the instance must run.

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
`DATABASE_URL`, `GSAM_HOME`) reaches it.

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

Managed and Managed plus pin `enableManagedSandboxOnly` on. Agents then run
only in a managed sandbox from a sandbox provider plugin (e2b, Daytona, Modal
and similar). An instance without one refuses every run. `internal` sets no
edition values, so agents run on the host. `verify` then checks only health,
the one company, the client log-in and closed sign-up.

Options: `--port` (default: first free from 3300), `--db-port` (default: first
free from 55400), `--company-name`, `--client-email`.

`create` does, in order:

1. Checks the edition against this build (unknown or wrong-tier features stop it).
2. Writes the folder, then starts the server once **without** either
   edition value (the app refuses company creation while
   `GSAM_MANAGED_CONFIG` is set, and invites while `company.invites` is
   hidden) and makes: one operator log-in (instance admin, for Greatstone), one
   company, one client log-in (board owner of that company, not instance admin).
3. Stops, closes sign-up (`auth.disableSignUp: true`), then starts with both
   edition values.
4. Runs every check (below) and writes the first backup.
5. Prints both log-ins **once** to the terminal. Give them to John. They are
   not stored anywhere else.

It stops with an error if any check fails; the instance stays up so you can look.

## Start, stop, status

```sh
scripts/client-instance.sh start  --root <root>   # always with both edition values
scripts/client-instance.sh stop   --root <root>   # server and its database
scripts/client-instance.sh status --root <root>
```

The same `--root` always gives the same edition, ports and data.

## Check an instance

```sh
CLIENT_INSTANCE_OPERATOR_PASSWORD=... scripts/client-instance.sh verify --root <root>
```

It checks: health; every hidden setting is reported hidden; each section 5
"on" feature is on and each "off" feature is off; a change request to each
floored hidden setting returns 403; exactly one company; new sign-ups are
refused. A refused request
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

## Restore (sandbox copy only)

Not scripted yet: this script has no `restore` command, and a restore has not
been tested. Until it has, do not restore a client instance. The next step
adds `restore` and tests it on a sandbox copy. A restore cannot turn a feature
back on: `GSAM_MANAGED_CONFIG` is never stored in the database.

## Upgrade (after John makes a release)

One instance at a time:

1. `backup`.
2. `stop`.
3. Move the checkout the instance runs from to the release tag.
4. `start` (migrations apply at start), then `verify`.
5. Say on the issue which instance moved and to which tag.

## Change the edition values

Edit only when section 5 of the product brief changes:
`scripts/client-instance/editions.ts`. Run its tests:

```sh
node cli/node_modules/tsx/dist/cli.mjs --test scripts/client-instance/editions.test.ts
```
