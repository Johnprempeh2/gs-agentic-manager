# Nightly live backup

`live-backup.sh` backs up the live GSAM instance every night at 02:30 (GRE-1930). It replaces the old
`~/GSAM/nightly-backup.sh`, which copied only the database.

Each night it writes three things to `/mnt/c/Users/johnp/GSAM-backups` (the PC's internal SSD) and keeps the
newest 14 of each:

| File | What it holds | Encrypted |
| --- | --- | --- |
| `nightly-<stamp>.sql.gz` | the database (same dump as before) | no, as before |
| `files-<stamp>.tar.gz` (+ `.sha256`) | uploaded files: `~/GSAM/data/instances/default/data/storage` | no, like the dump |
| `secrets-<stamp>.tar.enc` (+ `.sha256`) | the secrets master key | yes, with the backup key |

A failed step does not stop the others: a stopped database still gets its files and key archived. The run
exits 1 and records the failed step.

Then it copies the newest of each to John's USB drive (see "Off-machine copy" below).

Every run writes `~/GSAM/data/instances/default/data/health/live-backup.json`. The server reads it and shows
the newest archive of each kind on `/api/health` under `liveBackup`. There is a warning when one is missing or
more than 30 hours old, or when the last run had a failure. `liveBackup.offsite` shows the last good copy on the
USB drive; there is a warning when there is none in the last 48 hours.

## Off-machine copy (USB drive)

After the local backup, the run copies the newest dump, files archive and key archive to
`/mnt/d/GSAM-offsite` (`D:\GSAM-offsite`, the Seagate Portable USB drive) and keeps the newest 14 of each there.

| On the drive | From |
| --- | --- |
| `nightly-<stamp>.sql.gz.enc` (+ `.sha256`) | the dump, encrypted with the backup key |
| `files-<stamp>.tar.gz.enc` (+ `.sha256`) | the files archive, encrypted with the backup key |
| `secrets-<stamp>.tar.enc` (+ `.sha256`) | the key archive as it is (already encrypted) |

- The dump and the files archive hold client data, so they leave the PC only encrypted. Without the backup
  key, nothing on the drive can be read. Keep the backup key in the password manager, not on the drive.
- A copy counts only after it is read back from the drive (and decrypted) to the same bytes as the source.
  A copy that is already there is not copied again.
- The run writes only into a folder that holds the marker file `.gsam-offsite`. `install` makes it. An
  unplugged drive can leave an empty `/mnt/d` behind, and a copy there would be on this PC's own disk.
- If Windows gives the drive another letter, the run finds the marked folder under `/mnt/<letter>/`.
- **Drive not there:** the local backup still counts and the run still exits 0. The log says
  `OFFSITE COPY FAILED: ...`, and `OFFSITE-COPY-FAILED.txt` appears in `C:\Users\johnp\GSAM-backups` with
  the reason. Both go away after the next good copy. `/api/health` warns after 48 hours without one.
- **WSL sees drives only when it starts.** A drive plugged in later does not show in `/mnt/d`. Mount it
  (asks for your Ubuntu password; GSAM keeps running):
  `sudo mkdir -p /mnt/d && sudo mount -t drvfs D: /mnt/d -o uid=$(id -u),gid=$(id -g)`.
  Restarting WSL (`wsl --shutdown`) also works, but it stops GSAM too.
- To turn the copy off: `LIVE_BACKUP_OFFSITE_DIR=off` in the cron line. Health then warns, because there is
  no off-machine copy.

Disk space: each night adds about 2 GB (the files archive and the dump). 14 nights need about 28 GB on the drive.

## Install (John, once, by hand)

After the pull request is merged and the dev checkout is on `main`:

```sh
bash ~/Desktop/Code/gs-clip/scripts/live-backup/live-backup.sh install
```

This copies the script to `~/GSAM/nightly-backup.sh`. Cron already runs that file, so the crontab does not
change. It keeps the old script as `~/GSAM/nightly-backup.sh.before-GRE-1930` and makes the backup key if
there is none. With the USB drive plugged in, it makes `D:\GSAM-offsite` and its marker file; without it, it
prints a warning (plug the drive in and run install again). Run it again after a later change to the script. To run a backup now instead of waiting for 02:30:
`~/GSAM/nightly-backup.sh` (log: `~/GSAM/logs/nightly-backup.log`).

To go back: `cp ~/GSAM/nightly-backup.sh.before-GRE-1930 ~/GSAM/nightly-backup.sh`.

## Backup key

The master key decrypts the secret values in the database dump. It must never sit in plain text beside the
dump, so its archive is encrypted with a second key, the **backup key**:

- It lives at `~/.config/gsam-live-backup/backup.key` (mode 600) on the Linux side. It is never in the
  backup folder.
- `install` makes it once. A run never replaces it. With encrypted archives present and no key, the run
  refuses to make a new one and tells you to put the saved copy back.
- **Keep a copy off this PC.** If the Linux disk is lost, the backup key goes with it, and the encrypted
  master-key archives cannot be opened. Without the master key, every stored secret has to be entered again.
  After install, run `cat ~/.config/gsam-live-backup/backup.key` and save the line in your password manager
  as "GSAM live backup key". Do not paste it into an issue, a chat or an email.

Same cipher as the gs-memory backup (GRE-931): `openssl enc -aes-256-cbc -pbkdf2 -iter 200000`.

## Restore

Stop the server before you restore into a live instance. Both commands refuse to overwrite.

```sh
# uploaded files into <instance>/data/storage; files already there are kept
live-backup.sh restore-files /mnt/c/Users/johnp/GSAM-backups/files-<stamp>.tar.gz ~/GSAM/data/instances/default
# master key (needs the backup key at ~/.config/gsam-live-backup/backup.key)
live-backup.sh restore-key /mnt/c/Users/johnp/GSAM-backups/secrets-<stamp>.tar.enc ~/GSAM/data/instances/default/secrets/master.key
```

To restore the database dump, use the normal restore for `.sql.gz` backups (`runDatabaseRestore` in `packages/db`).

From the USB drive copy (when this PC's disks are lost): put the saved backup key back at
`~/.config/gsam-live-backup/backup.key` (mode 600) first, then:

```sh
# uploaded files, straight from the encrypted drive copy
live-backup.sh restore-files /mnt/d/GSAM-offsite/files-<stamp>.tar.gz.enc ~/GSAM/data/instances/default
# master key: the drive holds the same encrypted archive
live-backup.sh restore-key /mnt/d/GSAM-offsite/secrets-<stamp>.tar.enc ~/GSAM/data/instances/default/secrets/master.key
# database: decrypt to a plain .sql.gz (mode 600), then restore it as above
live-backup.sh decrypt /mnt/d/GSAM-offsite/nightly-<stamp>.sql.gz.enc ~/restore/nightly-<stamp>.sql.gz
```

## Disk space

Each files archive is about the size of the storage folder (1.6 GB on 22 Oct 2026; most uploads are already
compressed). 14 of them need about 23 GB on C:.

## Tests

```sh
bash scripts/live-backup/live-backup.test.sh
```

The test uses synthetic data in a temp folder only: a fake GSAM home, a fake master key and a stub database dump.
