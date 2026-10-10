/**
 * Partner branding: an instance-level rebrand set by the hosting operator so a
 * reseller can run the app under its own product name, logo and main colour.
 * It comes from three env vars and rides `/api/health` (like
 * `GSAM_HIDDEN_SETTINGS`). With all three unset the app looks exactly as it
 * does today. The "Powered by Greatstone" line is fixed and has no env switch.
 */
export const BRAND_NAME_ENV_KEY = "GSAM_BRAND_NAME";
export const BRAND_LOGO_URL_ENV_KEY = "GSAM_BRAND_LOGO_URL";
export const BRAND_PRIMARY_COLOR_ENV_KEY = "GSAM_BRAND_PRIMARY_COLOR";

export const PARTNER_BRAND_NAME_MAX_LENGTH = 60;

/** Page backgrounds of the default theme (`--background` in ui/src/index.css). */
export const THEME_BACKGROUNDS = { light: "#f7f8f4", dark: "#121212" } as const;
/** The two text colours a primary button may use (`--primary-foreground`). */
const PRIMARY_FOREGROUNDS = { light: "#f5f7f2", dark: "#0e1611" } as const;

/** Button text on the primary colour (WCAG AA, normal text). */
export const MIN_PRIMARY_TEXT_CONTRAST = 4.5;
/** The primary colour against the page (WCAG AA, UI components). */
export const MIN_PRIMARY_PAGE_CONTRAST = 3;

export type PartnerThemeMode = "light" | "dark";

export interface PartnerBrandColor {
  primary: string;
  primaryForeground: string;
}

export interface PartnerBranding {
  /** Product name shown instead of "GS Agentic Manager"; null keeps ours. */
  name: string | null;
  /** Logo image (https, http or a same-origin path); null keeps our mark. */
  logoUrl: string | null;
  /**
   * The partner colour per theme. A theme whose contrast check failed is null
   * and keeps the default theme colour.
   */
  colors: Record<PartnerThemeMode, PartnerBrandColor | null>;
}

export interface PartnerBrandingParseResult {
  /** Null when no branding env var is set (or none is usable). */
  branding: PartnerBranding | null;
  /** Operator-facing reasons a value was ignored, for a startup warning. */
  warnings: string[];
}

type BrandingEnv = Record<string, string | undefined>;

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeHexColor(value: string | undefined): string | null {
  const raw = nonEmpty(value);
  if (!raw) return null;
  const hex = raw.startsWith("#") ? raw.slice(1) : raw;
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return `#${hex.split("").map((char) => `${char}${char}`).join("").toLowerCase()}`;
  }
  if (/^[0-9a-fA-F]{6}$/.test(hex)) return `#${hex.toLowerCase()}`;
  return null;
}

function channelLuminance(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

/** WCAG contrast ratio between two `#rrggbb` colours. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function formatRatio(ratio: number): string {
  return `${Math.floor(ratio * 10) / 10}:1`;
}

/**
 * Check the partner colour for one theme: readable button text on it, and the
 * colour itself visible against that theme's page. Returns the colour with its
 * button text colour, or the reason it fails.
 */
export function checkPartnerColor(
  primary: string,
  mode: PartnerThemeMode,
): { color: PartnerBrandColor } | { reason: string } {
  const foreground = [PRIMARY_FOREGROUNDS.light, PRIMARY_FOREGROUNDS.dark]
    .map((candidate) => ({ candidate, ratio: contrastRatio(primary, candidate) }))
    .sort((a, b) => b.ratio - a.ratio)[0]!;
  if (foreground.ratio < MIN_PRIMARY_TEXT_CONTRAST) {
    return {
      reason: `button text on it is ${formatRatio(foreground.ratio)}, needs ${MIN_PRIMARY_TEXT_CONTRAST}:1`,
    };
  }
  const page = contrastRatio(primary, THEME_BACKGROUNDS[mode]);
  if (page < MIN_PRIMARY_PAGE_CONTRAST) {
    return {
      reason: `it is ${formatRatio(page)} against the ${mode} page, needs ${MIN_PRIMARY_PAGE_CONTRAST}:1`,
    };
  }
  return { color: { primary, primaryForeground: foreground.candidate } };
}

/**
 * Accept absolute http(s) URLs and same-origin paths only. Anything else
 * (`javascript:`, `data:`, protocol-relative `//host`) is refused.
 */
function parseLogoUrl(raw: string): string | null {
  if (raw.startsWith("/")) return raw.startsWith("//") ? null : raw;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function parsePartnerBranding(env: BrandingEnv): PartnerBrandingParseResult {
  const warnings: string[] = [];

  let name = nonEmpty(env[BRAND_NAME_ENV_KEY]);
  if (name && name.length > PARTNER_BRAND_NAME_MAX_LENGTH) {
    warnings.push(
      `${BRAND_NAME_ENV_KEY} is longer than ${PARTNER_BRAND_NAME_MAX_LENGTH} characters; it is ignored`,
    );
    name = null;
  }

  const rawLogo = nonEmpty(env[BRAND_LOGO_URL_ENV_KEY]);
  const logoUrl = rawLogo ? parseLogoUrl(rawLogo) : null;
  if (rawLogo && !logoUrl) {
    warnings.push(`${BRAND_LOGO_URL_ENV_KEY} must be an http(s) URL or a path starting with "/"; it is ignored`);
  }

  const colors: PartnerBranding["colors"] = { light: null, dark: null };
  const rawColor = nonEmpty(env[BRAND_PRIMARY_COLOR_ENV_KEY]);
  if (rawColor) {
    const primary = normalizeHexColor(rawColor);
    if (!primary) {
      warnings.push(`${BRAND_PRIMARY_COLOR_ENV_KEY} must be a hex colour like #1d4ed8; it is ignored`);
    } else {
      for (const mode of ["light", "dark"] as const) {
        const checked = checkPartnerColor(primary, mode);
        if ("color" in checked) {
          colors[mode] = checked.color;
        } else {
          warnings.push(
            `${BRAND_PRIMARY_COLOR_ENV_KEY} ${primary} fails the contrast check in ${mode} mode (${checked.reason}); ${mode} mode keeps the default theme colour`,
          );
        }
      }
    }
  }

  if (!name && !logoUrl && !colors.light && !colors.dark) return { branding: null, warnings };
  return { branding: { name, logoUrl, colors }, warnings };
}
