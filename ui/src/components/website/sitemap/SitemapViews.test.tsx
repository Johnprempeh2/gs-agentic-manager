// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WebsitePage } from "@greatstone/shared";
import { pagesLookup, type Tree } from "./model";
import { SitemapJourneysView, SitemapMenusView } from "./SitemapViews";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tree: Tree = {
  nodes: [
    { id: "n1", title: "Home", path: "/", parentId: null, order: 0, menu: "header", menuOrder: 0, pageId: "page-1" },
    { id: "n2", title: "Tools", path: "/tools", parentId: "n1", order: 0, menu: "header", menuOrder: 1, pageId: "page-2" },
  ],
  journeys: [{ id: "j1", name: "Leader", steps: ["n1", "n2"] }],
};

const pagesById = pagesLookup([
  { id: "page-1", slug: "/", title: "Home", status: "published" },
  { id: "page-2", slug: "/tools", title: "Tools", status: "planned" },
] as unknown as WebsitePage[]);

describe("Sitemap Menus and Journeys status", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (node: React.ReactNode) => act(() => root.render(node));

  it("shows each menu item's status and says a planned page stays out of the menu", () => {
    render(<SitemapMenusView tree={tree} onChange={() => {}} pagesById={pagesById} readOnly />);
    const items = [...container.querySelectorAll("li")].map((item) => item.textContent);
    expect(items).toEqual([
      "HomeLive",
      "ToolsPlannedTools is planned, so it stays out of this menu until it is live.",
    ]);
  });

  it("shows each journey step's status and names the steps visitors cannot take yet", () => {
    render(<SitemapJourneysView tree={tree} onChange={() => {}} pagesById={pagesById} readOnly />);
    const steps = container.querySelector("ol")!.textContent;
    expect(steps).toContain("Home");
    expect(steps).toContain("Live");
    expect(steps).toContain("Planned");
    const gaps = container.querySelector("[aria-label='Steps visitors cannot take yet']")!;
    expect(gaps.textContent).toBe("Tools is planned, not live. Visitors cannot take this step yet.");
  });
});
