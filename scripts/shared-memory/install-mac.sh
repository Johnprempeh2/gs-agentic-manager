#!/usr/bin/env bash
# Installs the shared memory sync on John's Mac (GRE-2668). Run from a checkout of main:
#   scripts/shared-memory/install-mac.sh --company-id <GSAM company id> [--gsam-url https://gsam.<tailnet>.ts.net:3100]
#   scripts/shared-memory/install-mac.sh --uninstall
# It copies three files, writes the config (no tokens) and loads a launchd job that runs every 30 minutes.
# Tokens stay in the macOS Keychain; this script never reads or prints them.
set -euo pipefail

LABEL=com.greatstone.gs-memory-sync
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$HOME/Library/Application Support/gs-memory-sync/bin"
CONF="$HOME/.config/gs-memory-sync"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/gs-memory-sync.log"

[ "$(uname -s)" = "Darwin" ] || { echo "This installer is for macOS." >&2; exit 1; }

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  rm -rf "$BIN"
  echo "Removed the job and the script. Config and state are kept in $CONF (delete it to start over)."
  exit 0
fi

COMPANY_ID=""
GSAM_URL="https://gsam.tail83d26c.ts.net:3100"
while [ $# -gt 0 ]; do
  case "$1" in
    --company-id) COMPANY_ID="$2"; shift 2 ;;
    --gsam-url) GSAM_URL="$2"; shift 2 ;;
    *) echo "Unknown option $1" >&2; exit 1 ;;
  esac
done

NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "node is not on PATH (Claude Code needs it too)." >&2; exit 1; }
"$NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' || { echo "Node 18 or newer is needed." >&2; exit 1; }

mkdir -p "$BIN" "$(dirname "$PLIST")" "$(dirname "$LOG")"
mkdir -p -m 700 "$CONF"
install -m 644 "$HERE/gs-memory-sync.mjs" "$HERE/redact.mjs" "$HERE/extract.mjs" "$BIN/"

if [ ! -f "$CONF/config.json" ]; then
  [ -n "$COMPANY_ID" ] || { echo "First install needs --company-id." >&2; exit 1; }
  "$NODE" -e '
    const [file, companyId, gsamUrl] = process.argv.slice(1);
    require("fs").writeFileSync(file, JSON.stringify({ gsamUrl, companyId }, null, 2) + "\n", { mode: 0o600 });
  ' "$CONF/config.json" "$COMPANY_ID" "$GSAM_URL"
  echo "Wrote $CONF/config.json"
fi

sed -e "s|@NODE@|$NODE|g" -e "s|@BIN@|$BIN|g" -e "s|@LOG@|$LOG|g" "$HERE/$LABEL.plist" > "$PLIST"
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "Loaded $LABEL (every 30 minutes). Log: $LOG"
echo "Check it:  $NODE \"$BIN/gs-memory-sync.mjs\" check"
