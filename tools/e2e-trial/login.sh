#!/usr/bin/env bash
# John runs this once: signs the e2e trial in to his ChatGPT plan.
set -euo pipefail
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo
echo "A web page opens (or copy the link below). Sign in to ChatGPT and type the code shown here."
echo
"$dir/e2e.sh" login openai --device
echo
echo "Done. Go back to GRE-905 and click \"Done, I logged in\"."
