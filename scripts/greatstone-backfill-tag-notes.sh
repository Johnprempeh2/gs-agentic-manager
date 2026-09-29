#!/usr/bin/env bash
# One-time backfill (GRE-120): give the live-* tags made before release notes
# existed a title and changelog.
#
#   scripts/greatstone-backfill-tag-notes.sh            show what would change
#   scripts/greatstone-backfill-tag-notes.sh --apply    re-create the tags and push them
#
# Each tag is re-created as an annotated tag on the SAME commit, with its
# original tag date (the app sorts live tags by date). The script stops if a
# commit would change. --apply pushes all tags in one push that replaces each
# remote tag (no tag is deleted without its replacement). Only John runs
# --apply: the pre-push guard lets tag pushes through for release scripts only.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/greatstone-common.sh"

die() { printf 'backfill: %s\n' "$*" >&2; exit 1; }

APPLY=0
case "${1:-}" in
  --apply) APPLY=1 ;;
  "") ;;
  *) die "usage: greatstone-backfill-tag-notes.sh [--apply]" ;;
esac

# Each tag and the commit it must stay on.
TAGS=(live-2026-09-27.1 live-2026-09-28.1 live-2026-09-28.2)
COMMITS=(9c20a0773d6d70f55c2fd7ed8039bc0a2b3ce64b 438fdadd0 507e4d2a3)

message() {
  case "$1" in
    live-2026-09-27.1) cat <<'EOF'
First live release: the localhost app as of 27 September

Features
- The localhost app as of 27 September, with every local change committed
- The Greatstone way of working and the release script
EOF
    ;;
    live-2026-09-28.1) cat <<'EOF'
My tasks page, release preview and one-click release

Features
- Guard main, tags and the public fork with a pre-push hook (#1)
- S1 ignores tool discovery and splits setup from agent time (#2)
- Agents acknowledge first on multi-step wakes (#5)
- Create a project from the task window's project picker (#4, GRE-17)
- Claude connection: record token expiry, warn before it expires, stop retrying on a dead token (#6)
- R1 sees four blind-spot strands (#7, GRE-21)
- My tasks page, where the operator blocks work (#9, GRE-29)
- Release preview: try a version on port 3200 before it goes live (#8, GRE-26)
- pnpm metrics:lost-time: time lost to hung runs, false stalls, reassignment (#11, GRE-37)
- Reassignment hands work over instead of dropping it (#12, GRE-36)
- One-click release from the "Update live?" card (#13, GRE-39)
- Show New Task uploads on the task; name failed uploads (#15, GRE-41)
- AI connections: say when a Claude token's expiry is unknown (#16, GRE-43)

Fixes
- Fresh task worktrees no longer race on .git/config.lock (#3)
- Fix see-through announcement popup (#10, GRE-31)
- Stop Safari contact AutoFill on title and name boxes (#14, GRE-40)
- A pending confirmation card is not a stalled review (#17, GRE-35)
EOF
    ;;
    live-2026-09-28.2) cat <<'EOF'
Decisions in the sidebar with Focus mode, and a silent-run watchdog

Features
- My tasks: one combined list in the Issues-page design (#19, GRE-42)
- List task attachments in the agent wake payload (#18, GRE-46)
- Silent-run watchdog stops a silent run and retries in a fresh session (#21, GRE-34)
- One release card per day; big changes merged after Flint's checks (#24, GRE-49)
- Wake issues waiting for a release when their fix goes live (#25, GRE-50)
- Decisions: Focus mode with Listen and Speak (#27, GRE-55)
- Decisions Focus: "Answered elsewhere" toast on both paths, keep progress across page leave (#28, GRE-59)
- Decisions in the sidebar by default, and a release UI sweep (#30, GRE-64)

Fixes
- Preview: make the old data copy writable before removing it (#20, GRE-19)
- No recovery wake while an issue only waits for a pending card (#22, GRE-51)
- Make workspace-runtime tests pass inside macOS agent runs (#26, GRE-52)
- Greatstone scripts: find ~/GSAM when agent runs have a temp HOME (#29, GRE-63)
- Decisions always in the sidebar and mobile nav (#31, GRE-66)
EOF
    ;;
  esac
}

REFSPECS=()
for i in "${!TAGS[@]}"; do
  tag="${TAGS[$i]}"
  commit="$(git -C "$RELEASE_REPO" rev-parse --verify --quiet "refs/tags/$tag^{commit}")" || die "unknown tag $tag"
  expected="$(git -C "$RELEASE_REPO" rev-parse --verify --quiet "${COMMITS[$i]}^{commit}")" || die "unknown commit ${COMMITS[$i]}"
  [ "$commit" = "$expected" ] || die "$tag is on $commit, not ${COMMITS[$i]}; stopping"
  current="$(git -C "$RELEASE_REPO" for-each-ref --format='%(contents:subject)%0a%0a%(contents:body)' "refs/tags/$tag" | git stripspace)"
  wanted="$(message "$tag" | git stripspace)"
  if [ "$current" = "$wanted" ]; then
    say "$tag: already has its notes"
    continue
  fi
  say "== $tag on ${commit:0:9}"
  say "$wanted"
  say ""
  [ "$APPLY" = 1 ] || continue
  date="$(git -C "$RELEASE_REPO" for-each-ref --format='%(creatordate:raw)' "refs/tags/$tag")"
  message "$tag" | GIT_COMMITTER_DATE="$date" git -C "$RELEASE_REPO" tag -a -f "$tag" "$commit" --cleanup=whitespace -F - >/dev/null
  [ "$(git -C "$RELEASE_REPO" rev-parse "refs/tags/$tag^{commit}")" = "$commit" ] || die "$tag moved; stopping"
  REFSPECS+=("+refs/tags/$tag:refs/tags/$tag")
done

if [ "$APPLY" = 1 ] && [ "${#REFSPECS[@]}" -gt 0 ]; then
  GSAM_RELEASE=1 git -C "$RELEASE_REPO" push --quiet origin "${REFSPECS[@]}"
  say "Re-created and pushed ${#REFSPECS[@]} tag(s); every commit is unchanged."
elif [ "$APPLY" = 0 ]; then
  say "Dry run. Run with --apply to re-create these tags on the same commits and push them."
fi
