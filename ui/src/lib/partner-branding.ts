import type { PartnerBranding } from "@greatstone/shared";

export const DEFAULT_PRODUCT_NAME = "GS Agentic Manager";
const META_NAME = "gsam-partner-branding";

let cached: { value: PartnerBranding | null } | null = null;

function parse(content: string | null | undefined): PartnerBranding | null {
  if (!content) return null;
  try {
    const value = JSON.parse(content) as PartnerBranding;
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

/**
 * The instance's partner branding (GSAM_BRAND_* env vars), written into the
 * HTML head by the server so it is known on first paint, before any API call
 * and on the sign-in page. Null on an unbranded instance. The same object is
 * on `/api/health` as `branding`.
 */
export function getPartnerBranding(): PartnerBranding | null {
  if (!cached) {
    const meta = typeof document === "undefined"
      ? null
      : document.querySelector(`meta[name="${META_NAME}"]`);
    cached = { value: parse(meta?.getAttribute("content")) };
  }
  return cached.value;
}

/** The product name to show: the partner's when set, ours otherwise. */
export function getProductName(): string {
  return getPartnerBranding()?.name ?? DEFAULT_PRODUCT_NAME;
}

/** Test hook: forget the cached value so the next read sees the current head. */
export function resetPartnerBrandingCache(): void {
  cached = null;
}
