// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebsitePage, WebsiteSite, WebsiteSitemapOption } from "@greatstone/shared";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const moduleMock = vi.hoisted(() => ({
  updateSitemapOption: vi.fn(),
  approveSitemapOption: vi.fn(),
  createSitemapOption: vi.fn(),
  archiveSitemapOption: vi.fn(),
  sitemapXml: vi.fn(),
}));
vi.mock("../../../api/website", async () => {
  const actual = await vi.importActual<typeof import("../../../api/website")>("../../../api/website");
  return { ...actual, websiteModuleApi: moduleMock };
});
vi.mock("../../../context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false }) }));

import { SitemapSection, treeFromPages } from "./SitemapSection";

const site = { id: "site-1", companyId: "co-1", domain: "www.example.test" } as WebsiteSite;

function option(overrides: Partial<WebsiteSitemapOption> = {}): WebsiteSitemapOption {
  return {
    id: "opt-a",
    companyId: "co-1",
    siteId: "site-1",
    name: "Option A",
    description: null,
    tree: {
      nodes: [
        { id: "n1", title: "Home", path: "/", parentId: null, order: 0, menu: "none", menuOrder: null, pageId: "page-1" },
        { id: "n2", title: "Consultancy", path: "/consultancy", parentId: "n1", order: 0, menu: "header", menuOrder: 1 },
        { id: "n3", title: "Tools", path: "/tools", parentId: "n1", order: 1, menu: "header", menuOrder: 2 },
      ],
      journeys: [],
    },
    status: "draft",
    proposedByAgentId: "agent-1",
    createdByUserId: null,
    approvedAt: null,
    approvedByUserId: null,
    changedSinceApproval: false,
    createdAt: "2026-10-23T09:00:00.000Z",
    updatedAt: "2026-10-23T09:00:00.000Z",
    ...overrides,
  };
}

const pages = [{ id: "page-1", slug: "/", title: "Home", status: "published", menu: "none", menuOrder: null, parentPageId: null, navOrder: 0, seo: {} }] as unknown as WebsitePage[];

describe("SitemapSection", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(props: Partial<Parameters<typeof SitemapSection>[0]> = {}) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <SitemapSection companyId="co-1" site={site} options={[option()]} pages={pages} canApprove canEdit {...props} />
        </QueryClientProvider>,
      );
    });
  }

  const button = (label: string) => [...container.querySelectorAll("button")].find((entry) => entry.getAttribute("aria-label") === label || entry.textContent === label);
  const rowTitles = () => [...container.querySelectorAll("[data-testid=sitemap-tree-row]")].map((row) => row.querySelector("span.font-medium")?.textContent);

  it("shows page status from the site's pages and moves pages from the keyboard, then saves", async () => {
    moduleMock.updateSitemapOption.mockResolvedValue(option());
    await render();
    expect(rowTitles()).toEqual(["Home", "Consultancy", "Tools"]);
    expect(container.textContent).toContain("Live");
    await act(async () => button("Move Tools up")!.click());
    expect(rowTitles()).toEqual(["Home", "Tools", "Consultancy"]);
    expect(container.textContent).toContain("Unsaved changes");
    await act(async () => button("Save changes")!.click());
    const [, , optionId, patch] = moduleMock.updateSitemapOption.mock.calls[0]!;
    expect(optionId).toBe("opt-a");
    expect(patch.baseUpdatedAt).toBe("2026-10-23T09:00:00.000Z");
    expect(patch.tree.nodes.find((node: { id: string }) => node.id === "n3").order).toBe(0);
  });

  const dialog = () => document.querySelector<HTMLElement>("[data-testid=sitemap-approve-dialog]");
  const dialogButton = (label: string) => [...(dialog()?.querySelectorAll("button") ?? [])].find((entry) => entry.textContent === label);

  it("asks before approving and says what approval does to the site", async () => {
    await render();
    await act(async () => button("Approve this option")!.click());
    expect(dialog()!.getAttribute("role")).toBe("alertdialog");
    expect(dialog()!.textContent).toContain("Approve Option A?");
    expect(dialog()!.textContent).toContain("2 new pages are planned and 0 pages");
    expect(moduleMock.approveSitemapOption).not.toHaveBeenCalled();
  });

  it("approves from Compare through the same dialog, with the counts for the chosen option", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    const optionB = option({
      id: "opt-b",
      name: "Option B",
      tree: { nodes: [{ id: "n1", title: "Home", path: "/", parentId: null, order: 0, menu: "none", menuOrder: null, pageId: "page-1" }], journeys: [] },
    });
    moduleMock.approveSitemapOption.mockResolvedValue({ option: { ...optionB, status: "approved" }, summary: { created: 0, updated: 1, archived: 0 } });
    await render({ options: [option(), optionB] });
    // Radix tabs switch on mouse down, not click.
    await act(async () => button("Compare")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })));
    const useButtons = [...container.querySelectorAll("[data-testid=sitemap-compare] button")].filter((entry) => entry.textContent === "Use this option");
    expect(useButtons).toHaveLength(2);
    await act(async () => (useButtons[1] as HTMLButtonElement).click());
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(dialog()!.textContent).toContain("Approve Option B?");
    expect(dialog()!.textContent).toContain("0 new pages are planned and 0 pages");
    expect(moduleMock.approveSitemapOption).not.toHaveBeenCalled();
    await act(async () => dialogButton("Approve")!.click());
    expect(moduleMock.approveSitemapOption).toHaveBeenCalledWith("co-1", "site-1", "opt-b");
    expect(dialog()).toBeNull();
    confirmSpy.mockRestore();
  });

  it("hides approval from people who cannot publish", async () => {
    await render({ canApprove: false });
    expect(button("Approve this option")).toBeUndefined();
  });

  it("starts an option from the site's pages with their parents and menus", () => {
    const tree = treeFromPages([
      ...pages,
      { id: "page-2", slug: "/about", title: "About", status: "planned", menu: "footer", menuOrder: 3, parentPageId: "page-1", navOrder: 0, seo: { noindex: true } },
    ] as unknown as WebsitePage[]);
    expect(tree.nodes.find((node) => node.pageId === "page-2")).toMatchObject({ parentId: "n1", menu: "footer", menuOrder: 3, noindex: true });
  });
});
