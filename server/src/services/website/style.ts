import { createHash } from "node:crypto";
import {
  contrastRatio,
  type WebsiteSiteStyle,
  type WebsiteStyleColour,
  type WebsiteStyleColourRole,
  type WebsiteStyleComponent,
  type WebsiteStyleComponentKind,
  type WebsiteStyleContrast,
  type WebsiteStyleContrastRating,
  type WebsiteStyleFont,
  type WebsiteStyleSource,
  type WebsiteStyleSurface,
  type WebsiteStyleTextStyle,
  type WebsiteStyleToken,
  type WebsiteStyleTokenKind,
  websitePreviewAddresses,
} from "@greatstone/shared";
import type { SiteRow } from "./module.js";

/**
 * The Website Style read (GRE-2520). It reads the site's own deployed HTML and
 * stylesheets, then lays the release theme tokens on top, as the site does, so the
 * Style tab and the agents see the values a visitor gets. Never a hand-typed copy.
 */

const PAGE_LIMIT_BYTES = 2_000_000;
const SHEET_LIMIT_BYTES = 1_500_000;
const MAX_SHEETS = 6;
const FETCH_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MISS_TTL_MS = 30_000;

// ---- CSS parsing ----

export interface CssRule {
  selector: string;
  declarations: Array<[string, string]>;
  /** The @media (or @supports) condition around the rule, or null at the top level. */
  media: string | null;
}

export interface CssFontFace {
  family: string;
  weight: string | null;
}

export interface ParsedCss {
  rules: CssRule[];
  fontFaces: CssFontFace[];
  keyframes: string[];
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The index of the brace that closes the block opened at `open`, skipping strings. */
function closingBrace(css: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < css.length; i++) {
    const ch = css[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
    } else if (ch === "\"" || ch === "'") quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
  }
  return css.length;
}

/** `prop: value; ...` to pairs, keeping `;` inside strings and brackets (data URLs). */
export function parseDeclarations(body: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let start = 0;
  let depth = 0;
  let quote: string | null = null;
  const push = (chunk: string) => {
    const colon = chunk.indexOf(":");
    if (colon < 1) return;
    const prop = chunk.slice(0, colon).trim().toLowerCase();
    const value = chunk.slice(colon + 1).replace(/!important\s*$/i, "").trim();
    if (prop && value) out.push([prop.startsWith("--") ? chunk.slice(0, colon).trim() : prop, value]);
  };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
    } else if (ch === "\"" || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === ";" && depth === 0) {
      push(body.slice(start, i));
      start = i + 1;
    }
  }
  push(body.slice(start));
  return out;
}

export function parseCss(source: string): ParsedCss {
  const parsed: ParsedCss = { rules: [], fontFaces: [], keyframes: [] };
  const walk = (css: string, media: string | null) => {
    let i = 0;
    while (i < css.length) {
      const open = css.indexOf("{", i);
      const semi = css.indexOf(";", i);
      // A statement at-rule (`@import ...;`, `@charset ...;`) before the next block.
      if (semi !== -1 && (open === -1 || semi < open) && css.slice(i, semi).trim().startsWith("@")) {
        i = semi + 1;
        continue;
      }
      if (open === -1) break;
      const prelude = css.slice(i, open).trim();
      const close = closingBrace(css, open);
      const body = css.slice(open + 1, close);
      i = close + 1;
      if (prelude.startsWith("@")) {
        const name = /^@([\w-]+)/.exec(prelude)?.[1]?.toLowerCase() ?? "";
        if (name === "media" || name === "supports" || name === "layer" || name === "container") {
          walk(body, name === "layer" ? media : prelude);
        } else if (name === "font-face") {
          const decls = new Map(parseDeclarations(body));
          const family = unquote(decls.get("font-family") ?? "");
          if (family) parsed.fontFaces.push({ family, weight: decls.get("font-weight") ?? null });
        } else if (name.endsWith("keyframes")) {
          const kf = prelude.replace(/^@[\w-]+\s*/, "").trim();
          if (kf && !parsed.keyframes.includes(kf)) parsed.keyframes.push(kf);
        }
        continue;
      }
      if (prelude) parsed.rules.push({ selector: prelude.replace(/\s+/g, " "), declarations: parseDeclarations(body), media });
    }
  };
  walk(stripComments(source), null);
  return parsed;
}

function unquote(value: string): string {
  return value.trim().replace(/^["']|["']$/g, "").trim();
}

function selectorList(selector: string): string[] {
  return selector.split(",").map((part) => part.trim()).filter(Boolean);
}

// ---- colours ----

interface Rgba { r: number; g: number; b: number; a: number }

const NAMED_COLOURS: Record<string, string> = {
  white: "#ffffff", black: "#000000", red: "#ff0000", green: "#008000", blue: "#0000ff",
  gray: "#808080", grey: "#808080", silver: "#c0c0c0", navy: "#000080", orange: "#ffa500",
  yellow: "#ffff00", purple: "#800080", teal: "#008080",
};

function clamp255(n: number) {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function channel(part: string, max = 255): number {
  const p = part.trim();
  return p.endsWith("%") ? (Number.parseFloat(p) / 100) * max : Number.parseFloat(p);
}

function alphaOf(part: string | undefined): number {
  if (part === undefined) return 1;
  const p = part.trim();
  const n = p.endsWith("%") ? Number.parseFloat(p) / 100 : Number.parseFloat(p);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/** A plain CSS colour (hex, rgb, hsl, a few names) to RGBA, or null for anything else. */
export function parseColour(value: string): Rgba | null {
  const v = value.trim().toLowerCase();
  if (v === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  if (NAMED_COLOURS[v]) return parseColour(NAMED_COLOURS[v]);
  const hex = /^#([0-9a-f]{3,8})$/.exec(v)?.[1];
  if (hex) {
    if (hex.length === 3 || hex.length === 4) {
      const [r, g, b, a] = hex.split("").map((c) => Number.parseInt(c + c, 16));
      return { r, g, b, a: a === undefined ? 1 : a / 255 };
    }
    if (hex.length === 6 || hex.length === 8) {
      const n = (i: number) => Number.parseInt(hex.slice(i, i + 2), 16);
      return { r: n(0), g: n(2), b: n(4), a: hex.length === 8 ? n(6) / 255 : 1 };
    }
    return null;
  }
  const fn = /^(rgba?|hsla?)\(([^()]*)\)$/.exec(v);
  if (!fn) return null;
  const [main, slashAlpha] = fn[2].split("/");
  const parts = main.includes(",") ? main.split(",") : main.trim().split(/\s+/);
  if (parts.length < 3) return null;
  const alpha = alphaOf(slashAlpha ?? parts[3]);
  if (fn[1].startsWith("rgb")) {
    const [r, g, b] = parts.slice(0, 3).map((p) => channel(p));
    if (![r, g, b].every(Number.isFinite)) return null;
    return { r: clamp255(r), g: clamp255(g), b: clamp255(b), a: alpha };
  }
  const h = Number.parseFloat(parts[0]);
  const s = Number.parseFloat(parts[1]) / 100;
  const l = Number.parseFloat(parts[2]) / 100;
  if (![h, s, l].every(Number.isFinite)) return null;
  const [r, g, b] = hslToRgb(((h % 360) + 360) % 360, s, l);
  return { r: clamp255(r), g: clamp255(g), b: clamp255(b), a: alpha };
}

function toHex({ r, g, b }: Pick<Rgba, "r" | "g" | "b">): string {
  return `#${[r, g, b].map((n) => clamp255(n).toString(16).padStart(2, "0")).join("")}`;
}

/** The colour as seen on an opaque background. */
function composite(top: Rgba, under: Rgba): Rgba {
  const a = top.a;
  return { r: top.r * a + under.r * (1 - a), g: top.g * a + under.g * (1 - a), b: top.b * a + under.b * (1 - a), a: 1 };
}

export function contrastRating(ratio: number): WebsiteStyleContrastRating {
  if (ratio >= 7) return "AAA";
  if (ratio >= 4.5) return "AA";
  if (ratio >= 3) return "AA large";
  return "Fail";
}

// ---- tokens and names ----

/**
 * The release theme as CSS variables. Keys may be nested objects or dotted paths
 * (`gs.accent` or `{ gs: { accent } }`), or already a variable (`--gs-accent`);
 * the site writes each as `--gs-accent` on :root.
 */
export function themeVariables(theme: Record<string, unknown>): Map<string, { token: string; value: string }> {
  const out = new Map<string, { token: string; value: string }>();
  const visit = (value: unknown, path: string[]) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) visit(child, [...path, key]);
      return;
    }
    if (typeof value !== "string" && typeof value !== "number") return;
    const token = path.join(".");
    if (!token) return;
    const cssVar = token.startsWith("--")
      ? token
      : `--${path.join("-").replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[._\s]+/g, "-").toLowerCase()}`;
    out.set(cssVar, { token, value: String(value).trim() });
  };
  visit(theme, []);
  return out;
}

/** `--gs-accent-dim` → "Accent dim". A shared prefix of two letters or fewer (`gs`, `c`) is dropped. */
export function nameFromVariable(cssVar: string): string {
  const parts = cssVar.replace(/^--/, "").split(/[-_]+/).filter(Boolean);
  const words = parts.length > 1 && parts[0].length <= 2 ? parts.slice(1) : parts;
  const text = words.join(" ");
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : cssVar;
}

function propertyKind(prop: string): string {
  if (prop === "color" || prop === "caret-color" || prop === "text-decoration-color" || prop === "-webkit-text-fill-color") return "text";
  if (prop.startsWith("background")) return "background";
  if (prop.startsWith("border") || prop.startsWith("outline")) return "border";
  if (prop.endsWith("shadow")) return "shadow";
  return "other";
}

function roleFromName(cssVar: string): WebsiteStyleColourRole | null {
  const n = cssVar.toLowerCase();
  if (/success|error|danger|warn|info|positive|negative/.test(n)) return "status";
  if (/border|line|divider|rule|stroke|outline/.test(n)) return "border";
  if (/accent|primary|brand|highlight|link|cta|secondary/.test(n)) return "accent";
  if (/text|fg|foreground|ink|muted|heading|copy|body-color/.test(n)) return "text";
  if (/bg|background|surface|paper|canvas|panel|card|base|dark|light/.test(n)) return "background";
  return null;
}

function tokenKind(cssVar: string, value: string): WebsiteStyleTokenKind {
  const n = cssVar.toLowerCase();
  if (/radius|rounded|round/.test(n)) return "radius";
  if (/ease|duration|transition|speed|delay|motion|anim/.test(n) || /cubic-bezier|\d(ms|s)$/.test(value)) return "motion";
  if (/space|spacing|gap|pad|margin|gutter|inset|section-y|stack/.test(n)) return "spacing";
  if (/width|height|max|min|size|container|wrap|nav-h|header-h/.test(n)) return "size";
  return "other";
}

// ---- the style read ----

interface Sources {
  siteUrl: string;
  sheets: Array<{ url: string; css: string }>;
  inlineCss: string;
  fontStylesheets: string[];
}

const VAR_REF = /var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/g;

/** Build the style answer from what was read. Pure, so the tests can feed it a stylesheet. */
export function buildSiteStyle(input: {
  siteId: string;
  siteUrl: string;
  theme: Record<string, unknown>;
  css: string;
  stylesheets: string[];
  fontStylesheets: string[];
  problem: string | null;
  readAt?: Date;
}): WebsiteSiteStyle {
  const parsed = parseCss(input.css);
  const release = themeVariables(input.theme);

  // Variables on :root / html at the top level; a later rule wins, the release theme wins over all.
  const vars = new Map<string, { value: string; source: WebsiteStyleSource; token: string | null }>();
  for (const rule of parsed.rules) {
    if (rule.media) continue;
    if (!selectorList(rule.selector).some((s) => s === ":root" || s === "html")) continue;
    for (const [prop, value] of rule.declarations) {
      if (prop.startsWith("--")) vars.set(prop, { value, source: "stylesheet", token: null });
    }
  }
  for (const [cssVar, { token, value }] of release) vars.set(cssVar, { value, source: "release", token });

  const resolve = (value: string, depth = 0): string => {
    if (depth > 8 || !value.includes("var(")) return value;
    return resolve(value.replace(VAR_REF, (_m, name: string, fallback?: string) => {
      const hit = vars.get(name);
      return hit ? hit.value : (fallback?.trim() ?? "");
    }), depth + 1);
  };

  // Where each variable is used: property kinds and selectors.
  type Usage = { kinds: Map<string, number>; selectors: string[] };
  const usage = new Map<string, Usage>();
  const emptyUsage = (): Usage => ({ kinds: new Map(), selectors: [] });
  for (const rule of parsed.rules) {
    for (const [prop, value] of rule.declarations) {
      for (const match of value.matchAll(VAR_REF)) {
        const entry = usage.get(match[1]) ?? emptyUsage();
        const kind = prop.startsWith("--") ? null : propertyKind(prop);
        if (kind) entry.kinds.set(kind, (entry.kinds.get(kind) ?? 0) + 1);
        if (!prop.startsWith("--") && entry.selectors.length < 4 && !entry.selectors.includes(rule.selector)) entry.selectors.push(rule.selector);
        usage.set(match[1], entry);
      }
    }
  }
  // A variable that only feeds another variable takes that one's uses.
  for (const [name, { value }] of vars) {
    for (const match of value.matchAll(VAR_REF)) {
      const from = usage.get(name);
      if (!from) continue;
      const to = usage.get(match[1]) ?? emptyUsage();
      for (const [k, c] of from.kinds) to.kinds.set(k, (to.kinds.get(k) ?? 0) + c);
      for (const s of from.selectors) if (to.selectors.length < 4 && !to.selectors.includes(s)) to.selectors.push(s);
      usage.set(match[1], to);
    }
  }

  const colours: WebsiteStyleColour[] = [];
  const tokens: WebsiteStyleToken[] = [];
  for (const [cssVar, entry] of vars) {
    const resolved = resolve(entry.value);
    const rgba = parseColour(resolved);
    const used = usage.get(cssVar);
    if (rgba) {
      const kinds = [...(used?.kinds ?? new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
      const named = roleFromName(cssVar);
      const fromUse: WebsiteStyleColourRole | null =
        kinds[0] === "text" ? "text" : kinds[0] === "background" ? "background" : kinds[0] === "border" ? "border" : null;
      colours.push({
        cssVar,
        token: entry.token,
        name: nameFromVariable(cssVar),
        value: entry.value === resolved ? entry.value : `${resolved}`,
        hex: toHex(rgba),
        alpha: Math.round(rgba.a * 100) / 100,
        role: named === "accent" || named === "status" ? named : fromUse ?? named ?? "other",
        usedFor: kinds,
        usedIn: used?.selectors ?? [],
        source: entry.source,
      });
    } else if (!/^(["']|url\()/.test(resolved) && !/,\s*(serif|sans-serif|monospace|system-ui)/.test(resolved)) {
      tokens.push({ name: cssVar, token: entry.token, value: resolved, kind: tokenKind(cssVar, resolved), source: entry.source });
    }
  }

  // Merged top-level declarations per simple selector, for the type scale, page and blocks.
  const merged = new Map<string, Map<string, string>>();
  for (const rule of parsed.rules) {
    if (rule.media) continue;
    for (const selector of selectorList(rule.selector)) {
      const decls = merged.get(selector) ?? new Map<string, string>();
      for (const [prop, value] of rule.declarations) if (!prop.startsWith("--")) decls.set(prop, value);
      merged.set(selector, decls);
    }
  }
  const declared = (selector: string, prop: string) => {
    const value = merged.get(selector)?.get(prop);
    return value === undefined ? null : resolve(value);
  };

  // The page background: body, then html, then a background-role colour, then white.
  const pageBgValue = declared("body", "background-color") ?? declared("body", "background") ?? declared("html", "background-color") ?? declared("html", "background");
  const pageBgParsed = pageBgValue ? parseColour(pageBgValue.split(/\s+/)[0]) : null;
  const pageBg = pageBgParsed && pageBgParsed.a > 0
    ? composite(pageBgParsed, { r: 255, g: 255, b: 255, a: 1 })
    : parseColour(colours.find((c) => c.role === "background" && c.alpha === 1)?.hex ?? "#ffffff")!;

  const contrast: WebsiteStyleContrast[] = [];
  const opaqueOn = (c: WebsiteStyleColour, under: Rgba) => toHex(composite({ ...parseColour(c.hex)!, a: c.alpha }, under));
  const texts = colours.filter((c) => c.role === "text" || c.role === "accent").slice(0, 10);
  const backgrounds = colours.filter((c) => c.role === "background").slice(0, 8);
  for (const bg of backgrounds) {
    const bgHex = opaqueOn(bg, pageBg);
    for (const text of texts) {
      if (text.cssVar === bg.cssVar) continue;
      const ratio = Math.round(contrastRatio(opaqueOn(text, parseColour(bgHex)!), bgHex) * 100) / 100;
      contrast.push({ text: text.cssVar, background: bg.cssVar, ratio, rating: contrastRating(ratio) });
    }
  }

  // Fonts: every font-family the stylesheet sets, with the weights the site loads.
  const googleWeights = new Map<string, number[]>();
  for (const href of input.fontStylesheets) {
    try {
      const url = new URL(href);
      for (const fam of url.searchParams.getAll("family")) {
        const [name, axes] = fam.split(":");
        const weights = (axes ?? "").replace(/^[a-z,]*@/i, "").split(";")
          .map((part) => Number.parseInt(part.split(",").pop() ?? "", 10)).filter((n) => Number.isFinite(n) && n >= 100);
        googleWeights.set(name.replace(/\+/g, " ").toLowerCase(), weights);
      }
    } catch {
      // not a URL: skip
    }
  }
  const faceWeights = new Map<string, number[]>();
  for (const face of parsed.fontFaces) {
    const key = face.family.toLowerCase();
    const list = faceWeights.get(key) ?? [];
    for (const part of (face.weight ?? "400").split(/\s+/)) {
      const n = part === "normal" ? 400 : part === "bold" ? 700 : Number.parseInt(part, 10);
      if (Number.isFinite(n) && !list.includes(n)) list.push(n);
    }
    faceWeights.set(key, list);
  }
  const fonts = new Map<string, WebsiteStyleFont>();
  const addFont = (stack: string, selector: string | null) => {
    const family = unquote(stack.split(",")[0] ?? "");
    if (!family || /^(inherit|initial|unset|var\()/.test(family)) return;
    const key = family.toLowerCase();
    const font: WebsiteStyleFont = fonts.get(key) ?? {
      family,
      stack,
      weights: [...new Set(googleWeights.get(key) ?? faceWeights.get(key) ?? [])].sort((a, b) => a - b),
      usedIn: [],
      loadedFrom: googleWeights.has(key) ? "google" : faceWeights.has(key) ? "font-face" : "system",
    };
    if (selector && font.usedIn.length < 6 && !font.usedIn.includes(selector)) font.usedIn.push(selector);
    fonts.set(key, font);
  };
  for (const rule of parsed.rules) {
    for (const [prop, value] of rule.declarations) {
      if (prop === "font-family") addFont(resolve(value), rule.selector);
    }
  }
  for (const [cssVar, entry] of vars) {
    const resolved = resolve(entry.value);
    if (/font|family|ff/i.test(cssVar) && !parseColour(resolved) && /[a-z]/i.test(resolved)) addFont(resolved, null);
  }

  // The type scale, H1 to small print, as the stylesheet sets it.
  const TEXT_STEPS: Array<[string, string]> = [
    ["h1", "Heading 1"], ["h2", "Heading 2"], ["h3", "Heading 3"], ["h4", "Heading 4"], ["h5", "Heading 5"], ["h6", "Heading 6"],
    [".lead", "Lead"], [".eyebrow", "Eyebrow"], [".kicker", "Kicker"], ["body", "Body"], ["p", "Paragraph"],
    ["blockquote", "Quote"], [".caption", "Caption"], ["small", "Small print"], [".small", "Small print"],
  ];
  const bodyFamily = declared("body", "font-family");
  const textStyles: WebsiteStyleTextStyle[] = [];
  for (const [selector, label] of TEXT_STEPS) {
    if (!merged.has(selector)) continue;
    textStyles.push({
      selector,
      label,
      fontFamily: declared(selector, "font-family") ?? (selector === "body" ? null : bodyFamily),
      fontSize: declared(selector, "font-size"),
      fontWeight: declared(selector, "font-weight"),
      lineHeight: declared(selector, "line-height"),
      letterSpacing: declared(selector, "letter-spacing"),
      textTransform: declared(selector, "text-transform"),
      color: declared(selector, "color"),
    });
  }

  // Building blocks: single-class rules for buttons, links, cards and pills.
  const components: WebsiteStyleComponent[] = [];
  const kindOf = (cls: string): WebsiteStyleComponentKind | null => {
    if (/^(btn|button|cta)([-_]|$)/.test(cls)) return "button";
    if (/^(link|text-link)([-_]|$)/.test(cls)) return "link";
    if (/(^|[-_])(pill|badge|chip|tag)([-_]|$)/.test(cls)) return "pill";
    if (/(^|[-_])card([-_]|$)/.test(cls) && !/__/.test(cls)) return "card";
    return null;
  };
  const seen = new Set<string>();
  for (const selector of merged.keys()) {
    const simple = /^\.([\w-]+)$/.exec(selector)?.[1];
    const isLink = selector === "a";
    if (!simple && !isLink) continue;
    const kind = isLink ? "link" : kindOf(simple!);
    if (!kind || seen.has(selector) || components.filter((c) => c.kind === kind).length >= 8) continue;
    seen.add(selector);
    const decls = merged.get(selector)!;
    if (decls.size === 0) continue;
    const base = simple?.split("--")[0];
    const className = isLink ? "" : base && base !== simple && merged.has(`.${base}`) ? `${base} ${simple}` : simple!;
    components.push({
      kind,
      selector,
      className,
      label: isLink ? "Text link" : nameFromVariable(`--${simple!.replace(/--/g, "-")}`),
      declarations: Object.fromEntries([...decls].map(([p, v]) => [p, resolve(v)])),
    });
    const radius = decls.get("border-radius");
    if (radius && !radius.includes("var(")) tokens.push({ name: `${selector} border-radius`, token: null, value: radius, kind: "radius", source: "stylesheet" });
  }

  // Motion in use: the keyframes the stylesheet defines.
  for (const name of parsed.keyframes.slice(0, 12)) {
    tokens.push({ name: `@keyframes ${name}`, token: null, value: "animation", kind: "motion", source: "stylesheet" });
  }

  // Background surfaces: the page and single-class sections or boxes with their own background.
  const surfaces: WebsiteStyleSurface[] = [];
  if (pageBgValue) surfaces.push({ selector: "body", label: "Page", background: pageBgValue });
  for (const [selector, decls] of merged) {
    if (surfaces.length >= 12) break;
    const cls = /^\.([\w-]+)$/.exec(selector)?.[1];
    if (!cls || !/(section|hero|band|surface|panel|footer|header|banner|strip|block|bg)/.test(cls)) continue;
    const background = decls.get("background") ?? decls.get("background-color");
    if (!background) continue;
    surfaces.push({ selector, label: nameFromVariable(`--${cls}`), background: resolve(background) });
  }

  const roleOrder: WebsiteStyleColourRole[] = ["background", "text", "accent", "border", "status", "other"];
  colours.sort((a, b) => roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role));

  return {
    siteId: input.siteId,
    siteUrl: input.siteUrl,
    readAt: (input.readAt ?? new Date()).toISOString(),
    stylesheets: input.stylesheets,
    fontStylesheets: input.fontStylesheets,
    releaseTokenCount: release.size,
    problem: input.problem,
    colours,
    contrast,
    fonts: [...fonts.values()],
    textStyles,
    components,
    tokens,
    surfaces,
  };
}

// ---- reading the deployed site ----

async function fetchText(url: string, limit: number): Promise<string> {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { "user-agent": "GSAM-Website-Style/1" } });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const text = await res.text();
  return text.length > limit ? text.slice(0, limit) : text;
}

/** The site's own stylesheets (same host) and font stylesheets (Google Fonts) from its HTML. */
export function stylesheetLinks(html: string, pageUrl: string): { own: string[]; fonts: string[]; inline: string } {
  const own: string[] = [];
  const fonts: string[] = [];
  const page = new URL(pageUrl);
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/rel\s*=\s*["']?[^"'>]*stylesheet/i.test(tag)) continue;
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href) continue;
    let url: URL;
    try {
      url = new URL(href.replace(/&amp;/g, "&"), page);
    } catch {
      continue;
    }
    if (url.hostname === "fonts.googleapis.com") fonts.push(url.toString());
    else if (url.host === page.host && /^https?:$/.test(url.protocol) && !own.includes(url.toString())) own.push(url.toString());
  }
  const inline = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n");
  return { own: own.slice(0, MAX_SHEETS), fonts, inline };
}

async function readSources(siteUrl: string): Promise<Sources> {
  const html = await fetchText(siteUrl, PAGE_LIMIT_BYTES);
  const links = stylesheetLinks(html, siteUrl);
  const sheets = await Promise.all(links.own.map(async (url) => ({ url, css: await fetchText(url, SHEET_LIMIT_BYTES).catch(() => "") })));
  // A font stylesheet the site @imports from its own CSS counts too.
  for (const sheet of sheets) {
    for (const m of sheet.css.matchAll(/@import\s+(?:url\()?["']?(https:\/\/fonts\.googleapis\.com\/[^"')\s;]+)/g)) {
      if (!links.fonts.includes(m[1])) links.fonts.push(m[1]);
    }
  }
  return { siteUrl, sheets: sheets.filter((s) => s.css), inlineCss: links.inline, fontStylesheets: links.fonts };
}

const cache = new Map<string, { at: number; value: WebsiteSiteStyle }>();

export function websiteStyleService() {
  return {
    /** The site's style, cached ten minutes per address and release theme. */
    async read(site: SiteRow, options: { fresh?: boolean } = {}): Promise<WebsiteSiteStyle> {
      const siteUrl = websitePreviewAddresses(site).live;
      const theme = (site.theme ?? {}) as Record<string, unknown>;
      const key = `${site.id} ${siteUrl} ${createHash("sha256").update(JSON.stringify(theme)).digest("hex")}`;
      const hit = cache.get(key);
      if (!options.fresh && hit && Date.now() - hit.at < (hit.value.problem ? CACHE_MISS_TTL_MS : CACHE_TTL_MS)) return hit.value;
      let sources: Sources | null = null;
      let problem: string | null = null;
      try {
        sources = await readSources(siteUrl);
        if (sources.sheets.length === 0 && !sources.inlineCss.trim()) problem = "The site's page links no stylesheet of its own.";
      } catch (error) {
        problem = `The site could not be read: ${error instanceof Error ? error.message : String(error)}`;
      }
      const value = buildSiteStyle({
        siteId: site.id,
        siteUrl,
        theme,
        css: [...(sources?.sheets.map((s) => s.css) ?? []), sources?.inlineCss ?? ""].join("\n"),
        stylesheets: sources?.sheets.map((s) => s.url) ?? [],
        fontStylesheets: sources?.fontStylesheets ?? [],
        problem,
      });
      cache.set(key, { at: Date.now(), value });
      return value;
    },
  };
}
