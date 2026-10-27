// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebsitePage } from "@greatstone/shared";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ requestChange: vi.fn(), uploadChangeImage: vi.fn(), media: vi.fn() }));
const issues = vi.hoisted(() => ({ addComment: vi.fn(), uploadAttachment: vi.fn() }));
const images = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../../api/website", () => ({ websiteModuleApi: api }));
vi.mock("../../api/issues", () => ({ issuesApi: issues }));
vi.mock("../../api/images", () => ({ imagesApi: images }));
vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { Link: actual.Link };
});

import { WebsiteChangeRequestPanel } from "./WebsiteChangeRequest";

const page = { id: "page-1", title: "Home", slug: "/", latestRevisionId: "rev-1" } as WebsitePage;
const ASSET = "6f1c1b8e-1a7b-4c1e-9b1a-2d3e4f5a6b7c";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  api.requestChange.mockResolvedValue({ issueId: "issue-1", identifier: "GRE-9", title: "t", assigneeAgentId: "agent-1", projectId: null });
  api.uploadChangeImage.mockResolvedValue({ attachmentId: "att-1" });
  issues.addComment.mockResolvedValue({});
  api.media.mockResolvedValue([
    { entryId: "e-1", entryKey: "team", assetId: ASSET, alt: "Team photo", caption: null, contentType: "image/png", byteSize: 1, width: null, height: null, contentPath: `/api/assets/${ASSET}/content` },
    { entryId: "e-2", entryKey: "logo", assetId: ASSET, alt: "Logo", caption: null, contentType: "image/svg+xml", byteSize: 1, width: null, height: null, contentPath: "/x" },
  ]);
  images.list.mockResolvedValue({
    images: [{ id: "img-1", status: "completed", assetId: ASSET, contentPath: "/studio.png", prompt: "Sunset over the bay" }],
    total: 1,
    nextOffset: null,
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function flush() {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function render(effects: { id: string; label: string; description?: string }[] = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <WebsiteChangeRequestPanel companyId="co-1" siteId="site-1" page={page} target={{ kind: "page" }} width="phone" effects={effects} onCancel={() => {}} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
}

const button = (label: string) => [...container.querySelectorAll("button")].find((el) => el.textContent?.trim() === label)!;
const rows = () => [...container.querySelectorAll<HTMLElement>('[data-testid="website-change-attachment"]')];
const problem = () => container.querySelector('[data-testid="website-change-attach-problem"]')?.textContent ?? "";
const png = (name = "mood.png", size = 10) => new File([new Uint8Array(size)], name, { type: "image/png" });

async function setValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function chooseFiles(...files: File[]) {
  const input = container.querySelector<HTMLInputElement>('[data-testid="website-change-file"]')!;
  expect(input.accept).toBe("image/png,image/jpeg,image/webp,image/gif");
  await act(async () => {
    Object.defineProperty(input, "files", { configurable: true, value: files });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

async function click(el: HTMLElement) {
  await act(async () => el.click());
  await flush();
}

describe("Ask an agent attachments (GRE-2527)", () => {
  it("uploads an image with a note: the request lists it and the file goes to the task's checked route", async () => {
    await render();
    expect(button("Send").disabled).toBe(true);
    await chooseFiles(png());
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.textContent).toContain("Uploaded · mood.png");
    await setValue(rows()[0]!.querySelector("input")!, "This colour");
    expect(button("Send").disabled).toBe(false);
    await click(button("Send"));

    expect(api.requestChange).toHaveBeenCalledWith(
      "co-1",
      "site-1",
      "page-1",
      expect.objectContaining({ request: "", attachments: [{ kind: "upload", name: "mood.png", note: "This colour" }] }),
    );
    expect(api.uploadChangeImage).toHaveBeenCalledWith("co-1", "site-1", "page-1", "issue-1", expect.any(File));
    expect((api.uploadChangeImage.mock.calls[0]![4] as File).name).toBe("mood.png");
    expect(issues.uploadAttachment).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="website-change-images"]')?.textContent).toBe("Your image is attached to the task.");
  });

  it("refuses SVG and big images before anything is sent", async () => {
    await render();
    await chooseFiles(new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" }), png("big.png", 8 * 1024 * 1024 + 1));
    expect(rows()).toHaveLength(0);
    expect(problem()).toContain("logo.svg is not a PNG, JPEG, WebP or GIF image.");
    expect(problem()).toContain("big.png is larger than 8 MB.");
  });

  it("a pasted image is added as pasted-1.png; a text paste is left alone", async () => {
    await render();
    const form = container.querySelector("form")!;
    const paste = (data: Partial<DataTransfer>) => {
      const event = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: Partial<DataTransfer> };
      event.clipboardData = data;
      return event;
    };
    const text = paste({ files: [] as unknown as FileList, items: [{ kind: "string", type: "text/plain", getAsFile: () => null }] as unknown as DataTransferItemList });
    await act(async () => { form.querySelector("textarea")!.dispatchEvent(text); });
    expect(text.defaultPrevented).toBe(false);
    expect(rows()).toHaveLength(0);
    const image = paste({ files: [png("image.png")] as unknown as FileList, items: [] as unknown as DataTransferItemList });
    await act(async () => { form.querySelector("textarea")!.dispatchEvent(image); });
    await flush();
    expect(image.defaultPrevented).toBe(true);
    expect(rows()[0]!.textContent).toContain("pasted-1.png");
  });

  it("picks from Website media (no SVG) and GS Studio", async () => {
    await render();
    await click(button("From media"));
    const items = () => [...container.querySelectorAll<HTMLButtonElement>('[data-testid="website-change-media-item"]')];
    expect(items().map((item) => item.textContent)).toEqual(["Team photo"]);
    await click(items()[0]!);
    await click(button("From media"));
    await click(button("GS Studio"));
    expect(items().map((item) => item.textContent)).toEqual(["Sunset over the bay"]);
    await click(items()[0]!);
    expect(rows().map((row) => row.textContent)).toEqual(["Website media · Team photo", "GS Studio · Sunset over the bay"]);

    await click(button("Send"));
    expect(api.requestChange.mock.calls[0]![3].attachments).toEqual([
      { kind: "media", source: "website", assetId: ASSET, label: "Team photo" },
      { kind: "media", source: "studio", assetId: ASSET, label: "Sunset over the bay" },
    ]);
    expect(api.uploadChangeImage).not.toHaveBeenCalled();
  });

  it("adds a reference site; a non-web address is refused", async () => {
    await render();
    await click(button("Link"));
    const address = container.querySelector<HTMLInputElement>('input[aria-label="Reference site address"]')!;
    await setValue(address, "javascript:alert(1)");
    await click(button("Add"));
    expect(container.textContent).toContain("Type a web address");
    expect(rows()).toHaveLength(0);
    await setValue(address, "example.com/inspo");
    await click(button("Add"));
    expect(rows()[0]!.textContent).toBe("Reference site · example.com/inspo");
    await click(button("Send"));
    expect(api.requestChange.mock.calls[0]![3].attachments).toEqual([{ kind: "link", url: "https://example.com/inspo" }]);
  });

  it("offers the site's effects library, and no Effect button without one", async () => {
    await render();
    expect(button("Effect")).toBeUndefined();
    act(() => root.unmount());
    root = createRoot(container);
    await render([{ id: "aurora", label: "Aurora", description: "Soft moving light" }]);
    await click(button("Effect"));
    const effect = container.querySelector<HTMLButtonElement>('[data-testid="website-change-effects"] button')!;
    expect(effect.textContent).toBe("AuroraSoft moving light");
    await click(effect);
    await setValue(rows()[0]!.querySelector("input")!, "Slower");
    await click(button("Send"));
    expect(api.requestChange.mock.calls[0]![3].attachments).toEqual([{ kind: "effect", effectId: "aurora", label: "Aurora", note: "Slower" }]);
  });

  it("removes an attachment, and stops at ten", async () => {
    await render();
    await chooseFiles(...Array.from({ length: 11 }, (_, n) => png(`shot-${n}.png`)));
    expect(rows()).toHaveLength(10);
    expect(problem()).toBe("Only 10 attachments fit on one request.");
    expect(button("Link").disabled).toBe(true);
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Remove shot-0.png"]')!);
    expect(rows()).toHaveLength(9);
    expect(button("Link").disabled).toBe(false);
  });

  it("a failed upload is said in the box and corrected on the task", async () => {
    api.uploadChangeImage.mockRejectedValue(new Error("The image is larger than 8 MB."));
    await render();
    await chooseFiles(png());
    await click(button("Send"));
    expect(container.querySelector('[data-testid="website-change-screenshot"]')?.textContent).toContain("Some files did not upload: mood.png (The image is larger than 8 MB.)");
    expect(issues.addComment).toHaveBeenCalledWith("issue-1", expect.stringContaining("Missing: mood.png"));
  });
});

describe("Ask an agent on a phone (GRE-2759)", () => {
  /** A PNG header the size of a 780 x 1600 screenshot: enough for the drawing to read its size. */
  const PNG = (() => {
    const bytes = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, ..."IHDR".split("").map((c) => c.charCodeAt(0)), 0, 0, 3, 12, 0, 0, 6, 64, 8, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    return `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`;
  })();
  const matchMedia = window.matchMedia;
  const layer = () => document.body.querySelector('[data-testid="website-markup-layer"]');

  let host: HTMLDivElement;

  afterEach(() => {
    window.matchMedia = matchMedia;
    host.remove();
  });

  async function renderWithDrawing(phone: boolean) {
    window.matchMedia = ((query: string) =>
      ({ matches: phone && query === "(width < 40rem)", media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList);
    // The editor's canvas: outside the panel's root, like the real host.
    host = document.createElement("div");
    document.body.appendChild(host);
    const capture = async () => ({ file: png("page.png"), width: 390, url: PNG });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <WebsiteChangeRequestPanel companyId="co-1" siteId="site-1" page={page} target={{ kind: "page" }} width="phone" capture={capture} markupHost={host} onCancel={() => {}} />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await flush();
  }

  it("opens the drawing at once on a laptop", async () => {
    await renderWithDrawing(false);
    expect(layer()).not.toBeNull();
  });

  it("keeps the drawing closed on a phone until the person asks, so the box shows first", async () => {
    await renderWithDrawing(true);
    expect(layer()).toBeNull();
    await click(button("Draw on the page"));
    expect(layer()).not.toBeNull();
    await click([...host.querySelectorAll("button")].find((el) => el.textContent?.trim() === "Done")!);
    expect(layer()).toBeNull();
    expect(button("Edit drawing") ?? button("Draw on the page")).toBeTruthy();
  });
});
