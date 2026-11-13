import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const glassCss = read("../greatstone-glass.css");
const indexCss = read("../index.css");

type Rgb = [number, number, number];
const hex = (value: string): Rgb => {
  const h = value.trim().replace("#", "");
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as Rgb;
};
const over = (top: Rgb, alpha: number, under: Rgb): Rgb =>
  top.map((channel, i) => channel * alpha + under[i]! * (1 - alpha)) as Rgb;
const luminance = (rgb: Rgb) => {
  const [r, g, b] = rgb.map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

/** `--name` inside the `selector {` block of the Messages hub section, falling back to :root. */
function hubToken(selector: ":root" | ".dark", name: string): string {
  const block = glassCss.slice(glassCss.indexOf("Messages hub: messenger bubbles"));
  for (const candidate of selector === ".dark" ? [".dark", ":root"] : [":root"]) {
    const start = block.indexOf(`${candidate} {`);
    const body = block.slice(start, block.indexOf("}", start));
    const match = new RegExp(`${name}:([^;]+);`).exec(body);
    if (match) return match[1]!.trim();
  }
  throw new Error(`${name} missing for ${selector}`);
}
/** A colour token: `#rrggbb`, or `rgb(r g b / a)` composited over the backdrop. */
function paint(value: string, backdrop: Rgb): Rgb {
  if (value.startsWith("#")) return hex(value);
  const m = /rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)/.exec(value);
  if (!m) throw new Error(`unreadable colour ${value}`);
  return over([Number(m[1]), Number(m[2]), Number(m[3])], Number(m[4]), backdrop);
}
function textToken(theme: "light" | "dark", name: string): Rgb {
  const start = theme === "light" ? indexCss.indexOf("--foreground: #121512") : indexCss.indexOf("--foreground: #f5f5f5");
  const match = new RegExp(`--${name}: (#[0-9a-f]{6})`).exec(indexCss.slice(start - 200, start + 20000));
  return hex(match![1]!);
}

// The brightest thing a glass bubble can sit over, per theme.
const backdrops = {
  dark: { "void": hex("#121212"), "emerald wash": over([27, 80, 57], 0.5, hex("#121212")) },
  light: { "paper": hex("#e9ede3"), "lime glint": over([200, 255, 0], 0.24, hex("#e9ede3")) },
} as const;

describe("Messages hub legibility (WCAG AA 4.5:1, solid text only)", () => {
  for (const theme of ["dark", "light"] as const) {
    const selector = theme === "dark" ? ".dark" : ":root";

    it(`${theme}: my lime bubble carries its text`, () => {
      const ratio = contrast(hex(hubToken(selector, "--gs-bubble-mine-fg")), hex(hubToken(selector, "--gs-bubble-mine-bg")));
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    });

    for (const [name, backdrop] of Object.entries(backdrops[theme])) {
      for (const token of ["foreground", "muted-foreground"]) {
        it(`${theme}: ${token} on a glass bubble over the ${name}`, () => {
          const bubble = paint(hubToken(selector, "--gs-bubble-theirs-bg"), backdrop);
          expect(contrast(textToken(theme, token), bubble)).toBeGreaterThanOrEqual(4.5);
        });
      }
      it(`${theme}: initials on a conversation avatar over the ${name}`, () => {
        const avatar = paint(hubToken(selector, "--gs-convo-avatar-bg"), backdrop);
        expect(contrast(textToken(theme, "foreground"), avatar)).toBeGreaterThanOrEqual(4.5);
      });
    }

    it(`${theme}: the unread badge`, () => {
      expect(contrast(textToken(theme, "primary-foreground"), textToken(theme, "primary"))).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("never fades bubble or list text with opacity", () => {
    const hub = glassCss.slice(glassCss.indexOf("Messages hub: messenger bubbles"));
    expect(hub).not.toMatch(/(^|[^-])opacity\s*:/m);
    const thread = read("../components/team-chat/TeamChatThread.tsx");
    expect(thread).not.toMatch(/own \? "opacity-/);
  });
});
