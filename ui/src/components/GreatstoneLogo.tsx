import type { CSSProperties } from "react";
import { cn } from "../lib/utils";
import { getPartnerBranding } from "../lib/partner-branding";
import { BrandLockup, ProductMark } from "./BrandLockup";
import stoneSrc from "../assets/brand/gs-stone-3d.png";
import wordmarkSrc from "../assets/brand/greatstone-wordmark.png";

/** The 3D stone render (113 x 160), for the logo and the Everest orb. */
export const GREATSTONE_STONE_3D_SRC = stoneSrc;

/**
 * The Greatstone logo from the master brand assets, never redrawn:
 * `full` is the 3D stone beside the wordmark, `stone` the 3D stone alone.
 * Both keep their true aspect (`flex-none`, fixed height, auto width), so a
 * flex row can never stretch them. A partner-branded instance shows the
 * partner's lockup or mark instead.
 */
export function GreatstoneLogo({ variant = "full", className }: { variant?: "full" | "stone"; className?: string }) {
  if (getPartnerBranding()) {
    return variant === "stone"
      ? <ProductMark className={cn("h-7 w-auto flex-none", className)} />
      : <BrandLockup className={cn("h-5 w-auto flex-none text-sidebar-foreground", className)} />;
  }
  const stone = (
    <img
      src={stoneSrc}
      width={113}
      height={160}
      alt={variant === "stone" ? "Greatstone" : ""}
      aria-hidden={variant === "stone" ? undefined : true}
      className="h-8 w-auto flex-none object-contain"
      data-slot="greatstone-stone"
    />
  );
  if (variant === "stone") return <span className={cn("inline-flex flex-none", className)}>{stone}</span>;
  return (
    <span className={cn("inline-flex flex-none items-center gap-2", className)} role="img" aria-label="Greatstone">
      {stone}
      <span
        aria-hidden="true"
        className="gs-wordmark"
        data-slot="greatstone-wordmark"
        style={{ "--gs-wordmark-src": `url("${wordmarkSrc}")` } as CSSProperties}
      />
    </span>
  );
}
