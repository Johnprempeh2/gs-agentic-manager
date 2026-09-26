import { cn } from "../lib/utils";
import { BrandMark } from "./BrandMark";

export const BRAND_PRODUCT_NAME = "GS Agentic Manager";

interface BrandLockupProps {
  className?: string;
  decorative?: boolean;
}

/**
 * Product lockup: the solid stone beside the product name set in Montserrat.
 * The stone takes the lockup's full height, so size the whole thing with a
 * height class (`h-5`) and the name scales with the surrounding text size.
 */
export function BrandLockup({ className, decorative = false }: BrandLockupProps) {
  return (
    <span
      className={cn("inline-flex items-center gap-2 leading-none", className)}
      role={decorative ? undefined : "img"}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : BRAND_PRODUCT_NAME}
    >
      <BrandMark decorative className="h-full w-auto shrink-0" />
      <span aria-hidden="true" className="font-semibold tracking-tight whitespace-nowrap">
        {BRAND_PRODUCT_NAME}
      </span>
    </span>
  );
}
