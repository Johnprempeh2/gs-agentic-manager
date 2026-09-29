#!/usr/bin/env bash
# Release GS Agentic Manager to the live app (see doc/GREATSTONE-WAY-OF-WORKING.md).
#
#   scripts/greatstone-release.sh rc-YYYY-MM-DD.N     release the candidate that was checked in the preview
#   scripts/greatstone-release.sh live-YYYY-MM-DD.N   move live back to an earlier release (rollback)
#
# Run from the dev checkout. The live app is a separate clone that only ever
# sits on a live-* tag; this script is the one thing that moves it. Before it
# moves live it backs up the live database to ~/GSAM/backups/. After a
# successful release it stops the preview.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/greatstone-common.sh"

die() { printf 'release: %s\n' "$*" >&2; exit 1; }

TAG="${1:-}"
case "$TAG" in
  rc-*) MODE=release ;;
  live-*) MODE=rollback ;;
  *) die "usage: greatstone-release.sh <rc-tag> | <live-tag>  (an rc-* tag releases a checked candidate; a live-* tag rolls back)" ;;
esac

# GSAM_RELEASE_FROM_APP=1: started by the live server (the Releases page, GRE-121).
# The server already held new runs and waited for runs flagged "finish before
# update"; the restart below is a hot restart, so other running runs are kept
# (adopted, or checkpointed and resumed). The candidate is cut from origin/main
# with Fork CI green, so it need not be the one in the preview.
FROM_APP="${GSAM_RELEASE_FROM_APP:-}"
record_release_repo "$RELEASE_REPO"
KEY_PROBLEM="$(live_board_key_check)" || die "$KEY_PROBLEM"

# A candidate carries a title and changelog; the live-* tag gets the same message.
if [ "$MODE" = release ]; then
  TITLE="$(rc_tag_title "$RELEASE_REPO" "$TAG")" || die "$TITLE"
fi

[ -d "$LIVE_DIR/.git" ] || die "no live checkout at $LIVE_DIR"
# Before the backup and the tag: a stale index.lock would stop the checkout below.
LOCK_NOTE="$(live_index_lock_check)" || die "$LOCK_NOTE"
[ -z "$LOCK_NOTE" ] || say "$LOCK_NOTE"
[ -z "$(git -C "$LIVE_DIR" status --porcelain)" ] || die "the live checkout has local changes; nothing may edit it. Inspect $LIVE_DIR before releasing."

git -C "$RELEASE_REPO" fetch --quiet --tags origin
git -C "$RELEASE_REPO" fetch --quiet origin main
STALE="$(release_scripts_current "$RELEASE_REPO")" || die "$STALE"
TARGET="$(git -C "$RELEASE_REPO" rev-parse --verify --quiet "refs/tags/$TAG^{commit}")" || die "unknown tag $TAG"
[ "$(git -C "$LIVE_DIR" rev-parse HEAD)" != "$TARGET" ] || die "live is already on $TAG ($TARGET); nothing to do."

if [ "$MODE" = release ]; then
  git -C "$RELEASE_REPO" merge-base --is-ancestor "$TARGET" origin/main \
    || die "$TAG ($TARGET) is not on origin/main; only merged code is released."
  if [ "$FROM_APP" != 1 ] && preview_running && [ "$(preview_state commit)" != "$TARGET" ]; then
    die "the preview runs $(preview_state tag) ($(preview_state commit)), not $TAG. Release the tag you checked, or check $TAG in the preview first."
  fi
fi

if [ "$FROM_APP" != 1 ]; then
  RUNS="$(active_runs "$LIVE_URL")" || die "cannot count the active agent runs on $LIVE_URL (see above). In login mode, put a board API key in $LIVE_BOARD_KEY_FILE (see the runbook)."
  [ "$RUNS" = "0" ] || die "$RUNS agent run(s) are active; release again when the agents are idle, or release from the app."
fi

# A server in login mode hides serverInfo from a caller with no board login.
# Without it the script cannot tell the old process from the new one, and would
# take a running live server for a stopped one. (A wrong key gets 401 on every
# route, so "is it up" is asked with no key.)
if curl -fsS -m 5 -o /dev/null "$LIVE_URL/api/health" 2>/dev/null && [ -z "$(health_field "$LIVE_URL" serverInfo.processStartedAt)" ]; then
  die "the live server at $LIVE_URL runs but does not show serverInfo: it runs in login mode and $LIVE_BOARD_KEY_FILE holds no valid board API key (see the runbook). Nothing was changed."
fi

PREVIOUS="$(git -C "$LIVE_DIR" describe --tags --exact-match --match 'live-*' HEAD 2>/dev/null || git -C "$LIVE_DIR" rev-parse --short HEAD)"

# Back up the live database before anything moves. The backup only reads.
if LIVE_DB_URL="$(live_database_url)"; then
  BACKUP_DIR="$BACKUP_ROOT/release-$(date +%Y-%m-%dT%H%M%S)-$TAG"
  BACKUP_FILE="$(gs_db backup --source-url "$LIVE_DB_URL" --dir "$BACKUP_DIR" --prefix "before-$TAG" | tail -n 1)"
  [ -s "$BACKUP_FILE" ] || die "the database backup failed; nothing was changed."
  say "Backed up the live database (on $PREVIOUS) to $BACKUP_FILE"
elif [ "$MODE" = rollback ] && [ -s "${GSAM_RELEASE_EXISTING_BACKUP:-}" ]; then
  # A rollback after a failed one-click release: the failed version may have
  # taken the database down. Keep the backup taken before that release.
  BACKUP_FILE="$GSAM_RELEASE_EXISTING_BACKUP"
  say "The live database is not running; keeping the backup from before the failed release: $BACKUP_FILE"
else
  die "the live database is not running; cannot back it up. Nothing was changed."
fi

if [ "$MODE" = release ]; then
  base="live-$(date +%Y-%m-%d)"
  n=1
  while git -C "$RELEASE_REPO" rev-parse --verify --quiet "refs/tags/$base.$n" >/dev/null; do n=$((n + 1)); done
  LIVE_TAG="$base.$n"
  tag_live_release "$RELEASE_REPO" "$TAG" "$LIVE_TAG" "$TARGET"
  # The live-* tag stays local until live is healthy on it (GRE-239): a failed
  # release deletes it, so History never offers a version that never ran.
  trap 'drop_unpushed_live_tag "$RELEASE_REPO" "$LIVE_DIR" "$LIVE_TAG"' EXIT
  say "Tagged $TAG as $LIVE_TAG: $TITLE"
else
  LIVE_TAG="$TAG"
fi

release_phase switching
STARTED_BEFORE="$(health_field "$LIVE_URL" serverInfo.processStartedAt)"
git -C "$LIVE_DIR" fetch --quiet --tags origin
# A new live-* tag is not on origin yet; live takes it from the release repo.
[ "$MODE" = rollback ] || git -C "$LIVE_DIR" fetch --quiet "$RELEASE_REPO" "refs/tags/$LIVE_TAG:refs/tags/$LIVE_TAG"
git -C "$LIVE_DIR" checkout --quiet --detach "$LIVE_TAG"
say "Live checkout is on $LIVE_TAG ($(git -C "$LIVE_DIR" rev-parse --short HEAD))"
# Non-interactive so a pnpm store change cannot hang on a hidden prompt. Such a
# change purges node_modules under the running server; see the runbook.
(cd "$LIVE_DIR" && pnpm install --frozen-lockfile --prefer-offline \
  --config.confirm-modules-purge=false --reporter=silent </dev/null)

# The live server runs under dev-runner's "restart required" supervisor. It
# notices the changed files within a few seconds, then restarts on request.
# That restart is a hot restart (POST /api/health/dev-server/restart writes the
# hot-restart intent): detached runs are adopted, ACP runs are checkpointed into
# conversation retries, and the new server writes hot-restart-report.json.
release_phase restarting
POLL_SECONDS="${GSAM_RELEASE_POLL_SECONDS:-2}"
NEEDS_NEW_PROCESS=1
if [ -z "$STARTED_BEFORE" ]; then
  # No live server answered before the switch (for example a rollback after a
  # failed version): start it instead of asking it to restart.
  [ -x "$GS_ROOT/start-live.sh" ] || die "the live server is not running and there is no $GS_ROOT/start-live.sh. Live code is on $LIVE_TAG; start the live server by hand."
  "$GS_ROOT/start-live.sh" </dev/null || die "the live server did not start on $LIVE_TAG; see ~/GSAM/logs/live.log. Roll back with: scripts/greatstone-release.sh $PREVIOUS"
  say "Started the live server"
else
  RESTART=""
  for _ in $(seq 1 15); do
    sleep "$POLL_SECONDS"
    RESTART="$(live_curl -sS -m 10 -X POST "$LIVE_URL/api/health/dev-server/restart" 2>&1 || true)"
    case "$RESTART" in *restart_requested*|*board_access_required*|*dev_server_supervisor_unavailable*) break ;; esac
  done
  case "$RESTART" in
    *restart_requested*) say "Asked the live server to restart" ;;
    # GRE-243: for the whole wait, dev-runner saw no change to a file it
    # watches (cli, scripts, server, the server packages, a few root files) and
    # no pending migration: a release or rollback of only ui/, doc/ or other
    # files. The running server already serves that code (the UI through the
    # Vite middleware), so it ends healthy on the old process.
    *restart_not_required*)
      NEEDS_NEW_PROCESS=0
      say "The live server needs no restart: $LIVE_TAG changes no file the server runs from (for example only ui/ or doc/)." ;;
    *dev_server_supervisor_unavailable*) die "the live server has no dev-runner supervisor, so it cannot restart itself. Live code is on $LIVE_TAG but the old server still runs; stop the live server and run ~/GSAM/start-live.sh, or roll back with: scripts/greatstone-release.sh $PREVIOUS" ;;
    *board_access_required*) die "the live server refused the restart: it runs in login mode and $LIVE_BOARD_KEY_FILE holds no valid board API key. Live code is on $LIVE_TAG but the old server still runs; fix the key and restart live, or roll back with: scripts/greatstone-release.sh $PREVIOUS" ;;
    *) die "the live server did not accept a restart ($RESTART). Live code is on $LIVE_TAG but the old server still runs; stop the live server and run ~/GSAM/start-live.sh, or roll back with: scripts/greatstone-release.sh $PREVIOUS" ;;
  esac
fi

# "commit" follows the checkout at once, so success also needs a new process
# (unless no restart was needed).
for _ in $(seq 1 90); do
  sleep "$POLL_SECONDS"
  STARTED_NOW="$(health_field "$LIVE_URL" serverInfo.processStartedAt)"
  if [ -n "$STARTED_NOW" ] && { [ "$NEEDS_NEW_PROCESS" = 0 ] || [ "$STARTED_NOW" != "$STARTED_BEFORE" ]; } && [ "$(health_commit "$LIVE_URL")" = "$TARGET" ]; then
    say "Live app at $LIVE_URL is running $LIVE_TAG ($TARGET), server started $STARTED_NOW."
    if [ "$MODE" = release ]; then
      trap - EXIT
      GSAM_RELEASE=1 git -C "$RELEASE_REPO" push --quiet origin "refs/tags/$TAG" "refs/tags/$LIVE_TAG" \
        || say "Could not push $TAG and $LIVE_TAG to origin; live runs $LIVE_TAG. Push them with: GSAM_RELEASE=1 git push origin $TAG $LIVE_TAG"
    fi
    "$GS_SCRIPT_DIR/greatstone-preview.sh" stop
    say "Roll back with: scripts/greatstone-release.sh $PREVIOUS"
    say "Database backup from before this release: $BACKUP_FILE"
    exit 0
  fi
done
die "the live app did not report $LIVE_TAG within 3 minutes; check the server log. Roll back with: scripts/greatstone-release.sh $PREVIOUS (database backup: $BACKUP_FILE)"
