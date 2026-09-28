#!/usr/bin/env bash
# Install the Greatstone commit guard into the shared hooks dir of the repo that
# holds the given worktree (default: the current directory). All worktrees share
# that dir, so one install covers every agent worktree. Safe to run repeatedly
# and from concurrent provisions. It never replaces a pre-commit hook that is
# not ours, and it does nothing when core.hooksPath points elsewhere.
set -euo pipefail

worktree="${1:-.}"
source_hook="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/pre-commit"
marker="Local guard for the Greatstone repo"

if [ -n "$(git -C "$worktree" config --get core.hooksPath || true)" ]; then
  echo "git-hooks: core.hooksPath is set; pre-commit guard not installed." >&2
  exit 0
fi

hooks_dir="$(cd "$worktree" && cd "$(git rev-parse --git-common-dir)" && pwd -P)/hooks"
target="$hooks_dir/pre-commit"
mkdir -p "$hooks_dir"

if [ -e "$target" ] && ! grep -q "$marker" "$target"; then
  echo "git-hooks: $target exists and is not the Greatstone guard; left unchanged." >&2
  exit 0
fi
if [ -e "$target" ] && cmp -s "$source_hook" "$target"; then
  exit 0
fi

tmp="$(mktemp "$hooks_dir/.pre-commit.XXXXXX")"
cp "$source_hook" "$tmp"
chmod 755 "$tmp"
mv -f "$tmp" "$target"
echo "git-hooks: installed pre-commit guard at $target"
