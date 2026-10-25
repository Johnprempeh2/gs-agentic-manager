import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BarChart3,
  CheckCircle2,
  Columns2,
  ExternalLink,
  FileText,
  Globe,
  Layers,
  ListChecks,
  Map as MapIcon,
  Maximize2,
  PenLine,
  Rocket,
  Send,
} from "lucide-react";
import {
  websitePreviewAddresses,
  type ProjectTree,
  type WebsiteHomeActivity,
  type WebsiteHomeRelease,
  type WebsiteHomeSummary,
  type WebsiteProperty,
  type WebsiteSite,
} from "@greatstone/shared";
import { websiteApi, websiteModuleApi, type WebsiteHubWorkItem } from "../../api/website";
import { projectsApi } from "../../api/projects";
import { queryKeys } from "../../lib/queryKeys";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";
import { Link } from "@/lib/router";
import { cn, formatDate, formatNumber } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { DecisionFeedCard } from "../decisions-feed/DecisionFeedCard";
import { ErrorState } from "../ErrorState";
import { pickLivePreviewService } from "../LivePreviewCard";
import { RELEASE_STATUS_COPY, isReleaseActive, releaseDate, releaseTime } from "./WebsiteReleases";
import { useCanPublishWebsite, useWebsiteSite } from "./WebsiteSiteConnection";
import { WebsiteFeaturesSection } from "./features/WebsiteFeatureCards";
import {
  LinkProjectFirst,
  PreviewStage,
  WORK_TYPE_LABELS,
  When,
  framingProblem,
  liveSiteUrl,
  rememberPreviewMode,
  taskHref,
  useDecisionCardContext,
  useHub,
  useWebsiteCards,
  workItemIcon,
  type WebsiteTab,
} from "./WebsiteHub";

// The Website Home (John, 24 Oct 2026): the admin's at-a-glance screen. The
// live site leads as the hero; then what needs a person, one tile per part of
// the site, the last website events and the agents' latest work. Counts,
// releases and events come from one read (`/website/sites/:siteId/home`);
// the rest reuses what the other tabs already load.

/** Collections the Collections tile counts, in the Collections tab's words. */
export const HOME_COLLECTIONS: { key: string; label: string }[] = [
  { key: "product", label: "Products" },
  { key: "public-person", label: "Team" },
  { key: "redirect", label: "Redirects" },
  { key: "form", label: "Forms" },
];

const ACTIVITY_VERBS: Record<string, string> = {
  "website.site_connected": "connected the site",
  "website.site_updated": "changed the site settings",
  "website.site_editor_origin_changed": "changed the editor address",
  "website.page_created": "added the page",
  "website.page_updated": "changed the settings of",
  "website.page_saved": "saved",
  "website.page_archived": "archived",
  "website.page_restored": "restored an earlier version of",
  "website.page_submitted": "sent for review",
  "website.page_approved": "approved",
  "website.page_sent_back": "sent back",
  "website.change_requested": "asked for a change to",
  "website.entry_created": "added",
  "website.entry_updated": "changed",
  "website.entry_saved": "saved",
  "website.entry_archived": "archived",
  "website.entry_submitted": "sent for review",
  "website.entry_approved": "approved",
  "website.entry_sent_back": "sent back",
  "website.public_drafts_imported": "imported drafts from the live site",
  "website.publish_started": "started a Publish:",
  "website.release_retried": "retried",
  "website.rollback_started": "started a roll back:",
  "website.sitemap_option_created": "proposed the sitemap option",
  "website.sitemap_option_imported": "proposed the sitemap option",
  "website.sitemap_option_updated": "edited the sitemap option",
  "website.sitemap_option_archived": "archived the sitemap option",
  "website.sitemap_option_approved": "approved the sitemap option",
  "approval.created": "asked for a Publish",
};

/** "saved", "approved the sitemap option": the event in plain words. */
export function activityVerb(action: string): string {
  return ACTIVITY_VERBS[action] ?? action.replace(/^[a-z]+\./, "").replace(/_/g, " ");
}

/** Who did it: the name, else what kind of actor it was. */
export function activityActor(event: Pick<WebsiteHomeActivity, "actorName" | "actorType">): string {
  if (event.actorName) return event.actorName;
  if (event.actorType === "agent") return "A removed agent";
  if (event.actorType === "system") return "GSAM";
  return "Someone";
}

/** Planned, drafted (draft, review or approved) and live pages. */
export function pageProgress(pages: WebsiteHomeSummary["pages"]) {
  const drafted = pages.draft + pages.review + pages.approved;
  const total = pages.planned + drafted + pages.published;
  return { planned: pages.planned, drafted, live: pages.published, total };
}

/** The live status line of the hero. */
export function liveStatus(site: WebsiteSite | null, releases: WebsiteHomeSummary["releases"] | undefined) {
  if (!site) return { label: "Not connected", tone: "bg-status-neutral-soft text-status-neutral-foreground" };
  const latest = releases?.latest ?? null;
  if (latest && isReleaseActive(latest.status)) return { label: "Publishing", tone: "bg-status-info-soft text-status-info-foreground" };
  if (latest?.status === "pending") return { label: "Pending", tone: "bg-status-warning-soft text-status-warning-foreground" };
  if (releases?.live) return { label: "Live", tone: "bg-status-success-soft text-status-success-foreground" };
  return { label: "Not published yet", tone: "bg-status-neutral-soft text-status-neutral-foreground" };
}


const count = (value: number) => formatNumber(value);

/* ---- The ambient haze around the hero frame ---- */

/**
 * The one ambient effect on the Home: a very slow emerald and teal haze in
 * the margin around the preview frame, never behind text (the frame and its
 * bar are opaque). CSS transform only; it holds still under reduced motion
 * and while the tab is hidden, so a hidden tab does no work.
 */
function useHazeStill() {
  const reduced = usePrefersReducedMotion();
  const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.visibilityState === "hidden");
  useEffect(() => {
    const onChange = () => setHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return reduced || hidden;
}

/* ---- Hero ---- */

export type HeroFrameHold = "waiting" | "not_connected" | "refused" | "unreachable" | null;

const HOLD_COPY: Record<Exclude<HeroFrameHold, "waiting" | null>, { title: (host: string) => string; body: string }> = {
  not_connected: {
    title: () => "Connect the site to see it here",
    body: "Once the site is connected under Releases, GSAM checks that it can be shown here and puts it in this frame.",
  },
  refused: {
    title: (host) => `${host} keeps itself out of frames`,
    body: "This site does not allow being shown inside another page, which keeps it safe. Open it in a new tab, or set a frameable copy under Releases, Site connection.",
  },
  unreachable: {
    title: (host) => `${host} did not answer`,
    body: "GSAM could not reach this site just now, so it is not shown here. Open it in a new tab to check it.",
  },
};

/** The hero's two views (John, 24 Oct 2026). In development leads: it is the site being worked on. */
export type HeroView = "live" | "dev";

/**
 * Why the hero holds a site back instead of framing it. A browser fires
 * `load` on a refused or failed frame too, so the page cannot see the
 * failure; the server's check of the address shown can. An address the
 * server did not check (a running workspace preview) frames as before.
 */
export function heroFrameHold(
  view: HeroView,
  url: string | null,
  site: WebsiteSite | null,
  home: WebsiteHomeSummary | undefined,
): HeroFrameHold {
  if (!url) return null;
  if (!site) return view === "live" ? "not_connected" : null;
  const addresses = websitePreviewAddresses(site);
  if (url !== (view === "live" ? addresses.live : addresses.dev)) return null;
  if (!home) return "waiting";
  const framing = view === "live" ? home.liveFraming : home.devFraming;
  if (framing === "refused") return "refused";
  if (framing === "unknown") return "unreachable";
  return null;
}

const HERO_VIEWS: { value: HeroView; label: string }[] = [
  { value: "live", label: "Live" },
  { value: "dev", label: "In development" },
];

function HeroFrame({ url, host, hold, view, onView, canShowDev, onOpenPreview }: {
  url: string | null;
  host: string | null;
  hold: HeroFrameHold;
  view: HeroView;
  onView: (view: HeroView) => void;
  canShowDev: boolean;
  onOpenPreview: () => void;
}) {
  const still = useHazeStill();
  const problem = url ? framingProblem(url, window.location.protocol) : null;
  const copy = hold && hold !== "waiting" ? HOLD_COPY[hold] : null;
  return (
    <div className="gs-website-haze rounded-2xl p-3 sm:p-5" data-motion={still ? "still" : "drift"} data-testid="website-home-haze">
      <div className="relative overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="flex items-center gap-3 border-b border-border bg-muted px-3 py-2">
          <span className="hidden shrink-0 gap-1.5 sm:flex" aria-hidden="true">
            <span className="size-2.5 rounded-full bg-border" />
            <span className="size-2.5 rounded-full bg-border" />
            <span className="size-2.5 rounded-full bg-border" />
          </span>
          <div className="flex shrink-0 items-center gap-0.5 rounded-md bg-background p-0.5" role="group" aria-label="Which site" data-testid="website-home-view">
            {HERO_VIEWS.map((entry) => (
              <button
                key={entry.value}
                type="button"
                aria-pressed={view === entry.value}
                disabled={entry.value === "dev" && !canShowDev}
                title={entry.value === "dev" && !canShowDev ? "No development address yet. Set it under Releases, Site connection." : undefined}
                onClick={() => onView(entry.value)}
                className={cn(
                  "inline-flex h-6 items-center rounded px-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:text-subtle-foreground",
                  view === entry.value ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {entry.label}
              </button>
            ))}
          </div>
          <span className="min-w-0 flex-1 truncate rounded-md bg-background px-2 py-0.5 text-center font-mono text-xs text-muted-foreground">
            {host ?? "No address yet"}
          </span>
          <Button type="button" variant="ghost" size="icon-xs" onClick={onOpenPreview} aria-label="Open the full preview" title="Open the full preview">
            <Maximize2 />
          </Button>
        </div>
        {hold === "waiting" ? (
          <div className="flex aspect-16/9 w-full items-center justify-center bg-muted" data-testid="website-home-frame-waiting">
            <p className="text-sm text-muted-foreground" role="status">Loading <span className="font-mono text-foreground">{host}</span></p>
          </div>
        ) : url && !problem && !copy ? (
          <PreviewStage url={url} device="laptop" width={1440} label={view === "live" ? "Live site" : "In development"} className="aspect-16/9 w-full" />
        ) : (
          <div className="flex aspect-16/9 w-full flex-col items-center justify-center gap-3 bg-muted p-6 text-center" data-testid="website-home-frame-placeholder">
            <span className="flex size-12 items-center justify-center rounded-full border border-border bg-card">
              <Globe className="size-5 text-muted-foreground" aria-hidden="true" />
            </span>
            <p className="text-sm font-medium">
              {copy ? copy.title(host ?? "The site") : url ? "The preview opens in a new tab" : "No preview to show yet"}
            </p>
            <p className="max-w-sm text-xs text-muted-foreground">
              {copy ? copy.body : problem ?? "The site shows here once it has an address or a preview is running."}
            </p>
            {url ? (
              <Button asChild size="sm" variant="outline">
                <a href={url} target="_blank" rel="noreferrer">
                  <ExternalLink />
                  Open in new tab
                </a>
              </Button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function ReleaseLine({ release }: { release: WebsiteHomeRelease }) {
  const at = release.liveAt ?? release.createdAt;
  return (
    <p className="text-sm text-muted-foreground">
      <span className="font-medium text-foreground">Release {release.number}</span> went live{" "}
      <time dateTime={at} title={releaseDate(at)}>{releaseTime(at)}</time>
      {release.publishedByName ? <> by <span className="text-foreground">{release.publishedByName}</span></> : null}
    </p>
  );
}

function Hero({
  property,
  site,
  home,
  devUrl,
  onOpenTab,
  onEditPages,
}: {
  property: WebsiteProperty;
  site: WebsiteSite | null;
  home: WebsiteHomeSummary | undefined;
  /** The In development address: the site's own, else the running workspace preview. */
  devUrl: string | null;
  onOpenTab: (tab: WebsiteTab) => void;
  onEditPages?: () => void;
}) {
  const live = site ? `https://${site.domain}/` : liveSiteUrl(property.siteUrl);
  // The Live view frames the exact copy of the live deploy when one is set.
  const liveView = site ? websitePreviewAddresses(site).live : live;
  const [chosenView, setView] = useState<HeroView>("dev");
  const view: HeroView = chosenView === "dev" && devUrl ? "dev" : "live";
  const previewUrl = view === "dev" ? devUrl : liveView;
  const domain = site?.domain ?? (live ? live.replace(/^https?:\/\//, "").replace(/\/$/, "") : property.siteUrl);
  const status = liveStatus(site, home?.releases);
  const latest = home?.releases.latest ?? null;
  const liveRelease = home?.releases.live ?? null;
  const previewHost = previewUrl ? previewUrl.replace(/^https?:\/\//, "").replace(/\/$/, "") : null;
  // The panel follows the frame: In development shows and opens the development address.
  const siteLink = view === "dev" ? devUrl : live;
  const siteLabel = view === "dev" ? previewHost : domain;
  return (
    <section className="grid gap-6 lg:grid-cols-5 lg:items-center" aria-labelledby="website-home-title" data-testid="website-home-hero">
      <div className="min-w-0 lg:col-span-3">
        <HeroFrame
          url={previewUrl}
          host={previewHost}
          hold={heroFrameHold(view, previewUrl, site, home)}
          view={view}
          onView={setView}
          canShowDev={!!devUrl}
          onOpenPreview={() => onOpenTab("preview")}
        />
      </div>
      <div className="flex min-w-0 flex-col gap-4 lg:col-span-2">
        <div className="space-y-2">
          <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium", status.tone)} data-testid="website-home-status">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
            {status.label}
          </span>
          <h2 id="website-home-title" className="text-2xl font-bold tracking-tight">{site?.name ?? property.name}</h2>
          {siteLink ? (
            <a href={siteLink} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1.5 break-all rounded-sm font-mono text-sm text-muted-foreground hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" data-testid="website-home-site-link">
              {siteLabel}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ) : (
            <p className="break-all font-mono text-sm text-muted-foreground">{domain}</p>
          )}
        </div>
        <div className="space-y-1" data-testid="website-home-release">
          {!site ? (
            <p className="text-sm text-muted-foreground">Connect the site under Releases to edit pages and Publish from here.</p>
          ) : liveRelease ? (
            <ReleaseLine release={liveRelease} />
          ) : (
            <p className="text-sm text-muted-foreground">Nothing published from GSAM yet.</p>
          )}
          {latest && latest.id !== liveRelease?.id ? (
            <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span>Release {latest.number}</span>
              <span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-medium", RELEASE_STATUS_COPY[latest.status].tone)}>
                {RELEASE_STATUS_COPY[latest.status].label}
              </span>
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => (onEditPages ? onEditPages() : onOpenTab("editor"))}>
            <PenLine />
            Edit pages
          </Button>
          <Button type="button" variant="outline" onClick={() => onOpenTab("releases")}>
            <Send />
            Publish
          </Button>
          {siteLink ? (
            <Button asChild variant="ghost">
              <a href={siteLink} target="_blank" rel="noreferrer" data-testid="website-home-open-site">
                <ExternalLink />
                {view === "dev" ? "Open development site" : "Open live site"}
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </Button>
          ) : null}
        </div>
        <div>
          <Button
            type="button"
            variant="link"
            className="h-auto px-0"
            onClick={() => {
              rememberPreviewMode("side");
              onOpenTab("preview");
            }}
            data-testid="website-home-compare"
          >
            <Columns2 />
            Compare side by side
          </Button>
        </div>
      </div>
    </section>
  );
}

/* ---- Needs you ---- */

function NeedsYou({
  companyId,
  projectId,
  tree,
  home,
}: {
  companyId: string;
  projectId: string | null;
  tree: ProjectTree | undefined;
  home: WebsiteHomeSummary | undefined;
}) {
  const { cards, assignableAgents, isLoading, error } = useWebsiteCards(companyId, projectId ?? "", tree);
  const { agentMap, currentUserId } = useDecisionCardContext(companyId);
  const projectCards = projectId ? cards : [];
  const approval = home?.publishApproval ?? null;
  const empty = !isLoading && !error && projectCards.length === 0 && !approval;
  return (
    <section className="space-y-4" aria-labelledby="website-home-needs-you" data-testid="website-home-needs-you">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="website-home-needs-you" className="text-lg font-semibold">Needs you</h2>
        <Link to="/decisions" className="rounded-sm text-sm font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          All decisions
        </Link>
      </div>
      {error ? <ErrorState error={error} compact /> : null}
      {empty ? (
        <div className="gs-glass-card flex items-center gap-3 rounded-xl border px-4 py-3" data-testid="website-home-needs-you-empty">
          <CheckCircle2 className="size-5 shrink-0 text-status-success" aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-sm font-medium">Nothing waiting on you</p>
            <p className="text-xs text-muted-foreground">Website decisions and Publish requests show here when an agent needs a person.</p>
          </div>
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {approval ? (
            <Link
              to={`/approvals/${approval.id}`}
              className="gs-glass-card flex min-w-0 items-center gap-3 rounded-xl border px-4 py-3 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="website-home-publish-approval"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-status-warning-soft">
                <Rocket className="size-4 text-status-warning-foreground" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{approval.title}</span>
                <span className="block text-xs text-muted-foreground">
                  {approval.changeCount === 1 ? "1 change" : `${count(approval.changeCount)} changes`} waiting for a Publish · <When at={approval.createdAt} />
                </span>
              </span>
            </Link>
          ) : null}
          {projectCards.map((card) => (
            <DecisionFeedCard
              key={card.id}
              card={card}
              companyId={companyId}
              assignableAgents={assignableAgents}
              agentMap={agentMap}
              currentUserId={currentUserId}
              compact
            />
          ))}
        </div>
      )}
    </section>
  );
}

/* ---- Tiles ---- */

function Tile({ label, icon: Icon, onOpen, testId, children }: {
  label: string;
  icon: typeof Globe;
  onOpen: () => void;
  testId: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid={testId}
      className="gs-glass-card flex min-w-0 flex-col gap-2 rounded-xl border p-4 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex w-full items-center justify-between gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
        <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      </span>
      {children}
    </button>
  );
}

function Big({ children }: { children: ReactNode }) {
  return <span className="block text-2xl font-bold tabular-nums">{children}</span>;
}

function Small({ children }: { children: ReactNode }) {
  return <span className="block text-xs text-muted-foreground">{children}</span>;
}

/** A slim two-part bar: live, then drafted, on the planned track. */
function SlimBar({ parts, label }: { parts: { value: number; className: string }[]; label: string }) {
  const total = Math.max(parts.reduce((sum, part) => sum + part.value, 0), 1);
  return (
    <span role="img" aria-label={label} className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
      {parts.filter((part) => part.value > 0).map((part, index) => (
        <span key={index} className={cn("h-full", part.className)} style={{ width: `${(part.value / total) * 100}%` }} />
      ))}
    </span>
  );
}

/** Seven days of visitors as a line; the stroke is the chart token. */
export function Sparkline({ values, label }: { values: number[]; label: string }) {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1);
  const step = 100 / (values.length - 1);
  const points = values.map((value, index) => `${(index * step).toFixed(2)},${(28 - (value / max) * 26).toFixed(2)}`).join(" ");
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" role="img" aria-label={label} className="h-8 w-full text-chart-1">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function Tiles({
  companyId,
  property,
  site,
  home,
  tree,
  onOpenTab,
}: {
  companyId: string;
  property: WebsiteProperty;
  site: WebsiteSite | null;
  home: WebsiteHomeSummary | undefined;
  tree: ProjectTree | undefined;
  onOpenTab: (tab: WebsiteTab) => void;
}) {
  const reportQuery = useQuery({
    queryKey: queryKeys.website.report(companyId, property.id),
    queryFn: () => websiteApi.report(companyId, property.id),
    enabled: !!property.ga4PropertyId,
  });
  const notConnected = <Small>Connect the site under Releases first.</Small>;
  const loading = <Small>Loading</Small>;

  const pages = home ? pageProgress(home.pages) : null;
  const sitemap = home?.sitemap;
  const latest = home?.releases.latest ?? null;
  const live = home?.releases.live ?? null;
  const treeTotal = tree ? tree.counts.done + tree.counts.active + tree.counts.blocked + tree.counts.waiting : 0;
  const keyTasks = tree ? tree.keyTaskIds.map((id) => tree.nodes.find((node) => node.id === id)).filter((node) => node !== undefined).slice(0, 2) : [];
  const ga4 = reportQuery.data?.ga4 ?? null;
  const week = ga4 ? ga4.dailyTrend.slice(-7).map((point) => point.visitors) : [];

  return (
    <section aria-label="At a glance" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" data-testid="website-home-tiles">
      <Tile label="Pages" icon={FileText} onOpen={() => onOpenTab("editor")} testId="website-home-tile-editor">
        {!site ? notConnected : !pages ? loading : (
          <>
            <Big>{count(pages.live + pages.drafted)} <span className="text-sm font-medium text-muted-foreground">of {count(pages.total)} started</span></Big>
            <SlimBar
              label={`${pages.live} live, ${pages.drafted} drafted, ${pages.planned} planned`}
              parts={[{ value: pages.live, className: "bg-status-success" }, { value: pages.drafted, className: "bg-status-info" }, { value: pages.planned, className: "bg-transparent" }]}
            />
            <Small>{count(pages.live)} live · {count(pages.drafted)} drafted · {count(pages.planned)} planned</Small>
          </>
        )}
      </Tile>
      <Tile label="Sitemap" icon={MapIcon} onOpen={() => onOpenTab("sitemap")} testId="website-home-tile-sitemap">
        {!site ? notConnected : !sitemap ? loading : (
          <>
            <span className="line-clamp-2 block text-sm font-semibold">{sitemap.approved?.name ?? "No approved sitemap"}</span>
            {sitemap.approved?.approvedAt ? <Small>Approved {formatDate(sitemap.approved.approvedAt)}{sitemap.approved.changedSinceApproval ? ", edited since" : ""}</Small> : null}
            <Small>
              {sitemap.awaitingReview === 0 ? "No options waiting" : sitemap.awaitingReview === 1 ? "1 option awaiting review" : `${sitemap.awaitingReview} options awaiting review`}
            </Small>
          </>
        )}
      </Tile>
      <Tile label="Releases" icon={Rocket} onOpen={() => onOpenTab("releases")} testId="website-home-tile-releases">
        {!site ? notConnected : !home ? loading : (
          <>
            <Big>{live ? `Release ${live.number}` : "None live"}</Big>
            {latest && latest.id !== live?.id ? (
              <span className={cn("inline-flex w-fit rounded-full px-2 py-0.5 text-xs font-medium", RELEASE_STATUS_COPY[latest.status].tone)}>
                Release {latest.number}: {RELEASE_STATUS_COPY[latest.status].label}
              </span>
            ) : live?.liveAt ? <Small>Live {releaseTime(live.liveAt)}</Small> : null}
            <Small>Nothing scheduled. Publish is always a person.</Small>
          </>
        )}
      </Tile>
      <Tile label="Build progress" icon={ListChecks} onOpen={() => onOpenTab("progress")} testId="website-home-tile-progress">
        {!property.projectId ? <Small>Link the website project to see its progress.</Small> : !tree ? loading : (
          <>
            <Big>{count(tree.counts.done)} <span className="text-sm font-medium text-muted-foreground">of {count(treeTotal)}</span></Big>
            <SlimBar
              label={`${tree.counts.done} of ${treeTotal} tasks done`}
              parts={[{ value: tree.counts.done, className: "bg-status-success" }, { value: tree.counts.active, className: "bg-status-running" }, { value: tree.counts.blocked, className: "bg-status-danger" }, { value: tree.counts.waiting, className: "bg-transparent" }]}
            />
            {keyTasks.length ? (
              keyTasks.map((node) => {
                const progress = tree.keyTaskProgress[node.id] ?? { done: 0, total: 0 };
                return <Small key={node.id}><span className="block truncate">{node.title} ({progress.done}/{progress.total})</span></Small>;
              })
            ) : <Small>No key tasks yet</Small>}
          </>
        )}
      </Tile>
      <Tile label="Traffic" icon={BarChart3} onOpen={() => onOpenTab("traffic")} testId="website-home-tile-traffic">
        {!property.ga4PropertyId ? (
          <>
            <span className="block text-sm font-semibold">Google not linked</span>
            <Small>No visitor numbers yet.</Small>
            <span className="text-xs font-medium text-foreground underline underline-offset-2">Link Google Analytics</span>
          </>
        ) : reportQuery.isLoading ? loading : !ga4 ? (
          <>
            <span className="block text-sm font-semibold">Waiting for the first pull</span>
            <Small>Visitors show after the next daily pull.</Small>
          </>
        ) : (
          <>
            <Big>{count(week.reduce((sum, value) => sum + value, 0))}</Big>
            <Small>visitors, last 7 days</Small>
            <Sparkline values={week} label={`Visitors per day for the last ${week.length} days`} />
          </>
        )}
      </Tile>
      <Tile label="Collections" icon={Layers} onOpen={() => onOpenTab("collections")} testId="website-home-tile-collections">
        {!site ? notConnected : !home ? loading : (
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
            {HOME_COLLECTIONS.map((collection) => (
              <div key={collection.key} className="min-w-0">
                <dt className="truncate text-xs text-muted-foreground">{collection.label}</dt>
                <dd className="text-sm font-semibold tabular-nums">{count(home.collections[collection.key] ?? 0)}</dd>
              </div>
            ))}
          </dl>
        )}
      </Tile>
    </section>
  );
}

/* ---- Recent activity and latest work ---- */

function RecentActivity({ site, home, error }: { site: WebsiteSite | null; home: WebsiteHomeSummary | undefined; error: unknown }) {
  const events = home?.activity ?? [];
  return (
    <section className="min-w-0 space-y-4" aria-labelledby="website-home-activity" data-testid="website-home-activity">
      <h2 id="website-home-activity" className="text-lg font-semibold">Recent activity</h2>
      {error ? <ErrorState error={error} compact /> : !site ? (
        <p className="text-sm text-muted-foreground">Page saves, approvals and releases show here once the site is connected.</p>
      ) : !home ? (
        <p className="text-sm text-muted-foreground">Loading activity</p>
      ) : events.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing yet. Page saves, approvals, releases and sitemap changes show here.</p>
      ) : (
        <ol className="gs-glass-card divide-y divide-border rounded-xl border">
          {events.map((event) => (
            <li key={event.id} className="flex min-w-0 items-baseline gap-3 px-4 py-2.5 text-sm">
              <p className="min-w-0 flex-1 truncate">
                <span className="font-medium">{activityActor(event)}</span>{" "}
                <span className="text-muted-foreground">{activityVerb(event.action)}</span>
                {event.subject ? <> <span className="font-medium">{event.subject}</span></> : null}
              </p>
              <span className="shrink-0 text-xs text-muted-foreground"><When at={event.createdAt} /></span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function LatestWork({ items, linked, error }: { items: WebsiteHubWorkItem[]; linked: boolean; error: unknown }) {
  return (
    <section className="min-w-0 space-y-4" aria-labelledby="website-home-work" data-testid="website-home-work">
      <h2 id="website-home-work" className="text-lg font-semibold">Latest work from agents</h2>
      {error ? <ErrorState error={error} compact /> : !linked ? (
        <p className="text-sm text-muted-foreground">Link the website project and its deliverables, previews and screenshots show here.</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing made yet. Deliverables, previews and screenshots from the website tasks show here.</p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="Latest website work">
          {items.slice(0, 8).map((item) => {
            const Icon = workItemIcon(item.type);
            const href = item.url ?? item.contentPath;
            const isImage = !!item.contentPath && !!item.contentType?.startsWith("image/");
            const thumb = isImage ? (
              <img src={item.contentPath!} alt="" loading="lazy" className="aspect-4/3 w-full rounded-lg border border-border object-cover" />
            ) : (
              <span className="flex aspect-4/3 w-full items-center justify-center rounded-lg border border-border bg-muted">
                <Icon className="size-5 text-muted-foreground" aria-hidden="true" />
              </span>
            );
            return (
              <li key={item.id} className="min-w-0 space-y-1.5">
                {href ? (
                  <a href={href} target="_blank" rel="noreferrer" className="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    {thumb}
                    <span className="sr-only">{item.title} (opens in a new tab)</span>
                  </a>
                ) : thumb}
                <p className="truncate text-xs font-medium" title={item.title}>{item.title}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {WORK_TYPE_LABELS[item.type] ?? item.type} ·{" "}
                  <Link to={taskHref(item.task)} className="rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{item.task.identifier ?? item.task.title}</Link>
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/* ---- The tab ---- */

export function WebsiteHomeTab({
  companyId,
  property,
  onOpenTab,
  onEditPages,
}: {
  companyId: string;
  property: WebsiteProperty;
  onOpenTab: (tab: WebsiteTab) => void;
  /** Edit pages: the full-screen editor (GRE-2296). Without it, the Pages tab. */
  onEditPages?: () => void;
}) {
  const projectId = property.projectId;
  const { site } = useWebsiteSite(companyId, property.id);
  const { canPublish } = useCanPublishWebsite(companyId, site?.id ?? null, !!site);
  const homeQuery = useQuery({
    queryKey: queryKeys.website.home(companyId, site?.id ?? ""),
    queryFn: () => websiteModuleApi.home(companyId, site!.id),
    enabled: !!site,
    refetchInterval: 60_000,
  });
  const projectQuery = useQuery({
    queryKey: [...queryKeys.projects.detail(projectId ?? ""), companyId],
    queryFn: () => projectsApi.get(projectId!, companyId),
    enabled: !!projectId,
  });
  const treeQuery = useQuery({
    queryKey: queryKeys.projectTree(projectId ?? "", false),
    queryFn: () => projectsApi.getTree(projectId!, false),
    enabled: !!projectId,
  });
  const hubQuery = useHub(companyId, property.id, !!projectId);

  const service = pickLivePreviewService(projectQuery.data?.workspaces.flatMap((workspace) => workspace.runtimeServices ?? []));
  const devUrl = (site ? websitePreviewAddresses(site).dev : null) ?? service?.url ?? null;
  const home = homeQuery.data;

  return (
    <div className="space-y-6" data-testid="website-home">
      <Hero property={property} site={site} home={home} devUrl={devUrl} onOpenTab={onOpenTab} onEditPages={site?.editorFrameOrigin ? onEditPages : undefined} />
      <NeedsYou companyId={companyId} projectId={projectId} tree={treeQuery.data} home={home} />
      <WebsiteFeaturesSection companyId={companyId} site={site} canChange={canPublish} />
      <Tiles companyId={companyId} property={property} site={site} home={home} tree={treeQuery.data} onOpenTab={onOpenTab} />
      {projectId ? null : <LinkProjectFirst companyId={companyId} property={property} />}
      <div className="grid gap-6 lg:grid-cols-2">
        <RecentActivity site={site} home={home} error={homeQuery.error} />
        <LatestWork items={hubQuery.data?.recentWork ?? []} linked={!!projectId} error={hubQuery.error} />
      </div>
    </div>
  );
}
