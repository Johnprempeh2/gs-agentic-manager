// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionCard, WebsiteHomeSummary, WebsiteHub, WebsiteHubSitemap, WebsiteProperty, WebsiteSite } from "@greatstone/shared";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const websiteApiMock = vi.hoisted(() => ({ hub: vi.fn(), update: vi.fn() }));
const moduleApiMock = vi.hoisted(() => ({ sites: vi.fn(), home: vi.fn() }));
const projectsMock = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), getTree: vi.fn() }));
const openNewIssue = vi.hoisted(() => vi.fn());
const feedMock = vi.hoisted(() => ({ cards: [] as DecisionCard[] }));

vi.mock("../../api/website", async () => {
  const actual = await vi.importActual<typeof import("../../api/website")>("../../api/website");
  return { ...actual, websiteApi: websiteApiMock, websiteModuleApi: moduleApiMock };
});
vi.mock("../../api/projects", () => ({ projectsApi: projectsMock }));
vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { Link: actual.Link };
});
vi.mock("../../api/agents", () => ({ agentsApi: { list: vi.fn().mockResolvedValue([]) } }));
vi.mock("../../api/auth", () => ({ authApi: { getSession: vi.fn().mockResolvedValue(null) } }));
vi.mock("../../context/DialogContext", () => ({ useDialogActions: () => ({ openNewIssue }) }));
vi.mock("../../hooks/useDecisionsFeed", () => ({
  useDecisionsFeed: () => ({ data: { cards: feedMock.cards, assignableAgents: [] }, isLoading: false, error: null }),
}));
vi.mock("../decisions-feed/DecisionFeedCard", () => ({
  decisionCardTaskId: (card: DecisionCard) => card.task?.id ?? null,
  DecisionFeedCard: ({ card }: { card: DecisionCard }) => <div data-testid="decision-card">{card.title}</div>,
}));
vi.mock("../LivePreviewCard", () => ({
  LivePreviewCard: () => null,
  pickLivePreviewService: (services: Array<{ status: string; url: string | null }> | undefined) =>
    (services ?? []).find((service) => service.status === "running" && service.url) ?? null,
}));
vi.mock("../../pages/ProjectTree", () => ({ ProjectTreeView: () => <div data-testid="project-tree" /> }));

import {
  WebsitePreviewTab,
  rememberPreviewMode,
  WebsiteSitemapTab,
  framingProblem,
  liveSiteUrl,
  sitemapApprovalState,
  websiteDecisionCards,
} from "./WebsiteHub";

function property(overrides: Partial<WebsiteProperty> = {}): WebsiteProperty {
  return {
    id: "prop-1",
    companyId: "co-1",
    name: "Greatstone",
    siteUrl: "sc-domain:greatstone.example",
    ga4PropertyId: "123",
    projectId: "proj-1",
    connectionStatus: "not_connected",
    connectedAt: null,
    lastPullAt: null,
    lastPullStatus: null,
    lastPullErrors: [],
    nextPullDueAt: null,
    createdAt: "2026-10-20T09:00:00.000Z",
    updatedAt: "2026-10-20T09:00:00.000Z",
    ...overrides,
  };
}

const task = { id: "task-1", identifier: "GRE-1", title: "Sitemap" };

function sitemap(overrides: Partial<WebsiteHubSitemap> = {}): WebsiteHubSitemap {
  return {
    source: "deliverable",
    title: "Website sitemap",
    filename: "website-sitemap.html",
    contentPath: "/api/attachments/att-1/content",
    contentType: "text/html",
    version: 2,
    versionCount: 3,
    status: "draft",
    reviewState: "none",
    task,
    createdAt: "2026-10-22T09:00:00.000Z",
    ...overrides,
  };
}

function hub(overrides: Partial<WebsiteHub> = {}): WebsiteHub {
  return { propertyId: "prop-1", projectId: "proj-1", recentWork: [], sitemap: null, previewLinks: [], ...overrides };
}

function card(id: string, taskId: string | null, projectId: string | null): DecisionCard {
  return {
    id,
    title: `Card ${id}`,
    task: taskId ? { kind: "issue", id: taskId, companyId: "co-1", title: null, identifier: null, status: null, href: null } : null,
    items: projectId ? [{ project: { id: projectId } }] : [],
  } as unknown as DecisionCard;
}

describe("website hub helpers", () => {
  it("turns a Search Console property into the live address", () => {
    expect(liveSiteUrl("sc-domain:greatstone.example")).toBe("https://greatstone.example/");
    expect(liveSiteUrl("https://www.greatstone.example/")).toBe("https://www.greatstone.example/");
    expect(liveSiteUrl("not a url")).toBeNull();
  });

  it("names mixed content before the frame tries to load", () => {
    expect(framingProblem("http://127.0.0.1:4100", "https:")).toMatch(/mixed content/);
    expect(framingProblem("http://127.0.0.1:4100", "http:")).toBeNull();
    expect(framingProblem("https://x.netlify.app", "https:")).toBeNull();
  });

  it("keeps the decision cards about the website project only", () => {
    const cards = [card("a", "task-1", null), card("b", "other", "proj-1"), card("c", "other", "proj-2"), card("d", null, null)];
    expect(websiteDecisionCards(cards, "proj-1", new Set(["task-1"])).map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("reads the sitemap approval state", () => {
    expect(sitemapApprovalState(sitemap({ reviewState: "approved" }), true)).toBe("approved");
    expect(sitemapApprovalState(sitemap({ reviewState: "changes_requested" }), false)).toBe("changes_requested");
    expect(sitemapApprovalState(sitemap({ reviewState: "needs_board_review" }), false)).toBe("waiting");
    expect(sitemapApprovalState(sitemap({ reviewState: "none" }), true)).toBe("waiting");
    expect(sitemapApprovalState(sitemap({ reviewState: null }), false)).toBe("none");
  });
});

let container: HTMLDivElement;
let root: Root;

async function render(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>{node}</MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

const text = () => container.textContent ?? "";

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  feedMock.cards = [];
  moduleApiMock.sites.mockResolvedValue([]);
  projectsMock.getTree.mockResolvedValue({ nodes: [{ id: "task-1" }], keyTaskIds: [], keyTaskProgress: {}, counts: { done: 0, active: 0, blocked: 0, waiting: 0 } });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("WebsiteSitemapTab", () => {
  it("says what to do next when there is no sitemap", async () => {
    websiteApiMock.hub.mockResolvedValue(hub());
    await render(<WebsiteSitemapTab companyId="co-1" property={property()} />);
    await vi.waitFor(() => expect(text()).toContain("No sitemap yet"));
    const button = Array.from(container.querySelectorAll("button")).find((el) => el.textContent?.includes("New task"))!;
    await act(async () => { button.click(); });
    expect(openNewIssue).toHaveBeenCalledWith({ projectId: "proj-1" });
  });

  it("frames the newest sitemap in a sandbox with its version and approval card", async () => {
    websiteApiMock.hub.mockResolvedValue(hub({ sitemap: sitemap() }));
    feedMock.cards = [card("review", "task-1", "proj-1")];
    await render(<WebsiteSitemapTab companyId="co-1" property={property()} />);
    await vi.waitFor(() => expect(text()).toContain("Version 2 of 3"));
    expect(text()).toContain("Waiting for your approval");
    const frame = container.querySelector("iframe")!;
    expect(frame.getAttribute("src")).toBe("/api/attachments/att-1/content");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(container.querySelector('a[href="#website-sitemap-approval"]')).not.toBeNull();
    expect(container.querySelector("#website-sitemap-approval [data-testid='decision-card']")?.textContent).toBe("Card review");
  });
});

describe("WebsitePreviewTab", () => {
  it("shows the running workspace preview with width toggles and lists posted deploy previews with their source", async () => {
    projectsMock.get.mockResolvedValue({
      id: "proj-1",
      workspaces: [{ runtimeServices: [{ status: "running", url: "http://127.0.0.1:4100", serviceName: "preview", port: 4100 }] }],
    });
    websiteApiMock.hub.mockResolvedValue(hub({
      previewLinks: [{ url: "https://deploy-preview-3--gs.netlify.app", source: "comment", label: "Mason", task, postedAt: "2026-10-22T09:00:00.000Z" }],
    }));
    await render(<WebsitePreviewTab companyId="co-1" property={property()} />);
    // The live site shows at once; the running workspace preview takes over when it is known.
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="website-preview-frame"]')?.getAttribute("src")).toBe("http://127.0.0.1:4100"),
    );
    expect(text()).toContain("Workspace preview (preview, port 4100)");
    const widths = Array.from(container.querySelectorAll('[aria-label="Preview width"] button')).map((el) => el.textContent);
    expect(widths).toEqual(["Laptop", "Tablet", "Phone"]);
    expect(text()).toContain("Open in new tab");
    await vi.waitFor(() => expect(text()).toContain("Comment by Mason"));
    const show = Array.from(container.querySelectorAll("button")).find((el) => el.textContent === "Show here")!;
    await act(async () => { show.click(); });
    expect(container.querySelector('[data-testid="website-preview-frame"]')!.getAttribute("src")).toBe("https://deploy-preview-3--gs.netlify.app");
  });

  it("shows the live site when no preview runs, with a placeholder until it loads and Open in new tab if it never does", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      projectsMock.get.mockResolvedValue({ id: "proj-1", workspaces: [] });
      websiteApiMock.hub.mockResolvedValue(hub());
      await render(<WebsitePreviewTab companyId="co-1" property={property()} />);
      const frame = container.querySelector('[data-testid="website-preview-frame"]')!;
      expect(frame.getAttribute("src")).toBe("https://greatstone.example/");
      expect(text()).toContain("Live (greatstone.example)");
      expect(container.querySelector('[data-testid="website-preview-placeholder"]')?.textContent).toContain("Loading greatstone.example");
      await act(async () => { vi.advanceTimersByTime(8_000); });
      const fallback = container.querySelector('[data-testid="website-preview-placeholder"]')!;
      expect(fallback.textContent).toContain("The site is not showing here");
      expect(fallback.querySelector('a[target="_blank"]')?.getAttribute("href")).toBe("https://greatstone.example/");
      // Once the frame loads, the site shows and the placeholder goes.
      await act(async () => { frame.dispatchEvent(new Event("load")); });
      expect(container.querySelector('[data-testid="website-preview-placeholder"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  const connected = {
    id: "site-1",
    name: "Greatstone",
    domain: "greatstone.example",
    propertyId: "prop-1",
    archivedAt: null,
    editorFrameOrigin: "https://dev.greatstone.example",
    livePreviewUrl: "https://mirror--greatstone.netlify.app/",
    devPreviewUrl: null,
  } as WebsiteSite;
  const frames = () => Array.from(container.querySelectorAll<HTMLIFrameElement>('[data-testid="website-preview-frame"]'));
  const button = (group: string, label: string) =>
    Array.from(container.querySelectorAll(`[aria-label="${group}"] button`)).find((el) => el.textContent === label) as HTMLButtonElement;

  it("switches between Live, In development and Side by side, remembering the choice, with the live copy named", async () => {
    window.localStorage.clear();
    moduleApiMock.sites.mockResolvedValue([connected]);
    moduleApiMock.home.mockResolvedValue({ liveFraming: "allowed", devFraming: "allowed" } as WebsiteHomeSummary);
    projectsMock.get.mockResolvedValue({ id: "proj-1", workspaces: [] });
    websiteApiMock.hub.mockResolvedValue(hub());
    await render(<WebsitePreviewTab companyId="co-1" property={property()} />);
    // Nothing remembered: the site in development leads, at the editor address.
    await vi.waitFor(() => expect(frames().map((frame) => frame.getAttribute("src"))).toEqual(["https://dev.greatstone.example/"]));
    expect(Array.from(container.querySelectorAll('[aria-label="Which site"] button')).map((el) => el.textContent)).toEqual(["Live", "In development", "Side by side"]);

    await act(async () => { button("Which site", "Live").click(); });
    expect(frames().map((frame) => frame.getAttribute("src"))).toEqual(["https://mirror--greatstone.netlify.app/"]);
    expect(container.querySelector('[data-testid="website-preview-mirror-note"]')?.textContent).toBe("Showing an exact copy of the live site.");
    expect(window.localStorage.getItem("gsam.website.preview-mode")).toBe("live");

    await act(async () => { button("Which site", "Side by side").click(); });
    const side = container.querySelector('[data-testid="website-preview-side-by-side"]')!;
    expect(side.className).toContain("min-[900px]:grid-cols-2");
    const live = side.querySelector('[data-testid="website-preview-live"]')!;
    const dev = side.querySelector('[data-testid="website-preview-dev"]')!;
    expect(live.getAttribute("aria-label")).toBe("Live (greatstone.example)");
    expect(dev.getAttribute("aria-label")).toBe("In development");
    expect(live.querySelector('a[target="_blank"]')?.getAttribute("href")).toBe("https://mirror--greatstone.netlify.app/");
    expect(dev.querySelector('a[target="_blank"]')?.getAttribute("href")).toBe("https://dev.greatstone.example/");
    expect(frames().map((frame) => frame.title)).toEqual(["Live (greatstone.example) preview, laptop width", "In development preview, laptop width"]);

    // One width toggle drives both frames.
    await act(async () => { button("Preview width", "Phone").click(); });
    expect(frames().map((frame) => frame.style.width)).toEqual(["390px", "390px"]);
    expect(frames().map((frame) => frame.title)).toEqual(["Live (greatstone.example) preview, phone width", "In development preview, phone width"]);
    expect(window.localStorage.getItem("gsam.website.preview-mode")).toBe("side");
  });

  it("opens in the mode the Home asked for, and shows the refused placeholder at once for an address that refuses frames", async () => {
    rememberPreviewMode("side");
    moduleApiMock.sites.mockResolvedValue([{ ...connected, livePreviewUrl: null }]);
    moduleApiMock.home.mockResolvedValue({ liveFraming: "refused", devFraming: "allowed" } as WebsiteHomeSummary);
    projectsMock.get.mockResolvedValue({ id: "proj-1", workspaces: [] });
    websiteApiMock.hub.mockResolvedValue(hub());
    await render(<WebsitePreviewTab companyId="co-1" property={property()} />);
    await vi.waitFor(() => expect(container.querySelector('[data-testid="website-preview-live"] [data-testid="website-preview-placeholder"]')?.textContent).toContain("does not allow being shown"));
    expect(container.querySelector('[data-testid="website-preview-live"] [data-testid="website-preview-frame"]')).toBeNull();
    expect(container.querySelector('[data-testid="website-preview-mirror-note"]')).toBeNull();
    expect(container.querySelector('[data-testid="website-preview-dev"] [data-testid="website-preview-frame"]')?.getAttribute("src")).toBe("https://dev.greatstone.example/");
  });
});
