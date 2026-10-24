import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ExternalLink,
  FileText,
  GitPullRequest,
  Globe,
  Image as ImageIcon,
  Laptop,
  Map as MapIcon,
  MonitorPlay,
  Smartphone,
  Tablet,
} from "lucide-react";
import type { Agent, DecisionCard, ProjectTree, WebsiteProperty } from "@greatstone/shared";
import { agentsApi } from "../../api/agents";
import { authApi } from "../../api/auth";
import { projectsApi } from "../../api/projects";
import { websiteApi, type WebsiteHubPreviewLink, type WebsiteHubSitemap } from "../../api/website";
import { useDialogActions } from "../../context/DialogContext";
import { useDecisionsFeed } from "../../hooks/useDecisionsFeed";
import { queryKeys } from "../../lib/queryKeys";
import { Link } from "@/lib/router";
import { cn, formatDateTime, relativeTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { DecisionFeedCard, decisionCardTaskId } from "../decisions-feed/DecisionFeedCard";
import { DeliverableDocumentView } from "../deliverables/DeliverableDocument";
import { EmptyState } from "../EmptyState";
import { ErrorState, errorStateMessage } from "../ErrorState";
import { LivePreviewCard, pickLivePreviewService } from "../LivePreviewCard";
import { ScaledFrame } from "../AttachmentPreviewPanel";
import { ProjectTreeView } from "../../pages/ProjectTree";
import { WebsiteSiteConnection, useWebsiteSite } from "./WebsiteSiteConnection";
import { WebsiteReleases } from "./WebsiteReleases";
import { useCanManageWebsite } from "./WebsiteSetup";
import { SitemapSection, StartSitemap, useSitemapData } from "./sitemap/SitemapSection";

// The website hub (23 Oct 2026): the Website page's Releases, Progress,
// Sitemap and Preview tabs. Everything is read from what GSAM already keeps:
// the linked project's tree, the decisions feed, the project's tasks' work
// products, attachments and comments, and the project workspace's preview.

export type WebsiteTab = "home" | "preview" | "progress" | "sitemap" | "editor" | "collections" | "releases" | "traffic";

/** The admin's at-a-glance Home leads (John, 24 Oct 2026), with the live site as its hero. */
export const WEBSITE_DEFAULT_TAB: WebsiteTab = "home";

export const WEBSITE_TABS: { value: WebsiteTab; label: string }[] = [
  { value: "home", label: "Home" },
  { value: "preview", label: "Preview" },
  { value: "progress", label: "Progress" },
  { value: "sitemap", label: "Sitemap" },
  { value: "editor", label: "Pages" },
  { value: "collections", label: "Collections" },
  { value: "releases", label: "Releases" },
  { value: "traffic", label: "Traffic" },
];

/** The tab named in `?tab=`. The old Overview became Home, so `?tab=overview` opens Home. */
export function websiteTabFrom(value: string | null): WebsiteTab {
  if (value === "overview") return "home";
  return WEBSITE_TABS.some((tab) => tab.value === value) ? (value as WebsiteTab) : WEBSITE_DEFAULT_TAB;
}

/** The public address of a Search Console property: `sc-domain:example.com` → `https://example.com/`. */
export function liveSiteUrl(siteUrl: string): string | null {
  const domain = /^sc-domain:(.+)$/i.exec(siteUrl)?.[1];
  if (domain) return `https://${domain}/`;
  try {
    const parsed = new URL(siteUrl);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/** Why a URL cannot show in a frame on this page, when we can tell before trying. */
export function framingProblem(url: string, pageProtocol: string): string | null {
  if (pageProtocol === "https:" && url.startsWith("http:")) {
    return "This preview uses plain http and this page uses https, so the browser blocks it here (mixed content). Open it in a new tab instead.";
  }
  return null;
}

/** Cards from the one decisions feed that are about the website project. */
export function websiteDecisionCards(cards: DecisionCard[], projectId: string, projectTaskIds: ReadonlySet<string>): DecisionCard[] {
  return cards.filter((card) => {
    const taskId = decisionCardTaskId(card);
    if (taskId && projectTaskIds.has(taskId)) return true;
    return card.items.some((item) => item.project?.id === projectId);
  });
}

export const WORK_TYPE_LABELS: Record<string, string> = {
  deliverable: "Deliverable",
  preview_url: "Preview",
  runtime_service: "Preview service",
  pull_request: "Pull request",
  branch: "Branch",
  commit: "Commit",
  artifact: "File",
  document: "Document",
  screenshot: "Screenshot",
};

const APPROVAL_LABELS: Record<string, { label: string; className: string }> = {
  waiting: { label: "Waiting for your approval", className: "bg-status-warning-soft text-status-warning-foreground" },
  approved: { label: "Approved", className: "bg-status-success-soft text-status-success-foreground" },
  changes_requested: { label: "Changes asked for", className: "bg-status-danger-soft text-status-danger-foreground" },
  none: { label: "No approval asked yet", className: "bg-muted text-muted-foreground" },
};

export function sitemapApprovalState(sitemap: WebsiteHubSitemap, hasApprovalCard: boolean): keyof typeof APPROVAL_LABELS {
  if (sitemap.reviewState === "approved") return "approved";
  if (sitemap.reviewState === "changes_requested") return "changes_requested";
  if (hasApprovalCard || sitemap.reviewState === "needs_board_review") return "waiting";
  return "none";
}

export function taskHref(task: { id: string; identifier: string | null }) {
  return `/issues/${task.identifier ?? task.id}`;
}

export function When({ at }: { at: string }) {
  return (
    <time dateTime={at} title={formatDateTime(at)}>
      {relativeTime(at)}
    </time>
  );
}

function Pill({ className, children }: { className: string; children: ReactNode }) {
  return <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", className)}>{children}</span>;
}

function Panel({ title, action, children, className }: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("gs-glass-card min-w-0 space-y-3 rounded-xl border p-4", className)} aria-label={title}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}


/* ---- Linking the website to its project ---- */

export function WebsiteProjectLink({
  companyId,
  property,
  onDone,
}: {
  companyId: string;
  property: WebsiteProperty;
  onDone?: () => void;
}) {
  const queryClient = useQueryClient();
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
  });
  const [choice, setChoice] = useState(property.projectId ?? "");
  const save = useMutation({
    mutationFn: (projectId: string | null) => websiteApi.update(companyId, property.id, { projectId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.website.overview(companyId) });
      void queryClient.invalidateQueries({ queryKey: ["website", companyId, "hub", property.id] });
      onDone?.();
    },
  });
  const projects = (projectsQuery.data ?? []).filter((project) => !project.archivedAt);
  const selectId = `website-project-${property.id}`;
  return (
    <form
      className="flex flex-col gap-2 sm:flex-row sm:items-end"
      data-testid="website-project-link"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate(choice || null);
      }}
    >
      <label htmlFor={selectId} className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
        <span className="font-medium">Project that builds this website</span>
        <NativeSelect
          id={selectId}
          value={choice}
          onChange={(event) => setChoice(event.target.value)}
          disabled={projectsQuery.isLoading || save.isPending}
        >
          <option value="">No project</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>{project.name}</option>
          ))}
        </NativeSelect>
      </label>
      <div className="flex items-center gap-2">
        {onDone ? (
          <Button type="button" variant="ghost" onClick={onDone} disabled={save.isPending}>Cancel</Button>
        ) : null}
        <Button type="submit" disabled={save.isPending || choice === (property.projectId ?? "")}>
          {save.isPending ? "Saving" : "Save"}
        </Button>
      </div>
      {save.isError ? <p role="alert" className="text-xs text-status-danger">{errorStateMessage(save.error)}</p> : null}
    </form>
  );
}

export function LinkProjectFirst({ companyId, property }: { companyId: string; property: WebsiteProperty }) {
  return (
    <Panel title="Link the website project">
      <p className="text-sm text-muted-foreground">
        Choose the project that builds this website, once. Its progress, decisions, sitemap and previews then show on this page.
      </p>
      <WebsiteProjectLink companyId={companyId} property={property} />
    </Panel>
  );
}

/* ---- Shared data ---- */

export function useHub(companyId: string, propertyId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.website.hub(companyId, propertyId),
    queryFn: () => websiteApi.hub(companyId, propertyId),
    enabled,
    refetchInterval: 60_000,
  });
}

/** Everything a decision card needs besides the card. */
export function useDecisionCardContext(companyId: string) {
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });
  const sessionQuery = useQuery({ queryKey: queryKeys.auth.session, queryFn: () => authApi.getSession() });
  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const agent of agentsQuery.data ?? []) map.set(agent.id, agent);
    return map;
  }, [agentsQuery.data]);
  const session = sessionQuery.data;
  return { agentMap, currentUserId: session?.user?.id ?? session?.session?.userId ?? null };
}

export function useWebsiteCards(companyId: string, projectId: string, tree: ProjectTree | undefined) {
  const feed = useDecisionsFeed(companyId);
  const cards = useMemo(() => {
    if (!feed.data) return [];
    const taskIds = new Set((tree?.nodes ?? []).map((node) => node.id));
    return websiteDecisionCards(feed.data.cards, projectId, taskIds);
  }, [feed.data, projectId, tree]);
  return { cards, assignableAgents: feed.data?.assignableAgents ?? [], isLoading: feed.isLoading, error: feed.error };
}

/* ---- Releases ---- */

export function workItemIcon(type: string) {
  if (type === "screenshot") return ImageIcon;
  if (type === "pull_request" || type === "branch" || type === "commit") return GitPullRequest;
  if (type === "preview_url" || type === "runtime_service") return MonitorPlay;
  return FileText;
}

/** Releases and Publish, once the site is connected (GRE-2133). */
function SiteReleases({ companyId, property }: { companyId: string; property: WebsiteProperty }) {
  const { site } = useWebsiteSite(companyId, property.id);
  return site ? <WebsiteReleases companyId={companyId} site={site} /> : null;
}

/** The Releases tab: the site connection, then Releases and Publish (moved here from the old Overview). */
export function WebsiteReleasesTab({ companyId, property }: { companyId: string; property: WebsiteProperty }) {
  return (
    <div className="space-y-6" data-testid="website-releases-tab">
      <WebsiteSiteConnection companyId={companyId} property={property} />
      <SiteReleases companyId={companyId} property={property} />
    </div>
  );
}

/* ---- Progress ---- */

export function WebsiteProgressTab({ companyId, property }: { companyId: string; property: WebsiteProperty }) {
  if (!property.projectId) return <LinkProjectFirst companyId={companyId} property={property} />;
  return (
    <div className="flex min-h-96 flex-col" data-testid="website-progress">
      <ProjectTreeView projectRef={property.projectId} embedded />
    </div>
  );
}

/* ---- Sitemap ---- */

/**
 * The Sitemap tab: the Sitemap section (GRE-2111) once the connected site has
 * pages or sitemap options; until then the sitemap file attached to the
 * project's tasks (the website hub), with a way to start the section.
 */
export function WebsiteSitemapTab({ companyId, property }: { companyId: string; property: WebsiteProperty }) {
  const { site, isLoading: siteLoading } = useWebsiteSite(companyId, property.id);
  const { options, pages } = useSitemapData(companyId, site?.id ?? null);
  const { canManage } = useCanManageWebsite(companyId);
  const optionList = options.data ?? [];
  const pageList = pages.data ?? [];
  if (siteLoading || (site && (options.isLoading || pages.isLoading))) {
    return <p className="text-sm text-muted-foreground">Loading the sitemap</p>;
  }
  if (site && (options.error || pages.error)) {
    return <ErrorState error={options.error ?? pages.error} onRetry={() => { void options.refetch(); void pages.refetch(); }} />;
  }
  if (site && optionList.length > 0) {
    // Board users who are not viewers can edit; the server checks website:edit on every save.
    return <SitemapSection companyId={companyId} site={site} options={optionList} pages={pageList} canApprove={canManage} canEdit />;
  }
  // A site with pages but no option yet: start from its pages. No pages: the attached sitemap file stays.
  if (site && pageList.length > 0) return <StartSitemap companyId={companyId} site={site} pages={pageList} />;
  return (
    <div className="space-y-6">
      {site ? <StartSitemap companyId={companyId} site={site} pages={pageList} /> : null}
      <WebsiteSitemapAttachment companyId={companyId} property={property} />
    </div>
  );
}

function WebsiteSitemapAttachment({ companyId, property }: { companyId: string; property: WebsiteProperty }) {
  const projectId = property.projectId;
  const hubQuery = useHub(companyId, property.id, !!projectId);
  const treeQuery = useQuery({
    queryKey: queryKeys.projectTree(projectId ?? "", false),
    queryFn: () => projectsApi.getTree(projectId!, false),
    enabled: !!projectId,
  });
  const { openNewIssue } = useDialogActions();
  const { cards, assignableAgents } = useWebsiteCards(companyId, projectId ?? "", treeQuery.data);
  const { agentMap, currentUserId } = useDecisionCardContext(companyId);

  if (!projectId) return <LinkProjectFirst companyId={companyId} property={property} />;
  if (hubQuery.error) return <ErrorState error={hubQuery.error} onRetry={() => void hubQuery.refetch()} />;
  if (hubQuery.isLoading) return <p className="text-sm text-muted-foreground">Loading the sitemap</p>;
  const sitemap = hubQuery.data?.sitemap ?? null;
  if (!sitemap) {
    return (
      <EmptyState
        icon={MapIcon}
        title="No sitemap yet"
        message="When an agent attaches the sitemap to a website task as website-sitemap.html, it shows here with its version and approval. Ask the project lead for it in a new task."
        action="New task"
        onAction={() => openNewIssue({ projectId })}
      />
    );
  }

  const approvalCard = cards.find((card) => decisionCardTaskId(card) === sitemap.task.id) ?? null;
  const approval = APPROVAL_LABELS[sitemapApprovalState(sitemap, approvalCard !== null)]!;
  return (
    <div className="space-y-6" data-testid="website-sitemap">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h2 className="text-lg font-semibold">{sitemap.title}</h2>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Pill className="bg-muted text-foreground">Version {sitemap.version} of {sitemap.versionCount}</Pill>
            {sitemap.status ? <Pill className="bg-muted text-foreground">{sitemap.status === "draft" ? "Draft" : "Final"}</Pill> : null}
            <Pill className={approval.className}>{approval.label}</Pill>
            <span>
              From <Link to={taskHref(sitemap.task)} className="hover:underline">{sitemap.task.identifier ?? sitemap.task.title}</Link>, <When at={sitemap.createdAt} />
            </span>
          </div>
          {sitemap.filename ? <p className="break-all font-mono text-xs text-muted-foreground">{sitemap.filename}</p> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {approvalCard ? (
            <Button asChild size="sm">
              <a href="#website-sitemap-approval">Go to the approval card</a>
            </Button>
          ) : (
            <Button asChild size="sm" variant="outline">
              <Link to={taskHref(sitemap.task)}>Open the task</Link>
            </Button>
          )}
          <Button asChild size="sm" variant="outline">
            <a href={sitemap.contentPath} target="_blank" rel="noreferrer">
              <ExternalLink />
              Open in new tab
            </a>
          </Button>
        </div>
      </div>
      <div className="relative h-(--sz-70vh) overflow-hidden rounded-xl border border-border">
        <DeliverableDocumentView source={{ ...sitemap, external: false, originalFilename: sitemap.filename }} />
      </div>
      {approvalCard ? (
        <section id="website-sitemap-approval" className="scroll-mt-6 space-y-4" aria-labelledby="website-sitemap-approval-title">
          <h2 id="website-sitemap-approval-title" className="text-lg font-semibold">Approval</h2>
          <DecisionFeedCard
            card={approvalCard}
            companyId={companyId}
            assignableAgents={assignableAgents}
            agentMap={agentMap}
            currentUserId={currentUserId}
          />
        </section>
      ) : null}
    </div>
  );
}

/* ---- Preview ---- */

export type WebsitePreviewDevice = "laptop" | "tablet" | "phone";
type Device = WebsitePreviewDevice;

/** Preview widths: laptop, tablet and phone (plan 3.4). */
export const WEBSITE_PREVIEW_DEVICES: { value: Device; label: string; width: number; icon: typeof Laptop }[] = [
  { value: "laptop", label: "Laptop", width: 1440, icon: Laptop },
  { value: "tablet", label: "Tablet", width: 768, icon: Tablet },
  { value: "phone", label: "Phone", width: 390, icon: Smartphone },
];

/** The live preview may run its own scripts, but never steer this page. */
const PREVIEW_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups";

function PreviewLinksList({
  links,
  selected,
  onShow,
}: {
  links: WebsiteHubPreviewLink[];
  selected: string | null;
  onShow: (url: string) => void;
}) {
  return (
    <Panel title="Deploy previews posted on website tasks">
      {links.length === 0 ? (
        <p className="text-xs text-muted-foreground">No Netlify preview links yet. Links that agents post on website tasks show here.</p>
      ) : (
        <ul className="divide-y divide-border/60" aria-label="Deploy previews">
          {links.map((link) => (
            <li key={link.url} className="flex min-w-0 flex-col gap-2 py-2 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-sm" title={link.url}>{link.url.replace(/^https:\/\//, "")}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {link.source === "comment" ? `Comment by ${link.label}` : `Work product: ${link.label}`} on{" "}
                  <Link to={taskHref(link.task)} className="hover:underline">{link.task.identifier ?? link.task.title}</Link> · <When at={link.postedAt} />
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button type="button" size="sm" variant="outline" aria-pressed={selected === link.url} onClick={() => onShow(link.url)}>
                  Show here
                </Button>
                <Button asChild size="sm" variant="ghost">
                  <a href={link.url} target="_blank" rel="noreferrer" aria-label={`Open ${link.url} in a new tab`}>
                    <ExternalLink />
                  </a>
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** How long a frame may take to load before the page offers the new tab instead. */
const PREVIEW_SLOW_MS = 8_000;

/**
 * The site in a frame, never a blank box: a calm placeholder while it loads,
 * and, if it has not loaded after a while (most often a site that refuses
 * to be framed), a clear message with "Open in new tab".
 */
export function PreviewStage({ url, device, width, className = "h-(--sz-80vh) min-h-96 rounded-xl border border-border" }: {
  url: string;
  device: Device;
  width: number;
  /** The stage's size and frame; the Home hero sets its own. */
  className?: string;
}) {
  const [state, setState] = useState<"loading" | "loaded" | "slow">("loading");
  useEffect(() => {
    setState("loading");
    const timer = window.setTimeout(() => setState((current) => (current === "loading" ? "slow" : current)), PREVIEW_SLOW_MS);
    return () => window.clearTimeout(timer);
  }, [url]);
  const host = url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return (
    <div className={cn("relative overflow-hidden bg-muted", className)} data-preview-state={state}>
      <ScaledFrame
        key={url}
        src={url}
        title={`Website preview, ${device} width`}
        width={width}
        sandbox={PREVIEW_SANDBOX}
        testId="website-preview-frame"
        viewport={device}
        onLoad={() => setState("loaded")}
      />
      {state === "loaded" ? null : (
        <div className="absolute inset-0 flex items-center justify-center bg-muted p-6" data-testid="website-preview-placeholder">
          <div className="flex max-w-sm flex-col items-center gap-3 text-center">
            <span className="flex size-12 items-center justify-center rounded-full border border-border bg-card">
              <Globe className="size-5 text-muted-foreground" aria-hidden="true" />
            </span>
            {state === "loading" ? (
              <p className="text-sm text-muted-foreground" role="status">
                Loading <span className="font-mono text-foreground">{host}</span>
              </p>
            ) : (
              <>
                <p className="text-sm font-medium">The site is not showing here</p>
                <p className="text-xs text-muted-foreground">
                  It may still be starting, or it may not allow being shown inside another page. That is the site keeping
                  itself safe; open it in a new tab instead.
                </p>
                <Button asChild size="sm">
                  <a href={url} target="_blank" rel="noreferrer">
                    <ExternalLink />
                    Open in new tab
                  </a>
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function WebsitePreviewTab({ companyId, property }: { companyId: string; property: WebsiteProperty }) {
  const projectId = property.projectId;
  const projectQuery = useQuery({
    queryKey: [...queryKeys.projects.detail(projectId ?? ""), companyId],
    queryFn: () => projectsApi.get(projectId!, companyId),
    enabled: !!projectId,
    refetchInterval: 30_000,
  });
  const hubQuery = useHub(companyId, property.id, !!projectId);
  const [device, setDevice] = useState<Device>("laptop");
  const [chosenUrl, setChosenUrl] = useState<string | null>(null);

  const project = projectQuery.data;
  const service = pickLivePreviewService(project?.workspaces.flatMap((workspace) => workspace.runtimeServices ?? []));
  const liveUrl = liveSiteUrl(property.siteUrl);
  // A chosen deploy preview, else the running workspace preview, else the live site.
  const url = chosenUrl ?? service?.url ?? liveUrl;
  const source = chosenUrl
    ? "Deploy preview"
    : service
      ? `Workspace preview (${service.serviceName}${service.port ? `, port ${service.port}` : ""})`
      : liveUrl
        ? "Live site"
        : null;
  const problem = url ? framingProblem(url, window.location.protocol) : null;
  const width = WEBSITE_PREVIEW_DEVICES.find((entry) => entry.value === device)!.width;

  return (
    <div className="space-y-6" data-testid="website-preview">
      <section className="space-y-4" aria-labelledby="website-preview-frame">
        {/* The site leads; the controls stay quiet above it. */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="website-preview-frame" className="sr-only">Preview</h2>
          <p className="min-w-0 truncate text-xs text-muted-foreground">
            {url ? (
              <>
                <span className="font-medium text-foreground">{source}</span>
                <span className="font-mono"> {url.replace(/^https?:\/\//, "").replace(/\/$/, "")}</span>
              </>
            ) : (
              "No preview is running."
            )}
          </p>
          <div className="flex flex-wrap items-center gap-1">
            <div className="flex items-center gap-0.5" role="group" aria-label="Preview width">
              {WEBSITE_PREVIEW_DEVICES.map((entry) => {
                const Icon = entry.icon;
                const active = entry.value === device;
                return (
                  <button
                    key={entry.value}
                    type="button"
                    aria-pressed={active}
                    title={`${entry.label} width (${entry.width} px)`}
                    onClick={() => setDevice(entry.value)}
                    className={cn(
                      "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                    )}
                  >
                    <Icon className="size-3.5" aria-hidden="true" />
                    {entry.label}
                  </button>
                );
              })}
            </div>
            {chosenUrl && (service?.url || liveUrl) ? (
              <Button type="button" size="xs" variant="ghost" onClick={() => setChosenUrl(null)}>
                {service?.url ? "Back to workspace preview" : "Back to the live site"}
              </Button>
            ) : null}
            {url ? (
              <Button asChild size="xs" variant="ghost">
                <a href={url} target="_blank" rel="noreferrer">
                  <ExternalLink />
                  Open in new tab
                </a>
              </Button>
            ) : null}
          </div>
        </div>
        {!url ? (
          <EmptyState
            icon={Globe}
            title="No preview to show"
            message="Start the preview from the card below, or pick a deploy preview. The Greatstone Website project serves its preview on port 4100."
          />
        ) : problem ? (
          <div className="flex h-(--sz-50vh) flex-col items-center justify-center gap-3 rounded-xl border border-border bg-muted p-6 text-center">
            <p role="alert" className="max-w-md text-sm text-muted-foreground">{problem}</p>
            <Button asChild size="sm">
              <a href={url} target="_blank" rel="noreferrer">
                <ExternalLink />
                Open in new tab
              </a>
            </Button>
          </div>
        ) : (
          <PreviewStage url={url} device={device} width={width} />
        )}
      </section>
      {!projectId ? (
        <LinkProjectFirst companyId={companyId} property={property} />
      ) : projectQuery.error ? (
        <ErrorState error={projectQuery.error} compact onRetry={() => void projectQuery.refetch()} />
      ) : (
        <>
          {project ? <LivePreviewCard project={project} companyId={companyId} /> : null}
          {hubQuery.error ? (
            <ErrorState error={hubQuery.error} compact onRetry={() => void hubQuery.refetch()} />
          ) : (
            <PreviewLinksList links={hubQuery.data?.previewLinks ?? []} selected={chosenUrl} onShow={setChosenUrl} />
          )}
        </>
      )}
    </div>
  );
}
