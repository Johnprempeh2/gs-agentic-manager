#!/bin/bash
# Smoke test of the Aura macOS package (GRE-6097) on a clean Mac: the GitHub
# Actions macOS runner. Never on a real install: it makes test log-ins and
# ends with the uninstall.
#
#   scripts/aura-macos/smoke-test.sh <package .tar.gz>
set -euo pipefail

TGZ="$(cd "$(dirname "${1:?usage: smoke-test.sh <package .tar.gz>}")" && pwd)/$(basename "$1")"
HERE="$(cd "$(dirname "$0")" && pwd)"
HOME_DIR="$HOME/GSAM-Aura"
[ ! -e "$HOME_DIR" ] || { echo "smoke-test: $HOME_DIR exists; run on a clean machine" >&2; exit 1; }
SCRATCH="$(mktemp -d)"
step() { printf '\n==> %s\n' "$*"; }

step "unpack"
tar -xzf "$TGZ" -C "$SCRATCH"
PKG="$(find "$SCRATCH" -maxdepth 1 -type d -name 'gsam-aura-macos-*' | head -1)"
export EXPECT_TEMPLATE=0
[ ! -d "$PKG/app/template/aura" ] || EXPECT_TEMPLATE=1

step "install from scratch"
bash "$PKG/install.sh" --no-open --no-dock
CTL="$HOME_DIR/app/bin/gsam-aura"
NODE="$HOME_DIR/app/node/bin/node"
URL="$("$CTL" url)"
test -f "$HOME/Library/LaunchAgents/com.gsam.aura.plist"
test -x "$HOME/Applications/GSAM.app/Contents/MacOS/GSAM"
launchctl print "gui/$(id -u)/com.gsam.aura" | grep -E 'state = running'
"$HOME_DIR/app/bin/claude" --version
"$HOME_DIR/app/bin/codex" --version
# Not developer mode: the log-in item runs the built server, and the installed
# runner is the prebuilt one (macOS accepts its signature after the copy).
! pgrep -fl 'pnpm|tsx watch|vite' | grep -F "$HOME_DIR" || { echo "a developer-mode process runs" >&2; exit 1; }
RUNNER="$(find "$HOME_DIR/app/payload" -type f -name paperclip-runnerd | head -1)"
test -x "$RUNNER"
codesign --verify "$RUNNER"

step "first run: owner link, Aura only, cap 2"
"$NODE" "$HERE/smoke-test.mjs" first-run "$URL" "$HOME_DIR/logs/server.log" "$SCRATCH/state.json"

step "finish setup: close public sign-up, restart through the log-in item"
GSAM_AURA_NO_OPEN=1 "$CTL" claim 5

step "invite flow (the owner invites a helper, as for John's optional access)"
"$NODE" "$HERE/smoke-test.mjs" invite "$URL" "$SCRATCH/state.json"

step "Tailscale commands refuse cleanly when Tailscale is missing"
if [ ! -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] && ! command -v tailscale >/dev/null; then
  for cmd in telegram phone; do
    ! "$CTL" "$cmd" on 2> "$SCRATCH/ts.err" || { echo "gsam-aura $cmd ran without Tailscale" >&2; exit 1; }
    grep -q "Tailscale is not installed" "$SCRATCH/ts.err"
  done
  if grep -q GSAM_CHAT_WEBHOOK_PUBLIC_URL "$HOME_DIR/data/instances/default/.env"; then echo "webhook URL set without Funnel" >&2; exit 1; fi
fi

step "status and backup"
"$CTL" status
"$NODE" "$HERE/smoke-test.mjs" restore "$URL" before-backup "$SCRATCH/state.json"
"$CTL" backup
BACKUP="$(ls -t "$HOME_DIR/data/instances/default/data/backups"/*.sql* 2>/dev/null | head -1)"
[ -n "$BACKUP" ] || { echo "no backup file" >&2; exit 1; }

step "restore: data in the backup comes back, data made after it goes"
printf '\037\213\010\000' > "$SCRATCH/damaged.sql.gz"  # a gzip header and nothing after it
! "$CTL" restore "$SCRATCH/damaged.sql.gz" || { echo "restore took a damaged file" >&2; exit 1; }
"$NODE" "$HERE/smoke-test.mjs" restore "$URL" after-backup "$SCRATCH/state.json"
"$CTL" restore "$BACKUP"
"$NODE" "$HERE/smoke-test.mjs" restore "$URL" restored "$SCRATCH/state.json"
ls -d "$HOME_DIR/data/instances/default/db.before-restore-"* >/dev/null || { echo "the database from before was not kept" >&2; exit 1; }
launchctl print "gui/$(id -u)/com.gsam.aura" | grep -E 'state = running'

step "the log-in item restarts GSAM after a crash"
pid="$(launchctl print "gui/$(id -u)/com.gsam.aura" | awk '/^\tpid = /{print $3}')"
kill -9 "$pid"
sleep 15
for _ in $(seq 1 60); do curl -fsS "$URL/api/health" >/dev/null 2>&1 && break; sleep 2; done
curl -fsS "$URL/api/health" | grep -q '"status":"ok"'

step "uninstall"
bash "$PKG/uninstall.sh" --yes
for path in "$HOME_DIR" "$HOME/Library/LaunchAgents/com.gsam.aura.plist" "$HOME/Applications/GSAM.app"; do
  [ ! -e "$path" ] || { echo "still there after uninstall: $path" >&2; exit 1; }
done
! curl -fsS --max-time 3 "$URL/api/health" >/dev/null 2>&1 || { echo "GSAM still answers after uninstall" >&2; exit 1; }
rm -rf "$SCRATCH"
printf '\nSMOKE TEST PASSED\n'
