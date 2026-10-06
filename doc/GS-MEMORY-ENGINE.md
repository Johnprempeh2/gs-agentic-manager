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
| Sub-folders | `app/` (venv, `hindsight.env`, `extension/` (the two Greatstone modules), `setup/` copy of `scripts/gs-memory`), `pg/data`, `pg/run` (socket), `models/`, `secrets/`, `backups/`, `logs/`, `home/` |
| Engine | `127.0.0.1:18888`, every API call needs the gateway key **and** a signed 60-second assertion from the GSAM gateway that names one bank, one operation and the allowed tags (Greatstone extension, GRE-672). MCP off. Prompt log off. Claude CLI telemetry, error reports and update checks off (`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`). Main PID for the egress check: `systemctl show -p MainPID --value gs-memory-hindsight`. |
| Database | `127.0.0.1:15432`, role `hindsight` with a password only the engine holds. Socket folder is `0700`. Any other login is rejected. |
| Windows copy | `C:\GreatstoneBackups\gs-memory\` (`/mnt/c/GreatstoneBackups/gs-memory/`) |
| Drive copy | External drive mounted at `/mnt/gs-backup-drive`, copies in `gs-memory-backup/` (GRE-935) |
| Units | `gs-memory-postgres.service`, `gs-memory-hindsight.service` (not enabled at boot), `gs-memory-backup.timer` (enabled, 02:30 nightly) |
| Limits | engine `MemoryHigh=5G`, `MemoryMax=6G`, `CPUQuota=600%`; database `MemoryMax=4G`, `CPUQuota=400%`; `Nice=10` |
| Never | `~/GSAM/`, ports 3100, 3200, 54329, the live database, `.wslconfig`, Tailscale. The script refuses these ports and paths. |

Secrets (all `0600` in `secrets/`, never printed, never in the repo):
`db.env` (database password), `engine.env` (gateway key and assertion secret), `gateway.env` (the GSAM server's copy
of both, see below), `claude.env` (Claude plan token, after `link-claude`).

## Install (one time, John, needs sudo)

From a fresh checkout of `main` (not `~/GSAM/live`). Live GSAM keeps running; nothing here restarts it.
Steps 2 onward use the engine's own copy of the script, made by step 1.

```sh
# 0. Preflight, no sudo, changes nothing. Every line must be PASS (NOTE lines are information).
scripts/gs-memory/gs-memory.sh preflight

# 1-4. Install.
sudo scripts/gs-memory/gs-memory.sh system-setup
sudo -u gsmemory /home/gsmemory/gs-memory/app/setup/gs-memory.sh install
sudo /home/gsmemory/gs-memory/app/setup/gs-memory.sh link-gateway
sudo systemctl start gs-memory-hindsight      # also starts gs-memory-postgres

# 5. Link the Claude plan, in private (next section). Then restart the engine only.
sudo systemctl restart gs-memory-hindsight

# 6. Prove it. RESULT: PASS.
scripts/gs-memory/gs-memory.sh check
```

If any step shows a FAIL or an ERROR, stop and comment on the install issue with its output (no secrets).
`install` ends with `Claude CLI for the engine: ... (<version>)`; that line proves `gsmemory` can run the Claude CLI.

**Existing PostgreSQL.** `system-setup` checks first, before it changes anything. If `pg_lsclusters` lists any
cluster, or `postgresql.service` is active, it prints what it found and stops with an error. It never drops a
cluster. Only if that PostgreSQL is not needed while the engine runs, run it again with
`--allow-disable-default-postgres`: that stops and disables `postgresql.service` (every cluster and its data stay
on disk; `sudo systemctl enable --now postgresql` brings them back). Re-runs of `system-setup` need the same flag
while such a cluster exists. On a PC with no PostgreSQL the package install is told not to make the default
`16/main` cluster, so a re-run passes the check.

`system-setup` makes the user and folders, installs `postgresql-16`, `postgresql-16-pgvector` and `python3-venv`,
copies the setup files to `app/setup/`, installs the four units and enables only the backup timer. It also proves
`gsmemory` can write the Windows copy folder (see below) and stops with an error if not.
`install` makes the cluster, builds the venv from `requirements.lock`
(hashes required, wheels only, CPU-only torch), downloads the two local models (about 215 MB), copies the
two extension modules to `app/extension/` and writes the secrets. An older `engine.env` gets the assertion secret
added; its key does not change. Last, it runs the Claude CLI the engine will use (the one bundled in
`claude-agent-sdk`) as `gsmemory`, and fails if it cannot. `link-gateway` writes the GSAM server's `gateway.env`
(next section but one). All three are safe to run again.

### Windows copy folder

`system-setup` makes `/mnt/c/GreatstoneBackups/gs-memory` owned by `gsmemory` and writes and removes a test file as
`gsmemory`. With the WSL `metadata` mount option the owner change works. Without it (the WSL default) `/mnt/c`
ignores the owner and shows every folder as `rwxrwxrwx`, so `gsmemory` can write too. If the test fails,
`system-setup` stops with an error. The nightly `backup` fails (non-zero exit, `systemctl --failed` shows
`gs-memory-backup.service`) if the folder is missing, the copy fails or the copy's checksum does not match; the
local dump is kept. After the first `backup`, prove the copy with `ls -l /mnt/c/GreatstoneBackups/gs-memory/`
(a `.dump.enc` and its `.sha256`; never a plain `.dump`, see "Back up and restore").

## Link the Claude plan (one time, John, in private)

Extraction uses John's Claude Max plan through Hindsight's `claude-code` provider. Internal use only; never for a client
instance. There is no API key and no paid fallback.

1. In John's own terminal: `claude setup-token` (browser sign-in; prints a long-lived token).
2. `sudo -u gsmemory /home/gsmemory/gs-memory/app/setup/gs-memory.sh link-claude` and paste the token at the
   prompt. It is not echoed, printed or logged; it goes only to `secrets/claude.env` (mode `600`). Do not pass it
   with `echo` (shell history), and never paste it into GSAM, an issue or a chat.
3. `sudo systemctl restart gs-memory-hindsight` (the engine only; not `gs-memory-postgres`, not live GSAM)

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
`/health` answers `200`; the API answers `401` without a key and with a wrong key; MCP is off; the calling user cannot
read the root folder; a database login without the password is refused. When the caller can read `gateway.env` (or
sets `GS_MEMORY_CHECK_KEY` and `GS_MEMORY_CHECK_ASSERTION_SECRET`) it also proves: the key without an assertion is
refused, the key plus a signed assertion is accepted, and an assertion for one bank is refused on another bank.
The check writes nothing; its bank does not exist, so "accepted" shows as `404 Bank ... not found`. Stopping the engine never touches live GSAM; the gateway returns "memory unavailable".

## Gateway secrets for the GSAM server

The GSAM server reads the engine URL, the key and the assertion secret from `~/gs-memory/secrets/gateway.env` of the
user it runs as (`/home/johnprempeh/gs-memory/secrets/gateway.env`; a sandbox GSAM can use
`GSAM_MEMORY_GATEWAY_CONFIG=<path>`). The server refuses the file unless it is mode `600`. The secrets are
deliberately not in the server environment, because agent processes inherit it.

`install` (as `gsmemory`) writes `secrets/gateway.env` in the engine root. `install` cannot write into the GSAM user's
home, so `sudo .../gs-memory.sh link-gateway` copies it there (owner = the user who ran `sudo`, mode `600`, folders
`700`). Never paste the file into an issue, a log or a run environment.

Rotating: delete `secrets/engine.env`, run `install` and `link-gateway`, restart the engine.

**Residual risk (accepted by Everest, 5 Oct 2026, synthetic data only).** The GSAM server and the agents run as the
same Linux user (`johnprempeh`). Mode `600` therefore does not hide `gateway.env` from agents: an agent that reads it
can sign its own assertions and call the engine directly, past the gateway's permission checks. `check` prints this
as a `NOTE`. This is accepted while memory holds only synthetic data. It **must be closed before G4** (real data);
it is an open item on the G4 gate in GRE-646. Possible fixes: run agents as a different user, or give the server a
signing helper that agents cannot read.

## Delete, supersede and retention (GRE-886)

- **Delete** (`POST /api/companies/:id/memory/records/:recordId/delete`, owner, the agent for its own working notes,
  or a `memory:delete` grant) leaves a tombstone: id, scope, contributor, source reference, dates and links. In one
  transaction it clears the record's title, content, entities, topics and evidence; scrubs every queued or sent
  `retain` payload in `memory_ingest_outbox` (an unsent one becomes `cancelled`); clears relationship notes and
  conflict terms; and drops the record's `memory_extracted_facts` rows. It then deletes the engine document, which
  removes its chunks, memory units and their search entries. If the engine is down, the delete waits in the outbox
  and is retried. Recall never returns a deleted record, even before the engine delete lands.
- The Hindsight entity table can keep an entity **name** that other documents share. Summit's phase 2 deletion test
  (GRE-888) checks the real engine tables for any raw text left.
- **Supersede** keeps the old record readable as history (`GET .../records/:recordId/history`) and links both ways.
- **Retention** (G1 decision 7): agent working notes 90 days after last use, unreviewed entries 180 days unless
  approved, cited by an approved record or in an open conflict, superseded entries 1 year. `POST .../memory/retention`
  with `{"dryRun": true, "withinDays": 14}` lists what falls due soon; `{"dryRun": false}` deletes what is due. Owner or
  `memory:admin` only. Backups follow the 90-day rule below.

## Graph and contribution activity (GRE-864)

Read-only routes under `/api/companies/:id/memory`; types in `packages/shared/src/memory.ts`.

- `GET .../graph` lists records the caller may read (never deleted ones) and the edges between them. Edges come only
  from stored rows: stated relationships and supersession (`explicit`, a stated link), and open conflicts from the
  contribution check and open link check leads (`inferred`, found by a check). Each edge has its type, kind, author and
  `basis` (what the link check matched, or null). An edge is returned only when both ends are in the result. Engine
  entity links are not stored in GSAM, so they are not edges.
- `GET .../graph/nodes/:recordId` and `GET .../graph/edges/:edgeId` give detail and provenance. Contributor, reviewers
  and the conflict check or engine extraction are kept as separate roles.
- `GET .../activity` lists contributions newest first, with review history; `GET .../activity/counts` counts them per
  contributor with the same filters, so a drill-down returns the same records. Counts are activity, not quality.
- Filters: `agentId`, `userId`, `scopeId`, `projectId`, `status`, `q`, and for activity `from` / `to` (`to` exclusive).
- Every query starts from the scopes the caller may read. Hidden records add no node, edge, label, count or feed row;
  a hidden or missing record or edge is the same 404.

## Linking memories (6 Oct 2026)

- **Stated links.** Agents have a fourth tool, `memory_link` (from, to, type, short reason), and `memory_contribute`
  takes `relatedTo` ids so a new entry is linked as it is saved; a refused `relatedTo` link saves nothing. Types are
  the relationship types (`supports`, `contradicts`, `refines`, `depends_on`, `same_subject`). The agent is the
  author and the run is the source. The rule is the contribute rule: `memory:contribute` on both scopes (an agent's
  own working notes count). Two records in different scopes may be linked, except that a client or restricted-project
  record links only inside its own scope. A hidden record is the same 404 as a missing one. Every attempt is in
  `memory_operations` (`memory_link`), ids and type only.
- **Link check.** Every 6 hours per company with memory on (the server scheduler; the steward routine is not live
  before G4), and on demand by the owner or a memory admin (`POST .../memory/link-check`), a pass compares the 2,000
  most recently changed live records. It proposes a lead when two records share a contributor-tagged name, a source,
  or a topic plus another match (a second topic or a stated price, date or amount). Terms on more than a quarter of
  records are ignored, each record has at most 5 open leads, and a client or restricted record pairs only inside its
  scope. It uses only what GSAM stores; nothing goes to the engine. A pair already stated, superseded, in a conflict
  or already a lead in any state is never proposed again, so reruns are safe.
- **Review.** `GET .../memory/link-leads` lists leads whose two ends the caller may both read. The owner, or a
  reviewer with `memory:approve` on both scopes (Everest), confirms one (`.../link-leads/:id/confirm`, a type and
  reason), which writes a stated relationship with the reviewer as author and keeps the basis, or dismisses it. A
  delete closes the record's open leads and clears their terms. Table `memory_link_leads` (migration 0298).

## Steward daily review (GRE-887)

- One pass a day reads records changed since a durable cursor (`memory_steward_cursors`) and writes findings to the
  decision queue (`memory_steward_queue_items`): failed ingestion, duplicates (same content hash in one scope),
  stale material (unreviewed past 90/180 days, superseded past 1 year, unsynced past 24 hours) and possible
  contradictions (open `memory_conflicts`). Related findings share one open item with their sources, scope, the
  current approved position and a proposed resolution. The steward sees a content hash, never the content, and never
  approves, edits or deletes a record.
- **Routing:** pricing, policy, legal and client-commitment items, and client or restricted scopes, go to John.
  Agent scopes go to that agent, project scopes to the project lead; anything else goes to John.
- **Reliability:** each page of records commits with its queue writes and the cursor in one transaction, under the
  run's lease token. A killed pass loses only its uncommitted page; the next pass marks it `interrupted` once the
  lease (10 minutes) lapses and resumes from the cursor. Every escalation has a unique key (finding, record,
  version), so a rerun never escalates the same entry twice. A missed day needs nothing: the next pass catches up
  from the cursor. Two passes at once: the second gets `409 busy`.
- **Access:** a scoped, expiring grant (`memory_steward_grants`), sandbox only until G4. Grants can be made only on an
  instance with `GSAM_MEMORY_STEWARD_SANDBOX_GRANTS=true`, by a company owner or admin, for at most 30 days.
  Every pass, refusal, grant and revoke is written to `memory_operations`.
- **API** (memory must be on): `POST .../memory/steward/review` (the granted agent), `GET .../memory/steward/queue`,
  `GET .../memory/steward/report?days=7` (owner, admin or the granted steward; review time, plan tokens, missed days
  and queue age per Europe/London day), `POST .../memory/steward/grants` and `.../grants/:grantId/revoke` (owner or
  admin).
- **Routine** (created at G4 on the steward's own task, not before): a GSAM routine assigned to the steward agent,
  `concurrencyPolicy: coalesce_if_active`, `catchUpPolicy: skip_missed` (the cursor catches up), one schedule
  trigger `30 3 * * *` in `Europe/London` (after the 02:30 engine backup). The routine's task tells the agent to call
  `POST .../memory/steward/review` once and post the result and `GET .../steward/report?days=1` on the task.

## Back up and restore

- Nightly at 02:30 the timer runs `backup`: `pg_dump -Fc` to `backups/` plus a `.sha256`, and an **encrypted** copy
  to `C:\GreatstoneBackups\gs-memory\`. 14 dumps kept in each place. If the database is not running it skips.
- **The Windows copy is encrypted** (GRE-777 D2). `/mnt/c` is readable by every Linux user (agents included) and by
  Windows, so only `hindsight-<stamp>.dump.enc` goes there: AES-256 (`openssl enc -aes-256-cbc -pbkdf2`), encrypted
  on the Linux side before the copy. Its `.dump.enc.sha256` holds two lines: the checksum of the encrypted file and of
  the plain dump. A copy counts only when the encrypted checksum matches and a decrypt gives the plain checksum back;
  if not, `backup` fails and the local dump is kept. A plain `.dump` left in the folder from before D2 is encrypted
  by the next `backup`, then removed. `check` fails while any plain `.dump` is in the folder.
- **Deleted content leaves every backup within 90 days** (G1 decision 7, GRE-887). A delete removes the content from
  the engine and leaves a tombstone in GSAM, but older dumps still hold it until they expire. `backup` therefore
  removes any dump (and its `.sha256`) whose name stamp is older than `GS_MEMORY_BACKUP_MAX_AGE_DAYS` (default 90,
  values above 90 are capped at 90), in both places, whatever `GS_MEMORY_BACKUP_KEEP` says. It also does this on a
  night the database is down, so old dumps cannot outlive the limit because no new dump was made. In practice the
  14-dump rule removes them after about 14 days; 90 days is the hard ceiling.
- GSAM's own database backups also hold memory records until a delete clears them. They expire after
  `GSAM_DB_BACKUP_RETENTION_DAYS` (default 7). While memory is on, this must stay at 90 or less.
- Any other copy (a manual export) must follow the same 90-day rule. The drive copy does (see below).
- By hand: `sudo -u gsmemory .../gs-memory.sh backup`
- Restore test (throwaway cluster on a free port, removed after): `sudo -u gsmemory .../gs-memory.sh restore-test
  [dump | dump.enc | --windows | --external]`. No argument: the newest local dump. `--windows` / `--external`: the
  newest encrypted Windows or drive copy, decrypted into the throwaway folder and checked against its plain checksum
  first. `--external` stops if the drive is not mounted.
- Real restore: stop the engine, `dropdb`/`createdb hindsight -O hindsight` over the socket, `pg_restore --no-owner --role=hindsight`, start.
  From a Windows copy, first decrypt it into `backups/` (never onto `/mnt/c`):
  `openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:secrets/backup.key -in <copy>.dump.enc -out backups/<copy>.dump`
  and check it against the plain line of `<copy>.dump.enc.sha256`.

### External drive copy (GRE-935)

John chose an external drive for the off-disk copy (5 Oct 2026). The Windows copy is on the same physical disk.

- After the local dump, `backup` writes the same encrypted copy (`.dump.enc` and its two-line `.sha256`) to
  `GS_MEMORY_EXTERNAL_BACKUPS` (default `/mnt/gs-backup-drive/gs-memory-backup`) and checks it the same way: encrypted
  checksum, then a decrypt that gives the plain checksum back. No plain dump and no key go to the drive.
- It copies only when `GS_MEMORY_EXTERNAL_MOUNT` (default `/mnt/gs-backup-drive`) is a real mount point, so an empty
  folder left when the drive is unplugged never counts as a copy.
- **The drive never fails the backup.** Drive not mounted, or the copy fails: one `WARNING` line with the date of the
  last good drive copy, and the backup goes on (local dump and Windows copy as before).
- The date of the last good drive copy is written to `last-external-copy` in the Windows copy folder (a date and a
  file name, no data). `check` shows its age: `PASS` up to 7 days (`GS_MEMORY_EXTERNAL_MAX_AGE_DAYS`), `WARN` after
  that or when no copy is recorded. A `WARN` does not fail `check`. Run `check` as `gsmemory` (or with `sudo`) to see
  it; other users cannot read that folder when it is owned by `gsmemory`.
- **30 copies kept on the drive** (`GS_MEMORY_EXTERNAL_KEEP`). With the drive always plugged in that is a month of
  nights; with the drive plugged in once a week the 90-day rule removes them first. The 90-day rule applies to the
  drive too, on each night the drive is mounted.
- To restore on another PC you need the drive **and** the backup key from the password manager. Do not keep the key
  on the drive.

**John's setup (one time, in John's own terminal).** Agents do not change the PC.

1. Plug in the drive. In Windows, note its letter (below, `E:`). Format NTFS or exFAT; any size above 2 GB is enough.
2. Make the mount point, add it to `/etc/fstab` so WSL mounts it at start, and mount it now:
   ```sh
   sudo sh -c 'mkdir -p /mnt/gs-backup-drive && echo "E: /mnt/gs-backup-drive drvfs rw,noatime,nofail,uid=$(id -u gsmemory),gid=$(id -g gsmemory),umask=077 0 0" >> /etc/fstab && mount /mnt/gs-backup-drive'
   ```
   `uid`/`gid`/`umask=077` make the drive readable only by `gsmemory` inside WSL.
3. Prove it: `sudo -u gsmemory /home/gsmemory/gs-memory/app/setup/gs-memory.sh backup`, then
   `sudo ls -l /mnt/gs-backup-drive/gs-memory-backup/` shows a `.dump.enc` and its `.sha256`, and
   `sudo -u gsmemory .../gs-memory.sh restore-test --external` ends with `restore test passed`.
- Plugged in after WSL started: `sudo mount /mnt/gs-backup-drive`. Before unplugging: `sudo umount /mnt/gs-backup-drive`,
  then eject in Windows. A drive with a new letter: change `E:` in `/etc/fstab`.

### Backup key

- `install` (or the first `backup`) makes `secrets/backup.key`: 48 random bytes, base64, owner `gsmemory`, mode `600`,
  in `/home/gsmemory/gs-memory/secrets/` (mode `700`). It is never written to `/mnt/c` and never printed or logged.
  Agents (user `johnprempeh`) cannot read it.
- **John keeps a second copy off the PC** (password manager). Without it, a lost WSL disk means the Windows copies
  cannot be opened. One time, in John's own terminal: `sudo cat /home/gsmemory/gs-memory/secrets/backup.key`, paste
  it into the password manager, clear the screen. Never paste it into GSAM, an issue, a chat or a file on `/mnt/c`.
- Lost key on the PC: put the saved copy back as `secrets/backup.key` (owner `gsmemory`, mode `600`). `backup` stops
  with an error rather than make a new key while encrypted copies exist, because a new key cannot open them.
- Changing the key: move the old `.dump.enc` files out of the folder, delete `secrets/backup.key`, run `backup`, save
  the new key. Keep the old key until the old copies expire (90 days at most).

## Upgrade Hindsight

1. Change the pin in `scripts/gs-memory/requirements.in` (Delta reviews the version, GRE-648).
2. Regenerate the lock:
   `uv pip compile --generate-hashes --python-version 3.12 --python-platform x86_64-unknown-linux-gnu --index-url https://pypi.org/simple --extra-index-url https://download.pytorch.org/whl/cpu --index-strategy unsafe-best-match --no-header -o scripts/gs-memory/requirements.lock scripts/gs-memory/requirements.in`
3. Pull request, review, merge. Then back up, re-run `system-setup` (copies the new files) and `install`
   (rebuilds the venv because the lock hash changed), restart, run `check`.

## Sandbox test (no sudo)

The safety guards have a shell test with stubbed system commands (no PostgreSQL, no sudo, no PC change):
`bash scripts/gs-memory/gs-memory.test.sh`. It covers: an existing cluster or active `postgresql.service` stops
`system-setup`; the opt-in disables only the service and drops no cluster; a copy folder `gsmemory` cannot write
stops `system-setup`; a failed backup copy exits non-zero; `preflight` output; `link-claude` never prints the token;
the Windows copy is encrypted (no plain dump, no key there, an old plain copy is replaced); a lost key stops `backup`;
`restore-test --windows` restores the decrypted copy and refuses a wrong key or a changed copy; `check` fails on a plain
dump in the Windows folder; the drive copy is encrypted and verified when the drive is mounted, a missing or read-only
drive only warns and the backup exits 0, the drive keeps `GS_MEMORY_EXTERNAL_KEEP` copies, `restore-test --external`
restores the drive copy and refuses a changed one, and `check` warns when the last drive copy is older than 7 days.

For the full engine:

Every path and port is an environment variable, so the whole script runs as a normal user in a scratch folder:

```sh
S=$(mktemp -d); (cd "$S" && apt-get download postgresql-16 postgresql-16-pgvector postgresql-client-16 libpq5 && for d in *.deb; do dpkg -x "$d" pgroot; done)
export GS_MEMORY_USER=$(id -un) GS_MEMORY_ROOT=$S/root GS_MEMORY_PG_BIN=$S/pgroot/usr/lib/postgresql/16/bin \
  GS_MEMORY_PG_PORT=25432 GS_MEMORY_API_PORT=28888 GS_MEMORY_WINDOWS_BACKUPS=$S/win \
  LD_LIBRARY_PATH=$S/pgroot/usr/lib/x86_64-linux-gnu TMPDIR=$S GS_MEMORY_GATEWAY_ENV=$S/gsam/gs-memory/secrets/gateway.env
# Drive copy in a sandbox: '/' is a real mount point, so the copy runs into a scratch folder.
export GS_MEMORY_EXTERNAL_MOUNT=/ GS_MEMORY_EXTERNAL_BACKUPS=$S/drive/gs-memory-backup
mkdir -p $S/win && scripts/gs-memory/gs-memory.sh install && scripts/gs-memory/gs-memory.sh link-gateway
scripts/gs-memory/gs-memory.sh serve-postgres & sleep 3; scripts/gs-memory/gs-memory.sh serve-hindsight &
scripts/gs-memory/gs-memory.sh check
scripts/gs-memory/gs-memory.sh backup && scripts/gs-memory/gs-memory.sh restore-test
scripts/gs-memory/gs-memory.sh restore-test --windows
scripts/gs-memory/gs-memory.sh restore-test --external
```

Stop both processes and remove `$S` after.

## Known limits

- Ubuntu ships pgvector `0.6.0`. Hindsight works with it; the `hnsw.iterative_scan` tuning (pgvector 0.8+) is skipped.
- `/health`, `/version` and `/metrics` answer without a key (loopback only; bank ids are not in metrics).
- Agents run as the same Linux user as the GSAM server and can read `gateway.env`. See "Residual risk" above;
  must be closed before G4.
