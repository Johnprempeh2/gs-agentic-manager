// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MarkupShape } from "../../lib/website-markup";
import { WebsiteMarkupLayer } from "./WebsiteMarkupLayer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The drawing shows at half the screenshot's size: 720 x 450 CSS px for a 1440 x 900 PNG.
const SIZE = { width: 1440, height: 900 };

let root: Root;
let container: HTMLDivElement;
let latest: MarkupShape[] = [];
const onDone = vi.fn();

function Harness() {
  const [shapes, setShapes] = useState<MarkupShape[]>([]);
  latest = shapes;
  return <WebsiteMarkupLayer screenshotUrl="data:image/png;base64,AAAA" size={SIZE} displayWidth={720} shapes={shapes} onChange={setShapes} onDone={onDone} />;
}

beforeEach(async () => {
  latest = [];
  onDone.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
  canvas().getBoundingClientRect = () => ({ left: 100, top: 50, width: 720, height: 450, right: 820, bottom: 500, x: 100, y: 50, toJSON: () => ({}) });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const canvas = () => container.querySelector<SVGSVGElement>('[data-testid="website-markup-canvas"]')!;
const tool = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const click = async (el: HTMLElement) => act(async () => el.click());

async function pointer(type: string, x: number, y: number) {
  await act(async () => {
    canvas().dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y, pointerId: 1 }));
  });
}

async function drag(from: [number, number], to: [number, number]) {
  await pointer("pointerdown", ...from);
  await pointer("pointermove", (from[0] + to[0]) / 2, (from[1] + to[1]) / 2);
  await pointer("pointermove", ...to);
  await pointer("pointerup", ...to);
}

describe("WebsiteMarkupLayer (GRE-2518)", () => {
  it("has every tool, three colours, undo, clear and Done, and starts on the red pen", () => {
    for (const label of ["Pen", "Arrow", "Box", "Highlight", "Text label", "Numbered marker", "Red", "Lime", "Teal", "Undo", "Clear"]) {
      expect(tool(label), label).not.toBeNull();
    }
    expect(tool("Pen").getAttribute("aria-pressed")).toBe("true");
    expect(tool("Red").getAttribute("aria-pressed")).toBe("true");
    expect(tool("Undo").disabled).toBe(true);
    expect(canvas().classList.contains("touch-none")).toBe(true);
  });

  it("the pen draws in the screenshot's pixels, not the screen's", async () => {
    await drag([110, 60], [460, 275]);
    expect(latest).toHaveLength(1);
    const pen = latest[0]!;
    expect(pen.kind).toBe("pen");
    if (pen.kind !== "pen") return;
    expect(pen.color).toBe("red");
    expect(pen.points[0]).toEqual([20, 20]);
    expect(pen.points.at(-1)).toEqual([720, 450]);
    expect(canvas().querySelectorAll('[data-mark="pen"]')).toHaveLength(1);
  });

  it("a tap with the pen draws nothing", async () => {
    await drag([110, 60], [110, 60]);
    expect(latest).toHaveLength(0);
  });

  it("arrow, box and highlight in the chosen colour", async () => {
    await click(tool("Teal"));
    await click(tool("Arrow"));
    await drag([100, 50], [460, 275]);
    await click(tool("Box"));
    await drag([460, 275], [100, 50]);
    await click(tool("Highlight"));
    await drag([100, 100], [400, 100]);
    expect(latest.map((shape) => [shape.kind, shape.color])).toEqual([
      ["arrow", "teal"],
      ["box", "teal"],
      ["highlight", "teal"],
    ]);
    expect(latest[1]).toMatchObject({ x: 0, y: 0, w: 720, h: 450 });
  });

  it("numbered markers count up; undo takes the last one back and its number is used again", async () => {
    await click(tool("Numbered marker"));
    await pointer("pointerdown", 200, 100);
    await pointer("pointerdown", 300, 100);
    expect(latest.map((shape) => (shape.kind === "marker" ? shape.n : null))).toEqual([1, 2]);
    expect(canvas().textContent).toBe("12");
    await click(tool("Undo"));
    await pointer("pointerdown", 400, 100);
    expect(latest.map((shape) => (shape.kind === "marker" ? shape.n : null))).toEqual([1, 2]);
  });

  it("a text label: click, type, Enter keeps it; Esc drops it and does not reach the editor", async () => {
    await click(tool("Text label"));
    await pointer("pointerdown", 190, 95);
    const input = () => container.querySelector<HTMLInputElement>('input[aria-label="Label text"]');
    expect(input()).not.toBeNull();
    const setValue = async (value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
        input()!.dispatchEvent(new Event("input", { bubbles: true }));
      });
    await setValue("  Too big  ");
    await act(async () => input()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(latest).toEqual([{ kind: "text", color: "red", x: 180, y: 90, text: "Too big" }]);
    expect(input()).toBeNull();

    await pointer("pointerdown", 300, 200);
    await setValue("Never mind");
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    const reachedWindow = vi.fn();
    window.addEventListener("keydown", reachedWindow);
    await act(async () => input()!.dispatchEvent(escape));
    window.removeEventListener("keydown", reachedWindow);
    expect(escape.defaultPrevented).toBe(true);
    expect(reachedWindow).not.toHaveBeenCalled();
    expect(latest).toHaveLength(1);
    expect(input()).toBeNull();
  });

  it("Clear removes the whole drawing; Done hides the layer", async () => {
    await drag([110, 60], [460, 275]);
    await drag([110, 260], [460, 75]);
    expect(latest).toHaveLength(2);
    await click(tool("Clear"));
    expect(latest).toHaveLength(0);
    await click([...container.querySelectorAll("button")].find((el) => el.textContent?.trim() === "Done")!);
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
