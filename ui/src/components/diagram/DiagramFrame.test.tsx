// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiagramFrame } from "./DiagramFrame";
import { readDiagramPrefs, useDiagramViewport } from "./useDiagramViewport";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let phone = false;
vi.mock("@/hooks/useIsPhone", () => ({ useIsPhone: () => phone }));

const CONTENT = { width: 2000, height: 1000 };
const BOXES = [
  { x: 0, y: 0, width: 200, height: 60 },
  { x: 1800, y: 900, width: 200, height: 60 },
];

function Harness({ onPick }: { onPick?: (id: string) => void }) {
  const viewport = useDiagramViewport({ content: CONTENT, storageKey: "test.view", home: () => ({ x: 0, y: 0, k: 1 }) });
  return (
    <DiagramFrame
      label="Test diagram"
      viewport={viewport}
      content={CONTENT}
      boxes={BOXES}
      find={{ items: [{ id: "a", label: "About us" }, { id: "b", label: "Contact", detail: "/contact" }], onPick: onPick ?? (() => {}) }}
      onCollapseAll={() => {}}
      onExpandAll={() => {}}
    >
      <div ref={viewport.viewportRef} data-testid="viewport" {...viewport.panHandlers} style={{ flex: 1 }}>
        <div data-testid="layer" style={{ transform: `translate(${viewport.view.x}px, ${viewport.view.y}px) scale(${viewport.view.k})` }}>
          <button type="button" data-testid="node">Node</button>
        </div>
      </div>
    </DiagramFrame>
  );
}

let container: HTMLDivElement;
let root: Root;

const button = (label: string) =>
  Array.from(container.querySelectorAll("button")).find((el) => el.textContent?.trim() === label || el.getAttribute("aria-label") === label) as HTMLButtonElement;
const zoom = () => container.querySelector("[data-diagram-zoom]")?.textContent;
const frame = () => container.querySelector("[data-diagram-frame]") as HTMLElement;
const key = async (target: Element, value: string) => {
  await act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true })); });
};

beforeEach(() => {
  phone = false;
  window.localStorage.clear();
  // jsdom lays nothing out: give every element a 1000 x 500 box.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(500);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, "requestFullscreen");
  Reflect.deleteProperty(document, "fullscreenElement");
  Reflect.deleteProperty(document, "exitFullscreen");
});

async function render(onPick?: (id: string) => void) {
  await act(async () => { root.render(<Harness onPick={onPick} />); });
}

describe("DiagramFrame", () => {
  it("zooms with the buttons and the keys, fits the whole diagram and resets", async () => {
    await render();
    expect(zoom()).toBe("100%");
    await act(async () => button("Zoom in").click());
    expect(zoom()).toBe("120%");
    await act(async () => button("Zoom out").click());
    expect(zoom()).toBe("100%");
    const node = container.querySelector('[data-testid="node"]')!;
    await key(node, "+");
    expect(zoom()).toBe("120%");
    await key(node, "-");
    await key(node, "-");
    expect(zoom()).toBe("83%");
    // 0 fits: (500 - 64) / 1000 tall is the tighter side.
    await key(node, "0");
    expect(zoom()).toBe("44%");
    await act(async () => button("Reset").click());
    expect(zoom()).toBe("100%");
    await act(async () => button("Fit to screen").click());
    expect(zoom()).toBe("44%");
  });

  it("zooms with Ctrl or Cmd and the wheel, and pans with a plain wheel", async () => {
    await render();
    const viewport = container.querySelector('[data-testid="viewport"]')!;
    const layer = container.querySelector('[data-testid="layer"]') as HTMLElement;
    await act(async () => { viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: 40, deltaX: 10, bubbles: true, cancelable: true })); });
    expect(zoom()).toBe("100%");
    expect(layer.style.transform).toBe("translate(-10px, -40px) scale(1)");
    await act(async () => { viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -50, ctrlKey: true, bubbles: true, cancelable: true })); });
    expect(zoom()).toBe("165%");
  });

  it("goes full screen through the Fullscreen API and back, with the toolbar inside", async () => {
    const request = vi.fn(async function (this: HTMLElement) {
      Object.defineProperty(document, "fullscreenElement", { configurable: true, value: this });
    });
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", { configurable: true, value: request });
    const exit = vi.fn(async () => {
      Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null });
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    Object.defineProperty(document, "exitFullscreen", { configurable: true, value: exit });
    await render();
    await act(async () => button("Full screen").click());
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.contexts[0]).toBe(frame());
    expect(frame().getAttribute("data-fullscreen")).toBe("native");
    expect(frame().querySelector("[data-diagram-toolbar]")).not.toBeNull();
    await act(async () => button("Exit full screen").click());
    expect(exit).toHaveBeenCalled();
    expect(frame().hasAttribute("data-fullscreen")).toBe(false);
  });

  it("leaves full screen when the browser does (Esc)", async () => {
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
      configurable: true,
      value: async function (this: HTMLElement) {
        Object.defineProperty(document, "fullscreenElement", { configurable: true, value: this });
      },
    });
    await render();
    await act(async () => button("Full screen").click());
    expect(frame().getAttribute("data-fullscreen")).toBe("native");
    await act(async () => {
      Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null });
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    expect(frame().hasAttribute("data-fullscreen")).toBe(false);
  });

  it("uses the overlay when the browser refuses or never answers", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      Object.defineProperty(HTMLElement.prototype, "requestFullscreen", { configurable: true, value: () => new Promise(() => {}) });
      await render();
      await act(async () => button("Full screen").click());
      expect(frame().hasAttribute("data-fullscreen")).toBe(false);
      await act(async () => { vi.advanceTimersByTime(1_000); });
      expect(frame().getAttribute("data-fullscreen")).toBe("overlay");
      await act(async () => button("Exit full screen").click());
      Object.defineProperty(HTMLElement.prototype, "requestFullscreen", { configurable: true, value: () => Promise.reject(new Error("denied")) });
      await act(async () => button("Full screen").click());
      expect(frame().getAttribute("data-fullscreen")).toBe("overlay");
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to a full-viewport overlay on a phone, and Esc closes it", async () => {
    phone = true;
    const request = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", { configurable: true, value: request });
    await render();
    await act(async () => button("Full screen").click());
    expect(request).not.toHaveBeenCalled();
    expect(frame().getAttribute("data-fullscreen")).toBe("overlay");
    expect(frame().className).toContain("fixed");
    await key(container.querySelector('[data-testid="node"]')!, "Escape");
    expect(frame().hasAttribute("data-fullscreen")).toBe(false);
  });

  it("finds a node by name and jumps to it", async () => {
    const onPick = vi.fn();
    await render(onPick);
    const input = container.querySelector("[data-diagram-find]") as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "cont");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const options = Array.from(container.querySelectorAll('[role="option"]')).map((el) => el.textContent);
    expect(options).toEqual(["Contact/contact"]);
    // Keys typed in the box never zoom.
    await key(input, "+");
    expect(zoom()).toBe("100%");
    await key(input, "Enter");
    expect(onPick).toHaveBeenCalledWith("b");
  });

  it("remembers the zoom for the diagram", async () => {
    vi.useFakeTimers();
    try {
      await render();
      await act(async () => button("Zoom in").click());
      await act(async () => { vi.advanceTimersByTime(300); });
      expect(readDiagramPrefs("test.view").view?.k).toBeCloseTo(1.2);
      act(() => root.unmount());
      root = createRoot(container);
      await render();
      expect(zoom()).toBe("120%");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the minimap only when the diagram is bigger than the view", async () => {
    await render();
    expect(container.querySelector("[data-diagram-minimap]")).not.toBeNull();
    await act(async () => button("Fit to screen").click());
    expect(container.querySelector("[data-diagram-minimap]")).toBeNull();
  });
});
