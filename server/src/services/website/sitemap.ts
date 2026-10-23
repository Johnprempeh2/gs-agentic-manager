import { and, asc, eq, inArray, isNull, ne } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { documents, websitePage, websiteSitemapOption } from "@greatstone/db";
import {
  sitemapTreeProblems,
  type CreateWebsiteSitemapOption,
  type UpdateWebsiteSitemapOption,
  type WebsitePageSeo,
  type WebsiteSitemapApproveResult,
  type WebsiteSitemapNode,
  type WebsiteSitemapOption,
  type WebsiteSitemapOptionStatus,
  type WebsiteSitemapTree,
} from "@greatstone/shared";
import { conflict, unprocessable } from "../../errors.js";
import { serialiseWebsiteContent, toWebsitePage, websiteDocumentStore, type SiteRow, type WebsiteActor } from "./module.js";

// Sitemap options (GRE-2111). An option is a JSON tree in one row: cheap to
// keep many, compare and copy between, and it never touches pages. Approving
// one (a person with website:publish; the route checks) writes the tree into
// the site's pages in one transaction: new pages are `planned`, pages the
// tree no longer names are archived (never deleted).

type OptionRow = typeof websiteSitemapOption.$inferSelect;
type PageRow = typeof websitePage.$inferSelect;

const EMPTY_PAGE = { root: { props: {} }, content: [], zones: {} };

export function toWebsiteSitemapOption(row: OptionRow): WebsiteSitemapOption {
  return {
    id: row.id,
    companyId: row.companyId,
    siteId: row.siteId,
    name: row.name,
    description: row.description,
    tree: row.tree as unknown as WebsiteSitemapTree,
    status: row.status as WebsiteSitemapOptionStatus,
    proposedByAgentId: row.proposedByAgentId,
    createdByUserId: row.createdByUserId,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    approvedByUserId: row.approvedByUserId,
    changedSinceApproval: row.status === "approved" && !!row.approvedAt && row.updatedAt.getTime() > row.approvedAt.getTime(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Parents before children, siblings by order. */
function parentsFirst(nodes: WebsiteSitemapNode[]): WebsiteSitemapNode[] {
  const children = new Map<string | null, WebsiteSitemapNode[]>();
  for (const node of nodes) {
    const list = children.get(node.parentId) ?? [];
    list.push(node);
    children.set(node.parentId, list);
  }
  const out: WebsiteSitemapNode[] = [];
  const walk = (parentId: string | null) => {
    for (const node of (children.get(parentId) ?? []).sort((x, y) => x.order - y.order)) {
      out.push(node);
      walk(node.id);
    }
  };
  walk(null);
  return out;
}

function escapeXml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** sitemap.xml for a site's live (not archived), non-noindex pages, in path order. */
export function buildSitemapXml(domain: string, pages: Array<Pick<PageRow, "slug" | "seo" | "updatedAt">>): string {
  const urls = pages
    .filter((page) => (page.seo as WebsitePageSeo | null)?.noindex !== true)
    .sort((x, y) => x.slug.localeCompare(y.slug))
    .map((page) => {
      const loc = escapeXml(`https://${domain}${page.slug === "/" ? "/" : page.slug}`);
      return `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${page.updatedAt.toISOString().slice(0, 10)}</lastmod>\n  </url>`;
    });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}${urls.length ? "\n" : ""}</urlset>\n`;
}

export function websiteSitemapService(db: Db) {
  const store = websiteDocumentStore(db);

  async function list(companyId: string, siteId: string, includeArchived = false) {
    const rows = await db
      .select()
      .from(websiteSitemapOption)
      .where(
        and(
          eq(websiteSitemapOption.companyId, companyId),
          eq(websiteSitemapOption.siteId, siteId),
          includeArchived ? undefined : ne(websiteSitemapOption.status, "archived"),
        ),
      )
      .orderBy(asc(websiteSitemapOption.createdAt));
    return rows.map(toWebsiteSitemapOption);
  }

  async function getRow(companyId: string, siteId: string, optionId: string) {
    const [row] = await db
      .select()
      .from(websiteSitemapOption)
      .where(and(eq(websiteSitemapOption.companyId, companyId), eq(websiteSitemapOption.siteId, siteId), eq(websiteSitemapOption.id, optionId)));
    return row ?? null;
  }

  async function create(site: SiteRow, input: CreateWebsiteSitemapOption, actor: WebsiteActor) {
    const [row] = await db
      .insert(websiteSitemapOption)
      .values({
        companyId: site.companyId,
        siteId: site.id,
        name: input.name,
        description: input.description ?? null,
        tree: input.tree as unknown as Record<string, unknown>,
        proposedByAgentId: actor.agentId,
        createdByUserId: actor.userId,
      })
      .returning();
    return row;
  }

  async function update(row: OptionRow, input: UpdateWebsiteSitemapOption) {
    if (row.status === "archived") throw unprocessable("This option is archived. Copy it into a new option to change it.", { code: "website_sitemap_option_archived" });
    if (input.baseUpdatedAt && new Date(input.baseUpdatedAt).getTime() !== row.updatedAt.getTime()) {
      throw conflict("Someone changed this option after you opened it. Reload it, then make your change again.", {
        code: "website_sitemap_option_conflict",
        updatedAt: row.updatedAt.toISOString(),
      });
    }
    const [updated] = await db
      .update(websiteSitemapOption)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.tree ? { tree: input.tree as unknown as Record<string, unknown> } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(websiteSitemapOption.companyId, row.companyId), eq(websiteSitemapOption.id, row.id)))
      .returning();
    return updated;
  }

  async function archive(row: OptionRow) {
    if (row.status === "approved") throw unprocessable("The approved option cannot be archived. Approve another option first.", { code: "website_sitemap_option_approved" });
    const [updated] = await db
      .update(websiteSitemapOption)
      .set({ status: "archived", updatedAt: new Date() })
      .where(and(eq(websiteSitemapOption.companyId, row.companyId), eq(websiteSitemapOption.id, row.id)))
      .returning();
    return updated;
  }

  /**
   * Write the option's tree into the site's pages and make it the approved option.
   * Match order per node: its pageId (any page of this site, archived ones come back),
   * then a live page with the same path, else a new planned page.
   */
  async function approve(site: SiteRow, row: OptionRow, actor: WebsiteActor): Promise<WebsiteSitemapApproveResult> {
    if (row.status === "archived") throw unprocessable("This option is archived.", { code: "website_sitemap_option_archived" });
    const tree = row.tree as unknown as WebsiteSitemapTree;
    const problems = sitemapTreeProblems(tree);
    if (problems.length) throw unprocessable(problems[0]!, { code: "website_sitemap_tree_invalid", problems });
    const emptyBody = serialiseWebsiteContent(EMPTY_PAGE) as { body: string };

    return db.transaction(async (tx) => {
      const pages = await tx
        .select()
        .from(websitePage)
        .where(and(eq(websitePage.companyId, site.companyId), eq(websitePage.siteId, site.id)));
      const byId = new Map(pages.map((page) => [page.id, page]));
      const liveBySlug = new Map(pages.filter((page) => !page.archivedAt).map((page) => [page.slug, page]));
      const ordered = parentsFirst(tree.nodes);

      const pageForNode = new Map<string, PageRow>();
      for (const node of ordered) {
        const existing = (node.pageId ? byId.get(node.pageId) : undefined) ?? liveBySlug.get(node.path);
        if (existing && ![...pageForNode.values()].includes(existing)) pageForNode.set(node.id, existing);
      }
      const kept = new Set([...pageForNode.values()].map((page) => page.id));
      const now = new Date();
      const summary = { created: 0, updated: 0, archived: 0 };

      // 1. Archive live pages the tree no longer names, and detach every parent link,
      //    so paths and parents can be rewritten freely below.
      const removed = pages.filter((page) => !page.archivedAt && !kept.has(page.id));
      if (removed.length) {
        await tx
          .update(websitePage)
          .set({ archivedAt: now, parentPageId: null, updatedAt: now })
          .where(and(eq(websitePage.companyId, site.companyId), inArray(websitePage.id, removed.map((page) => page.id))));
        summary.archived = removed.length;
      }
      if (kept.size) {
        await tx
          .update(websitePage)
          .set({ parentPageId: null })
          .where(and(eq(websitePage.companyId, site.companyId), inArray(websitePage.id, [...kept])));
        // Park kept pages on unique temporary paths so two pages can swap paths.
        for (const page of pageForNode.values()) {
          await tx.update(websitePage).set({ slug: `${page.slug}#moving-${page.id}` }).where(eq(websitePage.id, page.id));
        }
      }

      // 2. Parents first: update or create each node's page.
      const pageIdForNode = new Map<string, string>();
      for (const node of ordered) {
        const parentPageId = node.parentId ? pageIdForNode.get(node.parentId) ?? null : null;
        const existing = pageForNode.get(node.id);
        const fields = {
          slug: node.path,
          title: node.title,
          parentPageId,
          menu: node.menu,
          menuOrder: node.menuOrder,
          navOrder: node.order,
          updatedAt: now,
        };
        if (existing) {
          const seo = { ...((existing.seo ?? {}) as WebsitePageSeo), noindex: node.noindex === true };
          if (node.seoTitle) seo.title = node.seoTitle;
          await tx
            .update(websitePage)
            .set({ ...fields, seo: seo as Record<string, unknown>, archivedAt: null })
            .where(and(eq(websitePage.companyId, site.companyId), eq(websitePage.id, existing.id)));
          pageIdForNode.set(node.id, existing.id);
          summary.updated += 1;
        } else {
          const doc = await store.createDocument(tx, { companyId: site.companyId, title: node.title, format: "puck-json", body: emptyBody.body, actor });
          const seo: WebsitePageSeo = { noindex: node.noindex === true, ...(node.seoTitle ? { title: node.seoTitle } : {}) };
          const [created] = await tx
            .insert(websitePage)
            .values({ companyId: site.companyId, siteId: site.id, status: "planned", seo: seo as Record<string, unknown>, documentId: doc.id, ...fields })
            .returning();
          pageIdForNode.set(node.id, created!.id);
          summary.created += 1;
        }
      }

      // 3. The option remembers its pages, becomes the approved one; the old one goes back to draft.
      const approvedTree: WebsiteSitemapTree = {
        ...tree,
        nodes: tree.nodes.map((node) => ({ ...node, pageId: pageIdForNode.get(node.id) ?? null })),
      };
      await tx
        .update(websiteSitemapOption)
        .set({ status: "draft", updatedAt: now })
        .where(and(eq(websiteSitemapOption.siteId, site.id), eq(websiteSitemapOption.status, "approved"), ne(websiteSitemapOption.id, row.id)));
      const [option] = await tx
        .update(websiteSitemapOption)
        .set({ tree: approvedTree as unknown as Record<string, unknown>, status: "approved", approvedAt: now, approvedByUserId: actor.userId, updatedAt: now })
        .where(and(eq(websiteSitemapOption.companyId, site.companyId), eq(websiteSitemapOption.id, row.id)))
        .returning();

      const livePages = await tx
        .select({ page: websitePage, latestRevisionId: documents.latestRevisionId, latestRevisionNumber: documents.latestRevisionNumber })
        .from(websitePage)
        .innerJoin(documents, eq(documents.id, websitePage.documentId))
        .where(and(eq(websitePage.companyId, site.companyId), eq(websitePage.siteId, site.id), isNull(websitePage.archivedAt)))
        .orderBy(asc(websitePage.slug));
      return {
        option: toWebsiteSitemapOption(option!),
        pages: livePages.map((entry) => toWebsitePage(entry.page, entry)),
        summary,
      };
    });
  }

  async function sitemapXml(site: SiteRow) {
    const pages = await db
      .select({ slug: websitePage.slug, seo: websitePage.seo, updatedAt: websitePage.updatedAt })
      .from(websitePage)
      .where(and(eq(websitePage.companyId, site.companyId), eq(websitePage.siteId, site.id), isNull(websitePage.archivedAt)));
    return buildSitemapXml(site.domain, pages);
  }

  return { list, getRow, create, update, archive, approve, sitemapXml };
}
