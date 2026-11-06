/**
 * A media entry's file name on the site: `media/<sha256>.<ext>`. A release copies the asset
 * there, and the live design frame serves the same name from GSAM before release (GRE-4265).
 */
const MEDIA_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "application/pdf": "pdf",
};

export function websiteMediaExt(asset: { contentType: string; originalFilename: string | null }) {
  const fromName = asset.originalFilename?.match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toLowerCase();
  return MEDIA_EXT[asset.contentType] ?? fromName ?? "bin";
}

/** `<sha256>.<ext>` as the site names it, or null for anything else (no paths, no other names). */
export function parseWebsiteMediaFileName(name: string) {
  const match = /^([a-f0-9]{64})\.([a-z0-9]{1,8})$/.exec(name);
  return match ? { sha256: match[1]!, ext: match[2]! } : null;
}
