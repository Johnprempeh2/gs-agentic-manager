import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { Project } from "@greatstone/shared";
import { ArrowUpDown, Check, ChevronDown, FileCheck2, Layers, Search, X } from "lucide-react";
import {
  deliverablesApi,
  type Deliverable,
  type DeliverableKind,
  type DeliverableSort,
} from "../api/deliverables";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useOptionalToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { copyTextToClipboard } from "../lib/clipboard";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { PageSkeleton } from "../components/PageSkeleton";
import {
  DELIVERABLE_KIND_LABELS,
  DeliverableCard,
  deliverableShareUrl,
} from "../components/deliverables/DeliverableCard";
import { DeliverableQuickLook } from "../components/deliverables/DeliverableQuickLook";
import { LivePreviewCard, workspaceHasPreview } from "../components/LivePreviewCard";
import { projectsApi } from "../api/projects";
import { useNavigate, useSearchParams } from "@/lib/router";
import { goBackOr } from "@/lib/mobile-back";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 60;
const SEARCH_DEBOUNCE_MS = 150;

export const DELIVERABLE_SORT_OPTIONS: { value: DeliverableSort; label: string }[] = [
  { value: "newest", label: "Newest" },
  { value: "recently_opened", label: "Recently opened" },
  { value: "title", label: "A–Z" },
];

type GroupBy = "none" | "project" | "month";

/** Projects whose primary workspace serves a preview, for the cards above the list. */
export function projectsWithPreview(projects: Project[] | undefined, projectId: string | null) {
  return (projects ?? []).filter((project) => {
    if (projectId && project.id !== projectId) return false;
    const workspace = project.primaryWorkspace;
    return Boolean(workspace) && workspaceHasPreview({
      runtimeConfig: workspace?.runtimeConfig?.workspaceRuntime ?? null,
      runtimeServices: workspace?.runtimeServices ?? null,
    });
  });
}
type DateRange = "all" | "week" | "month";

const GROUP_OPTIONS: { value: GroupBy; label: string }[] = [
  { value: "none", label: "None" },
  { value: "project", label: "Project" },
  { value: "month", label: "Month" },
];

const DATE_OPTIONS: { value: DateRange; label: string }[] = [
  { value: "all", label: "All time" },
  { value: "week", label: "This week" },
  { value: "month", label: "This month" },
];

const KIND_OPTIONS = (Object.keys(DELIVERABLE_KIND_LABELS) as DeliverableKind[]).map((value) => ({
  value,
  label: DELIVERABLE_KIND_LABELS[value],
}));

export const EXAMPLE_DELIVERABLE_PROMPT =
  "Write a one-page brief on our Q4 hiring plan as a Greatstone-branded HTML deliverable.";

function parseOption<T extends string>(value: string | null, options: { value: T }[], fallback: T): T {
  return options.some((option) => option.value === value) ? (value as T) : fallback;
}

/** Start of the date range in local time, as an ISO string. */
export function dateRangeStart(range: DateRange, now = new Date()): string | undefined {
  if (range === "all") return undefined;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (range === "week") {
    // Weeks start on Monday.
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  } else {
    start.setDate(1);
  }
  return start.toISOString();
}

export function groupDeliverables(items: Deliverable[], groupBy: GroupBy) {
  if (groupBy === "none") return [{ key: "all", label: null as string | null, items }];
  const groups = new Map<string, { key: string; label: string | null; items: Deliverable[] }>();
  for (const item of items) {
    const key = groupBy === "project"
      ? item.project?.id ?? "none"
      : item.createdAt.slice(0, 7);
    const label = groupBy === "project"
      ? item.project?.name ?? "No project"
      : new Date(item.createdAt).toLocaleDateString(undefined, { month: "long", year: "numeric" });
    const group = groups.get(key) ?? { key, label, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function FilterMenu<T extends string>({
  label,
  value,
  allLabel,
  options,
  onChange,
  testId,
}: {
  label: string;
  value: T | null;
  allLabel: string;
  options: { value: T; label: string }[];
  onChange: (value: T | null) => void;
  testId: string;
}) {
  const selected = options.find((option) => option.value === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid={testId}
          className={cn(
            "inline-flex h-8 items-center gap-1 rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            selected
              ? "border-foreground/20 bg-accent text-foreground"
              : "border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground",
          )}
        >
          {selected ? `${label}: ${selected.label}` : label}
          <ChevronDown className="h-3 w-3" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-56 overflow-y-auto">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => onChange(null)} className="justify-between">
          {allLabel}
          {!selected ? <Check className="h-3.5 w-3.5" /> : null}
        </DropdownMenuItem>
        {options.map((option) => (
          <DropdownMenuItem key={option.value} onSelect={() => onChange(option.value)} className="justify-between">
            <span className="truncate">{option.label}</span>
            {option.value === value ? <Check className="h-3.5 w-3.5" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Deliverables() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const toast = useOptionalToastActions();
  const pushToast = toast?.pushToast ?? (() => null);
  const [searchParams, setSearchParams] = useSearchParams();
  const searchRef = useRef<HTMLInputElement | null>(null);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);

  const query = searchParams.get("q") ?? "";
  const kindParam = searchParams.get("kind");
  const kind = KIND_OPTIONS.some((option) => option.value === kindParam) ? kindParam as DeliverableKind : null;
  const projectId = searchParams.get("projectId");
  const agentId = searchParams.get("agentId");
  const brand = searchParams.get("brand");
  const dateRange = parseOption(searchParams.get("date"), DATE_OPTIONS, "all");
  const sort = parseOption(searchParams.get("sort"), DELIVERABLE_SORT_OPTIONS, "newest");
  const groupBy = parseOption(searchParams.get("group"), GROUP_OPTIONS, "none");
  const openId = searchParams.get("open");

  const [draftQuery, setDraftQuery] = useState(query);
  const navigate = useNavigate();
  // Arriving on a deliverable from another page in the app (a chat link, a
  // toast) closes back to that page; the installed app has no browser Back.
  // A shared link (first page of the visit) and a card opened here close to
  // the list.
  const [returnOnClose, setReturnOnClose] = useState(() => {
    const historyIndex = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    return !!openId && historyIndex > 0;
  });

  useEffect(() => {
    setBreadcrumbs([{ label: "Deliverables" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    setDraftQuery((prev) => (prev.trim() === query ? prev : query));
  }, [query]);

  const updateParams = useCallback(
    (mutate: (next: URLSearchParams) => void, replace = false) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        mutate(next);
        return next;
      }, { replace });
    },
    [setSearchParams],
  );

  const setParam = useCallback(
    (key: string, value: string | null) => updateParams((next) => {
      if (value) next.set(key, value);
      else next.delete(key);
    }),
    [updateParams],
  );

  // Results follow the search box as you type.
  useEffect(() => {
    const trimmed = draftQuery.trim();
    if (trimmed === query) return;
    const handle = window.setTimeout(() => {
      updateParams((next) => {
        if (trimmed) next.set("q", trimmed);
        else next.delete("q");
      }, true);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [draftQuery, query, updateParams]);

  // "/" focuses the search box from anywhere on the page.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target) || openId) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openId]);

  const from = useMemo(() => dateRangeStart(dateRange), [dateRange]);
  const listParams = {
    q: query || undefined,
    kind: kind ?? undefined,
    projectId: projectId ?? undefined,
    agentId: agentId ?? undefined,
    brand: brand ?? undefined,
    from,
    sort,
  };

  const {
    data,
    isLoading,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
    error,
    refetch,
  } = useInfiniteQuery({
    queryKey: queryKeys.deliverables.list(selectedCompanyId ?? "", listParams),
    queryFn: ({ pageParam }) =>
      deliverablesApi.list(selectedCompanyId!, { ...listParams, limit: PAGE_SIZE, offset: pageParam }),
    enabled: !!selectedCompanyId,
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.nextOffset ?? undefined,
    placeholderData: (previous) => previous,
  });

  useEffect(() => {
    const target = loadMoreRef.current;
    if (!target || !hasNextPage || isFetchingNextPage) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void fetchNextPage();
    }, { rootMargin: "480px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  const deliverables = useMemo(() => data?.pages.flatMap((page) => page.deliverables) ?? [], [data]);
  const facets = data?.pages[0]?.facets ?? { brands: [], agents: [], projects: [] };
  const total = data?.pages[0]?.total ?? 0;
  const groups = useMemo(() => groupDeliverables(deliverables, groupBy), [deliverables, groupBy]);
  // Quick Look moves through cards in the order they are shown.
  const ordered = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const openIndex = openId ? ordered.findIndex((item) => item.id === openId) : -1;

  const filtered = !!(query || kind || projectId || agentId || brand || dateRange !== "all");

  const copyLink = useCallback(async (id: string) => {
    try {
      await copyTextToClipboard(deliverableShareUrl(id));
      pushToast({ title: "Link copied", tone: "success", ttlMs: 2500 });
    } catch {
      pushToast({ title: "Could not copy the link", tone: "error" });
    }
  }, [pushToast]);

  const closeQuickLook = useCallback(() => {
    if (returnOnClose) {
      setReturnOnClose(false);
      goBackOr(navigate, "/deliverables");
    } else {
      setParam("open", null);
    }
  }, [navigate, returnOnClose, setParam]);
  const navigateQuickLook = useCallback(
    (id: string) => updateParams((next) => next.set("open", id), true),
    [updateParams],
  );

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId ?? ""),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const previewProjects = projectsWithPreview(projects, projectId);

  if (!selectedCompanyId) {
    return <EmptyState icon={FileCheck2} message="Select an organization to view deliverables." />;
  }

  return (
    <div className="w-full max-w-7xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl font-bold">Deliverables</h1>
        <p className="text-sm text-muted-foreground">Finished documents your agents made for you.</p>
      </header>

      <div className="space-y-3">
        <div className="relative w-full max-w-2xl">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <input
            ref={searchRef}
            value={draftQuery}
            onChange={(event) => setDraftQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                if (draftQuery) setDraftQuery("");
                else event.currentTarget.blur();
              }
            }}
            type="search"
            placeholder="Search titles, tasks, agents and document text"
            aria-label="Search deliverables"
            className="h-12 w-full rounded-lg border border-input bg-background pl-12 pr-16 text-base shadow-xs outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 [&::-webkit-search-cancel-button]:hidden"
          />
          {draftQuery ? (
            <button
              type="button"
              onClick={() => setDraftQuery("")}
              aria-label="Clear search"
              className="absolute right-3 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          ) : (
            <kbd className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 rounded border border-border bg-muted px-1.5 font-mono text-xs text-muted-foreground">
              /
            </kbd>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by kind">
            {[{ value: null, label: "All" }, ...KIND_OPTIONS].map((option) => {
              const active = kind === option.value;
              return (
                <button
                  key={option.label}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setParam("kind", option.value)}
                  className={cn(
                    "inline-flex h-8 items-center rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    active
                      ? "border-foreground/20 bg-accent text-foreground"
                      : "border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  )}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          <span className="mx-1 hidden h-5 w-px bg-border sm:block" aria-hidden="true" />
          <FilterMenu
            label="Project"
            allLabel="All projects"
            value={projectId}
            options={facets.projects.map((project) => ({ value: project.id, label: project.name }))}
            onChange={(value) => setParam("projectId", value)}
            testId="deliverable-filter-project"
          />
          <FilterMenu
            label="Agent"
            allLabel="All agents"
            value={agentId}
            options={facets.agents.map((agent) => ({ value: agent.id, label: agent.name }))}
            onChange={(value) => setParam("agentId", value)}
            testId="deliverable-filter-agent"
          />
          <FilterMenu
            label="Brand"
            allLabel="All brands"
            value={brand}
            options={facets.brands.map((name) => ({ value: name, label: name }))}
            onChange={(value) => setParam("brand", value)}
            testId="deliverable-filter-brand"
          />
          <FilterMenu
            label="Date"
            allLabel="All time"
            value={dateRange === "all" ? null : dateRange}
            options={DATE_OPTIONS.filter((option) => option.value !== "all")}
            onChange={(value) => setParam("date", value)}
            testId="deliverable-filter-date"
          />

          <div className="ml-auto flex items-center gap-1.5">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" data-testid="deliverable-sort">
                  <ArrowUpDown />
                  {DELIVERABLE_SORT_OPTIONS.find((option) => option.value === sort)?.label}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuLabel>Sort by</DropdownMenuLabel>
                {DELIVERABLE_SORT_OPTIONS.map((option) => (
                  <DropdownMenuItem
                    key={option.value}
                    onSelect={() => setParam("sort", option.value === "newest" ? null : option.value)}
                    className="justify-between"
                  >
                    {option.label}
                    {sort === option.value ? <Check className="h-3.5 w-3.5" /> : null}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" data-testid="deliverable-group">
                  <Layers />
                  {groupBy === "none" ? "Group" : `By ${GROUP_OPTIONS.find((option) => option.value === groupBy)?.label.toLowerCase()}`}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuLabel>Group by</DropdownMenuLabel>
                {GROUP_OPTIONS.map((option) => (
                  <DropdownMenuItem
                    key={option.value}
                    onSelect={() => setParam("group", option.value === "none" ? null : option.value)}
                    className="justify-between"
                  >
                    {option.label}
                    {groupBy === option.value ? <Check className="h-3.5 w-3.5" /> : null}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {previewProjects.length > 0 ? (
        <section aria-label="Live previews" className="grid grid-cols-1 gap-3 lg:grid-cols-2" data-testid="deliverables-live-previews">
          {previewProjects.map((project) => (
            <LivePreviewCard key={project.id} project={project} companyId={selectedCompanyId} showProjectName />
          ))}
        </section>
      ) : null}

      {error && !isLoading ? <ErrorState error={error} onRetry={() => void refetch()} compact={!!data} /> : null}

      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : deliverables.length === 0 ? (
        filtered ? (
          <EmptyState
            icon={Search}
            message="No deliverables match."
            description="Try fewer words or clear a filter."
          />
        ) : (
          <div className="flex flex-col items-center pb-16 text-center" data-testid="deliverables-empty">
            <EmptyState
              icon={FileCheck2}
              title="No deliverables yet"
              message="When you ask an agent for a finished document — a report, brief, plan or deck — it lands here, ready to preview, share and download."
            />
            <div className="w-full max-w-lg rounded-lg border border-border bg-muted/40 p-4 text-left">
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Try asking</p>
              <p className="text-sm text-foreground">“{EXAMPLE_DELIVERABLE_PROMPT}”</p>
            </div>
          </div>
        )
      ) : (
        <div className="space-y-8">
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {total} {total === 1 ? "deliverable" : "deliverables"}
          </p>
          {groups.map((group) => (
            <section key={group.key} className="space-y-3" aria-label={group.label ?? "Deliverables"}>
              {group.label ? (
                <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  {group.label} <span className="font-normal">· {group.items.length}</span>
                </h2>
              ) : null}
              <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-3">
                {group.items.map((deliverable) => (
                  <DeliverableCard
                    key={deliverable.id}
                    deliverable={deliverable}
                    onPreview={() => setParam("open", deliverable.id)}
                    onCopyLink={() => void copyLink(deliverable.id)}
                  />
                ))}
              </div>
            </section>
          ))}
          <div ref={loadMoreRef} className="flex min-h-10 items-center justify-center text-xs text-muted-foreground">
            {isFetchingNextPage ? "Loading more deliverables..." : null}
          </div>
        </div>
      )}

      {openId ? (
        <DeliverableQuickLookHost
          companyId={selectedCompanyId}
          openId={openId}
          ordered={ordered}
          openIndex={openIndex}
          onNavigate={navigateQuickLook}
          onClose={closeQuickLook}
          onBack={returnOnClose ? closeQuickLook : undefined}
          onCopyLink={(id) => void copyLink(id)}
        />
      ) : null}
    </div>
  );
}

/**
 * Opens Quick Look on a card in the list, or — for a shared link to a
 * deliverable not in the loaded list — on that one deliverable alone.
 */
function DeliverableQuickLookHost({
  companyId,
  openId,
  ordered,
  openIndex,
  onNavigate,
  onClose,
  onBack,
  onCopyLink,
}: {
  companyId: string;
  openId: string;
  ordered: Deliverable[];
  openIndex: number;
  onNavigate: (id: string) => void;
  onClose: () => void;
  onBack?: () => void;
  onCopyLink: (id: string) => void;
}) {
  const [single, setSingle] = useState<Deliverable | null>(null);
  useEffect(() => {
    if (openIndex >= 0) return;
    let cancelled = false;
    deliverablesApi.get(companyId, openId).then(
      (detail) => { if (!cancelled) setSingle(detail); },
      () => { if (!cancelled) onClose(); },
    );
    return () => { cancelled = true; };
  }, [companyId, openId, openIndex, onClose]);

  if (openIndex >= 0) {
    return (
      <DeliverableQuickLook
        companyId={companyId}
        items={ordered}
        index={openIndex}
        onIndexChange={(index) => onNavigate(ordered[index]!.id)}
        onClose={onClose}
        onBack={onBack}
        onCopyLink={onCopyLink}
      />
    );
  }
  if (!single || single.id !== openId) return null;
  return (
    <DeliverableQuickLook
      companyId={companyId}
      items={[single]}
      index={0}
      onIndexChange={() => undefined}
      onClose={onClose}
      onBack={onBack}
      onCopyLink={onCopyLink}
    />
  );
}
