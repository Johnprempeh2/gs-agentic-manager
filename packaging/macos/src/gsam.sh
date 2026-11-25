#!/bin/bash
# GSAM for Mac: the engine behind GSAM.app. Each subcommand is one setup step,
# so the app can show progress between them. Every step is safe to run again.
#   gsam.sh status | xcode | node | rust | code | deps | tools | service | wait | open | update | log
set -euo pipefail

NODE_VERSION="24.22.3"
REPO="https://github.com/Johnprempeh2/gs-agentic-manager.git"
APP_HOME="${GSAM_APP_HOME:-$HOME/Library/Application Support/GSAM}"
RUNTIME="$APP_HOME/runtime"
CODE="${GSAM_CODE_DIR:-$HOME/GSAM}"
DATA="${GSAM_DATA_DIR:-$HOME/GSAM-data}"
PORT="${GSAM_PORT:-3100}"
LABEL="${GSAM_LABEL:-co.greatstone.gsam}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UPDATE_PLIST="$HOME/Library/LaunchAgents/$LABEL.update.plist"
LOG="$APP_HOME/setup.log"
export CARGO_HOME="$RUNTIME/cargo" RUSTUP_HOME="$RUNTIME/rustup"
export PATH="$RUNTIME/node/bin:$CARGO_HOME/bin:/usr/bin:/bin:/usr/sbin:/sbin"
mkdir -p "$APP_HOME" "$RUNTIME" "$DATA"
exec 3>&1 >>"$LOG" 2>&1   # step output goes to the log; fd 3 answers the app
echo "=== $(date '+%Y-%m-%d %H:%M:%S') $*"

healthy() { curl -fsS -m 3 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; }
latest_release() { git ls-remote --tags --refs "$REPO" 'live-*' | sed 's#.*refs/tags/##' | sort -V | tail -1; }
current_release() { cat "$APP_HOME/version" 2>/dev/null || echo none; }
checkout_release() {
  git -C "$CODE" fetch --depth 1 origin tag "$1"
  git -C "$CODE" checkout -q --force "$1"
  echo "$1" > "$APP_HOME/version"
}

case "${1:-}" in
  status)
    # installed = code, deps and the background service all present
    if [ -d "$CODE/node_modules" ] && [ -f "$PLIST" ] && [ -x "$RUNTIME/node/bin/node" ]; then printf installed >&3; else printf new >&3; fi ;;

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

  rust)
    if ! [ -x "$CARGO_HOME/bin/cargo" ]; then
      curl -fsSL https://sh.rustup.rs -o "$RUNTIME/rustup-init.sh"
      sh "$RUNTIME/rustup-init.sh" -y --no-modify-path --profile minimal
      rm -f "$RUNTIME/rustup-init.sh"
    fi ;;

  code)
    # Always the newest released version (live-* tag), never unreleased work on main.
    [ -d "$CODE/.git" ] || git clone --depth 1 "$REPO" "$CODE"
    checkout_release "$(latest_release)" ;;

  deps)
    cd "$CODE" && corepack pnpm install --frozen-lockfile ;;

  tools)
    # The Claude and ChatGPT command line apps; GSAM's agents sign in through them.
    command -v claude >/dev/null || npm install -g @anthropic-ai/claude-code
    command -v codex  >/dev/null || npm install -g @openai/codex ;;

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
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$DATA/gsam.log</string>
  <key>StandardErrorPath</key><string>$DATA/gsam.log</string>
</dict></plist>
EOF
    # Nightly updater: installs a new GSAM release at 03:30 (or on wake if the Mac was asleep).
    ENGINE="$APP_HOME/gsam.sh"; cp "$0" "$ENGINE"; chmod +x "$ENGINE"
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
  </dict>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>30</integer></dict>
</dict></plist>
EOF
    pkill -f "dev-runner.ts" 2>/dev/null || true   # a copy started by hand from Terminal
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

  open)
    url="http://localhost:$PORT"
    if [ -d "/Applications/Google Chrome.app" ]; then
      open -na "Google Chrome" --args --app="$url" --user-data-dir="$APP_HOME/window"
    else open "$url"; fi ;;

  newer)
    # prints the newer release name, or nothing when up to date
    latest=$(latest_release || true)
    [ -n "$latest" ] && [ "$latest" != "$(current_release)" ] && printf "%s" "$latest" >&3 || true ;;

  update)
    latest=$(latest_release)
    [ "$latest" = "$(current_release)" ] && exit 0
    checkout_release "$latest"
    (cd "$CODE" && corepack pnpm install --frozen-lockfile)
    launchctl kickstart -k "gui/$(id -u)/$LABEL" ;;

  log)
    open -a Console "$DATA/gsam.log" 2>/dev/null || open "$DATA/gsam.log" ;;

  *) echo "unknown step: ${1:-}"; exit 2 ;;
esac
