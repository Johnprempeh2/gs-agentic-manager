// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionCard, WebsiteHomeSummary, WebsiteProperty, WebsiteSite } from "@greatstone/shared";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const websiteApiMock = vi.hoisted(() => ({ hub: vi.fn(), report: vi.fn(), update: vi.fn() }));
const moduleApiMock = vi.hoisted(() => ({ sites: vi.fn(), home: vi.fn() }));
const projectsMock = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), getTree: vi.fn() }));
const feedMock = vi.hoisted(() => ({ cards: [] as DecisionCard[] }));
const motionMock = vi.hoisted(() => ({ reduced: false }));

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
vi.mock("../../context/DialogContext", () => ({ useDialogActions: () => ({ openNewIssue: vi.fn() }) }));
vi.mock("../../hooks/useDecisionsFeed", () => ({
  useDecisionsFeed: () => ({ data: { cards: feedMock.cards, assignableAgents: [] }, isLoading: false, error: null }),
}));
vi.mock("../../hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => motionMock.reduced }));
vi.mock("../decisions-feed/DecisionFeedCard", () => ({
  decisionCardTaskId: (card: DecisionCard) => card.task?.id ?? null,
  DecisionFeedCard: ({ card, compact }: { card: DecisionCard; compact?: boolean }) => (
    <div data-testid="decision-card" data-compact={compact ? "yes" : "no"}>{card.title}</div>
  ),
}));
vi.mock("../LivePreviewCard", () => ({ LivePreviewCard: () => null, pickLivePreviewService: () => null }));
vi.mock("../../pages/ProjectTree", () => ({ ProjectTreeView: () => null }));

import { WebsiteHomeTab, activityVerb, liveStatus, pageProgress } from "./WebsiteHome";

function property(overrides: Partial<WebsiteProperty> = {}): WebsiteProperty {
  return {
    id: "prop-1",
    companyId: "co-1",
    name: "Greatstone",
    siteUrl: "sc-domain:greatstone.example",
    ga4PropertyId: "123",
    projectId: "proj-1",
    connectionStatus: "connected",
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

const site = { id: "site-1", name: "Greatstone", domain: "greatstone.example", propertyId: "prop-1", archivedAt: null } as WebsiteSite;

function summary(overrides: Partial<WebsiteHomeSummary> = {}): WebsiteHomeSummary {
  return {
    pages: { planned: 170, draft: 4, review: 1, approved: 1, published: 2 },
    sitemap: { approved: { id: "opt-1", name: "Option B: two doors", approvedAt: "2026-10-22T09:00:00.000Z", changedSinceApproval: false }, awaitingReview: 2 },
    releases: {
      latest: { id: "rel-2", number: 2, kind: "publish", status: "pending", liveAt: null, createdAt: "2026-10-23T09:00:00.000Z", publishedByName: "John Prempeh" },
      live: { id: "rel-1", number: 1, kind: "publish", status: "live", liveAt: "2026-10-22T09:00:00.000Z", createdAt: "2026-10-22T08:58:00.000Z", publishedByName: "John Prempeh" },
    },
    publishApproval: null,
    collections: { product: 12, "public-person": 6, redirect: 3, form: 2 },
    activity: [
      { id: "a1", action: "website.page_saved", entityType: "website_page", entityId: "p1", actorType: "agent", actorName: "Mikey", subject: "Home", createdAt: "2026-10-23T10:00:00.000Z" },
    ],
    liveFraming: "allowed",
    ...overrides,
  };
}

const tree = {
  project: { id: "proj-1", name: "Website", status: "in_progress", lead: null },
  keyTaskIds: ["k1"],
  unsortedIds: [],
  nodes: [{ id: "k1", identifier: "GRE-1", title: "Build the pages", status: "in_progress", parentId: null }],
  externalBlockers: [],
  hiddenDoneByParent: {},
  keyTaskProgress: { k1: { done: 3, total: 8 } },
  counts: { done: 12, active: 5, blocked: 1, waiting: 2 },
  openTidyTaskId: null,
  truncated: false,
  limits: { maxNodes: 500, maxDepth: 8 },
};

let container: HTMLDivElement;
let root: Root;
const onOpenTab = vi.fn();

async function render(prop = property()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <WebsiteHomeTab companyId="co-1" property={prop} onOpenTab={onOpenTab} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

const text = () => container.textContent ?? "";
const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`);

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  feedMock.cards = [];
  motionMock.reduced = false;
  moduleApiMock.sites.mockResolvedValue([site]);
  moduleApiMock.home.mockResolvedValue(summary());
  websiteApiMock.hub.mockResolvedValue({ propertyId: "prop-1", projectId: "proj-1", recentWork: [], sitemap: null, previewLinks: [] });
  websiteApiMock.report.mockResolvedValue({
    ga4: { dailyTrend: [1, 2, 3, 4, 5, 6, 7, 8].map((visitors, index) => ({ date: `2026-10-1${index}`, visitors, sessions: 0, conversions: 0 })) },
  });
  projectsMock.get.mockResolvedValue({ id: "proj-1", workspaces: [] });
  projectsMock.getTree.mockResolvedValue(tree);
  projectsMock.list.mockResolvedValue([]);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("Website Home helpers", () => {
  it("counts planned, drafted and live pages", () => {
    expect(pageProgress(summary().pages)).toEqual({ planned: 170, drafted: 6, live: 2, total: 178 });
  });

  it("names events in plain words", () => {
    expect(activityVerb("website.sitemap_option_approved")).toBe("approved the sitemap option");
    expect(activityVerb("website.something_new")).toBe("something new");
  });

  it("reads the live status from the releases", () => {
    expect(liveStatus(null, undefined).label).toBe("Not connected");
    expect(liveStatus(site, summary().releases).label).toBe("Pending");
    expect(liveStatus(site, { latest: summary().releases.live, live: summary().releases.live }).label).toBe("Live");
    expect(liveStatus(site, { latest: null, live: null }).label).toBe("Not published yet");
  });
});

describe("WebsiteHomeTab", () => {
  it("leads with the site, then shows the tiles, activity and a calm needs-you strip", async () => {
    await render();
    await vi.waitFor(() => expect(text()).toContain("Option B: two doors"));
    expect(byTestId("website-preview-frame")?.getAttribute("src")).toBe("https://greatstone.example/");
    expect(byTestId("website-home-status")?.textContent).toContain("Pending");
    expect(byTestId("website-home-release")?.textContent).toContain("Release 1 went live");
    expect(byTestId("website-home-needs-you-empty")?.textContent).toContain("Nothing waiting on you");
    expect(byTestId("website-home-tile-editor")?.textContent).toContain("8 of 178 started");
    expect(byTestId("website-home-tile-editor")?.textContent).toContain("2 live · 6 drafted · 170 planned");
    expect(byTestId("website-home-tile-sitemap")?.textContent).toContain("2 options awaiting review");
    expect(byTestId("website-home-tile-releases")?.textContent).toContain("Release 2: Pending");
    await vi.waitFor(() => expect(byTestId("website-home-tile-progress")?.textContent).toContain("12 of 20"));
    expect(byTestId("website-home-tile-progress")?.textContent).toContain("Build the pages (3/8)");
    // Seven days of visitors: 2 + 3 + ... + 8.
    await vi.waitFor(() => expect(byTestId("website-home-tile-traffic")?.textContent).toContain("35"));
    expect(byTestId("website-home-tile-collections")?.textContent).toContain("Products12");
    expect(byTestId("website-home-activity")?.textContent).toContain("Mikey saved Home");
  });

  it("opens each tile's tab, and the hero actions open Pages and Releases", async () => {
    await render();
    await vi.waitFor(() => expect(text()).toContain("Option B: two doors"));
    const expected: Record<string, string> = {
      "website-home-tile-editor": "editor",
      "website-home-tile-sitemap": "sitemap",
      "website-home-tile-releases": "releases",
      "website-home-tile-progress": "progress",
      "website-home-tile-traffic": "traffic",
      "website-home-tile-collections": "collections",
    };
    for (const [id, tab] of Object.entries(expected)) {
      await act(async () => { (byTestId(id) as HTMLButtonElement).click(); });
      expect(onOpenTab).toHaveBeenLastCalledWith(tab);
    }
    const button = (label: string) => Array.from(container.querySelectorAll("button")).find((el) => el.textContent?.trim() === label)!;
    await act(async () => { button("Edit pages").click(); });
    expect(onOpenTab).toHaveBeenLastCalledWith("editor");
    await act(async () => { button("Publish").click(); });
    expect(onOpenTab).toHaveBeenLastCalledWith("releases");
  });

  it("puts the open Publish request and the website project's decisions in the needs-you strip, compact", async () => {
    feedMock.cards = [
      { id: "c1", title: "Approve the home page copy", task: { id: "k1" }, items: [] },
      { id: "c2", title: "Another project", task: { id: "elsewhere" }, items: [] },
    ] as unknown as DecisionCard[];
    moduleApiMock.home.mockResolvedValue(summary({ publishApproval: { id: "ap-1", title: "Publish 3 changes", changeCount: 3, createdAt: "2026-10-23T09:00:00.000Z" } }));
    await render();
    await vi.waitFor(() => expect(byTestId("website-home-publish-approval")?.textContent).toContain("Publish 3 changes"));
    expect(byTestId("website-home-publish-approval")?.getAttribute("href")).toBe("/approvals/ap-1");
    await vi.waitFor(() => expect(container.querySelectorAll('[data-testid="decision-card"]')).toHaveLength(1));
    expect(byTestId("decision-card")?.getAttribute("data-compact")).toBe("yes");
    expect(byTestId("website-home-needs-you-empty")).toBeNull();
  });

  it("shows calm empty states for a site that is not connected and has no project or Google", async () => {
    moduleApiMock.sites.mockResolvedValue([]);
    await render(property({ projectId: null, ga4PropertyId: null, siteUrl: "not a url" }));
    await vi.waitFor(() => expect(byTestId("website-home-status")?.textContent).toContain("Not connected"));
    expect(byTestId("website-home-frame-placeholder")?.textContent).toContain("No preview to show yet");
    expect(byTestId("website-preview-frame")).toBeNull();
    expect(byTestId("website-home-tile-editor")?.textContent).toContain("Connect the site under Releases first.");
    expect(byTestId("website-home-tile-progress")?.textContent).toContain("Link the website project");
    expect(byTestId("website-home-tile-traffic")?.textContent).toContain("Google not linked");
    expect(byTestId("website-home-needs-you-empty")).not.toBeNull();
    expect(text()).toContain("Link the website project");
    expect(moduleApiMock.home).not.toHaveBeenCalled();
    expect(websiteApiMock.report).not.toHaveBeenCalled();
  });

  it("shows a clean placeholder, never a blank frame, when the live site refuses frames", async () => {
    moduleApiMock.home.mockResolvedValue(summary({ liveFraming: "refused" }));
    await render();
    await vi.waitFor(() => expect(byTestId("website-home-frame-placeholder")?.textContent).toContain("greatstone.example keeps itself out of frames"));
    expect(byTestId("website-preview-frame")).toBeNull();
    expect(byTestId("website-home-frame-placeholder")?.querySelector("a")?.getAttribute("href")).toBe("https://greatstone.example/");
  });

  it("holds an unconnected live site back with a clean placeholder instead of a frame that may fail", async () => {
    moduleApiMock.sites.mockResolvedValue([]);
    await render(property({ siteUrl: "https://fresh.example/" }));
    await vi.waitFor(() => expect(byTestId("website-home-frame-placeholder")?.textContent).toContain("Connect the site to see it here"));
    expect(byTestId("website-preview-frame")).toBeNull();
  });

  it("keeps the hero haze still under reduced motion and while the tab is hidden", async () => {
    await render();
    expect(byTestId("website-home-haze")?.getAttribute("data-motion")).toBe("drift");
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(byTestId("website-home-haze")?.getAttribute("data-motion")).toBe("still");
    visibility.mockRestore();
    act(() => root.unmount());
    root = createRoot(container);
    motionMock.reduced = true;
    await render();
    expect(byTestId("website-home-haze")?.getAttribute("data-motion")).toBe("still");
  });
});
