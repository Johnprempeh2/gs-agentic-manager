#!/usr/bin/env bash
# One-command release smoke: boots a throwaway instance from this checkout
# (embedded Postgres, local_trusted, temp folder) and walks the main pages
# headless in Chromium. Exit 0 means every page opened without an error.
# Usage: pnpm smoke:pages   (GSAM_E2E_PORT=3299 to pick another port)
set -euo pipefail
cd "$(dirname "$0")/.."
export GSAM_E2E_PORT="${GSAM_E2E_PORT:-3298}"
exec npx playwright test --config tests/e2e/playwright.config.ts tests/e2e/smoke-pages.spec.ts "$@"
