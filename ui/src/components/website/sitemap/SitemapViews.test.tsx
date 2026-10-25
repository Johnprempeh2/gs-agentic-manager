// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebsitePage } from "@greatstone/shared";
import { pagesLookup, type Tree } from "./model";
import { SitemapJourneysView, SitemapMenusView } from "./SitemapViews";
import { SitemapTreeView } from "./SitemapTree";

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

  it("Edit page on a row with a page opens it in the editor (GRE-2296)", () => {
    const onEditPage = vi.fn();
    const extra: Tree = { ...tree, nodes: [...tree.nodes, { id: "n3", title: "New", path: "/new", parentId: null, order: 1, menu: "none", menuOrder: null, pageId: null }] };
    render(<SitemapTreeView tree={extra} onChange={() => {}} pagesById={pagesById} readOnly onEditPage={onEditPage} />);
    const edits = [...container.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.textContent === "Edit page");
    expect(edits.map((button) => button.getAttribute("aria-label"))).toEqual(["Edit page Home", "Edit page Tools"]);
    act(() => edits[1]!.click());
    expect(onEditPage).toHaveBeenCalledWith("page-2");
  });

  it("lays the tree out top to bottom, folds a deep section with more than 12 pages, and Find unfolds the way to a page (GRE-2509)", () => {
    const products = Array.from({ length: 13 }, (_, i) => ({ id: `p${i}`, title: `Product ${i}`, path: `/tools/brands/products/${i}`, parentId: "n3", order: i, menu: "none" as const, menuOrder: null }));
    const deep: Tree = {
      ...tree,
      nodes: [...tree.nodes, { id: "n3", title: "Brands", path: "/tools/brands", parentId: "n2", order: 0, menu: "none", menuOrder: null }, ...products],
    };
    render(<SitemapTreeView tree={deep} onChange={() => {}} pagesById={pagesById} readOnly />);
    const titles = () => [...container.querySelectorAll("[data-testid=sitemap-tree-row]")].map((row) => row.querySelector("[data-sitemap-title]")!.textContent);
    expect(titles()).toEqual(["Home", "Tools", "Brands"]);
    const brandsPath = container.querySelectorAll("[data-sitemap-path]")[2]!;
    expect(brandsPath.textContent).toBe("/brands");
    expect(brandsPath.getAttribute("title")).toBe("/tools/brands");
    const fold = container.querySelector<HTMLButtonElement>("button[aria-label='Show the 13 sub-pages of Brands']")!;
    expect(fold.getAttribute("aria-expanded")).toBe("false");

    const find = container.querySelector<HTMLInputElement>("[role=toolbar] input")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(find, "Product 7");
      find.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => find.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(titles()).toHaveLength(16);
    const found = container.querySelector("[data-found]")!;
    expect(found.querySelector("[data-sitemap-title]")!.textContent).toBe("Product 7");
    expect(document.activeElement).toBe(found);
  });
});
