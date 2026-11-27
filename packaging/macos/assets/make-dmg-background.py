"""Draws the GSAM disk image background: dmg-background.png (660x420) and @2x.

Greatstone void #121212, the lime wordmark, a lime arrow from where Finder
draws GSAM.app (left) to the Applications alias (right), and the first-open
step. Run on a Mac (it uses the system's Helvetica Neue) after changing it:
    python3 packaging/macos/assets/make-dmg-background.py
The icon positions here must match dmg-settings.py.
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
WIDTH, HEIGHT = 660, 420
APP_AT, APPS_AT = (170, 215), (490, 215)  # icon centres, as in dmg-settings.py
VOID, LIME, TEXT, MUTED = "#121212", "#c8ff00", "#f2f2f2", "#b5b5b5"  # MUTED on VOID is about 9:1
# Finder draws icon labels black in Light Mode and white in Dark Mode, and their colour
# cannot be set. On this mid grey both pass WCAG AA: black 4.6:1, white 4.5:1.
PILL = "#767676"
LABEL_Y = 298  # where Finder centres a 13-point label under a 128-point icon at y 215
LABELS = (("GSAM", APP_AT), ("Applications", APPS_AT))
LABEL_FONT = "/System/Library/Fonts/SFNS.ttf"  # Finder's label font
FONT = "/System/Library/Fonts/HelveticaNeue.ttc"


def draw(scale: int) -> Image.Image:
    s = lambda v: int(round(v * scale))
    img = Image.new("RGB", (s(WIDTH), s(HEIGHT)), VOID)
    d = ImageDraw.Draw(img)

    wordmark = Image.open(REPO / "ui/src/assets/brand/greatstone-wordmark.png").convert("RGBA")
    w = s(150)
    wordmark = wordmark.resize((w, round(wordmark.height * w / wordmark.width)), Image.LANCZOS)
    img.paste(wordmark, ((s(WIDTH) - w) // 2, s(30)), wordmark)

    title = ImageFont.truetype(FONT, s(20), index=1)  # Helvetica Neue Bold
    text = "Drag GSAM into Applications"
    d.text(((s(WIDTH) - d.textlength(text, font=title)) / 2, s(72)), text, font=title, fill=TEXT)

    # The arrow, between the two icons (each 128 points wide).
    y = s(APP_AT[1])
    x0, x1 = s(APP_AT[0] + 92), s(APPS_AT[0] - 92)
    d.line([(x0, y), (x1 - s(14), y)], fill=LIME, width=s(5))
    d.polygon([(x1, y), (x1 - s(18), y - s(12)), (x1 - s(18), y + s(12))], fill=LIME)

    # A pill behind each label, sized to the label with padding.
    label_font = ImageFont.truetype(LABEL_FONT, 13)
    for label, (x, _) in LABELS:
        half = label_font.getlength(label) / 2 + 12
        d.rounded_rectangle([s(x - half), s(LABEL_Y - 11), s(x + half), s(LABEL_Y + 11)], radius=s(11), fill=PILL)

    note = ImageFont.truetype(FONT, s(13))
    line = "First time: right-click GSAM in Applications and choose Open."
    d.text(((s(WIDTH) - d.textlength(line, font=note)) / 2, s(HEIGHT - 52)), line, font=note, fill=MUTED)
    return img


one, two = draw(1), draw(2)
# The window is exactly the 1x image (dmg-settings.py); the @2x must be exactly double.
assert one.size == (WIDTH, HEIGHT) and two.size == (2 * WIDTH, 2 * HEIGHT)
one.save(HERE / "dmg-background.png", dpi=(72, 72))
two.save(HERE / "dmg-background@2x.png", dpi=(144, 144))
print("wrote dmg-background.png and dmg-background@2x.png")
