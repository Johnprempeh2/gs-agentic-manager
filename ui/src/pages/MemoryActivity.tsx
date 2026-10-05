import { useCallback, useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  MEMORY_RECORD_STATUSES,
  type MemoryActivityItem,
  type MemoryActorRef,
  type MemoryContributorActivity,
  type MemoryRecordStatus,
} from "@greatstone/shared";
import { Brain, Lock, PowerOff, SearchX } from "lucide-react";
import { Link, useSearchParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn, formatDate, formatDateTime } from "@/lib/utils";
import { ApiError } from "../api/client";
import { agentsApi } from "../api/agents";
import { memoryGraphApi, type MemoryActivityFilters } from "../api/memoryGraph";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { PageSkeleton } from "../components/PageSkeleton";
import { MemoryFilterBar, type MemoryCommonFilters } from "../components/memory/MemoryFilterBar";
import { MemoryPageHeader } from "../components/memory/MemoryPageHeader";
import { MemoryStatusBadge } from "../components/memory/MemoryStatusBadge";
import { MemorySourceLink } from "../components/memory/MemoryDetailPanel";
import { actorLabel, memoryStatusMeta } from "../components/memory/memoryLabels";
import { isMemoryDisabled } from "./Memory";

const SEARCH_DEBOUNCE_MS = 250;
const COUNT_STATUSES: MemoryRecordStatus[] = ["unreviewed", "approved", "disputed", "superseded"];

const EVENT_LABEL: Record<string, string> = {
  approve: "Approved",
  dispute: "Disputed",
  supersede: "Replaced an older entry",
  superseded_by: "Replaced by a newer entry",
  conflict_flagged: "Possible conflict flagged",
  conflict_resolved: "Conflict settled",
  delete: "Deleted",
};

type GroupBy = "date" | "contributor";

/** `to` is inclusive on screen; the gateway treats it as exclusive, so send the next day. */
export function toActivityQuery(params: URLSearchParams): MemoryActivityFilters {
  const status = params.get("status");
  const to = params.get("to");
  let toExclusive: string | undefined;
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
    const next = new Date(`${to}T00:00:00.000Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    toExclusive = next.toISOString().slice(0, 10);
  }
  return {
    q: params.get("q") || undefined,
    agentId: params.get("agent") || undefined,
    userId: params.get("user") || undefined,
    scopeId: params.get("scope") || undefined,
    status: MEMORY_RECORD_STATUSES.includes(status as MemoryRecordStatus) ? (status as MemoryRecordStatus) : undefined,
    from: params.get("from") || undefined,
    to: toExclusive,
  };
}

function contributorKey(actor: MemoryActorRef) {
  return actor.agentId ? `agent:${actor.agentId}` : actor.userId ? `user:${actor.userId}` : "system";
}

function dayKey(value: Date | string) {
  return new Date(value).toISOString().slice(0, 10);
}

export function groupActivity(items: MemoryActivityItem[], groupBy: GroupBy) {
  const groups = new Map<string, { label: string; items: MemoryActivityItem[] }>();
  for (const item of items) {
    const key = groupBy === "date" ? dayKey(item.record.createdAt) : contributorKey(item.contributor);
    const label = groupBy === "date" ? formatDate(item.record.createdAt) : actorLabel(item.contributor);
    const group = groups.get(key) ?? { label, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  const list = [...groups.entries()].map(([key, group]) => ({ key, ...group }));
  // Dates newest first; contributors by name, never by how much they added.
  return groupBy === "date"
    ? list.sort((a, b) => b.key.localeCompare(a.key))
    : list.sort((a, b) => a.label.localeCompare(b.label));
}

function ActivityCounts({
  contributors,
  note,
  onDrillDown,
  activeKey,
}: {
  contributors: MemoryContributorActivity[];
  note: string;
  onDrillDown: (actor: MemoryActorRef) => void;
  activeKey: string | null;
}) {
  return (
    <section className="rounded-lg border border-border bg-card" aria-labelledby="memory-activity-counts">
      <div className="space-y-0.5 border-b border-border px-3 py-2">
        <h2 id="memory-activity-counts" className="text-sm font-semibold">Activity by contributor</h2>
        <p className="text-xs text-muted-foreground">{note} Select a name to see the entries.</p>
      </div>
      {contributors.length === 0 ? (
        <p className="px-3 py-3 text-sm text-muted-foreground">No activity in this period.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th scope="col" className="px-3 py-2 font-medium">Contributor</th>
                <th scope="col" className="px-3 py-2 font-medium">Entries added</th>
                {COUNT_STATUSES.map((status) => (
                  <th key={status} scope="col" className="px-3 py-2 font-medium">{memoryStatusMeta[status].label}</th>
                ))}
                <th scope="col" className="px-3 py-2 font-medium">Links stated</th>
                <th scope="col" className="px-3 py-2 font-medium">Review steps</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {contributors.map((row) => {
                const key = contributorKey(row.contributor);
                const drillable = row.contributor.actorType !== "system";
                return (
                  <tr key={key} className={cn(activeKey === key && "bg-accent text-accent-foreground")}>
                    <th scope="row" className="px-3 py-2 text-left font-normal">
                      {drillable ? (
                        <button
                          type="button"
                          aria-pressed={activeKey === key}
                          onClick={() => onDrillDown(row.contributor)}
                          className="underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {actorLabel(row.contributor)}
                        </button>
                      ) : (
                        actorLabel(row.contributor)
                      )}
                    </th>
                    <td className="px-3 py-2 font-mono">{row.contributionCount}</td>
                    {COUNT_STATUSES.map((status) => (
                      <td key={status} className="px-3 py-2 font-mono">{row.contributionCountByStatus[status] ?? 0}</td>
                    ))}
                    <td className="px-3 py-2 font-mono">{row.relationshipsStatedCount}</td>
                    <td className="px-3 py-2 font-mono">{row.reviewActionCount}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ActivityItem({ item, agentNames }: { item: MemoryActivityItem; agentNames: Map<string, string> }) {
  const { record } = item;
  const steps = item.history.filter((event) => EVENT_LABEL[event.action]);
  const heading = record.title?.trim() || record.content?.trim() || (record.status === "deleted" ? "Deleted entry" : "Untitled entry");
  const stepActor = (agentId: string | null, userId: string | null): MemoryActorRef => ({
    actorType: agentId ? "agent" : userId ? "user" : "system",
    agentId,
    userId,
    name: agentId ? agentNames.get(agentId) ?? null : null,
  });

  return (
    <li className="space-y-2 px-3 py-3">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 text-sm font-medium line-clamp-2 break-words">{heading}</p>
        <MemoryStatusBadge status={record.status} />
      </div>
      <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
        <div className="flex gap-1.5">
          <dt className="text-muted-foreground">Contributor</dt>
          <dd>{actorLabel(item.contributor)} · {formatDateTime(record.createdAt)}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-muted-foreground">Scope</dt>
          <dd>{item.scopeName}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-muted-foreground">Source</dt>
          <dd><MemorySourceLink source={item.source} /></dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-muted-foreground">Engine extraction</dt>
          <dd>{item.extractedFactCount === 0 ? "None yet" : `${item.extractedFactCount} ${item.extractedFactCount === 1 ? "fact" : "facts"}`}</dd>
        </div>
      </dl>
      {steps.length > 0 ? (
        <div className="space-y-0.5">
          <p className="text-xs text-muted-foreground">Reviews and changes</p>
          <ul className="space-y-0.5 text-xs">
            {steps.map((event) => (
              <li key={event.id}>
                {event.action === "conflict_flagged"
                  ? "Possible conflict found by the conflict check"
                  : `${EVENT_LABEL[event.action]} by ${actorLabel(stepActor(event.agentId, event.userId))}`}
                <span className="text-muted-foreground"> · {formatDateTime(event.createdAt)}</span>
                {event.relatedRecordId && (event.action === "supersede" || event.action === "superseded_by") ? (
                  <>
                    {" · "}
                    <Link to={`/memory?node=${encodeURIComponent(event.relatedRecordId)}`} className="underline underline-offset-2">
                      {event.action === "supersede" ? "Older entry" : "Newer entry"}
                    </Link>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No review yet.</p>
      )}
      {record.status !== "deleted" ? (
        <Link
          to={`/memory?node=${encodeURIComponent(record.id)}`}
          className="inline-block text-xs underline underline-offset-2 hover:text-foreground"
        >
          Show in graph
        </Link>
      ) : null}
    </li>
  );
}

export function MemoryActivity() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [params, setParams] = useSearchParams();
  const query = useMemo(() => toActivityQuery(params), [params]);
  const groupBy: GroupBy = params.get("group") === "contributor" ? "contributor" : "date";
  const [searchText, setSearchText] = useState(query.q ?? "");

  useEffect(() => {
    setBreadcrumbs([{ label: "Memory", href: "/memory" }, { label: "Contributions" }]);
  }, [setBreadcrumbs]);

  const updateParams = useCallback(
    (patch: Record<string, string | undefined>) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          for (const [key, value] of Object.entries(patch)) {
            if (value) next.set(key, value);
            else next.delete(key);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  useEffect(() => {
    const trimmed = searchText.trim();
    if (trimmed === (query.q ?? "")) return;
    const timer = window.setTimeout(() => updateParams({ q: trimmed || undefined }), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchText, query.q, updateParams]);

  const { agentId: _agent, userId: _user, ...countsQuery } = query;
  const feed = useInfiniteQuery({
    queryKey: queryKeys.memoryGraph.activity(selectedCompanyId ?? "", { ...query }),
    queryFn: ({ pageParam }) => memoryGraphApi.activity(selectedCompanyId!, { ...query, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: !!selectedCompanyId,
    retry: (count, error) => !(error instanceof ApiError && (error.status === 403 || isMemoryDisabled(error))) && count < 2,
  });
  const counts = useQuery({
    queryKey: queryKeys.memoryGraph.activityCounts(selectedCompanyId ?? "", { ...countsQuery }),
    queryFn: () => memoryGraphApi.activityCounts(selectedCompanyId!, countsQuery),
    enabled: !!selectedCompanyId,
    retry: false,
  });
  const scopes = useQuery({
    queryKey: queryKeys.memoryGraph.graph(selectedCompanyId ?? "", {}),
    queryFn: () => memoryGraphApi.graph(selectedCompanyId!, {}),
    enabled: !!selectedCompanyId,
    retry: false,
    select: (graph) => graph.scopes,
  });
  const agents = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? ""),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const agentNames = useMemo(() => new Map((agents.data ?? []).map((agent) => [agent.id, agent.name])), [agents.data]);

  const items = useMemo(() => feed.data?.pages.flatMap((page) => page.items) ?? [], [feed.data]);
  const groups = useMemo(() => groupActivity(items, groupBy), [items, groupBy]);
  const activeKey = query.agentId ? `agent:${query.agentId}` : query.userId ? `user:${query.userId}` : null;
  const filtered = Boolean(query.q || query.agentId || query.userId || query.scopeId || query.status || query.from || query.to);

  const drillDown = (actor: MemoryActorRef) => {
    const key = contributorKey(actor);
    if (key === activeKey) updateParams({ agent: undefined, user: undefined });
    else updateParams({ agent: actor.agentId ?? undefined, user: actor.agentId ? undefined : actor.userId ?? undefined });
  };
  const clearFilters = () => {
    setSearchText("");
    updateParams({ q: undefined, agent: undefined, user: undefined, scope: undefined, status: undefined, from: undefined, to: undefined });
  };

  if (!selectedCompanyId) {
    return <p className="text-sm text-muted-foreground">Select an organization first.</p>;
  }

  const header = <MemoryPageHeader tab="contributions" />;
  const error = feed.error ?? counts.error;
  if (error instanceof ApiError && error.status === 403) {
    return (
      <div className="space-y-4">
        {header}
        <EmptyState icon={Lock} message="You do not have access to memory in this organization." description="Ask a board admin if you need to see it." />
      </div>
    );
  }
  if (isMemoryDisabled(error)) {
    return (
      <div className="space-y-4">
        {header}
        <EmptyState icon={PowerOff} message="Memory is turned off for this organization." description="A board admin can turn it on in organization settings." />
      </div>
    );
  }

  const filterValues: MemoryCommonFilters = { q: query.q, agentId: query.agentId, scopeId: query.scopeId, status: query.status };

  return (
    <div className="space-y-4">
      {header}
      <MemoryFilterBar
        filters={filterValues}
        statuses={MEMORY_RECORD_STATUSES}
        searchText={searchText}
        onSearchTextChange={setSearchText}
        onChange={(next) => updateParams({ q: next.q, agent: next.agentId, user: next.agentId ? undefined : query.userId, scope: next.scopeId, status: next.status })}
        agents={(agents.data ?? []).map((agent) => ({ id: agent.id, name: agent.name }))}
        scopes={scopes.data ?? []}
      >
        <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          From
          <Input type="date" className="h-9 w-auto" value={params.get("from") ?? ""} onChange={(event) => updateParams({ from: event.target.value || undefined })} />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          To
          <Input type="date" className="h-9 w-auto" value={params.get("to") ?? ""} onChange={(event) => updateParams({ to: event.target.value || undefined })} />
        </label>
        </div>
      </MemoryFilterBar>

      {counts.data ? (
        <ActivityCounts contributors={counts.data.contributors} note={counts.data.note} onDrillDown={drillDown} activeKey={activeKey} />
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Entries</h2>
        <div className="flex items-center gap-1" role="group" aria-label="Group entries by">
          <span className="mr-1 text-xs text-muted-foreground">Group by</span>
          {(["date", "contributor"] as const).map((value) => (
            <Button
              key={value}
              size="sm"
              variant={groupBy === value ? "secondary" : "ghost"}
              aria-pressed={groupBy === value}
              onClick={() => updateParams({ group: value === "date" ? undefined : value })}
            >
              {value === "date" ? "Date" : "Contributor"}
            </Button>
          ))}
        </div>
      </div>

      {feed.isLoading ? (
        <PageSkeleton variant="list" />
      ) : feed.error && !feed.data ? (
        <ErrorState error={feed.error} onRetry={() => void feed.refetch()} />
      ) : items.length === 0 ? (
        filtered ? (
          <EmptyState icon={SearchX} message="No contributions match these filters." action="Clear filters" onAction={clearFilters} hideActionIcon />
        ) : (
          <EmptyState icon={Brain} message="No contributions yet." description="Entries appear here when agents or people contribute to memory." />
        )
      ) : (
        <div className="space-y-4">
          {groups.map((group) => (
            <section key={group.key} aria-label={group.label}>
              <div className="flex items-center gap-2 rounded-t-md bg-muted/50 px-3 py-2">
                <h3 className="text-sm font-medium">{group.label}</h3>
                <span className="text-xs text-muted-foreground">{group.items.length}</span>
              </div>
              <ul className="divide-y divide-border rounded-b-md border border-border bg-card">
                {group.items.map((item) => (
                  <ActivityItem key={item.record.id} item={item} agentNames={agentNames} />
                ))}
              </ul>
            </section>
          ))}
          {feed.hasNextPage ? (
            <Button variant="outline" onClick={() => void feed.fetchNextPage()} disabled={feed.isFetchingNextPage}>
              {feed.isFetchingNextPage ? "Loading…" : "Load more"}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
