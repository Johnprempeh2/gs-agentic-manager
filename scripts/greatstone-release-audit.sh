#!/usr/bin/env bash
# Release audit (GRE-767): what live runs against John's open release task,
# and which live-* tags of the last days had no Flint check.
#
#   scripts/greatstone-release-audit.sh [days]   (default 7)
#
# Keystone runs it at the start of each daily candidate step; Flint runs it at
# the start of each live check. Only the tag live now can get a live check, so
# a past tag with no live check shows "missed (no longer live)". The last line
# is the one action: "action: one live check of <tag>" or "action: none"
# (doc/GREATSTONE-WAY-OF-WORKING.md, GRE-919).
#
# Read-only. It reads $LIVE_URL/api/health, searches issues on the same server
# and reads tags in the release repo. It makes no tag, issue or comment and
# sends no write to the live server. The only local change is `git fetch
# origin`, which updates the copies of origin's refs.
#
# Issue search uses GSAM_API_KEY when it is set (an agent run), else the board
# key in GSAM_LIVE_BOARD_KEY_FILE, else no login (local_trusted). The company is
# GSAM_COMPANY_ID, else the company with issue prefix GRE, else the first one.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/greatstone-common.sh"

die() { printf 'release-audit: %s\n' "$*" >&2; exit 1; }

DAYS="${1:-7}"
case "$DAYS" in ''|*[!0-9]*) die "usage: greatstone-release-audit.sh [days]" ;; esac

# issues <query>: one GET issue search on the live server. Prints one line per
# issue: identifier, status, title (tab-separated).
issues() {
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const [base, keyFile, query] = process.argv.slice(1);
    let key = process.env.GSAM_API_KEY ?? "";
    if (!key) { try { key = readFileSync(keyFile, "utf8").trim(); } catch {} }
    const headers = key ? { authorization: `Bearer ${key}` } : {};
    const get = async (p) => {
      const res = await fetch(base + p, { headers });
      if (!res.ok) {
        console.error(`GET ${p} answered ${res.status} ${(await res.text()).slice(0, 200)}`);
        process.exit(1);
      }
      return res.json();
    };
    let company = process.env.GSAM_COMPANY_ID ?? "";
    if (!company) {
      const list = await get("/api/companies");
      company = (list.find((c) => c.issuePrefix === "GRE") ?? list[0])?.id ?? "";
      if (!company) { console.error("the live server has no company"); process.exit(1); }
    }
    const body = await get(`/api/companies/${company}/issues?q=${encodeURIComponent(query)}&limit=100`);
    for (const i of Array.isArray(body) ? body : (body.items ?? body.issues ?? [])) {
      console.log([i.identifier, i.status, String(i.title).replace(/[\t\n]/g, " ")].join("\t"));
    }
  ' "$LIVE_URL" "$LIVE_BOARD_KEY_FILE" "$1"
}

# Regex for any of the space-separated <tags> as a whole word in a title:
# rc-2026-10-01.1 must not match rc-2026-10-01.10.
tag_regex() { local t="${1//./\\.}"; printf '(^|[^0-9A-Za-z.-])(%s)([^0-9]|$)' "${t// /|}"; }

# tags_at <commit> <pattern>: the tags that point at <commit>, space-separated.
tags_at() { git -C "$RELEASE_REPO" tag --points-at "$1" --list "$2" | sort -V | paste -sd ' ' -; }

# verdict <live-commit> <task-commit>: match, live moved past task (<tag>) or live behind task.
verdict() {
  local live="$1" task="$2" at
  if [ "$live" = "$task" ]; then
    say "match"
  elif git -C "$RELEASE_REPO" merge-base --is-ancestor "$live" "$task" 2>/dev/null; then
    say "live behind task"
  else
    at="$(tags_at "$live" 'live-*')"
    say "live moved past task (${at:-${live:0:9}})"
  fi
}

# check_state <search-lines> <rc tags> <preview|live>: checked (GRE-n), open (GRE-n) or NOT CHECKED.
# A preview check names the rc and "preview" in its title; a live check names
# the rc and "live check" or "check live". A cancelled check does not count.
check_state() {
  local lines="$1" rc="$2" kind="$3" kind_re hits done_id open_id
  case "$kind" in
    preview) kind_re='preview' ;;
    live) kind_re='live check|check live' ;;
  esac
  hits="$(printf '%s\n' "$lines" | awk -F '\t' 'NF >= 3' \
    | grep -E "$(tag_regex "$rc")" | grep -iE "$kind_re" | grep -vE $'\tJohn:' || true)"
  done_id="$(printf '%s\n' "$hits" | awk -F '\t' '$2 == "done" { print $1; exit }')"
  open_id="$(printf '%s\n' "$hits" | awk -F '\t' '$2 != "done" && $2 != "cancelled" && $1 != "" { print $1; exit }')"
  if [ -n "$done_id" ]; then say "checked ($done_id)"
  elif [ -n "$open_id" ]; then say "open ($open_id)"
  else say "NOT CHECKED"
  fi
}

git -C "$RELEASE_REPO" fetch --quiet --tags origin 2>/dev/null \
  && git -C "$RELEASE_REPO" fetch --quiet origin main 2>/dev/null \
  || say "(could not fetch origin; using the local tags and origin/main)"

# --- Now -------------------------------------------------------------------
LIVE_TAGS=""
LIVE_COMMIT="$(health_commit "$LIVE_URL")"
[ -n "$LIVE_COMMIT" ] || die "the live server at $LIVE_URL does not answer /api/health with a commit."
say "Now"
say "  live commit:   $LIVE_COMMIT"
if git -C "$RELEASE_REPO" cat-file -e "$LIVE_COMMIT^{commit}" 2>/dev/null; then
  LIVE_TAGS="$(tags_at "$LIVE_COMMIT" 'live-*')"
  RC_TAGS="$(tags_at "$LIVE_COMMIT" 'rc-*')"
  say "  live tags:     ${LIVE_TAGS:-none}"
  say "  rc tags:       ${RC_TAGS:-none}"
  if git -C "$RELEASE_REPO" rev-parse --verify --quiet origin/main >/dev/null; then
    say "  origin/main:   $(git -C "$RELEASE_REPO" rev-list --count "$LIVE_COMMIT..origin/main") commit(s) not yet live"
  fi
else
  say "  (the release repo does not have this commit; fetch origin)"
fi

TASK_LINES="$(issues "John: release")" || die "the issue search on $LIVE_URL failed (see above)."
TASK="$(printf '%s\n' "$TASK_LINES" | awk -F '\t' '$2 != "done" && $2 != "cancelled" && $3 ~ /^John: release rc-/' | head -n 1)"
if [ -z "$TASK" ]; then
  say "  release task:  none open"
  say "  verdict:       no open release task"
else
  TASK_ID="$(printf '%s' "$TASK" | cut -f1)"
  TASK_TAG="$(printf '%s' "$TASK" | cut -f3 | sed -E 's/^John: release (rc-[^ ]+).*/\1/')"
  say "  release task:  $TASK_ID names $TASK_TAG"
  TASK_COMMIT="$(git -C "$RELEASE_REPO" rev-parse --verify --quiet "refs/tags/$TASK_TAG^{commit}")" \
    || die "$TASK_ID names $TASK_TAG, but the release repo has no such tag."
  say "  verdict:       $(verdict "$LIVE_COMMIT" "$TASK_COMMIT")"
fi

# --- Last N days -----------------------------------------------------------
say ""
say "Last $DAYS days"
printf '  %-20s %-11s %-20s %-20s %s\n' "live tag" "date" "rc tag" "preview check" "live check"
SINCE=$(( $(date +%s) - DAYS * 86400 ))
ROWS=0
ACTION="none"
while read -r tag when day; do
  [ "$when" -ge "$SINCE" ] || continue
  ROWS=$((ROWS + 1))
  commit="$(git -C "$RELEASE_REPO" rev-parse "refs/tags/$tag^{commit}")"
  # Two rc tags can share a commit (a candidate cut again with no new merge); a check of either counts.
  rc="$(tags_at "$commit" 'rc-*')"
  preview="NOT CHECKED"
  live="NOT CHECKED"
  if [ -n "$rc" ]; then
    lines=""
    for one in $rc; do
      lines+="$(issues "$one")"$'\n' || die "the issue search on $LIVE_URL failed (see above)."
    done
    preview="$(check_state "$lines" "$rc" preview)"
    live="$(check_state "$lines" "$rc" live)"
  fi
  # Only the tag live now can still get a live check; for a past tag it was missed.
  if [ "$live" = "NOT CHECKED" ]; then
    case " $LIVE_TAGS " in
      *" $tag "*) ACTION="one live check of $tag" ;;
      *) live="missed (no longer live)" ;;
    esac
  fi
  printf '  %-20s %-11s %-20s %-20s %s\n' "$tag" "$day" "${rc:--}" "$preview" "$live"
done < <(git -C "$RELEASE_REPO" for-each-ref --sort=creatordate \
  --format='%(refname:short) %(creatordate:unix) %(creatordate:short)' 'refs/tags/live-*')
[ "$ROWS" -gt 0 ] || say "  no live-* tags in the last $DAYS days"
say ""
say "action: $ACTION"
exit 0
