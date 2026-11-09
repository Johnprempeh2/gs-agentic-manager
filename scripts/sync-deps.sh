#!/usr/bin/env bash
# Bring this checkout's node_modules in line with pnpm-lock.yaml in place
# (GRE-4756). Run it after pulling main, from the dev checkout or a worktree.
#
#   scripts/sync-deps.sh
#
# Agent runs set HOME and XDG_DATA_HOME to a per-run temp dir, so a bare
# `pnpm install` there picks a different pnpm store from the one node_modules
# was installed with and asks to remove and reinstall every modules directory.
# This script reads the store from node_modules/.modules.yaml and installs
# against it, so only the changed packages are added or removed.
#
# Exit 0 when node_modules matches the lockfile, non-zero when pnpm failed.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

args=(install --frozen-lockfile)
STORE=""
if [ -f node_modules/.modules.yaml ]; then
  STORE="$(sed -nE 's/^storeDir: *//p' node_modules/.modules.yaml)"
fi
if [ -n "$STORE" ]; then
  args+=(--store-dir "$STORE")
  echo "sync-deps: using the store node_modules was installed with: $STORE"
fi

exec pnpm "${args[@]}"
