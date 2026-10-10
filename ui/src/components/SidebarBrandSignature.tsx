import { cn } from "../lib/utils";
import { getPartnerBranding } from "../lib/partner-branding";
import { BrandLockup, PoweredByGreatstone, ProductMark } from "./BrandLockup";

/**
 * The product signature at the foot of the primary sidebar: the stone and the
 * product name, quiet, settling below the last nav group. The header row stays
 * with the organization name (the orientation anchor). In the collapsed rail
 * only the stone shows. A partner-branded instance shows its own logo and name
 * with the fixed "Powered by Greatstone" line below.
 */
export function SidebarBrandSignature({ rail = false }: { rail?: boolean }) {
  const partner = getPartnerBranding() !== null;
  return (
    <div
      className={cn(
        "mt-auto flex shrink-0 px-2 pt-6 pb-1",
        partner && !rail ? "flex-col items-start gap-1" : "items-center",
      )}
      data-slot="sidebar-brand-signature"
    >
      {rail ? (
        <ProductMark className="h-4 w-auto" />
      ) : (
        <>
          <BrandLockup className="h-4 text-xs text-subtle-foreground" />
          <PoweredByGreatstone className="text-[11px]" />
        </>
      )}
    </div>
  );
}
