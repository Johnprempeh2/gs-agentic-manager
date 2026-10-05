#!/usr/bin/env bash
# Shell test for gs-memory.sh safety guards (GRE-810). No sudo, no real PostgreSQL, no PC changes:
# every system command the script calls (pg_lsclusters, systemctl, apt-get, useradd, runuser, id -un, ss)
# is a stub that records its call. Run: bash scripts/gs-memory/gs-memory.test.sh
set -uo pipefail
# A BASH_ENV that sets PATH would hide the stubs from the script under test.
unset BASH_ENV

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/gs-memory.sh"
T="$(mktemp -d "${GSAM_RUN_SCRATCH_DIR:-${TMPDIR:-/tmp}}/gs-memory-test.XXXXXX")"
trap 'chmod -R u+w "$T" 2>/dev/null; rm -rf "$T"' EXIT
ME="$(id -un)"
REAL_ID="$(command -v id)"
IS_ROOT=0; [[ "$(id -u)" == 0 ]] && IS_ROOT=1
failures=0

pass() { printf 'ok   %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*"; failures=$((failures + 1)); }

# --- stubs ----------------------------------------------------------------------------------
BIN="$T/bin"
PGBIN="$T/pgbin"
mkdir -p "$BIN" "$PGBIN"
stub() { printf '#!/usr/bin/env bash\n%s\n' "$2" > "$BIN/$1"; chmod +x "$BIN/$1"; }
stub pg_lsclusters 'echo "pg_lsclusters $*" >> "$CALLS"; [[ -z "${STUB_CLUSTERS:-}" ]] || printf "%s\n" "$STUB_CLUSTERS"'
stub systemctl 'echo "systemctl $*" >> "$CALLS"
case "$1" in
  is-active) [[ "${STUB_PG_ACTIVE:-0}" == 1 ]];;
  is-system-running) echo running;;
  *) exit 0;;
esac'
for cmd in pg_dropcluster pg_ctlcluster apt-get useradd; do stub "$cmd" "echo \"$cmd \$*\" >> \"\$CALLS\""; done
stub dpkg 'exit 0'
stub ss 'exit 0'
stub runuser 'echo "runuser $*" >> "$CALLS"; [[ "${STUB_RUNUSER_DENIED:-0}" == 1 ]] && exit 1; while [[ "$1" != -- ]]; do shift; done; shift; exec "$@"'
stub id "if [[ \"\$*\" == -un ]]; then echo \"\${STUB_USER:-$ME}\"; elif [[ \"\$*\" == -u ]]; then [[ \"\${STUB_USER:-}\" == root ]] && echo 0 || $REAL_ID -u; else exec $REAL_ID \"\$@\"; fi"
printf '#!/usr/bin/env bash\nexit 0\n' > "$PGBIN/postgres"
printf '#!/usr/bin/env bash\nexit 0\n' > "$PGBIN/pg_isready"
# pg_dump stub: writes a small synthetic dump to the -f path.
printf '#!/usr/bin/env bash\nwhile [[ $# -gt 0 ]]; do [[ "$1" == -f ]] && { echo synthetic-dump > "$2"; exit 0; }; shift; done; exit 1\n' > "$PGBIN/pg_dump"
chmod +x "$PGBIN"/*

# A fresh sandbox per case. GS_MEMORY_USER is the test user, so install -o and the write test work without root.
fresh() {
  local case_dir="$T/case-$1"
  mkdir -p "$case_dir/home" "$case_dir/systemd" "$case_dir/win"
  export CALLS="$case_dir/calls" PATH="$BIN:$PATH"
  : > "$CALLS"
  export GS_MEMORY_USER="$ME" GS_MEMORY_HOME="$case_dir/home" GS_MEMORY_ROOT="$case_dir/home/gs-memory" \
    GS_MEMORY_PG_BIN="$PGBIN" GS_MEMORY_PG_PORT=25432 GS_MEMORY_API_PORT=28888 \
    GS_MEMORY_WINDOWS_BACKUPS="$case_dir/win/gs-memory" GS_MEMORY_SYSTEMD_DIR="$case_dir/systemd" \
    GS_MEMORY_GATEWAY_ENV="$case_dir/gsam/gs-memory/secrets/gateway.env" GS_MEMORY_MIN_FREE_GB=0
  unset STUB_CLUSTERS STUB_PG_ACTIVE STUB_USER STUB_RUNUSER_DENIED
  CASE="$case_dir"
}
called() { grep -q -- "$1" "$CALLS"; }

# --- 1. existing cluster -> stop with an error, change nothing ------------------------------
fresh cluster
export STUB_USER=root STUB_CLUSTERS="16 main 5432 online postgres /var/lib/postgresql/16/main /var/log/postgresql/postgresql-16-main.log"
out="$("$SCRIPT" system-setup 2>&1)"; rc=$?
[[ "$rc" != 0 ]] && pass "existing cluster: system-setup exits $rc" || fail "existing cluster: system-setup exited 0"
[[ "$out" == *"cluster 16/main, port 5432, online"* ]] && pass "existing cluster: it prints what it found" || fail "existing cluster: output does not name the cluster: $out"
[[ "$out" == *"--allow-disable-default-postgres"* ]] && pass "existing cluster: it names the opt-in" || fail "existing cluster: no opt-in hint"
if called pg_dropcluster || called pg_ctlcluster || called "systemctl disable" || called useradd || called apt-get || [[ -n "$(ls -A "$CASE/systemd")" ]]; then
  fail "existing cluster: something was changed: $(tr '\n' ';' < "$CALLS")"
else
  pass "existing cluster: no drop, no stop, no user, no package, no unit"
fi

# --- 2. active postgresql.service, no cluster -> stop with an error -------------------------
fresh active
export STUB_USER=root STUB_PG_ACTIVE=1
out="$("$SCRIPT" system-setup 2>&1)"; rc=$?
[[ "$rc" != 0 && "$out" == *"postgresql.service is active"* ]] && pass "active postgresql.service: system-setup stops ($rc)" || fail "active postgresql.service: rc=$rc out=$out"
called "systemctl disable" && fail "active postgresql.service: it was disabled without the opt-in" || pass "active postgresql.service: not touched without the opt-in"

# --- 3. opt-in -> service stopped and disabled, cluster kept, setup goes on -----------------
fresh optin
export STUB_USER=root STUB_PG_ACTIVE=1 STUB_CLUSTERS="16 main 5432 online postgres /var/lib/postgresql/16/main /var/log/x.log"
out="$("$SCRIPT" system-setup --allow-disable-default-postgres 2>&1)"; rc=$?
[[ "$rc" == 0 ]] && pass "opt-in: system-setup finishes" || fail "opt-in: system-setup exited $rc: $out"
called "systemctl disable --now postgresql.service" && pass "opt-in: postgresql.service stopped and disabled" || fail "opt-in: postgresql.service not disabled"
called pg_dropcluster || called pg_ctlcluster && fail "opt-in: a cluster was dropped or stopped one by one" || pass "opt-in: no cluster dropped"
[[ -f "$CASE/systemd/gs-memory-backup.timer" ]] && pass "opt-in: units installed" || fail "opt-in: units missing"
[[ "$out" == *"Windows copy folder is writable by $ME"* ]] && pass "opt-in: copy folder write test passed" || fail "opt-in: no write test: $out"
grep -q 'pg_dropcluster' "$SCRIPT" && fail "gs-memory.sh still contains pg_dropcluster" || pass "gs-memory.sh never calls pg_dropcluster"

# --- 4. unknown option -> refused before any change -----------------------------------------
fresh badopt
export STUB_USER=root
"$SCRIPT" system-setup --drop-everything >/dev/null 2>&1 && fail "unknown option accepted" || pass "unknown option refused"
[[ ! -s "$CALLS" ]] && pass "unknown option: nothing called" || fail "unknown option: calls made: $(tr '\n' ';' < "$CALLS")"

# --- 5. copy folder the engine user cannot write -> system-setup stops ----------------------
# The runuser stub refuses the write test, as /mnt/c does for gsmemory when the folder stays root-owned.
fresh nowrite
export STUB_USER=root STUB_RUNUSER_DENIED=1
out="$("$SCRIPT" system-setup 2>&1)"; rc=$?
[[ "$rc" != 0 && "$out" == *"cannot write"* ]] && pass "copy folder not writable by the engine user: system-setup stops" || fail "copy folder not writable: rc=$rc out=$out"

# --- 6. backup: copy failure -> non-zero; success -> dump and checksum in both places --------
fresh backup-ok
mkdir -p "$GS_MEMORY_ROOT/backups" "$GS_MEMORY_WINDOWS_BACKUPS"
out="$("$SCRIPT" backup 2>&1)"; rc=$?
copied=("$GS_MEMORY_WINDOWS_BACKUPS"/hindsight-*.dump)
if [[ "$rc" == 0 && -f "${copied[0]}" && -f "${copied[0]}.sha256" ]]; then pass "backup: dump and .sha256 copied, exit 0"; else fail "backup ok case: rc=$rc out=$out"; fi

fresh backup-missing
mkdir -p "$GS_MEMORY_ROOT/backups"
out="$("$SCRIPT" backup 2>&1)"; rc=$?
[[ "$rc" != 0 && "$out" == *"ERROR"*"missing"* ]] && pass "backup: missing copy folder -> exit $rc" || fail "backup missing folder: rc=$rc out=$out"
ls "$GS_MEMORY_ROOT/backups"/hindsight-*.dump >/dev/null 2>&1 && pass "backup: local dump kept when the copy fails" || fail "backup: local dump lost"

if [[ "$IS_ROOT" == 0 ]]; then
  fresh backup-readonly
  mkdir -p "$GS_MEMORY_ROOT/backups" "$GS_MEMORY_WINDOWS_BACKUPS" && chmod 0555 "$GS_MEMORY_WINDOWS_BACKUPS"
  out="$("$SCRIPT" backup 2>&1)"; rc=$?
  [[ "$rc" != 0 && "$out" == *"ERROR: cannot copy"* ]] && pass "backup: read-only copy folder -> exit $rc" || fail "backup read-only folder: rc=$rc out=$out"
  chmod 0755 "$GS_MEMORY_WINDOWS_BACKUPS"
fi

# --- 6b. backup expiry: no dump older than 90 days survives, even with a high KEEP (GRE-887) ---
make_dump() { (cd "$1" && echo synthetic-dump > "hindsight-$2.dump" && sha256sum "hindsight-$2.dump" > "hindsight-$2.dump.sha256"); }
old="$(date -u -d '-91 days' +%Y%m%dT%H%M%SZ)"; recent="$(date -u -d '-89 days' +%Y%m%dT%H%M%SZ)"
fresh backup-expiry
mkdir -p "$GS_MEMORY_ROOT/backups" "$GS_MEMORY_WINDOWS_BACKUPS"
for d in "$GS_MEMORY_ROOT/backups" "$GS_MEMORY_WINDOWS_BACKUPS"; do make_dump "$d" "$old"; make_dump "$d" "$recent"; done
out="$(GS_MEMORY_BACKUP_KEEP=500 "$SCRIPT" backup 2>&1)"; rc=$?
if [[ "$rc" == 0 && ! -e "$GS_MEMORY_ROOT/backups/hindsight-$old.dump" && ! -e "$GS_MEMORY_WINDOWS_BACKUPS/hindsight-$old.dump" \
  && ! -e "$GS_MEMORY_WINDOWS_BACKUPS/hindsight-$old.dump.sha256" ]]; then
  pass "backup expiry: 91-day-old dump and checksum removed in both places with KEEP=500"
else fail "backup expiry: old dump kept: rc=$rc out=$out"; fi
[[ -e "$GS_MEMORY_ROOT/backups/hindsight-$recent.dump" && -e "$GS_MEMORY_WINDOWS_BACKUPS/hindsight-$recent.dump" ]] \
  && pass "backup expiry: 89-day-old dump kept" || fail "backup expiry: recent dump removed"

fresh backup-expiry-cap
mkdir -p "$GS_MEMORY_ROOT/backups"; make_dump "$GS_MEMORY_ROOT/backups" "$old"
GS_MEMORY_BACKUP_MAX_AGE_DAYS=365 GS_MEMORY_WINDOWS_BACKUPS="$CASE/win" "$SCRIPT" backup >/dev/null 2>&1
[[ ! -e "$GS_MEMORY_ROOT/backups/hindsight-$old.dump" ]] && pass "backup expiry: MAX_AGE_DAYS above 90 is capped at 90" || fail "backup expiry: MAX_AGE_DAYS=365 kept a 91-day dump"

fresh backup-expiry-down
mkdir -p "$GS_MEMORY_ROOT/backups" "$GS_MEMORY_WINDOWS_BACKUPS"
for d in "$GS_MEMORY_ROOT/backups" "$GS_MEMORY_WINDOWS_BACKUPS"; do make_dump "$d" "$old"; done
printf '#!/usr/bin/env bash\nexit 1\n' > "$PGBIN/pg_isready"
out="$("$SCRIPT" backup 2>&1)"; rc=$?
printf '#!/usr/bin/env bash\nexit 0\n' > "$PGBIN/pg_isready"
[[ "$rc" == 0 && ! -e "$GS_MEMORY_ROOT/backups/hindsight-$old.dump" && ! -e "$GS_MEMORY_WINDOWS_BACKUPS/hindsight-$old.dump" ]] \
  && pass "backup expiry: old dumps expire on a night the database is down" || fail "backup expiry when down: rc=$rc out=$out"

# --- 7. preflight: PASS/FAIL per line, exit 1 on an existing cluster ------------------------
fresh preflight-clean
out="$("$SCRIPT" preflight 2>&1)"; rc=$?
[[ "$rc" == 0 && "$out" == *"RESULT: PASS"* ]] && pass "preflight: clean PC passes" || fail "preflight clean: rc=$rc out=$out"
bad_lines="$(grep -vE '^(  (PASS|FAIL|NOTE)  |gs-memory preflight as |RESULT: )' <<<"$out" || true)"
[[ -z "$bad_lines" ]] && pass "preflight: every line is PASS, FAIL or NOTE" || fail "preflight: unexpected lines: $bad_lines"
called "systemctl disable" && fail "preflight changed a service" || pass "preflight: read-only (no service change)"

fresh preflight-cluster
export STUB_CLUSTERS="14 main 5432 down postgres /var/lib/postgresql/14/main /var/log/x.log"
out="$("$SCRIPT" preflight 2>&1)"; rc=$?
[[ "$rc" == 1 && "$out" == *"FAIL  existing PostgreSQL cluster: 14/main"* ]] && pass "preflight: existing cluster -> FAIL, exit 1" || fail "preflight cluster: rc=$rc out=$out"

# --- 8. link-claude never prints the token --------------------------------------------------
fresh link
mkdir -p "$GS_MEMORY_ROOT/secrets"
token="synthetic-token-$(date +%s)-abcdefghijklmnop"
out="$(printf '%s\n' "$token" | "$SCRIPT" link-claude 2>&1)"; rc=$?
[[ "$rc" == 0 && "$out" != *"$token"* ]] && pass "link-claude: token stored, not printed" || fail "link-claude: rc=$rc or token printed"

# --- 9. restore-test: fixed C.UTF-8 locale, whatever the caller's locale is (GRE-674) ---------
fresh restore-locale
mkdir -p "$GS_MEMORY_ROOT/backups"
(cd "$GS_MEMORY_ROOT/backups" && echo synthetic-dump > hindsight-20261005T000000Z.dump \
  && sha256sum hindsight-20261005T000000Z.dump > hindsight-20261005T000000Z.dump.sha256)
# initdb stub: fails like the real one when LC_CTYPE is not a valid locale; records its env and args.
printf '#!/usr/bin/env bash\necho "initdb LC_ALL=${LC_ALL:-} LC_CTYPE=${LC_CTYPE:-} $*" >> "$CALLS"\n[[ "${LC_CTYPE:-}" == UTF-8 ]] && { echo "initdb: error: invalid locale settings" >&2; exit 1; }\nexit 0\n' > "$PGBIN/initdb"
for c in pg_ctl createdb pg_restore; do printf '#!/usr/bin/env bash\nexit 0\n' > "$PGBIN/$c"; done
printf '#!/usr/bin/env bash\necho 25\n' > "$PGBIN/psql"
chmod +x "$PGBIN"/*
out="$(LC_CTYPE=UTF-8 LANG=en_GB.UTF-8 "$SCRIPT" restore-test 2>&1)"; rc=$?
[[ "$rc" == 0 && "$out" == *"restore test passed"* ]] && pass "restore-test: passes with a Mac ssh locale (LC_CTYPE=UTF-8)" || fail "restore-test locale: rc=$rc out=$out"
called "initdb LC_ALL=C.UTF-8 LC_CTYPE= .*--locale=C.UTF-8" && pass "restore-test: initdb runs with C.UTF-8" || fail "restore-test: initdb locale not fixed: $(cat "$CALLS")"

echo
if [[ "$failures" == 0 ]]; then echo "ALL PASS"; else echo "$failures FAILED"; exit 1; fi
