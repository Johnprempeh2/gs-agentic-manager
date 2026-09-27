import { useEffect, type RefObject } from "react";

/**
 * Ease the page in when the operator moves to another section. It animates
 * the page root that is already mounted (no remount, so no lost state), keys
 * on the section rather than the full path so opening a task inside Tasks
 * does not replay it, and reads timing from the CSS motion tokens so the
 * values stay in the token layer. Reduced motion skips it entirely.
 */
export function useRouteEnterMotion(
  containerRef: RefObject<HTMLElement | null>,
  sectionKey: string,
) {
  useEffect(() => {
    const page = containerRef.current?.firstElementChild;
    if (!(page instanceof HTMLElement) || typeof page.animate !== "function") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    const tokens = getComputedStyle(document.documentElement);
    const duration = Number.parseFloat(tokens.getPropertyValue("--motion-route-enter"));
    if (!Number.isFinite(duration) || duration <= 0) return;
    const travel = tokens.getPropertyValue("--motion-route-travel").trim() || "0px";
    const easing = tokens.getPropertyValue("--motion-ease-emphasized").trim() || "ease-out";

    const animation = page.animate(
      [
        { opacity: 0, transform: `translateY(${travel})` },
        { opacity: 1, transform: "none" },
      ],
      { duration, easing },
    );
    return () => animation.cancel();
  }, [containerRef, sectionKey]);
}

/** `/GRE/issues/GRE-12` and `/GRE/issues` share the section `/GRE/issues`. */
export function routeSectionKey(pathname: string): string {
  return pathname.split("/").slice(0, 3).join("/");
}
