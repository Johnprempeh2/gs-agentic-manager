#!/bin/bash
# Removes GSAM from this Mac (GRE-6097): the log-in item, the GSAM app and its
# Dock icon, and ~/GSAM-Aura (code, data, backups, logs).
#
#   bash uninstall.sh            asks first
#   bash uninstall.sh --yes      no question (for scripts)
#   bash uninstall.sh --keep-backups   copies the backups to ~/GSAM-Aura-backups first
#
# Not removed: the Claude and ChatGPT accounts themselves (sign out of them on
# their websites if you want), and Tailscale if you installed it.
set -euo pipefail

HOME_DIR="${GSAM_AURA_HOME:-$HOME/GSAM-Aura}"
LABEL="com.gsam.aura"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
BUNDLE="$HOME/Applications/GSAM.app"
YES=0 KEEP=0
for arg in "$@"; do
  case "$arg" in
    --yes) YES=1 ;;
    --keep-backups) KEEP=1 ;;
    *) echo "uninstall.sh: unknown option $arg" >&2; exit 2 ;;
  esac
done
say() { printf '[gsam] %s\n' "$*"; }

if [ "$YES" != 1 ]; then
  printf 'This deletes GSAM and ALL its data in %s. Type DELETE to go on: ' "$HOME_DIR"
  read -r answer
  [ "$answer" = "DELETE" ] || { say "nothing removed"; exit 1; }
fi

say "1/5 stop GSAM and remove the log-in item"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
if [ -f "$HOME_DIR/data/instances/default/config.json" ] && [ -x "$HOME_DIR/app/node/bin/node" ]; then
  ports="$("$HOME_DIR/app/node/bin/node" -p 'const c=require(process.argv[1]);c.server.port+" "+c.database.embeddedPostgresPort' "$HOME_DIR/data/instances/default/config.json")"
  for _ in $(seq 1 60); do
    busy=0
    for p in $ports; do nc -z 127.0.0.1 "$p" 2>/dev/null && busy=1; done
    [ "$busy" = 0 ] && break
    sleep 1
  done
fi

say "2/5 GSAM app and Dock icon"
rm -rf "$BUNDLE"
if defaults read com.apple.dock persistent-apps 2>/dev/null | grep -q "GSAM.app"; then
  tmp="$(mktemp -d)/dock.plist"
  defaults export com.apple.dock "$tmp"
  count=0
  while /usr/libexec/PlistBuddy -c "Print :persistent-apps:$count" "$tmp" >/dev/null 2>&1; do count=$((count + 1)); done
  # Last to first, so a deletion does not shift the entries still to check.
  i=$((count - 1))
  while [ "$i" -ge 0 ]; do
    url="$(/usr/libexec/PlistBuddy -c "Print :persistent-apps:$i:tile-data:file-data:_CFURLString" "$tmp" 2>/dev/null || true)"
    case "$url" in *GSAM.app*) /usr/libexec/PlistBuddy -c "Delete :persistent-apps:$i" "$tmp" ;; esac
    i=$((i - 1))
  done
  defaults import com.apple.dock "$tmp"
  killall Dock 2>/dev/null || true
fi

say "3/5 backups"
if [ "$KEEP" = 1 ] && [ -d "$HOME_DIR/data/instances/default/data/backups" ]; then
  dest="$HOME/GSAM-Aura-backups-$(date +%Y%m%d-%H%M%S)"
  cp -R "$HOME_DIR/data/instances/default/data/backups" "$dest"
  say "backups copied to $dest"
fi

say "4/5 code, data, backups and logs ($HOME_DIR)"
rm -rf "$HOME_DIR"

say "5/5 check"
left=""
for path in "$HOME_DIR" "$PLIST" "$BUNDLE"; do [ ! -e "$path" ] || left="$left $path"; done
[ -z "$left" ] || { echo "[gsam] error: still there:$left" >&2; exit 1; }
say "GSAM is removed from this Mac."
