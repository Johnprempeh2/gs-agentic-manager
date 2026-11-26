#!/bin/bash
# Screenshots of the mounted GSAM-Installer.dmg window in Light and Dark Mode, window only.
# CI (release-assets.yml, macOS runner) only: it switches the runner's appearance.
#   scripts/release/dmg-window-shots.sh <dmg> <out dir>
set -euo pipefail
dmg=$1; out=$2; mkdir -p "$out"
winid() {
  osascript -l JavaScript -e '
    ObjC.import("CoreGraphics"); ObjC.import("Foundation");
    const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0));
    let id = "";
    for (let i = 0; i < list.count; i++) {
      const w = list.objectAtIndex(i);
      if (ObjC.unwrap(w.objectForKey("kCGWindowOwnerName")) === "Finder" && ObjC.unwrap(w.objectForKey("kCGWindowName")) === "GSAM")
        id = String(ObjC.unwrap(w.objectForKey("kCGWindowNumber")));
    }
    id'
}
for mode in light dark; do
  dark=$([ "$mode" = dark ] && echo true || echo false)
  osascript -e "tell application \"System Events\" to tell appearance preferences to set dark mode to $dark" || echo "could not set $mode mode"
  open "$dmg"; sleep 8
  osascript -e 'tell application "Finder" to set selection to {}' || true
  id=$(winid)
  if [ -n "$id" ]; then screencapture -x -o -l"$id" "$out/mac-dmg-window-$mode.png"; else screencapture -x "$out/mac-dmg-screen-$mode.png"; fi
  osascript -e 'tell application "Finder" to get bounds of front window' || true
  osascript -e 'tell application "Finder" to close every window' || true
  hdiutil detach /Volumes/GSAM -quiet || true
done
ls -la "$out"
