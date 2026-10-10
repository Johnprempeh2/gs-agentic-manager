import { cn } from "../lib/utils";
import { DEFAULT_PRODUCT_NAME, getPartnerBranding, getProductName } from "../lib/partner-branding";
import { BrandMark } from "./BrandMark";

export const BRAND_PRODUCT_NAME = DEFAULT_PRODUCT_NAME;

interface BrandLockupProps {
  className?: string;
  decorative?: boolean;
}

/**
 * The product's mark at the lockup's height: the partner logo on a
 * partner-branded instance, nothing when the partner set a name but no logo
 * (our stone must not sit beside their name), the Greatstone stone otherwise.
 */
export function ProductMark({ className }: { className?: string }) {
  const partner = getPartnerBranding();
  if (partner?.logoUrl) {
    return <img src={partner.logoUrl} alt="" aria-hidden="true" className={cn("object-contain", className)} />;
  }
  if (partner?.name) return null;
  return <BrandMark decorative className={className} />;
}

/**
 * Product lockup: the stone beside the product name set in Montserrat, or the
 * partner's logo and name on a partner-branded instance. The mark takes the
 * lockup's full height, so size the whole thing with a height class (`h-5`)
 * and the name scales with the surrounding text size.
 */
export function BrandLockup({ className, decorative = false }: BrandLockupProps) {
  const productName = getProductName();
  return (
    <span
      className={cn("inline-flex items-center gap-2 leading-none", className)}
      role={decorative ? undefined : "img"}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : productName}
    >
      <ProductMark className="h-full w-auto shrink-0" />
      <span aria-hidden="true" className="font-semibold tracking-tight whitespace-nowrap">
        {productName}
      </span>
    </span>
  );
}

/**
 * The fixed "Powered by Greatstone" line on a partner-branded instance. There
 * is deliberately no setting to hide it. Renders nothing on our own brand.
 */
export function PoweredByGreatstone({ className }: { className?: string }) {
  if (!getPartnerBranding()) return null;
  return (
    <span className={cn("text-xs text-subtle-foreground", className)} data-slot="powered-by-greatstone">
      Powered by Greatstone
    </span>
  );
}
