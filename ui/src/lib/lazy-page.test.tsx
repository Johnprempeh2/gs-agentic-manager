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
});
