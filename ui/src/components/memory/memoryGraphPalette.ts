import type { MemoryRecordStatus } from "@greatstone/shared";

/**
 * WebGL cannot read CSS variables, so the 3D graph resolves the design tokens in
 * `index.css` to plain rgb() at runtime (and again when the theme flips). No colour
 * values live here: only the token names, so the graph follows the theme.
 */

/** Same meaning as the list badges and the old 2D graph. */
export const STATUS_TOKEN: Record<MemoryRecordStatus, string> = {
  unreviewed: "--status-pending",
  approved: "--status-success",
  disputed: "--status-alert",
  superseded: "--muted-foreground",
  deleted: "--muted-foreground",
};

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface MemoryGraphPalette {
  dark: boolean;
  background: Rgb;
  foreground: Rgb;
  muted: Rgb;
  hub: Rgb;
  status: Record<MemoryRecordStatus, Rgb>;
  fontFamily: string;
}

const FALLBACK: Rgb = { r: 128, g: 128, b: 128 };

/** Any CSS colour (hex, oklch, color-mix...) to rgb, via a 1x1 canvas the browser paints. */
function toRgb(css: string, ctx: CanvasRenderingContext2D | null): Rgb {
  if (!ctx || !css) return FALLBACK;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = "transparent";
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return { r, g, b };
}

export function readMemoryGraphPalette(element: Element = document.documentElement): MemoryGraphPalette {
  const style = getComputedStyle(element);
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const token = (name: string) => toRgb(style.getPropertyValue(name).trim(), ctx);
  const status = Object.fromEntries(
    Object.entries(STATUS_TOKEN).map(([key, name]) => [key, token(name)]),
  ) as Record<MemoryRecordStatus, Rgb>;
  return {
    dark: document.documentElement.classList.contains("dark"),
    background: token("--background"),
    foreground: token("--foreground"),
    muted: token("--muted-foreground"),
    hub: token("--primary"),
    status,
    fontFamily: getComputedStyle(document.body).fontFamily || style.getPropertyValue("--font-sans"),
  };
}

export function rgba({ r, g, b }: Rgb, alpha = 1): string {
  return alpha >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
