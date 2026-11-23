#!/usr/bin/env bash
# Contents check of the Aura macOS package (GRE-6097): nothing from
# Greatstone's own install may leave in it. Flint's check (GRE-6101) is the
# human-level review; this one stops the build early.
#
#   scripts/aura-macos/check-package.sh <package dir> [feature-request address]
set -euo pipefail

DIR="${1:?usage: check-package.sh <package dir> [address]}"
ADDRESS="${2:-}"
fail=0
bad() { echo "CHECK FAILED: $*" >&2; fail=1; }

# 1. No data, log-ins or keys: no instance folders, databases, env or key files.
while IFS= read -r file; do bad "data or key file: $file"; done < <(
  cd "$DIR" && find . \( -name '.env' -o -name '*.pem' -o -name '*.p12' -o -name 'master.key' \
    -o -name 'PG_VERSION' -o -name 'postmaster.pid' -o -name '*.sql.gz' -o -name 'config.json' -path '*instances*' \) -print)
[ ! -e "$DIR/app/data" ] || bad "app/data exists"

# 2. No live secrets in any text file (keys of the shapes our tools use).
SECRET_RE='sk-ant-[A-Za-z0-9_-]{30,}|sk-proj-[A-Za-z0-9_-]{30,}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{50,}|xox[bap]-[0-9]{9,}-[0-9A-Za-z-]+|AKIA[0-9A-Z]{16}'
while IFS= read -r hit; do bad "secret-shaped text: $hit"; done < <(
  grep -rIEo --exclude-dir=.git "$SECRET_RE" "$DIR" 2>/dev/null | cut -c1-160 | head -20)

# 3. Nothing from Greatstone's own machine or install.
LOCAL_RE='/Users/johnprempeh|/home/johnprempeh|GSAM/data/instances|GSAM/live|gsam-client-instances'
while IFS= read -r hit; do bad "local path of Greatstone's machine: $hit"; done < <(
  grep -rIEl "$LOCAL_RE" "$DIR" 2>/dev/null | head -20)
while IFS= read -r skill; do bad "Greatstone-only skill: $skill"; done < <(
  cd "$DIR" && find . -type d \( -name 'greatstone-voice*' -o -name 'greatstone-brand*' -o -name 'greatstone-way*' \) -print)

# 4. The template names Greatstone only in the feature-request address.
if [ -d "$DIR/app/template" ]; then
  while IFS= read -r hit; do
    if [ -n "$ADDRESS" ] && printf '%s' "$hit" | grep -qF "$ADDRESS"; then continue; fi
    bad "template names Greatstone: $hit"
  done < <(grep -rIin 'greatstone' "$DIR/app/template" 2>/dev/null || true)
fi

# 5. Nothing is built on the owner's Mac: the agent runner ships prebuilt for
#    the package's CPU (a stock Mac has no Rust or pnpm).
CPU="$(node -p 'require(process.argv[1]).cpu' "$DIR/manifest.json" 2>/dev/null || true)"
[ "$CPU" = x64 ] && WANT_ARCH=x86_64 || WANT_ARCH=arm64
RUNNERS="$(find "$DIR/app/payload" -type f -name paperclip-runnerd 2>/dev/null)"
[ -n "$RUNNERS" ] || bad "no prebuilt agent runner (paperclip-runnerd) in the payload"
while IFS= read -r bin; do
  [ -n "$bin" ] || continue
  [ -x "$bin" ] || bad "agent runner is not executable: $bin"
  archs="$(lipo -archs "$bin" 2>/dev/null || true)"
  case " $archs " in *" $WANT_ARCH "*) ;; *) bad "agent runner is not $WANT_ARCH ($archs): $bin" ;; esac
done <<< "$RUNNERS"

[ "$fail" = 0 ] || exit 1
echo "contents check passed: no data, keys, local paths or Greatstone-only skills; prebuilt $WANT_ARCH agent runner"
