#!/usr/bin/env bash
# List the upstream (`paperclipai/paperclip`) commits we have not yet taken or skipped
# (see doc/GREATSTONE-WAY-OF-WORKING.md, "Taking upstream code").
#
#   scripts/upstream-pending.sh [--upstream <ref>] [--main <ref>] [--base <sha>] [--count]
#
# Upstream commits in <base>..<upstream> (default 01d9a1218..refs/upstream/master),
# minus:
#   - commits named in an `Upstream-Commit: <sha> taken|partial` line in any
#     commit message in <base>..<main> (default origin/main, else main),
#   - commits listed in doc/upstream-taken.txt (taken before the trailer rule),
#   - commits listed in doc/upstream-skipped.txt,
#   - commits `git cherry` finds as identical patches on <main>.
# Security-looking commits are listed first. A `partial` commit leaves the
# list, but is shown under "Partial" until a `taken` line or a skip line
# closes it.
#
# Read-only. It runs only `git log`, `git rev-parse` and `git cherry`. It never
# fetches: refresh the upstream ref first with
#   git fetch https://github.com/paperclipai/paperclip.git master:refs/upstream/master
# --count prints only the number of pending commits.
set -euo pipefail

BASE="01d9a1218"
UPSTREAM="refs/upstream/master"
MAIN=""
COUNT_ONLY=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --upstream) UPSTREAM="$2"; shift 2 ;;
    --main) MAIN="$2"; shift 2 ;;
    --base) BASE="$2"; shift 2 ;;
    --count) COUNT_ONLY=1; shift ;;
    -h|--help) sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

ROOT="$(git rev-parse --show-toplevel)"
TAKEN_FILE="$ROOT/doc/upstream-taken.txt"
SKIP_FILE="$ROOT/doc/upstream-skipped.txt"

if [ -z "$MAIN" ]; then
  if git rev-parse -q --verify origin/main^{commit} >/dev/null; then MAIN="origin/main"; else MAIN="main"; fi
fi
for ref in "$UPSTREAM" "$MAIN" "$BASE"; do
  if ! git rev-parse -q --verify "$ref^{commit}" >/dev/null; then
    echo "error: $ref is not a commit here." >&2
    [ "$ref" = "$UPSTREAM" ] && echo "fetch it first: git fetch https://github.com/paperclipai/paperclip.git master:$UPSTREAM" >&2
    exit 1
  fi
done

# Full sha of a recorded short sha, or empty with a warning.
resolve() {
  local full
  if full="$(git rev-parse -q --verify "$1^{commit}" 2>/dev/null)"; then
    printf '%s\n' "$full"
  else
    echo "warning: $2 names $1, which is not a commit here" >&2
  fi
}

# Sets of full shas, one per line (bash 3.2 on macOS has no associative arrays).
NL=$'\n'
TAKEN="$NL" PARTIAL="$NL" SKIPPED="$NL"
add() { eval "$1=\"\${$1}$2\$NL\""; }
has() { case "$1" in *"$NL$2$NL"*) return 0 ;; esac; return 1; }

# "Upstream-Commit: <sha> taken|partial" anywhere in a message, so the line
# still counts after a squash merge folds it into the body.
while read -r sha kind; do
  full="$(resolve "$sha" "an Upstream-Commit line on $MAIN")"
  [ -n "$full" ] || continue
  if [ "$kind" = "taken" ]; then add TAKEN "$full"; else add PARTIAL "$full"; fi
done < <(git log --format=%B "$BASE..$MAIN" \
  | sed -nE 's/^[[:space:]]*Upstream-Commit:[[:space:]]+([0-9a-fA-F]{7,40})[[:space:]]+(taken|partial)[[:space:]]*$/\1 \2/p')

# doc/upstream-taken.txt: "<sha> taken|partial <our commit> <note>".
if [ -f "$TAKEN_FILE" ]; then
  while read -r sha kind _; do
    case "$sha" in ''|'#'*) continue ;; esac
    full="$(resolve "$sha" "doc/upstream-taken.txt")"
    [ -n "$full" ] || continue
    case "$kind" in
      taken) add TAKEN "$full" ;;
      partial) add PARTIAL "$full" ;;
      *) echo "warning: doc/upstream-taken.txt: $sha has kind '$kind', not taken|partial" >&2 ;;
    esac
  done < "$TAKEN_FILE"
fi

# doc/upstream-skipped.txt: "<sha> <reason>".
if [ -f "$SKIP_FILE" ]; then
  while read -r sha _; do
    case "$sha" in ''|'#'*) continue ;; esac
    full="$(resolve "$sha" "doc/upstream-skipped.txt")"
    if [ -n "$full" ]; then add SKIPPED "$full"; fi
  done < "$SKIP_FILE"
fi

# Identical patches already on main (plain cherry-picks).
while read -r mark sha; do
  if [ "$mark" = "-" ]; then add TAKEN "$sha"; fi
done < <(git cherry "$MAIN" "$UPSTREAM" "$BASE")

# Security-looking: a security word in the subject, or a CVE/GHSA id anywhere.
# Upstream bodies are long, so security words in the body match too much.
SECURITY_SUBJECT_RE='\(auth|secur|vulnerab|xss|csrf|ssrf|inject|traversal|redact|leak|credential|secret|sanitiz|bypass|privilege|authoriz|authenticat|permission|grant|token|ownership'
SECURITY_ID_RE='cve-[0-9]{4}-[0-9]+|ghsa-[0-9a-z]{4}-'

security=() other=() partial=()
while read -r sha; do
  if has "$TAKEN" "$sha" || has "$SKIPPED" "$sha"; then continue; fi
  line="$(git log -1 --format='%h %cs %s' "$sha")"
  if has "$PARTIAL" "$sha"; then partial+=("$line"); continue; fi
  if git log -1 --format=%s "$sha" | grep -qiE "$SECURITY_SUBJECT_RE" \
    || git log -1 --format=%B "$sha" | grep -qiE "$SECURITY_ID_RE"; then
    security+=("$line")
  else
    other+=("$line")
  fi
done < <(git rev-list --reverse --no-merges "$BASE..$UPSTREAM")

pending=$(( ${#security[@]} + ${#other[@]} ))
if [ "$COUNT_ONLY" -eq 1 ]; then
  echo "$pending"
  exit 0
fi

total="$(git rev-list --count --no-merges "$BASE..$UPSTREAM")"
echo "Upstream $(git rev-parse --short "$UPSTREAM") vs $MAIN $(git rev-parse --short "$MAIN"), since $BASE"
echo "Upstream commits: $total. Pending: $pending. Partial: ${#partial[@]}."
section() {
  local title="$1"; shift
  echo
  echo "## $title ($#)"
  [ "$#" -gt 0 ] && printf '%s\n' "$@"
  return 0
}
section "Security-looking" ${security[@]+"${security[@]}"}
section "Other" ${other[@]+"${other[@]}"}
section "Partial (rest not yet taken or skipped)" ${partial[@]+"${partial[@]}"}
