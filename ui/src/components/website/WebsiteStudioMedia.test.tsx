// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GeneratedImage, GeneratedVideo, WebsiteSite } from "@greatstone/shared";
import { focalPointFromClick, studioClipItems, studioImageItems, studioMediaEntry } from "../../lib/website-studio-media";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  images: vi.fn(),
  videos: vi.fn(),
  sites: vi.fn(),
  createEntry: vi.fn(),
}));
vi.mock("../../api/images", () => ({ imagesApi: { list: api.images } }));
vi.mock("../../api/videos", () => ({ videosApi: { list: api.videos } }));
vi.mock("../../api/website", () => ({ websiteModuleApi: { sites: api.sites, createEntry: api.createEntry } }));
vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { Link: actual.Link };
});

import { UseOnWebsiteDialog, WebsiteMediaPicker, type MediaPickerKind } from "./WebsiteStudioMedia";

const site = { id: "site-1", name: "Example", domain: "example.com", archivedAt: null } as WebsiteSite;
const otherSite = { id: "site-2", name: "Shop", domain: "shop.example.com", archivedAt: null } as WebsiteSite;
const image = (over: Partial<GeneratedImage>) =>
  ({ id: "img-11112222", prompt: "A harbour at dawn", status: "completed", assetId: "asset-1", contentPath: "/api/assets/asset-1/content", altText: "Harbour", ...over }) as GeneratedImage;
const clip = (over: Partial<GeneratedVideo>) =>
  ({ id: "vid-33334444", prompt: "Waves rolling in", status: "completed", assetId: "asset-9", contentPath: "/api/assets/asset-9/content", ...over }) as GeneratedVideo;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
  api.images.mockResolvedValue({
    images: [image({}), image({ id: "img-pending", status: "pending", assetId: null, contentPath: null }), image({ id: "img-failed", status: "failed", assetId: null })],
    total: 3,
    nextOffset: null,
  });
  api.videos.mockResolvedValue({ videos: [clip({}), clip({ id: "vid-pending", status: "pending", assetId: null, contentPath: null })], total: 2, nextOffset: null });
  api.sites.mockResolvedValue([site]);
  api.createEntry.mockResolvedValue({ id: "entry-1" });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function flush() {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function show(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>{node}</MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
}

// Dialogs render in a portal on document.body.
const byTestId = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const allByTestId = (id: string) => [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];

async function click(element: HTMLElement) {
  await act(async () => { element.click(); });
  await flush();
}

async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("studio media helpers", () => {
  it("keeps only finished items that have an asset", () => {
    expect(studioImageItems([image({}), image({ id: "p", status: "pending", assetId: null, contentPath: null })]).map((item) => item.id)).toEqual(["img-11112222"]);
    expect(studioClipItems([clip({}), clip({ id: "f", status: "failed", assetId: null })]).map((item) => item.source)).toEqual(["animation"]);
  });

  it("makes a media entry that points at the studio asset, with trimmed alt text", () => {
    const [item] = studioImageItems([image({})]);
    const entry = studioMediaEntry(item!, { alt: "  Boats in a harbour  ", caption: " ", focalPoint: { x: 0.2, y: 0.8 } }, new Date(0));
    expect(entry).toEqual({
      collection: "media",
      entryKey: "studio-image-img-1111-0",
      content: { assetId: "asset-1", alt: "Boats in a harbour", caption: null, focalPoint: { x: 0.2, y: 0.8 } },
    });
  });

  it("turns a click into a focus point inside 0 to 1", () => {
    const rect = { left: 10, top: 20, width: 200, height: 100 };
    expect(focalPointFromClick(rect, 60, 45)).toEqual({ x: 0.25, y: 0.25 });
    expect(focalPointFromClick(rect, 500, -5)).toEqual({ x: 1, y: 0 });
  });
});

describe("WebsiteMediaPicker", () => {
  const picker = (kind: MediaPickerKind, onAdded = vi.fn(), onClose = vi.fn()) => (
    <WebsiteMediaPicker companyId="co-1" site={site} kind={kind} media={[]} onClose={onClose} onAdded={onAdded} />
  );

  it("lists finished GS Studio images and keeps Use off until alt text is added", async () => {
    const onAdded = vi.fn();
    await show(picker("image", onAdded));
    expect(document.body.textContent).toContain("Add image");
    const items = allByTestId("media-picker-item");
    expect(items).toHaveLength(1);
    const use = byTestId("media-use") as HTMLButtonElement;
    expect(use.disabled).toBe(true);

    await click(items[0]!);
    // Neutral on open: no error before the person has done anything.
    const alt = byTestId("media-alt") as HTMLInputElement;
    expect(document.body.textContent).not.toContain("Add alt text before you use this.");
    expect(alt.getAttribute("aria-invalid")).toBeNull();
    expect(use.disabled).toBe(true);
    await type(alt, "Boats");
    await type(alt, "   ");
    expect(document.body.textContent).toContain("Add alt text before you use this.");
    expect(alt.getAttribute("aria-invalid")).toBe("true");
    expect(use.disabled).toBe(true);
    await type(byTestId("media-alt") as HTMLInputElement, "Boats in a harbour at dawn");
    expect(use.disabled).toBe(false);

    await click(use);
    expect(api.createEntry).toHaveBeenCalledTimes(1);
    const [companyId, siteId, input] = api.createEntry.mock.calls[0]!;
    expect([companyId, siteId]).toEqual(["co-1", "site-1"]);
    expect(input).toMatchObject({ collection: "media", content: { assetId: "asset-1", alt: "Boats in a harbour at dawn", caption: null, focalPoint: { x: 0.5, y: 0.5 } } });
    expect(onAdded).toHaveBeenCalledWith("Added from GS Studio. It is now in Website media and goes live with the next Publish.", {
      assetId: "asset-1",
      contentPath: "/api/assets/asset-1/content",
      alt: "Boats in a harbour at dawn",
      created: true,
    });
  });

  it("keeps Cancel and Use outside the scroll body, so they stay in view", async () => {
    await show(picker("image"));
    const scrollBody = document.body.querySelector('[data-slot="dialog-scroll-body"]')!;
    expect(scrollBody.contains(byTestId("media-use"))).toBe(false);
    expect(byTestId("website-media-picker")!.contains(byTestId("media-use"))).toBe(true);
  });

  it("titles Website media cards by alt text, not the entry key", async () => {
    const media = [
      { entryId: "e-1", entryKey: "studio-image-img-1111-abc", assetId: "a-1", alt: "Boats in a harbour", caption: "At dawn", contentType: "image/png", byteSize: 1, width: null, height: null, contentPath: "/a-1" },
      { entryId: "e-2", entryKey: "hero-photo", assetId: "a-2", alt: "", caption: null, contentType: "image/png", byteSize: 1, width: null, height: null, contentPath: "/a-2" },
    ];
    await show(<WebsiteMediaPicker companyId="co-1" site={site} kind="image" media={media} onClose={vi.fn()} onAdded={vi.fn()} />);
    await click([...document.body.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) => tab.textContent === "Website media")!);
    const cards = [...byTestId("media-picker-library")!.querySelectorAll("li")];
    expect(cards.map((card) => card.querySelector(".font-medium")?.textContent)).toEqual(["Boats in a harbour", "hero-photo"]);
    expect(cards[0]!.textContent).not.toContain("studio-image");
    expect(cards[0]!.getAttribute("title")).toBe("studio-image-img-1111-abc");
    expect(cards[1]!.textContent).toContain("No alt text");
    // No block selected: the cards are for looking only, and there is no Use.
    expect(byTestId("media-picker-entry")).toBeNull();
    expect(byTestId("media-use")).toBeNull();
  });

  it("lists finished Animate clips under Add animation", async () => {
    await show(picker("animation"));
    expect(document.body.textContent).toContain("Add animation");
    expect(document.body.textContent).toContain("Animation studio");
    expect(api.videos).toHaveBeenCalled();
    expect(allByTestId("media-picker-item").map((el) => el.textContent)).toEqual(["Waves rolling in"]);
  });

  it("shows the server's refusal and keeps the picker open", async () => {
    api.createEntry.mockRejectedValueOnce(new Error("This collection is not in the site's release schema"));
    const onClose = vi.fn();
    await show(picker("image", vi.fn(), onClose));
    await click(allByTestId("media-picker-item")[0]!);
    await type(byTestId("media-alt") as HTMLInputElement, "Boats");
    await click(byTestId("media-use")!);
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("not in the site's release schema");
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("UseOnWebsiteDialog", () => {
  const [item] = studioImageItems([image({})]);

  it("asks which site when there are several, and needs alt text before sending", async () => {
    api.sites.mockResolvedValue([site, otherSite]);
    const onSent = vi.fn();
    await show(<UseOnWebsiteDialog companyId="co-1" item={item!} onClose={vi.fn()} onSent={onSent} />);
    const send = byTestId("use-on-website-send") as HTMLButtonElement;
    expect(document.body.textContent).toContain("Which site?");
    await type(byTestId("media-alt") as HTMLInputElement, "Boats in a harbour");
    expect(send.disabled).toBe(true);

    const select = byTestId("use-on-website-site") as HTMLSelectElement;
    await act(async () => {
      select.value = "site-2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(send.disabled).toBe(false);
    await click(send);
    expect(api.createEntry.mock.calls[0]![1]).toBe("site-2");
    expect(onSent).toHaveBeenCalledWith("Sent to Shop's Website media.");
  });

  it("uses the only site without asking", async () => {
    await show(<UseOnWebsiteDialog companyId="co-1" item={item!} onClose={vi.fn()} onSent={vi.fn()} />);
    expect(byTestId("use-on-website-site")).toBeNull();
    await type(byTestId("media-alt") as HTMLInputElement, "Boats");
    await click(byTestId("use-on-website-send")!);
    expect(api.createEntry.mock.calls[0]![1]).toBe("site-1");
  });
});
