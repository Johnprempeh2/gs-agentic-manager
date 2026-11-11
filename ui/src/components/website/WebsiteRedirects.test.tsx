// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebsiteMediaItem, WebsiteRedirect } from "@greatstone/shared";
import { ApiError } from "../../api/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const moduleApiMock = vi.hoisted(() => ({
  access: vi.fn(), redirects: vi.fn(), createRedirect: vi.fn(), saveRedirect: vi.fn(), deleteRedirect: vi.fn(),
  submitEntry: vi.fn(), approveEntry: vi.fn(), media: vi.fn(), renameMedia: vi.fn(), deleteMedia: vi.fn(),
}));

vi.mock("../../api/website", async () => {
  const actual = await vi.importActual<typeof import("../../api/website")>("../../api/website");
  return { ...actual, websiteModuleApi: moduleApiMock };
});

import { WebsiteRedirects } from "./WebsiteRedirects";
import { WebsiteMediaLibrary } from "./WebsiteMediaLibrary";

const redirect = (entryId: string, from: string, to: string, extra: Partial<WebsiteRedirect> = {}): WebsiteRedirect =>
  ({ entryId, key: `redirect-${entryId}`, from, to, status: 301, state: "draft", latestRevisionId: `${entryId}-r1`, updatedAt: "2026-11-09T09:00:00Z", ...extra });
const media: WebsiteMediaItem = {
  entryId: "m1", entryKey: "harbour", assetId: "a1", alt: "Boats in a harbour", caption: null, contentType: "image/png",
  byteSize: 2048, width: null, height: null, contentPath: "/api/assets/a1/content",
};

let container: HTMLDivElement;
let root: Root;

async function flush() {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function render(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => { root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>); });
  await flush();
}

async function click(element: Element | null | undefined) {
  expect(element).toBeTruthy();
  await act(async () => { (element as HTMLElement).click(); });
  await flush();
}

async function type(selector: string, value: string) {
  const input = document.body.querySelector<HTMLInputElement>(selector)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function buttonByText(text: string) {
  return [...document.body.querySelectorAll("button")].find((button) => button.textContent?.trim() === text);
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
  moduleApiMock.access.mockResolvedValue({ view: true, edit: true, publish: true });
  moduleApiMock.redirects.mockResolvedValue([redirect("r1", "/old-pricing", "/pricing"), redirect("r2", "/blog", "https://blog.example.com/", { state: "review", status: 302 })]);
  moduleApiMock.media.mockResolvedValue([media]);
  moduleApiMock.submitEntry.mockResolvedValue({});
  moduleApiMock.approveEntry.mockResolvedValue({});
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

describe("WebsiteRedirects (GRE-4785)", () => {
  it("lists each redirect with its state and type, and the next step a person can take", async () => {
    await render(<WebsiteRedirects companyId="co-1" siteId="site-1" />);
    const rows = [...container.querySelectorAll('[data-testid="redirect-row"]')].map((row) => row.textContent);
    expect(rows[0]).toContain("/old-pricing");
    expect(rows[0]).toContain("Draft");
    expect(rows[0]).toContain("Permanent (301)");
    // A person with Publish rights approves a draft straight away: no Send for review step.
    expect(rows[0]).not.toContain("Send for review");
    expect(rows[0]).toContain("Approve");
    expect(rows[1]).toContain("In review");
    expect(rows[1]).toContain("Temporary (302)");
    expect(rows[1]).toContain("Approve");

    const approveIn = (n: number) => [...container.querySelectorAll('[data-testid="redirect-row"]')][n]!.querySelector("button");
    await click(approveIn(1));
    expect(moduleApiMock.submitEntry).not.toHaveBeenCalled();
    expect(moduleApiMock.approveEntry).toHaveBeenCalledWith("co-1", "site-1", "r2");
    expect(container.textContent).toContain("Approved /blog. Publish puts it on staging, and Deploy puts it live.");

    await click(approveIn(0));
    expect(moduleApiMock.submitEntry).toHaveBeenCalledWith("co-1", "site-1", "r1");
    expect(moduleApiMock.approveEntry).toHaveBeenCalledWith("co-1", "site-1", "r1");
  });

  it("keeps Send for review for someone who can edit but not approve", async () => {
    moduleApiMock.access.mockResolvedValue({ view: true, edit: true, publish: false });
    await render(<WebsiteRedirects companyId="co-1" siteId="site-1" />);
    const rows = [...container.querySelectorAll('[data-testid="redirect-row"]')].map((row) => row.textContent);
    expect(rows[0]).toContain("Send for review");
    expect(buttonByText("Approve")).toBeUndefined();
  });

  it("checks the addresses before it saves, then adds the redirect as a draft", async () => {
    moduleApiMock.createRedirect.mockResolvedValue(redirect("r3", "/team", "/people"));
    await render(<WebsiteRedirects companyId="co-1" siteId="site-1" />);
    await click(container.querySelector('[data-testid="redirect-add"]'));
    await type('[data-testid="redirect-from"]', "team");
    await type('[data-testid="redirect-to"]', "/people");
    await click(document.body.querySelector('[data-testid="redirect-save"]'));
    expect(moduleApiMock.createRedirect).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Start the old path with /");

    await type('[data-testid="redirect-from"]', "/team");
    await click(document.body.querySelector('[data-testid="redirect-save"]'));
    expect(moduleApiMock.createRedirect).toHaveBeenCalledWith("co-1", "site-1", { from: "/team", to: "/people", status: 301 });
    expect(container.textContent).toContain("Redirect added as a draft.");
  });

  it("changes a redirect at the version it read, and deletes one after a confirm", async () => {
    moduleApiMock.saveRedirect.mockResolvedValue(redirect("r1", "/old-pricing", "/prices"));
    moduleApiMock.deleteRedirect.mockResolvedValue({ entryId: "r1" });
    await render(<WebsiteRedirects companyId="co-1" siteId="site-1" />);
    await click(container.querySelector('[aria-label="Change redirect from /old-pricing"]'));
    await type('[data-testid="redirect-to"]', "/prices");
    await click(document.body.querySelector('[data-testid="redirect-save"]'));
    expect(moduleApiMock.saveRedirect).toHaveBeenCalledWith("co-1", "site-1", "r1", { from: "/old-pricing", to: "/prices", status: 301, baseRevisionId: "r1-r1" });

    await click(container.querySelector('[aria-label="Delete redirect from /old-pricing"]'));
    expect(document.body.textContent).toContain("stops sending visitors to /pricing after the next Publish and Deploy");
    await click(buttonByText("Delete"));
    expect(moduleApiMock.deleteRedirect).toHaveBeenCalledWith("co-1", "site-1", "r1");
  });

  it("shows no change buttons to someone who can only view", async () => {
    moduleApiMock.access.mockResolvedValue({ view: true, edit: false, publish: false });
    await render(<WebsiteRedirects companyId="co-1" siteId="site-1" />);
    expect(container.querySelectorAll('[data-testid="redirect-row"]')).toHaveLength(2);
    expect(container.querySelector('[data-testid="redirect-add"]')).toBeNull();
    expect(buttonByText("Send for review")).toBeUndefined();
  });
});

describe("WebsiteMediaLibrary (GRE-4785)", () => {
  it("renames media", async () => {
    moduleApiMock.renameMedia.mockResolvedValue({ ...media, entryKey: "harbour-at-dawn" });
    await render(<WebsiteMediaLibrary companyId="co-1" siteId="site-1" />);
    expect(container.textContent).toContain("Boats in a harbour");
    await click(container.querySelector('[aria-label="Rename harbour"]'));
    await type('[data-testid="media-name"]', "harbour-at-dawn");
    await click(document.body.querySelector('[data-testid="media-rename-save"]'));
    expect(moduleApiMock.renameMedia).toHaveBeenCalledWith("co-1", "site-1", "m1", "harbour-at-dawn");
    expect(container.textContent).toContain("Renamed to harbour-at-dawn.");
  });

  it("says which page still uses media it could not delete", async () => {
    moduleApiMock.deleteMedia.mockRejectedValue(new ApiError("This media is still used by Home. Take it off that first.", 409,
      { error: "This media is still used by Home. Take it off that first.", details: { code: "website_media_in_use" } }));
    await render(<WebsiteMediaLibrary companyId="co-1" siteId="site-1" />);
    await click(container.querySelector('[aria-label="Delete harbour"]'));
    await click(buttonByText("Delete"));
    expect(moduleApiMock.deleteMedia).toHaveBeenCalledWith("co-1", "site-1", "m1");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("still used by Home");
  });
});
