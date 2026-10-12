/**
 * Phone back navigation, shared by the header back arrow and the left-edge
 * swipe. The Home Screen app has no browser back button, so every inner page
 * needs a way out even when it was opened from a link or a notification.
 */

type Crumb = { label: string; href?: string; identifier?: string };

/** The parent to fall back to, or null on a top-level page (which keeps the menu). */
export function mobileBackFallback(crumbs: ReadonlyArray<Crumb>): string | null {
  if (crumbs.length >= 2) return crumbs[crumbs.length - 2]?.href ?? "/dashboard";
  if (crumbs[0]?.label === "Tasks" && crumbs[0]?.identifier) return "/issues";
  return null;
}

/** Go back through in-app history when there is some (the list keeps its
 *  place), else replace this page with its parent. */
type BackNavigate = {
  (delta: number): unknown;
  (to: string, options?: { replace?: boolean }): unknown;
};

export function goBackOr(
  navigate: BackNavigate,
  fallbackHref: string,
  historyState: unknown = typeof window === "undefined" ? null : window.history.state,
) {
  const historyIndex = (historyState as { idx?: number } | null)?.idx ?? 0;
  if (historyIndex > 0) navigate(-1);
  else navigate(fallbackHref, { replace: true });
}
