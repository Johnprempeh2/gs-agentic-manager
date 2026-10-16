// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

function renderDialog(scrollBody: boolean) {
  flushSync(() =>
    root.render(
      <Dialog open>
        <DialogContent scrollBody={scrollBody} className="max-h-(--sz-85vh)">
          <DialogTitle>Title</DialogTitle>
          <DialogDescription>Long text</DialogDescription>
        </DialogContent>
      </Dialog>,
    ),
  );
  return document.querySelector<HTMLElement>('[data-slot="dialog-content"]')!;
}

it("scrolls an inner body so the glass rim stays on the frame", () => {
  const content = renderDialog(true);
  const body = content.querySelector<HTMLElement>('[data-slot="dialog-scroll-body"]');

  expect(content.className).toContain("gs-glass-float");
  expect(content.className).not.toContain("overflow-y-auto");
  expect(content.className).toContain("grid-rows-[minmax(0,1fr)]");
  expect(body?.className).toContain("overflow-y-auto");
  expect(body?.textContent).toContain("Long text");
  // The close button stays on the frame, outside the scrolling body.
  expect(body?.querySelector('[data-slot="dialog-close"]')).toBeNull();
  expect(content.querySelector('[data-slot="dialog-close"]')).not.toBeNull();
});

it("renders children directly without scrollBody", () => {
  const content = renderDialog(false);

  expect(content.querySelector('[data-slot="dialog-scroll-body"]')).toBeNull();
  expect(content.className).not.toContain("grid-rows-[minmax(0,1fr)]");
});
