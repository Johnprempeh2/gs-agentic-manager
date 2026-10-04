#!/usr/bin/env bash
# Show how long each beta (experimental) switch has been on, for the beta
# graduation rule (a switch must be on in live for 2 weeks).
#
#   GSAM_API_URL=<base> [GSAM_API_KEY=<key>] [GSAM_COMPANY_ID=<id>] scripts/beta-switch-age.sh [--tests]
#
# One row per switch in GET /api/instance/settings/experimental: on/off, on
# since (date of the change that turned it on), days on, and 2-week rule met.
# Retired switches (RETIRED_INSTANCE_FEATURE_KEYS) show "retired". --tests
# adds "test files": tracked test files that name the switch, not counting
# files that name every switch (the settings list tests).
# The dates come from the `instance.settings.experimental_updated` activity
# rows of one company (every change is logged for each company). A switch with
# no logged change shows "unknown"; the script does not guess.
#
# Read-only: it sends only GET requests and changes no setting. The company is
# GSAM_COMPANY_ID, else the company of the key's agent (GET /api/agents/me).
# Leave GSAM_API_KEY unset only for a local-trusted sandbox.
set -euo pipefail

case "${1:-}" in
  -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  ""|--tests) ;;
  *) echo "unknown argument: $1" >&2; exit 2 ;;
esac

: "${GSAM_API_URL:?set GSAM_API_URL to the API base, e.g. http://127.0.0.1:3101}"
BASE="${GSAM_API_URL%/}"
BASE="${BASE%/api}"
LIMIT=500 # the activity route's maximum

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

AUTH=()
[ -n "${GSAM_API_KEY:-}" ] && AUTH=(-H "Authorization: Bearer $GSAM_API_KEY")
get() {
  curl -fsS -X GET ${AUTH[@]+"${AUTH[@]}"} "$BASE/api/$1" -o "$2"
}

COMPANY_ID="${GSAM_COMPANY_ID:-}"
if [ -z "$COMPANY_ID" ]; then
  get "agents/me" "$TMP/me.json"
  COMPANY_ID="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).companyId ?? ""))' "$TMP/me.json")"
  [ -n "$COMPANY_ID" ] || { echo "error: set GSAM_COMPANY_ID (the key has no agent company)" >&2; exit 1; }
fi

get "instance/settings/experimental" "$TMP/settings.json"
get "companies/$COMPANY_ID/activity?action=instance.settings.experimental_updated&limit=$LIMIT" "$TMP/activity.json"

node "$(dirname "$0")/beta-switch-age.mjs" "$TMP/settings.json" "$TMP/activity.json" --limit "$LIMIT" ${1:+"$1"}
