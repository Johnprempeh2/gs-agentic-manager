import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import {
  BLANK_CHECK_SAMPLE_SIZE,
  BLANK_SCREENSHOT_MESSAGE,
  isScreenshotLikeFilename,
  looksBlankScreenshot,
} from "@greatstone/shared";
import { cn } from "@/lib/utils";

/**
 * Runs the shared blank-shot check on a loaded image. Returns null when the
 * pixels cannot be read (no canvas, or a cross-origin image).
 */
export function imageLooksBlank(image: HTMLImageElement): boolean | null {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = BLANK_CHECK_SAMPLE_SIZE;
    canvas.height = BLANK_CHECK_SAMPLE_SIZE;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, 0, 0, BLANK_CHECK_SAMPLE_SIZE, BLANK_CHECK_SAMPLE_SIZE);
    const { data } = context.getImageData(0, 0, BLANK_CHECK_SAMPLE_SIZE, BLANK_CHECK_SAMPLE_SIZE);
    return looksBlankScreenshot(data);
  } catch {
    return null;
  }
}

/**
 * An image attachment in a card. The whole image shows, anchored to the top,
 * so a tall screenshot never crops to its empty middle (GRE-2524). An image
 * named like a screenshot that is mostly one flat colour gets a warning.
 */
export function AttachmentThumbnail({
  src,
  alt,
  filename,
  className,
}: {
  src: string;
  alt: string;
  filename: string | null | undefined;
  className?: string;
}) {
  const [blank, setBlank] = useState(false);
  const checkBlank = isScreenshotLikeFilename(filename);

  return (
    <>
      <img
        src={src}
        alt={alt}
        loading="lazy"
        className={cn("h-full w-full object-contain object-top", className)}
        onLoad={checkBlank ? (event) => setBlank(imageLooksBlank(event.currentTarget) === true) : undefined}
      />
      {blank ? (
        <span
          className="@container absolute inset-x-0 bottom-0 bg-status-warning-soft px-1.5 py-1 text-(length:--text-micro) font-medium text-status-warning-foreground"
          data-testid="attachment-blank-warning"
          title={`${BLANK_SCREENSHOT_MESSAGE}. Ask the agent to retake it.`}
        >
          {/* Small tiles (chat on a phone) fit only the short label. */}
          <span className="flex items-center gap-1">
            <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span className="sr-only">{BLANK_SCREENSHOT_MESSAGE}</span>
            <span aria-hidden="true" className="truncate @[10rem]:hidden">Blank</span>
            <span aria-hidden="true" className="hidden truncate @[10rem]:inline">{BLANK_SCREENSHOT_MESSAGE}</span>
          </span>
        </span>
      ) : null}
    </>
  );
}
