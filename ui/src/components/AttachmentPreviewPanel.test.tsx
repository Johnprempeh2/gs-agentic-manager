// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueAttachment } from "@greatstone/shared";
import { HTML_ATTACHMENT_SANDBOX_TOKENS } from "@greatstone/shared";
import { ThemeProvider } from "../context/ThemeContext";
import { AttachmentPreviewContext } from "../context/AttachmentPreviewContext";
import { MarkdownBody } from "./MarkdownBody";
import { useAttachmentPreview } from "./AttachmentPreviewPanel";

// The app's router wrapper adds company prefixes; plain router hooks stand in.
vi.mock("@/lib/router", async () => await import("react-router-dom"));

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

function makeAttachment(overrides: Partial<IssueAttachment>): IssueAttachment {
  return {
    id: "att-html",
    companyId: "company-1",
    issueId: "issue-1",
    issueCommentId: null,
    assetId: "asset-1",
    provider: "local_disk",
    objectKey: "key",
    contentType: "text/html",
    byteSize: 100,
    sha256: "sha",
    originalFilename: "mock-up.html",
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date("2026-10-08T00:00:00Z"),
    updatedAt: new Date("2026-10-08T00:00:00Z"),
    contentPath: "/api/attachments/att-html/content",
    ...overrides,
  };
}

const ATTACHMENTS = [
  makeAttachment({}),
  makeAttachment({
    id: "att-zip",
    contentType: "application/zip",
    originalFilename: "bundle.zip",
    contentPath: "/api/attachments/att-zip/content",
  }),
];

let navigateBack: (() => void) | null = null;
let currentPathState: unknown = null;

function Harness({ markdown }: { markdown: string }) {
  const { open, panel } = useAttachmentPreview(ATTACHMENTS);
  const location = useLocation();
  const navigate = useNavigate();
  navigateBack = () => navigate(-1);
  currentPathState = location.state;
  return (
    <AttachmentPreviewContext.Provider value={open}>
      <MarkdownBody>{markdown}</MarkdownBody>
      {panel}
    </AttachmentPreviewContext.Provider>
  );
}

const MARKDOWN = [
  "See [mock-up.html](/api/attachments/att-html/content)",
  "and [bundle.zip](/api/attachments/att-zip/content)",
  "and [docs](https://example.com/docs).",
].join(" ");

describe("attachment preview panel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <MemoryRouter initialEntries={["/", { pathname: "/GRE/issues/GRE-1", state: { issueDetailSource: "inbox" } }]}>
              <Harness markdown={MARKDOWN} />
            </MemoryRouter>
          </ThemeProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    navigateBack = null;
    currentPathState = null;
  });

  function link(text: string) {
    const anchor = Array.from(container.querySelectorAll("a")).find((a) => a.textContent?.includes(text));
    if (!anchor) throw new Error(`link ${text} not found`);
    return anchor;
  }

  function panel() {
    return document.querySelector<HTMLElement>("[data-testid='attachment-preview-panel']");
  }

  async function click(anchor: HTMLAnchorElement, init: MouseEventInit = {}) {
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
    await act(() => {
      anchor.dispatchEvent(event);
    });
    await flushReact();
    return event;
  }

  it("opens an HTML attachment in a sandboxed frame on a plain click", async () => {
    const event = await click(link("mock-up.html"));

    expect(event.defaultPrevented).toBe(true);
    const sheet = panel();
    expect(sheet).not.toBeNull();
    expect(sheet!.textContent).toContain("mock-up.html");
    const frame = sheet!.querySelector("iframe")!;
    expect(frame.getAttribute("src")).toBe("/api/attachments/att-html/content");
    expect(frame.getAttribute("sandbox")).toBe(HTML_ATTACHMENT_SANDBOX_TOKENS.join(" "));
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    const newTab = sheet!.querySelector<HTMLAnchorElement>("a[aria-label='Open in new tab']")!;
    expect(newTab.getAttribute("href")).toBe("/api/attachments/att-html/content");
    expect(newTab.getAttribute("target")).toBe("_blank");
    // Other page state survives alongside the preview.
    expect(currentPathState).toMatchObject({ issueDetailSource: "inbox" });
  });

  it("leaves Cmd/Ctrl-clicks and middle clicks to the browser", async () => {
    expect((await click(link("mock-up.html"), { metaKey: true })).defaultPrevented).toBe(false);
    expect((await click(link("mock-up.html"), { ctrlKey: true })).defaultPrevented).toBe(false);
    expect((await click(link("mock-up.html"), { button: 1 })).defaultPrevented).toBe(false);
    expect(panel()).toBeNull();
  });

  it("does not intercept files it cannot preview or non-attachment links", async () => {
    expect((await click(link("bundle.zip"))).defaultPrevented).toBe(false);
    expect((await click(link("docs"), {})).defaultPrevented).toBe(false);
    expect(panel()).toBeNull();
  });

  it("closes with the close button and returns to the issue's history entry", async () => {
    await click(link("mock-up.html"));
    const close = document.querySelector<HTMLButtonElement>("button[aria-label='Close preview']")!;
    await act(() => {
      close.click();
    });
    await vi.waitFor(() => expect(panel()).toBeNull());
    expect(currentPathState).toEqual({ issueDetailSource: "inbox" });
  });

  it("closes on Escape", async () => {
    await click(link("mock-up.html"));
    await act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    await vi.waitFor(() => expect(panel()).toBeNull());
  });

  it("closes on browser back", async () => {
    await click(link("mock-up.html"));
    expect(panel()).not.toBeNull();
    await act(() => {
      navigateBack!();
    });
    await vi.waitFor(() => expect(panel()).toBeNull());
    expect(currentPathState).toEqual({ issueDetailSource: "inbox" });
  });

  it("switches HTML previews between fit, laptop and phone widths", async () => {
    await click(link("mock-up.html"));
    const frame = () => panel()!.querySelector("iframe")!;
    expect(frame().dataset.viewport).toBe("fit");

    const phone = document.querySelector<HTMLButtonElement>("button[aria-label='Phone width (390 px)']")!;
    await act(() => {
      phone.click();
    });
    expect(phone.getAttribute("aria-pressed")).toBe("true");
    expect(frame().dataset.viewport).toBe("phone");
    expect(frame().style.width).toBe("390px");

    const laptop = document.querySelector<HTMLButtonElement>("button[aria-label='Laptop width (1440 px)']")!;
    await act(() => {
      laptop.click();
    });
    expect(frame().style.width).toBe("1440px");
  });
});
