# gs-memory.sh

Sets up, runs, backs up and checks the organisation memory engine (Hindsight on its own PostgreSQL). The install
runbook for a real machine is kept outside the public repo. This page has the rules the script enforces and the
sandbox test.

## Backups

- `backup` writes `pg_dump -Fc` to `backups/` plus a `.sha256`, and an **encrypted** copy (`.dump.enc`, AES-256,
  `openssl enc -aes-256-cbc -pbkdf2`) to the copy folder `GS_MEMORY_WINDOWS_BACKUPS`. A plain dump never goes there.
  A copy counts only when the encrypted checksum matches and a decrypt gives the plain checksum back; if not,
  `backup` fails and the local dump is kept. `check` fails while any plain `.dump` is in the copy folder.
- **Deleted content leaves every backup within 90 days** (G1 decision 7, GRE-887). A delete removes the content from
  the engine and leaves a tombstone in GSAM, but older dumps still hold it until they expire. `backup` therefore
  removes any dump (and its `.sha256`) whose name stamp is older than `GS_MEMORY_BACKUP_MAX_AGE_DAYS` (default 90,
  values above 90 are capped at 90), in every copy, whatever `GS_MEMORY_BACKUP_KEEP` says. It also does this on a
  night the database is down. In practice the 14-dump rule removes them after about 14 days; 90 days is the hard
  ceiling.
- GSAM's own database backups also hold memory records until a delete clears them. They expire after
  `GSAM_DB_BACKUP_RETENTION_DAYS` (default 7). While memory is on, this must stay at 90 or less.
- Any other copy (a manual export, the drive copy) must follow the same 90-day rule.

## Copy folder

`system-setup` checks that the engine user can write the copy folder and stops with an error if not. The nightly
`backup` fails (non-zero exit) if the folder is missing, the copy fails or the copy's checksum does not match; the
local dump is kept.

## Backup key

- `install` (or the first `backup`) makes `secrets/backup.key`: 48 random bytes, base64, mode `600`, in a `700`
  folder owned by the engine user. It is never written to the copy folder and never printed or logged.
- The owner keeps a second copy off the machine (a password manager). Without it, the encrypted copies cannot be
  opened after a lost disk.
- Lost key on the machine: put the saved copy back as `secrets/backup.key` (engine user, mode `600`). `backup` stops
  with an error rather than make a new key while encrypted copies exist, because a new key cannot open them.
- Changing the key: move the old `.dump.enc` files out of the folder, delete `secrets/backup.key`, run `backup`, save
  the new key. Keep the old key until the old copies expire (90 days at most).

## Sandbox test (no sudo)

The safety guards have a shell test with stubbed system commands (no PostgreSQL, no sudo, no machine change):
`bash scripts/gs-memory/gs-memory.test.sh`.

For the full engine, every path and port is an environment variable, so the whole script runs as a normal user in a
scratch folder:

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
