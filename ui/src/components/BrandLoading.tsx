import type { CSSProperties, SVGProps } from "react";
import { cn } from "../lib/utils";
import { BRAND_STONE_SLABS, BRAND_STONE_VIEWBOX } from "./BrandMark";

/**
 * The stone building itself: each slab's outline draws in turn, bottom slab
 * first, holds as a finished stone, then clears and starts again. Timing lives
 * in index.css (`brand-build-*`); reduced motion shows the finished stone.
 */
export function BrandBuildingIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox={BRAND_STONE_VIEWBOX}
      className={cn("brand-mark brand-build-icon", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {BRAND_STONE_SLABS.map((points, index) => (
        <polygon
          key={points}
          points={points}
          pathLength={1}
          vectorEffect="non-scaling-stroke"
          className="brand-build-slab"
          style={{ "--brand-build-index": index } as CSSProperties}
        />
      ))}
    </svg>
  );
}

/**
 * Compact "working" glyph for inline status rows: the solid stone with its
 * slabs lighting in sequence. Sized like an icon (`h-3.5 w-3.5`).
 */
export function BrandThinkingIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox={BRAND_STONE_VIEWBOX}
      className={cn("brand-mark brand-thinking-icon", className)}
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      {BRAND_STONE_SLABS.map((points, index) => (
        <polygon
          key={points}
          points={points}
          className="brand-thinking-slab"
          style={{ "--brand-build-index": index } as CSSProperties}
        />
      ))}
    </svg>
  );
}

/** Full-page loading state: a large, centred stone building itself. */
export function BrandLoading({ className }: { className?: string }) {
  return (
    <div
      role="status"
      className={cn("flex min-h-dvh w-full items-center justify-center", className)}
    >
      <BrandBuildingIcon className="h-24 w-auto" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}
