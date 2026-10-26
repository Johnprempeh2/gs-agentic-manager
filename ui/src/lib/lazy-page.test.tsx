// @vitest-environment jsdom
import { act, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { lazyPage } from "./lazy-page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("lazyPage", () => {
  it("loads the named export only when the page is shown", async () => {
    const load = vi.fn(async () => ({ Calendar: () => <p>CALENDAR</p>, other: 1 }));
    const Calendar = lazyPage(load, "Calendar");
    expect(load).not.toHaveBeenCalled();

    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(<Suspense fallback={<p>LOADING</p>}><Calendar /></Suspense>);
    });
    await vi.waitFor(() => expect(container.textContent).toBe("CALENDAR"));
    expect(load).toHaveBeenCalledOnce();
    act(() => root.unmount());
  });

  // A suspend shows the fallback, and React then holds the page for 300 ms
  // (GRE-2761). A page that a preload already fetched must not suspend.
  it("renders an already-loaded page in the first commit, without the fallback", () => {
    const module = { Calendar: () => <p>CALENDAR</p> };
    const load = vi.fn(async () => module);
    const Calendar = lazyPage(load, "Calendar", () => module);

    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => {
      root.render(<Suspense fallback={<p>LOADING</p>}><Calendar /></Suspense>);
    });
    expect(container.textContent).toBe("CALENDAR");
    expect(load).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("loads the page when the preload has not finished yet", async () => {
    const load = vi.fn(async () => ({ Calendar: () => <p>CALENDAR</p> }));
    const Calendar = lazyPage(load, "Calendar", () => undefined);

    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(<Suspense fallback={<p>LOADING</p>}><Calendar /></Suspense>);
    });
    await vi.waitFor(() => expect(container.textContent).toBe("CALENDAR"));
    expect(load).toHaveBeenCalledOnce();
    act(() => root.unmount());
  });
});
