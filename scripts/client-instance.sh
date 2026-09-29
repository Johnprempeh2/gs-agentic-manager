#!/usr/bin/env bash
# Start, stop, back up, check, upgrade and restore one client instance. See doc/CLIENT-INSTANCES.md.
set -euo pipefail
CODE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$CODE_DIR/cli/node_modules/tsx/dist/cli.mjs" "$CODE_DIR/scripts/client-instance/client-instance.ts" "$@"
