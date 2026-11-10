import type { Meta, StoryObj } from "@storybook/react-vite";
import type { WebsitePage, WebsiteSite } from "@greatstone/shared";
import { SitemapNow } from "@/components/website/sitemap/SitemapNow";
import type { Tree } from "@/components/website/sitemap/model";

// "Site now": the built pages of the Greatstone site as GSAM held them on 10 Nov 2026,
// with a sample of the sitemap ideas nobody has built.

type Row = [slug: string, title: string, status: WebsitePage["status"], menu: WebsitePage["menu"], navOrder: number, noindex?: boolean];

const BUILT: Row[] = [
  ["/", "Two Doors", "approved", "none", 0],
  ["/consultancy", "DX Consultancy", "approved", "header", 0],
  ["/consultancy/how-we-help", "How we help", "approved", "header", 0],
  ["/consultancy/services", "Services catalogue", "approved", "none", 1],
  ["/consultancy/transformation-services", "Transformation Services", "approved", "header", 1],
  ["/consultancy/industries", "Industries", "approved", "header", 3],
  ["/consultancy/how-we-work", "How we work", "approved", "none", 5],
  ["/consultancy/the-climb", "The Climb", "approved", "footer", 6],
  ["/dev-tools", "DX Dev Tools", "approved", "header", 1],
  ["/gs-agentic-manager", "GS Agentic Manager", "draft", "header", 2, true],
  ["/proof", "Proof", "approved", "header", 2],
  ["/about", "About", "approved", "header", 3],
  ["/insights", "Insights", "approved", "header", 4],
  ["/contact", "Begin the Conversation", "approved", "footer", 5],
  ["/privacy", "Privacy", "approved", "footer", 9],
  ["/cookies", "Cookies", "approved", "footer", 10],
  ["/terms", "Terms", "approved", "footer", 11],
];

const IDEAS: Row[] = [
  ["/account", "My account", "planned", "header", 20],
  ["/account/orders", "Orders", "planned", "none", 0],
  ["/account/quotes", "Quotes", "planned", "none", 1],
  ["/consultancy/ai-market-intelligence", "AI Market Intelligence", "planned", "header", 7],
  ["/consultancy/deep-dive", "Deep Dive", "planned", "none", 8],
  ["/consultancy/industries/education", "Education", "planned", "none", 0],
  ["/consultancy/industries/healthcare", "Healthcare", "planned", "none", 1],
  ["/dev-tools/brands", "Browse brands", "planned", "header", 0],
  ["/dev-tools/licences", "Licences and renewals", "planned", "header", 1],
  ["/dev-tools/trials", "Trials", "planned", "none", 2],
  ["/refunds", "Refunds", "planned", "footer", 12],
  ["/support", "Support", "planned", "footer", 13],
];

function toPages(rows: Row[]): WebsitePage[] {
  const idOf = (slug: string) => `page:${slug}`;
  const slugs = new Set(rows.map(([slug]) => slug));
  return rows.map(([slug, title, status, menu, navOrder, noindex]) => {
    const parent = slug === "/" ? null : slug.split("/").length > 2 ? slug.slice(0, slug.lastIndexOf("/")) : "/";
    return {
      id: idOf(slug), slug, title, status, menu, navOrder, menuOrder: navOrder,
      parentPageId: parent && slugs.has(parent) ? idOf(parent) : null,
      seo: { noindex: Boolean(noindex) }, archivedAt: null, publishedRevisionId: null,
      updatedAt: slug === "/" ? "2026-11-09T05:46:00.000Z" : "2026-11-08T19:47:00.000Z",
    };
  }) as unknown as WebsitePage[];
}

const pages = toPages([...BUILT, ...IDEAS]);

function treeOf(list: WebsitePage[]): Tree {
  return {
    nodes: list.map((page, order) => ({ id: `node:${page.slug}`, title: page.title, path: page.slug, parentId: null, order, menu: page.menu, menuOrder: page.menuOrder, pageId: page.id })),
    journeys: [],
  };
}

const site = { id: "site", devPreviewUrl: "https://gre3833-next-db-staging.netlify.app", livePreviewUrl: null, liveReleaseId: null } as unknown as WebsiteSite;

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="p-4 sm:p-6">{children}</div>;
}

const meta = { title: "Website/Sitemap site now", parameters: { layout: "fullscreen" } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const SiteNow: Story = {
  render: () => <Frame><SitemapNow site={site} pages={pages} approvedTree={treeOf(pages)} onEditPage={() => {}} /></Frame>,
};

/** Small previews: they draw inside GSAM only, because the preview site lets only GSAM frame it. */
export const WithPreviews: Story = {
  render: () => <Frame><SitemapNow site={site} pages={pages} approvedTree={treeOf(pages)} framing={{ devFraming: "allowed", liveFraming: "unknown" }} onEditPage={() => {}} /></Frame>,
};

/** The preview address refuses frames: text rows, and one sentence saying why. */
export const PreviewsRefused: Story = {
  render: () => <Frame><SitemapNow site={site} pages={pages} approvedTree={treeOf(pages)} framing={{ devFraming: "refused", liveFraming: "unknown" }} onEditPage={() => {}} /></Frame>,
};

/** The approved sitemap leaves Proof out and lists a Pricing page that has no page row. */
export const SitemapAndPagesDisagree: Story = {
  render: () => {
    const tree = treeOf(pages.filter((page) => page.slug !== "/proof"));
    tree.nodes.push({ id: "node:/pricing", title: "Pricing", path: "/pricing", parentId: null, order: 99, menu: "none", menuOrder: null });
    return <Frame><SitemapNow site={site} pages={pages} approvedTree={tree} onEditPage={() => {}} /></Frame>;
  },
};

export const NothingBuiltYet: Story = {
  render: () => <Frame><SitemapNow site={site} pages={toPages(IDEAS)} approvedTree={null} onEditPage={() => {}} /></Frame>,
};
