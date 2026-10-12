// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startVisualViewportSync } from "./ios-keyboard";

class FakeViewport extends EventTarget {
  offsetTop = 0;
  height = 800;
}

describe("startVisualViewportSync", () => {
  let viewport: FakeViewport;
  let stop: () => void;
  const scrollTo = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    viewport = new FakeViewport();
    Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => { cb(0); return 1; });
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
    scrollTo.mockClear();
    stop = startVisualViewportSync(window);
  });

  afterEach(() => {
    stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps --vv-offset-top in step with how far iOS panned the page", () => {
    viewport.offsetTop = 240;
    viewport.dispatchEvent(new Event("scroll"));
    expect(document.documentElement.style.getPropertyValue("--vv-offset-top")).toBe("240px");
  });

  it("publishes how much of the page's bottom edge the keyboard hides", () => {
    Object.defineProperty(window, "innerHeight", { value: 714, configurable: true });
    viewport.height = 384;
    viewport.offsetTop = 319; // iOS stopped 11 px short of the bottom
    viewport.dispatchEvent(new Event("resize"));
    expect(document.documentElement.style.getPropertyValue("--vv-bottom-inset")).toBe("11px");

    viewport.offsetTop = 330; // panned all the way: nothing hidden
    viewport.dispatchEvent(new Event("scroll"));
    expect(document.documentElement.style.getPropertyValue("--vv-bottom-inset")).toBe("0px");
  });

  it("nudges the page once the keyboard has closed but iOS left it panned", () => {
    viewport.offsetTop = 180;
    document.dispatchEvent(new FocusEvent("focusout"));
    vi.advanceTimersByTime(300);
    expect(scrollTo).toHaveBeenCalledTimes(2);
  });

  it("leaves the page alone while typing or once iOS has settled it", () => {
    const input = document.createElement("textarea");
    document.body.appendChild(input);
    input.focus();
    viewport.offsetTop = 180;
    document.dispatchEvent(new FocusEvent("focusout"));
    vi.advanceTimersByTime(300);
    expect(scrollTo).not.toHaveBeenCalled();

    input.blur();
    input.remove();
    viewport.offsetTop = 0;
    viewport.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(300);
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
