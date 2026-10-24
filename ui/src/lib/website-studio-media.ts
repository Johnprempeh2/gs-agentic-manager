import type { CreateWebsiteEntry, GeneratedImage, GeneratedVideo } from "@greatstone/shared";

// GS Studio images and Animate clips as website media (GRE-2114, plan 2.12).
// A studio item is already a company asset, so a website media entry only
// points at its `assetId`: nothing is downloaded or uploaded again.

/** Where a picked item comes from (GRE-2107 copy, section 7). */
export type StudioMediaSource = "studio" | "animation";

export const STUDIO_MEDIA_SOURCE_LABEL: Record<StudioMediaSource, string> = {
  studio: "GS Studio",
  animation: "Animation studio",
};

export interface StudioMediaItem {
  source: StudioMediaSource;
  id: string;
  assetId: string;
  contentPath: string;
  /** The prompt, to tell items apart. Never used as alt text. */
  label: string;
}

export interface FocalPoint {
  x: number;
  y: number;
}

export const CENTRE_FOCAL_POINT: FocalPoint = { x: 0.5, y: 0.5 };

/** Finished studio images only: a pending or failed one has no asset yet. */
export function studioImageItems(images: GeneratedImage[]): StudioMediaItem[] {
  return images.flatMap((image) =>
    image.status === "completed" && image.assetId && image.contentPath
      ? [{ source: "studio" as const, id: image.id, assetId: image.assetId, contentPath: image.contentPath, label: image.prompt }]
      : [],
  );
}

/** Finished Animate clips only. */
export function studioClipItems(videos: GeneratedVideo[]): StudioMediaItem[] {
  return videos.flatMap((video) =>
    video.status === "completed" && video.assetId && video.contentPath
      ? [{ source: "animation" as const, id: video.id, assetId: video.assetId, contentPath: video.contentPath, label: video.prompt }]
      : [],
  );
}

/** "Use" needs alt text: an image on the site is never left without one. */
export function hasAltText(alt: string) {
  return alt.trim().length > 0;
}

/** The new `media` entry for a studio item: `{ assetId, alt, caption, focalPoint }`. */
export function studioMediaEntry(
  item: StudioMediaItem,
  fields: { alt: string; caption: string; focalPoint: FocalPoint },
  now: Date = new Date(),
): CreateWebsiteEntry {
  const kind = item.source === "animation" ? "clip" : "image";
  return {
    collection: "media",
    // The studio id keeps the key readable; the time lets one item be used twice.
    entryKey: `studio-${kind}-${item.id.slice(0, 8)}-${now.getTime().toString(36)}`,
    content: {
      assetId: item.assetId,
      alt: fields.alt.trim(),
      caption: fields.caption.trim() || null,
      focalPoint: fields.focalPoint,
    },
  };
}

/** A click on the preview as a focus point, each side 0 to 1, two decimals. */
export function focalPointFromClick(rect: { left: number; top: number; width: number; height: number }, clientX: number, clientY: number): FocalPoint {
  const clamp = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
  return {
    x: rect.width > 0 ? clamp((clientX - rect.left) / rect.width) : 0.5,
    y: rect.height > 0 ? clamp((clientY - rect.top) / rect.height) : 0.5,
  };
}
