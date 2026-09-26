#!/usr/bin/env python3
"""Regenerate the GS Agentic Manager favicon and app-icon set from the stone.

The stone geometry is the traced outline of the Greatstone master logo and
must stay in sync with BRAND_STONE_SLABS in ui/src/components/BrandMark.tsx.
Requires Pillow (`pip install pillow`). Run from the repo root:

    python3 scripts/generate-brand-icons.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

SLABS = [
    "209,295 223,298 253,333 252,337 225,374 217,392 204,398 201,388 144,420 132,419 86,399 73,406 22,355 112,300",
    "262,216 265,216 265,223 259,317 223,277 123,281 26,338 0,249",
    "30,149 218,208 10,235 13,174 24,153",
    "98,69 116,71 155,114 264,116 284,179 202,189 40,137 36,127 42,116 85,77",
    "179,0 189,0 246,28 265,92 154,91 143,84 106,41 121,26",
]
STONE_W, STONE_H = 284, 420

VOID = (18, 18, 18, 255)       # --background (dark)
LIME = (200, 255, 0, 255)      # --brand-mark (dark)
EMERALD = (27, 80, 57, 255)    # worktree variant background
PAPER = (247, 248, 244, 255)

PUBLIC = Path(__file__).resolve().parent.parent / "ui" / "public"
SUPERSAMPLE = 8


def polygons():
    return [[tuple(float(v) for v in pt.split(",")) for pt in slab.split()] for slab in SLABS]


def render(size, stone_height_ratio, bg, fg, radius_ratio):
    """Solid stone centred on a (optionally rounded) square tile."""
    big = size * SUPERSAMPLE
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    if radius_ratio > 0:
        draw.rounded_rectangle((0, 0, big - 1, big - 1), radius=int(big * radius_ratio), fill=bg)
    else:
        draw.rectangle((0, 0, big, big), fill=bg)
    scale = big * stone_height_ratio / STONE_H
    ox = (big - STONE_W * scale) / 2
    oy = (big - STONE_H * scale) / 2
    for poly in polygons():
        draw.polygon([(ox + x * scale, oy + y * scale) for x, y in poly], fill=fg)
    return img.resize((size, size), Image.LANCZOS)


def svg(bg_hex, fg_hex, size=64, stone_ratio=0.74, radius=14):
    scale = size * stone_ratio / STONE_H
    ox = (size - STONE_W * scale) / 2
    oy = (size - STONE_H * scale) / 2
    polys = "".join(f'<polygon points="{slab}"/>' for slab in SLABS)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}">'
        f'<rect width="{size}" height="{size}" rx="{radius}" fill="{bg_hex}"/>'
        f'<g fill="{fg_hex}" transform="translate({ox:.3f} {oy:.3f}) scale({scale:.5f})">{polys}</g>'
        "</svg>\n"
    )


def write_set(prefix, bg, fg, bg_hex, fg_hex, with_app_icons):
    render(16, 0.84, bg, fg, 0.18).save(PUBLIC / f"{prefix}favicon-16x16.png")
    render(32, 0.8, bg, fg, 0.2).save(PUBLIC / f"{prefix}favicon-32x32.png")
    ico = render(48, 0.78, bg, fg, 0.2)
    ico.save(PUBLIC / f"{prefix}favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
    (PUBLIC / f"{prefix}favicon.svg").write_text(svg(bg_hex, fg_hex))
    if with_app_icons:
        # iOS rounds the corners itself and ignores transparency: full bleed.
        render(180, 0.66, bg, fg, 0).convert("RGB").save(PUBLIC / "apple-touch-icon.png")
        # Android maskable: keep the stone inside the central 80% safe circle.
        render(192, 0.58, bg, fg, 0).save(PUBLIC / "android-chrome-192x192.png")
        render(512, 0.58, bg, fg, 0).save(PUBLIC / "android-chrome-512x512.png")


if __name__ == "__main__":
    write_set("", VOID, LIME, "#121212", "#c8ff00", with_app_icons=True)
    # Worktree previews get the inverse so a second tab is told apart at a glance.
    write_set("worktree-", EMERALD, LIME, "#1b5039", "#c8ff00", with_app_icons=False)
    print(f"Wrote brand icons to {PUBLIC}")
