#!/usr/bin/env bash
# Show how long each beta (experimental) switch has been on, for the beta
# graduation rule (a switch must be on in live for 2 weeks).
#
#   GSAM_API_URL=<base> [GSAM_API_KEY=<key>] [GSAM_COMPANY_ID=<id>] scripts/beta-switch-age.sh [--tests] [--scorecard <file>] [--failed-runs]
#
# One row per switch in GET /api/instance/settings/experimental: on/off, on
# since (date of the change that turned it on), days on, and 2-week rule met.
# Retired switches (RETIRED_INSTANCE_FEATURE_KEYS) show "retired". --tests
# adds "test files": tracked test files that name the switch, not counting
# files that name every switch (the settings list tests). --scorecard reads a
# saved copy of the beta scorecard (GRE-81 `scorecard` document) and lists
# catalog switches with no row ("no row") and rows naming a key no longer in
# the catalog ("gone"). --failed-runs lists, for each switch that is on, the
# failed, interrupted and cancelled runs since its "on since" time, grouped by
# error code with run ids. It does not decide which runs are linked to the
# switch; Beacon links or clears each group on the scorecard. If the run list
# cannot reach a switch's "on since" time the line ends "history cut at <time>".
# The dates come from the `instance.settings.experimental_updated` activity
# rows of one company (every change is logged for each company). A switch with
# no logged change shows "unknown"; the script does not guess.
#
# Read-only: it sends only GET requests and changes no setting. The company is
# GSAM_COMPANY_ID, else the company of the key's agent (GET /api/agents/me).
# Leave GSAM_API_KEY unset only for a local-trusted sandbox.
set -euo pipefail

ARGS=()
FAILED_RUNS=0
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --tests) ARGS+=(--tests) ;;
    --failed-runs) FAILED_RUNS=1 ;;
    --scorecard)
      [ -r "${2:-}" ] || { echo "--scorecard needs a readable file" >&2; exit 2; }
      ARGS+=(--scorecard "$2"); shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

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

REPORT="$(dirname "$0")/beta-switch-age.mjs"

if [ "$FAILED_RUNS" = 1 ]; then
  # Page back through the run list (newest first) to the earliest "on since".
  # `before` is the oldest createdAt of the last page plus 1 ms, so runs that
  # share that millisecond are read again rather than skipped; the merge drops
  # repeats. Paging stops when a page is short (complete), when it does not move
  # back (a server without the GRE-794 filters ignores `before`), or at the page cap.
  RUN_LIMIT=1000 # the run list route's maximum
  MAX_PAGES=20
  SINCE="$(node "$REPORT" "$TMP/settings.json" "$TMP/activity.json" --limit "$LIMIT" --earliest-on-since)"
  COMPLETE=0
  if [ -n "$SINCE" ]; then
    BEFORE=""
    PREV_OLDEST=""
    page=0
    while [ "$page" -lt "$MAX_PAGES" ]; do
      Q="status=failed,interrupted,cancelled&summary=true&limit=$RUN_LIMIT&since=$SINCE"
      [ -n "$BEFORE" ] && Q="$Q&before=$BEFORE"
      get "companies/$COMPANY_ID/heartbeat-runs?$Q" "$TMP/runs-$page.json"
      read -r COUNT OLDEST < <(node -e '
        const runs = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
        const oldest = runs.map((r) => r.createdAt).filter(Boolean).sort()[0];
        process.stdout.write(`${runs.length} ${oldest ? new Date(Date.parse(oldest) + 1).toISOString() : "-"}\n`);
      ' "$TMP/runs-$page.json")
      page=$((page + 1))
      if [ "$COUNT" -lt "$RUN_LIMIT" ]; then COMPLETE=1; break; fi
      # Same-format ISO times compare as strings.
      if [ "$OLDEST" = "-" ] || { [ -n "$PREV_OLDEST" ] && [[ ! "$OLDEST" < "$PREV_OLDEST" ]]; }; then break; fi
      PREV_OLDEST="$OLDEST"
      BEFORE="$OLDEST"
    done
  else
    COMPLETE=1
  fi
  node -e '
    const fs = require("fs");
    const [out, complete, ...files] = process.argv.slice(1);
    const byId = new Map();
    for (const file of files) for (const run of JSON.parse(fs.readFileSync(file, "utf8"))) byId.set(run.id, run);
    fs.writeFileSync(out, JSON.stringify({ runs: [...byId.values()], complete: complete === "1" }));
  ' "$TMP/runs.json" "$COMPLETE" $(ls "$TMP"/runs-*.json 2>/dev/null)
  ARGS+=(--failed-runs "$TMP/runs.json")
fi

node "$REPORT" "$TMP/settings.json" "$TMP/activity.json" --limit "$LIMIT" ${ARGS[@]+"${ARGS[@]}"}
