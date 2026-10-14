import { intelligenceDomain } from "@greatstone/shared";
import { guardedRemoteHttpFetch } from "./remote-http-fetch.js";

// Brand logos and article images for the Intelligence page. The browser never
// loads a remote host (GRE-405, and the tailnet CSP is img-src 'self'): it asks
// our server, which fetches through the private-network guard, caps size and
// time, keeps the bytes in a small memory cache and serves them same-origin.

export const LOGODEV_KEY_ENV = "GSAM_LOGODEV_PUBLISHABLE_KEY";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
// og:image sits in <head>; the first 512 KB of a page is plenty.
const MAX_HTML_BYTES = 512 * 1024;
const MAX_REDIRECTS = 4;
const REQUEST_TIMEOUT_MS = 10_000;
const HIT_TTL_MS = 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 60 * 60 * 1000;
// ponytail: memory cache, lost on restart and bounded by bytes; move to the
// asset store if refetching after a restart ever matters.
const CACHE_BUDGET_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 2_000;

export type Media = { contentType: string; body: Buffer };
export type MediaFetch = (url: URL, accept: string, signal: AbortSignal) => Promise<Response>;

const guardError = (message: string, code: string) => Object.assign(new Error(message), { code });

export const guardedMediaFetch: MediaFetch = (url, accept, signal) =>
  guardedRemoteHttpFetch(
    url,
    { method: "GET", headers: { accept, "user-agent": "Mozilla/5.0 (compatible; GS Agentic Manager intelligence preview)" }, signal },
    { error: guardError, connectTimeoutMs: 5_000, responseTimeoutMs: 8_000 },
  );

const decodeEntities = (value: string) =>
  value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x2f;|&#0*47;/gi, "/");

/**
 * The page's preview image: og:image (or its :secure_url / :url forms), else
 * twitter:image, resolved against the page URL. Only http(s) results count.
 */
export function extractOgImage(html: string, pageUrl: string): string | null {
  const found = new Map<string, string>();
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = new Map<string, string>();
    for (const match of tag.matchAll(/([a-z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
      attrs.set(match[1]!.toLowerCase(), match[2] ?? match[3] ?? match[4] ?? "");
    }
    const key = (attrs.get("property") ?? attrs.get("name") ?? "").toLowerCase();
    const content = attrs.get("content")?.trim();
    if (key && content && !found.has(key)) found.set(key, decodeEntities(content));
  }
  for (const key of ["og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src"]) {
    const value = found.get(key);
    if (!value) continue;
    try {
      const url = new URL(value, pageUrl);
      if (url.protocol === "https:" || url.protocol === "http:") return url.toString();
    } catch {
      // Try the next tag.
    }
  }
  return null;
}

/** Logo.dev image URL for a domain. `fallback=404` so a miss is our monogram, not theirs. */
export function logoDevUrl(domain: string, key: string): string {
  const params = new URLSearchParams({ token: key, size: "128", retina: "true", format: "png", fallback: "404" });
  return `https://img.logo.dev/${encodeURIComponent(domain)}?${params}`;
}

async function readCapped(response: Response, max: number, truncate: boolean): Promise<Buffer | null> {
  const declared = Number(response.headers.get("content-length"));
  if (!truncate && declared > max) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      if (!truncate) return null;
      chunks.push(value.subarray(0, value.byteLength - (size - max)));
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

type Fetched = { url: URL; contentType: string; body: Buffer };

/** GET with redirects, each hop back through the guard. Null on any failure or a non-2xx answer. */
async function fetchFollowing(fetchImpl: MediaFetch, start: string, accept: string): Promise<Fetched | null> {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  try {
    let url = new URL(start);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (url.protocol !== "https:" && url.protocol !== "http:") return null;
      const response = await fetchImpl(url, accept, signal);
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel().catch(() => undefined);
        url = new URL(location, url);
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      const contentType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      const isImage = IMAGE_TYPES.has(contentType);
      const isHtml = contentType === "text/html" || contentType === "application/xhtml+xml";
      if (!isImage && !isHtml) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      const body = await readCapped(response, isImage ? MAX_IMAGE_BYTES : MAX_HTML_BYTES, !isImage);
      return body ? { url, contentType, body } : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** Memory cache keyed by request, with expiry and a byte budget. In-flight fetches are shared. */
function mediaCache(now: () => number) {
  const entries = new Map<string, { expires: number; value: Promise<Media | null>; size: number }>();
  let total = 0;
  return (key: string, load: () => Promise<Media | null>): Promise<Media | null> => {
    const hit = entries.get(key);
    if (hit && hit.expires > now()) return hit.value;
    if (hit) {
      total -= hit.size;
      entries.delete(key);
    }
    const entry = { expires: now() + MISS_TTL_MS, value: load().catch(() => null), size: 0 };
    entries.set(key, entry);
    void entry.value.then((media) => {
      if (entries.get(key) !== entry) return;
      entry.size = media?.body.byteLength ?? 0;
      entry.expires = now() + (media ? HIT_TTL_MS : MISS_TTL_MS);
      total += entry.size;
      for (const [oldKey, old] of entries) {
        if (total <= CACHE_BUDGET_BYTES && entries.size <= MAX_ENTRIES) break;
        total -= old.size;
        entries.delete(oldKey);
      }
    });
    return entry.value;
  };
}

export function intelligenceMediaService(options: {
  fetchImpl?: MediaFetch;
  logoKey?: () => string | undefined;
  now?: () => number;
} = {}) {
  const fetchImpl = options.fetchImpl ?? guardedMediaFetch;
  const logoKey = options.logoKey ?? (() => process.env[LOGODEV_KEY_ENV]?.trim() || undefined);
  const cached = mediaCache(options.now ?? Date.now);

  return {
    /** The brand logo for a bare domain, or null with no key set, a bad domain or no match. */
    logo(domain: string): Promise<Media | null> {
      const key = logoKey();
      const clean = intelligenceDomain({ domain });
      if (!key || !clean) return Promise.resolve(null);
      return cached(`logo:${clean}`, async () => {
        const fetched = await fetchFollowing(fetchImpl, logoDevUrl(clean, key), "image/png,image/*");
        return fetched && IMAGE_TYPES.has(fetched.contentType) ? { contentType: fetched.contentType, body: fetched.body } : null;
      });
    },

    /** An image URL as is, or a page URL's og:image / twitter:image. Null when there is none to show. */
    image(url: string): Promise<Media | null> {
      return cached(`image:${url}`, async () => {
        const first = await fetchFollowing(fetchImpl, url, "text/html,image/*;q=0.9");
        if (!first) return null;
        if (IMAGE_TYPES.has(first.contentType)) return { contentType: first.contentType, body: first.body };
        const imageUrl = extractOgImage(first.body.toString("utf8"), first.url.toString());
        if (!imageUrl) return null;
        const image = await fetchFollowing(fetchImpl, imageUrl, "image/*");
        return image && IMAGE_TYPES.has(image.contentType) ? { contentType: image.contentType, body: image.body } : null;
      });
    },
  };
}
