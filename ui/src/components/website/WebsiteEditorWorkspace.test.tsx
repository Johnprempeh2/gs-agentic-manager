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
  pageComments: vi.fn(),
  createEntry: vi.fn(),
  submitPage: vi.fn(),
  images: vi.fn(),
}));
const issues = vi.hoisted(() => ({ listComments: vi.fn(), addComment: vi.fn(), update: vi.fn(), uploadAttachment: vi.fn() }));
vi.mock("../../api/images", () => ({ imagesApi: { list: api.images } }));
vi.mock("../../api/issues", () => ({ issuesApi: issues }));
vi.mock("../MarkdownBody", () => ({ MarkdownBody: ({ children }: { children: string }) => <div>{children}</div> }));
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
  api.pageComments.mockResolvedValue([]);
  issues.listComments.mockResolvedValue([]);
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
    payload: { protocol: 1, nonce, siteId: "site-1", engine: { version: "1.0.0", commit: "b".repeat(40) }, supportedReleaseSchemas: [1], siteContract: 1, blocks: [{ type: "Hero", label: "Hero" }], editorContract: 1, ...ackExtra },
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

  it("Ask an agent offers the effects library the site's editor sent (GRE-2527)", async () => {
    await render();
    await openPreview();
    const { pickBlock } = await connect({ motionEffects: [{ id: "bg.ascent", label: "Ascent", still: "/motion/ascent.webp" }] });
    await pickBlock();
    await act(async () => button("Effect").click());
    await flush();
    const choice = document.body.querySelector<HTMLButtonElement>('[data-testid="website-change-effects"] button')!;
    expect(choice.textContent).toBe("Ascent");
    await act(async () => choice.click());
    await flush();
    expect(panel()!.querySelector('[data-testid="website-change-attachment"]')!.textContent).toBe("Effect · Ascent");
  });

  it("click to change: pick, describe, Send creates exactly one task with the durable reference", async () => {
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
    expect(button("Send").disabled).toBe(true);
    expect(textarea().placeholder).toBe("Describe or draw what you want changed");

    await type("Make the heading shorter.");
    expect(api.requestChange).not.toHaveBeenCalled();
    await act(async () => button("Send").click());
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
      width: "laptop",
      request: "Make the heading shorter.",
    });
    expect(panel()!.dataset.step).toBe("created");
    expect(document.body.querySelector<HTMLAnchorElement>('[data-testid="website-change-request"] a')!.getAttribute("href")).toBe("/issues/GRE-9001");
    expect(text()).toContain("is with the website agent");
  });

  it("click to change: Cancel creates nothing and clears the highlight", async () => {
    await render();
    await openPreview();
    const { pickBlock, sent } = await connect();
    await pickBlock();
    await act(async () => button("Cancel").click());
    expect(panel()).toBeNull();
    expect(sent("highlight").at(-1)!.payload).toEqual({ blockId: null });

    await pickBlock();
    await type("Change the photo.");
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

  describe("Ask an agent and comments (GRE-2350)", () => {
    const created = { issueId: "issue-7", identifier: "GRE-9007", title: "Website change", assigneeAgentId: "lintel", projectId: "proj-1" };

    async function askAndCreate(words: string) {
      await act(async () => labelled("Ask an agent").click());
      await flush();
      await type(words);
      await act(async () => button("Send").click());
      await flush();
    }

    it("with nothing selected, the comment is about the whole page at the current width", async () => {
      api.requestChange.mockResolvedValue(created);
      await render();
      await connect();
      await act(async () => labelled("Ask an agent").click());
      await flush();
      expect(panel()!.textContent).toContain("Whole page");
      expect(panel()!.textContent).toContain("The whole page on Home");
      expect(panel()!.textContent).toContain("Seen at Laptop width");
      expect(panel()!.textContent).not.toContain("Edit words or image myself");

      await askAndCreate("The page feels too long.");
      expect(api.requestChange).toHaveBeenCalledTimes(1);
      const [, , pageId, input] = api.requestChange.mock.calls[0]!;
      expect(pageId).toBe("page-1");
      expect(input).toEqual({ requestId: expect.stringMatching(/^[0-9a-f-]{36}$/), pageRevisionId: "rev-2", width: "laptop", request: "The page feels too long." });
      expect(panel()!.dataset.step).toBe("created");
      // The new comment shows in the list without a reload.
      expect(api.pageComments.mock.calls.length).toBeGreaterThan(1);
    });

    it("with a block selected in the editor, the comment is about that block", async () => {
      api.requestChange.mockResolvedValue(created);
      await render();
      const editor = await connect();
      await editor.reply("editor-state", { selection: { blockId: "h1", blockType: "Hero", label: "Hero banner" }, canUndo: false, canRedo: false });
      await act(async () => labelled("Ask an agent").click());
      await flush();
      expect(panel()!.textContent).toContain("Selected block");
      expect(panel()!.textContent).toContain("Hero banner on Home");

      await askAndCreate("Use the new tagline.");
      const [, , , input] = api.requestChange.mock.calls[0]!;
      expect(input).toEqual({
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        pageRevisionId: "rev-2",
        blockId: "h1",
        blockType: "Hero",
        blockLabel: "Hero banner",
        width: "laptop",
        request: "Use the new tagline.",
      });
    });

    it("lists open comments numbered; a thread shows replies, the agent's draft and resolves", async () => {
      api.pageComments.mockResolvedValue([
        { number: 1, issueId: "issue-1", identifier: "GRE-1", title: "t", status: "todo", request: "Shorter heading", blockId: "h1", blockType: "Hero", blockLabel: "Hero banner", pageRevisionId: "rev-2", width: "phone", assigneeAgentId: "lintel", createdAt: "2026-10-23T09:30:00.000Z", updatedAt: "2026-10-23T09:30:00.000Z" },
        { number: 2, issueId: "issue-2", identifier: "GRE-2", title: "t", status: "todo", request: "Warmer colours", blockId: null, blockType: null, blockLabel: null, pageRevisionId: "rev-2", width: null, assigneeAgentId: "lintel", createdAt: "2026-10-23T09:40:00.000Z", updatedAt: "2026-10-23T09:40:00.000Z" },
      ]);
      api.revisions.mockResolvedValue([
        { id: "rev-3", revisionNumber: 3, changeSummary: "Shortened the heading", createdByAgentId: "lintel", createdByUserId: null, createdAt: "2026-10-23T11:00:00.000Z" },
        ...revisions,
      ]);
      issues.listComments.mockResolvedValue([
        { id: "c1", issueId: "issue-1", authorAgentId: "lintel", authorUserId: null, body: "Done: the heading is now one line.", createdAt: "2026-10-23T11:01:00.000Z" },
      ]);
      issues.update.mockResolvedValue({ id: "issue-1", status: "done" });
      await render();
      await connect();
      expect(document.body.querySelector('[data-testid="website-comments-count"]')!.textContent).toBe("2");

      await act(async () => labelled("Comments").click());
      await flush();
      const items = [...document.body.querySelectorAll<HTMLButtonElement>('[data-testid="website-comment-item"]')];
      expect(items.map((item) => item.textContent)).toEqual([
        expect.stringMatching(/^1Shorter headingHero banner · GRE-1/),
        expect.stringMatching(/^2Warmer coloursWhole page · GRE-2/),
      ]);

      await act(async () => items[0]!.click());
      await flush();
      const thread = document.body.querySelector<HTMLElement>('[data-testid="website-comment-thread"]')!;
      expect(thread.querySelector('[data-testid="website-comment-request"]')!.textContent).toBe("Shorter heading");
      expect(thread.textContent).toContain("seen at Phone width");
      expect(thread.textContent).toContain("Done: the heading is now one line.");
      expect(thread.querySelector('[data-testid="website-comment-change"]')!.textContent).toContain("The agent saved draft 3");
      expect(issues.listComments).toHaveBeenCalledWith("issue-1", { order: "asc" });

      // Preview the change shows the latest draft in the preview.
      await act(async () => button("Preview the change").click());
      await flush();
      expect(frame()!.getAttribute("src")).toBe(`${EDITOR}/preview/page-1`);

      api.pageComments.mockResolvedValue([]);
      await act(async () => button("Mark resolved").click());
      await flush();
      expect(issues.update).toHaveBeenCalledWith("issue-1", { status: "done", comment: "Marked resolved in the website editor." });
      expect(document.body.querySelector('[data-testid="website-comment-thread"]')).toBeNull();
      expect(document.body.textContent).toContain("No open comments");
      expect(document.body.querySelector('[data-testid="website-comments-count"]')).toBeNull();
    });

    describe("pins, block toolbar and screenshot (GRE-2361)", () => {
      const COMMENT_MESSAGES = { editorMessages: ["comment-pins", "pin-clicked", "ask-agent", "capture"] };
      const PNG = "data:image/png;base64,iVBORw0KGgo=";
      const comments = [
        { number: 1, issueId: "issue-1", identifier: "GRE-1", title: "t", status: "todo", request: "Shorter heading", blockId: "h1", blockType: "Hero", blockLabel: "Hero banner", pageRevisionId: "rev-2", width: "laptop", assigneeAgentId: "lintel", createdAt: "2026-10-23T09:30:00.000Z", updatedAt: "2026-10-23T09:30:00.000Z" },
        { number: 2, issueId: "issue-2", identifier: "GRE-2", title: "t", status: "todo", request: "Warmer colours", blockId: null, blockType: null, blockLabel: null, pageRevisionId: "rev-2", width: null, assigneeAgentId: "lintel", createdAt: "2026-10-23T09:40:00.000Z", updatedAt: "2026-10-23T09:40:00.000Z" },
      ];

      it("sends a pin for each block comment after load-draft; a whole-page comment has none", async () => {
        api.pageComments.mockResolvedValue(comments);
        await render();
        const editor = await connect(COMMENT_MESSAGES);
        const types = editor.posted.mock.calls.map((call) => (call[0] as { type: string }).type);
        expect(types.indexOf("comment-pins")).toBeGreaterThan(types.indexOf("load-draft"));
        expect(editor.sent("comment-pins").map((message) => message.payload)).toEqual([{ pins: [{ blockId: "h1", number: 1 }] }]);
      });

      it("an older engine gets no pins", async () => {
        api.pageComments.mockResolvedValue(comments);
        await render();
        const editor = await connect();
        expect(editor.sent("comment-pins")).toHaveLength(0);
      });

      it("a click on a pin opens that comment's thread in the Comments drawer", async () => {
        api.pageComments.mockResolvedValue(comments);
        await render();
        const editor = await connect(COMMENT_MESSAGES);
        await editor.reply("pin-clicked", { blockId: "h1", number: 1 });
        expect(drawer()!.textContent).toContain("Comments");
        const thread = document.body.querySelector<HTMLElement>('[data-testid="website-comment-thread"]')!;
        expect(thread.querySelector('[data-testid="website-comment-request"]')!.textContent).toBe("Shorter heading");
      });

      it("Ask an agent in the frame's block toolbar opens the comment box for that block", async () => {
        api.requestChange.mockResolvedValue(created);
        await render();
        const editor = await connect(COMMENT_MESSAGES);
        await editor.reply("ask-agent", { blockId: "h1", blockType: "Hero", label: "Hero banner" });
        expect(panel()!.textContent).toContain("Selected block");
        expect(panel()!.textContent).toContain("Hero banner on Home");
      });

      it("a task with a screenshot: the editor's PNG is attached to the task", async () => {
        api.requestChange.mockResolvedValue(created);
        issues.uploadAttachment.mockResolvedValue({ id: "att-1" });
        await render();
        const editor = await connect(COMMENT_MESSAGES);
        await editor.reply("editor-state", { selection: { blockId: "h1", blockType: "Hero", label: "Hero banner" }, canUndo: false, canRedo: false });
        await askAndCreate("Use the new tagline.");
        const [capture] = editor.sentMessages("capture");
        expect(capture!.payload).toEqual({ blockId: "h1" });
        expect(api.requestChange).not.toHaveBeenCalled();
        await editor.reply("capture-result", { requestId: capture!.id, ok: true, png: PNG, width: 1440 });

        const [, , , input] = api.requestChange.mock.calls[0]!;
        expect(input).toMatchObject({ blockId: "h1", screenshot: true });
        expect(issues.uploadAttachment).toHaveBeenCalledTimes(1);
        const [companyId, issueId, file] = issues.uploadAttachment.mock.calls[0]!;
        expect([companyId, issueId]).toEqual(["co-1", "issue-7"]);
        expect((file as File).name).toBe("website-h1.png");
        expect((file as File).type).toBe("image/png");
        expect(panel()!.querySelector('[data-testid="website-change-screenshot"]')!.textContent).toContain("A screenshot of the block is attached");
      });

      it("the editor refuses the capture: the task has no screenshot", async () => {
        api.requestChange.mockResolvedValue(created);
        await render();
        const editor = await connect(COMMENT_MESSAGES);
        await askAndCreate("The page feels too long.");
        const [capture] = editor.sentMessages("capture");
        expect(capture!.payload).toEqual({ blockId: null });
        await editor.reply("capture-result", { requestId: capture!.id, ok: false, message: "Could not draw it." });
        expect(api.requestChange.mock.calls[0]![3]).not.toHaveProperty("screenshot");
        expect(issues.uploadAttachment).not.toHaveBeenCalled();
      });

      it("the upload fails: the task gets a comment that no screenshot is attached, and the panel says so", async () => {
        api.requestChange.mockResolvedValue(created);
        issues.uploadAttachment.mockRejectedValue(new Error("Too large"));
        issues.addComment.mockResolvedValue({ id: "c9" });
        await render();
        const editor = await connect(COMMENT_MESSAGES);
        await askAndCreate("The page feels too long.");
        const [capture] = editor.sentMessages("capture");
        await editor.reply("capture-result", { requestId: capture!.id, ok: true, png: PNG, width: 1440 });
        expect(issues.addComment).toHaveBeenCalledWith("issue-7", expect.stringContaining("No screenshot is attached to this task."));
        expect(panel()!.dataset.step).toBe("created");
        expect(panel()!.querySelector('[data-testid="website-change-screenshot"]')!.textContent).toContain("did not upload");
      });
    });

    describe("draw on the page (GRE-2518)", () => {
      const COMMENT_MESSAGES = { editorMessages: ["comment-pins", "pin-clicked", "ask-agent", "capture"] };
      /** A PNG header the size of a 1440 x 900 screenshot: enough for the drawing to read its size. */
      const PNG_1440 = (() => {
        const bytes = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, ..."IHDR".split("").map((c) => c.charCodeAt(0)), 0, 0, 5, 160, 0, 0, 3, 132, 8, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        return `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`;
      })();
      const originals = {
        src: Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src")!,
        getContext: HTMLCanvasElement.prototype.getContext,
        toBlob: HTMLCanvasElement.prototype.toBlob,
      };

      beforeEach(() => {
        // jsdom loads no images and has no 2D canvas: load at once and record nothing.
        Object.defineProperty(HTMLImageElement.prototype, "src", {
          configurable: true,
          set(this: HTMLImageElement) {
            setTimeout(() => this.onload?.(new Event("load")));
          },
        });
        const ctx = new Proxy({}, { get: (_target, prop) => (prop === "measureText" ? () => ({ width: 40 }) : () => undefined), set: () => true });
        HTMLCanvasElement.prototype.getContext = (() => ctx) as unknown as typeof HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.toBlob = function (done: BlobCallback) {
          done(new Blob(["png"], { type: "image/png" }));
        };
      });

      afterEach(() => {
        Object.defineProperty(HTMLImageElement.prototype, "src", originals.src);
        HTMLCanvasElement.prototype.getContext = originals.getContext;
        HTMLCanvasElement.prototype.toBlob = originals.toBlob;
      });

      const layer = () => document.body.querySelector<HTMLElement>('[data-testid="website-markup-layer"]');
      const canvas = () => document.body.querySelector<SVGSVGElement>('[data-testid="website-markup-canvas"]')!;
      async function tapCanvas(x: number, y: number) {
        canvas().getBoundingClientRect = () => ({ left: 0, top: 0, width: 720, height: 450, right: 720, bottom: 450, x: 0, y: 0, toJSON: () => ({}) });
        await act(async () => {
          canvas().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y, pointerId: 1 }));
        });
      }

      async function openOnBlock() {
        await render();
        const editor = await connect(COMMENT_MESSAGES);
        await editor.reply("ask-agent", { blockId: "h1", blockType: "Hero", label: "Hero banner" });
        const [capture] = editor.sentMessages("capture");
        expect(capture!.payload).toEqual({ blockId: "h1" });
        return { editor, capture: capture! };
      }

      it("the screenshot is taken as the box opens and the drawing layer covers the page, in Edit copy", async () => {
        const { editor, capture } = await openOnBlock();
        expect(panel()!.querySelector('[data-testid="website-change-drawing"]')!.getAttribute("data-state")).toBe("pending");
        expect(layer()).toBeNull();

        await editor.reply("capture-result", { requestId: capture.id, ok: true, png: PNG_1440, width: 1440 });
        const host = document.body.querySelector('[data-testid="website-markup-host"]')!;
        expect(host.contains(layer())).toBe(true);
        expect(layer()!.querySelector("img")!.getAttribute("src")).toBe(PNG_1440);
        expect(canvas().getAttribute("viewBox")).toBe("0 0 1440 900");

        await act(async () => button("Done").click());
        expect(layer()).toBeNull();
        await act(async () => button("Draw on the page").click());
        expect(layer()).not.toBeNull();
      });

      it("a marker and a label, then Cmd+Enter: one task with the words, the drawing and three files", async () => {
        api.requestChange.mockResolvedValue(created);
        issues.uploadAttachment.mockResolvedValue({ id: "att-1" });
        const { editor, capture } = await openOnBlock();
        await editor.reply("capture-result", { requestId: capture.id, ok: true, png: PNG_1440, width: 1440 });

        await act(async () => labelled("Numbered marker").click());
        await tapCanvas(360, 225);
        await act(async () => labelled("Text label").click());
        await tapCanvas(100, 50);
        const input = document.body.querySelector<HTMLInputElement>('input[aria-label="Label text"]')!;
        await act(async () => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Make this bigger");
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
        expect(canvas().querySelectorAll("[data-mark]")).toHaveLength(2);

        await type("Use the new tagline.");
        await key({ key: "Enter", metaKey: true }, textarea());
        await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
        await flush();

        expect(api.requestChange).toHaveBeenCalledTimes(1);
        expect(api.requestChange.mock.calls[0]![3]).toMatchObject({
          blockId: "h1",
          request: "Use the new tagline.",
          screenshot: true,
          markup: { marks: 2, markers: 1, labels: ["Make this bigger"] },
        });
        const files = issues.uploadAttachment.mock.calls.map((call) => call[2] as File);
        expect(files.map((file) => file.name)).toEqual(["website-h1.png", "website-h1-markup.png", "website-h1-markup.json"]);
        const doc = JSON.parse(await files[2]!.text());
        expect(doc).toMatchObject({ version: 1, width: 1440, height: 900, device: "laptop" });
        expect(doc.shapes).toEqual([
          { kind: "marker", color: "red", x: 720, y: 450, n: 1 },
          { kind: "text", color: "red", x: 200, y: 100, text: "Make this bigger" },
        ]);
        expect(panel()!.dataset.step).toBe("created");
        expect(panel()!.querySelector('[data-testid="website-change-screenshot"]')!.textContent).toContain("your drawing are attached");
        expect(layer()).toBeNull();
      });
    });
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
      expect(mediaPanel().querySelector('[role="status"]')!.textContent).toBe("Put in Hero banner. Save the page to keep it.");
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
      expect(button("Use in block").disabled).toBe(true);
      expect(motionPanel().querySelector('[data-testid="website-motion-current"]')!.textContent).toBe("This is the block's background now.");
    });

    it("a refusal says why in plain words", async () => {
      const editor = await openEditorOnBlock(motionAck);
      await act(async () => labelled("Background").click());
      await act(async () => effect("hero.stone").click());
      await act(async () => button("Use in block").click());
      await flush();
      const [request] = editor.sentMessages("set-motion");
      await editor.reply("set-motion-result", { requestId: request!.id, ok: false, code: "effect_not_allowed" });
      expect(motionPanel().querySelector('[role="alert"]')!.textContent).toBe(
        "Hero banner does not take Hero stone, so nothing changed. Pick another background.",
      );
    });

    const libraryAck = {
      blocks: [{ type: "Hero", label: "Hero", motion: { effects: ["none", "bg.veil"], default: { effect: "none", intensity: "off" } } }],
      motionEffects: [
        {
          id: "bg.veil",
          label: "Veil",
          still: "/motion/veil-dark.webp",
          study: "019",
          preview: "/effect-preview/bg.veil",
          description: "A soft emerald atmosphere.",
          settings: {
            intensity: ["off", "subtle", "full"],
            speed: ["still", "slow", "normal"],
            colour: ["emerald", "teal"],
            defaults: { intensity: "subtle", speed: "slow", colour: "emerald" },
          },
        },
      ],
      backgroundSurfaces: [
        { id: "none", label: "None" },
        { id: "panel", label: "Panel" },
      ],
    };

    it("offers None, the site surfaces and the effect library, with a live preview and safe settings (GRE-2526)", async () => {
      const editor = await openEditorOnBlock(libraryAck);
      await act(async () => labelled("Background").click());
      expect(effect("bg.veil").textContent).toContain("A soft emerald atmosphere.");
      await act(async () => effect("bg.veil").click());
      const preview = document.body.querySelector<HTMLIFrameElement>('[data-testid="website-motion-preview"]')!;
      expect(preview.getAttribute("src")).toBe(`${EDITOR}/effect-preview/bg.veil`);
      expect(preview.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
      // The library id is for agents: the settings card shows the name and description only.
      expect(document.body.querySelector('[data-testid="website-motion-settings"]')!.textContent).not.toContain("bg.veil");
      await act(async () => button("Normal").click());
      await act(async () => button("Teal").click());
      await act(async () => button("Use in block").click());
      await flush();
      const [request] = editor.sentMessages("set-motion");
      expect(request!.payload).toEqual({ blockId: "h1", motion: { effect: "bg.veil", intensity: "subtle", speed: "normal", colour: "teal" } });
      await editor.reply("set-motion-result", { requestId: request!.id, ok: true });
      expect(motionPanel().querySelector('[role="status"]')!.textContent).toBe(
        "Veil, Subtle, normal, teal, is in Hero banner. Save the page in the editor to keep it.",
      );

      await act(async () => document.body.querySelector<HTMLButtonElement>('[data-testid="website-motion-surface-panel"]')!.click());
      await act(async () => button("Use in block").click());
      await flush();
      expect(editor.sentMessages("set-motion")[1]!.payload).toEqual({ blockId: "h1", motion: { effect: "none", intensity: "off" }, surface: "panel" });
    });

    it("on a phone, Use in block closes the sheet and brings the block into view (GRE-2526)", async () => {
      const matchMedia = window.matchMedia;
      window.matchMedia = ((query: string) =>
        ({ matches: query === "(width < 40rem)", media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList);
      try {
        const editor = await openEditorOnBlock(libraryAck);
        await act(async () => labelled("Background").click());
        await act(async () => effect("bg.veil").click());
        await act(async () => button("Use in block").click());
        await flush();
        const [request] = editor.sentMessages("set-motion");
        await editor.reply("set-motion-result", { requestId: request!.id, ok: true });
        expect(document.body.querySelector('[data-testid="website-editor-drawer"]')).toBeNull();
        expect(editor.sentMessages("highlight").at(-1)!.payload).toEqual({ blockId: "h1" });
        expect(document.body.querySelector('[data-testid="website-save-banner"]')!.textContent).toContain("Unsaved changes");

        // Reopened, the panel shows what was just put in, not the draft GSAM sent before it.
        await act(async () => labelled("Background").click());
        expect(effect("bg.veil").getAttribute("aria-checked")).toBe("true");
        expect(button("Use in block").disabled).toBe(true);
        expect(motionPanel().querySelector('[data-testid="website-motion-current"]')!.textContent).toBe("This is the block's background now.");
      } finally {
        window.matchMedia = matchMedia;
      }
    });

    it("Ask an agent carries the block id, the effect id and its settings (GRE-2526)", async () => {
      await openEditorOnBlock(libraryAck);
      await act(async () => labelled("Background").click());
      await act(async () => effect("bg.veil").click());
      await act(async () => document.body.querySelector<HTMLButtonElement>('[data-testid="website-motion-ask"]')!.click());
      await flush();
      expect(panel()).not.toBeNull();
      expect(textarea().value).toContain("block id `h1`");
      expect(textarea().value).toContain("Effect: `bg.veil` (Veil)");
      expect(textarea().value).toContain("Speed: `slow`");
    });

    it("the frozen Two Doors home page takes no Background change (GRE-2522)", async () => {
      const twoDoors = { root: { props: {} }, content: [{ type: "TwoDoors", props: { id: "t1" } }, ...data.content] };
      api.pageEditor.mockResolvedValue({ ...load, data: twoDoors });
      const editor = await openEditorOnBlock(libraryAck);
      await act(async () => labelled("Background").click());
      expect(document.body.querySelector('[data-testid="website-motion-frozen"]')!.textContent).toContain("frozen");
      expect(motionPanel().querySelector('[role="radiogroup"]')).toBeNull();
      expect(document.body.querySelector('[data-testid="website-motion-apply"]')).toBeNull();
      expect(editor.sentMessages("set-motion")).toHaveLength(0);
    });

    it("an engine with no motion choices, or no selected block, says what to do and sends nothing", async () => {
      const editor = await openEditorOnBlock();
      await act(async () => labelled("Background").click());
      expect(motionPanel().textContent).toContain("does not offer background choices yet");
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

  it("an engine that lists no editor commands: undo stays off and Cmd+S says to use the editor's Save", async () => {
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

  describe("editor host version check (GRE-2357)", () => {
    const canvas = () => document.body.querySelector<HTMLElement>('[data-testid="website-editor-canvas"]');
    const outOfDate = () => document.body.querySelector<HTMLElement>('[data-testid="website-editor-out-of-date"]');

    it("an old engine (no editor contract) gets 'Editor host is out of date', not the frame", async () => {
      await render();
      const editor = await connect({ editorContract: undefined });
      expect(outOfDate()!.textContent).toContain("Editor host is out of date");
      expect(outOfDate()!.textContent).toContain(`Redeploy the editor host (${EDITOR})`);
      expect(frame()).toBeNull();
      expect(editor.sent("load-draft")).toHaveLength(0);
      expect(document.body.querySelector('[data-testid="website-save-state"]')!.textContent).toBe("Not open");
    });

    it("a site with no GSAM and website contract gets 'Out of date: update the website', not the frame (GRE-2633)", async () => {
      await render();
      const editor = await connect({ siteContract: undefined });
      const message = document.body.querySelector<HTMLElement>('[data-testid="website-site-out-of-date"]');
      expect(message!.textContent).toContain("Out of date: update the website.");
      expect(message!.textContent).toContain("The website speaks contract none; GSAM needs 1 or later.");
      expect(frame()).toBeNull();
      expect(editor.sent("load-draft")).toHaveLength(0);
      expect(document.body.querySelector('[data-testid="website-save-state"]')!.textContent).toBe("Not open");
    });

    it("a silent engine gets 'Editor host is out of date' after the hello timeout, and Retry loads the frame again", async () => {
      await render();
      const iframe = frame()!;
      vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(() => {});
      vi.useFakeTimers();
      await act(async () => { iframe.dispatchEvent(new Event("load")); });
      expect(canvas()!.dataset.hidden).toBe("true");
      await act(async () => { vi.advanceTimersByTime(10_000); });
      vi.useRealTimers();
      await flush();
      expect(outOfDate()!.textContent).toContain("Editor host is out of date");
      expect(frame()).toBeNull();
      await act(async () => button("Retry").click());
      await flush();
      expect(outOfDate()).toBeNull();
      expect(frame()).not.toBeNull();
    });

    it("a current engine shows the canvas, hidden only until the handshake passes", async () => {
      await render();
      expect(canvas()!.dataset.hidden).toBe("true");
      const editor = await connect(fullAck);
      expect(outOfDate()).toBeNull();
      expect(canvas()!.dataset.hidden).toBeUndefined();
      expect(canvas()!.className).not.toContain("invisible");
      expect(editor.sent("load-draft")).toHaveLength(1);
    });

    it("website PR #98's engine (editor commands, no contract number) opens", async () => {
      await render();
      const editor = await connect({ editorContract: undefined, ...fullAck });
      expect(outOfDate()).toBeNull();
      expect(editor.sent("load-draft")).toHaveLength(1);
    });
  });

  it("Add block and Outline drive the editor's own drawer and outline", async () => {
    await render();
    const editor = await connect(fullAck);
    await act(async () => labelled("Add block").click());
    await act(async () => labelled("Outline").click());
    expect(editor.sent("editor-command").map((message) => message.payload)).toEqual([{ command: "add-block" }, { command: "outline", on: true }]);
  });
});

describe("Edit copy, Layout and empty pages (GRE-2394)", () => {
  const copyAck = { editorContract: 2, editorCommands: ["undo", "redo", "save", "add-block", "deselect", "outline", "layout", "import-live"] };
  const empty = { ...load, data: { root: { props: {} }, content: [] } };
  const modeToggle = () => document.body.querySelector<HTMLElement>('[data-testid="website-edit-mode"]');
  const modeButton = (label: string) => [...modeToggle()!.querySelectorAll("button")].find((el) => el.textContent?.includes(label))!;
  const notBuilt = () => document.body.querySelector<HTMLElement>('[data-testid="website-not-built"]');
  const importWarning = () => document.body.querySelector<HTMLElement>('[data-testid="website-import-warning"]');

  it("opens in Edit copy: no Add block, Outline, Media or Motion; Save, History and Preview stay", async () => {
    await render();
    const editor = await connect(copyAck);
    const hello = editor.posted.mock.calls[0]![0] as { payload: Record<string, unknown> };
    expect(hello.payload.editMode).toBe("copy");
    expect(modeButton("Edit copy").getAttribute("aria-pressed")).toBe("true");
    expect(modeButton("Layout").getAttribute("aria-pressed")).toBe("false");
    for (const name of ["Add block", "Outline", "Media", "Background"]) expect(labelled(name)).toBeNull();
    expect(labelled("History")).not.toBeNull();
    expect(button("Preview")).toBeDefined();
    // Save still goes to the editor.
    await key({ key: "s", metaKey: true });
    expect(editor.sent("editor-command").map((message) => message.payload)).toEqual([{ command: "save" }]);
    // Words saved in Edit copy go through GSAM as before.
    api.savePageContent.mockResolvedValue({ state: "saved", revisionId: "rev-3", revisionNumber: 3, savedAt: "2026-10-25T10:00:00.000Z" });
    await editor.save("11111111-1111-4111-8111-111111111111");
    expect(api.savePageContent).toHaveBeenCalledTimes(1);
  });

  it("Layout shows Add block, Outline, Media and Motion, and tells the editor; Edit copy hides them again", async () => {
    await render();
    const editor = await connect(copyAck);
    await act(async () => modeButton("Layout").click());
    await flush();
    expect(editor.sent("editor-command").at(-1)!.payload).toEqual({ command: "layout", on: true });
    for (const name of ["Add block", "Outline", "Media", "Background"]) expect(labelled(name)).not.toBeNull();
    await act(async () => labelled("Add block").click());
    expect(editor.sent("editor-command").at(-1)!.payload).toEqual({ command: "add-block" });
    await act(async () => labelled("Media").click());
    expect(drawer()).not.toBeNull();
    await act(async () => modeButton("Edit copy").click());
    await flush();
    expect(editor.sent("editor-command").at(-1)!.payload).toEqual({ command: "layout", on: false });
    expect(labelled("Add block")).toBeNull();
    // The Media drawer closes with it.
    expect(drawer()).toBeNull();
  });

  it("an editor host without Edit copy (contract 1) opens as today, in Layout, with no switch", async () => {
    await render();
    const editor = await connect({ editorCommands: ["undo", "redo", "save", "add-block", "deselect", "outline"] });
    expect(editor.sent("load-draft")).toHaveLength(1);
    expect(modeToggle()).toBeNull();
    expect(labelled("Add block")).not.toBeNull();
    expect(labelled("Media")).not.toBeNull();
  });

  it("an empty draft with nothing live shows Not built yet, never a blank canvas", async () => {
    api.pageEditor.mockResolvedValue(empty);
    await render();
    await connect({ ...copyAck, liveContent: null });
    expect(notBuilt()).not.toBeNull();
    expect(notBuilt()!.textContent).toContain("Not built yet");
    expect(notBuilt()!.textContent).toContain("Home");
    expect(notBuilt()!.textContent).toContain("/");
    // Says who acts, so nobody waits for work that is not running.
    expect(notBuilt()!.textContent).toContain("Ask an agent to build it, or switch to Layout to add blocks yourself.");
    expect(importWarning()).toBeNull();
    // Layout keeps the canvas to add blocks, with one line that says so.
    await act(async () => modeButton("Layout").click());
    await flush();
    expect(document.body.querySelector('[data-testid="website-empty-page"]')).toBeNull();
    expect(notBuilt()!.textContent).toContain("Use Add block");
  });

  it("a draft with content shows neither empty state", async () => {
    await render();
    await connect({ ...copyAck, liveContent: { blocks: 3 } });
    expect(notBuilt()).toBeNull();
    expect(importWarning()).toBeNull();
  });

  it("live content not in GSAM: Import it asks the editor to import, and its save fills the draft", async () => {
    api.pageEditor.mockResolvedValue(empty);
    api.savePageContent.mockResolvedValue({ state: "saved", revisionId: "rev-3", revisionNumber: 3, savedAt: "2026-10-25T10:00:00.000Z" });
    await render();
    const editor = await connect({ ...copyAck, liveContent: { blocks: 1 } });
    expect(importWarning()!.textContent).toContain("This page has live content that isn't in GSAM yet");
    expect(notBuilt()).toBeNull();
    await act(async () => button("Import it").click());
    await flush();
    expect(editor.sent("editor-command").at(-1)!.payload).toEqual({ command: "import-live" });
    expect(button("Importing").disabled).toBe(true);
    // The frame saves the imported page, block ids kept, through GSAM.
    await editor.save("22222222-2222-4222-8222-222222222222");
    expect(api.savePageContent).toHaveBeenCalledTimes(1);
    expect(api.savePageContent.mock.calls[0]![3]).toMatchObject({ content: data });
    expect(importWarning()).toBeNull();
    expect(text()).toContain("The live page is now in the draft. Nothing is published.");
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
