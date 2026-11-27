#!/bin/bash
# Builds dist/GSAM.app and dist/GSAM-Installer.dmg from src/.
#
# Signing. With nothing set the app is ad hoc signed (first open: right-click, Open).
#   GSAM_SIGN_IDENTITY     a "Developer ID Application" identity (name or SHA-1): the app and the
#                          disk image are signed with it, the app under the hardened runtime
#   GSAM_SIGN_KEYCHAIN     the keychain that holds it (optional)
#   GSAM_NOTARY_KEY        path to an App Store Connect API key (.p8); with GSAM_NOTARY_KEY_ID and
#   GSAM_NOTARY_ISSUER     GSAM_NOTARY_ISSUER the disk image is notarised by Apple and stapled
# Notarising needs the identity: Apple refuses an ad hoc signature.
set -euo pipefail
cd "$(dirname "$0")"
ICON_SRC="${ICON_SRC:-assets/icon-1024.png}"   # rounded macOS tile with the Greatstone stone
HUB_URL="${GSAM_HUB_URL:-}"   # Greatstone's hub, where licence keys are checked (https://...)
SIGN_ID="${GSAM_SIGN_IDENTITY:-}"
NOTARY_KEY="${GSAM_NOTARY_KEY:-}"
if [ -n "$NOTARY_KEY" ]; then
  [ -n "$SIGN_ID" ] || { echo "GSAM_NOTARY_KEY is set but GSAM_SIGN_IDENTITY is not: Apple only notarises a Developer ID signature" >&2; exit 1; }
  [ -f "$NOTARY_KEY" ] && [ -n "${GSAM_NOTARY_KEY_ID:-}" ] && [ -n "${GSAM_NOTARY_ISSUER:-}" ] || { echo "notarising needs GSAM_NOTARY_KEY (a file), GSAM_NOTARY_KEY_ID and GSAM_NOTARY_ISSUER" >&2; exit 1; }
fi
sign() { codesign --force --timestamp ${GSAM_SIGN_KEYCHAIN:+--keychain "$GSAM_SIGN_KEYCHAIN"} --sign "$SIGN_ID" "$@"; }
[ -n "$HUB_URL" ] || echo "warning: GSAM_HUB_URL is not set; this app cannot activate a licence until the hub address is built in" >&2
rm -rf dist build && mkdir -p dist build

# Icon: every size macOS asks for, from the 512px Greatstone stone.
set_dir=build/GSAM.iconset; mkdir -p "$set_dir"
for s in 16 32 128 256 512; do
  sips -z $s $s "$ICON_SRC" --out "$set_dir/icon_${s}x${s}.png" >/dev/null
  d=$((s*2)); sips -z $d $d "$ICON_SRC" --out "$set_dir/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$set_dir" -o build/GSAM.icns

# App: compiled AppleScript applet with the engine inside it.
osacompile -o dist/GSAM.app src/main.applescript
cp src/gsam.sh dist/GSAM.app/Contents/Resources/gsam.sh
cp src/mac-setup.mjs dist/GSAM.app/Contents/Resources/mac-setup.mjs
[ -z "$HUB_URL" ] || printf '%s' "$HUB_URL" > dist/GSAM.app/Contents/Resources/hub-url
cp build/GSAM.icns dist/GSAM.app/Contents/Resources/applet.icns
plist=dist/GSAM.app/Contents/Info.plist
# osacompile also ships its own icon in Assets.car, which macOS prefers over applet.icns
rm -f dist/GSAM.app/Contents/Resources/Assets.car
/usr/libexec/PlistBuddy -c "Delete :CFBundleIconName" "$plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Set :CFBundleName GSAM" "$plist"
/usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string GSAM" "$plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string co.greatstone.gsam.app" "$plist" 2>/dev/null || /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier co.greatstone.gsam.app" "$plist"
/usr/libexec/PlistBuddy -c "Add :CFBundleShortVersionString string 1.0" "$plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :NSAppleEventsUsageDescription string GSAM opens Terminal once so you can sign in to Claude or ChatGPT." "$plist" 2>/dev/null || true
if [ -n "$SIGN_ID" ]; then
  # The applet is the only code in the bundle (the rest are scripts, sealed as resources), so no --deep.
  sign --options runtime --entitlements assets/entitlements.plist dist/GSAM.app
  codesign --verify --strict --verbose=2 dist/GSAM.app
else
  codesign --force --deep --sign - dist/GSAM.app   # ad-hoc signature so macOS treats it as one app
fi

# One app for Apple silicon and Intel: the AppleScript applet is universal. Check it stays so.
archs=$(lipo -archs dist/GSAM.app/Contents/MacOS/applet)
case "$archs" in *arm64*x86_64*|*x86_64*arm64*) ;; *) echo "GSAM.app is not universal ($archs)" >&2; exit 1 ;; esac

# Disk image: branded window (Greatstone void, lime arrow, the first-open step), GSAM on the
# left, Applications on the right, the GSAM icon as the volume icon. dmgbuild (pinned, hashes
# checked) writes the layout without Finder. It needs Python 3.11 or newer.
py=""
for c in "${PYTHON:-}" python3.13 python3.12 python3.11 python3; do
  [ -n "$c" ] && command -v "$c" >/dev/null && "$c" -c 'import sys; sys.exit(sys.version_info < (3, 11))' 2>/dev/null && { py=$c; break; }
done
[ -n "$py" ] || { echo "Python 3.11 or newer is needed to build the disk image (brew install python)" >&2; exit 1; }
"$py" -m venv build/venv
build/venv/bin/pip install -q --disable-pip-version-check --require-hashes -r assets/dmgbuild-requirements.txt
build/venv/bin/dmgbuild -s assets/dmg-settings.py \
  -D app=dist/GSAM.app -D icon=build/GSAM.icns -D background=assets/dmg-background.png \
  "GSAM" dist/GSAM-Installer.dmg >/dev/null
if [ -n "$SIGN_ID" ]; then
  sign dist/GSAM-Installer.dmg
fi
if [ -n "$NOTARY_KEY" ]; then
  # One submission: the disk image, which covers the app inside it. Apple usually answers in minutes.
  # ponytail: only the disk image is stapled, so a Mac that is offline at first open of the copied
  # app cannot check the ticket. Setup needs the internet anyway; staple the app too if that changes.
  xcrun notarytool submit dist/GSAM-Installer.dmg --key "$NOTARY_KEY" --key-id "$GSAM_NOTARY_KEY_ID" \
    --issuer "$GSAM_NOTARY_ISSUER" --wait --timeout 30m --output-format json | tee build/notary.json
  grep -q '"status" *: *"Accepted"' build/notary.json || {
    id=$(sed -n 's/.*"id" *: *"\([^"]*\)".*/\1/p' build/notary.json | head -1)
    [ -z "$id" ] || xcrun notarytool log "$id" --key "$NOTARY_KEY" --key-id "$GSAM_NOTARY_KEY_ID" --issuer "$GSAM_NOTARY_ISSUER" >&2 || true
    echo "Apple did not accept the disk image for notarisation" >&2; exit 1
  }
  xcrun stapler staple dist/GSAM-Installer.dmg
  xcrun stapler validate dist/GSAM-Installer.dmg
fi
# Last, after stapling: that rewrites the disk image.
shasum -a 256 dist/GSAM-Installer.dmg | sed 's#dist/##' > dist/GSAM-Installer.dmg.sha256
signed="ad hoc signed"; [ -z "$SIGN_ID" ] || signed="Developer ID signed"; [ -z "$NOTARY_KEY" ] || signed="$signed, notarised"
echo "Built: $(pwd)/dist/GSAM.app and $(pwd)/dist/GSAM-Installer.dmg ($archs, $signed)"
