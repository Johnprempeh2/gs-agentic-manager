import { isWebsiteHtmlPage, WEBSITE_HTML_PAGE_FORMAT } from "@greatstone/shared";
import { LiveDesignConflict, type LivePageSource } from "../live-design.js";

/**
 * A website page as live design's page (plan revision 8 on GRE-1831): its
 * revisions are the versions, a save is a new revision of `{ format: "gs-html", html }`.
 */

interface PageLike {
  id: string;
  companyId: string;
  siteId: string;
  documentId: string;
  title: string;
  slug: string;
}

interface Store {
  readRevision(companyId: string, documentId: string, revisionId: string): Promise<{ revisionNumber: number; content: unknown } | null>;
  readDocument(companyId: string, documentId: string): Promise<{ latestRevisionId: string | null } | null>;
  saveRevision(input: {
    companyId: string;
    documentId: string;
    content: unknown;
    baseRevisionId: string;
    changeSummary?: string | null;
    actor: { agentId: string | null; userId: string | null };
  }): Promise<{ state: "saved"; revisionId: string } | { state: "conflict" | "failed"; message: string }>;
}

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const STARTER_STYLE =
  "body{margin:0;font-family:Montserrat,system-ui,sans-serif;background:#121212;color:#f5f5f5}" +
  "main{max-width:1100px;margin:0 auto;padding:96px 24px}h1{font-size:48px;font-weight:800;margin:0 0 16px;letter-spacing:-.01em}" +
  "p{color:#b0b0b0;max-width:60ch;line-height:1.7;font-size:17px}";

/** What an empty or block-built page shows until the agent builds its HTML version. */
export function websiteStarterPage(page: Pick<PageLike, "title" | "slug">, blocks: unknown) {
  const hasBlocks = blocks !== null && blocks !== undefined;
  const note = hasBlocks
    ? "This page was built with blocks. Ask in the chat to rebuild it as an editable page, for example: \u201cRebuild this page from its blocks, same look\u201d."
    : "This page has not been designed yet. Ask in the chat to build it, for example: \u201cBuild this page in the Greatstone style\u201d.";
  // The blocks ride along as inert JSON so the agent can rebuild from them; nothing runs it.
  const data = hasBlocks
    ? `<script type="application/json" id="gs-page-blocks">${JSON.stringify(blocks).replace(/</g, "\\u003c")}</script>`
    : "";
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(page.title)}</title><style>${STARTER_STYLE}</style></head><body><main><h1>${escapeHtml(page.title)}</h1><p>${note}</p></main>${data}</body></html>`;
}

export function websitePageSource(store: Store, page: PageLike): LivePageSource {
  return {
    kind: "website-page",
    label: `${page.title} (${page.slug})`,
    guidance: [
      `This is the website page ${page.slug} ("${page.title}"). Save the complete page as one HTML document under 2 MB.`,
      "Use the site's look from DESIGN.md (Greatstone brand unless told otherwise), images from the site's media library rather than embedded data, and nothing loaded from the internet.",
      "Keep any element marked data-gs-shared (header, footer, navigation) exactly as it is. If the page is a starter with a gs-page-blocks script, rebuild the page from those blocks with the same words and order, then drop that script.",
    ].join(" "),
    frameSrc: (revisionId) =>
      `/api/companies/${page.companyId}/website/sites/${page.siteId}/pages/${page.id}/live-frame?revision=${encodeURIComponent(revisionId)}`,
    read: async (revisionId) => {
      const found = await store.readRevision(page.companyId, page.documentId, revisionId);
      if (!found) throw new LiveDesignConflict("That version of the page is gone.");
      return isWebsiteHtmlPage(found.content) ? found.content.html : websiteStarterPage(page, isEmptyContent(found.content) ? null : found.content);
    },
    save: async (html, agentId) => {
      const doc = await store.readDocument(page.companyId, page.documentId);
      if (!doc?.latestRevisionId) throw new LiveDesignConflict("The page is gone.");
      const result = await store.saveRevision({
        companyId: page.companyId,
        documentId: page.documentId,
        content: { format: WEBSITE_HTML_PAGE_FORMAT, html },
        baseRevisionId: doc.latestRevisionId,
        changeSummary: "Live design",
        actor: { agentId, userId: null },
      });
      if (result.state !== "saved") throw new LiveDesignConflict(result.message);
      return result.revisionId;
    },
  };
}

/** A page created from the sitemap starts with empty content: no blocks to rebuild from. */
function isEmptyContent(content: unknown) {
  if (content === null || content === undefined) return true;
  if (typeof content !== "object") return false;
  const record = content as { content?: unknown; root?: { props?: Record<string, unknown> } };
  const blocks = Array.isArray(record.content) ? record.content : null;
  return Object.keys(content).length === 0 || (blocks !== null && blocks.length === 0);
}
