#!/bin/bash
# GSAM for Mac: the engine behind GSAM.app. Each subcommand is one setup step,
# so the app can show progress between them. Every step is safe to run again.
#   gsam.sh status | xcode | node | activate | rust | code | deps | tools | config | service | wait
#           | tailscale | owner | owner-done | open | newer | update | log
set -euo pipefail

NODE_VERSION="24.22.3"
# Remote help (the tailscale step): tailscaled built from source at a pinned
# release, with Go from go.dev checked against these pinned SHA-256 sums.
# Go modules are checked against Go's checksum database (sum.golang.org).
TS_VERSION="1.106.0"
GO_VERSION="1.27.4"
GO_SHA256_arm64="91a44a2b8a716600ad94a4f143e156116620db8828086a6e3602291be9bd0bb4"
GO_SHA256_amd64="2b799377704ef12db39bd254995d5c348c9cc8d86562ca817724390e56c38f43"
TS_TAG="tag:gsam-customer"
TS_REMOTE_PORT=3100                  # the port the tailnet policy opens to Greatstone admins
REPO="https://github.com/Johnprempeh2/gs-agentic-manager.git"
APP_HOME="${GSAM_APP_HOME:-$HOME/Library/Application Support/GSAM}"
RUNTIME="$APP_HOME/runtime"
CODE="${GSAM_CODE_DIR:-$HOME/GSAM}"
DATA="${GSAM_DATA_DIR:-$HOME/GSAM-data}"
PORT="${GSAM_PORT:-3100}"
LABEL="${GSAM_LABEL:-co.greatstone.gsam}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UPDATE_PLIST="$HOME/Library/LaunchAgents/$LABEL.update.plist"
TS_PLIST="$HOME/Library/LaunchAgents/$LABEL.tailscale.plist"
LOG="$APP_HOME/setup.log"
INST="$DATA/instances/default"       # GSAM's own folder inside the data folder
DB_PORT="${GSAM_DB_PORT:-54329}"     # used only when a new config is written
HERE="$(cd "$(dirname "$0")" && pwd)"
# Greatstone's hub: GSAM_HUB_URL, else the address build.sh put in the app.
HUB_URL="${GSAM_HUB_URL:-$(cat "$HERE/hub-url" 2>/dev/null || true)}"
# Tests only: clone from a local checkout and check out a branch instead of the newest live-* tag.
CODE_SOURCE="${GSAM_CODE_SOURCE:-}"
CODE_REF="${GSAM_CODE_REF:-}"
export CARGO_HOME="$RUNTIME/cargo" RUSTUP_HOME="$RUNTIME/rustup"
export PATH="$RUNTIME/node/bin:$CARGO_HOME/bin:/usr/bin:/bin:/usr/sbin:/sbin"
mkdir -p "$APP_HOME" "$RUNTIME" "$DATA"
exec 3>&1 4>&2 >>"$LOG" 2>&1   # step output goes to the log; fd 3 answers the app, fd 4 carries errors to it
echo "=== $(date '+%Y-%m-%d %H:%M:%S') $*"

healthy() { curl -fsS -m 3 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; }
# A message the person sees in the app's error dialog.
fail() { echo "$1"; echo "$1" >&4; exit 1; }
# Tests: print a tailscale command instead of running it (GSAM_TAILSCALE_DRY_RUN=1). The auth key is only ever a file path.
x() { if [ -n "${GSAM_TAILSCALE_DRY_RUN:-}" ]; then local c="$*"; echo "would run: ${c/#ts /tailscale --socket=$TS_SOCK }" >&3; else "$@"; fi; }
TS="$RUNTIME/tailscale"
# A unix socket path must stay under 104 bytes, so it lives in the per-user temp folder, not under Application Support.
TS_SOCK="$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null || echo /tmp/)$LABEL.tailscaled.sock"
ts() { "$TS/bin/tailscale" --socket="$TS_SOCK" "$@"; }
latest_release() { git ls-remote --tags --refs "$REPO" 'live-*' | sed 's#.*refs/tags/##' | sort -V | tail -1; }
current_release() { cat "$APP_HOME/version" 2>/dev/null || echo none; }
checkout_release() {
  git -C "$CODE" fetch --depth 1 origin tag "$1"
  git -C "$CODE" checkout -q --force "$1"
  echo "$1" > "$APP_HOME/version"
}

case "${1:-}" in
  status)
    # new: nothing installed. unlicensed: installed before licences (local log-in free).
    # setup: licensed, but the owner has not made their log-in yet. installed: ready.
    if ! { [ -d "$CODE/node_modules" ] && [ -f "$PLIST" ] && [ -x "$RUNTIME/node/bin/node" ]; }; then printf new >&3
    elif [ ! -f "$INST/fleet/spoke.json" ]; then printf unlicensed >&3
    elif [ -f "$INST/fleet/operator.json" ]; then printf setup >&3
    else printf installed >&3; fi ;;

  xcode)
    # Apple's command line tools give git and the compilers Rust needs.
    if ! xcode-select -p >/dev/null 2>&1; then
      xcode-select --install || true
      for _ in $(seq 1 180); do xcode-select -p >/dev/null 2>&1 && break; sleep 10; done
      xcode-select -p >/dev/null 2>&1 || { echo "Apple developer tools were not installed"; exit 1; }
    fi ;;

  node)
    if [ ! -x "$RUNTIME/node/bin/node" ] || [ "$("$RUNTIME/node/bin/node" -v)" != "v$NODE_VERSION" ]; then
      arch=$([ "$(uname -m)" = arm64 ] && echo arm64 || echo x64)
      file="node-v$NODE_VERSION-darwin-$arch.tar.gz"
      tmp=$(mktemp -d)
      curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$file" -o "$tmp/$file"
      curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$tmp/sums"
      (cd "$tmp" && grep " $file\$" sums | shasum -a 256 -c -)
      rm -rf "$RUNTIME/node" && mkdir -p "$RUNTIME/node"
      tar -xzf "$tmp/$file" -C "$RUNTIME/node" --strip-components 1
      rm -rf "$tmp"
    fi
    corepack enable ;;

  activate)
    # Licence key (GSAM_LICENCE_KEY) -> fleet registration, signed entitlement document, operator log-in.
    [ -n "$HUB_URL" ] || fail "This copy of GSAM does not know where Greatstone's service is. Ask Greatstone for a new download."
    mkdir -p "$INST"
    out=$(GSAM_RELEASE_TAG="$(current_release)" node "$HERE/mac-setup.mjs" activate "$INST" "$HUB_URL") || fail "$out"
    echo "$out" ;;

  rust)
    if ! [ -x "$CARGO_HOME/bin/cargo" ]; then
      curl -fsSL https://sh.rustup.rs -o "$RUNTIME/rustup-init.sh"
      sh "$RUNTIME/rustup-init.sh" -y --no-modify-path --profile minimal
      rm -f "$RUNTIME/rustup-init.sh"
    fi ;;

  code)
    if [ -n "$CODE_SOURCE" ]; then
      # Tests: a local checkout and branch, never the live release.
      [ -d "$CODE/.git" ] || git clone -q --depth 1 "file://$CODE_SOURCE" "$CODE"
      git -C "$CODE" fetch -q --depth 1 origin "${CODE_REF:-HEAD}"
      git -C "$CODE" checkout -q --force FETCH_HEAD
      echo "test:${CODE_REF:-HEAD}" > "$APP_HOME/version"
    else
      # Always the newest released version (live-* tag), never unreleased work on main.
      [ -d "$CODE/.git" ] || git clone --depth 1 "$REPO" "$CODE"
      checkout_release "$(latest_release)"
    fi ;;

  deps)
    cd "$CODE" && corepack pnpm install --frozen-lockfile ;;

  tools)
    # The Claude and ChatGPT command line apps; GSAM's agents sign in through them.
    command -v claude >/dev/null || npm install -g @anthropic-ai/claude-code
    command -v codex  >/dev/null || npm install -g @openai/codex ;;

  config)
    # Log-ins on (authenticated, this Mac only, sign-up closed), hourly backups kept 30 days.
    # An install from before licences is backed up first; nothing changes if that backup fails.
    if { [ -d "$INST/db" ] || [ -f "$INST/config.json" ]; } && ! grep -q '"deploymentMode": "authenticated"' "$INST/config.json" 2>/dev/null; then
      healthy || fail "GSAM is not running, so it cannot make a backup before switching to log-ins. Nothing was changed. Open GSAM again to retry."
      curl -fsS -m 600 -X POST -H "Origin: http://127.0.0.1:$PORT" -H "Content-Type: application/json" -d '{}' \
        "http://127.0.0.1:$PORT/api/instance/database-backups" || fail "GSAM could not make a backup before switching to log-ins, so nothing was changed. Try again, or send the log to Greatstone."
    fi
    out=$(node "$HERE/mac-setup.mjs" config "$INST" "$DB_PORT") || fail "$out"
    echo "$out" ;;

  service)
    mkdir -p "$HOME/Library/LaunchAgents"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string><string>-c</string>
    <string>cd "$CODE" &amp;&amp; exec corepack pnpm dev:once --data-dir "$DATA"</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$PATH</string>
    <key>HOME</key><string>$HOME</string>
    <key>CARGO_HOME</key><string>$CARGO_HOME</string>
    <key>RUSTUP_HOME</key><string>$RUSTUP_HOME</string>
    <key>PORT</key><string>$PORT</string>
    <key>GSAM_TELEMETRY_DISABLED</key><string>1</string>
    <key>GSAM_LAUNCHD_LABEL</key><string>$LABEL</string>$( [ -z "${GSAM_FLEET_CHECK_IN_SECONDS:-}" ] || printf '\n    <key>GSAM_FLEET_CHECK_IN_SECONDS</key><string>%s</string>' "$GSAM_FLEET_CHECK_IN_SECONDS")
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$DATA/gsam.log</string>
  <key>StandardErrorPath</key><string>$DATA/gsam.log</string>
</dict></plist>
EOF
    # Nightly updater: installs a new GSAM release at 03:30 (or on wake if the Mac was asleep).
    ENGINE="$APP_HOME/gsam.sh"; [ "$0" -ef "$ENGINE" ] || cp "$0" "$ENGINE"; chmod +x "$ENGINE"
    cat > "$UPDATE_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL.update</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$ENGINE</string><string>update</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>GSAM_APP_HOME</key><string>$APP_HOME</string><key>GSAM_CODE_DIR</key><string>$CODE</string>
    <key>GSAM_DATA_DIR</key><string>$DATA</string><key>GSAM_PORT</key><string>$PORT</string>
    <key>GSAM_LABEL</key><string>$LABEL</string>
    $( [ -z "$CODE_SOURCE" ] || printf '\n    <key>GSAM_CODE_SOURCE</key><string>%s</string><key>GSAM_CODE_REF</key><string>%s</string>' "$CODE_SOURCE" "$CODE_REF")
  </dict>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>30</integer></dict>
</dict></plist>
EOF
    pkill -f "dev-runner.ts.*--data-dir $DATA\$" 2>/dev/null || true   # a copy of THIS install started by hand from Terminal, never any other GSAM
    for p in "$PLIST" "$UPDATE_PLIST"; do
      l=$(basename "$p" .plist)
      launchctl bootout "gui/$(id -u)/$l" 2>/dev/null || true
      launchctl bootstrap "gui/$(id -u)" "$p"
    done ;;

  wait)
    # first start compiles, so allow up to 10 minutes
    launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || launchctl bootstrap "gui/$(id -u)" "$PLIST"
    for _ in $(seq 1 120); do healthy && exit 0; sleep 5; done
    echo "GSAM did not answer on port $PORT"; exit 1 ;;

  tailscale)
    # Optional remote help: joins Greatstone's tailnet as $TS_TAG and serves GSAM to it.
    # Runs as this Mac user in userspace networking mode: no system extension, no sudo.
    keyfile="$INST/fleet/tailscale.json"
    if [ ! -f "$keyfile" ] && [ ! -f "$TS_PLIST" ]; then
      echo "tailscale: the hub sent no auth key, skipped"; printf skipped >&3; exit 0
    fi
    if [ "$(cat "$TS/version" 2>/dev/null)" != "$TS_VERSION" ]; then
      arch=$([ "$(uname -m)" = arm64 ] && echo arm64 || echo amd64)
      sum_var="GO_SHA256_$arch"; file="go$GO_VERSION.darwin-$arch.tar.gz"
      tmp=$(mktemp -d)
      x curl -fsSL "https://go.dev/dl/$file" -o "$tmp/$file"
      [ -n "${GSAM_TAILSCALE_DRY_RUN:-}" ] || echo "${!sum_var}  $tmp/$file" | shasum -a 256 -c -
      x rm -rf "$RUNTIME/go"
      x tar -xzf "$tmp/$file" -C "$RUNTIME"
      x env GOTOOLCHAIN=local GOPATH="$RUNTIME/gopath" GOCACHE="$RUNTIME/gocache" GOBIN="$TS/bin" \
        "$RUNTIME/go/bin/go" install -modcacherw "tailscale.com/cmd/tailscale@v$TS_VERSION" "tailscale.com/cmd/tailscaled@v$TS_VERSION"
      x rm -rf "$tmp" "$RUNTIME/go" "$RUNTIME/gopath" "$RUNTIME/gocache"   # about 1 GB of build tools, not needed to run
      [ -n "${GSAM_TAILSCALE_DRY_RUN:-}" ] || echo "$TS_VERSION" > "$TS/version"
    fi
    mkdir -p "$TS/state"
    plist="<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\"><dict>
  <key>Label</key><string>$LABEL.tailscale</string>
  <key>ProgramArguments</key><array>
    <string>$TS/bin/tailscaled</string><string>--tun=userspace-networking</string>
    <string>--statedir=$TS/state</string><string>--socket=$TS_SOCK</string><string>--port=0</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$TS/tailscaled.log</string>
  <key>StandardErrorPath</key><string>$TS/tailscaled.log</string>
</dict></plist>"
    if [ -n "${GSAM_TAILSCALE_DRY_RUN:-}" ]; then echo "would write $TS_PLIST:" >&3; echo "$plist" >&3
    else
      printf '%s\n' "$plist" > "$TS_PLIST"
      launchctl bootout "gui/$(id -u)/$LABEL.tailscale" 2>/dev/null || true
      launchctl bootstrap "gui/$(id -u)" "$TS_PLIST"
      for _ in $(seq 1 30); do ts status >/dev/null 2>&1 && break; ts status 2>&1 | grep -q "Logged out" && break; sleep 1; done
    fi
    code=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).code)' "$INST/fleet/spoke.json")
    if [ -f "$keyfile" ]; then
      # The key goes to tailscale as a file path (never on a command line other users can see), then is deleted.
      authfile="$TS/authkey"; ( umask 077; node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).authKey)' "$keyfile" > "$authfile" )
      x ts up --auth-key="file:$authfile" --hostname="gsam-$code" --advertise-tags="$TS_TAG" --accept-dns=false \
        || { rm -f "$authfile"; fail "GSAM could not join Greatstone's network for remote help. Everything else works."; }
      rm -f "$authfile"; x rm -f "$keyfile"
    fi
    x ts serve --bg --tcp="$TS_REMOTE_PORT" "tcp://127.0.0.1:$PORT"
    [ -n "${GSAM_TAILSCALE_DRY_RUN:-}" ] && exit 0
    name=$(ts status --json | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write((JSON.parse(d).Self?.DNSName??"").replace(/\.$/,"")))')
    [ -n "$name" ] || fail "GSAM joined Greatstone's network but has no name there yet. Open GSAM again to retry."
    node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ name: process.argv[2] }) + "\n")' "$INST/fleet/tailnet.json" "$name"
    # Log-ins over the tailnet arrive with that name, so GSAM must allow it.
    if [ "$(node "$HERE/mac-setup.mjs" allow-host "$INST" "$name")" = changed ]; then
      launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>/dev/null || true
    fi
    printf joined >&3 ;;

  owner)
    # The owner's one-time set-up link, made by the server once it is licensed. Opens it in the GSAM window.
    for _ in $(seq 1 60); do
      [ -f "$INST/fleet/operator.json" ] || { printf done >&3; exit 0; }
      [ -f "$INST/fleet/owner-invite.json" ] && break
      sleep 2
    done
    url=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).url)' "$INST/fleet/owner-invite.json") \
      || fail "GSAM did not make the set-up link. Open GSAM again to retry."
    bash "$0" open "$url"
    printf opened >&3 ;;

  owner-done)
    # yes once the server has seen the owner's log-in and made Greatstone's operator log-in.
    for _ in $(seq 1 15); do [ -f "$INST/fleet/operator.json" ] || { printf yes >&3; exit 0; }; sleep 2; done
    printf no >&3 ;;

  open)
    url="${2:-http://localhost:$PORT}"
    [ -n "${GSAM_NO_WINDOW:-}" ] && { echo "open: no window (test run)"; exit 0; }
    if [ -d "/Applications/Google Chrome.app" ]; then
      open -na "Google Chrome" --args --app="$url" --user-data-dir="$APP_HOME/window"
    else open "$url"; fi ;;

  newer)
    # prints the newer release name, or nothing when up to date
    latest=$(latest_release || true)
    [ -n "$latest" ] && [ "$latest" != "$(current_release)" ] && printf "%s" "$latest" >&3 || true ;;

  update)
    # Nightly at 03:30, or at once when Greatstone sends an "update now" order (the server starts this job).
    if [ -n "$CODE_SOURCE" ]; then
      before=$(git -C "$CODE" rev-parse HEAD)
      bash "$0" code
      [ "$(git -C "$CODE" rev-parse HEAD)" = "$before" ] && { echo "update: already on the newest test commit"; exit 0; }
    else
      latest=$(latest_release)
      [ "$latest" = "$(current_release)" ] && { echo "update: already on $latest"; exit 0; }
      checkout_release "$latest"
    fi
    (cd "$CODE" && corepack pnpm install --frozen-lockfile)
    launchctl kickstart -k "gui/$(id -u)/$LABEL" ;;

  log)
    open -a Console "$DATA/gsam.log" 2>/dev/null || open "$DATA/gsam.log" ;;

  *) echo "unknown step: ${1:-}"; exit 2 ;;
esac
