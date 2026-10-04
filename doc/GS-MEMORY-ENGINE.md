# Organization memory engine: runbook

The sandbox engine behind the GSAM memory gateway ([ADR-0001](adr/0001-organization-memory-gateway-on-hindsight.md)).
Hindsight `0.10.2` on its own PostgreSQL 16 + pgvector, on John's PC, beside live GSAM. Owner: Bedrock. Issue: GRE-674.
The change list is GRE-649 section 5.3, approved by John on 4 Oct 2026.

**Synthetic data only** (Kestrel Works fixtures) until gate G4.

## Layout

| Item | Value |
|---|---|
| Service user | `gsmemory` (system user, no login shell). Agents run as `johnprempeh` and cannot read its files. |
| Root folder | `/home/gsmemory/gs-memory/` (`~/gs-memory/` of the service user), mode `0700` |
| Sub-folders | `app/` (venv, `hindsight.env`, `setup/` copy of `scripts/gs-memory`), `pg/data`, `pg/run` (socket), `models/`, `secrets/`, `backups/`, `logs/`, `home/` |
| Engine | `127.0.0.1:18888`, every API call needs the gateway key. MCP off. Prompt log off. Claude CLI telemetry, error reports and update checks off (`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`). Main PID for the egress check: `systemctl show -p MainPID --value gs-memory-hindsight`. |
| Database | `127.0.0.1:15432`, role `hindsight` with a password only the engine holds. Socket folder is `0700`. Any other login is rejected. |
| Windows copy | `C:\GreatstoneBackups\gs-memory\` (`/mnt/c/GreatstoneBackups/gs-memory/`) |
| Units | `gs-memory-postgres.service`, `gs-memory-hindsight.service` (not enabled at boot), `gs-memory-backup.timer` (enabled, 02:30 nightly) |
| Limits | engine `MemoryHigh=5G`, `MemoryMax=6G`, `CPUQuota=600%`; database `MemoryMax=4G`, `CPUQuota=400%`; `Nice=10` |
| Never | `~/GSAM/`, ports 3100, 3200, 54329, the live database, `.wslconfig`, Tailscale. The script refuses these ports and paths. |

Secrets (all `0600` in `secrets/`, never printed, never in the repo):
`db.env` (database password), `engine.env` (gateway key), `claude.env` (Claude plan token, after `link-claude`).

## Install (one time, needs sudo)

From an up-to-date checkout of `main`:

```sh
sudo scripts/gs-memory/gs-memory.sh system-setup
sudo -u gsmemory /home/gsmemory/gs-memory/app/setup/gs-memory.sh install
```

`system-setup` makes the user and folders, installs `postgresql-16`, `postgresql-16-pgvector` and `python3-venv`,
drops the package's default `16/main` cluster, copies the setup files to `app/setup/`, installs the four units
and enables only the backup timer. `install` makes the cluster, builds the venv from `requirements.lock`
(hashes required, wheels only, CPU-only torch), downloads the two local models (about 215 MB) and writes the
secrets. Both are safe to run again.

## Link the Claude plan (one time, John)

Extraction uses John's Claude Max plan through Hindsight's `claude-code` provider. Internal use only; never for a client
instance. There is no API key and no paid fallback.

1. In John's own terminal: `claude setup-token` (browser sign-in; prints a long-lived token).
2. `sudo -u gsmemory /home/gsmemory/gs-memory/app/setup/gs-memory.sh link-claude` and paste the token. It is not echoed.
3. `sudo systemctl restart gs-memory-hindsight`

Undo: `... gs-memory.sh unlink-claude`, then restart. Without the link the engine uses provider `none`:
`chunks` retain and recall still work (no model call), extraction and reflect do not.

The token is a new token made for the engine. Do not copy `~/.claude` files. On Linux Hindsight runs the Claude CLI
with an isolated config folder, so it cannot use John's existing sign-in anyway.

## Start, check, stop

```sh
sudo systemctl start gs-memory-hindsight      # also starts gs-memory-postgres
curl -fsS http://127.0.0.1:18888/health
scripts/gs-memory/gs-memory.sh check          # run as johnprempeh = agent-side evidence
sudo systemctl stop gs-memory-hindsight gs-memory-postgres
```

`check` proves: both ports listen on `127.0.0.1` only; both are refused on every other address (Tailscale included);
the API answers `401` without a key and with a wrong key; MCP is off; the calling user cannot read the root folder;
a database login without the password is refused. Set `GS_MEMORY_CHECK_KEY` (as `gsmemory`) to also prove `200` with
the key. Stopping the engine never touches live GSAM; the gateway returns "memory unavailable".

## Gateway key for the GSAM server

Only the GSAM server holds the key. Put it straight into the GSAM secret store, never into an issue, a log or a
run environment:

```sh
sudo -u gsmemory /home/gsmemory/gs-memory/app/setup/gs-memory.sh gateway-key | <GSAM secret store command>
```

It refuses to print to a terminal. Rotating: delete `secrets/engine.env`, run `install`, restart, update the store.

## Back up and restore

- Nightly at 02:30 the timer runs `backup`: `pg_dump -Fc` to `backups/` plus a `.sha256`, and a copy to
  `C:\GreatstoneBackups\gs-memory\`. 14 dumps kept in each place. If the database is not running it skips.
- By hand: `sudo -u gsmemory .../gs-memory.sh backup`
- Restore test (throwaway cluster on a free port, removed after): `sudo -u gsmemory .../gs-memory.sh restore-test [dump]`
- Real restore: stop the engine, `dropdb`/`createdb hindsight -O hindsight` over the socket, `pg_restore --no-owner --role=hindsight`, start.
- **Open:** the off-disk copy (external drive or encrypted OneDrive) waits for John's choice. The Windows copy is
  on the same physical disk and is readable by Windows and by `johnprempeh`; fine for synthetic data, must be
  encrypted or moved before G4.

## Upgrade Hindsight

1. Change the pin in `scripts/gs-memory/requirements.in` (Delta reviews the version, GRE-648).
2. Regenerate the lock:
   `uv pip compile --generate-hashes --python-version 3.12 --python-platform x86_64-unknown-linux-gnu --index-url https://pypi.org/simple --extra-index-url https://download.pytorch.org/whl/cpu --index-strategy unsafe-best-match --no-header -o scripts/gs-memory/requirements.lock scripts/gs-memory/requirements.in`
3. Pull request, review, merge. Then back up, re-run `system-setup` (copies the new files) and `install`
   (rebuilds the venv because the lock hash changed), restart, run `check`.

## Sandbox test (no sudo)

Every path and port is an environment variable, so the whole script runs as a normal user in a scratch folder:

```sh
S=$(mktemp -d); (cd "$S" && apt-get download postgresql-16 postgresql-16-pgvector postgresql-client-16 libpq5 && for d in *.deb; do dpkg -x "$d" pgroot; done)
export GS_MEMORY_USER=$(id -un) GS_MEMORY_ROOT=$S/root GS_MEMORY_PG_BIN=$S/pgroot/usr/lib/postgresql/16/bin \
  GS_MEMORY_PG_PORT=25432 GS_MEMORY_API_PORT=28888 GS_MEMORY_WINDOWS_BACKUPS=$S/win \
  LD_LIBRARY_PATH=$S/pgroot/usr/lib/x86_64-linux-gnu TMPDIR=$S
mkdir -p $S/win && scripts/gs-memory/gs-memory.sh install
scripts/gs-memory/gs-memory.sh serve-postgres & sleep 3; scripts/gs-memory/gs-memory.sh serve-hindsight &
GS_MEMORY_CHECK_KEY=$(cut -d= -f2- $S/root/secrets/engine.env) scripts/gs-memory/gs-memory.sh check
scripts/gs-memory/gs-memory.sh backup && scripts/gs-memory/gs-memory.sh restore-test
```

Stop both processes and remove `$S` after.

## Known limits

- Ubuntu ships pgvector `0.6.0`. Hindsight works with it; the `hnsw.iterative_scan` tuning (pgvector 0.8+) is skipped.
- `/health`, `/version` and `/metrics` answer without a key (loopback only; bank ids are not in metrics).
- Agents run as the same Linux user as the GSAM server, so the gateway key's safety depends on how GSAM stores it.
  Mason's scoped tenant extension (signed per-request assertion) closes this; until then the key is the only lock.
