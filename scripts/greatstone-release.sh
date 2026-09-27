#!/usr/bin/env bash
# Release GS Agentic Manager to the live app (see doc/GREATSTONE-WAY-OF-WORKING.md).
#
#   scripts/greatstone-release.sh          tag origin/main as live-YYYY-MM-DD.N and release it
#   scripts/greatstone-release.sh <tag>    release an existing tag (also the rollback path)
#
# Run from the dev checkout. The live app is a separate clone that only ever
# sits on a tag; this script is the one thing that moves it.
set -euo pipefail

LIVE_DIR="${GSAM_LIVE_DIR:-$HOME/GSAM/live}"
LIVE_URL="${GSAM_LIVE_URL:-http://localhost:3100}"
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

say() { printf '%s\n' "$*"; }
die() { printf 'release: %s\n' "$*" >&2; exit 1; }

[ -d "$LIVE_DIR/.git" ] || die "no live checkout at $LIVE_DIR"
[ -z "$(git -C "$LIVE_DIR" status --porcelain)" ] || die "the live checkout has local changes; nothing may edit it. Inspect $LIVE_DIR before releasing."

active_runs() {
  # Counts queued or running agent runs across every company on the live app.
  node --input-type=module -e '
    const base = process.argv[1];
    const get = async (p) => (await fetch(base + p)).json();
    let active = 0;
    for (const company of await get("/api/companies")) {
      const runs = await get(`/api/companies/${company.id}/heartbeat-runs?limit=50`);
      const list = Array.isArray(runs) ? runs : (runs.runs ?? runs.items ?? []);
      active += list.filter((r) => r.status === "running" || r.status === "queued").length;
    }
    console.log(active);
  ' "$LIVE_URL"
}

git fetch --quiet --tags origin

if [ $# -ge 1 ]; then
  TAG="$1"
  git rev-parse --verify --quiet "refs/tags/$TAG" >/dev/null || die "unknown tag $TAG"
else
  git fetch --quiet origin main
  base="live-$(date +%Y-%m-%d)"
  n=1
  while git rev-parse --verify --quiet "refs/tags/$base.$n" >/dev/null; do n=$((n + 1)); done
  TAG="$base.$n"
  git tag -a "$TAG" origin/main -m "Live release $TAG"
  GSAM_RELEASE=1 git push --quiet origin "refs/tags/$TAG"
  say "Tagged origin/main as $TAG"
fi

RUNS="$(active_runs)"
[ "$RUNS" = "0" ] || die "$RUNS agent run(s) are active; release again when the agents are idle."

TARGET="$(git rev-parse "$TAG^{commit}")"
git -C "$LIVE_DIR" fetch --quiet --tags origin
git -C "$LIVE_DIR" checkout --quiet --detach "$TAG"
say "Live checkout is on $TAG ($(git -C "$LIVE_DIR" rev-parse --short HEAD))"
(cd "$LIVE_DIR" && pnpm install --frozen-lockfile --prefer-offline --reporter=silent)

# The live server runs under dev-runner's "restart required" supervisor, which
# notices the changed files within a few seconds and restarts on request.
sleep 5
curl -fsS -X POST "$LIVE_URL/api/dev-server/restart" >/dev/null 2>&1 || true

for _ in $(seq 1 90); do
  sleep 2
  commit="$(curl -fsS "$LIVE_URL/api/health" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).commit||"")}catch{console.log("")}})')"
  if [ "$commit" = "$TARGET" ]; then
    say "Live app at $LIVE_URL is running $TAG."
    exit 0
  fi
done
die "the live app did not report $TAG within 3 minutes; check the server log. Roll back with: scripts/greatstone-release.sh <previous tag>"
