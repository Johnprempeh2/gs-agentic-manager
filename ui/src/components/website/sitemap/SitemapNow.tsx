import { useMemo, useState } from "react";
import { ExternalLink, PenLine } from "lucide-react";
import { websitePreviewAddresses, type WebsiteHomeSummary, type WebsitePage, type WebsiteSite, type WebsiteSitemapTree } from "@greatstone/shared";
import { Button } from "@/components/ui/button";
import { cn, formatDateTime } from "@/lib/utils";
import {
  BUILT_PAGE_STATES,
  builtPageRows,
  builtPageState,
  countOf,
  isBuiltPage,
  sitemapMismatches,
  type BuiltPageState,
  type SitemapMismatch,
} from "./model";
import { MENU_LABELS, Pill } from "./SitemapViews";

// "Site now": the pages that exist, from the site's real page rows and never
// from a plan. Sitemap entries nobody has built are suggestions: a separate,
// quieter group that no total counts.

const INDENT = ["", "pl-6", "pl-12", "pl-18", "pl-24"];

const STATE_ORDER: BuiltPageState[] = ["live", "changed", "review", "approved", "draft"];

export function dismissedKey(siteId: string) {
  return `gsam.sitemap.dismissed.${siteId}`;
}

function readDismissed(siteId: string): string[] {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(dismissedKey(siteId)) ?? "[]");
    return Array.isArray(stored) ? stored.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function mismatchText(entry: SitemapMismatch): string {
  if (entry.kind === "built-not-in-sitemap") return "is built, but it is not in the approved sitemap.";
  if (entry.kind === "sitemap-no-page") return "is in the approved sitemap, but there is no page for it.";
  return `is set to the ${MENU_LABELS[entry.menu ?? "header"].toLowerCase()} menu but is not built, so the menu leaves it out.`;
}

type PreviewSite = Pick<WebsiteSite, "domain" | "livePreviewUrl" | "devPreviewUrl" | "editorFrameOrigin">;

/** The address a person opens to see a page: the development preview, else the live address. */
export function pageViewUrl(site: PreviewSite, slug: string): string | null {
  const addresses = websitePreviewAddresses(site);
  try {
    return new URL(slug.replace(/^\//, ""), addresses.dev ?? addresses.live).toString();
  } catch {
    return null;
  }
}

/** What the server found when it checked whether GSAM may show the site's addresses in a frame. */
export type SitemapFraming = Pick<WebsiteHomeSummary, "liveFraming" | "devFraming">;

/** The frame check of the address `pageViewUrl` uses. Undefined: not checked yet, or the check failed. */
export function pageFraming(site: PreviewSite, framing: SitemapFraming | null | undefined) {
  return websitePreviewAddresses(site).dev ? framing?.devFraming : framing?.liveFraming;
}

// A small, still picture of the page: the real page in a frame nobody can
// click, tab into or hear, drawn at laptop width and scaled down. Scripts stay
// on because some pages show nothing until theirs run.
// ponytail: one live frame per built page, loaded as it nears the screen. Fine
// for tens of pages; a site with hundreds wants stored screenshots instead.
function PageThumb({ src }: { src: string }) {
  return (
    <div aria-hidden="true" data-testid="sitemap-now-thumb" className="relative hidden h-[100px] w-[160px] shrink-0 overflow-hidden rounded-md border border-border bg-muted sm:block">
      <iframe src={src} title="" tabIndex={-1} loading="lazy" sandbox="allow-scripts allow-same-origin" className="pointer-events-none absolute left-0 top-0 h-[800px] w-[1280px] origin-top-left scale-[0.125] border-0" />
    </div>
  );
}

export function SitemapNow({ site, pages, approvedTree, framing, onEditPage }: {
  site: WebsiteSite;
  pages: WebsitePage[];
  /** The approved sitemap, to check the real pages against. Null: none approved yet. */
  approvedTree: WebsiteSitemapTree | null;
  /** The frame check from the site's Home summary. Small previews show only when it says "allowed". */
  framing?: SitemapFraming | null;
  onEditPage?: (pageId: string) => void;
}) {
  const rows = useMemo(() => builtPageRows(pages), [pages]);
  const frameCheck = pageFraming(site, framing);
  const mismatches = useMemo(() => sitemapMismatches(pages, approvedTree), [pages, approvedTree]);
  const suggested = useMemo(
    () => pages.filter((page) => !page.archivedAt && !isBuiltPage(page)).sort((a, b) => a.slug.localeCompare(b.slug)),
    [pages],
  );
  const [dismissed, setDismissed] = useState(() => readDismissed(site.id));
  const [showDismissed, setShowDismissed] = useState(false);
  const setDismissedFor = (pageId: string, hide: boolean) => {
    const next = hide ? [...dismissed, pageId] : dismissed.filter((entry) => entry !== pageId);
    setDismissed(next);
    try {
      window.localStorage.setItem(dismissedKey(site.id), JSON.stringify(next));
    } catch {
      // Storage blocked: the choice lasts for this visit.
    }
  };

  const stateCounts = STATE_ORDER.map((state) => ({ state, count: rows.filter((row) => builtPageState(row.page) === state).length })).filter((entry) => entry.count > 0);
  const hidden = suggested.filter((page) => dismissed.includes(page.id));
  const shown = showDismissed ? suggested : suggested.filter((page) => !dismissed.includes(page.id));
  const titleBySlug = new Map(pages.map((page) => [page.slug, page.title]));
  const groups = new Map<string, WebsitePage[]>();
  for (const page of shown) {
    const top = `/${page.slug.split("/")[1] ?? ""}`;
    groups.set(top, [...(groups.get(top) ?? []), page]);
  }

  return (
    <div className="space-y-6" data-testid="sitemap-now">
      <section aria-labelledby="sitemap-now-built" className="space-y-3">
        <div className="space-y-1">
          <h2 id="sitemap-now-built" className="text-sm font-semibold">Built pages</h2>
          <p className="text-sm text-muted-foreground" data-testid="sitemap-now-summary">
            {rows.length === 0 ? "No page is built yet." : (
              <>
                {countOf(rows.length, "page")} {rows.length === 1 ? "is" : "are"} built: {stateCounts.map((entry) => `${entry.count} ${BUILT_PAGE_STATES[entry.state].label.toLowerCase()}`).join(", ")}.
              </>
            )}
            {rows.length > 0 && !site.liveReleaseId ? " No release has gone live from GSAM for this site yet, so no page reads as live here." : ""}
            {rows.length > 0 && frameCheck === "refused" ? " Small previews are off: the site's preview address does not let GSAM show it in a frame. View opens each page in a new tab." : ""}
          </p>
        </div>
        {rows.length > 0 ? (
          <ul className="divide-y divide-border rounded-xl border border-border" aria-label="Built pages">
            {rows.map(({ page, depth }) => {
              const state = BUILT_PAGE_STATES[builtPageState(page)];
              const viewUrl = pageViewUrl(site, page.slug);
              return (
                <li key={page.id} data-testid="sitemap-now-page" className={cn("flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2", INDENT[Math.min(depth, INDENT.length - 1)])}>
                  {viewUrl && frameCheck === "allowed" ? <PageThumb src={viewUrl} /> : null}
                  <div className="min-w-40 flex-1">
                    <p className={cn("break-words text-sm leading-6", depth === 0 ? "font-semibold" : "font-medium")}>{page.title}</p>
                    <p className="break-all font-mono text-xs text-muted-foreground">{page.slug}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Pill className={state.tone}>{state.label}</Pill>
                    {page.seo.noindex ? <Pill className="bg-status-neutral-soft text-status-neutral-foreground">Hidden from search</Pill> : null}
                    <span>{page.menu === "none" ? "Not in a menu" : `${MENU_LABELS[page.menu]} menu`}</span>
                    <span>Changed {formatDateTime(page.updatedAt)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {onEditPage ? (
                      <Button type="button" variant="outline" size="xs" onClick={() => onEditPage(page.id)} aria-label={`Edit page ${page.title}`}>
                        <PenLine aria-hidden="true" />
                        Edit page
                      </Button>
                    ) : null}
                    {viewUrl ? (
                      <Button asChild variant="ghost" size="xs">
                        <a href={viewUrl} target="_blank" rel="noreferrer" aria-label={`View ${page.title} in a new tab`}>
                          <ExternalLink aria-hidden="true" />
                          View
                        </a>
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>

      {mismatches.length > 0 ? (
        <section aria-labelledby="sitemap-now-attention" className="space-y-2 rounded-xl border border-border p-3" data-testid="sitemap-now-attention">
          <h2 id="sitemap-now-attention" className="flex flex-wrap items-center gap-2 text-sm font-semibold">
            Needs attention
            <Pill className="bg-status-warning-soft text-status-warning-foreground">{mismatches.length}</Pill>
          </h2>
          <p className="text-sm text-muted-foreground">Where the approved sitemap and the real pages disagree.</p>
          <ul className="space-y-1 text-sm">
            {mismatches.map((entry) => (
              <li key={`${entry.kind}:${entry.path}`}>
                <span className="font-medium">{entry.title}</span> <span className="font-mono text-xs text-muted-foreground">{entry.path}</span> {mismatchText(entry)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {suggested.length > 0 ? (
        <section aria-labelledby="sitemap-now-suggested" className="space-y-3 rounded-xl border border-dashed border-border p-3" data-testid="sitemap-now-suggested">
          <div className="space-y-1">
            <h2 id="sitemap-now-suggested" className="flex flex-wrap items-center gap-2 text-sm font-medium text-muted-foreground">
              Suggested pages
              <Pill className="bg-muted text-muted-foreground">Not built</Pill>
            </h2>
            <p className="text-sm text-muted-foreground">
              {countOf(suggested.length, "idea")} from the sitemap plan that nobody has built. Visitors cannot open {suggested.length === 1 ? "it" : "them"}, and {suggested.length === 1 ? "it is" : "they are"} not counted as {suggested.length === 1 ? "a page" : "pages"} anywhere.
            </p>
          </div>
          {[...groups.entries()].map(([top, items]) => (
            <details key={top} className="rounded-md">
              <summary className="cursor-pointer rounded-sm px-1 py-1 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                Under {titleBySlug.get(top) ?? top} <span className="font-mono text-xs">{top}</span> ({items.length})
              </summary>
              <ul className="mt-1 divide-y divide-border">
                {items.map((page) => (
                  <li key={page.id} data-testid="sitemap-now-suggestion" className="flex flex-wrap items-center gap-x-4 gap-y-1 py-1.5 pl-4">
                    <div className="min-w-40 flex-1">
                      <p className="break-words text-sm text-muted-foreground">{page.title}</p>
                      <p className="break-all font-mono text-xs text-muted-foreground">{page.slug}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {dismissed.includes(page.id) ? (
                        <Button type="button" variant="ghost" size="xs" onClick={() => setDismissedFor(page.id, false)} aria-label={`Bring back the suggestion ${page.title}`}>Bring back</Button>
                      ) : (
                        <>
                          {onEditPage ? (
                            <Button type="button" variant="outline" size="xs" onClick={() => onEditPage(page.id)} aria-label={`Build the page ${page.title}`}>Build this page</Button>
                          ) : null}
                          <Button type="button" variant="ghost" size="xs" onClick={() => setDismissedFor(page.id, true)} aria-label={`Dismiss the suggestion ${page.title}`}>Dismiss</Button>
                        </>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </details>
          ))}
          <p className="text-xs text-muted-foreground">
            Dismiss hides a suggestion for you, in this browser. It stays in the sitemap plan until someone takes it out there and that change is approved.
            {hidden.length > 0 ? (
              <>
                {" "}
                <button type="button" className="rounded-sm underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setShowDismissed(!showDismissed)}>
                  {showDismissed ? "Hide dismissed" : `Show ${countOf(hidden.length, "dismissed suggestion")}`}
                </button>
              </>
            ) : null}
          </p>
        </section>
      ) : null}
    </div>
  );
}
