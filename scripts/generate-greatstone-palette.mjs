#!/usr/bin/env node
/**
 * generate-greatstone-palette.mjs
 *
 * Retunes Tailwind's colour palettes into the Greatstone families at the token
 * layer, so the ~3,000 hard-coded palette classes in ui/ (text-blue-600,
 * bg-green-500/10, ...) follow the brand without touching a component.
 *
 * Each step keeps Tailwind's WCAG relative LUMINANCE exactly (solved per step,
 * kept inside sRGB), so every class keeps the contrast it was designed with;
 * only hue (and, where the brand is quieter, chroma) moves. Matching OKLCH
 * lightness alone was not enough: green-700 on green-100 fell to 4.46:1 as teal.
 *
 *   blue            -> "live": lime on the void, emerald on paper
 *   sky, cyan       -> teal (information)
 *   green, emerald  -> brand teal (success)
 *   red, rose       -> coral (danger)
 *   violet, purple, indigo -> brand purple (review, joint)
 *   slate, zinc, gray, neutral -> Greatstone green-greys
 *   amber, yellow, orange      -> unchanged (already on brand)
 *
 * Output: ui/src/greatstone-palette.css (imported by index.css). Re-run after a
 * Tailwind upgrade:  node scripts/generate-greatstone-palette.mjs
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function findTailwindTheme() {
  const store = path.join(ROOT, "node_modules", ".pnpm");
  const dir = readdirSync(store).find((name) => /^tailwindcss@4\./.test(name));
  if (!dir) throw new Error("tailwindcss v4 not found in node_modules/.pnpm");
  return path.join(store, dir, "node_modules", "tailwindcss", "theme.css");
}

const source = readFileSync(findTailwindTheme(), "utf8");
const palette = {};
for (const [, name, step, l, c, h] of source.matchAll(/--color-([a-z]+)-(\d+):\s*oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\);/g)) {
  (palette[name] ??= {})[step] = { l: Number(l), c: Number(c), h: Number(h) };
}

// hue: target hue; chroma: scale applied to Tailwind's chroma; max: chroma cap.
const LIGHT = {
  blue: { hue: 152, chroma: 0.62, max: 0.16 },
  sky: { hue: 200, chroma: 0.75, max: 0.13 },
  cyan: { hue: 196, chroma: 0.8, max: 0.13 },
  green: { hue: 182, chroma: 0.72, max: 0.14 },
  emerald: { hue: 178, chroma: 0.72, max: 0.14 },
  red: { hue: 22, chroma: 0.86, max: 0.21 },
  rose: { hue: 18, chroma: 0.8, max: 0.19 },
  violet: { hue: 293, chroma: 0.72, max: 0.17 },
  purple: { hue: 296, chroma: 0.72, max: 0.17 },
  indigo: { hue: 288, chroma: 0.7, max: 0.16 },
  slate: { hue: 145, chroma: 0, max: 0.012, floor: 0.006 },
  zinc: { hue: 145, chroma: 0, max: 0.01, floor: 0.005 },
  gray: { hue: 145, chroma: 0, max: 0.012, floor: 0.006 },
  neutral: { hue: 145, chroma: 0, max: 0.008, floor: 0.004 },
};
// On the void, "live" is the brand lime; everything else keeps its light mapping.
const DARK = { ...LIGHT, blue: { hue: 124, chroma: 1.25, max: 0.26 } };

const fmt = (n, d) => Number(n.toFixed(d)).toString();

// OKLCH -> linear sRGB (Ottosson's OKLab matrices).
function linearRgb(l, c, h) {
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const [L, M, S] = [l_ ** 3, m_ ** 3, s_ ** 3];
  return [
    4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
  ];
}
const inGamut = (rgb) => rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);
// WCAG relative luminance straight from linear sRGB.
const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * Keep WCAG relative LUMINANCE (not just OKLCH lightness) identical to
 * Tailwind's step, so every contrast pair built from these palettes is
 * unchanged. Chroma steps down until the colour is inside sRGB.
 */
function matchLuminance(original, hue, chroma) {
  const target = luminance(linearRgb(original.l / 100, original.c, original.h));
  for (let c = chroma; c >= 0; c -= 0.004) {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 40; i += 1) {
      const mid = (lo + hi) / 2;
      if (luminance(linearRgb(mid, c, hue)) < target) lo = mid;
      else hi = mid;
    }
    const l = (lo + hi) / 2;
    if (inGamut(linearRgb(l, c, hue))) return { l: l * 100, c };
  }
  return { l: original.l, c: 0 };
}

function block(selector, map, note) {
  const lines = [`${selector} {`, `  /* ${note} */`];
  for (const [name, rule] of Object.entries(map)) {
    const steps = palette[name];
    if (!steps) continue;
    for (const [step, original] of Object.entries(steps)) {
      let chroma = Math.min(original.c * rule.chroma, rule.max);
      if (rule.floor) chroma = Math.max(chroma, rule.floor);
      const matched = matchLuminance(original, rule.hue, chroma);
      lines.push(`  --color-${name}-${step}: oklch(${fmt(matched.l, 2)}% ${fmt(matched.c, 3)} ${rule.hue});`);
    }
  }
  lines.push("}");
  return lines.join("\n");
}

const out = [
  "/* GENERATED by scripts/generate-greatstone-palette.mjs. Do not edit by hand. */",
  "/* Tailwind palettes retuned to the Greatstone families: same WCAG luminance per",
  "   step (so every contrast pair is unchanged), brand hue and chroma. */",
  "",
  block(":root", LIGHT, "Paper: live is emerald."),
  "",
  block(".dark", DARK, "Void: live is lime."),
  "",
].join("\n");

const target = path.join(ROOT, "ui", "src", "greatstone-palette.css");
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== out) {
    console.error("greatstone-palette.css is stale: run node scripts/generate-greatstone-palette.mjs");
    process.exit(1);
  }
  console.log("greatstone-palette.css is current");
} else {
  writeFileSync(target, out);
  console.log(`wrote ${path.relative(ROOT, target)}`);
}
