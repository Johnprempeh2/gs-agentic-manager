import { createHmac, timingSafeEqual } from "node:crypto";

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

/**
 * The live design frame is sandboxed without `allow-same-origin`, so its image requests carry
 * no sign-in cookie. Each `/media/` link in the frame instead carries `sig=<expiry>.<hmac>` over
 * company, site and file name; the media route checks that in place of the session.
 */
export const WEBSITE_MEDIA_LINK_TTL_SECONDS = 60 * 60;

function mediaLinkMac(secret: string, companyId: string, siteId: string, file: string, expiresAt: number) {
  const key = createHmac("sha256", secret).update(`website-media:${companyId}`).digest();
  return createHmac("sha256", key).update(`${siteId}:${file}:${expiresAt}`).digest("base64url");
}

export function signWebsiteMediaLink(secret: string, input: { companyId: string; siteId: string; file: string }, nowMs = Date.now()) {
  const expiresAt = Math.floor(nowMs / 1000) + WEBSITE_MEDIA_LINK_TTL_SECONDS;
  return `${expiresAt}.${mediaLinkMac(secret, input.companyId, input.siteId, input.file, expiresAt)}`;
}

/** True only for an unexpired signature made for exactly this company, site and file. */
export function verifyWebsiteMediaLink(secret: string, input: { companyId: string; siteId: string; file: string }, sig: string, nowMs = Date.now()) {
  const match = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(sig);
  if (!match) return false;
  const expiresAt = Number(match[1]);
  if (expiresAt <= Math.floor(nowMs / 1000)) return false;
  const expected = Buffer.from(mediaLinkMac(secret, input.companyId, input.siteId, input.file, expiresAt));
  const given = Buffer.from(match[2]!);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
