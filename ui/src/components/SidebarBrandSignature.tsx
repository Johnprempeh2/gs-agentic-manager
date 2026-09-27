import { BrandLockup } from "./BrandLockup";
import { BrandMark } from "./BrandMark";

/**
 * The product signature at the foot of the primary sidebar: the stone and the
 * product name, quiet, settling below the last nav group. The header row stays
 * with the organization name (the orientation anchor). In the collapsed rail
 * only the stone shows.
 */
export function SidebarBrandSignature({ rail = false }: { rail?: boolean }) {
  return (
    <div className="mt-auto flex shrink-0 items-center px-2 pt-6 pb-1" data-slot="sidebar-brand-signature">
      {rail ? (
        <BrandMark decorative className="h-4 w-auto" />
      ) : (
        <BrandLockup className="h-4 text-xs text-subtle-foreground" />
      )}
    </div>
  );
}
