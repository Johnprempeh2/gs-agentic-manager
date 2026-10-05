#!/usr/bin/env bash
# List the upstream (`paperclipai/paperclip`) commits we have not yet taken or skipped
# (see doc/GREATSTONE-WAY-OF-WORKING.md, "Taking upstream code").
#
#   scripts/upstream-pending.sh [--upstream <ref>] [--main <ref>] [--base <sha>] [--count] [--clash]
#                               [--advisories]
#
# Upstream commits in <base>..<upstream> (default 01d9a1218..refs/upstream/master),
# minus:
#   - commits already in <main> (a sync merge brought them in); the header
#     names the newest of them as "Synced to",
#   - commits named in an `Upstream-Commit: <sha> taken|partial` line in any
#     commit message in <base>..<main> (default origin/main, else main),
#   - commits listed in doc/upstream-taken.txt (taken before the trailer rule),
#   - commits listed in doc/upstream-skipped.txt,
#   - commits `git cherry` finds as identical patches on <main>.
# Security-looking commits are listed first. A `partial` commit leaves the
# list, but is shown under "Partial" until a `taken` line or a skip line
# closes it.
#
# Read-only. It runs only `git log`, `git rev-parse`, `git cherry` and (with
# --clash) `git merge-tree`. It never fetches: refresh the upstream ref first with
#   git fetch https://github.com/paperclipai/paperclip.git master:refs/upstream/master
# --count prints only the number of pending commits.
# --clash adds "clean" or "conflict: <files>" to each listed commit: the result of
# cherry-picking it alone onto <main>, by `git merge-tree` (git 2.40+). No worktree,
# index or ref change.
# A commit that adds a migration (packages/db/src/migrations/NNNN_*.sql) gets
# "[migration: NNNN clash]" when <main> has its own NNNN_*.sql, else "NNNN free".
# Different file names merge without a conflict, so --clash does not see it.
# Renumber steps: doc/DATABASE.md, "Taking upstream migrations".
# --advisories also reads upstream's security advisories (`gh api`, read-only)
# and compares them with doc/upstream-advisories.txt. It prints NEW (not in the
# file), CHANGED (updated_at moved) and OPEN (verdict still `check`) lines, and
# lists a pending commit as security when an advisory names its sha or PR
# number. Needs `gh` and `node`. Findings do not change the exit code.
set -euo pipefail

BASE="01d9a1218"
UPSTREAM="refs/upstream/master"
MAIN=""
COUNT_ONLY=0
CLASH=0
ADVISORIES=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --upstream) UPSTREAM="$2"; shift 2 ;;
    --main) MAIN="$2"; shift 2 ;;
    --base) BASE="$2"; shift 2 ;;
    --count) COUNT_ONLY=1; shift ;;
    --clash) CLASH=1; shift ;;
    --advisories) ADVISORIES=1; shift ;;
    -h|--help) sed -n '2,36p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

ROOT="$(git rev-parse --show-toplevel)"
TAKEN_FILE="$ROOT/doc/upstream-taken.txt"
SKIP_FILE="$ROOT/doc/upstream-skipped.txt"
ADVISORY_FILE="$ROOT/doc/upstream-advisories.txt"
ADVISORY_REPO="paperclipai/paperclip"

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

# --advisories: upstream advisories against doc/upstream-advisories.txt.
# The node step prints "R <report line>" and "M <ghsa> <sha prefix | #PR>"
# for every commit sha or PR number an advisory names.
# File lines: "<GHSA id> <severity> <updated_at> <verdict> [note]", where the
# verdict is in-base, taken #<PR>, n/a: <reason> or check.
ADVISORY_JS='
const fs = require("fs");
const [file, repo] = process.argv.slice(1);
const list = JSON.parse(fs.readFileSync(0, "utf8"));
const known = new Map();
const bad = [];
if (fs.existsSync(file)) {
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [id, severity, updatedAt, ...rest] = line.split(/\s+/);
    const verdict = rest.join(" ");
    if (!/^(in-base|taken #\d+|n\/a: \S|check)/.test(verdict)) bad.push(`${id} has verdict "${verdict}"`);
    known.set(id, { severity, updatedAt, verdict });
  }
}
const out = [];
const counts = { NEW: 0, CHANGED: 0, OPEN: 0 };
const report = (kind, text) => { counts[kind] += 1; out.push(`R ${kind} ${text}`); };
for (const a of list) {
  const id = a.ghsa_id;
  const head = `${id} ${a.severity} ${a.updated_at}`;
  const mine = known.get(id);
  if (!mine) report("NEW", `${head} ${a.summary}`);
  else if (mine.updatedAt !== a.updated_at) report("CHANGED", `${head} (was ${mine.updatedAt}) ${a.summary}`);
  if (mine && mine.verdict.startsWith("check")) report("OPEN", `${head} ${a.summary}`);
  const text = [a.summary, a.description, ...(a.references || [])].join(" ");
  const tokens = new Set();
  for (const m of text.matchAll(/\b[0-9a-f]{7,40}\b/gi)) {
    if (/[0-9]/.test(m[0]) && /[a-f]/i.test(m[0])) tokens.add(m[0].toLowerCase());
  }
  const pr = new RegExp(`github\\.com/${repo}/pull/(\\d+)|(?:^|[\\s(])#(\\d+)\\b`, "g");
  for (const m of text.matchAll(pr)) tokens.add(`#${m[1] || m[2]}`);
  for (const t of tokens) out.push(`M ${id} ${t}`);
}
for (const b of bad) out.push(`R BAD ${b}`);
out.unshift(`R ## Advisories (${list.length} upstream: ${counts.NEW} new, ${counts.CHANGED} changed, ${counts.OPEN} open)`);
if (list.length >= 100) out.push("R warning: 100 advisories read; the list may be cut. Add paging.");
console.log(out.join("\n"));
'
ADVISORY_REPORT=() ADVISORY_MATCH=()
if [ "$ADVISORIES" -eq 1 ] && [ "$COUNT_ONLY" -eq 0 ]; then
  if ! advisory_json="$(gh api "repos/$ADVISORY_REPO/security-advisories?per_page=100")"; then
    echo "error: could not read $ADVISORY_REPO security advisories with gh api." >&2
    exit 1
  fi
  advisory_out="$(printf '%s' "$advisory_json" | node -e "$ADVISORY_JS" "$ADVISORY_FILE" "$ADVISORY_REPO")"
  while IFS= read -r line; do
    case "$line" in
      "R "*) ADVISORY_REPORT+=("${line#R }") ;;
      "M "*) ADVISORY_MATCH+=("${line#M }") ;;
    esac
  done <<< "$advisory_out"
fi

# The GHSA ids naming commit $1 (full sha) by sha prefix or by its "(#N)" PR.
advisory_for() {
  local entry id token pr="" ids=""
  [ "${#ADVISORY_MATCH[@]}" -gt 0 ] || return 0
  pr="$(git log -1 --format=%s "$1" | sed -nE 's/.*\(#([0-9]+)\)[[:space:]]*$/#\1/p')"
  for entry in "${ADVISORY_MATCH[@]}"; do
    id="${entry%% *}" token="${entry#* }"
    case "$token" in
      "#"*) [ "$token" = "$pr" ] || continue ;;
      *) case "$1" in "$token"*) ;; *) continue ;; esac ;;
    esac
    case " $ids " in *" $id "*) ;; *) ids="${ids:+$ids }$id" ;; esac
  done
  [ -z "$ids" ] || printf '  [%s]' "$ids"
}

# Security-looking: a security word in the subject, or a CVE/GHSA id anywhere.
# Upstream bodies are long, so security words in the body match too much.
SECURITY_SUBJECT_RE='\(auth|secur|vulnerab|xss|csrf|ssrf|inject|traversal|redact|leak|credential|secret|sanitiz|bypass|privilege|authoriz|authenticat|permission|grant|token|ownership'
SECURITY_ID_RE='cve-[0-9]{4}-[0-9]+|ghsa-[0-9a-z]{4}-'

# "clean" or "conflict: <files>" for cherry-picking $1 alone onto $MAIN.
clash() {
  local out rc=0
  out="$(git merge-tree --write-tree --name-only --no-messages --merge-base="$1^" "$MAIN" "$1")" || rc=$?
  case "$rc" in
    0) echo "clean" ;;
    1) echo "conflict: $(printf '%s\n' "$out" | sed 1d | sort -u | paste -sd ' ' -)" ;;
    *) echo "error: git merge-tree failed on $1 (needs git 2.40+)" >&2; exit 1 ;;
  esac
}

MIGRATIONS_DIR="packages/db/src/migrations"
# Our migration numbers on $MAIN, one per line.
OUR_MIGRATIONS="$NL$(git ls-tree --name-only "$MAIN" "$MIGRATIONS_DIR/" \
  | sed -nE 's#^.*/([0-9]{4})_[^/]*\.sql$#\1#p' | sort -u)$NL"

# "  [migration: NNNN clash|free, ...]" when $1 adds a migration, else nothing.
migration() {
  local nums n tags=""
  nums="$(git diff-tree --no-commit-id -r --name-only --diff-filter=A "$1" -- "$MIGRATIONS_DIR/" \
    | sed -nE "s#^$MIGRATIONS_DIR/([0-9]{4})_[^/]*\.sql\$#\1#p" | sort -u)"
  [ -n "$nums" ] || return 0
  for n in $nums; do
    if has "$OUR_MIGRATIONS" "$n"; then tags="$tags, $n clash"; else tags="$tags, $n free"; fi
  done
  printf '  [migration: %s]' "${tags#, }"
}

security=() other=() partial=()
while read -r sha; do
  if has "$TAKEN" "$sha" || has "$SKIPPED" "$sha"; then continue; fi
  if [ "$COUNT_ONLY" -eq 0 ] && [ "$CLASH" -eq 1 ]; then
    line="$(git log -1 --format='%h %cs %s' "$sha")$(migration "$sha")  [$(clash "$sha")]"
  else
    line="$(git log -1 --format='%h %cs %s' "$sha")$(migration "$sha")"
  fi
  if has "$PARTIAL" "$sha"; then partial+=("$line"); continue; fi
  ghsa="$(advisory_for "$sha")"
  if [ -n "$ghsa" ]; then
    security+=("$line$ghsa")
  elif git log -1 --format=%s "$sha" | grep -qiE "$SECURITY_SUBJECT_RE" \
    || git log -1 --format=%B "$sha" | grep -qiE "$SECURITY_ID_RE"; then
    security+=("$line")
  else
    other+=("$line")
  fi
done < <(git rev-list --reverse --no-merges "$BASE..$UPSTREAM" ^"$MAIN")

pending=$(( ${#security[@]} + ${#other[@]} ))
if [ "$COUNT_ONLY" -eq 1 ]; then
  echo "$pending"
  exit 0
fi

total="$(git rev-list --count --no-merges "$BASE..$UPSTREAM")"
echo "Upstream $(git rev-parse --short "$UPSTREAM") vs $MAIN $(git rev-parse --short "$MAIN"), since $BASE"
# The newest upstream commit in main: the last sync merge, or the fork point.
echo "Synced to: $(git rev-parse --short "$(git merge-base "$MAIN" "$UPSTREAM")")"
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
if [ "$ADVISORIES" -eq 1 ]; then
  echo
  printf '%s\n' "${ADVISORY_REPORT[@]}"
fi
