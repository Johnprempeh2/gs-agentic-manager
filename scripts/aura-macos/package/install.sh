#!/bin/bash
# Installs GSAM on this Mac with one company, "Aura" (GRE-6097).
# See doc/AURA-MAC-INSTALL.md in the GSAM repository.
#
#   bash install.sh [--no-open] [--no-dock] [--port N] [--upgrade]
#
# Everything goes into ~/GSAM-Aura (code, data, backups, logs), a log-in item
# that starts GSAM when you log in, and ~/Applications/GSAM.app. Nothing is
# installed system-wide and nothing needs an administrator password.
#
# --upgrade   replace the code of an existing install; the data stays (a
#             backup is made first).
set -euo pipefail

PKG="$(cd "$(dirname "$0")" && pwd)"
HOME_DIR="${GSAM_AURA_HOME:-$HOME/GSAM-Aura}"
APP="$HOME_DIR/app"
DATA="$HOME_DIR/data"
LOGS="$HOME_DIR/logs"
INSTANCE="$DATA/instances/default"
CONFIG="$INSTANCE/config.json"
LABEL="com.gsam.aura"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
BUNDLE="$HOME/Applications/GSAM.app"

OPEN=1 DOCK=1 PORT="" UPGRADE=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-open) OPEN=0; shift ;;
    --no-dock) DOCK=0; shift ;;
    --port) PORT="${2:?--port needs a number}"; shift 2 ;;
    --upgrade) UPGRADE=1; shift ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "install.sh: unknown option $1" >&2; exit 2 ;;
  esac
done

say() { printf '[gsam] %s\n' "$*"; }
die() { printf '[gsam] error: %s\n' "$*" >&2; exit 1; }
NODE="$PKG/app/node/bin/node"

# ---------------------------------------------------------------- checks
[ "$(uname -s)" = "Darwin" ] || die "this package is for macOS"
# A copied or downloaded package is marked "from the internet"; the database
# and tool programs inside it are not notarised, so macOS would refuse them.
xattr -dr com.apple.quarantine "$PKG" 2>/dev/null || true
[ "$(id -u)" != 0 ] || die "run this as yourself, not with sudo"
CPU="$("$NODE" -p 'require(process.argv[1]).cpu' "$PKG/manifest.json" 2>/dev/null || true)"
case "$(uname -m)/$CPU" in
  arm64/arm64|x86_64/x64) ;;
  *) die "this package is for $CPU Macs; this Mac is $(uname -m)" ;;
esac
# Everything else GSAM needs is inside this package: Node, the database, the
# prebuilt agent runner (no Rust, pnpm or build step on this Mac). Only git,
# which agents use, comes from Apple's Command Line Tools.
if ! xcode-select -p >/dev/null 2>&1; then
  say "agents need git: macOS now asks to install Apple's Command Line Tools. Press Install."
  xcode-select --install >/dev/null 2>&1 || true
fi

# The agent runner is a native program built for this CPU. Sign the copied
# file again (ad hoc, as the build does) so macOS runs the new copy.
resign_runner() {
  local bin
  while IFS= read -r bin; do codesign --force --sign - "$bin" 2>/dev/null || true; done < <(
    find "$APP/payload" -type f -name paperclip-runnerd 2>/dev/null)
}

port_free() { ! nc -z 127.0.0.1 "$1" 2>/dev/null; }
first_free() {
  local p="$1"
  while ! port_free "$p" || [ "$p" = 3100 ] || [ "$p" = 3200 ]; do p=$((p + 1)); done
  echo "$p"
}

# ---------------------------------------------------------------- upgrade
if [ "$UPGRADE" = 1 ]; then
  [ -x "$APP/bin/gsam-aura" ] || die "no install at $HOME_DIR to upgrade"
  say "1/4 backup before the upgrade"
  "$APP/bin/gsam-aura" start >/dev/null
  "$APP/bin/gsam-aura" backup
  say "2/4 stop"
  "$APP/bin/gsam-aura" stop
  say "3/4 new code (old code kept in app.previous until the next upgrade)"
  rm -rf "$HOME_DIR/app.previous"
  mv "$APP" "$HOME_DIR/app.previous"
  ditto "$PKG/app" "$APP"
  xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
  resign_runner
  say "4/4 start and health check"
  "$APP/bin/gsam-aura" start
  say "upgraded to $("$NODE" -p 'require(process.argv[1]).gsamVersion' "$PKG/manifest.json")"
  exit 0
fi

[ ! -e "$DATA" ] || die "GSAM is already installed in $HOME_DIR. Use --upgrade, or uninstall first."
[ ! -e "$PLIST" ] || die "$PLIST already exists. Uninstall first (bash uninstall.sh)."

# ---------------------------------------------------------------- files
say "1/7 copying GSAM to $HOME_DIR"
mkdir -p "$HOME_DIR" "$LOGS" "$INSTANCE/secrets"
chmod 700 "$HOME_DIR"
ditto "$PKG/app" "$APP"
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
resign_runner
cp "$PKG/manifest.json" "$HOME_DIR/manifest.json"

PORT="${PORT:-$(first_free 3300)}"
DB_PORT="$(first_free 55400)"
port_free "$PORT" || die "port $PORT is in use"
[ "$PORT" != 3100 ] && [ "$PORT" != 3200 ] || die "ports 3100 and 3200 are kept for other installs; pick another"

# The instance's own sign-in secret; it never leaves this Mac.
printf 'BETTER_AUTH_SECRET=%s\n' "$(openssl rand -hex 32)" > "$INSTANCE/.env"
chmod 600 "$INSTANCE/.env"

write_config() { # <local_trusted|authenticated>
  "$NODE" - "$CONFIG" "$INSTANCE" "$PORT" "$DB_PORT" "$1" <<'EOF'
const fs = require("fs"), path = require("path");
const [file, dir, port, dbPort, mode] = process.argv.slice(2);
const config = {
  $meta: { version: 1, updatedAt: new Date().toISOString(), source: "onboard" },
  database: {
    mode: "embedded-postgres",
    embeddedPostgresDataDir: path.join(dir, "db"),
    embeddedPostgresPort: Number(dbPort),
    backup: { enabled: true, intervalMinutes: 60, retentionDays: 30, dir: path.join(dir, "data", "backups") },
  },
  logging: { mode: "file", logDir: path.join(dir, "logs") },
  server: {
    deploymentMode: mode,
    exposure: "private",
    bind: "loopback",
    host: "127.0.0.1",
    port: Number(port),
    allowedHostnames: [],
    serveUi: true,
  },
  telemetry: { enabled: false },
  updates: { checkEnabled: false },
  auth: { baseUrlMode: "auto", disableSignUp: false },
  storage: {
    provider: "local_disk",
    localDisk: { baseDir: path.join(dir, "data", "storage") },
    s3: { bucket: "paperclip", region: "us-east-1", prefix: "", forcePathStyle: false },
  },
  secrets: {
    provider: "local_encrypted",
    strictMode: false,
    localEncrypted: { keyFilePath: path.join(dir, "secrets", "master.key") },
  },
};
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
EOF
}

URL="http://127.0.0.1:$PORT"
api() { # <method> <path> [json]
  if [ -n "${3:-}" ]; then
    curl -fsS -X "$1" -H 'Content-Type: application/json' -H "Origin: $URL" -d "$3" "$URL$2"
  else
    curl -fsS -X "$1" -H "Origin: $URL" "$URL$2"
  fi
}
wait_healthy() {
  local i
  for i in $(seq 1 150); do
    curl -fsS --max-time 3 "$URL/api/health" 2>/dev/null | grep -q '"status":"ok"' && return 0
    [ -z "${1:-}" ] || kill -0 "$1" 2>/dev/null || die "GSAM stopped during setup; see $LOGS/server.log"
    sleep 2
  done
  die "GSAM did not start within 5 minutes; see $LOGS/server.log"
}

# ---------------------------------------------------------------- setup start
# The first start has no log-ins at all (local trusted, this Mac only): it
# makes the company and the settings, then stops. Nobody can sign in to it.
say "2/7 first start (setup only), port $PORT, database port $DB_PORT"
write_config local_trusted
"$APP/bin/gsam-aura" serve >> "$LOGS/server.log" 2>&1 &
SETUP_PID=$!
trap 'kill "$SETUP_PID" 2>/dev/null || true' EXIT
wait_healthy "$SETUP_PID"

say "3/7 settings: at most 2 agents at once (change it in Instance settings)"
api PATCH /api/instance/settings/general '{"runAdmission":{"maxConcurrentRuns":2},"teamCatalogAddMode":"install"}' >/dev/null

say "4/7 company \"Aura\""
if [ -d "$APP/template/aura" ]; then
  features="$(sed '/^$/d' "$APP/template/aura-features-on.txt" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o={};for(const k of s.split("\n").filter(Boolean))o[k]=true;process.stdout.write(JSON.stringify(o))})')"
  [ "$features" = "{}" ] || api PATCH /api/instance/settings/experimental "$features" >/dev/null
  "$APP/bin/gsam-aura" cli company import "$APP/template/aura" --target new --yes --api-base "$URL" >> "$LOGS/install.log" 2>&1 \
    || die "the Aura template did not import; see $LOGS/install.log"
else
  api POST /api/companies '{"name":"Aura"}' >/dev/null
fi
COMPANIES="$(api GET /api/companies | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).map(c=>c.name).join(",")))')"
[ "$COMPANIES" = "Aura" ] || die "expected one company \"Aura\", found: ${COMPANIES:-none}"

kill "$SETUP_PID"
for _ in $(seq 1 60); do kill -0 "$SETUP_PID" 2>/dev/null || break; sleep 1; done
! kill -0 "$SETUP_PID" 2>/dev/null || die "the setup start did not stop"
trap - EXIT
for _ in $(seq 1 30); do port_free "$DB_PORT" && break; sleep 1; done

# ---------------------------------------------------------------- normal start
say "5/7 log-in item (GSAM starts when you log in)"
write_config authenticated
mkdir -p "$(dirname "$PLIST")"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$APP/bin/gsam-aura</string><string>serve</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$LOGS/server.log</string>
  <key>StandardErrorPath</key><string>$LOGS/server.log</string>
</dict>
</plist>
EOF
plutil -lint "$PLIST" >/dev/null
"$APP/bin/gsam-aura" start
curl -fsS "$URL/api/health" | grep -q '"deploymentMode":"authenticated"' || die "GSAM did not start in authenticated mode"

say "6/7 GSAM app in ~/Applications"
mkdir -p "$BUNDLE/Contents/MacOS" "$BUNDLE/Contents/Resources"
cat > "$BUNDLE/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>GSAM</string>
  <key>CFBundleDisplayName</key><string>GSAM</string>
  <key>CFBundleIdentifier</key><string>com.gsam.aura.app</string>
  <key>CFBundleExecutable</key><string>GSAM</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>GSAM</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
</dict>
</plist>
EOF
printf '#!/bin/bash\nexec /bin/bash "%s/bin/gsam-aura" open\n' "$APP" > "$BUNDLE/Contents/MacOS/GSAM"
chmod 755 "$BUNDLE/Contents/MacOS/GSAM"
ICON="$(find "$APP/payload/node_modules/@greatstone/server/ui-dist" -maxdepth 2 -name 'apple-touch-icon*.png' 2>/dev/null | head -1 || true)"
if [ -n "$ICON" ]; then
  ICONSET="$(mktemp -d)/GSAM.iconset"; mkdir -p "$ICONSET"
  for s in 16 32 128 256 512; do
    sips -z "$s" "$s" "$ICON" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null 2>&1 || true
  done
  iconutil -c icns "$ICONSET" -o "$BUNDLE/Contents/Resources/GSAM.icns" 2>/dev/null || true
fi
if [ "$DOCK" = 1 ] && ! defaults read com.apple.dock persistent-apps 2>/dev/null | grep -q "GSAM.app"; then
  defaults write com.apple.dock persistent-apps -array-add \
    "<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>file://$BUNDLE/</string><key>_CFURLStringType</key><integer>15</integer></dict></dict></dict>"
  killall Dock 2>/dev/null || true
fi

say "7/7 done. GSAM runs on $URL (this Mac only)."
say "    Data and backups: $DATA"
say "    Commands: $APP/bin/gsam-aura help"
if [ "$OPEN" = 1 ]; then
  "$APP/bin/gsam-aura" claim
else
  say "Next: run '$APP/bin/gsam-aura claim' to create the owner log-in."
fi
