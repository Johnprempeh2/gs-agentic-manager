/**
 * Blank-shot check (GRE-2524). A screenshot used as proof must show content.
 * An image named like a screenshot ("screenshot", "before", "after") that is
 * mostly one flat colour is flagged so the agent retakes it.
 *
 * The server (sharp) and the UI (canvas) both decode the image to a small RGBA
 * grid of BLANK_CHECK_SAMPLE_SIZE x BLANK_CHECK_SAMPLE_SIZE and call
 * `looksBlankScreenshot`, so both sides give the same answer.
 */

export const BLANK_CHECK_SAMPLE_SIZE = 64;

/** More than this share of one flat colour counts as blank. */
export const BLANK_SCREENSHOT_THRESHOLD = 0.9;

export const BLANK_SCREENSHOT_MESSAGE = "This screenshot looks blank";

export const BLANK_SCREENSHOT_RETAKE_HINT =
  "This screenshot looks blank: more than 90% of it is one flat colour. "
  + "Retake it showing the feature working on real content (a connected editor, a page with content). "
  + "If you cannot reach a real signed-in view, say so plainly in the comment (\"UI not seen live; fixture only\").";

export function isScreenshotLikeFilename(filename: string | null | undefined): boolean {
  if (!filename) return false;
  return /screenshot|before|after/i.test(filename);
}

/**
 * Share (0..1) of pixels in the most common colour. Colours are bucketed to
 * 5 bits per channel so compression noise does not split a flat area.
 * Pixels that are almost fully transparent count as one colour.
 */
export function dominantColourShare(rgba: ArrayLike<number>): number {
  const pixelCount = Math.floor(rgba.length / 4);
  if (pixelCount === 0) return 0;
  const counts = new Map<number, number>();
  let top = 0;
  for (let i = 0; i < pixelCount; i += 1) {
    const o = i * 4;
    const key = rgba[o + 3]! < 16
      ? -1
      : ((rgba[o]! >> 3) << 10) | ((rgba[o + 1]! >> 3) << 5) | (rgba[o + 2]! >> 3);
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    if (next > top) top = next;
  }
  return top / pixelCount;
}

export function looksBlankScreenshot(rgba: ArrayLike<number>): boolean {
  return dominantColourShare(rgba) > BLANK_SCREENSHOT_THRESHOLD;
}
