# dmgbuild settings for GSAM-Installer.dmg (build.sh passes app, icon and background).
# Writes the window layout itself, so it needs no Finder or screen (works in CI).
# Icon positions must match make-dmg-background.py.
import os.path
import struct

app = defines["app"]  # noqa: F821 (dmgbuild provides defines)
files = [app]
symlinks = {"Applications": "/Applications"}
icon = defines["icon"]  # noqa: F821  volume icon
background = defines["background"]  # noqa: F821  dmg-background.png; dmgbuild adds the @2x beside it
format = "UDZO"
filesystem = "HFS+"
# The window is exactly the 1x background (a PNG: width and height at bytes 16 to 24),
# so no strip of plain window shows beside it.
with open(background, "rb") as png:
    width, height = struct.unpack(">II", png.read(24)[16:24])
window_rect = ((200, 140), (width, height))
default_view = "icon-view"
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
icon_size = 128
text_size = 13
icon_locations = {
    os.path.basename(app): (170, 215),
    "Applications": (490, 215),
}
