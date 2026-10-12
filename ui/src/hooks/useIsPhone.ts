import { useSyncExternalStore } from "react";

/** Tailwind's `sm` breakpoint: below it the layout is a phone layout. */
const PHONE_QUERY = "(width < 40rem)";

function subscribe(onChange: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const media = window.matchMedia(PHONE_QUERY);
  media.addEventListener?.("change", onChange);
  return () => media.removeEventListener?.("change", onChange);
}

function snapshot() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(PHONE_QUERY).matches;
}

/**
 * True on a phone-width screen. For components that change structure (not
 * just styling) on a phone and may render outside the app shell, so they
 * cannot rely on SidebarContext. Without matchMedia (tests, server) it is
 * false: the desktop structure.
 */
export function useIsPhone(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
