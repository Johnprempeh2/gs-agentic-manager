import {
  BLANK_CHECK_SAMPLE_SIZE,
  BLANK_SCREENSHOT_RETAKE_HINT,
  isScreenshotLikeFilename,
  looksBlankScreenshot,
} from "@greatstone/shared";

const CHECKABLE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const CHECK_SOURCE_LIMIT_BYTES = 25 * 1024 * 1024;

/**
 * The blank-shot check for an upload (GRE-2524). Returns the retake hint when
 * an image named like a screenshot is more than 90% one flat colour, else null.
 * An image that cannot be read is not flagged: the check never blocks an upload.
 */
export async function blankScreenshotWarning(input: {
  contentType: string;
  originalFilename: string | null;
  body: Buffer;
}): Promise<string | null> {
  if (!isScreenshotLikeFilename(input.originalFilename)) return null;
  if (!CHECKABLE_TYPES.has(input.contentType.toLowerCase().split(";")[0]!.trim())) return null;
  if (input.body.length > CHECK_SOURCE_LIMIT_BYTES) return null;
  try {
    const { default: sharp } = await import("sharp");
    const pixels = await sharp(input.body, { limitInputPixels: 100_000_000 })
      .ensureAlpha()
      .resize(BLANK_CHECK_SAMPLE_SIZE, BLANK_CHECK_SAMPLE_SIZE, { fit: "fill" })
      .raw()
      .toBuffer();
    return looksBlankScreenshot(pixels) ? BLANK_SCREENSHOT_RETAKE_HINT : null;
  } catch {
    return null;
  }
}
