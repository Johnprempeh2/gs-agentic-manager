// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { Kbd } from "./kbd";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("renders one keycap as a kbd and keeps a caller's classes", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<Kbd className="ml-auto">Esc</Kbd>));
  const key = container.querySelector("kbd");
  expect(key?.textContent).toBe("Esc");
  expect(key?.className).toContain("ml-auto");
  expect(key?.className).toContain("tabular-nums");
  act(() => root.unmount());
});
