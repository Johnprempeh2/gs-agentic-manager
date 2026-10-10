import {
  BRAND_LOGO_URL_ENV_KEY,
  BRAND_NAME_ENV_KEY,
  BRAND_PRIMARY_COLOR_ENV_KEY,
  parsePartnerBranding,
  type PartnerBranding,
} from "@greatstone/shared";
import { logger } from "../middleware/logger.js";

type BrandingEnv = Record<string, string | undefined>;

let cache: { key: string; branding: PartnerBranding | null } | null = null;

/**
 * Instance-level partner branding from `GSAM_BRAND_NAME`,
 * `GSAM_BRAND_LOGO_URL` and `GSAM_BRAND_PRIMARY_COLOR`. Parsed once per raw
 * value set; each rejected value (a bad URL, a colour that fails contrast) is
 * warned about once and the default theme stays in its place.
 */
export function getPartnerBranding(env: BrandingEnv = process.env): PartnerBranding | null {
  const key = JSON.stringify([env[BRAND_NAME_ENV_KEY], env[BRAND_LOGO_URL_ENV_KEY], env[BRAND_PRIMARY_COLOR_ENV_KEY]]);
  if (cache && cache.key === key) return cache.branding;
  const { branding, warnings } = parsePartnerBranding(env);
  for (const warning of warnings) logger.warn(warning);
  cache = { key, branding };
  return branding;
}
