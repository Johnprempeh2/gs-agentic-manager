// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FocusTitleTip, isIconOnly } from "./FocusTitleTip";

let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container.remove();
  vi.restoreAllMocks();
});

/** jsdom lays nothing out: give text a size unless its parent is sr-only. */
function stubLayout() {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const hidden = this.classList.contains("sr-only");
    return { width: hidden ? 1 : 40, height: hidden ? 1 : 16, top: 0, left: 0, right: 40, bottom: 16, x: 0, y: 0, toJSON() {} } as DOMRect;
  });
}

describe("FocusTitleTip", () => {
  it("treats an icon or a visually hidden label as icon only, and visible words as labelled", () => {
    stubLayout();
    container.innerHTML = `<button id="a"><svg></svg></button><button id="b"><svg></svg><span class="sr-only">Sort</span></button><button id="c"><span>Sort</span></button>`;
    expect(isIconOnly(container.querySelector("#a")!)).toBe(true);
    expect(isIconOnly(container.querySelector("#b")!)).toBe(true);
    expect(isIconOnly(container.querySelector("#c")!)).toBe(false);
  });

  it("shows the title of a keyboard-focused icon button and hides it on blur", () => {
    stubLayout();
    vi.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, selector: string) {
      return selector === ":focus-visible" ? true : Element.prototype.closest.call(this, selector) === this;
    });
    act(() => {
      root = createRoot(container);
      root.render(<FocusTitleTip />);
    });
    const button = document.createElement("button");
    button.title = "Sort";
    button.innerHTML = "<svg></svg>";
    container.appendChild(button);
    act(() => button.focus());
    expect(document.querySelector("[data-testid=focus-title-tip]")?.textContent).toBe("Sort");
    act(() => button.blur());
    expect(document.querySelector("[data-testid=focus-title-tip]")).toBeNull();
  });
});
