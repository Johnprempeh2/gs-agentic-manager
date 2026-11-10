import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { LINK_STATUSES, LINK_TYPES, type LinkStatus, type LinkType } from "@greatstone/shared";
import { Layers, Link2, Plus, Search, X } from "lucide-react";
import { useSearchParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { linksApi } from "../api/links";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { PageSkeleton } from "../components/PageSkeleton";
import { FilterMenu } from "../components/FilterMenu";
import { AddLinkDialog, LinkRow } from "../components/links/LinkRow";
import { LINK_STATUS_LABELS, LINK_TYPE_LABELS, groupLinksByClient } from "../lib/links-register";
import { queryKeys } from "../lib/queryKeys";

const TYPE_OPTIONS = LINK_TYPES.map((value) => ({ value, label: LINK_TYPE_LABELS[value] }));
const STATUS_OPTIONS = LINK_STATUSES.map((value) => ({ value, label: LINK_STATUS_LABELS[value] }));
const FILTER_KEYS = ["q", "client", "project", "type", "status"] as const;

/**
 * The links register (GRE-4252): every link we share, grouped by client, so
 * John and Ben find a site or portal without asking Everest.
 */
export function Links() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get("q") ?? "";
  const clientCaseId = searchParams.get("client");
  const projectId = searchParams.get("project");
  const type = searchParams.get("type") as LinkType | null;
  const status = searchParams.get("status") as LinkStatus | null;
  const grouped = searchParams.get("group") !== "none";
  const [draftQuery, setDraftQuery] = useState(query);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    setBreadcrumbs([{ label: "Links" }]);
  }, [setBreadcrumbs]);

  function setParam(key: string, value: string | null) {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    }, { replace: true });
  }

  // Search as you type, a beat after the last key.
  useEffect(() => {
    const handle = window.setTimeout(() => {
      if (draftQuery.trim() !== query) setParam("q", draftQuery.trim() || null);
    }, 250);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftQuery]);

  const listParams = {
    q: query || undefined,
    clientCaseId: clientCaseId ?? undefined,
    projectId: projectId ?? undefined,
    type: type ?? undefined,
    status: status ?? undefined,
  };
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.links.list(selectedCompanyId ?? "", listParams),
    queryFn: () => linksApi.list(selectedCompanyId!, listParams),
    enabled: !!selectedCompanyId,
  });
  const { data: allProjects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId ?? ""),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  // The server lists every client and project in the register, whatever the filters.
  const facets = data?.facets ?? { clients: [], projects: [] };
  const links = data?.links ?? [];
  const groups = useMemo(
    () => (grouped ? groupLinksByClient(links) : [{ key: "all", label: "", items: links }]),
    [grouped, links],
  );
  const filtered = FILTER_KEYS.some((key) => searchParams.get(key));

  if (!selectedCompanyId) {
    return <EmptyState icon={Link2} message="Choose an organisation to view its links." />;
  }

  return (
    <div className="w-full max-w-5xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Every link we share: sites, client portals, previews and decks, by client.
        </p>
        <Button size="sm" onClick={() => setAdding(true)} data-tour="links-add">
          <Plus />
          Add link
        </Button>
      </div>

      <div className="space-y-3">
        <div className="relative w-full max-w-2xl">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <input
            value={draftQuery}
            onChange={(event) => setDraftQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && draftQuery) setDraftQuery("");
            }}
            type="search"
            placeholder="Search titles, addresses, clients, tasks and notes"
            aria-label="Search links"
            className="h-12 w-full rounded-lg border border-input bg-background pl-12 pr-12 text-base shadow-xs outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 [&::-webkit-search-cancel-button]:hidden"
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
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2" data-testid="link-filters">
          <FilterMenu
            label="Client"
            allLabel="All clients"
            value={clientCaseId}
            options={facets.clients.map((client) => ({ value: client.id, label: client.name }))}
            onChange={(value) => setParam("client", value)}
            testId="link-filter-client"
          />
          <FilterMenu
            label="Project"
            allLabel="All projects"
            value={projectId}
            options={facets.projects.map((project) => ({ value: project.id, label: project.name }))}
            onChange={(value) => setParam("project", value)}
            testId="link-filter-project"
          />
          <FilterMenu
            label="Type"
            allLabel="All types"
            value={type}
            options={TYPE_OPTIONS}
            onChange={(value) => setParam("type", value)}
            testId="link-filter-type"
          />
          <FilterMenu
            label="Status"
            allLabel="Live, draft and broken"
            value={status}
            options={STATUS_OPTIONS}
            onChange={(value) => setParam("status", value)}
            testId="link-filter-status"
          />
        </div>
      </div>

      {error && !isLoading ? <ErrorState error={error} onRetry={() => void refetch()} compact={!!data} /> : null}

      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : error && !data ? null : links.length === 0 ? (
        filtered ? (
          <EmptyState
            icon={Search}
            message="No links match."
            description="Try part of the address, or clear a filter."
            action="Clear search and filters"
            hideActionIcon
            onAction={() => {
              setDraftQuery("");
              setSearchParams((current) => {
                const next = new URLSearchParams(current);
                for (const key of FILTER_KEYS) next.delete(key);
                return next;
              }, { replace: true });
            }}
          />
        ) : (
          <EmptyState
            icon={Link2}
            title="No links yet"
            message="When an agent registers a site, a deliverable link or a preview, it lands here under its client. You can add any other link by hand."
          />
        )
      ) : (
        <div className="space-y-8">
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 text-xs text-muted-foreground" aria-live="polite">
              {data?.total ?? links.length} {(data?.total ?? links.length) === 1 ? "link" : "links"}
            </p>
            <Button
              variant="outline"
              size="sm"
              aria-pressed={grouped}
              onClick={() => setParam("group", grouped ? "none" : null)}
              data-testid="link-group-toggle"
            >
              <Layers />
              {grouped ? "By client" : "No grouping"}
            </Button>
          </div>
          {groups.map((group) => (
            <section key={group.key} aria-label={group.label || "Links"} data-testid="link-group">
              {group.label ? (
                <h2 className="mb-1 text-xs font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
                  {group.label} <span className="font-normal">· {group.items.length}</span>
                </h2>
              ) : null}
              <ul className="divide-y divide-border border-y border-border">
                {group.items.map((link) => (
                  <LinkRow key={link.id} link={link} companyId={selectedCompanyId} showClient={!grouped} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      <AddLinkDialog
        companyId={selectedCompanyId}
        open={adding}
        onOpenChange={setAdding}
        clients={facets.clients}
        projects={(allProjects ?? []).map((project) => ({ id: project.id, name: project.name }))}
      />
    </div>
  );
}

export default Links;
