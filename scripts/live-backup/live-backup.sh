#!/usr/bin/env bash
# Nightly backup of the live GSAM instance (GRE-1930). Cron: 30 2 * * *, as the user that runs GSAM.
#
#   live-backup.sh [run]                   database dump, uploaded files archive and encrypted secrets key
#                                          archive, side by side in LIVE_BACKUP_DEST. Keeps the newest 14 of each.
#                                          Then copies the newest of each, encrypted, to the USB drive (GRE-1950).
#   live-backup.sh install                 copies this script to ~/GSAM/nightly-backup.sh (the cron entry stays
#                                          the same), makes the backup key if there is none, and marks the
#                                          off-machine folder on the USB drive. Run it from the repo.
#   live-backup.sh restore-files <archive> <instance dir>
#                                          unpacks a files-*.tar.gz (or the drive's files-*.tar.gz.enc) into
#                                          <instance dir>/data/storage. Never overwrites a file that is already there.
#   live-backup.sh restore-key <archive> <key file>
#                                          decrypts a secrets-*.tar.enc with the backup key and writes the master
#                                          key to <key file> (mode 600). Stops if <key file> exists with other bytes.
#   live-backup.sh decrypt <file.enc> <out file>
#                                          decrypts a drive copy (nightly-*.sql.gz.enc) with the backup key.
#
# The secrets master key unlocks the secret values in the database dump, so it is never written in plain text
# to LIVE_BACKUP_DEST (readable from Windows). Its archive is encrypted with the backup key, which lives on the
# Linux side at LIVE_BACKUP_KEY_FILE. John keeps a copy of the backup key off this PC (see "Backup key" in
# scripts/live-backup/README.md): without it the encrypted archive cannot be opened.
#
# The off-machine copy goes to LIVE_BACKUP_OFFSITE_DIR on John's USB drive. The database dump and the files
# archive hold client data, so they leave the PC only encrypted with the same backup key. The folder counts
# only when it holds the marker file that install wrote: an unplugged drive leaves an empty /mnt/<letter>,
# and a copy there would sit on this PC's own disk. If the drive is missing the local backup still counts;
# the run logs "OFFSITE COPY FAILED" and writes OFFSITE-COPY-FAILED.txt in LIVE_BACKUP_DEST.
#
# Every run writes <instance>/data/health/live-backup.json. The server reads it to find the backup folder and
# reports the newest dump, files archive and key archive, and the last good off-machine copy, on /api/health
# (liveBackup).
#
# Settings (all have defaults for the live PC; tests and sandboxes move them):
#   LIVE_BACKUP_DEST       backup folder            (default /mnt/c/Users/johnp/GSAM-backups)
#   LIVE_BACKUP_KEEP       copies kept of each kind (default 14, on the drive too)
#   LIVE_BACKUP_OFFSITE_DIR
#                          off-machine folder       (default /mnt/d/GSAM-offsite; "off" turns the copy off)
#   LIVE_BACKUP_OFFSITE_SEARCH
#                          where to look when the drive comes back under another letter (default /mnt)
#   LIVE_BACKUP_KEY_FILE   backup key               (default ~/.config/gsam-live-backup/backup.key)
#   LIVE_BACKUP_LOG        log file for runs        (default ~/GSAM/logs/nightly-backup.log; "-" for the terminal)
#   LIVE_BACKUP_COMMON     scripts/greatstone-common.sh to source; it sets GSAM_ROOT paths and the dump helpers
#   LIVE_BACKUP_STORAGE_DIR, LIVE_BACKUP_MASTER_KEY_FILE
#                          what to archive (default: storage.localDisk.baseDir and secrets.localEncrypted.keyFilePath
#                          from <instance>/config.json, else <instance>/data/storage and <instance>/secrets/master.key)
#   GSAM_ROOT              the GSAM home            (default ~/GSAM, read by greatstone-common.sh)
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_PATH="$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")"
# Agent runs set HOME to a temp folder; the backup belongs to the real home folder.
USER_HOME="$(perl -e 'print((getpwuid($<))[7])' 2>/dev/null || true)"
USER_HOME="${USER_HOME:-$HOME}"
if [[ -z "${LIVE_BACKUP_COMMON:-}" ]]; then
  # In the repo the common file sits next door. The installed copy in ~/GSAM uses the dev checkout, as before.
  if [[ -f "$SCRIPT_DIR/../greatstone-common.sh" ]]; then
    LIVE_BACKUP_COMMON="$SCRIPT_DIR/../greatstone-common.sh"
  else
    LIVE_BACKUP_COMMON="$USER_HOME/Desktop/Code/gs-clip/scripts/greatstone-common.sh"
  fi
fi
# shellcheck source=../greatstone-common.sh
. "$LIVE_BACKUP_COMMON" || { echo "cannot read $LIVE_BACKUP_COMMON" >&2; exit 1; }

DEST="${LIVE_BACKUP_DEST:-/mnt/c/Users/johnp/GSAM-backups}"
KEEP="${LIVE_BACKUP_KEEP:-14}"
BACKUP_KEY="${LIVE_BACKUP_KEY_FILE:-$USER_HOME/.config/gsam-live-backup/backup.key}"
LOG_FILE="${LIVE_BACKUP_LOG:-$GS_ROOT/logs/nightly-backup.log}"
INSTANCE_DIR="$LIVE_DATA_DIR/instances/$INSTANCE_ID"

# config_path <dotted.key>: a path from the instance config.json, "~/" expanded, or nothing. The server reads
# the same keys (server/src/config.ts), so the backup follows a key or storage folder that was moved.
config_path() {
  local file="$INSTANCE_DIR/config.json"
  [[ -f "$file" ]] && command -v node >/dev/null 2>&1 || return 0
  node -e '
    let v; try { v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); } catch { process.exit(0); }
    for (const k of process.argv[2].split(".")) v = v?.[k];
    if (typeof v === "string" && v.trim()) console.log(v.trim().replace(/^~(?=\/|$)/, process.argv[3]));
  ' "$file" "$1" "$USER_HOME" 2>/dev/null
}
STORAGE_DIR="${LIVE_BACKUP_STORAGE_DIR:-$(config_path storage.localDisk.baseDir)}"
STORAGE_DIR="${STORAGE_DIR:-$INSTANCE_DIR/data/storage}"
MASTER_KEY="${LIVE_BACKUP_MASTER_KEY_FILE:-$(config_path secrets.localEncrypted.keyFilePath)}"
MASTER_KEY="${MASTER_KEY:-$INSTANCE_DIR/secrets/master.key}"
STATE_FILE="$INSTANCE_DIR/data/health/live-backup.json"
INSTALL_TARGET="$GS_ROOT/nightly-backup.sh"
OFFSITE_DIR="${LIVE_BACKUP_OFFSITE_DIR:-/mnt/d/GSAM-offsite}"
OFFSITE_SEARCH="${LIVE_BACKUP_OFFSITE_SEARCH:-/mnt}"
OFFSITE_MARKER=".gsam-offsite"
# The time of the last good copy survives runs with the drive unplugged, so health can count the 48 hours.
OFFSITE_LAST_OK="$(dirname "$STATE_FILE")/live-backup-offsite.last-ok"
OFFSITE_FAILED_NOTE="$DEST/OFFSITE-COPY-FAILED.txt"

log() { printf '%s\n' "$*"; }
die() { printf 'live-backup: %s\n' "$*" >&2; exit 1; }

# Same cipher and key file layout as the gs-memory backup (GRE-931).
encrypt_stream() { quiet openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$BACKUP_KEY"; }
decrypt_stream() { openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$BACKUP_KEY"; }

# Low priority, so the nightly run does not slow the live server.
quiet() {
  if command -v ionice >/dev/null 2>&1; then nice -n 15 ionice -c2 -n7 "$@"; else nice -n 15 "$@"; fi
}

json_string() {
  local s="$1"
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//$'\n'/ }"
  printf '"%s"' "$s"
}

# Made once. A new key cannot open old archives, so it is never made while encrypted archives exist.
ensure_backup_key() {
  [[ -s "$BACKUP_KEY" ]] && return 0
  if compgen -G "$DEST/secrets-*.tar.enc" >/dev/null; then
    log "no backup key at $BACKUP_KEY, but encrypted archives exist in $DEST. Put the saved key back (scripts/live-backup/README.md, \"Backup key\")"
    return 1
  fi
  mkdir -p "$(dirname "$BACKUP_KEY")" && chmod 700 "$(dirname "$BACKUP_KEY")" || return 1
  (umask 077; openssl rand -base64 48 > "$BACKUP_KEY") || return 1
  log "new backup key written to $BACKUP_KEY (mode 600). Save a copy off this PC (scripts/live-backup/README.md, \"Backup key\")"
}

sha256_line() { (cd "$(dirname "$1")" && sha256sum "$(basename "$1")"); }

# prune_dir <dir> <prefix> <suffix>. Names carry the stamp, so name order is age order.
prune_dir() {
  local f
  while read -r f; do
    [[ -n "$f" ]] || continue
    rm -f "$f" "$f.sha256" && log "pruned $f"
  done < <(ls -1 "$1"/"$2"-*"$3" 2>/dev/null | sort -r | tail -n +"$((KEEP + 1))")
}
prune() { prune_dir "$DEST" "$1" "$2"; }

# Same dump as the old ~/GSAM/nightly-backup.sh: the release backup command, one read-only transaction.
dump_database() {
  local url f
  url="$(live_database_url)" || { log "live database not running; no dump tonight"; return 1; }
  f="$(PGPASSWORD="$(live_database_password)" quiet bash -c "$(declare -f gs_tools_installed gs_db); GS_TOOLS_ROOT=\"$GS_TOOLS_ROOT\" gs_db backup --source-url \"$url\" --dir \"$DEST\" --prefix nightly" | tail -n 1)"
  [[ -s "$f" ]] || { log "database dump FAILED"; return 1; }
  log "ok: $f ($(du -h "$f" | cut -f1))"
  prune nightly .sql.gz
}

archive_files() {
  local name="files-$STAMP.tar.gz" part rc
  [[ -d "$STORAGE_DIR" ]] || { log "no storage folder at $STORAGE_DIR; no files archive"; return 1; }
  part="$DEST/.$name.part"
  # Stored under storage/ whatever the folder is called, so restore-files always lands in data/storage.
  quiet tar -C "$STORAGE_DIR" --transform 's|^\.$|storage|;s|^\./|storage/|' -czf "$part" .; rc=$?
  # tar exit 1 means a file changed while it was read (an upload during the run). The archive is still good.
  if (( rc > 1 )) || ! gzip -t "$part" 2>/dev/null; then
    rm -f "$part"; log "files archive FAILED (tar exit $rc)"; return 1
  fi
  (( rc == 1 )) && log "warning: some files changed while they were archived"
  mv "$part" "$DEST/$name" && sha256_line "$DEST/$name" > "$DEST/$name.sha256" || { log "files archive FAILED (cannot write $DEST/$name)"; return 1; }
  log "ok: $DEST/$name ($(du -h "$DEST/$name" | cut -f1))"
  prune files .tar.gz
}

# The plain key goes from its file through tar and openssl into the encrypted part file. No plain copy on disk.
archive_key() {
  local name="secrets-$STAMP.tar.enc" part want got
  [[ -s "$MASTER_KEY" ]] || { log "no secrets master key at $MASTER_KEY; no key archive"; return 1; }
  ensure_backup_key || { log "secrets key archive FAILED (no backup key)"; return 1; }
  part="$DEST/.$name.part"
  # Stored as master.key whatever the file is called, so restore-key always knows the member name.
  if ! tar -C "$(dirname "$MASTER_KEY")" --transform 's|^.*$|master.key|' -cf - "$(basename "$MASTER_KEY")" | encrypt_stream > "$part"; then
    rm -f "$part"; log "secrets key archive FAILED (encrypt)"; return 1
  fi
  # The archive counts only when it decrypts back to the same key bytes.
  want="$(sha256sum < "$MASTER_KEY" | cut -d' ' -f1)"
  got="$(decrypt_stream < "$part" 2>/dev/null | tar -xOf - master.key 2>/dev/null | sha256sum | cut -d' ' -f1)"
  if [[ "$want" != "$got" ]]; then
    rm -f "$part"; log "secrets key archive FAILED (decrypt check)"; return 1
  fi
  mv "$part" "$DEST/$name" && sha256_line "$DEST/$name" > "$DEST/$name.sha256" || { log "secrets key archive FAILED (cannot write $DEST/$name)"; return 1; }
  log "ok: $DEST/$name (encrypted, decrypt verified)"
  prune secrets .tar.enc
}

# The marked off-machine folder: at its usual place, or on a drive that Windows gave another letter.
find_offsite() {
  local d
  for d in "$OFFSITE_DIR" "$OFFSITE_SEARCH"/*/"$(basename "$OFFSITE_DIR")"; do
    [[ -f "$d/$OFFSITE_MARKER" ]] && { printf '%s\n' "$d"; return 0; }
  done
  return 1
}

# Set by copy_offsite, read by write_state.
OFFSITE_STATUS="failed"
OFFSITE_FAILURE="the run stopped before the off-machine copy"
OFFSITE_USED_DIR=""

offsite_failed() {
  OFFSITE_STATUS="failed"
  OFFSITE_FAILURE="$1"
  log "OFFSITE COPY FAILED: $1"
  {
    printf 'The nightly off-machine backup copy failed at %s.\n\n%s\n\n' "$(date -Is)" "$1"
    printf 'The backup on this PC is not affected. If the USB drive was unplugged, plug it in.\n'
    printf 'WSL does not see a drive plugged in after it started. In Ubuntu, run:\n'
    printf '  sudo mkdir -p /mnt/d && sudo mount -t drvfs D: /mnt/d -o uid=$(id -u),gid=$(id -g)\n'
    printf 'The next night copies the newest set.\n'
    printf 'This file goes away after the next good copy. Log: %s\n' "$LOG_FILE"
  } > "$OFFSITE_FAILED_NOTE" 2>/dev/null || log "warning: cannot write $OFFSITE_FAILED_NOTE"
}

# offsite_copy_one <source> <folder> <name> <encrypt: yes|no>. Writes through a part file. The copy counts
# only when it reads back (decrypted, if encrypted) to the source bytes. A copy already there is kept.
offsite_copy_one() {
  local src="$1" dir="$2" name="$3" enc="$4" part want got note=""
  if [[ -s "$dir/$name" && -s "$dir/$name.sha256" ]]; then
    log "offsite: $name already on the drive"; return 0
  fi
  part="$dir/.$name.part"
  want="$(sha256sum < "$src" | cut -d' ' -f1)"
  if [[ "$enc" == yes ]]; then
    note=", encrypted"
    encrypt_stream < "$src" > "$part" || { rm -f "$part"; log "offsite: cannot write $name"; return 1; }
    got="$(decrypt_stream < "$part" 2>/dev/null | sha256sum | cut -d' ' -f1)"
  else
    quiet cp "$src" "$part" || { rm -f "$part"; log "offsite: cannot write $name"; return 1; }
    got="$(sha256sum < "$part" | cut -d' ' -f1)"
  fi
  if [[ "$want" != "$got" ]]; then
    rm -f "$part"; log "offsite: $name did not read back the same"; return 1
  fi
  mv -f "$part" "$dir/$name" && sha256_line "$dir/$name" > "$dir/$name.sha256" || { log "offsite: cannot write $name"; return 1; }
  log "ok: $dir/$name ($(du -h "$dir/$name" | cut -f1)$note, read back verified)"
}

# Copies the newest dump, files archive and key archive to the drive and keeps 14 of each there. The dump
# and the files archive hold client data, so they leave this PC only encrypted. Never fails the local backup.
copy_offsite() {
  local dir spec prefix suffix enc src name copied=0 failed=()
  if [[ "$OFFSITE_DIR" == off ]]; then
    OFFSITE_STATUS="off"; OFFSITE_FAILURE="turned off (LIVE_BACKUP_OFFSITE_DIR=off)"
    log "off-machine copy turned off"; return 0
  fi
  if ! dir="$(find_offsite)"; then
    offsite_failed "USB drive not found: no $OFFSITE_MARKER in $OFFSITE_DIR (drive unplugged, or plugged in after WSL started)"
    return 1
  fi
  OFFSITE_USED_DIR="$dir"
  [[ "$dir" == "$OFFSITE_DIR" ]] || log "offsite: the drive is at $dir now"
  [[ -s "$BACKUP_KEY" ]] || { offsite_failed "no backup key at $BACKUP_KEY"; return 1; }
  for spec in "nightly .sql.gz yes" "files .tar.gz yes" "secrets .tar.enc no"; do
    read -r prefix suffix enc <<<"$spec"
    src="$(ls -1 "$DEST"/"$prefix"-*"$suffix" 2>/dev/null | sort | tail -n 1)"
    [[ -n "$src" ]] || continue
    name="$(basename "$src")"; [[ "$enc" == yes ]] && name="$name.enc"
    if offsite_copy_one "$src" "$dir" "$name" "$enc"; then
      copied=$((copied + 1))
      if [[ "$enc" == yes ]]; then prune_dir "$dir" "$prefix" "$suffix.enc"; else prune_dir "$dir" "$prefix" "$suffix"; fi
    else
      failed+=("$name")
    fi
  done
  if (( ${#failed[@]} )); then
    local joined; joined="$(IFS=,; printf '%s' "${failed[*]}")"
    offsite_failed "copy to $dir failed: ${joined//,/, }"; return 1
  fi
  (( copied )) || { offsite_failed "no local backup to copy"; return 1; }
  date -u +%FT%TZ > "$OFFSITE_LAST_OK" || log "warning: cannot write $OFFSITE_LAST_OK"
  rm -f "$OFFSITE_FAILED_NOTE"
  OFFSITE_STATUS="ok"; OFFSITE_FAILURE=""
  log "off-machine copy finished: $dir"
}

# The server reads this file (server/src/services/live-backup-health.ts). It points at the backup folder and
# says whether the last run had a failed step. The server checks the archives in the folder itself. The
# offsite part is the off-machine copy: the result of this run and the time of the last good copy.
write_state() {
  local ok="$1" failure="$2" dir part
  dir="$(dirname "$STATE_FILE")"
  mkdir -p "$dir" 2>/dev/null || { log "warning: cannot write $STATE_FILE"; return 0; }
  part="$STATE_FILE.part"
  {
    printf '{\n  "version": 1,\n'
    printf '  "backupDir": %s,\n' "$(json_string "$DEST")"
    printf '  "finishedAt": "%s",\n' "$(date -u +%FT%TZ)"
    printf '  "ok": %s,\n' "$ok"
    if [[ -n "$failure" ]]; then printf '  "failure": %s,\n' "$(json_string "$failure")"; else printf '  "failure": null,\n'; fi
    printf '  "offsite": {\n    "status": %s,\n' "$(json_string "$OFFSITE_STATUS")"
    printf '    "dir": %s,\n' "$(json_string "${OFFSITE_USED_DIR:-$OFFSITE_DIR}")"
    if [[ -s "$OFFSITE_LAST_OK" ]]; then printf '    "lastCopyAt": %s,\n' "$(json_string "$(head -n 1 "$OFFSITE_LAST_OK")")"; else printf '    "lastCopyAt": null,\n'; fi
    if [[ -n "$OFFSITE_FAILURE" ]]; then printf '    "failure": %s\n' "$(json_string "$OFFSITE_FAILURE")"; else printf '    "failure": null\n'; fi
    printf '  }\n}\n'
  } > "$part" && mv "$part" "$STATE_FILE" || log "warning: cannot write $STATE_FILE"
}

cmd_run() {
  umask 077
  if [[ "$LOG_FILE" != "-" ]]; then
    mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null
    exec >>"$LOG_FILE" 2>&1
  fi
  log "=== $(date -Is) nightly backup"
  mkdir -p "$(dirname "$STATE_FILE")" 2>/dev/null
  # One run at a time. A second cron start, or a hand run during the night run, skips quietly.
  exec 9>"$(dirname "$STATE_FILE")/live-backup.lock" || die "cannot open the lock file"
  flock -n 9 || { log "another backup is running; skipped"; return 0; }
  if ! mkdir -p "$DEST" 2>/dev/null || [[ ! -w "$DEST" ]]; then
    log "cannot write $DEST"
    write_state false "cannot write the backup folder"
    return 1
  fi
  STAMP="$(date +%Y%m%d-%H%M%S)"
  # Each step runs even when an earlier one failed: a stopped database must not also cost the files archive.
  local failed=()
  dump_database || failed+=("database dump")
  archive_files || failed+=("files archive")
  archive_key || failed+=("secrets key archive")
  # Copies whatever is newest, even after a failed step. A failed copy does not fail the local backup.
  copy_offsite
  if (( ${#failed[@]} )); then
    local joined
    joined="$(IFS=,; printf '%s' "${failed[*]}")"
    write_state false "failed: ${joined//,/, }"
    log "backup finished with failures: ${joined//,/, }"
    return 1
  fi
  write_state true ""
  log "backup finished"
}

cmd_install() {
  [[ -f "$SCRIPT_DIR/../greatstone-common.sh" ]] || die "run install from the repo: bash <checkout>/scripts/live-backup/live-backup.sh install"
  [[ -d "$GS_ROOT" ]] || die "no GSAM home at $GS_ROOT"
  local saved="$INSTALL_TARGET.before-GRE-1930"
  if [[ -f "$INSTALL_TARGET" && ! -e "$saved" ]]; then
    cp -p "$INSTALL_TARGET" "$saved" || die "cannot save the old script to $saved"
    log "old script saved: $saved"
  fi
  install -m 0755 "$SCRIPT_PATH" "$INSTALL_TARGET" || die "cannot write $INSTALL_TARGET"
  log "installed: $INSTALL_TARGET (cron runs it at 02:30)"
  if ! crontab -l 2>/dev/null | grep -qF "$INSTALL_TARGET"; then
    log "WARNING: no cron entry runs $INSTALL_TARGET. Add: 30 2 * * * $INSTALL_TARGET"
  fi
  ensure_backup_key || exit 1
  log "backup key: $BACKUP_KEY"
  log "Save a copy of the backup key off this PC now (scripts/live-backup/README.md, \"Backup key\")."
  mark_offsite
}

# The nightly copy writes only into a folder with the marker, so install makes the folder and the marker
# while John is there to see that the drive is plugged in.
mark_offsite() {
  local drive
  [[ "$OFFSITE_DIR" == off ]] && { log "off-machine copy: turned off"; return 0; }
  if [[ -f "$OFFSITE_DIR/$OFFSITE_MARKER" ]]; then log "off-machine folder: $OFFSITE_DIR"; return 0; fi
  drive="$(dirname "$OFFSITE_DIR")"
  if [[ ! -d "$drive" || ! -w "$drive" ]]; then
    log "WARNING: USB drive not found at $drive. Plug it in and check that 'ls $drive' shows its files. If not, run:"
    log "  sudo mkdir -p $drive && sudo mount -t drvfs D: $drive -o uid=\$(id -u),gid=\$(id -g)"
    log "Then run install again."
    return 0
  fi
  mkdir -p "$OFFSITE_DIR" && printf 'GSAM off-machine backup folder, marked by live-backup.sh install on %s.\nThe nightly copy writes only where this file is. Do not delete it.\n' "$(date -Is)" \
    > "$OFFSITE_DIR/$OFFSITE_MARKER" || { log "WARNING: cannot write $OFFSITE_DIR"; return 0; }
  log "off-machine folder marked: $OFFSITE_DIR"
}

cmd_restore_files() {
  local archive="${1:-}" target="${2:-}"
  [[ -f "$archive" && -n "$target" ]] || die "usage: live-backup.sh restore-files <files-*.tar.gz> <instance dir>"
  if [[ -s "$archive.sha256" ]]; then
    (cd "$(dirname "$archive")" && sha256sum -c --quiet "$(basename "$archive").sha256") || die "checksum mismatch: $archive"
  fi
  mkdir -p "$target/data" || die "cannot write $target/data"
  if [[ "$archive" == *.enc ]]; then
    # A drive copy: encrypted with the backup key.
    [[ -s "$BACKUP_KEY" ]] || die "no backup key at $BACKUP_KEY; put the saved copy back first"
    decrypt_stream < "$archive" 2>/dev/null | tar -C "$target/data" --skip-old-files -xzf - || die "cannot decrypt or unpack $archive (wrong key?)"
    log "restored $(decrypt_stream < "$archive" 2>/dev/null | tar -tzf - | grep -vc '/$') files into $target/data/storage (existing files kept)"
    return 0
  fi
  tar -C "$target/data" --skip-old-files -xzf "$archive" || die "cannot unpack $archive"
  log "restored $(tar -tzf "$archive" | grep -vc '/$') files into $target/data/storage (existing files kept)"
}

# For the drive's nightly-*.sql.gz.enc: writes the plain dump, which then restores like any .sql.gz backup.
cmd_decrypt() {
  local src="${1:-}" out="${2:-}"
  [[ -f "$src" && -n "$out" ]] || die "usage: live-backup.sh decrypt <file.enc> <out file>"
  [[ -e "$out" ]] && die "$out exists; give another out file"
  [[ -s "$BACKUP_KEY" ]] || die "no backup key at $BACKUP_KEY; put the saved copy back first"
  if [[ -s "$src.sha256" ]]; then
    (cd "$(dirname "$src")" && sha256sum -c --quiet "$(basename "$src").sha256") || die "checksum mismatch: $src"
  fi
  umask 077
  if ! decrypt_stream < "$src" > "$out.part" 2>/dev/null || { [[ "$out" == *.gz ]] && ! gzip -t "$out.part" 2>/dev/null; }; then
    rm -f "$out.part"; die "cannot decrypt $src with $BACKUP_KEY (wrong key?)"
  fi
  mv "$out.part" "$out" || die "cannot write $out"
  log "decrypted $src to $out"
}

cmd_restore_key() {
  local archive="${1:-}" target="${2:-}" tmp
  [[ -f "$archive" && -n "$target" ]] || die "usage: live-backup.sh restore-key <secrets-*.tar.enc> <key file>"
  [[ -s "$BACKUP_KEY" ]] || die "no backup key at $BACKUP_KEY; put the saved copy back first"
  if [[ -s "$archive.sha256" ]]; then
    (cd "$(dirname "$archive")" && sha256sum -c --quiet "$(basename "$archive").sha256") || die "checksum mismatch: $archive"
  fi
  mkdir -p "$(dirname "$target")" || die "cannot write $(dirname "$target")"
  tmp="$(mktemp "$(dirname "$target")/.restore-key.XXXXXX")" || die "cannot write $(dirname "$target")"
  chmod 600 "$tmp"
  if ! decrypt_stream < "$archive" 2>/dev/null | tar -xOf - master.key > "$tmp" 2>/dev/null || [[ ! -s "$tmp" ]]; then
    rm -f "$tmp"; die "cannot decrypt $archive with $BACKUP_KEY (wrong key?)"
  fi
  if [[ -e "$target" ]]; then
    if cmp -s "$tmp" "$target"; then rm -f "$tmp"; log "$target already holds this key"; return 0; fi
    rm -f "$tmp"; die "$target exists with a different key; move it away first"
  fi
  mv "$tmp" "$target" || die "cannot write $target"
  log "restored the secrets master key to $target (mode 600)"
}

case "${1:-run}" in
  run) cmd_run;;
  install) cmd_install;;
  restore-files) shift; cmd_restore_files "$@";;
  restore-key) shift; cmd_restore_key "$@";;
  decrypt) shift; cmd_decrypt "$@";;
  *) sed -n '2,17p' "$SCRIPT_PATH" | sed 's/^# \{0,1\}//'; exit 2;;
esac
