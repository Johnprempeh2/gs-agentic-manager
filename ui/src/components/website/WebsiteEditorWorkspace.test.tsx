// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebsitePage, WebsitePageEditorLoad, WebsiteProperty, WebsiteSite } from "@greatstone/shared";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  sites: vi.fn(),
  pages: vi.fn(),
  page: vi.fn(),
  pageEditor: vi.fn(),
  savePageContent: vi.fn(),
  revisions: vi.fn(),
  revision: vi.fn(),
  restoreRevision: vi.fn(),
  media: vi.fn(),
  requestChange: vi.fn(),
  createEntry: vi.fn(),
  images: vi.fn(),
}));
vi.mock("../../api/images", () => ({ imagesApi: { list: api.images } }));
vi.mock("../../api/videos", () => ({ videosApi: { list: vi.fn() } }));
vi.mock("../../api/website", async () => {
  const actual = await vi.importActual<typeof import("../../api/website")>("../../api/website");
  return { ...actual, websiteModuleApi: api };
});
vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { useSearchParams: actual.useSearchParams, Link: actual.Link };
});

import { WebsiteEditorTab } from "./WebsiteEditorWorkspace";

const EDITOR = "https://editor.example.com";
const property = { id: "prop-1", companyId: "co-1", name: "Example", siteUrl: "https://example.com/" } as WebsiteProperty;
const site = {
  id: "site-1",
  companyId: "co-1",
  name: "Example",
  domain: "example.com",
  propertyId: "prop-1",
  editorFrameOrigin: EDITOR,
  archivedAt: null,
} as WebsiteSite;
const page = {
  id: "page-1",
  siteId: "site-1",
  title: "Home",
  slug: "/",
  latestRevisionId: "rev-2",
  publishedRevisionId: null,
} as WebsitePage;
const data = { root: { props: {} }, content: [{ type: "Hero", props: { id: "h1", heading: "Hello", image: "media:asset-1" } }] };
const load: WebsitePageEditorLoad = {
  page,
  revisionId: "rev-2",
  data,
  theme: {},
  site: { name: "Example", settings: { domain: "example.com" }, navigation: [] },
  editorFrameOrigin: EDITOR,
  media: [{ entryId: "m1", entryKey: "hero", assetId: "asset-1", alt: "Team", caption: null, contentType: "image/png", byteSize: 3, width: 4, height: 3, contentPath: "/api/assets/asset-1/content" }],
};
const revisions = [
  { id: "rev-2", revisionNumber: 2, changeSummary: null, createdByAgentId: null, createdByUserId: "u", createdAt: "2026-10-23T10:00:00.000Z" },
  { id: "rev-1", revisionNumber: 1, changeSummary: "Created", createdByAgentId: null, createdByUserId: "u", createdAt: "2026-10-23T09:00:00.000Z" },
];

const pickRef = {
  siteId: "site-1",
  pageId: "page-1",
  pageRevisionId: "rev-2",
  blockId: "h1",
  blockType: "Hero",
  engine: { version: "1.0.0", commit: "b".repeat(40) },
  source: { file: "src/blocks/Hero.tsx", line: 12 },
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
  api.sites.mockResolvedValue([site]);
  api.pages.mockResolvedValue([page]);
  api.pageEditor.mockResolvedValue(load);
  api.revisions.mockResolvedValue(revisions);
  api.media.mockResolvedValue(load.media);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, blob: async () => new Blob(["png"], { type: "image/png" }) })));
  vi.stubGlobal("confirm", vi.fn(() => true));
  api.images.mockResolvedValue({
    images: [{ id: "img-77778888", prompt: "A harbour at dawn", status: "completed", assetId: "asset-7", contentPath: "/api/assets/asset-7/content" }],
    total: 1,
    nextOffset: null,
  });
  api.createEntry.mockResolvedValue({ id: "entry-7" });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function flush() {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/website?tab=editor"]}>
          <WebsiteEditorTab companyId="co-1" property={property} onOpenTab={vi.fn()} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
}

const text = () => container.textContent ?? "";
const button = (label: string) => [...container.querySelectorAll("button")].find((el) => el.textContent?.trim() === label)!;
const textarea = () => container.querySelector<HTMLTextAreaElement>('[data-testid="website-change-request"] textarea')!;
const panel = () => container.querySelector<HTMLElement>('[data-testid="website-change-request"]');

async function type(value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(textarea(), value);
    textarea().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function openPreview() {
  await act(async () => button("Preview").click());
  await flush();
}

const frame = () => container.querySelector<HTMLIFrameElement>('[data-testid="website-editor-frame"]');

/** Load the frame and complete the handshake as the site's editor would. */
async function connect() {
  const iframe = frame()!;
  const frameWindow = iframe.contentWindow!;
  const posted = vi.spyOn(frameWindow, "postMessage").mockImplementation(() => {});
  await act(async () => { iframe.dispatchEvent(new Event("load")); });
  const hello = posted.mock.calls[0]![0] as { type: string; payload: { nonce: string } };
  expect(hello.type).toBe("hello");
  expect(posted.mock.calls[0]![1]).toBe(EDITOR);
  const nonce = hello.payload.nonce;
  const fromFrame = async (message: Record<string, unknown>) => {
    await act(async () => {
      window.dispatchEvent(new MessageEvent("message", { origin: EDITOR, source: frameWindow, data: { gs: "website-frame", id: `m-${Math.random()}`, ...message } }));
    });
    await flush();
  };
  await fromFrame({
    type: "hello-ack",
    payload: { protocol: 1, nonce, siteId: "site-1", engine: { version: "1.0.0", commit: "b".repeat(40) }, supportedReleaseSchemas: [1], blocks: [{ type: "Hero", label: "Hero" }] },
  });
  const sent = (type: string) => posted.mock.calls.map((call) => call[0] as { type: string; payload: Record<string, unknown> }).filter((message) => message.type === type);
  const save = (requestId: string) => fromFrame({ protocol: 1, session: nonce, type: "save", payload: { requestId, pageId: "page-1", baseRevisionId: "rev-2", data } });
  const pickBlock = async (origin = EDITOR) => {
    await act(async () => {
      window.dispatchEvent(new MessageEvent("message", {
        origin,
        source: frameWindow,
        data: { gs: "website-frame", id: `m-${Math.random()}`, protocol: 1, session: nonce, type: "block-picked", payload: { ref: pickRef, label: "Hero banner", rect: { x: 0, y: 0, width: 100, height: 40 } } },
      }));
    });
    await flush();
  };
  const sentMessages = (type: string) =>
    posted.mock.calls.map((call) => call[0] as { type: string; id: string; payload: Record<string, unknown> }).filter((message) => message.type === type);
  const reply = (type: string, payload: Record<string, unknown>) => fromFrame({ protocol: 1, session: nonce, type, payload });
  return { posted, sent, sentMessages, reply, save, fromFrame, pickBlock };
}

/** Click to change, then "Edit words or image myself": the editor opens with block h1 selected. */
async function openEditorOnBlock() {
  await render();
  await openPreview();
  const preview = await connect();
  await preview.pickBlock();
  await act(async () => button("Edit words or image myself").click());
  await flush();
  return connect();
}

/** Media, Add image, pick the GS Studio image, add alt text, Use. */
async function useStudioImage(alt = "Boats in a harbour") {
  await act(async () => button("Media").click());
  await flush();
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="website-add-image"]')!.click());
  await flush();
  await act(async () => document.body.querySelector<HTMLButtonElement>('[data-testid="media-picker-item"]')!.click());
  await flush();
  const input = document.body.querySelector<HTMLInputElement>('[data-testid="media-alt"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, alt);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => document.body.querySelector<HTMLButtonElement>('[data-testid="media-use"]')!.click());
  await flush();
}

const mediaPanel = () => container.querySelector<HTMLElement>('[data-testid="website-media"]')!;

describe("WebsiteEditorTab", () => {
  it("frames the site's editor with the contract's sandbox and sends the draft with images as Blobs after hello-ack", async () => {
    await render();
    const iframe = frame()!;
    expect(iframe.getAttribute("src")).toBe(`${EDITOR}/editor/page-1`);
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin allow-forms");
    expect(iframe.getAttribute("referrerpolicy")).toBe("no-referrer");
    const { sent } = await connect();
    const [draft] = sent("load-draft");
    expect(draft!.payload).toMatchObject({ pageId: "page-1", revisionId: "rev-2", data });
    expect((draft!.payload.media as Record<string, { blob: unknown }>)["asset-1"]!.blob).toBeInstanceOf(Blob);
  });

  it("save flow: saved, then failed with Retry that saves the same request again", async () => {
    api.savePageContent
      .mockResolvedValueOnce({ state: "saved", revisionId: "rev-3", revisionNumber: 3 })
      .mockResolvedValueOnce({ state: "failed", message: "The save did not complete. Your edits are kept; try again." })
      .mockResolvedValueOnce({ state: "saved", revisionId: "rev-4", revisionNumber: 4 });
    await render();
    const { sent, save } = await connect();

    await save("req-1");
    expect(api.savePageContent).toHaveBeenCalledWith("co-1", "site-1", "page-1", { baseRevisionId: "rev-2", content: data, editorOrigin: EDITOR });
    expect(sent("save-result")[0]!.payload).toMatchObject({ requestId: "req-1", outcome: "saved", revisionId: "rev-3" });
    expect(text()).toContain("Saved at");

    await save("req-2");
    expect(text()).toContain("The save did not complete");
    await act(async () => button("Retry").click());
    await flush();
    expect(api.savePageContent).toHaveBeenCalledTimes(3);
    expect(sent("save-result").map((message) => message.payload.requestId)).toEqual(["req-1", "req-2", "req-2"]);
    expect(text()).toContain("Saved at");
  });

  it("conflict: tells the person someone saved first and hands the frame the latest content", async () => {
    api.savePageContent.mockResolvedValueOnce({ state: "conflict", latestRevisionId: "rev-9", latestRevisionNumber: 9, message: "newer" });
    api.page.mockResolvedValue({ ...page, content: { theirs: true } });
    api.revisions.mockResolvedValue([{ ...revisions[0], id: "rev-9", revisionNumber: 9 }]);
    await render();
    const { sent, save } = await connect();
    await save("req-1");
    expect(sent("save-result")[0]!.payload).toMatchObject({ outcome: "conflict", currentRevisionId: "rev-9", currentData: { theirs: true } });
    expect(text()).toContain("Someone saved this page first");
  });

  it("origin-changed (C2.4): the editor closes and asks to reload", async () => {
    api.savePageContent.mockResolvedValueOnce({ state: "failed", code: "origin-changed", message: "changed" });
    await render();
    const { save } = await connect();
    await save("req-1");
    expect(text()).toContain("The editor address for this site changed. Reload to continue.");
    expect(frame()).toBeNull();
  });

  it("previews the draft at laptop, tablet and phone widths", async () => {
    await render();
    await act(async () => button("Preview").click());
    await flush();
    expect(frame()!.getAttribute("src")).toBe(`${EDITOR}/preview/page-1`);
    for (const [label, width, viewport] of [["Tablet 768", 768, "tablet"], ["Phone 390", 390, "phone"], ["Laptop 1440", 1440, "laptop"]] as const) {
      await act(async () => button(label).click());
      await flush();
      expect(frame()!.dataset.viewport).toBe(viewport);
      expect(frame()!.style.width).toBe(`${width}px`);
    }
    await act(async () => button("Live").click());
    await flush();
    expect(text()).toContain("This page is not live yet");
  });

  it("history: restores an older version on top of the latest one and reloads the editor", async () => {
    api.restoreRevision.mockResolvedValue({ state: "saved", revisionId: "rev-3", revisionNumber: 3 });
    await render();
    await act(async () => button("History").click());
    await flush();
    expect(text()).toContain("Version 2");
    expect(text()).toContain("Current");
    await act(async () => button("Restore").click());
    await flush();
    expect(api.restoreRevision).toHaveBeenCalledWith("co-1", "site-1", "page-1", "rev-1", "rev-2");
    expect(text()).toContain("Version 1 restored as version 3.");
  });

  it("media: lists the site's media entries", async () => {
    await render();
    await act(async () => button("Media").click());
    await flush();
    const image = container.querySelector<HTMLImageElement>('[data-testid="website-media"] img')!;
    expect(image.getAttribute("src")).toBe("/api/assets/asset-1/content");
    expect(image.alt).toBe("Team");
  });

  it("click to change: pick, describe, confirm creates exactly one task with the durable reference", async () => {
    api.requestChange.mockResolvedValue({ issueId: "issue-1", identifier: "GRE-9001", title: "Website change: Hero banner on Home", assigneeAgentId: "lintel", projectId: "proj-1" });
    await render();
    await openPreview();
    const { pickBlock, sent } = await connect();
    expect(text()).toContain("Preview. Click a block to ask for a change");
    await pickBlock();
    expect(sent("highlight").at(-1)!.payload).toEqual({ blockId: "h1" });
    expect(panel()!.dataset.step).toBe("describe");
    expect(panel()!.textContent).toContain("Hero banner on Home");
    expect(panel()!.textContent).not.toContain("h1");
    expect(button("Review").disabled).toBe(true);

    await type("Make the heading shorter.");
    await act(async () => button("Review").click());
    expect(panel()!.dataset.step).toBe("confirm");
    expect(container.querySelector('[data-testid="website-change-summary"]')!.textContent).toBe("Make the heading shorter.");
    expect(api.requestChange).not.toHaveBeenCalled();

    await act(async () => button("Create task").click());
    await flush();
    expect(api.requestChange).toHaveBeenCalledTimes(1);
    const [companyId, siteId, pageId, input] = api.requestChange.mock.calls[0]!;
    expect([companyId, siteId, pageId]).toEqual(["co-1", "site-1", "page-1"]);
    expect(input).toEqual({
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      pageRevisionId: "rev-2",
      blockId: "h1",
      blockType: "Hero",
      blockLabel: "Hero banner",
      engine: { version: "1.0.0", commit: "b".repeat(40) },
      source: { file: "src/blocks/Hero.tsx", line: 12 },
      request: "Make the heading shorter.",
    });
    expect(panel()!.dataset.step).toBe("created");
    expect(container.querySelector<HTMLAnchorElement>('[data-testid="website-change-request"] a')!.getAttribute("href")).toBe("/issues/GRE-9001");
    expect(text()).toContain("is with the website agent");
  });

  it("click to change: Cancel at describe or confirm creates nothing and clears the highlight", async () => {
    await render();
    await openPreview();
    const { pickBlock, sent } = await connect();
    await pickBlock();
    await act(async () => button("Cancel").click());
    expect(panel()).toBeNull();
    expect(sent("highlight").at(-1)!.payload).toEqual({ blockId: null });

    await pickBlock();
    await type("Change the photo.");
    await act(async () => button("Review").click());
    await act(async () => button("Cancel").click());
    expect(panel()).toBeNull();
    expect(api.requestChange).not.toHaveBeenCalled();
  });

  it("click to change: a block-picked from a wrong origin is ignored", async () => {
    await render();
    await openPreview();
    const { pickBlock, sent } = await connect();
    await pickBlock("https://evil.example.com");
    expect(panel()).toBeNull();
    expect(sent("highlight")).toHaveLength(0);
  });

  it("click to change: Edit words or image myself opens the block in the editor", async () => {
    await render();
    await openPreview();
    const preview = await connect();
    await preview.pickBlock();
    await act(async () => button("Edit words or image myself").click());
    await flush();
    expect(frame()!.getAttribute("src")).toBe(`${EDITOR}/editor/page-1`);
    const editor = await connect();
    expect(editor.sent("load-draft")).toHaveLength(1);
    expect(editor.sent("highlight").at(-1)!.payload).toEqual({ blockId: "h1" });
    expect(api.requestChange).not.toHaveBeenCalled();
  });

  describe("insert media into the selected block (GRE-2206)", () => {
    it("sends insert-media for the selected block with the new entry's asset", async () => {
      const editor = await openEditorOnBlock();
      await useStudioImage();
      expect(api.createEntry).toHaveBeenCalledTimes(1);
      const [insert] = editor.sentMessages("insert-media");
      expect(insert!.payload).toEqual({
        blockId: "h1",
        field: "image",
        mediaEntryId: "asset-7",
        assetUrl: "/api/assets/asset-7/content",
        alt: "Boats in a harbour",
      });
      expect(mediaPanel().textContent).toContain("Putting it in the selected block.");
    });

    it("ok reply: no editor reload, and the draft shows unsaved changes", async () => {
      const editor = await openEditorOnBlock();
      const iframe = frame();
      await useStudioImage();
      const [insert] = editor.sentMessages("insert-media");
      await editor.reply("insert-media-result", { requestId: insert!.id, ok: true });
      expect(frame()).toBe(iframe);
      expect(editor.sent("load-draft")).toHaveLength(1);
      expect(mediaPanel().textContent).toContain("Put in the selected block. Save the page in the editor to keep it.");
      expect(container.querySelector('[data-testid="website-save-banner"]')!.textContent).toContain("Unsaved changes");
    });

    it("ok:false reply: says why in plain words and keeps the media entry", async () => {
      const editor = await openEditorOnBlock();
      await useStudioImage();
      const [insert] = editor.sentMessages("insert-media");
      await editor.reply("insert-media-result", { requestId: insert!.id, ok: false, code: "field_not_media" });
      expect(mediaPanel().textContent).toContain("The selected block has no image or video field for this. It is in Website media");
      expect(api.createEntry).toHaveBeenCalledTimes(1);
    });

    it("no reply in time (older site): falls back to today's flow and reloads the editor", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const editor = await openEditorOnBlock();
      const iframe = frame();
      await useStudioImage();
      expect(editor.sentMessages("insert-media")).toHaveLength(1);
      await act(async () => { vi.advanceTimersByTime(5_000); });
      await flush();
      expect(frame()).not.toBe(iframe);
      expect(mediaPanel().textContent).toContain("Added from GS Studio. It is now in Website media and goes live with the next Publish.");
    });

    it("no block selected: makes the entry and reloads, without insert-media", async () => {
      await render();
      const editor = await connect();
      const iframe = frame();
      await useStudioImage();
      expect(api.createEntry).toHaveBeenCalledTimes(1);
      expect(editor.sentMessages("insert-media")).toHaveLength(0);
      expect(frame()).not.toBe(iframe);
    });

    it("a selected block lets an existing Website media entry be used without making a new one", async () => {
      const editor = await openEditorOnBlock();
      await act(async () => button("Media").click());
      await flush();
      await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="website-add-image"]')!.click());
      await flush();
      await act(async () => [...document.body.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) => tab.textContent === "Website media")!.click());
      await flush();
      await act(async () => document.body.querySelector<HTMLButtonElement>('[data-testid="media-picker-entry"]')!.click());
      await act(async () => document.body.querySelector<HTMLButtonElement>('[data-testid="media-use"]')!.click());
      await flush();
      expect(api.createEntry).not.toHaveBeenCalled();
      expect(editor.sentMessages("insert-media")[0]!.payload).toMatchObject({ blockId: "h1", mediaEntryId: "asset-1", alt: "Team" });
    });
  });

  it("does not open an editor until the editor address is set", async () => {
    api.sites.mockResolvedValue([{ ...site, editorFrameOrigin: null }]);
    await render();
    expect(text()).toContain("Set the editor address");
    expect(frame()).toBeNull();
  });
});
