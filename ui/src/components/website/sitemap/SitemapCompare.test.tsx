// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WebsiteSitemapOption, WebsiteSitemapTree } from "@greatstone/shared";
import { SitemapCompareView } from "./SitemapCompare";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const node = (id: string, title: string, path: string, parentId: string | null) => ({
  id, title, path, parentId, order: 0, menu: "none" as const, menuOrder: null,
});

const option = (id: string, name: string, tree: WebsiteSitemapTree) =>
  ({ id, name, tree, status: "draft" }) as unknown as WebsiteSitemapOption;

const published = option("v1", "v1 as published", {
  nodes: [node("1", "Services", "/services", null), node("2", "Business website build", "/services/business-website-build", "1")],
  journeys: [],
});
const regrouped = option("rev10", "Rev 10", {
  nodes: [
    node("a", "Services", "/services", null),
    node("b", "Websites and web apps", "/services/websites-web-apps", "a"),
    node("c", "Business website build", "/services/websites-web-apps/business-website-build", "b"),
  ],
  journeys: [],
});

describe("Sitemap Compare", () => {
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

  it("shows a page at a new address as moved, with its other address, not as removed and added (GRE-2193)", () => {
    act(() => root.render(
      <SitemapCompareView
        options={[published, regrouped]}
        pagesById={new Map()}
        initialA="v1"
        initialB="rev10"
        canApprove={false}
        canEdit={false}
        onApprove={() => {}}
        onCopy={async () => null}
        busy={false}
      />,
    ));
    const counts = container.querySelector("[aria-live=polite]")!.textContent;
    expect(counts).toContain("1 added");
    expect(counts).toContain("0 removed");
    expect(counts).toContain("1 moved");
    const row = (list: string) =>
      [...container.querySelectorAll(`[aria-label='Pages in ${list}'] li`)].find((item) => item.textContent?.startsWith("Business website build"))!;
    expect(row("v1 as published").textContent).toContain("Moved");
    expect(row("v1 as published").textContent).toContain("Now at /services/websites-web-apps/business-website-build");
    expect(row("Rev 10").textContent).toContain("Moved");
    expect(row("Rev 10").textContent).toContain("Was at /services/business-website-build");
  });
});
