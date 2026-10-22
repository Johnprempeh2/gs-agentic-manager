#!/usr/bin/env bash
# Nightly backup of the live GSAM instance (GRE-1930). Cron: 30 2 * * *, as the user that runs GSAM.
#
#   live-backup.sh [run]                   database dump, uploaded files archive and encrypted secrets key
#                                          archive, side by side in LIVE_BACKUP_DEST. Keeps the newest 14 of each.
#   live-backup.sh install                 copies this script to ~/GSAM/nightly-backup.sh (the cron entry stays
#                                          the same) and makes the backup key if there is none. Run it from the repo.
#   live-backup.sh restore-files <archive> <instance dir>
#                                          unpacks a files-*.tar.gz into <instance dir>/data/storage.
#                                          Never overwrites a file that is already there.
#   live-backup.sh restore-key <archive> <key file>
#                                          decrypts a secrets-*.tar.enc with the backup key and writes the master
#                                          key to <key file> (mode 600). Stops if <key file> exists with other bytes.
#
# The secrets master key unlocks the secret values in the database dump, so it is never written in plain text
# to LIVE_BACKUP_DEST (readable from Windows). Its archive is encrypted with the backup key, which lives on the
# Linux side at LIVE_BACKUP_KEY_FILE. John keeps a copy of the backup key off this PC (see "Backup key" in
# scripts/live-backup/README.md): without it the encrypted archive cannot be opened.
#
# Every run writes <instance>/data/health/live-backup.json. The server reads it to find the backup folder and
# reports the newest dump, files archive and key archive on /api/health (liveBackup).
#
# Settings (all have defaults for the live PC; tests and sandboxes move them):
#   LIVE_BACKUP_DEST       backup folder            (default /mnt/c/Users/johnp/GSAM-backups)
#   LIVE_BACKUP_KEEP       copies kept of each kind (default 14)
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

log() { printf '%s\n' "$*"; }
die() { printf 'live-backup: %s\n' "$*" >&2; exit 1; }

# Same cipher and key file layout as the gs-memory backup (GRE-931).
encrypt_stream() { openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$BACKUP_KEY"; }
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

# prune <prefix> <suffix>. Names carry the stamp, so name order is age order.
prune() {
  local f
  while read -r f; do
    [[ -n "$f" ]] || continue
    rm -f "$f" "$f.sha256" && log "pruned $f"
  done < <(ls -1 "$DEST"/"$1"-*"$2" 2>/dev/null | sort -r | tail -n +"$((KEEP + 1))")
}

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

# The server reads this file (server/src/services/live-backup-health.ts). It points at the backup folder and
# says whether the last run had a failed step. The server checks the archives in the folder itself.
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
    # Part 2 of GRE-1929 (the off-machine copy) fills this in.
    printf '  "offsite": { "status": "not_configured" }\n}\n'
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
}

cmd_restore_files() {
  local archive="${1:-}" target="${2:-}"
  [[ -f "$archive" && -n "$target" ]] || die "usage: live-backup.sh restore-files <files-*.tar.gz> <instance dir>"
  if [[ -s "$archive.sha256" ]]; then
    (cd "$(dirname "$archive")" && sha256sum -c --quiet "$(basename "$archive").sha256") || die "checksum mismatch: $archive"
  fi
  mkdir -p "$target/data" || die "cannot write $target/data"
  tar -C "$target/data" --skip-old-files -xzf "$archive" || die "cannot unpack $archive"
  log "restored $(tar -tzf "$archive" | grep -vc '/$') files into $target/data/storage (existing files kept)"
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
  *) sed -n '2,15p' "$SCRIPT_PATH" | sed 's/^# \{0,1\}//'; exit 2;;
esac
