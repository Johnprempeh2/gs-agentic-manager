import { useEffect, useRef, type RefObject } from "react";

/** How the new page arrives: a section switch rises in; on a phone, moving
 *  deeper slides in from the right and going back slides in from the left. */
export type RouteEnterVariant = "rise" | "forward" | "back";

export interface MobileRouteMotion {
  pathname: string;
  /** React Router's navigation type for the move that produced `pathname`. */
  navigationType: "POP" | "PUSH" | "REPLACE";
}

/**
 * Ease the page in when the operator moves to another section. It animates
 * the page root that is already mounted (no remount, so no lost state), keys
 * on the section rather than the full path so opening a task inside Tasks
 * does not replay it, and reads timing from the CSS motion tokens so the
 * values stay in the token layer. Reduced motion skips it entirely.
 *
 * With `mobile`, every page change plays, like a native app: a move inside a
 * section slides sideways (forward for a new page, back for history), and a
 * section switch keeps the rise.
 */
export function useRouteEnterMotion(
  containerRef: RefObject<HTMLElement | null>,
  sectionKey: string,
  mobile?: MobileRouteMotion | null,
) {
  const previousSection = useRef<string | null>(null);
  const motionKey = mobile ? mobile.pathname : sectionKey;
  const variantRef = useRef<RouteEnterVariant>("rise");
  variantRef.current = routeEnterVariant(previousSection.current, sectionKey, mobile ?? null);

  useEffect(() => {
    const variant = variantRef.current;
    previousSection.current = sectionKey;
    const page = containerRef.current?.firstElementChild;
    if (!(page instanceof HTMLElement) || typeof page.animate !== "function") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    const tokens = getComputedStyle(document.documentElement);
    const duration = Number.parseFloat(tokens.getPropertyValue("--motion-route-enter"));
    if (!Number.isFinite(duration) || duration <= 0) return;
    const travel = tokens.getPropertyValue("--motion-route-travel").trim() || "0px";
    const travelX = tokens.getPropertyValue("--motion-route-travel-x").trim() || "0px";
    const easing = tokens.getPropertyValue("--motion-ease-emphasized").trim() || "ease-out";

    const from =
      variant === "forward"
        ? `translateX(${travelX})`
        : variant === "back"
          ? `translateX(calc(-1 * ${travelX}))`
          : `translateY(${travel})`;
    const animation = page.animate(
      [
        { opacity: 0, transform: from },
        { opacity: 1, transform: "none" },
      ],
      { duration, easing },
    );
    return () => animation.cancel();
    // sectionKey is read through the ref-computed variant; the motion key
    // decides when to play.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef, motionKey]);
}

/** Pure choice of entrance, exported for tests. */
export function routeEnterVariant(
  previousSection: string | null,
  section: string,
  mobile: MobileRouteMotion | null,
): RouteEnterVariant {
  if (!mobile || previousSection === null || previousSection !== section) return "rise";
  return mobile.navigationType === "POP" ? "back" : "forward";
}

/** `/GRE/issues/GRE-12` and `/GRE/issues` share the section `/GRE/issues`. */
export function routeSectionKey(pathname: string): string {
  return pathname.split("/").slice(0, 3).join("/");
}
