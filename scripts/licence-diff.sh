#!/usr/bin/env bash
# List the npm packages that are new, or whose licence changed, between two refs
# (GRE-624). Each line is `ok` (MIT, ISC, BSD-*, Apache-2.0, 0BSD, ...) or `check`
# (GPL, AGPL, LGPL, SSPL, BUSL, unknown, none, anything else). Paste the `check`
# lines on the issue for Harbor.
#
#   scripts/licence-diff.sh <base> <head> [--fetch]
#
# For each ref it copies only pnpm-lock.yaml, pnpm-workspace.yaml, .npmrc,
# patches/ and the package.json files (`git archive`) into a temp dir and runs
# `pnpm licenses ls --json` there. It never checks out, installs into or writes
# the repository; the temp dir is removed on exit. Licences are read from the
# pnpm store this checkout's node_modules uses (set LICENCE_DIFF_STORE_DIR to
# override). If the store lacks a package of a ref, rerun with --fetch: it runs
# `pnpm fetch --ignore-scripts` in the temp dir, which adds the missing tarballs
# to the pnpm store (a download cache) and nothing else.
#
# Exit 0 whenever the report printed, whatever it says. Exit 1 if a ref could
# not be listed, 2 on bad arguments.
set -euo pipefail

FETCH=0
args=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --fetch) FETCH=1; shift ;;
    -h|--help) sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown argument: $1" >&2; exit 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
if [ "${#args[@]}" -ne 2 ]; then
  echo "usage: scripts/licence-diff.sh <base> <head> [--fetch]" >&2
  exit 2
fi
BASE="${args[0]}" HEAD="${args[1]}"

ROOT="$(git rev-parse --show-toplevel)"
HERE="$(cd "$(dirname "$0")" && pwd)"
for ref in "$BASE" "$HEAD"; do
  if ! git rev-parse -q --verify "$ref^{commit}" >/dev/null; then
    echo "error: $ref is not a commit here." >&2
    exit 1
  fi
done

STORE="${LICENCE_DIFF_STORE_DIR:-}"
if [ -z "$STORE" ] && [ -f "$ROOT/node_modules/.modules.yaml" ]; then
  STORE="$(sed -nE 's/^storeDir: *//p' "$ROOT/node_modules/.modules.yaml")"
fi
[ -n "$STORE" ] || STORE="$(cd "$ROOT" && pnpm store path)"

TMP="$(mktemp -d "${GSAM_RUN_SCRATCH_DIR:-${TMPDIR:-/tmp}}/licence-diff.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# $1 ref, $2 name: writes $TMP/$2.json.
list() {
  local dir="$TMP/$2" files
  mkdir -p "$dir"
  files="$(git ls-tree -r --name-only "$1" \
    | grep -E '(^|/)package\.json$|^pnpm-lock\.yaml$|^pnpm-workspace\.yaml$|^\.npmrc$|^patches/' \
    | grep -v 'node_modules/' || true)"
  if ! printf '%s\n' "$files" | grep -qx 'pnpm-lock.yaml'; then
    echo "{}" > "$TMP/$2.json"
    echo "warning: $1 has no pnpm-lock.yaml; treated as no packages" >&2
    return 0
  fi
  # shellcheck disable=SC2086
  git archive "$1" -- $files | tar -x -C "$dir"
  if [ "$FETCH" -eq 1 ]; then
    (cd "$dir" && npm_config_store_dir="$STORE" pnpm fetch --ignore-scripts >"$TMP/$2.err" 2>&1) || {
      echo "error: pnpm fetch failed for $1:" >&2; tail -5 "$TMP/$2.err" >&2; exit 1; }
  fi
  if ! (cd "$dir" && npm_config_store_dir="$STORE" pnpm licenses ls --json >"$TMP/$2.json" 2>"$TMP/$2.err"); then
    echo "error: pnpm licenses ls failed for $1:" >&2
    sed -n '1,20p' "$TMP/$2.json" "$TMP/$2.err" >&2
    if grep -q MISSING_PACKAGE_INDEX_FILE "$TMP/$2.json" "$TMP/$2.err"; then
      echo "the pnpm store ($STORE) lacks a package of $1; rerun with --fetch" >&2
    fi
    exit 1
  fi
}

list "$BASE" base
list "$HEAD" head
node "$HERE/licence-diff.mjs" "$TMP/base.json" "$TMP/head.json" \
  "$BASE ($(git rev-parse --short "$BASE"))" "$HEAD ($(git rev-parse --short "$HEAD"))"
