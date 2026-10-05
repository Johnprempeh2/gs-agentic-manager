#!/usr/bin/env bash
# John runs this once: signs the e2e trial in to his ChatGPT plan.
set -euo pipefail
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if "$dir/e2e.sh" models openai >/dev/null 2>&1; then
  echo
  echo "You are already logged in. Nothing to do."
  echo "Go back to GRE-905 and click \"Done, I logged in\"."
  echo
  exit 0
fi

cat <<'EOF'

==============================================================
  ChatGPT login for the e2e trial (GRE-905)
==============================================================

  In a moment this window shows a LINK and a CODE.

  1. Open the link in your web browser.
     (Hold Ctrl and click the link, or copy it into the browser.)
  2. Sign in to ChatGPT, if it asks.
  3. Type the CODE from this window into the web page.
  4. Come back to this window and wait for "LOGIN DONE".

==============================================================

EOF
"$dir/e2e.sh" login openai --device
cat <<'EOF'

==============================================================
  LOGIN DONE. You can close this window.
  Go back to GRE-905 and click "Done, I logged in".
==============================================================

EOF
