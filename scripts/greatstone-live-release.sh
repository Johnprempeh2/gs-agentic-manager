#!/usr/bin/env bash
# One-click release launcher (see doc/GREATSTONE-WAY-OF-WORKING.md, step 6).
#
#   greatstone-live-release.sh <job-dir> <rc-tag> <release-repo>
#
# The live server starts this when John accepts an "Update live?" card, after
# it has held new agent runs and seen none running. It does not repeat any
# release logic: it runs <release-repo>/scripts/greatstone-release.sh, the same
# command John runs by hand. If that fails after live moved, it rolls back with
# the same script to the live-* tag live was on before. The outcome goes to
# <job-dir>/result.json; the server posts it on the release issue.
#
# It first starts a copy of itself in the background and exits, so the release
# runs in a process whose parent is not the live server. The live server
# restarting during the release does not stop it.
set -uo pipefail

JOB_DIR="${1:?job dir}"
TAG="${2:?rc tag}"
RELEASE_REPO="${3:?release repo}"

if [ "${GSAM_LIVE_RELEASE_FOREGROUND:-}" != 1 ]; then
  GSAM_LIVE_RELEASE_FOREGROUND=1 nohup bash "$0" "$@" </dev/null >>"$JOB_DIR/launcher.log" 2>&1 &
  printf '%s\n' "$!" >"$JOB_DIR/launcher.pid"
  exit 0
fi

export GSAM_RELEASE_REPO="$RELEASE_REPO"
RELEASE="$RELEASE_REPO/scripts/greatstone-release.sh"

# write_result <outcome> <message> [<live-tag>] [<commit>] [<backup-file>]
write_result() {
  node -e '
    const [file, outcome, message, liveTag, previousTag, commit, backupFile] = process.argv.slice(1);
    const fs = require("node:fs");
    const or = (v) => (v ? v : null);
    fs.writeFileSync(file + ".tmp", JSON.stringify({ outcome, message: or(message), liveTag: or(liveTag), previousTag: or(previousTag), commit: or(commit), backupFile: or(backupFile) }, null, 2) + "\n");
    fs.renameSync(file + ".tmp", file);
  ' "$JOB_DIR/result.json" "$1" "$2" "${3:-}" "${PREVIOUS:-}" "${4:-}" "${5:-}"
}

# The last "release: ..." error line of a log, or its last line.
reason_from() {
  local line
  line="$(grep '^release: ' "$1" 2>/dev/null | tail -n 1 | sed 's/^release: //')"
  [ -n "$line" ] || line="$(tail -n 1 "$1" 2>/dev/null)"
  printf '%s' "$line"
}

PREVIOUS=""
if [ ! -f "$RELEASE_REPO/scripts/greatstone-common.sh" ] || [ ! -x "$RELEASE" ]; then
  write_result not_released "no release script in $RELEASE_REPO"
  exit 1
fi
# shellcheck source=greatstone-common.sh
source "$RELEASE_REPO/scripts/greatstone-common.sh"

BEFORE="$(git -C "$LIVE_DIR" rev-parse HEAD 2>/dev/null || true)"
PREVIOUS="$(git -C "$LIVE_DIR" describe --tags --exact-match --match 'live-*' HEAD 2>/dev/null || true)"

say "$(date -u +%FT%TZ) release $TAG (live on ${PREVIOUS:-$BEFORE})"
"$RELEASE" "$TAG" >"$JOB_DIR/release.log" 2>&1
STATUS=$?
BACKUP="$(sed -n 's/^Backed up the live database (on .*) to //p' "$JOB_DIR/release.log" | tail -n 1)"
LIVE_TAG="$(sed -n 's/^Tagged .* as \(live-[^ :]*\).*$/\1/p' "$JOB_DIR/release.log" | tail -n 1)"

if [ "$STATUS" -eq 0 ]; then
  write_result released "" "$LIVE_TAG" "$(health_commit "$LIVE_URL")" "$BACKUP"
  say "$(date -u +%FT%TZ) released"
  exit 0
fi

REASON="$(reason_from "$JOB_DIR/release.log")"
if [ "$(git -C "$LIVE_DIR" rev-parse HEAD 2>/dev/null || true)" = "$BEFORE" ]; then
  write_result not_released "$REASON" "" "" "$BACKUP"
  say "$(date -u +%FT%TZ) not released: live did not move"
  exit 1
fi
if [ -z "$PREVIOUS" ]; then
  write_result rollback_failed "$REASON; live was not on a live-* tag before, so there is nothing to roll back to" "" "" "$BACKUP"
  exit 1
fi

say "$(date -u +%FT%TZ) release failed after live moved; rolling back to $PREVIOUS"
# If the failed version took the database down, the rollback cannot take a new
# backup; the backup taken before this release is the one to keep.
GSAM_RELEASE_EXISTING_BACKUP="$BACKUP" "$RELEASE" "$PREVIOUS" >"$JOB_DIR/rollback.log" 2>&1
if [ $? -eq 0 ]; then
  write_result rolled_back "$REASON" "" "$(health_commit "$LIVE_URL")" "$BACKUP"
  say "$(date -u +%FT%TZ) rolled back to $PREVIOUS"
  exit 1
fi
write_result rollback_failed "$REASON; rollback: $(reason_from "$JOB_DIR/rollback.log")" "" "" "$BACKUP"
say "$(date -u +%FT%TZ) rollback failed"
exit 1
