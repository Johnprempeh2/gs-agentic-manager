/**
 * iOS pans the page, not the layout, when the keyboard opens: sticky and
 * fixed bars stay where the full-height page put them. Two consequences on a
 * phone: the sticky header (and its Dynamic Island padding) slides off the top
 * while typing, and after the keyboard closes iOS can leave the page panned,
 * so the tab bar and composer sit mid-screen until the next scroll.
 *
 * This keeps `--vv-offset-top` in step with the visible area so the header can
 * follow it, and nudges the page by a pixel once the keyboard has gone if iOS
 * left it panned, which makes it lay the page out again.
 */
const SETTLE_DELAY_MS = 300;

function isEditable(element: Element | null): boolean {
  if (!element) return false;
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return true;
  return element instanceof HTMLElement && element.isContentEditable;
}

export function startVisualViewportSync(win: Window = window): () => void {
  const viewport = win.visualViewport;
  if (!viewport) return () => {};
  const root = win.document.documentElement;
  let frame = 0;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;

  const publishOffset = () => {
    win.cancelAnimationFrame(frame);
    frame = win.requestAnimationFrame(() => {
      const offset = Number.isFinite(viewport.offsetTop) ? Math.max(0, viewport.offsetTop) : 0;
      root.style.setProperty("--vv-offset-top", `${offset}px`);
    });
  };

  const settleAfterKeyboard = () => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      if (isEditable(win.document.activeElement)) return; // still typing
      if (viewport.offsetTop < 1) return; // iOS put the page back itself
      win.scrollTo(win.scrollX, win.scrollY + 1);
      win.scrollTo(win.scrollX, win.scrollY - 1);
      publishOffset();
    }, SETTLE_DELAY_MS);
  };

  viewport.addEventListener("resize", publishOffset);
  viewport.addEventListener("scroll", publishOffset);
  viewport.addEventListener("resize", settleAfterKeyboard);
  win.document.addEventListener("focusout", settleAfterKeyboard);
  publishOffset();

  return () => {
    viewport.removeEventListener("resize", publishOffset);
    viewport.removeEventListener("scroll", publishOffset);
    viewport.removeEventListener("resize", settleAfterKeyboard);
    win.document.removeEventListener("focusout", settleAfterKeyboard);
    win.cancelAnimationFrame(frame);
    clearTimeout(settleTimer);
    root.style.removeProperty("--vv-offset-top");
  };
}
