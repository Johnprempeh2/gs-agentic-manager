#!/usr/bin/env bash
# Shell test for live-backup.sh (GRE-1930, GRE-1950). Synthetic data only: a fake GSAM home in a temp folder, a
# fake master key, a database dump stub and a fake USB drive folder. Nothing under ~/GSAM, no live database,
# no /mnt/c or /mnt/d.
# Run: bash scripts/live-backup/live-backup.test.sh
set -uo pipefail
unset BASH_ENV

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/live-backup.sh"
T="$(mktemp -d "${GSAM_RUN_SCRATCH_DIR:-${TMPDIR:-/tmp}}/live-backup-test.XXXXXX")"
trap 'chmod -R u+w "$T" 2>/dev/null; rm -rf "$T"' EXIT
failures=0
pass() { printf 'ok   %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*"; failures=$((failures + 1)); }
check() { local name="$1"; shift; if "$@"; then pass "$name"; else fail "$name"; fi; }

# The real greatstone-common.sh (so the paths are the real layout under GSAM_ROOT), with the two database
# helpers replaced. The dump stub runs inside `bash -c` like the real one, so it must stand alone.
COMMON="$T/common.sh"
cat > "$COMMON" <<EOF
. "$HERE/../greatstone-common.sh"
live_database_url() { [[ "\${STUB_DB_DOWN:-0}" == 1 ]] && return 1; printf 'postgres://paperclip@127.0.0.1:1/paperclip\n'; }
live_database_password() { printf 'synthetic-db-password\n'; }
gs_tools_installed() { return 0; }
gs_db() {
  local dir="" prefix=""
  while [[ \$# -gt 0 ]]; do case "\$1" in --dir) dir="\$2"; shift;; --prefix) prefix="\$2"; shift;; esac; shift; done
  printf '%s\n' "\${PGPASSWORD:-none}" > "\$dir/../pgpassword-seen"
  local f="\$dir/\$prefix-\$(date +%Y%m%d-%H%M%S).sql.gz"
  printf 'synthetic dump\n' | gzip > "\$f"
  printf 'progress line\n%s\n' "\$f"
}
EOF

BIN="$T/bin"; mkdir -p "$BIN"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "${STUB_CRONTAB:-}"\n' > "$BIN/crontab"; chmod +x "$BIN/crontab"

KEY_TEXT="synthetic-master-key-0123456789abcdef"
fresh() {
  CASE="$T/case-$1"
  export GSAM_ROOT="$CASE/GSAM" LIVE_BACKUP_COMMON="$COMMON" LIVE_BACKUP_DEST="$CASE/win/GSAM-backups" \
    LIVE_BACKUP_KEY_FILE="$CASE/home/.config/gsam-live-backup/backup.key" LIVE_BACKUP_LOG="-" PATH="$BIN:$PATH" \
    LIVE_BACKUP_OFFSITE_DIR="$CASE/mnt/d/GSAM-offsite" LIVE_BACKUP_OFFSITE_SEARCH="$CASE/mnt"
  unset LIVE_BACKUP_KEEP STUB_DB_DOWN STUB_CRONTAB
  # The USB drive, plugged in and marked by install.
  OFFSITE="$LIVE_BACKUP_OFFSITE_DIR"
  mkdir -p "$OFFSITE" && printf 'marked\n' > "$OFFSITE/.gsam-offsite"
  INST="$GSAM_ROOT/data/instances/default"
  mkdir -p "$INST/data/storage/company-1/assets" "$INST/secrets" "$CASE/win"
  printf 'synthetic image bytes\n' > "$INST/data/storage/company-1/assets/logo.png"
  printf '# Synthetic document\n' > "$INST/data/storage/company-1/assets/brief.md"
  (umask 077; printf '%s\n' "$KEY_TEXT" > "$INST/secrets/master.key")
  STATE="$INST/data/health/live-backup.json"
}
newest() { ls -1 "$LIVE_BACKUP_DEST"/$1 2>/dev/null | sort | tail -1; }
count() { ls -1 "$LIVE_BACKUP_DEST"/$1 2>/dev/null | wc -l | tr -d ' '; }
on_drive() { ls -1 "${2:-$OFFSITE}"/$1 2>/dev/null | wc -l | tr -d ' '; }
state() { node -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(eval(process.argv[2]))' "$STATE" "$1"; }
decrypt_key() { openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$LIVE_BACKUP_KEY_FILE" < "$1" | tar -xOf - master.key; }

# --- 1. a full run: dump, files archive, encrypted key archive, state ---------------------------------
fresh full
out="$("$SCRIPT" run 2>&1)"; rc=$?
check "full run exits 0 ($rc)" test "$rc" = 0
check "full run: database dump written" test -s "$(newest 'nightly-*.sql.gz')"
files="$(newest 'files-*.tar.gz')"; keyarc="$(newest 'secrets-*.tar.enc')"
check "full run: files archive written with a checksum" test -s "$files" -a -s "$files.sha256"
check "full run: files archive holds the uploaded file" bash -c "tar -tzf '$files' | grep -qx 'storage/company-1/assets/logo.png'"
check "full run: key archive written with a checksum" test -s "$keyarc" -a -s "$keyarc.sha256"
check "full run: key archive decrypts to the same key" test "$(decrypt_key "$keyarc")" = "$KEY_TEXT"
check "full run: no plain master key anywhere in the backup folder" bash -c "! grep -rqF '$KEY_TEXT' '$LIVE_BACKUP_DEST' && ! find '$LIVE_BACKUP_DEST' -name 'master.key*' | grep -q ."
check "full run: no part files left" bash -c "! ls -A '$LIVE_BACKUP_DEST' | grep -q '\.part$'"
check "full run: backup key made, mode 600, outside the backup folder" bash -c "[[ \$(stat -c %a '$LIVE_BACKUP_KEY_FILE') == 600 && '$LIVE_BACKUP_KEY_FILE' != '$LIVE_BACKUP_DEST'/* ]]"
check "full run: the dump got the database password in the environment" test "$(cat "$CASE/win/pgpassword-seen")" = synthetic-db-password
check "full run: the password is not in the output" bash -c "! grep -q synthetic-db-password <<<'$out'"
check "full run: state says ok and names the folder" node -e '
  const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  process.exit(s.ok === true && s.failure === null && s.backupDir === process.argv[2] && s.offsite.status === "ok" ? 0 : 1);
' "$STATE" "$LIVE_BACKUP_DEST"

# --- 1b. the instance config.json moves the key and the storage folder -------------------------------
fresh moved
mkdir -p "$CASE/elsewhere/storage/company-2" "$CASE/elsewhere/keys"
printf 'moved upload\n' > "$CASE/elsewhere/storage/company-2/moved.txt"
(umask 077; printf 'moved-key-material\n' > "$CASE/elsewhere/keys/instance.key")
printf '{"secrets":{"localEncrypted":{"keyFilePath":"%s"}},"storage":{"localDisk":{"baseDir":"%s"}}}\n' \
  "$CASE/elsewhere/keys/instance.key" "$CASE/elsewhere/uploads" > "$INST/config.json"
mv "$CASE/elsewhere/storage" "$CASE/elsewhere/uploads"
"$SCRIPT" run >/dev/null 2>&1; rc=$?
check "moved paths: run exits 0 ($rc)" test "$rc" = 0
check "moved paths: files archive holds the configured folder, as storage/" bash -c "tar -tzf '$(newest 'files-*.tar.gz')' | grep -qx 'storage/company-2/moved.txt'"
check "moved paths: key archive holds the configured key, as master.key" test "$(decrypt_key "$(newest 'secrets-*.tar.enc')")" = moved-key-material

# --- 2. database down: files and key are still archived, the run fails ---------------------------------
fresh dbdown
export STUB_DB_DOWN=1
out="$("$SCRIPT" run 2>&1)"; rc=$?
check "database down: exits 1" test "$rc" = 1
check "database down: no dump" test "$(count 'nightly-*.sql.gz')" = 0
check "database down: files and key archives still written" test -s "$(newest 'files-*.tar.gz')" -a -s "$(newest 'secrets-*.tar.enc')"
check "database down: state records the failed step" node -e '
  const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  process.exit(s.ok === false && s.failure === "failed: database dump" ? 0 : 1);
' "$STATE"

# --- 3. keep 14 of each kind -----------------------------------------------------------------------------
fresh prune
mkdir -p "$LIVE_BACKUP_DEST"
for d in $(seq -w 1 16); do
  for f in "nightly-202601$d-023000.sql.gz" "files-202601$d-023000.tar.gz" "secrets-202601$d-023000.tar.enc"; do
    printf 'old\n' > "$LIVE_BACKUP_DEST/$f"
  done
done
# Encrypted archives exist, so the run will not make a new key; give it one.
mkdir -p "$(dirname "$LIVE_BACKUP_KEY_FILE")"; (umask 077; openssl rand -base64 48 > "$LIVE_BACKUP_KEY_FILE")
"$SCRIPT" run >/dev/null 2>&1
check "prune: 14 dumps kept" test "$(count 'nightly-*.sql.gz')" = 14
check "prune: 14 files archives kept" test "$(count 'files-*.tar.gz')" = 14
check "prune: 14 key archives kept" test "$(count 'secrets-*.tar.enc')" = 14
check "prune: the oldest went, the new one stayed" bash -c "[[ ! -e '$LIVE_BACKUP_DEST/files-20260101-023000.tar.gz' && -e '$(newest 'files-2026*.tar.gz')' ]]"

# --- 4. lost backup key with encrypted archives: no new key, other steps still run ------------------------
fresh lostkey
"$SCRIPT" run >/dev/null 2>&1
rm -f "$LIVE_BACKUP_KEY_FILE"
sleep 1
out="$("$SCRIPT" run 2>&1)"; rc=$?
check "lost key: exits 1" test "$rc" = 1
check "lost key: no new key made" test ! -e "$LIVE_BACKUP_KEY_FILE"
check "lost key: it says to put the saved key back" bash -c "grep -q 'Put the saved key back' <<<'$out'"
check "lost key: the dump and files archive still ran" test "$(count 'files-*.tar.gz')" = 2 -a "$(count 'nightly-*.sql.gz')" = 2

# --- 5. backup folder cannot be written -------------------------------------------------------------------
fresh nodest
mkdir -p "$LIVE_BACKUP_DEST"; chmod 500 "$LIVE_BACKUP_DEST"
if [[ -w "$LIVE_BACKUP_DEST" ]]; then
  pass "backup folder not writable: skipped (running as root)"
else
  "$SCRIPT" run >/dev/null 2>&1; rc=$?
  check "backup folder not writable: exits 1" test "$rc" = 1
  check "backup folder not writable: state records it" bash -c "grep -q 'cannot write the backup folder' '$STATE'"
fi
chmod 700 "$LIVE_BACKUP_DEST"

# --- 6. one run at a time ---------------------------------------------------------------------------------
fresh lock
mkdir -p "$INST/data/health"
exec 8>"$INST/data/health/live-backup.lock"; flock -n 8
out="$("$SCRIPT" run 2>&1)"; rc=$?
exec 8>&-
check "second run while one runs: exits 0 and skips" bash -c "[[ $rc == 0 ]] && grep -q 'another backup is running' <<<'$out'"
check "second run while one runs: wrote nothing" test "$(count '*')" = 0

# --- 7. restore files and key into an empty instance ------------------------------------------------------
fresh restore
"$SCRIPT" run >/dev/null 2>&1
files="$(newest 'files-*.tar.gz')"; keyarc="$(newest 'secrets-*.tar.enc')"
target="$CASE/restored/instances/default"
"$SCRIPT" restore-files "$files" "$target" >/dev/null 2>&1
check "restore-files: the image comes back byte for byte" cmp -s "$INST/data/storage/company-1/assets/logo.png" "$target/data/storage/company-1/assets/logo.png"
check "restore-files: the document comes back byte for byte" cmp -s "$INST/data/storage/company-1/assets/brief.md" "$target/data/storage/company-1/assets/brief.md"
printf 'newer local file\n' > "$target/data/storage/company-1/assets/logo.png"
"$SCRIPT" restore-files "$files" "$target" >/dev/null 2>&1
check "restore-files: an existing file is not overwritten" test "$(cat "$target/data/storage/company-1/assets/logo.png")" = "newer local file"
"$SCRIPT" restore-key "$keyarc" "$target/secrets/master.key" >/dev/null 2>&1; rc=$?
check "restore-key: exits 0 ($rc)" test "$rc" = 0
check "restore-key: same key bytes, mode 600" bash -c "cmp -s '$INST/secrets/master.key' '$target/secrets/master.key' && [[ \$(stat -c %a '$target/secrets/master.key') == 600 ]]"
printf 'other key\n' > "$CASE/other.key"
"$SCRIPT" restore-key "$keyarc" "$CASE/other.key" >/dev/null 2>&1; rc=$?
check "restore-key: refuses to replace a different key" bash -c "[[ $rc != 0 && \$(cat '$CASE/other.key') == 'other key' ]]"
printf 'wrong backup key\n' > "$CASE/wrong.key"
LIVE_BACKUP_KEY_FILE="$CASE/wrong.key" "$SCRIPT" restore-key "$keyarc" "$CASE/fresh.key" >/dev/null 2>&1; rc=$?
check "restore-key: a wrong backup key fails and writes nothing" bash -c "[[ $rc != 0 && ! -e '$CASE/fresh.key' ]] && ! ls -A '$CASE' | grep -q '^\.restore-key'"

# --- 8. install: copy to ~/GSAM/nightly-backup.sh, keep the old one, make the key -------------------------
fresh install
printf '#!/bin/bash\necho old\n' > "$GSAM_ROOT/nightly-backup.sh"
export STUB_CRONTAB="30 2 * * * $GSAM_ROOT/nightly-backup.sh"
out="$("$SCRIPT" install 2>&1)"; rc=$?
check "install: exits 0 ($rc)" test "$rc" = 0
check "install: the repo script is now ~/GSAM/nightly-backup.sh" cmp -s "$SCRIPT" "$GSAM_ROOT/nightly-backup.sh"
check "install: the old script is kept" bash -c "grep -q 'echo old' '$GSAM_ROOT/nightly-backup.sh.before-GRE-1930'"
check "install: backup key made" test -s "$LIVE_BACKUP_KEY_FILE"
check "install: cron entry found, no warning" bash -c "! grep -q WARNING <<<'$out'"
before="$(cat "$LIVE_BACKUP_KEY_FILE")"
"$SCRIPT" install >/dev/null 2>&1
check "install again: the key is not replaced, the saved old script is not overwritten" bash -c "[[ \$(cat '$LIVE_BACKUP_KEY_FILE') == '$before' ]] && grep -q 'echo old' '$GSAM_ROOT/nightly-backup.sh.before-GRE-1930'"
# The installed copy finds greatstone-common.sh through LIVE_BACKUP_COMMON and runs.
out="$("$GSAM_ROOT/nightly-backup.sh" run 2>&1)"; rc=$?
check "installed copy: a run works ($rc)" test "$rc" = 0
export STUB_CRONTAB=""
out="$("$SCRIPT" install 2>&1)"
check "install with no cron entry: it warns" bash -c "grep -q 'WARNING: no cron entry' <<<'$out'"
out="$("$GSAM_ROOT/nightly-backup.sh" install 2>&1)"; rc=$?
check "install from the installed copy: refused" test "$rc" != 0

# --- 9. off-machine copy: the newest set goes to the drive, encrypted ------------------------------------------
fresh offsite
out="$("$SCRIPT" run 2>&1)"; rc=$?
check "offsite: run exits 0 ($rc)" test "$rc" = 0
dump="$(newest 'nightly-*.sql.gz')"; files="$(newest 'files-*.tar.gz')"; keyarc="$(newest 'secrets-*.tar.enc')"
check "offsite: the dump is on the drive, encrypted, with a checksum" test -s "$OFFSITE/$(basename "$dump").enc" -a -s "$OFFSITE/$(basename "$dump").enc.sha256"
check "offsite: the files archive is on the drive, encrypted, with a checksum" test -s "$OFFSITE/$(basename "$files").enc" -a -s "$OFFSITE/$(basename "$files").enc.sha256"
check "offsite: the key archive is on the drive as it is" cmp -s "$keyarc" "$OFFSITE/$(basename "$keyarc")"
check "offsite: no plain dump or files archive on the drive" test "$(on_drive '*.sql.gz')" = 0 -a "$(on_drive '*.tar.gz')" = 0
check "offsite: the drive copies are not readable without the key" bash -c "! gzip -t '$OFFSITE/$(basename "$dump").enc' 2>/dev/null && ! gzip -t '$OFFSITE/$(basename "$files").enc' 2>/dev/null"
check "offsite: no part files left on the drive" bash -c "! ls -A '$OFFSITE' | grep -q '\.part$'"
check "offsite: state says ok, with the folder and the copy time" test "$(state 's.offsite.status + "|" + s.offsite.dir + "|" + (s.offsite.failure === null) + "|" + /^20..-..-..T..:..:..Z$/.test(s.offsite.lastCopyAt)')" = "ok|$OFFSITE|true|true"
check "offsite: no failure note" test ! -e "$LIVE_BACKUP_DEST/OFFSITE-COPY-FAILED.txt"
check "offsite: the log says the copy finished" bash -c "grep -q 'off-machine copy finished' <<<'$out'"
# Database down on the next night: the same dump is still the newest, and it is not copied again.
sleep 1
out="$(STUB_DB_DOWN=1 "$SCRIPT" run 2>&1)"
check "offsite run again: a copy already on the drive is kept, not copied again" bash -c "grep -q \"$(basename "$dump").enc already on the drive\" <<<'$out' && [[ $(on_drive 'nightly-*.sql.gz.enc') == 1 ]]"
check "offsite run again: the new files archive is copied" test "$(on_drive 'files-*.tar.gz.enc')" = 2

# --- 10. the drive is unplugged: the local backup still counts, the failure is clear ---------------------------
lastok="$(state 's.offsite.lastCopyAt')"
mv "$CASE/mnt/d" "$CASE/unplugged"
sleep 1
out="$("$SCRIPT" run 2>&1)"; rc=$?
check "drive unplugged: run exits 0 ($rc)" test "$rc" = 0
check "drive unplugged: the local backup ran" test "$(count 'files-*.tar.gz')" = 3
check "drive unplugged: the log says OFFSITE COPY FAILED" bash -c "grep -q 'OFFSITE COPY FAILED: USB drive not found' <<<'$out'"
check "drive unplugged: a failure note in the backup folder" bash -c "grep -q 'USB drive not found' '$LIVE_BACKUP_DEST/OFFSITE-COPY-FAILED.txt'"
check "drive unplugged: state says local ok, offsite failed, last good copy kept" test "$(state 's.ok + "|" + s.offsite.status + "|" + s.offsite.lastCopyAt + "|" + /USB drive not found/.test(s.offsite.failure)')" = "true|failed|$lastok|true"

# --- 11. an empty mount folder (no marker) is not the drive --------------------------------------------------
mkdir -p "$OFFSITE"
"$SCRIPT" run >/dev/null 2>&1
check "unmarked folder: nothing written there" test "$(ls -A "$OFFSITE" | wc -l | tr -d ' ')" = 0
check "unmarked folder: state says failed" test "$(state 's.offsite.status')" = failed
rmdir "$OFFSITE" "$CASE/mnt/d"

# --- 12. the drive comes back under another letter ------------------------------------------------------------
mv "$CASE/unplugged" "$CASE/mnt/e"
out="$("$SCRIPT" run 2>&1)"; rc=$?
check "other letter: run exits 0 ($rc)" test "$rc" = 0
check "other letter: the newest set is copied there" test -s "$CASE/mnt/e/GSAM-offsite/$(basename "$(newest 'files-*.tar.gz')").enc"
check "other letter: state names the new folder, says ok" test "$(state 's.offsite.status + "|" + s.offsite.dir')" = "ok|$CASE/mnt/e/GSAM-offsite"
check "other letter: the failure note is gone" test ! -e "$LIVE_BACKUP_DEST/OFFSITE-COPY-FAILED.txt"

# --- 13. a copy that cannot be written fails, leaves no part file and keeps the last good time -----------------
fresh offsite-readonly
"$SCRIPT" run >/dev/null 2>&1
lastok="$(state 's.offsite.lastCopyAt')"
sleep 1
chmod 500 "$OFFSITE"
if [[ -w "$OFFSITE" ]]; then
  pass "drive read-only: skipped (running as root)"
else
  "$SCRIPT" run >/dev/null 2>&1; rc=$?
  check "drive read-only: run exits 0 ($rc)" test "$rc" = 0
  check "drive read-only: state says failed, names the files, keeps the last good time" test "$(state 's.offsite.status + "|" + /copy to .* failed: nightly-.*\.sql\.gz\.enc, files-.*\.tar\.gz\.enc, secrets-.*\.tar\.enc/.test(s.offsite.failure) + "|" + s.offsite.lastCopyAt')" = "failed|true|$lastok"
fi
chmod 700 "$OFFSITE"

# --- 14. keep 14 of each kind on the drive -------------------------------------------------------------------
fresh offsite-prune
for d in $(seq -w 1 16); do
  for f in "nightly-202601$d-023000.sql.gz.enc" "files-202601$d-023000.tar.gz.enc" "secrets-202601$d-023000.tar.enc"; do
    printf 'old\n' > "$OFFSITE/$f"; printf 'old\n' > "$OFFSITE/$f.sha256"
  done
done
"$SCRIPT" run >/dev/null 2>&1
check "drive prune: 14 of each kind kept" test "$(on_drive 'nightly-*.sql.gz.enc')$(on_drive 'files-*.tar.gz.enc')$(on_drive 'secrets-*.tar.enc')" = 141414
check "drive prune: the oldest went with its checksum, the new one stayed" bash -c "[[ ! -e '$OFFSITE/files-20260101-023000.tar.gz.enc' && ! -e '$OFFSITE/files-20260101-023000.tar.gz.enc.sha256' && -e '$OFFSITE/$(basename "$(newest 'files-*.tar.gz')").enc' ]]"

# --- 15. restore from the drive copy only -----------------------------------------------------------------
fresh offsite-restore
"$SCRIPT" run >/dev/null 2>&1
dump="$(newest 'nightly-*.sql.gz')"
target="$CASE/restored/instances/default"
"$SCRIPT" restore-files "$(ls -1 "$OFFSITE"/files-*.tar.gz.enc)" "$target" >/dev/null 2>&1; rc=$?
check "restore from drive: files exits 0 ($rc)" test "$rc" = 0
check "restore from drive: the image comes back byte for byte" cmp -s "$INST/data/storage/company-1/assets/logo.png" "$target/data/storage/company-1/assets/logo.png"
check "restore from drive: the document comes back byte for byte" cmp -s "$INST/data/storage/company-1/assets/brief.md" "$target/data/storage/company-1/assets/brief.md"
"$SCRIPT" restore-key "$(ls -1 "$OFFSITE"/secrets-*.tar.enc)" "$target/secrets/master.key" >/dev/null 2>&1
check "restore from drive: same master key" cmp -s "$INST/secrets/master.key" "$target/secrets/master.key"
"$SCRIPT" decrypt "$(ls -1 "$OFFSITE"/nightly-*.sql.gz.enc)" "$CASE/restored/dump.sql.gz" >/dev/null 2>&1; rc=$?
check "restore from drive: the dump decrypts to the same bytes, mode 600" bash -c "[[ $rc == 0 ]] && cmp -s '$dump' '$CASE/restored/dump.sql.gz' && [[ \$(stat -c %a '$CASE/restored/dump.sql.gz') == 600 ]]"
"$SCRIPT" decrypt "$(ls -1 "$OFFSITE"/nightly-*.sql.gz.enc)" "$CASE/restored/dump.sql.gz" >/dev/null 2>&1; rc=$?
check "decrypt: refuses to overwrite" test "$rc" != 0
LIVE_BACKUP_KEY_FILE="$CASE/wrong.key" bash -c "printf 'wrong\n' > '$CASE/wrong.key'; '$SCRIPT' decrypt '$(ls -1 "$OFFSITE"/nightly-*.sql.gz.enc)' '$CASE/wrong.sql.gz'" >/dev/null 2>&1; rc=$?
check "decrypt: a wrong backup key fails and writes nothing" bash -c "[[ $rc != 0 && ! -e '$CASE/wrong.sql.gz' && ! -e '$CASE/wrong.sql.gz.part' ]]"
LIVE_BACKUP_KEY_FILE="$CASE/wrong.key" "$SCRIPT" restore-files "$(ls -1 "$OFFSITE"/files-*.tar.gz.enc)" "$CASE/wrong-target" >/dev/null 2>&1; rc=$?
check "restore-files from drive: a wrong backup key fails" bash -c "[[ $rc != 0 ]] && ! find '$CASE/wrong-target' -type f 2>/dev/null | grep -q ."

# --- 16. turned off -----------------------------------------------------------------------------------------
fresh offsite-off
export LIVE_BACKUP_OFFSITE_DIR=off
"$SCRIPT" run >/dev/null 2>&1; rc=$?
check "offsite off: run exits 0, state says off, nothing on the drive" bash -c "[[ $rc == 0 && \$(ls -A '$OFFSITE' | grep -vc '^.gsam-offsite\$') == 0 ]]" 
check "offsite off: state says off" test "$(state 's.offsite.status')" = off

# --- 17. install marks the drive folder ------------------------------------------------------------------------
fresh offsite-install
rm -rf "$OFFSITE"
export STUB_CRONTAB="30 2 * * * $GSAM_ROOT/nightly-backup.sh"
out="$("$SCRIPT" install 2>&1)"; rc=$?
check "install: marks the drive folder" bash -c "[[ $rc == 0 && -f '$OFFSITE/.gsam-offsite' ]] && grep -q 'off-machine folder marked' <<<'$out'"
rm -rf "$CASE/mnt/d"
"$SCRIPT" install > "$CASE/install.out" 2>&1; rc=$?
check "install with no drive: exits 0 and warns" bash -c "[[ $rc == 0 ]] && grep -q 'WARNING: USB drive not found' '$CASE/install.out' && [[ ! -e '$OFFSITE' ]]"

echo
if (( failures )); then echo "$failures FAILED"; exit 1; fi
echo "all passed"
