import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { WebsitePage, WebsiteSitemapOption } from "@greatstone/shared";
import { SitemapCompareView } from "@/components/website/sitemap/SitemapCompare";
import { SitemapJourneysView, SitemapMenusView } from "@/components/website/sitemap/SitemapViews";
import { pagesLookup, type Tree } from "@/components/website/sitemap/model";

// GRE-2144: every menu item and journey step says whether its page is live.

const pages = [
  { id: "p-home", slug: "/", title: "Home", status: "published" },
  { id: "p-consultancy", slug: "/consultancy", title: "Consultancy", status: "published" },
  { id: "p-tools", slug: "/tools", title: "Tools", status: "planned" },
  { id: "p-insights", slug: "/insights", title: "Insights", status: "draft" },
  { id: "p-about", slug: "/about", title: "About", status: "published" },
  { id: "p-contact", slug: "/contact", title: "Contact", status: "planned" },
] as unknown as WebsitePage[];
const pagesById = pagesLookup(pages);

const treeA: Tree = {
  nodes: [
    { id: "n1", title: "Home", path: "/", parentId: null, order: 0, menu: "none", menuOrder: null, pageId: "p-home" },
    { id: "n2", title: "Consultancy", path: "/consultancy", parentId: "n1", order: 0, menu: "header", menuOrder: 0, pageId: "p-consultancy" },
    { id: "n3", title: "Tools", path: "/tools", parentId: "n1", order: 1, menu: "header", menuOrder: 1, pageId: "p-tools" },
    { id: "n4", title: "Insights", path: "/insights", parentId: "n1", order: 2, menu: "header", menuOrder: 2, pageId: "p-insights" },
    { id: "n5", title: "About", path: "/about", parentId: "n1", order: 3, menu: "footer", menuOrder: 0, pageId: "p-about" },
    { id: "n6", title: "Contact", path: "/contact", parentId: "n1", order: 4, menu: "footer", menuOrder: 1, pageId: "p-contact" },
    { id: "n7", title: "Privacy", path: "/privacy", parentId: "n1", order: 5, menu: "none", menuOrder: null },
  ],
  journeys: [
    { id: "j1", name: "Leader, first call to blueprint", steps: ["n1", "n2", "n3", "n6"] },
    { id: "j2", name: "Reader to subscriber", steps: ["n1", "n4", "n5"] },
  ],
};

const treeB: Tree = {
  nodes: treeA.nodes.map((node) => (node.id === "n4" ? { ...node, menu: "footer" as const, menuOrder: 2 } : node)),
  journeys: [],
};

function option(id: string, name: string, tree: Tree): WebsiteSitemapOption {
  return {
    id, companyId: "co", siteId: "site", name, description: null, tree, status: "draft",
    proposedByAgentId: null, createdByUserId: null, approvedAt: null, approvedByUserId: null, changedSinceApproval: false,
    createdAt: "2026-10-23T09:00:00.000Z", updatedAt: "2026-10-23T09:00:00.000Z",
  };
}

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="p-4 sm:p-6">{children}</div>;
}

function Menus() {
  const [tree, setTree] = useState(treeA);
  return <Frame><SitemapMenusView tree={tree} onChange={setTree} pagesById={pagesById} readOnly={false} /></Frame>;
}

function Journeys() {
  const [tree, setTree] = useState(treeA);
  return <Frame><SitemapJourneysView tree={tree} onChange={setTree} pagesById={pagesById} readOnly={false} /></Frame>;
}

function Compare() {
  return (
    <Frame>
      <SitemapCompareView
        options={[option("a", "Option A", treeA), option("b", "Option B", treeB)]}
        pagesById={pagesById}
        initialA="a"
        initialB="b"
        canApprove
        canEdit={false}
        onApprove={() => {}}
        onCopy={() => {}}
        busy={false}
      />
    </Frame>
  );
}

const meta = { title: "Website/Sitemap status", parameters: { layout: "fullscreen" } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const MenusView: Story = { render: () => <Menus /> };
export const JourneysView: Story = { render: () => <Journeys /> };
export const CompareView: Story = { render: () => <Compare /> };
