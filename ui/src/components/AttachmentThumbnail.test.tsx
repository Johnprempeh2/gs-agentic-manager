// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttachmentThumbnail } from "./AttachmentThumbnail";

const SIZE = 64;

function flatPixels(): Uint8ClampedArray {
  return new Uint8ClampedArray(SIZE * SIZE * 4).fill(255);
}

function busyPixels(): Uint8ClampedArray {
  const px = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let i = 0; i < SIZE * SIZE; i += 1) {
    px[i * 4] = (i * 7) % 256;
    px[i * 4 + 1] = (i * 13) % 256;
    px[i * 4 + 2] = (i * 3) % 256;
    px[i * 4 + 3] = 255;
  }
  return px;
}

let pixels = flatPixels();
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  pixels = flatPixels();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => ({
    drawImage: () => undefined,
    getImageData: () => ({ data: pixels }),
  })) as unknown as HTMLCanvasElement["getContext"]);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function render(filename: string) {
  flushSync(() => {
    root.render(<AttachmentThumbnail src="/api/attachments/a/content?w=320" alt={filename} filename={filename} />);
  });
  const img = container.querySelector("img")!;
  flushSync(() => {
    img.dispatchEvent(new Event("load"));
  });
  return img;
}

describe("AttachmentThumbnail", () => {
  it("shows the whole image anchored to the top, never a centre crop", () => {
    const img = render("logo.png");
    expect(img.className).toContain("object-contain");
    expect(img.className).toContain("object-top");
    expect(img.className).not.toContain("object-cover");
  });

  it("warns when a screenshot is mostly one flat colour", () => {
    render("after-laptop-thread.png");
    const warning = container.querySelector("[data-testid='attachment-blank-warning']");
    expect(warning?.querySelector(".sr-only")?.textContent).toBe("This screenshot looks blank");
    expect(warning?.getAttribute("title")).toContain("Ask the agent to retake it");
  });

  it("does not warn for a screenshot with content", () => {
    pixels = busyPixels();
    render("before-board.png");
    expect(container.querySelector("[data-testid='attachment-blank-warning']")).toBeNull();
  });

  it("does not check images that are not named like screenshots", () => {
    render("logo.png");
    expect(HTMLCanvasElement.prototype.getContext).not.toHaveBeenCalled();
    expect(container.querySelector("[data-testid='attachment-blank-warning']")).toBeNull();
  });
});
