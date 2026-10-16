/**
 * Saved searches and pinned views for the search box. Kept in this
 * browser per company and person, like recent searches.
 */

export type SavedSearchItem =
  | { id: string; kind: "search"; label: string; query: string }
  | { id: string; kind: "view"; label: string; path: string };

/** A saved item before it has an id. */
export type NewSavedSearchItem =
  | { kind: "search"; label: string; query: string }
  | { kind: "view"; label: string; path: string };

const STORAGE_PREFIX = "gsam:saved-searches:";
export const MAX_SAVED_ITEMS = 10;

function storageKey(companyId: string, userId: string | null) {
  return `${STORAGE_PREFIX}${companyId}:${userId ?? "me"}`;
}

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function isItem(value: unknown): value is SavedSearchItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || typeof item.label !== "string") return false;
  if (item.kind === "search") return typeof item.query === "string" && item.query.trim().length > 0;
  if (item.kind === "view") return typeof item.path === "string" && item.path.startsWith("/");
  return false;
}

export function loadSavedSearches(companyId: string, userId: string | null): SavedSearchItem[] {
  const store = storage();
  if (!store || !companyId) return [];
  try {
    const parsed = JSON.parse(store.getItem(storageKey(companyId, userId)) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isItem).slice(0, MAX_SAVED_ITEMS) : [];
  } catch {
    return [];
  }
}

function write(companyId: string, userId: string | null, items: SavedSearchItem[]) {
  const store = storage();
  if (!store || !companyId) return;
  try {
    store.setItem(storageKey(companyId, userId), JSON.stringify(items.slice(0, MAX_SAVED_ITEMS)));
  } catch {
    // Storage full or blocked: saving is a convenience, so carry on.
  }
}

function sameTarget(a: SavedSearchItem, b: SavedSearchItem) {
  if (a.kind === "search" && b.kind === "search") return a.query.trim().toLowerCase() === b.query.trim().toLowerCase();
  if (a.kind === "view" && b.kind === "view") return a.path === b.path;
  return false;
}

export function isSaved(items: readonly SavedSearchItem[], candidate: NewSavedSearchItem): boolean {
  return items.some((item) => sameTarget(item, { ...candidate, id: "" } as SavedSearchItem));
}

/** Adds the item at the top, replacing any copy of the same search or page. */
export function saveSearchItem(
  companyId: string,
  userId: string | null,
  item: NewSavedSearchItem,
): SavedSearchItem[] {
  const entry = { ...item, id: `${item.kind}-${Date.now().toString(36)}` } as SavedSearchItem;
  const rest = loadSavedSearches(companyId, userId).filter((existing) => !sameTarget(existing, entry));
  const next = [entry, ...rest].slice(0, MAX_SAVED_ITEMS);
  write(companyId, userId, next);
  return next;
}

export function removeSavedSearch(companyId: string, userId: string | null, id: string): SavedSearchItem[] {
  const next = loadSavedSearches(companyId, userId).filter((item) => item.id !== id);
  write(companyId, userId, next);
  return next;
}

/** "Tasks / Indago" from breadcrumbs, else a tidy version of the path. */
export function viewLabel(breadcrumbs: readonly { label: string }[], path: string): string {
  const fromCrumbs = breadcrumbs.map((crumb) => crumb.label.trim()).filter(Boolean).join(" / ");
  if (fromCrumbs) return fromCrumbs;
  const first = path.split("?")[0]!.split("/").filter(Boolean)[0] ?? "Home";
  return first.charAt(0).toUpperCase() + first.slice(1).replace(/-/g, " ");
}
