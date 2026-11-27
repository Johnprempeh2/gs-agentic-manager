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

# Checks 1-3 read only the files Greatstone writes: the installer, template,
# our @greatstone packages, web UI and skills. Third-party npm packages come
# from the public registry and cannot carry our data; their own test keys and
# doc examples (ssh2 test certs, AWS and Octokit example keys) are not ours.
ours() { awk '{ i = 0; rest = $0; while ((j = index(rest, "node_modules/")) > 0) { i = 1; rest = substr(rest, j + 13) } if (!i || rest ~ /^@greatstone\//) print }'; }
OURS="$(mktemp)"; trap 'rm -f "$OURS"' EXIT
(cd "$DIR" && find . -type f -print) | ours > "$OURS"
grep_ours() { (cd "$DIR" && tr '\n' '\0' < "$OURS" | xargs -0 grep -IE "$@" 2>/dev/null) || true; }

# 1. No data, log-ins or keys: no instance folders, databases, env or key files.
while IFS= read -r file; do bad "data or key file: $file"; done < <(
  grep -E '/\.env$|\.pem$|\.p12$|/master\.key$|/PG_VERSION$|/postmaster\.pid$|\.sql\.gz$|instances.*/config\.json$' "$OURS")
[ ! -e "$DIR/app/data" ] || bad "app/data exists"

# 2. No live secrets in any text file (keys of the shapes our tools use).
SECRET_RE='sk-ant-[A-Za-z0-9_-]{30,}|sk-proj-[A-Za-z0-9_-]{30,}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{50,}|xox[bap]-[0-9]{9,}-[0-9A-Za-z-]+|AKIA[0-9A-Z]{16}'
while IFS= read -r hit; do bad "secret-shaped text: $hit"; done < <(
  grep_ours -o "$SECRET_RE" | cut -c1-160 | head -20)

# 3. Nothing from Greatstone's own machine or install. The app code
#    (@greatstone/*/dist) names the install folders to keep agents out of
#    them, so only home folders are checked there.
HOME_RE='/Users/johnprempeh|/home/johnprempeh'
INSTALL_RE='GSAM/data/instances|GSAM/live|gsam-client-instances'
while IFS= read -r hit; do bad "local path of Greatstone's machine: $hit"; done < <(
  { grep_ours -l "$HOME_RE"; grep_ours -l "$INSTALL_RE" | grep -Ev 'node_modules/@greatstone/[^/]+/dist/' || true; } | head -20)
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

# 6. The server carries the web UI and the bundled skills.
[ -f "$DIR/app/payload/node_modules/@greatstone/server/ui-dist/index.html" ] || bad "no web UI (server/ui-dist/index.html) in the payload"
[ -f "$DIR/app/payload/node_modules/@greatstone/server/skills/paperclip/SKILL.md" ] || bad "no bundled skills (server/skills) in the payload"

[ "$fail" = 0 ] || exit 1
echo "contents check passed: no data, keys, local paths or Greatstone-only skills; prebuilt $WANT_ARCH agent runner; web UI; skills"
