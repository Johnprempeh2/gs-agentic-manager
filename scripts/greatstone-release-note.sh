#!/usr/bin/env bash
# List the pull requests merged since the last live tag, for the release note
# (see doc/GREATSTONE-WAY-OF-WORKING.md, "Releasing").
#
#   scripts/greatstone-release-note.sh <last-live-tag> [ref] [--no-gh] [--no-app]
#
# One line per merge on the first-parent history of <ref> (default origin/main)
# after <last-live-tag>: the pull request, the GRE id, the title and the
# issue's "Done when" items. A pull request with no GRE id in its title or
# branch name is flagged "NO GRE ID". A commit on main with no pull request is
# flagged "NO PR".
#
# Read-only. It runs only `git log` / `git rev-parse`, `gh pr view` (for the
# branch of a squash merge; --no-gh skips it) and `curl` GET on
# /api/issues/<id> (for "Done when"; --no-app skips it). It never writes to
# git, GitHub or the app.
#
# App to read: GSAM_API_URL with GSAM_API_KEY when set (agent runs), else
# GSAM_LIVE_URL (default http://localhost:3100) with the board key in
# GSAM_LIVE_BOARD_KEY_FILE (default ~/GSAM/release-board-key) when it exists.
set -euo pipefail

PREFIX="${GSAM_COMPANY_PREFIX:-GRE}"
REPO="${GSAM_GITHUB_REPO:-Johnprempeh2/gs-agentic-manager}"
USE_GH=1
USE_APP=1
ARGS=()
for a in "$@"; do
  case "$a" in
    --no-gh) USE_GH=0 ;;
    --no-app) USE_APP=0 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown option: $a" >&2; exit 2 ;;
    *) ARGS+=("$a") ;;
  esac
done
if [ "${#ARGS[@]}" -lt 1 ] || [ "${#ARGS[@]}" -gt 2 ]; then
  echo "usage: greatstone-release-note.sh <last-live-tag> [ref] [--no-gh] [--no-app]" >&2
  exit 2
fi
SINCE="${ARGS[0]}"
UNTIL="${ARGS[1]:-origin/main}"
git rev-parse --verify --quiet "$SINCE^{commit}" >/dev/null || { echo "unknown tag or ref: $SINCE" >&2; exit 2; }
git rev-parse --verify --quiet "$UNTIL^{commit}" >/dev/null || { echo "unknown ref: $UNTIL" >&2; exit 2; }

API_BASE=""
AUTH=""
if [ "$USE_APP" = 1 ]; then
  if [ -n "${GSAM_API_URL:-}" ]; then
    API_BASE="${GSAM_API_URL%/}"; API_BASE="${API_BASE%/api}"
    AUTH="${GSAM_API_KEY:-}"
  else
    API_BASE="${GSAM_LIVE_URL:-http://localhost:3100}"
    user_home="$(perl -e 'print((getpwuid($<))[7])' 2>/dev/null || true)"
    key_file="${GSAM_LIVE_BOARD_KEY_FILE:-${GSAM_ROOT:-${user_home:-$HOME}/GSAM}/release-board-key}"
    [ -r "$key_file" ] && AUTH="$(tr -d '[:space:]' <"$key_file")"
  fi
fi

gre_id() { grep -oE "${PREFIX}-[0-9]+" <<<"$1" | head -n1 || true; }

# "Done when" items of an issue description, joined with "; ". Takes a
# "**Done when** (note):" heading with a list under it, and "Done when: text".
done_when() {
  awk '
    !on && /^[[:space:]]*(#+[[:space:]]*)?(\*\*)?Done when/ {
      on = 1
      rest = $0
      sub(/^[[:space:]]*(#+[[:space:]]*)?(\*\*)?Done when(\*\*)?:?(\*\*)?:?[[:space:]]*/, "", rest)
      if (rest != "" && rest !~ /^\(/) items[++n] = rest
      next
    }
    on && /^[[:space:]]*$/ { if (n) exit; next }
    on && /^[[:space:]]*([-*]|[0-9]+\.)[[:space:]]+/ { sub(/^[[:space:]]*([-*]|[0-9]+\.)[[:space:]]+(\[[ xX]\][[:space:]]+)?/, ""); items[++n] = $0; next }
    on { if (n) exit; on = 0 }
    END { for (i = 1; i <= n; i++) printf "%s%s", (i > 1 ? "; " : ""), items[i] }
  '
}

issue_done_when() {
  local id="$1" body
  [ "$USE_APP" = 1 ] || { printf '(app not read)'; return; }
  local hdr=()
  [ -n "$AUTH" ] && hdr=(-H "Authorization: Bearer $AUTH")
  body="$(curl -sf --max-time 10 ${hdr[@]+"${hdr[@]}"} "$API_BASE/api/issues/$id" 2>/dev/null)" || { printf '(issue not read)'; return; }
  local text
  text="$(jq -r '.description // ""' <<<"$body" | done_when)"
  printf '%s' "${text:-(no Done when in issue)}"
}

count=0
flagged=0
while IFS=$'\x1f' read -r -d $'\x1e' sha subject body; do
  sha="${sha#$'\n'}"
  [ -n "$sha" ] || continue
  pr="" branch="" title="$subject"
  if [[ "$subject" =~ ^Merge\ pull\ request\ \#([0-9]+)\ from\ [^/[:space:]]+/([^[:space:]]+) ]]; then
    pr="${BASH_REMATCH[1]}"; branch="${BASH_REMATCH[2]}"
    first="$(awk 'NF { print; exit }' <<<"$body")"
    title="${first:-$branch}"
  elif [[ "$subject" =~ ^(.*)\ \(\#([0-9]+)\)$ ]]; then
    title="${BASH_REMATCH[1]}"; pr="${BASH_REMATCH[2]}"
    if [ "$USE_GH" = 1 ]; then
      branch="$(gh pr view "$pr" --repo "$REPO" --json headRefName --jq .headRefName 2>/dev/null || true)"
    fi
  fi
  count=$((count + 1))
  id="$(gre_id "$title")"
  [ -n "$id" ] || id="$(gre_id "$branch")"
  ref="${pr:+#$pr}"; ref="${ref:-commit ${sha:0:9}}"
  if [ -z "$pr" ]; then
    flagged=$((flagged + 1))
    printf -- '- %s NO PR %s\n' "$ref" "$title"
  elif [ -z "$id" ]; then
    flagged=$((flagged + 1))
    printf -- '- %s NO GRE ID %s (branch: %s)\n' "$ref" "$title" "${branch:-unknown}"
  else
    printf -- '- %s %s %s — Done when: %s\n' "$ref" "$id" "$title" "$(issue_done_when "$id")"
  fi
done < <(git log --first-parent --reverse --format='%H%x1f%s%x1f%b%x1e' "$SINCE..$UNTIL")

printf '%d merged since %s (to %s); %d flagged.\n' "$count" "$SINCE" "$UNTIL" "$flagged"
