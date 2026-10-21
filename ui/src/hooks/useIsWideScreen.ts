import { useSyncExternalStore } from "react";

/** Wide enough for labelled row buttons beside a full task title (Tailwind `2xl`). */
const WIDE_QUERY = "(width >= 96rem)";

function subscribe(onChange: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const media = window.matchMedia(WIDE_QUERY);
  media.addEventListener?.("change", onChange);
  return () => media.removeEventListener?.("change", onChange);
}

function snapshot() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia(WIDE_QUERY).matches;
}

/**
 * True on a wide desktop screen. Below it, row buttons drop their labels so
 * the task title keeps the room. Without matchMedia (tests, server) it is true.
 */
export function useIsWideScreen(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => true);
}
