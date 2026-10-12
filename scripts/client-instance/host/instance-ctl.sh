#!/usr/bin/env bash
# Start, stop or show one client instance on a hosted server (GRE-664).
# systemd calls this through gsam-client@<code>.service; see doc/CLIENT-HOSTING.md.
#
#   instance-ctl.sh start|stop|status|verify|restore-check|offsite-backup|watch <code>
#
# offsite-backup and watch read their config from /etc/gsam/offsite/<code>.env
# and /etc/gsam/watch/<code>.env (mode 600, owner gsam; GRE-666). Timers run
# them: gsam-offsite@.timer, gsam-watch@.timer, gsam-restore-check@.timer.
#
# It runs client-instance.sh from the release folder the instance last
# started from (`release.dir` in client-instance.json), so after an upgrade
# the next start uses the new release with no change to the unit.
set -euo pipefail

GSAM_HOSTED_ROOT="${GSAM_HOSTED_ROOT:-/srv/gsam}"
INSTANCES="$GSAM_HOSTED_ROOT/instances"
RELEASES="$GSAM_HOSTED_ROOT/releases"

die() { echo "instance-ctl: $*" >&2; exit 1; }

[ $# -eq 2 ] || die "usage: instance-ctl.sh start|stop|status|verify|restore-check|offsite-backup|watch <code>"
cmd="$1"
code="$2"
case "$cmd" in start | stop | status | verify | restore-check | offsite-backup | watch) ;; *) die "unknown command: $cmd" ;; esac
# A code, never a client name (doc/CLIENT-INSTANCES.md, Rules).
[[ "$code" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || die "bad instance code: $code"

root="$INSTANCES/$code"
state="$root/client-instance.json"
[ -f "$state" ] || die "no instance at $root"

rel="$(node -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(s.release?.dir ?? "")' "$state")"
[ -n "$rel" ] || die "$state names no release folder; start it once by hand from a release (doc/CLIENT-HOSTING.md)"
rel="$(realpath -e "$rel")" || die "release folder is missing: $rel"
releases="$(realpath -e "$RELEASES")" || die "no releases folder: $RELEASES"
case "$rel/" in "$releases"/*/) ;; *) die "release folder $rel is not under $RELEASES" ;; esac
[ -x "$rel/scripts/client-instance.sh" ] || die "no client-instance.sh in $rel"

extra=()
case "$cmd" in
  offsite-backup) extra=(--offsite-config "/etc/gsam/offsite/$code.env") ;;
  watch) extra=(--watch-config "/etc/gsam/watch/$code.env") ;;
esac

# Clean environment, as the run-book says: nothing from systemd or a shell
# reaches the server except these.
exec env -i HOME="$HOME" USER="$(id -un)" LOGNAME="$(id -un)" LANG=C.UTF-8 \
  PATH=/usr/local/bin:/usr/bin:/bin \
  "$rel/scripts/client-instance.sh" "$cmd" --root "$root" "${extra[@]}"
