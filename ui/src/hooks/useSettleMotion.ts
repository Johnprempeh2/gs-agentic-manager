import { useEffect, useRef, type RefObject } from "react";

/**
 * Let a list settle in when what it shows changes (a filter, a sort, a
 * grouping, or its first data replacing the skeleton), so the rows do not
 * snap from one set to another. It animates the container that is already
 * mounted (no remount, nothing waits on it, clicks land at once), skips the
 * first render (the page's own entrance covers that) and reads its timing
 * from the CSS motion tokens. Reduced motion zeroes the token and skips it.
 */
export function useSettleMotion(ref: RefObject<HTMLElement | null>, key: string) {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const el = ref.current;
    if (!el || typeof el.animate !== "function") return;
    const tokens = getComputedStyle(document.documentElement);
    const duration = Number.parseFloat(tokens.getPropertyValue("--motion-list-settle"));
    if (!Number.isFinite(duration) || duration <= 0) return;
    const travel = tokens.getPropertyValue("--motion-list-settle-travel").trim() || "0px";
    const easing = tokens.getPropertyValue("--motion-ease-emphasized").trim() || "ease-out";
    const animation = el.animate(
      [
        { opacity: 0, transform: `translateY(${travel})` },
        { opacity: 1, transform: "none" },
      ],
      { duration, easing },
    );
    return () => animation.cancel();
  }, [ref, key]);
}
