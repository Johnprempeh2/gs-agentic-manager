import { lazy, type ComponentType } from "react";

const RELOADED_KEY = "gsam.lazy-page.reloaded-at";

function reloadOnceForStaleBundle(error: unknown): never {
  // After a deploy, an open tab can ask for a page file that no longer exists.
  // One reload fetches the new app; a second failure is a real error.
  try {
    const last = Number(window.sessionStorage.getItem(RELOADED_KEY));
    if (!last || Date.now() - last > 60_000) {
      window.sessionStorage.setItem(RELOADED_KEY, String(Date.now()));
      window.location.reload();
    }
  } catch {
    // Storage blocked: fall through to the error boundary.
  }
  throw error;
}

/**
 * A page loaded only when its route is opened, so the first screen on a phone
 * downloads less. `name` picks the export, since pages use named exports.
 */
export function lazyPage<M, K extends keyof M>(load: () => Promise<M>, name: K) {
  return lazy(async () => {
    const module = await load().catch(reloadOnceForStaleBundle);
    return { default: module[name] as unknown as ComponentType<any> };
  }) as unknown as M[K];
}
