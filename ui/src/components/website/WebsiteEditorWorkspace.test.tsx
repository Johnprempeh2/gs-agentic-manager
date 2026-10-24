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
  submitPage: vi.fn(),
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
  return {
    useSearchParams: actual.useSearchParams,
    useLocation: actual.useLocation,
    useNavigate: actual.useNavigate,
    Navigate: actual.Navigate,
    Link: actual.Link,
  };
});

import { Route, Routes, useLocation } from "react-router-dom";
import { WebsiteFullScreenEditor, WebsitePagesTab } from "./WebsiteEditorWorkspace";

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
  status: "draft",
  latestRevisionId: "rev-2",
  publishedRevisionId: null,
} as WebsitePage;
const about = { ...page, id: "page-2", title: "About", slug: "/about", latestRevisionId: "rev-5" } as WebsitePage;
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

let onLeave = vi.fn();

/** The full-screen editor, as `/website/edit` renders it. */
async function render(entry = "/website/edit") {
  onLeave = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[entry]}>
          <WebsiteFullScreenEditor companyId="co-1" property={property} onLeave={onLeave} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
}

// The editor covers the viewport from a portal on <body>, so look there.
const screen = () => document.body.querySelector<HTMLElement>('[data-testid="website-editor"]');
const text = () => screen()?.textContent ?? "";
const button = (label: string) => [...document.body.querySelectorAll("button")].find((el) => el.textContent?.trim() === label)!;
const labelled = (label: string) => document.body.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const textarea = () => document.body.querySelector<HTMLTextAreaElement>('[data-testid="website-change-request"] textarea')!;
const panel = () => document.body.querySelector<HTMLElement>('[data-testid="website-change-request"]');
const drawer = () => document.body.querySelector<HTMLElement>('[data-testid="website-editor-drawer"]');
const key = async (init: KeyboardEventInit, target: EventTarget = document.body) => {
  await act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); });
  await flush();
};

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

const frame = () => document.body.querySelector<HTMLIFrameElement>('[data-testid="website-editor-frame"]');

/** Load the frame and complete the handshake as the site's editor would. */
async function connect(ackExtra: Record<string, unknown> = {}) {
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
    payload: { protocol: 1, nonce, siteId: "site-1", engine: { version: "1.0.0", commit: "b".repeat(40) }, supportedReleaseSchemas: [1], blocks: [{ type: "Hero", label: "Hero" }], ...ackExtra },
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
async function openEditorOnBlock(ackExtra: Record<string, unknown> = {}, entry?: string) {
  await render(entry);
  await openPreview();
  const preview = await connect();
  await preview.pickBlock();
  await act(async () => button("Edit words or image myself").click());
  await flush();
  return connect(ackExtra);
}

/** Media, Add image, pick the GS Studio image, add alt text, Use. */
async function useStudioImage(alt = "Boats in a harbour") {
  await act(async () => labelled("Media").click());
  await flush();
  await act(async () => document.body.querySelector<HTMLButtonElement>('[data-testid="website-add-image"]')!.click());
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

const mediaPanel = () => document.body.querySelector<HTMLElement>('[data-testid="website-media"]')!;

describe("WebsiteFullScreenEditor", () => {
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
    for (const [label, width, viewport] of [["Tablet", 768, "tablet"], ["Phone", 390, "phone"], ["Laptop", 1440, "laptop"]] as const) {
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
    await act(async () => labelled("History").click());
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
    await act(async () => labelled("Media").click());
    await flush();
    const image = document.body.querySelector<HTMLImageElement>('[data-testid="website-media"] img')!;
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
    expect(document.body.querySelector('[data-testid="website-change-summary"]')!.textContent).toBe("Make the heading shorter.");
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
    expect(document.body.querySelector<HTMLAnchorElement>('[data-testid="website-change-request"] a')!.getAttribute("href")).toBe("/issues/GRE-9001");
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
        media: { blob: expect.any(Blob), alt: "Boats in a harbour", width: null, height: null },
      });
      expect(mediaPanel().textContent).toContain("Selected block: Hero banner.");
      expect(mediaPanel().textContent).toContain("Putting it in Hero banner.");
    });

    it("ok reply: no editor reload, and the draft shows unsaved changes", async () => {
      const editor = await openEditorOnBlock();
      const iframe = frame();
      await useStudioImage();
      const [insert] = editor.sentMessages("insert-media");
      await editor.reply("insert-media-result", { requestId: insert!.id, ok: true });
      expect(frame()).toBe(iframe);
      expect(editor.sent("load-draft")).toHaveLength(1);
      expect(mediaPanel().querySelector('[role="status"]')!.textContent).toBe("Put in Hero banner. The image shows after you save the page in the editor.");
      expect(document.body.querySelector('[data-testid="website-save-banner"]')!.textContent).toContain("Unsaved changes");
    });

    it("ok:false reply: says why in plain words and keeps the media entry", async () => {
      const editor = await openEditorOnBlock();
      await useStudioImage();
      const [insert] = editor.sentMessages("insert-media");
      await editor.reply("insert-media-result", { requestId: insert!.id, ok: false, code: "field_not_media" });
      expect(mediaPanel().querySelector('[role="alert"]')!.textContent).toBe(
        "Hero banner has no image or video field, so nothing changed. The image is saved in Website media. Pick it from an image field in the editor.",
      );
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
      expect(mediaPanel().querySelector('[role="alert"]')!.textContent).toBe(
        "The site's editor did not answer, so the editor was reloaded. The image is saved in Website media. Pick it from the block's image field.",
      );
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
      await act(async () => labelled("Media").click());
      await flush();
      await act(async () => document.body.querySelector<HTMLButtonElement>('[data-testid="website-add-image"]')!.click());
      await flush();
      await act(async () => [...document.body.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) => tab.textContent === "Website media")!.click());
      await flush();
      await act(async () => document.body.querySelector<HTMLButtonElement>('[data-testid="media-picker-entry"]')!.click());
      await act(async () => document.body.querySelector<HTMLButtonElement>('[data-testid="media-use"]')!.click());
      await flush();
      expect(api.createEntry).not.toHaveBeenCalled();
      expect(editor.sentMessages("insert-media")[0]!.payload).toMatchObject({
        blockId: "h1",
        mediaEntryId: "asset-1",
        alt: "Team",
        media: { blob: expect.any(Blob), alt: "Team", width: 4, height: 3 },
      });
    });

    it("sends the picked asset's blob from its content path, and still sends insert-media when that fetch fails (GRE-2226)", async () => {
      const editor = await openEditorOnBlock();
      vi.mocked(fetch).mockClear();
      vi.mocked(fetch).mockRejectedValueOnce(new Error("offline"));
      await useStudioImage();
      expect(fetch).toHaveBeenCalledWith("/api/assets/asset-7/content", { credentials: "include" });
      const [insert] = editor.sentMessages("insert-media");
      expect(insert!.payload).toMatchObject({ blockId: "h1", mediaEntryId: "asset-7", assetUrl: "/api/assets/asset-7/content" });
      expect(insert!.payload).not.toHaveProperty("media");
    });
  });

  describe("motion in the selected block (GRE-2219)", () => {
    const motionAck = {
      blocks: [{ type: "Hero", label: "Hero", motion: { effects: ["none", "hero.stone", "bg.ascent"], default: { effect: "none", intensity: "off" } } }],
      motionEffects: [
        { id: "hero.stone", label: "Hero stone", still: "/motion/stone-still.png" },
        { id: "bg.ascent", label: "Ascent", still: "/motion/ascent-dark.webp", study: "016" },
      ],
    };
    const motionPanel = () => document.body.querySelector<HTMLElement>('[data-testid="website-motion"]')!;
    const effect = (id: string) => document.body.querySelector<HTMLButtonElement>(`[data-testid="website-motion-effect-${id}"]`)!;

    it("a GS Studio hand-off opens Motion with the study chosen, and Use in block sends set-motion", async () => {
      const editor = await openEditorOnBlock(motionAck, "/website/edit?motion=016");
      expect(motionPanel().textContent).toContain("From GS Studio: study 016, Ascent.");
      expect(effect("bg.ascent").getAttribute("aria-checked")).toBe("true");
      expect(effect("bg.ascent").querySelector("img")!.getAttribute("src")).toBe(`${EDITOR}/motion/ascent-dark.webp`);
      expect(effect("none").getAttribute("aria-checked")).toBe("false");

      await act(async () => button("Full").click());
      await act(async () => document.body.querySelector<HTMLButtonElement>('[data-testid="website-motion-apply"]')!.click());
      await flush();
      const [request] = editor.sentMessages("set-motion");
      expect(request!.payload).toEqual({ blockId: "h1", motion: { effect: "bg.ascent", intensity: "full" } });

      await editor.reply("set-motion-result", { requestId: request!.id, ok: true });
      expect(motionPanel().querySelector('[role="status"]')!.textContent).toBe(
        "Ascent, Full, is in Hero banner. Save the page in the editor to keep it.",
      );
      expect(document.body.querySelector('[data-testid="website-save-banner"]')!.textContent).toContain("Unsaved changes");
      expect(button("In the block").disabled).toBe(true);
    });

    it("a refusal says why in plain words", async () => {
      const editor = await openEditorOnBlock(motionAck);
      await act(async () => labelled("Motion").click());
      await act(async () => effect("hero.stone").click());
      await act(async () => button("Use in block").click());
      await flush();
      const [request] = editor.sentMessages("set-motion");
      await editor.reply("set-motion-result", { requestId: request!.id, ok: false, code: "effect_not_allowed" });
      expect(motionPanel().querySelector('[role="alert"]')!.textContent).toBe(
        "Hero banner does not take Hero stone, so nothing changed. Pick another effect.",
      );
    });

    it("an engine with no motion choices, or no selected block, says what to do and sends nothing", async () => {
      const editor = await openEditorOnBlock();
      await act(async () => labelled("Motion").click());
      expect(motionPanel().textContent).toContain("does not offer motion choices yet");
      expect(motionPanel().querySelector('[role="radiogroup"]')).toBeNull();
      expect(editor.sentMessages("set-motion")).toHaveLength(0);

      act(() => root.unmount());
      root = createRoot(container);
      await render("/website/edit?motion=016");
      expect(motionPanel().textContent).toContain("Pick a block first");
    });
  });

  it("does not open an editor until the editor address is set", async () => {
    api.sites.mockResolvedValue([{ ...site, editorFrameOrigin: null }]);
    await render();
    expect(text()).toContain("Set the editor address");
    expect(frame()).toBeNull();
  });
});

describe("full-screen editor (GRE-2296)", () => {
  const fullAck = { editorCommands: ["undo", "redo", "save", "add-block", "deselect", "outline"] };
  const selected = { blockId: "h1", blockType: "Hero", label: "Hero banner" };

  it("covers the viewport with one top bar and the frame, and no page list or Website tabs", async () => {
    await render();
    expect(screen()!.parentElement).toBe(document.body);
    expect(screen()!.className).toContain("fixed inset-0");
    expect(container.textContent).toBe("");
    expect(document.body.querySelector('[data-testid="website-editor-topbar"]')).not.toBeNull();
    expect(document.body.querySelector('nav[aria-label="Pages"]')).toBeNull();
    expect(frame()!.getAttribute("src")).toBe(`${EDITOR}/editor/page-1`);
    // Laptop fills the canvas when editing; no drawer until something asks for one.
    expect(frame()!.style.width).toBe("");
    expect(drawer()).toBeNull();
  });

  it("the page picker searches the site's pages and opens another one", async () => {
    // cmdk measures its list.
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    Element.prototype.scrollIntoView ??= () => {};
    api.pages.mockResolvedValue([page, about]);
    await render("/website/edit?page=page-1");
    await act(async () => document.body.querySelector<HTMLButtonElement>('[data-testid="website-page-picker"]')!.click());
    await flush();
    const option = [...document.body.querySelectorAll<HTMLElement>('[cmdk-item]')].find((item) => item.textContent?.includes("About"))!;
    expect(option.textContent).toContain("/about");
    await act(async () => option.click());
    await flush();
    expect(frame()!.getAttribute("src")).toBe(`${EDITOR}/editor/page-2`);
  });

  it("the top bar names the page without the home page's '/', and shows which panel is open", async () => {
    await render();
    await connect(fullAck);
    expect(document.body.querySelector('[data-testid="website-page-picker"]')!.textContent).toBe("Home");
    expect(document.body.querySelector('[data-testid="website-save-state"]')!.textContent).toBe("Draft");
    await act(async () => labelled("Media").click());
    expect(labelled("Media").getAttribute("aria-pressed")).toBe("true");
    expect(labelled("History").getAttribute("aria-pressed")).toBe("false");
  });

  it("Esc closes the drawer, then clears the selected block, then leaves", async () => {
    await render();
    const editor = await connect(fullAck);
    await editor.reply("editor-state", { selection: selected, canUndo: false, canRedo: false });
    await act(async () => labelled("History").click());
    expect(drawer()).not.toBeNull();

    await key({ key: "Escape" });
    expect(drawer()).toBeNull();
    expect(onLeave).not.toHaveBeenCalled();

    await key({ key: "Escape" });
    expect(editor.sent("editor-command").at(-1)!.payload).toEqual({ command: "deselect" });
    expect(onLeave).not.toHaveBeenCalled();

    await editor.reply("editor-state", { selection: null, canUndo: false, canRedo: false });
    await key({ key: "Escape" });
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it("Esc pressed inside the frame (editor-key) and the Back button leave", async () => {
    await render();
    const editor = await connect(fullAck);
    await editor.reply("editor-key", { key: "escape" });
    expect(onLeave).toHaveBeenCalledTimes(1);
    await act(async () => labelled("Back to Website").click());
    await flush();
    expect(onLeave).toHaveBeenCalledTimes(2);
  });

  it("leaving with unsaved changes asks first", async () => {
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await render();
    const editor = await connect(fullAck);
    await editor.reply("dirty", { dirty: true });
    await act(async () => labelled("Back to Website").click());
    await flush();
    expect(window.confirm).toHaveBeenCalled();
    expect(onLeave).not.toHaveBeenCalled();
  });

  it("Cmd+S saves through the editor, and Cmd+Z / Cmd+Shift+Z undo and redo", async () => {
    await render();
    const editor = await connect(fullAck);
    await editor.reply("editor-state", { selection: null, canUndo: true, canRedo: true });
    await key({ key: "s", metaKey: true });
    await key({ key: "z", metaKey: true });
    await key({ key: "z", metaKey: true, shiftKey: true });
    expect(editor.sent("editor-command").map((message) => message.payload.command)).toEqual(["save", "undo", "redo"]);
    expect(labelled("Undo").disabled).toBe(false);
    await act(async () => labelled("Redo").click());
    expect(editor.sent("editor-command").at(-1)!.payload).toEqual({ command: "redo" });
  });

  it("an engine without editor commands: undo stays off and Cmd+S says to use the editor's Save", async () => {
    await render();
    const editor = await connect();
    await key({ key: "s", ctrlKey: true });
    expect(editor.sent("editor-command")).toHaveLength(0);
    expect(text()).toContain("saves from its own Save button");
    expect(labelled("Undo").disabled).toBe(true);
  });

  it("the save path: the frame's save goes through GSAM's API and the top bar says Saved", async () => {
    api.savePageContent.mockResolvedValueOnce({ state: "saved", revisionId: "rev-3", revisionNumber: 3 });
    await render();
    const editor = await connect(fullAck);
    await key({ key: "s", metaKey: true });
    await editor.save("req-1");
    expect(api.savePageContent).toHaveBeenCalledWith("co-1", "site-1", "page-1", { baseRevisionId: "rev-2", content: data, editorOrigin: EDITOR });
    expect(editor.sent("save-result")[0]!.payload).toMatchObject({ outcome: "saved", revisionId: "rev-3" });
    expect(document.body.querySelector('[data-testid="website-save-state"]')!.textContent).toMatch(/^Saved /);
  });

  it("clicking an image on the page opens Media for that block and field, and the pick goes into it", async () => {
    await render();
    const editor = await connect(fullAck);
    await editor.reply("media-requested", { blockId: "h1", field: "backgroundImage", kind: "image", label: "Hero banner" });
    expect(drawer()!.getAttribute("aria-label")).toBe("Media");
    expect(document.body.querySelector('[data-testid="media-picker-item"]')).not.toBeNull();
    await act(async () => document.body.querySelector<HTMLButtonElement>('[data-testid="media-picker-item"]')!.click());
    await flush();
    const input = document.body.querySelector<HTMLInputElement>('[data-testid="media-alt"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Boats");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => document.body.querySelector<HTMLButtonElement>('[data-testid="media-use"]')!.click());
    await flush();
    expect(editor.sentMessages("insert-media")[0]!.payload).toMatchObject({ blockId: "h1", field: "backgroundImage", mediaEntryId: "asset-7" });
  });

  it("Request publish asks a person with Publish rights; it never publishes, and needs the page saved first", async () => {
    api.submitPage.mockResolvedValue({ ...page, status: "review" });
    await render();
    const editor = await connect(fullAck);
    await editor.reply("dirty", { dirty: true });
    await act(async () => document.body.querySelector<HTMLButtonElement>('[data-testid="website-request-publish"]')!.click());
    await flush();
    expect(api.submitPage).not.toHaveBeenCalled();
    expect(text()).toContain("Save the page first");

    await editor.reply("dirty", { dirty: false });
    await act(async () => document.body.querySelector<HTMLButtonElement>('[data-testid="website-request-publish"]')!.click());
    await flush();
    expect(api.submitPage).toHaveBeenCalledWith("co-1", "site-1", "page-1");
    expect(text()).toContain("Home is waiting for approval");
  });

  it("Add block and Outline drive the editor's own drawer and outline", async () => {
    await render();
    const editor = await connect(fullAck);
    await act(async () => labelled("Add block").click());
    await act(async () => labelled("Outline").click());
    expect(editor.sent("editor-command").map((message) => message.payload)).toEqual([{ command: "add-block" }, { command: "outline", on: true }]);
  });
});

describe("WebsitePagesTab (GRE-2296)", () => {
  function Where() {
    const location = useLocation();
    return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
  }
  async function renderTab(entry = "/website?tab=editor") {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={[entry]}>
            <Routes>
              <Route path="/website" element={<WebsitePagesTab companyId="co-1" property={property} onOpenTab={vi.fn()} />} />
              <Route path="/website/edit" element={<Where />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await flush();
  }
  const where = () => container.querySelector('[data-testid="where"]')?.textContent;

  it("lists the pages, and Edit opens the full-screen editor on that page", async () => {
    api.pages.mockResolvedValue([page, about]);
    await renderTab();
    expect(frame()).toBeNull();
    expect(container.textContent).toContain("About");
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Edit About"]')!.click());
    await flush();
    expect(where()).toBe("/website/edit?property=prop-1&page=page-2");
  });

  it("the old in-page editor links open the full-screen editor", async () => {
    await renderTab("/website?tab=editor&motion=016");
    expect(where()).toBe("/website/edit?property=prop-1&motion=016");
  });
});
