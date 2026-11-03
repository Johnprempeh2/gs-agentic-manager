import { and, eq, isNull } from "drizzle-orm";
import { websiteEntry, websitePage, type Db } from "@greatstone/db";
import {
  WEBSITE_CHROME_COLLECTION,
  WEBSITE_CHROME_KEYS,
  WEBSITE_HTML_PAGE_FORMAT,
  type WebsiteChrome,
  type WebsiteChromeKey,
} from "@greatstone/shared";
import type { websiteModuleService } from "./module.js";

/**
 * The site's shared parts for release schema 2 (plan revision 8 on GRE-1831): header, nav and
 * footer documents and the site stylesheet, kept as entries of the reserved `_chrome`
 * collection so they get revisions, review and publish like any entry.
 */

type Service = ReturnType<typeof websiteModuleService>;
type Which = "latest" | "released";
const STYLESHEET_KEY = "stylesheet";

const str = (value: unknown) => (typeof value === "string" ? value : "");

/** The shared parts at their latest (editing) or released (publish) revisions; null before any are imported. */
export async function loadWebsiteChrome(db: Db, service: Service, companyId: string, siteId: string, which: Which = "latest"): Promise<WebsiteChrome | null> {
  const rows = await db
    .select()
    .from(websiteEntry)
    .where(and(eq(websiteEntry.companyId, companyId), eq(websiteEntry.siteId, siteId), eq(websiteEntry.collection, WEBSITE_CHROME_COLLECTION), isNull(websiteEntry.archivedAt)));
  if (rows.length === 0) return null;
  const read = async (key: string) => {
    const row = rows.find((r) => r.entryKey === key);
    if (!row) return {};
    const revisionId = which === "latest" ? (await service.store.readDocument(companyId, row.documentId))?.latestRevisionId : (row.approvedRevisionId ?? row.publishedRevisionId);
    if (!revisionId) return {};
    const found = await service.store.readRevision(companyId, row.documentId, revisionId);
    return (found?.content ?? {}) as Record<string, unknown>;
  };
  const chrome = {} as WebsiteChrome["chrome"];
  for (const key of WEBSITE_CHROME_KEYS) {
    const content = await read(key);
    chrome[key] = { html: str(content.html), css: str(content.css) };
  }
  return { chrome, stylesheet: str((await read(STYLESHEET_KEY)).css) };
}

/** A schema 2 release file, as greatstone-website's one-time export writes it (GRE-3778). */
export interface HtmlReleaseImport {
  schema: 2;
  stylesheet: string;
  chrome: Partial<Record<WebsiteChromeKey, { html?: string; css?: string }>>;
  pages: Array<{
    slug: string;
    title: string;
    html: string;
    css?: string;
    seo?: Record<string, unknown>;
    menu?: string;
    menuOrder?: number | null;
    navOrder?: number | null;
  }>;
}

export interface HtmlImportResult {
  /** Live paths that moved to their sitemap path, each with a draft 301 redirect. */
  redirects: Array<{ from: string; to: string }>;
  updated: string[];
  created: string[];
  unchanged: string[];
  chrome: string[];
}

/**
 * Brings an exported schema 2 release in as new revisions: each page by its path (a new page
 * when the path is new) and each shared part. Pages go back to draft for review; nothing is
 * published. Running it again with the same file changes nothing.
 */
export async function importHtmlRelease(
  db: Db,
  service: Service,
  site: { companyId: string; id: string },
  file: HtmlReleaseImport,
  actor: { agentId: string | null; userId: string | null },
  /** Live path to sitemap path, for pages the approved sitemap moves (e.g. /dx-consultancy to /consultancy). */
  paths: Record<string, string> = {},
): Promise<HtmlImportResult> {
  const result: HtmlImportResult = { redirects: [], updated: [], created: [], unchanged: [], chrome: [] };
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  const saveNew = async (row: { companyId: string; documentId: string }, content: unknown, label: string) => {
    const doc = await service.store.readDocument(row.companyId, row.documentId);
    if (!doc?.latestRevisionId) throw new Error(`${label}: its document is gone`);
    const current = await service.store.readRevision(row.companyId, row.documentId, doc.latestRevisionId);
    if (same(current?.content, content)) return false;
    const saved = await service.store.saveRevision({
      companyId: row.companyId,
      documentId: row.documentId,
      content,
      baseRevisionId: doc.latestRevisionId,
      changeSummary: "Imported as an HTML page (GRE-3778 export)",
      actor,
    });
    if (saved.state !== "saved") throw new Error(`${label}: ${saved.message}`);
    return true;
  };

  const pages = await service.listPages(site.companyId, site.id);
  const redirects = await service.listEntries(site.companyId, site.id, "redirect");
  for (const page of file.pages) {
    const content = { format: WEBSITE_HTML_PAGE_FORMAT, html: page.html, css: page.css ?? "" };
    const slug = paths[page.slug] ?? page.slug;
    if (slug !== page.slug) {
      // The old address keeps working: a 301 to the sitemap path, reviewed and published with the pages.
      const key = `import${page.slug.replace(/\//g, "-")}`;
      if (!redirects.some((r) => r.entryKey === key)) {
        await service.createEntry(site.companyId, site.id, { collection: "redirect", entryKey: key, content: { id: key, from: page.slug, to: slug, status: 301 } } as never, actor);
      }
      result.redirects.push({ from: page.slug, to: slug });
    }
    const existing = pages.find((p) => p.slug === slug && !p.archivedAt);
    if (!existing) {
      // A new page sits under its nearest existing parent path in the sitemap.
      const parent = pages
        .filter((p) => !p.archivedAt && p.slug !== "/" && slug.startsWith(`${p.slug}/`))
        .sort((a, b) => b.slug.length - a.slug.length)[0];
      await service.createPage(site.companyId, site.id, {
        slug,
        parentPageId: parent?.id ?? null,
        title: page.title,
        seo: page.seo ?? {},
        menu: (page.menu as "header" | "footer" | "none" | undefined) ?? "none",
        menuOrder: page.menuOrder ?? null,
        navOrder: page.navOrder ?? null,
        content,
      } as never, actor);
      result.created.push(slug);
      continue;
    }
    const row = await service.getPageRow(site.companyId, site.id, existing.id);
    if (!row) continue;
    if (await saveNew(row, content, slug)) {
      // The new revision needs review before it can be published.
      await db.update(websitePage).set({ status: "draft", updatedAt: new Date() }).where(and(eq(websitePage.companyId, row.companyId), eq(websitePage.id, row.id)));
      result.updated.push(slug);
    } else result.unchanged.push(slug);
  }

  const parts: Array<[string, Record<string, string>]> = [
    ...WEBSITE_CHROME_KEYS.map((key) => [key, { html: file.chrome[key]?.html ?? "", css: file.chrome[key]?.css ?? "" }] as [string, Record<string, string>]),
    [STYLESHEET_KEY, { css: file.stylesheet }],
  ];
  const entries = await service.listEntries(site.companyId, site.id, WEBSITE_CHROME_COLLECTION);
  for (const [key, content] of parts) {
    const existing = entries.find((e) => e.entryKey === key);
    if (!existing) {
      await service.createEntry(site.companyId, site.id, { collection: WEBSITE_CHROME_COLLECTION, entryKey: key, content } as never, actor);
      result.chrome.push(key);
      continue;
    }
    const row = await service.getEntryRow(site.companyId, site.id, existing.id);
    if (row && (await saveNew(row, content, `${WEBSITE_CHROME_COLLECTION}/${key}`))) result.chrome.push(key);
  }
  return result;
}
