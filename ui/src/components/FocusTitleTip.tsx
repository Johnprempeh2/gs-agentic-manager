import { useEffect, useState } from "react";

const CONTROL = "button, a[href], [role=button], [role=tab], [role=menuitem]";

/** True when the control shows no readable text of its own (an icon button). */
export function isIconOnly(el: Element): boolean {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim()) continue;
    const rect = node.parentElement?.getBoundingClientRect();
    // A visually hidden (sr-only) label measures 1px: it is not on screen.
    if (rect && rect.width > 1 && rect.height > 1) return false;
  }
  return true;
}

function focusVisible(el: Element): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return false; // an engine without :focus-visible (old test DOMs)
  }
}

/**
 * Shows an icon-only control's `title` as a visible tip while it has keyboard
 * focus. The browser shows `title` on hover but never on focus, so without
 * this a keyboard user tabbing through icon buttons sees no names at all.
 * Mounted once in the app shell; hover keeps the browser's own tip.
 */
export function FocusTitleTip() {
  const [tip, setTip] = useState<{ text: string; top: number; left: number; above: boolean } | null>(null);

  useEffect(() => {
    const show = (event: FocusEvent) => {
      const el = event.target instanceof Element ? event.target.closest(CONTROL) : null;
      const text = el?.getAttribute("title")?.trim();
      if (!el || !text || !focusVisible(el) || !isIconOnly(el)) {
        setTip(null);
        return;
      }
      const r = el.getBoundingClientRect();
      const above = r.bottom + 40 > window.innerHeight;
      setTip({ text, left: r.left + r.width / 2, top: above ? r.top - 6 : r.bottom + 6, above });
    };
    const hide = () => setTip(null);
    document.addEventListener("focusin", show);
    document.addEventListener("focusout", hide);
    window.addEventListener("scroll", hide, true);
    document.addEventListener("pointerdown", hide);
    return () => {
      document.removeEventListener("focusin", show);
      document.removeEventListener("focusout", hide);
      window.removeEventListener("scroll", hide, true);
      document.removeEventListener("pointerdown", hide);
    };
  }, []);

  if (!tip) return null;
  return (
    <div
      aria-hidden="true"
      data-testid="focus-title-tip"
      className="pointer-events-none fixed z-popover w-max max-w-xs -translate-x-1/2 rounded-md bg-foreground px-3 py-1.5 text-xs text-background shadow-md data-[above=true]:-translate-y-full"
      data-above={tip.above}
      style={{ top: tip.top, left: `clamp(8rem, ${tip.left}px, calc(100vw - 8rem))` }}
    >
      {tip.text}
    </div>
  );
}
