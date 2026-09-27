import type { SVGProps } from "react";
import { cn } from "../lib/utils";

/**
 * The Greatstone stone: the five stacked slabs that replace the "O" in the
 * GREATSTONE wordmark. Geometry is the traced outline of the master logo
 * (greatstone-homepage/assets/slab-polygons.json), translated to the origin.
 * Never redraw it by hand. Order is bottom slab first so animations that
 * stagger by index read as stones being laid, foundation upward.
 */
export const BRAND_STONE_SLABS = [
  "209,295 223,298 253,333 252,337 225,374 217,392 204,398 201,388 144,420 132,419 86,399 73,406 22,355 112,300",
  "262,216 265,216 265,223 259,317 223,277 123,281 26,338 0,249",
  "30,149 218,208 10,235 13,174 24,153",
  "98,69 116,71 155,114 264,116 284,179 202,189 40,137 36,127 42,116 85,77",
  "179,0 189,0 246,28 265,92 154,91 143,84 106,41 121,26",
] as const;

/** Content bounds are 284 x 420; the pad keeps outline strokes inside the box. */
export const BRAND_STONE_VIEWBOX = "-8 -8 300 436";

interface BrandMarkProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  /**
   * `solid` fills each slab and stays legible down to favicon size.
   * `outline` matches the master logo and is for 32px and up.
   */
  variant?: "solid" | "outline";
  decorative?: boolean;
  title?: string;
}

/** Icon-shaped adapter (className + aria-hidden), e.g. for EmptyState. */
export function BrandStoneIcon(props: Omit<SVGProps<SVGSVGElement>, "children">) {
  return <BrandMark decorative {...props} />;
}

/**
 * Colour comes from `currentColor`; the `brand-mark` class maps it to the
 * `--brand-mark` token (lime on the void, emerald on paper). Size it with a
 * height class (`h-6 w-auto`); width follows the aspect.
 */
export function BrandMark({
  variant = "solid",
  decorative = false,
  title = "Greatstone",
  className,
  ...rest
}: BrandMarkProps) {
  const outline = variant === "outline";
  return (
    <svg
      {...rest}
      className={cn("brand-mark", className)}
      viewBox={BRAND_STONE_VIEWBOX}
      fill={outline ? "none" : "currentColor"}
      stroke={outline ? "currentColor" : "none"}
      strokeWidth={outline ? 1.75 : undefined}
      strokeLinejoin="round"
      role={decorative ? undefined : "img"}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : title}
      focusable="false"
    >
      {BRAND_STONE_SLABS.map((points) => (
        <polygon key={points} points={points} vectorEffect={outline ? "non-scaling-stroke" : undefined} />
      ))}
    </svg>
  );
}
