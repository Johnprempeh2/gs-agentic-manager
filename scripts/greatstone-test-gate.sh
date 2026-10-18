#!/usr/bin/env bash
# The release test gate (see doc/GREATSTONE-WAY-OF-WORKING.md, step 3).
#
#   scripts/greatstone-test-gate.sh <rc-tag>           run the full test suite on <rc-tag> and, when it
#                                                     passes, record a pass marker for its commit
#   scripts/greatstone-test-gate.sh --detach <rc-tag>  start the same run in the background, in its own
#                                                     session, with output in $GSAM_ROOT/test-gate/<rc-tag>.out,
#                                                     and return at once. Agents use this: it outlives the
#                                                     agent run that starts it (GRE-1643).
#   scripts/greatstone-test-gate.sh --check <rc-tag>   say whether <rc-tag>'s commit has a pass marker
#                                                     (exit 0 = yes); runs nothing
#
# <rc-tag> may also be a full commit sha (the pass marker is keyed by commit).
#
# Since 18 Oct 2026 the release gate is Fork CI's full test matrix on GitHub
# (scripts/greatstone-github-gate.mjs). This PC gate is the fallback: for
# greatstone-release.sh --pc-gate, and when GitHub cannot be asked.
#
# Fork CI ran no tests on pull requests until 18 Oct 2026, so failing tests
# reached main and then live; it now runs the same lanes on each pull request,
# but a merge result is only tested here. The release script refuses an rc-*
# tag whose commit has no pass marker; this script is the only thing that
# writes one.
#
# It runs the lanes in scripts/greatstone-test-gate.lanes of the tagged commit,
# in a clean clone of the tag at $GSAM_ROOT/test-gate/code (never the dev
# checkout, never live): "setup:" lines one after another, then every other
# lane in parallel, GSAM_TEST_GATE_JOBS at a time (default: all of them, sized
# for the 64 GB PC; on the 16 GB Mac use 3 or 4). Each lane gets a clean
# environment, so nothing from the caller (GSAM_HOME, DATABASE_URL, agent
# tokens) reaches the tests. Lanes use TMPDIR=$GSAM_TEST_GATE_TMPDIR (default
# /tmp/gsam-test-gate-tmp), never the caller's: an agent run's TMPDIR is its run
# scratch folder, deleted when the run ends. The lanes run in their own process
# group; when the gate stops (a signal or an error), it stops that group, so no
# lane goes on as an orphan.
#
#   $GSAM_ROOT/test-gate/passed/<commit>   the pass marker: commit, tag, time, seconds
#   $GSAM_ROOT/test-gate/logs/<commit>/    one log per lane, kept for both outcomes
#   $GSAM_ROOT/test-gate/overrides.log     releases that skipped the gate (greatstone-release.sh --skip-test-gate)
set -euo pipefail
# At the end of an agent run the server stops every process whose start
# environment names that run (GSAM_RUN_ID or its legacy alias; see
# server/src/services/run-process-cleanup.ts). The gate takes 20 minutes and
# must outlive the run that starts it, so it starts again without the marker
# (unset is not enough: /proc/<pid>/environ keeps the start environment).
# The legacy alias is found by its value, as the rebrand guard forbids its name.
if [ -n "${GSAM_RUN_ID:-}" ]; then
  run_marker_unsets=()
  for name in $(compgen -e); do
    case "$name" in
      *_RUN_ID) [ "${!name}" = "$GSAM_RUN_ID" ] && run_marker_unsets+=(-u "$name") ;;
    esac
  done
  exec env "${run_marker_unsets[@]}" bash "${BASH_SOURCE[0]}" "$@"
fi
# An agent run puts its managed git and gh launchers
# (<tmp>/paperclip-github-runtime/<run>) first on PATH. They stay out of the
# gate's own git calls and of every lane, or each test that runs git gets the
# launcher instead of git (GRE-1605: git-credentials, github-launcher,
# git-workspace-sync).
GATE_PATH=""
IFS=: read -r -a PATH_ENTRIES <<<"$PATH"
for entry in "${PATH_ENTRIES[@]}"; do
  case "$entry" in */paperclip-github-runtime/*) continue ;; esac
  GATE_PATH="${GATE_PATH:+$GATE_PATH:}$entry"
done
export PATH="$GATE_PATH"
source "$(dirname "${BASH_SOURCE[0]}")/greatstone-common.sh"

die() { printf 'test-gate: %s\n' "$*" >&2; exit 1; }

CHECK=0
DETACH=0
case "${1:-}" in
  --check) CHECK=1; shift ;;
  --detach) DETACH=1; shift ;;
esac
TAG="${1:-}"
[ -n "$TAG" ] && [ "$#" = 1 ] || die "usage: greatstone-test-gate.sh [--check | --detach] <rc-tag | commit sha>"
if COMMIT="$(git -C "$RELEASE_REPO" rev-parse --verify --quiet "refs/tags/$TAG^{commit}")"; then
  FETCH_REF="refs/tags/$TAG:refs/tags/$TAG"
elif [[ "$TAG" =~ ^[0-9a-f]{40}$ ]] && COMMIT="$(git -C "$RELEASE_REPO" rev-parse --verify --quiet "$TAG^{commit}")"; then
  FETCH_REF="$COMMIT"
else
  die "unknown tag $TAG"
fi

if [ "$CHECK" = 1 ]; then
  if MSG="$(test_gate_check "$COMMIT" "$TAG")"; then say "$MSG"; exit 0; fi
  die "$MSG"
fi

CODE_DIR="$TEST_GATE_DIR/code"
LOG_DIR="$TEST_GATE_DIR/logs/$COMMIT"
LOCK_DIR="$TEST_GATE_DIR/lock"
GATE_TMPDIR="${GSAM_TEST_GATE_TMPDIR:-/tmp/gsam-test-gate-tmp}"
case "$TEST_GATE_DIR/" in "$LIVE_DIR/"* | "$LIVE_DATA_DIR/"*) die "the test gate folder must be outside the live folders." ;; esac
for scratch in "${GSAM_RUN_SCRATCH_DIR:-}" "${GSAM_SCRATCH_DIR:-}" "${GSAM_TASK_SCRATCH_DIR:-}"; do
  [ -n "$scratch" ] || continue
  case "$GATE_TMPDIR/" in "$scratch/"*) die "GSAM_TEST_GATE_TMPDIR must be outside the run scratch folder $scratch (it is deleted when the run ends)." ;; esac
done
mkdir -p "$TEST_GATE_DIR" "$GATE_TMPDIR"
export TMPDIR="$GATE_TMPDIR"
lock_owner() { head -n 1 "$LOCK_DIR/owner" 2>/dev/null || echo unknown; }

if [ "$DETACH" = 1 ]; then
  [ ! -d "$LOCK_DIR" ] || die "another test gate runs ($(lock_owner)); if none does, remove $LOCK_DIR."
  OUT="$TEST_GATE_DIR/$TAG.out"
  SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
  # A new session: no terminal or agent shell can send it a hangup, and its
  # output goes to a file, so a closed pipe cannot stop it either.
  cd "$TEST_GATE_DIR"
  nohup perl -e 'use POSIX (); POSIX::setsid(); exec @ARGV or die "exec $ARGV[0]: $!\n"' bash "$SELF" "$TAG" </dev/null >"$OUT" 2>&1 &
  say "Test gate for $TAG started in the background (pid $!). Output: $OUT"
  say "Result: scripts/greatstone-test-gate.sh --check $TAG (exit 0 = passed); the last line of $OUT says PASSED or FAILED."
  exit 0
fi

# in_group <stdin> <command...>: runs the command from the clone in a new
# session (its own process group) and waits for it. When it ends, whatever it
# left in that group is stopped; when the gate stops early, stop_group stops
# the whole group (GRE-1643: lanes went on as orphans after the gate stopped).
GROUP=""
stop_group() {
  [ -n "$GROUP" ] || return 0
  kill -TERM -- "-$GROUP" 2>/dev/null || { GROUP=""; return 0; }
  for _ in 1 2 3 4 5; do
    sleep 1
    kill -0 -- "-$GROUP" 2>/dev/null || { GROUP=""; return 0; }
  done
  kill -KILL -- "-$GROUP" 2>/dev/null || true
  GROUP=""
}
in_group() {
  local input="$1" code=0
  shift
  (cd "$CODE_DIR" && exec perl -e 'use POSIX (); POSIX::setsid(); exec @ARGV or die "exec $ARGV[0]: $!\n"' "$@") <"$input" &
  GROUP=$!
  wait "$GROUP" || code=$?
  kill -TERM -- "-$GROUP" 2>/dev/null || true
  GROUP=""
  return "$code"
}
on_signal() {
  printf 'test-gate: stopped by SIG%s; its lanes were stopped too. No pass marker was written.\n' "$1" >&2 || true
  exit "$2"
}

# One gate at a time: they share the clone.
mkdir "$LOCK_DIR" 2>/dev/null \
  || die "another test gate runs ($(lock_owner)); if none does, remove $LOCK_DIR."
trap 'stop_group; rm -rf "$LOCK_DIR"' EXIT
trap 'on_signal HUP 129' HUP
trap 'on_signal INT 130' INT
trap 'on_signal PIPE 141' PIPE
trap 'on_signal TERM 143' TERM
printf 'pid %s, %s, started %s\n' "$$" "$TAG" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$LOCK_DIR/owner"

# A clean clone of the tag, fetched from the local repository so an unpushed
# rc-* tag works (as greatstone-preview.sh does).
SOURCE_GIT="$(cd "$RELEASE_REPO" && cd "$(git rev-parse --git-common-dir)" && pwd)"
[ -d "$CODE_DIR/.git" ] || git clone --quiet --no-checkout "$SOURCE_GIT" "$CODE_DIR"
git -C "$CODE_DIR" fetch --quiet --force "$SOURCE_GIT" "$FETCH_REF"
git -C "$CODE_DIR" checkout --quiet --force --detach "$COMMIT"
git -C "$CODE_DIR" clean -ffdxq
LANES_FILE="$CODE_DIR/scripts/greatstone-test-gate.lanes"
[ -f "$LANES_FILE" ] || die "$TAG ($COMMIT) has no scripts/greatstone-test-gate.lanes, so the gate cannot tell what to run. Cut a candidate from a newer main."

rm -rf "$LOG_DIR"
mkdir -p "$LOG_DIR"
STARTED="$(date +%s)"
say "Test gate for $TAG ($COMMIT): code $CODE_DIR, logs $LOG_DIR"

# The lane environment: the account home (agent runs set HOME to a temp
# folder), the PATH that has node and pnpm, plus ~/.cargo/bin (a non-login
# shell such as ssh or an agent run does not have it, and the native runner
# suite builds with cargo), the gate's own TMPDIR, and CI=true as on GitHub.
# PATH has no agent git launcher (see the top).
LANE_HOME="${GS_USER_HOME:-$HOME}"
LANE_PATH="$PATH"
[ ! -d "$LANE_HOME/.cargo/bin" ] || LANE_PATH="$LANE_HOME/.cargo/bin:$LANE_PATH"
LANE_ENV=(
  HOME="$LANE_HOME" USER="${USER:-}" LOGNAME="${LOGNAME:-}" SHELL=/bin/bash LANG="${LANG:-en_US.UTF-8}"
  PATH="$LANE_PATH" TMPDIR="$GATE_TMPDIR" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true TERM=dumb
)

LANES=()
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in '' | '#'*) continue ;; esac
  name="${line%%:*}"
  cmd="${line#*:}"
  cmd="${cmd# }"
  [ "$name" != "$line" ] && [ -n "$cmd" ] || die "bad line in scripts/greatstone-test-gate.lanes: $line"
  if [ "$name" = setup ]; then
    say "setup: $cmd"
    in_group /dev/null env -i "${LANE_ENV[@]}" bash -c "$cmd" >>"$LOG_DIR/setup.log" 2>&1 \
      || die "setup failed on $TAG: $cmd (see $LOG_DIR/setup.log). No pass marker was written."
    continue
  fi
  case "$name" in *[!A-Za-z0-9._-]*) die "bad lane name \"$name\" in scripts/greatstone-test-gate.lanes" ;; esac
  printf '%s\n' "$cmd" >"$LOG_DIR/$name.cmd"
  LANES+=("$name")
done <"$LANES_FILE"
[ "${#LANES[@]}" -gt 0 ] || die "scripts/greatstone-test-gate.lanes on $TAG names no lanes."

JOBS="${GSAM_TEST_GATE_JOBS:-${#LANES[@]}}"
say "Running ${#LANES[@]} lanes, $JOBS at a time..."
# Each lane writes "<exit code> <seconds>" to <lane>.status. xargs -P runs them
# in parallel on Linux and macOS alike.
printf '%s\n' "${LANES[@]}" >"$LOG_DIR/lanes.list"
in_group "$LOG_DIR/lanes.list" xargs -P "$JOBS" -I{} env -i "${LANE_ENV[@]}" CODE_DIR="$CODE_DIR" LOG_DIR="$LOG_DIR" bash -c '
  name="$1"; start="$(date +%s)"
  (cd "$CODE_DIR" && bash "$LOG_DIR/$name.cmd" </dev/null) >"$LOG_DIR/$name.log" 2>&1
  code=$?
  printf "%s %s\n" "$code" "$(( $(date +%s) - start ))" >"$LOG_DIR/$name.status"
  printf "  %-14s %s in %ss\n" "$name" "$([ "$code" = 0 ] && echo pass || echo "FAIL ($code)")" "$(( $(date +%s) - start ))"
' _ {} || true

FAILED=()
for name in "${LANES[@]}"; do
  read -r code _ <"$LOG_DIR/$name.status" 2>/dev/null || code=missing
  [ "$code" = 0 ] || FAILED+=("$name")
done

# One retry, alone. A few suites flake only under the gate's 13-way parallel
# load (a different test each run); a real failure fails again on its own.
# Retried lanes are named in the log and in the pass marker.
RETRIED=()
if [ "${#FAILED[@]}" -gt 0 ] && [ "${GSAM_TEST_GATE_RETRY:-1}" = 1 ]; then
  STILL_FAILED=()
  for name in "${FAILED[@]}"; do
    mv "$LOG_DIR/$name.log" "$LOG_DIR/$name.first-attempt.log" 2>/dev/null || true
    say "  retrying $name alone..."
    start="$(date +%s)"
    code=0
    in_group /dev/null env -i "${LANE_ENV[@]}" CODE_DIR="$CODE_DIR" LOG_DIR="$LOG_DIR" bash "$LOG_DIR/$name.cmd" >"$LOG_DIR/$name.log" 2>&1 || code=$?
    printf "%s %s\n" "$code" "$(( $(date +%s) - start ))" >"$LOG_DIR/$name.status"
    if [ "$code" = 0 ]; then say "  $name passed on retry"; RETRIED+=("$name"); else STILL_FAILED+=("$name"); fi
  done
  FAILED=(${STILL_FAILED[@]+"${STILL_FAILED[@]}"})
fi
SECONDS_TAKEN=$(( $(date +%s) - STARTED ))
TOOK="$((SECONDS_TAKEN / 60))m$((SECONDS_TAKEN % 60))s"

if [ "${#FAILED[@]}" -gt 0 ]; then
  say "FAILED: ${#FAILED[@]} of ${#LANES[@]} lanes failed on $TAG ($COMMIT) after $TOOK:"
  for name in "${FAILED[@]}"; do
    say "  $name (log: $LOG_DIR/$name.log)"
    # Vitest's summary names each failing test on a FAIL line (after colour codes).
    { perl -pe 's/\e\[[0-9;]*m//g' "$LOG_DIR/$name.log" 2>/dev/null | grep -E '^ *FAIL ' || true; } | sort -u | head -n 20 | sed 's/^ */    /'
  done
  say "No pass marker was written; greatstone-release.sh refuses $TAG. Fix the tests on main and cut a new candidate."
  exit 1
fi

mkdir -p "$TEST_GATE_DIR/passed"
cat >"$TEST_GATE_DIR/passed/$COMMIT.tmp" <<EOF
commit=$COMMIT
tag=$TAG
passed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
seconds=$SECONDS_TAKEN
lanes=${#LANES[@]}
retried=${RETRIED[*]:-}
EOF
mv "$TEST_GATE_DIR/passed/$COMMIT.tmp" "$TEST_GATE_DIR/passed/$COMMIT"
say "PASSED: all ${#LANES[@]} lanes on $TAG ($COMMIT) in $TOOK. Pass marker: $TEST_GATE_DIR/passed/$COMMIT"
