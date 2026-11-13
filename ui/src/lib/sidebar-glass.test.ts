import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const glassCss = read("../greatstone-glass.css");
const indexCss = read("../index.css");

type Rgb = [number, number, number];

const hex = (value: string): Rgb => {
  const h = value.replace("#", "");
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

/** The value of `--name` inside the first `selector {` block after the sidebar v2 marker. */
function sidebarToken(selector: string, name: string): string {
  const block = glassCss.slice(glassCss.indexOf("Sidebar v2: floating liquid glass"));
  const start = block.indexOf(`${selector} {`);
  const body = block.slice(start, block.indexOf("}", start));
  const match = new RegExp(`${name}:([^;]+);`).exec(body);
  if (!match) throw new Error(`${name} missing in ${selector}`);
  return match[1]!;
}
function textToken(theme: "light" | "dark", name: string): Rgb {
  const start = theme === "light" ? indexCss.indexOf("--foreground: #121512") : indexCss.indexOf("--foreground: #f5f5f5");
  const match = new RegExp(`--${name}: (#[0-9a-f]{6})`).exec(indexCss.slice(start - 200, start + 20000));
  return hex(match![1]!);
}
/** The near-opaque base under the glass gradient, and the gradient's least helpful white stop. */
function glass(selector: string): { base: Rgb; alpha: number; white: number } {
  const bg = sidebarToken(selector, "--glass-sidebar-bg");
  const stops = [...bg.matchAll(/rgb\(255 255 255 \/ ([\d.]+)\)/g)].map((m) => Number(m[1]));
  const base = /rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)\s*$/.exec(bg.trim())!;
  return {
    base: [Number(base[1]), Number(base[2]), Number(base[3])],
    alpha: Number(base[4]),
    white: selector === ".dark" ? Math.max(...stops) : Math.min(...stops),
  };
}
function surface(selector: string, backdrop: Rgb): Rgb {
  const g = glass(selector);
  return over([255, 255, 255], g.white, over(g.base, g.alpha, backdrop));
}

describe("sidebar liquid glass legibility", () => {
  // The brightest emerald wash behind the sidebar, and what a peeking panel
  // can float over: a lime button in the dark, ink in daylight.
  const darkBackdrops: Record<string, Rgb> = {
    "emerald wash": over([27, 80, 57], 0.5, hex("#121212")),
    "deep emerald": over([14, 49, 34], 0.6, hex("#121212")),
    "lime button": hex("#c8ff00"),
  };
  const lightBackdrops: Record<string, Rgb> = {
    "lime glint": over([200, 255, 0], 0.24, hex("#e9ede3")),
    "emerald wash": over([27, 80, 57], 0.14, hex("#e9ede3")),
    "ink": hex("#121512"),
  };

  for (const [theme, selector, backdrops] of [
    ["dark", ".dark", darkBackdrops],
    ["light", ":root", lightBackdrops],
  ] as const) {
    for (const token of ["foreground", "muted-foreground"]) {
      for (const [name, backdrop] of Object.entries(backdrops)) {
        it(`${theme}: ${token} clears 4.5:1 over the ${name}`, () => {
          const ratio = contrast(textToken(theme, token), surface(selector, backdrop));
          expect(ratio).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
  }

  it("never fades sidebar text with opacity", () => {
    const block = glassCss.slice(glassCss.indexOf("Sidebar v2: floating liquid glass"));
    expect(block).not.toMatch(/(^|[\s{;])opacity\s*:/);
  });
});

describe("Everest orb motion", () => {
  it("stops the glow, bob and ring under reduced motion, and keeps 'working' as a solid ring", () => {
    const css = glassCss;
    const blocks: string[] = [];
    const marker = "@media (prefers-reduced-motion: reduce)";
    for (let at = css.indexOf(marker); at >= 0; at = css.indexOf(marker, at + 1)) {
      let depth = 0;
      let end = css.indexOf("{", at);
      for (let i = end; i < css.length; i += 1) {
        if (css[i] === "{") depth += 1;
        if (css[i] === "}") depth -= 1;
        if (depth === 0) { end = i; break; }
      }
      blocks.push(css.slice(at, end));
    }
    const orbBlock = blocks.find((block) => block.includes(".gs-everest-orb"));
    expect(orbBlock).toBeDefined();
    const stopped = /([^{}]+)\{\s*animation:\s*none;?\s*\}/.exec(orbBlock!)?.[1] ?? "";
    for (const selector of [".gs-everest-orb,", ".gs-everest-orb-stone", '.gs-everest-orb[data-working="true"]::after']) {
      expect(stopped).toContain(selector);
    }
    expect(orbBlock).toMatch(/\.gs-everest-orb\[data-working="true"\]::after \{ border-color: #c8ff00; \}/);
  });
});
