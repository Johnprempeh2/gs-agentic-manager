#!/usr/bin/env bash
# List tasks on live whose "blocked by" links form a loop, and remove one link.
#
#   scripts/greatstone-blocking-cycles.sh                    list every loop, with the id of each link
#   scripts/greatstone-blocking-cycles.sh --remove <link id> remove that one link (logged), then list again
#
# Startup recovery logs "task keeps blockers that already form a cycle" with
# the task ids when it meets one. Removing any one link in a loop breaks it.
# Reads the running live database (see live_database_url); exit 3 means loops remain.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/greatstone-common.sh"

LIVE_DB_URL="$(live_database_url)" || { echo "blocking-cycles: the live database is not running" >&2; exit 1; }
PGPASSWORD="$(live_database_password)" gs_db blocking-cycles --source-url "$LIVE_DB_URL" "$@"
