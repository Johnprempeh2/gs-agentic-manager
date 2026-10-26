#!/usr/bin/env bash
# One-time setup of the shared memory on John's Mac (GRE-2668), in John's own terminal:
#   scripts/shared-memory/setup-mac.sh --company-id <GSAM company id>
# 1. Asks for the Claude Code token, then the Codex token (from GSAM: Memory > Claude and ChatGPT > Connect).
#    Each is typed into the macOS Keychain prompt; it never reaches the screen, a file or shell history.
# 2. Installs the 30-minute sync (install-mac.sh) and runs its check.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ "$(uname -s)" = "Darwin" ] || { echo "This setup is for macOS." >&2; exit 1; }

store() {
  local service="$1" label="$2"
  if security find-generic-password -s "$service" >/dev/null 2>&1; then
    read -r -p "A $label token is already in the Keychain. Replace it? [y/N] " answer
    [ "${answer:-N}" = "y" ] || return 0
  fi
  echo
  echo "In GSAM open Memory > Claude and ChatGPT, click Connect for $label and copy the token."
  echo "Paste it at the Keychain prompt below (twice). Nothing is shown while you paste."
  security add-generic-password -U -s "$service" -a gsam -l "GS shared memory ($label)" -T /usr/bin/security -w
}

store gs-memory-claude-code "Claude Code"
store gs-memory-codex "Codex"
"$HERE/install-mac.sh" "$@"
node "$HOME/Library/Application Support/gs-memory-sync/bin/gs-memory-sync.mjs" check
