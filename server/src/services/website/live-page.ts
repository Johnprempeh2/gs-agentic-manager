import { isWebsiteHtmlPage, WEBSITE_HTML_PAGE_FORMAT, type WebsiteChrome } from "@greatstone/shared";
import { LiveDesignConflict, type LivePageSource } from "../live-design.js";

/**
 * A website page as live design's page (plan revision 8 on GRE-1831). A revision holds
 * `{ format: "gs-html", html, css }`: the page's own part, which the site renders inside
 * its shared header, nav and footer with one site stylesheet (release schema 2).
 *
 * The agent edits a light document: the page CSS in `<style id="gs-page-css">`, the page
 * HTML in `<main id="gs-page">`, the shared parts marked data-gs-shared and the site
 * stylesheet left out (it is large; the agent reads it from its own route). The editor
 * frame shows the same page with the real stylesheet, so it looks like the build.
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

/** The site's shared parts, or null before they are imported. */
export type ChromeLoader = () => Promise<WebsiteChrome | null>;

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// CSS lives inside <style>; a closing tag in it would end the element early.
const safeCss = (css: string) => css.replace(/<\/style/gi, "<\\/style");

const STARTER_CSS =
  ".gs-starter{max-width:1100px;margin:0 auto;padding:96px 24px}.gs-starter h1{font-size:48px;font-weight:800;margin:0 0 16px}" +
  ".gs-starter p{max-width:60ch;line-height:1.7;font-size:17px}";

/**
 * The home page (/) is the frozen Two Doors landing (John, 24 Oct): its hero and doors are the
 * two-doors-landing island, built in the site's code. John may add sections below it (25 Oct), so
 * chat edits are allowed, but a save must keep the island first and unchanged, and page CSS may not
 * reach into the landing (agents restyled .td-* classes through page CSS before, 5 Nov).
 */
export const HOME_LANDING_ISLAND = '<gs-island name="two-doors-landing"></gs-island>';
const HOME_GUIDANCE =
  `This is the home page. Its hero and doors are the frozen Two Doors landing, ${HOME_LANDING_ISLAND}: keep that tag first and exactly as it is, and never restyle it (no page CSS for .td-, .b-hero or gs-island). Add or edit sections only after it. A save that changes the landing is refused.`;
export function checkHomeFrozen(part: { html: string; css: string }) {
  if (!part.html.trimStart().startsWith(HOME_LANDING_ISLAND) || part.html.split("two-doors-landing").length !== 2) {
    throw new LiveDesignConflict(`The home page keeps the Two Doors landing first and unchanged (${HOME_LANDING_ISLAND}); add sections after it. Nothing was saved.`);
  }
  if (/\.td-|\.b-hero|gs-island|two-doors/i.test(part.css)) {
    throw new LiveDesignConflict("Page CSS on the home page cannot restyle the Two Doors landing (its .td- and hero classes). Nothing was saved.");
  }
}

/** What an empty or block-built page shows until it has its HTML version. */
export function websiteStarterPage(page: Pick<PageLike, "title" | "slug">, blocks: unknown) {
  const hasBlocks = blocks !== null && blocks !== undefined;
  const note = hasBlocks
    ? "This page is still in the old block format. Ask in the chat to rebuild it as an editable page, for example: \u201cRebuild this page from its blocks, same look\u201d."
    : "This page has not been designed yet. Ask in the chat to build it, for example: \u201cBuild this page in the Greatstone style\u201d.";
  // The blocks ride along as inert JSON so the agent can rebuild from them; nothing runs it.
  const data = hasBlocks
    ? `<script type="application/json" id="gs-page-blocks">${JSON.stringify(blocks).replace(/</g, "\\u003c")}</script>`
    : "";
  return { html: `<section class="gs-starter"><h1>${escapeHtml(page.title)}</h1><p>${note}</p></section>${data}`, css: STARTER_CSS };
}

/** The page's own part of a revision: HTML pages as they are, anything else as a starter. */
export function pagePart(page: Pick<PageLike, "title" | "slug">, content: unknown) {
  if (isWebsiteHtmlPage(content)) return { html: content.html, css: content.css ?? "" };
  return websiteStarterPage(page, isEmptyContent(content) ? null : content);
}

/**
 * The page as one document. `stylesheet` is the site stylesheet for the frame, or null for
 * the agent's copy (a link stands in for it).
 */
export function pageDocument(
  page: Pick<PageLike, "title" | "slug" | "companyId" | "siteId">,
  part: { html: string; css: string },
  chrome: WebsiteChrome | null,
  stylesheet: string | null,
) {
  const shared = (key: "header" | "nav" | "footer", tag: string) => {
    const doc = chrome?.chrome[key];
    if (!doc || (!doc.html.trim() && !doc.css.trim())) return "";
    const css = doc.css.trim() ? `<style data-gs-shared="${key}">${safeCss(doc.css)}</style>` : "";
    return `${css}<${tag} data-gs-shared="${key}">${doc.html}</${tag}>`;
  };
  const siteCss =
    stylesheet !== null
      ? `<style data-gs-shared="stylesheet">${safeCss(stylesheet)}</style>`
      : chrome
        ? `<link rel="stylesheet" data-gs-shared="stylesheet" href="/api/companies/${page.companyId}/website/sites/${page.siteId}/stylesheet">`
        : "";
  return [
    `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`,
    `<title>${escapeHtml(page.title)}</title>${siteCss}<style id="gs-page-css">${safeCss(part.css)}</style></head><body>`,
    shared("header", "div"),
    shared("nav", "div"),
    `<main id="gs-page">${part.html}</main>`,
    shared("footer", "div"),
    `</body></html>`,
  ].join("");
}

/** Takes the page's own part back out of the agent's document. */
export function splitPageDocument(html: string) {
  const open = html.match(/<main\b[^>]*\bid\s*=\s*["']gs-page["'][^>]*>/i);
  const close = html.toLowerCase().lastIndexOf("</main>");
  if (!open || open.index === undefined || close < open.index) {
    throw new LiveDesignConflict('Keep the page inside <main id="gs-page"> … </main>; only that part is saved.');
  }
  const body = html.slice(open.index + open[0].length, close).trim();
  if (!body) throw new LiveDesignConflict("The page came back empty, so nothing was saved.");
  const css = html.match(/<style\b[^>]*\bid\s*=\s*["']gs-page-css["'][^>]*>([\s\S]*?)<\/style\s*>/i)?.[1] ?? "";
  return { html: body, css: css.trim() };
}

/**
 * `engineOrigin`: the site's editor host (its development deploy). When set, the editor frames the
 * site's own /live-design route there, so the real engine renders the draft with every island
 * running; GSAM hands it the draft (GET …/live-draft) through the frame protocol. Without it, GSAM
 * renders the page itself in its sandbox.
 */
export function websitePageSource(store: Store, page: PageLike, loadChrome: ChromeLoader, engineOrigin: string | null = null): LivePageSource {
  const part = async (revisionId: string) => {
    const found = await store.readRevision(page.companyId, page.documentId, revisionId);
    if (!found) throw new LiveDesignConflict("That version of the page is gone.");
    return pagePart(page, found.content);
  };
  return {
    kind: "website-page",
    label: `${page.title} (${page.slug})`,
    guidance: [
      `This is the website page ${page.slug} ("${page.title}"). Only what is inside <main id="gs-page"> and the CSS in <style id="gs-page-css"> is saved: that is the page. Return the whole document with those two kept, under 2 MB.`,
      "The header, nav and footer (data-gs-shared) and the site stylesheet are shared by every page: never change or copy them into the page. Use the site's existing classes and tokens from the stylesheet (its link is in the head) and DESIGN.md before adding page CSS, and keep page CSS scoped to classes on this page.",
      "No scripts, no inline event handlers, no style attributes, no outside frames and nothing loaded from the internet: the site's sanitiser removes them. Working parts (forms, quotes, account entry, product lists, the 3D stone, animations) are islands placed with <gs-island>. Images come from the site's media library; when the design needs one it does not have (a real client logo, a white or dark variant, a photo, an icon, a generated background), get or make it and add it to the library as a draft by following the design-assets skill (GET /api/skills/design-assets), then use its /media/ path. Logos are always the real files, never drawn. Before placing any image, look at the image itself: light logos go on dark tiles, dark or colour logos on light ones, and nothing is faded with opacity.",
      "When asked for an element the site has no island for (a carousel, tabs, an accordion, a reveal, a ticker), build it script-free in page HTML and CSS rather than refusing: a carousel is a scroll-snap row with anchor links to each slide (#id targets) for arrows or dots; tabs and accordions use <details>/<summary> or :target; motion uses CSS animations with a prefers-reduced-motion fallback. Keep it keyboard reachable and labelled, and say in one line what a script-free version cannot do (for example auto-rotate) if that was asked for.",
      'The site adds behaviour to marked-up HTML. A full carousel: <section data-behaviour="carousel" data-autoplay="6000" aria-roledescription="carousel" aria-label="…"> holding a scroll-snap <div data-carousel-track> whose children are the slides, buttons with data-carousel-prev / data-carousel-next (aria-label), optional data-carousel-dot="0", "1"… buttons and a data-carousel-pause button with aria-pressed="false". It rotates only on the published site, pauses on hover, focus and reduced motion, and swipes without script; style the active slide with .is-active and the current dot with [aria-current].',
      "Never answer that something cannot be built. When a request needs behaviour HTML and CSS cannot give (live data, a new kind of form, a new interaction), build the best script-free version now, then create one issue in the website project assigned to Keystone, titled \"Website behaviour: <what>\", describing the markup you used and what the behaviour must add, and tell John in one line that the fuller version is on its way with that issue's key. Check for an open issue with the same title first.",
      "Before making versions, check that what John picked can be saved: anything rendered by a <gs-island> (for example the whole Two Doors landing) lives in the site's code, not in this page. If it is inside an island, make no versions: create that website-behaviour issue as above, then reply with an error field (it closes the request) saying in one line that this part is built in code so a change would not save here, and the issue key that will build it.",
      "If the page is a starter with a gs-page-blocks script, rebuild it from those blocks with the same words and order, then drop that script, but only when John asks for that rebuild, and never for the home page (/), which John has frozen.",
      ...(page.slug === "/" ? [HOME_GUIDANCE] : []),
    ].join(" "),
    frameSrc: (revisionId) =>
      engineOrigin
        ? `${engineOrigin}/live-design#revision=${encodeURIComponent(revisionId)}`
        : `/api/companies/${page.companyId}/website/sites/${page.siteId}/pages/${page.id}/live-frame?revision=${encodeURIComponent(revisionId)}`,
    read: async (revisionId) => pageDocument(page, await part(revisionId), await loadChrome(), null),
    version: async (revisionId) => (await store.readRevision(page.companyId, page.documentId, revisionId))?.revisionNumber ?? null,
    save: async (html, agentId) => {
      const content = { format: WEBSITE_HTML_PAGE_FORMAT, ...splitPageDocument(html) };
      if (page.slug === "/") checkHomeFrozen(content);
      const doc = await store.readDocument(page.companyId, page.documentId);
      if (!doc?.latestRevisionId) throw new LiveDesignConflict("The page is gone.");
      const result = await store.saveRevision({
        companyId: page.companyId,
        documentId: page.documentId,
        content,
        baseRevisionId: doc.latestRevisionId,
        changeSummary: "Live design",
        actor: { agentId, userId: null },
      });
      if (result.state !== "saved") throw new LiveDesignConflict(result.message);
      return result.revisionId;
    },
  };
}

/**
 * The frame's document for a revision: the page with the real site stylesheet, as the build
 * shows it. `assetOrigin` (the site's preview address) serves the site's own images and fonts,
 * whose paths the page keeps site-relative; only the frame's copy points them there.
 * `/media/` files come from GSAM's own copy of the site's media entries instead, so an image
 * added since the last release shows too (GRE-4265). `signMedia` gives each such link its signature.
 */
export async function websitePageFrame(
  store: Store,
  page: PageLike,
  loadChrome: ChromeLoader,
  revisionId: string,
  assetOrigin: string | null,
  signMedia?: (file: string) => string | null,
) {
  const found = await store.readRevision(page.companyId, page.documentId, revisionId);
  if (!found) throw new LiveDesignConflict("That version of the page is gone.");
  const chrome = await loadChrome();
  const doc = pageDocument(page, pagePart(page, found.content), chrome, chrome?.stylesheet ?? "");
  // The sandboxed frame sends no sign-in cookie, so each media link carries its own signature.
  const media = `/api/companies/${page.companyId}/website/sites/${page.siteId}/media/`;
  const withMedia = doc.replace(/(["'(\s,])\/media\/([a-f0-9]{64}\.[a-z0-9]{1,8}(?![\w.?#]))?/g, (_match, lead: string, file?: string) => {
    if (!file) return `${lead}${media}`;
    const sig = signMedia?.(file);
    return `${lead}${media}${file}${sig ? `?sig=${sig}` : ""}`;
  });
  return assetOrigin ? withMedia.replace(/(["'(\s,])\/(assets|fonts|motion)\//g, `$1${assetOrigin}/$2/`) : withMedia;
}

/** The draft the site's /live-design route renders: the page's own part, its shared parts and the stylesheet. */
export async function websitePageDraft(store: Store, page: PageLike, loadChrome: ChromeLoader, revisionId: string) {
  const found = await store.readRevision(page.companyId, page.documentId, revisionId);
  if (!found) throw new LiveDesignConflict("That version of the page is gone.");
  const chrome = await loadChrome();
  return {
    page: { ...pagePart(page, found.content), slug: page.slug, path: page.slug, title: page.title },
    chrome: chrome?.chrome ?? null,
    stylesheet: chrome?.stylesheet ?? null,
  };
}

/** The origin of a site address, or null when there is none or it is not https. */
export function siteAssetOrigin(url: string | null | undefined) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** A page created from the sitemap starts with empty content: no blocks to rebuild from. */
function isEmptyContent(content: unknown) {
  if (content === null || content === undefined) return true;
  if (typeof content !== "object") return false;
  const record = content as { content?: unknown; root?: { props?: Record<string, unknown> } };
  const blocks = Array.isArray(record.content) ? record.content : null;
  return Object.keys(content).length === 0 || (blocks !== null && blocks.length === 0);
}
