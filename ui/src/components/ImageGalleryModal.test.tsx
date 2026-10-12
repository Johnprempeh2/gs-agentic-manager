// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beforeAfterPair, ImageGalleryModal, type GalleryMediaItem } from "./ImageGalleryModal";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function makeMediaItem(overrides: Partial<GalleryMediaItem> = {}): GalleryMediaItem {
  return {
    id: "media-1",
    contentPath: "/api/attachments/media-1/content",
    openPath: "/api/attachments/media-1/content",
    downloadPath: "/api/attachments/media-1/content?download=1",
    contentType: "image/png",
    originalFilename: "screenshot.png",
    ...overrides,
  };
}

describe("ImageGalleryModal", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    document.body.innerHTML = "";
  });

  it("renders video media with a download link in the gallery", async () => {
    const video = makeMediaItem({
      id: "video-1",
      contentPath: "/api/attachments/video-1/content",
      downloadPath: "/api/attachments/video-1/content?download=1",
      contentType: "video/webm",
      originalFilename: "demo.webm",
    });

    await act(async () => {
      root.render(
        <ImageGalleryModal
          items={[video]}
          initialIndex={0}
          open
          onOpenChange={() => undefined}
        />,
      );
    });
    await flushReact();

    const renderedVideo = document.body.querySelector("video");
    expect(renderedVideo?.getAttribute("src")).toBe("/api/attachments/video-1/content");
    expect(renderedVideo?.getAttribute("controls")).not.toBeNull();
    expect(
      document.body.querySelector('a[aria-label="Download demo.webm"]')?.getAttribute("href"),
    ).toBe("/api/attachments/video-1/content?download=1");
  });

  it("compares a before/after pair with a divider the viewer can move", async () => {
    const before = makeMediaItem({ id: "b", contentPath: "/b", originalFilename: "before-dashboard-dark.png" });
    const after = makeMediaItem({ id: "a", contentPath: "/a", originalFilename: "after-dashboard-dark.png" });
    const other = makeMediaItem({ id: "o", contentPath: "/o", originalFilename: "notes.png" });
    expect(beforeAfterPair([before, other, after], 2)).toEqual({ before, after });
    expect(beforeAfterPair([before, other, after], 1)).toBeNull();
    expect(beforeAfterPair([before, other], 0)).toBeNull();

    await act(async () => {
      root.render(<ImageGalleryModal items={[after, other, before]} initialIndex={0} open onOpenChange={() => undefined} />);
    });
    await flushReact();
    const compare = [...document.body.querySelectorAll("button")].find((button) => button.textContent === "Compare before and after");
    expect(compare).toBeTruthy();
    await act(async () => compare!.click());
    await flushReact();
    const images = [...document.body.querySelectorAll("[data-gallery-compare] img")].map((img) => img.getAttribute("src"));
    expect(images).toEqual(["/a", "/b"]);
    expect(document.body.querySelector('input[type="range"]')).not.toBeNull();
  });

  it("supports keyboard navigation and Escape close", async () => {
    const onOpenChange = vi.fn();
    const first = makeMediaItem({
      id: "first",
      contentPath: "/api/attachments/first/content",
      originalFilename: "first.png",
    });
    const second = makeMediaItem({
      id: "second",
      contentPath: "/api/attachments/second/content",
      originalFilename: "second.png",
    });

    await act(async () => {
      root.render(
        <ImageGalleryModal
          items={[first, second]}
          initialIndex={0}
          open
          onOpenChange={onOpenChange}
        />,
      );
    });
    await flushReact();

    expect(document.body.textContent).toContain("first.png");
    expect(document.body.textContent).toContain("1 / 2");

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    });
    await flushReact();

    expect(document.body.textContent).toContain("second.png");
    expect(document.body.textContent).toContain("2 / 2");

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    });
    await flushReact();

    expect(document.body.textContent).toContain("first.png");
    expect(document.body.textContent).toContain("1 / 2");

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
