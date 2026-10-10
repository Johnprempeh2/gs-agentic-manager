import type { PartnerBranding } from "@greatstone/shared";
import { getPartnerBranding } from "./services/partner-branding.js";

const FAVICON_BLOCK_START = "<!-- GSAM_FAVICON_START -->";
const FAVICON_BLOCK_END = "<!-- GSAM_FAVICON_END -->";
const RUNTIME_BRANDING_BLOCK_START = "<!-- GSAM_RUNTIME_BRANDING_START -->";
const RUNTIME_BRANDING_BLOCK_END = "<!-- GSAM_RUNTIME_BRANDING_END -->";

const DEFAULT_FAVICON_LINKS = [
  '<link rel="icon" href="/favicon.ico" sizes="48x48" />',
  '<link rel="icon" href="/favicon.svg" type="image/svg+xml" />',
  '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />',
  '<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />',
].join("\n");

export type WorktreeUiBranding = {
  enabled: boolean;
  name: string | null;
  color: string | null;
  textColor: string | null;
  faviconHref: string | null;
  /**
   * Runtime instance id for this worktree preview. Surfaced to the client so
   * the experimental "Run tasks in this worktree" card can fail closed when a
   * copied settings row was armed in a different instance. Null outside a
   * worktree or when the runtime id is unset.
   */
  instanceId: string | null;
};

function isTruthyEnvValue(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function nonEmpty(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeHexColor(value: string | undefined): string | null {
  const raw = nonEmpty(value);
  if (!raw) return null;
  const hex = raw.startsWith("#") ? raw.slice(1) : raw;
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return `#${hex.split("").map((char) => `${char}${char}`).join("").toLowerCase()}`;
  }
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    return `#${hex.toLowerCase()}`;
  }
  return null;
}

function hslComponentToHex(n: number): string {
  return Math.round(Math.max(0, Math.min(255, n)))
    .toString(16)
    .padStart(2, "0");
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const s = Math.max(0, Math.min(100, saturation)) / 100;
  const l = Math.max(0, Math.min(100, lightness)) / 100;
  const c = (1 - Math.abs((2 * l) - 1)) * s;
  const h = ((hue % 360) + 360) % 360;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - (c / 2);

  let r = 0;
  let g = 0;
  let b = 0;

  if (h < 60) {
    r = c;
    g = x;
  } else if (h < 120) {
    r = x;
    g = c;
  } else if (h < 180) {
    g = c;
    b = x;
  } else if (h < 240) {
    g = x;
    b = c;
  } else if (h < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }

  return `#${hslComponentToHex((r + m) * 255)}${hslComponentToHex((g + m) * 255)}${hslComponentToHex((b + m) * 255)}`;
}

function deriveColorFromSeed(seed: string): string {
  let hash = 0;
  for (const char of seed) {
    hash = ((hash * 33) + char.charCodeAt(0)) >>> 0;
  }
  return hslToHex(hash % 360, 68, 56);
}

function hexToRgb(color: string): { r: number; g: number; b: number } {
  const normalized = normalizeHexColor(color) ?? "#000000";
  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16),
  };
}

function relativeLuminanceChannel(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(color: string): number {
  const { r, g, b } = hexToRgb(color);
  return (
    (0.2126 * relativeLuminanceChannel(r)) +
    (0.7152 * relativeLuminanceChannel(g)) +
    (0.0722 * relativeLuminanceChannel(b))
  );
}

function pickReadableTextColor(background: string): string {
  const backgroundLuminance = relativeLuminance(background);
  const whiteContrast = 1.05 / (backgroundLuminance + 0.05);
  const blackContrast = (backgroundLuminance + 0.05) / 0.05;
  return whiteContrast >= blackContrast ? "#f8fafc" : "#111827";
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// The Greatstone stone (traced master logo); keep in sync with
// BRAND_STONE_SLABS in ui/src/components/BrandMark.tsx.
const BRAND_STONE_SLABS = [
  "209,295 223,298 253,333 252,337 225,374 217,392 204,398 201,388 144,420 132,419 86,399 73,406 22,355 112,300",
  "262,216 265,216 265,223 259,317 223,277 123,281 26,338 0,249",
  "30,149 218,208 10,235 13,174 24,153",
  "98,69 116,71 155,114 264,116 284,179 202,189 40,137 36,127 42,116 85,77",
  "179,0 189,0 246,28 265,92 154,91 143,84 106,41 121,26",
];

function createFaviconDataUrl(background: string, foreground: string): string {
  // 284 x 420 stone scaled to 74% of a 64px tile, centred.
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">',
    `<rect width="64" height="64" rx="14" fill="${background}"/>`,
    `<g fill="${foreground}" transform="translate(15.991 8.32) scale(0.11276)">`,
    ...BRAND_STONE_SLABS.map((points) => `<polygon points="${points}"/>`),
    "</g>",
    "</svg>",
  ].join("");
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function isWorktreeUiBrandingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthyEnvValue(env.GSAM_IN_WORKTREE);
}

export function getWorktreeUiBranding(env: NodeJS.ProcessEnv = process.env): WorktreeUiBranding {
  if (!isWorktreeUiBrandingEnabled(env)) {
    return {
      enabled: false,
      name: null,
      color: null,
      textColor: null,
      faviconHref: null,
      instanceId: null,
    };
  }

  const name = nonEmpty(env.GSAM_WORKTREE_NAME) ?? nonEmpty(env.GSAM_INSTANCE_ID) ?? "worktree";
  const color = normalizeHexColor(env.GSAM_WORKTREE_COLOR) ?? deriveColorFromSeed(name);
  const textColor = pickReadableTextColor(color);

  return {
    enabled: true,
    name,
    color,
    textColor,
    faviconHref: createFaviconDataUrl(color, textColor),
    instanceId: nonEmpty(env.GSAM_INSTANCE_ID),
  };
}

export function renderFaviconLinks(branding: WorktreeUiBranding): string {
  if (!branding.enabled || !branding.faviconHref) return DEFAULT_FAVICON_LINKS;

  const href = escapeHtmlAttribute(branding.faviconHref);
  return [
    `<link rel="icon" href="${href}" type="image/svg+xml" sizes="any" />`,
    `<link rel="shortcut icon" href="${href}" type="image/svg+xml" />`,
  ].join("\n");
}

export function renderRuntimeBrandingMeta(branding: WorktreeUiBranding): string {
  if (!branding.enabled || !branding.name || !branding.color || !branding.textColor) return "";

  const tags = [
    '<meta name="paperclip-worktree-enabled" content="true" />',
    `<meta name="paperclip-worktree-name" content="${escapeHtmlAttribute(branding.name)}" />`,
    `<meta name="paperclip-worktree-color" content="${escapeHtmlAttribute(branding.color)}" />`,
    `<meta name="paperclip-worktree-text-color" content="${escapeHtmlAttribute(branding.textColor)}" />`,
  ];
  if (branding.instanceId) {
    tags.push(`<meta name="paperclip-instance-id" content="${escapeHtmlAttribute(branding.instanceId)}" />`);
  }
  return tags.join("\n");
}

function replaceMarkedBlock(html: string, startMarker: string, endMarker: string, content: string): string {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start) return html;

  const before = html.slice(0, start + startMarker.length);
  const after = html.slice(end);
  const indentedContent = content
    ? `\n${content
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n")}\n    `
    : "\n    ";
  return `${before}${indentedContent}${after}`;
}

const DEFAULT_PRODUCT_NAME = "GS Agentic Manager";

function escapeHtmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** A double-quoted JS string literal that is also safe inside an inline <script>. */
function jsStringLiteral(value: string): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

export const PARTNER_BRANDING_META_NAME = "gsam-partner-branding";

/**
 * Partner branding in the HTML head: the brand as JSON in a meta tag (the UI
 * reads it synchronously, so the Greatstone brand never flashes before
 * `/api/health` loads) and theme overrides. The selectors outrank the
 * stylesheet's `:root` and `.dark` blocks whatever order they load in, and
 * each mode is set only when the colour passed that mode's contrast check.
 */
export function renderPartnerBrandingHead(branding: PartnerBranding | null): string {
  if (!branding) return "";
  const tags = [
    `<meta name="${PARTNER_BRANDING_META_NAME}" content="${escapeHtmlAttribute(JSON.stringify(branding))}" />`,
  ];
  const blocks: string[] = [];
  for (const [mode, selector] of [["light", "html:root:not(.dark)"], ["dark", "html.dark"]] as const) {
    const color = branding.colors[mode];
    if (!color) continue;
    blocks.push(
      `${selector}{--primary:${color.primary};--primary-foreground:${color.primaryForeground};` +
        `--sidebar-primary:${color.primary};--sidebar-primary-foreground:${color.primaryForeground};` +
        `--ring:${color.primary};}`,
    );
  }
  if (blocks.length) tags.push(`<style id="gsam-partner-theme">${blocks.join("")}</style>`);
  return tags.join("\n");
}

/**
 * Swap the product name in the HTML shell (tab title, phone install title and
 * the startup notice) so the partner name shows before the app's JS loads.
 */
export function applyPartnerProductName(html: string, name: string | null): string {
  if (!name) return html;
  return html
    .replace(`<title>${DEFAULT_PRODUCT_NAME}</title>`, `<title>${escapeHtmlText(name)}</title>`)
    .replace(
      `<meta name="apple-mobile-web-app-title" content="${DEFAULT_PRODUCT_NAME}" />`,
      `<meta name="apple-mobile-web-app-title" content="${escapeHtmlAttribute(name)}" />`,
    )
    .replaceAll(`>${DEFAULT_PRODUCT_NAME} couldn’t start<`, `>${escapeHtmlText(name)} couldn’t start<`)
    .replace(
      new RegExp(`"${DEFAULT_PRODUCT_NAME} (couldn’t start|is taking longer to load)"`, "g"),
      (_match, rest: string) => jsStringLiteral(`${name} ${rest}`),
    );
}

function renderPartnerFaviconLinks(logoUrl: string): string {
  return `<link rel="icon" href="${escapeHtmlAttribute(logoUrl)}" />`;
}

export function applyUiBranding(html: string, env: NodeJS.ProcessEnv = process.env): string {
  const branding = getWorktreeUiBranding(env);
  const partner = getPartnerBranding(env);
  // A worktree preview keeps its own coloured favicon so it is never mistaken
  // for the instance it was copied from.
  const faviconLinks = !branding.enabled && partner?.logoUrl
    ? renderPartnerFaviconLinks(partner.logoUrl)
    : renderFaviconLinks(branding);
  const withFavicon = replaceMarkedBlock(html, FAVICON_BLOCK_START, FAVICON_BLOCK_END, faviconLinks);
  const runtimeBlock = [renderRuntimeBrandingMeta(branding), renderPartnerBrandingHead(partner)]
    .filter(Boolean)
    .join("\n");
  const withRuntime = replaceMarkedBlock(
    withFavicon,
    RUNTIME_BRANDING_BLOCK_START,
    RUNTIME_BRANDING_BLOCK_END,
    runtimeBlock,
  );
  const withTouchIcon = partner?.logoUrl
    ? withRuntime.replace(
      '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />',
      `<link rel="apple-touch-icon" href="${escapeHtmlAttribute(partner.logoUrl)}" />`,
    )
    : withRuntime;
  return applyPartnerProductName(withTouchIcon, partner?.name ?? null);
}

const DEFAULT_MANIFEST_ICONS = [
  { src: "/android-chrome-192x192.png", sizes: "192x192", type: "image/png" },
  { src: "/android-chrome-512x512.png", sizes: "512x512", type: "image/png" },
  { src: "/android-chrome-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
];

/**
 * The web app manifest (the name and icon a phone uses when the app is added
 * to the home screen) for a partner-branded instance. Null when the partner
 * set neither a name nor a logo, so the static `ui/public/site.webmanifest`
 * is served unchanged.
 */
export function renderPartnerWebManifest(partner: PartnerBranding | null): string | null {
  if (!partner || (!partner.name && !partner.logoUrl)) return null;
  const name = partner.name ?? DEFAULT_PRODUCT_NAME;
  return JSON.stringify({
    id: "/",
    name,
    short_name: partner.name ?? "GS Agents",
    description: "Run teams of AI agents: goals, tasks, budgets and approvals in one place.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    theme_color: "#121212",
    background_color: "#121212",
    icons: partner.logoUrl ? [{ src: partner.logoUrl, sizes: "any" }] : DEFAULT_MANIFEST_ICONS,
  }, null, 2);
}
