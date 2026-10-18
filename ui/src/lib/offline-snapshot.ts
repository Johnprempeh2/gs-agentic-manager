import { dehydrate, hydrate, type DehydratedState, type QueryClient } from "@tanstack/react-query";

/**
 * The last Inbox, Needed from you, client list and Today, saved on this
 * device so GSAM opens with them when there is no signal (John, 2026-10-16:
 * "Save on phone"). Each page keeps what was on screen the last time it
 * loaded, including what the app needs to start (who is signed in, the
 * organisations). Cleared on sign out and when the session ends elsewhere.
 */
const PREFIX = "gsam.offline-snapshot.v1:";
/** Older than this is more misleading than useful. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Per page; well inside the usual 5 MB browser allowance for all four. */
const MAX_CHARS = 1_000_000;

export type SnapshotPage = "inbox" | "needed" | "clients" | "today";

const PAGES: Array<[RegExp, SnapshotPage]> = [
  [/^\/[^/]+\/inbox\/(?:mine|recent|unread|blocked|all)\/?$/, "inbox"],
  [/^\/[^/]+\/needed\/?$/, "needed"],
  [/^\/[^/]+\/organisations\/?$/, "clients"],
  [/^\/[^/]+\/(?:today|morning)\/?$/, "today"],
];

/** The saved page a route belongs to, or null for every other page. */
export function snapshotPageFor(pathname: string): SnapshotPage | null {
  for (const [pattern, page] of PAGES) if (pattern.test(pathname)) return page;
  return null;
}

interface Snapshot {
  savedAt: number;
  state: DehydratedState;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Save what is on screen now: every loaded query something is showing. */
export function saveSnapshot(queryClient: QueryClient, page: SnapshotPage, now = Date.now()): boolean {
  const store = storage();
  if (!store) return false;
  try {
    const state = dehydrate(queryClient, {
      shouldDehydrateQuery: (query) =>
        query.state.status === "success" && query.state.data !== undefined && query.getObserversCount() > 0,
      shouldDehydrateMutation: () => false,
    });
    if (state.queries.length === 0) return false;
    const json = JSON.stringify({ savedAt: now, state } satisfies Snapshot);
    if (json.length > MAX_CHARS) return false;
    store.setItem(PREFIX + page, json);
    return true;
  } catch {
    // Full storage or data that will not serialise: keep the last good copy.
    return false;
  }
}

function savedKeys(store: Storage): string[] {
  const keys: string[] = [];
  for (let i = 0; i < store.length; i += 1) {
    const key = store.key(i);
    if (key?.startsWith(PREFIX)) keys.push(key);
  }
  return keys;
}

/**
 * Put the saved pages back before the app first renders. Each query keeps the
 * time it was really loaded, so it refreshes as soon as the network allows and
 * the offline notice can say how old it is.
 */
export function restoreSnapshots(queryClient: QueryClient, now = Date.now()): number {
  const store = storage();
  if (!store) return 0;
  let restored = 0;
  for (const key of savedKeys(store)) {
    try {
      const saved = JSON.parse(store.getItem(key) ?? "null") as Snapshot | null;
      if (!saved || typeof saved.savedAt !== "number" || now - saved.savedAt > MAX_AGE_MS) {
        store.removeItem(key);
        continue;
      }
      hydrate(queryClient, saved.state);
      restored += 1;
    } catch {
      store.removeItem(key);
    }
  }
  return restored;
}

/** Remove every saved page from this device. */
export function clearSnapshots(): void {
  const store = storage();
  if (!store) return;
  try {
    for (const key of savedKeys(store)) store.removeItem(key);
  } catch {
    /* Storage unavailable: nothing was saved either. */
  }
}
