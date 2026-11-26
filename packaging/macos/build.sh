#!/bin/bash
# Builds dist/GSAM.app and dist/GSAM-Installer.dmg from src/.
set -euo pipefail
cd "$(dirname "$0")"
ICON_SRC="${ICON_SRC:-assets/icon-1024.png}"   # rounded macOS tile with the Greatstone stone
HUB_URL="${GSAM_HUB_URL:-}"   # Greatstone's hub, where licence keys are checked (https://...)
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
codesign --force --deep --sign - dist/GSAM.app   # ad-hoc signature so macOS treats it as one app

# Disk image: drag GSAM into Applications.
stage=build/dmg; mkdir -p "$stage"
cp -R dist/GSAM.app "$stage/"
ln -s /Applications "$stage/Applications"
hdiutil create -volname "GSAM" -srcfolder "$stage" -ov -format UDZO dist/GSAM-Installer.dmg >/dev/null
echo "Built: $(pwd)/dist/GSAM.app and $(pwd)/dist/GSAM-Installer.dmg"
