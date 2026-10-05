#!/usr/bin/env bash
# Runs the trial's e2e with telemetry off. Agent runs get a throwaway $HOME, so
# the ChatGPT login and the Playwright browsers are pinned to the real home
# folder: John's one login is then seen by every run. Agent runs also set
# OPENAI_BASE_URL and OPENAI_API_KEY empty, which the OpenAI SDK rejects.
set -euo pipefail
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
real_home="$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f6 || true)"
real_home="${real_home:-$HOME}"
export E2E_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1
export XDG_CONFIG_HOME="${E2E_CONFIG_HOME:-$real_home/.config}"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$real_home/.cache/ms-playwright}"
unset OPENAI_BASE_URL OPENAI_API_KEY
cd "$dir"
exec "$dir/node_modules/.bin/e2e" "$@"
