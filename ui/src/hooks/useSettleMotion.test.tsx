// @vitest-environment jsdom

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettleMotion } from "./useSettleMotion";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function List({ filter }: { filter: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useSettleMotion(ref, filter);
  return <div ref={ref} data-testid="list" />;
}

describe("useSettleMotion", () => {
  let container: HTMLDivElement;
  let root: Root;
  const animate = vi.fn((_frames: unknown, _options: unknown) => ({ cancel: vi.fn() }));

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    animate.mockClear();
    HTMLElement.prototype.animate = animate as unknown as typeof HTMLElement.prototype.animate;
    document.documentElement.style.setProperty("--motion-list-settle", "160ms");
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("stays still on first render and settles when the key changes", () => {
    act(() => root.render(<List filter="all" />));
    expect(animate).not.toHaveBeenCalled();
    act(() => root.render(<List filter="active" />));
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.calls[0]?.[1]).toMatchObject({ duration: 160 });
    act(() => root.render(<List filter="active" />));
    expect(animate).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the duration token is zero (reduced motion)", () => {
    document.documentElement.style.setProperty("--motion-list-settle", "0ms");
    act(() => root.render(<List filter="all" />));
    act(() => root.render(<List filter="active" />));
    expect(animate).not.toHaveBeenCalled();
  });
});
