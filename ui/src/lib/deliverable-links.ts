/**
 * The in-app path for a link that opens one deliverable
 * (`/deliverables?open=<id>`, with or without the company prefix or this
 * origin), else null. Such links route inside the app so the page they were
 * opened from stays in history and Quick Look can return to it (GRE-611).
 */
export function inAppDeliverablePath(
  href: string | null | undefined,
  origin: string = typeof window === "undefined" ? "http://localhost" : window.location.origin,
): string | null {
  if (!href) return null;
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  if (!/^(?:\/[^/]+)?\/deliverables\/?$/.test(url.pathname)) return null;
  if (!url.searchParams.get("open")) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}
