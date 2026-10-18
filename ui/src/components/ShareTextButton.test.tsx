// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShareTextButton } from "./ShareTextButton";

let container: HTMLDivElement;
let root: Root;
const nav = navigator as unknown as { share?: (data: ShareData) => Promise<void> };

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete nav.share;
});

async function click() {
  await act(async () => {
    container.querySelector("button")!.click();
  });
}

describe("ShareTextButton", () => {
  it("is hidden where the device has no share sheet", () => {
    act(() => root.render(<ShareTextButton title="Today" getText={() => "x"} />));
    expect(container.querySelector("button")).toBeNull();
  });

  it("hands the text to the share sheet", async () => {
    nav.share = vi.fn(async () => {});
    act(() => root.render(<ShareTextButton title="Today, 18 Oct" getText={() => "Needs me: nothing"} />));
    await click();
    expect(nav.share).toHaveBeenCalledWith({ title: "Today, 18 Oct", text: "Needs me: nothing" });
    expect(container.textContent).toBe("Share");
  });

  it("treats closing the share sheet as no error, and says so when sharing fails", async () => {
    nav.share = vi.fn(async () => { throw Object.assign(new Error("closed"), { name: "AbortError" }); });
    act(() => root.render(<ShareTextButton title="Today" getText={() => "x"} />));
    await click();
    expect(container.textContent).toBe("Share");

    nav.share = vi.fn(async () => { throw Object.assign(new Error("denied"), { name: "NotAllowedError" }); });
    await click();
    expect(container.textContent).toBe("Could not share");
  });
});
