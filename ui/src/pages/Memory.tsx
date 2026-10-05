import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Box, Brain, List, Lock, PowerOff, SearchX } from "lucide-react";
import { useSearchParams } from "@/lib/router";
import { ApiError } from "../api/client";
import { agentsApi } from "../api/agents";
import { MEMORY_GRAPH_STATUSES, type MemoryGraphNode, type MemoryGraphStatus } from "@greatstone/shared";
import { memoryGraphApi, type MemoryGraphFilters } from "../api/memoryGraph";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { supportsWebGL } from "../lib/webgl";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "../components/ui/button";
import { MemoryFilterBar } from "../components/memory/MemoryFilterBar";
import { MemoryRecordList } from "../components/memory/MemoryRecordList";
import { MemoryEdgeDetail, MemoryNodeDetail } from "../components/memory/MemoryDetailPanel";
import { MemoryGraphLegend } from "../components/memory/MemoryGraphLegend";
import { buildMemoryGraph3D, type MemoryGraphGroupBy } from "../components/memory/memoryGraph3dData";
import { MemoryPageHeader } from "../components/memory/MemoryPageHeader";

/** three.js lives in its own chunk, fetched only when the graph is shown. */
const MemoryGraph3D = lazy(() => import("../components/memory/MemoryGraph3D"));

const SEARCH_DEBOUNCE_MS = 250;

type MemoryView = "graph" | "list";

/** Filters and selection live in the URL so other screens can link to a place in the graph. */
export function readMemoryFilters(params: URLSearchParams): MemoryGraphFilters {
  const status = params.get("status");
  return {
    q: params.get("q") || undefined,
    agentId: params.get("agent") || undefined,
    scopeId: params.get("scope") || undefined,
    status: MEMORY_GRAPH_STATUSES.includes(status as MemoryGraphStatus) ? (status as MemoryGraphStatus) : undefined,
  };
}

/** The gateway answers 404 "Memory is not enabled…" when memory is off; other 404s are real errors. */
export function isMemoryDisabled(error: unknown) {
  return error instanceof ApiError && error.status === 404 && /not enabled/i.test(error.message);
}

function hasFilters(filters: MemoryGraphFilters) {
  return Boolean(filters.q || filters.agentId || filters.scopeId || filters.status);
}

function ToggleButton({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Button type="button" size="xs" variant={pressed ? "secondary" : "ghost"} aria-pressed={pressed} onClick={onClick}>
      {children}
    </Button>
  );
}

export function Memory() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => readMemoryFilters(params), [params]);
  const selectedNodeId = params.get("node");
  const selectedEdgeId = params.get("edge");
  const [searchText, setSearchText] = useState(filters.q ?? "");
  const webgl = useMemo(() => supportsWebGL(), []);
  const view: MemoryView = params.get("view") === "list" || !webgl ? "list" : "graph";
  const groupBy: MemoryGraphGroupBy = params.get("group") === "scope" ? "scope" : "contributor";

  useEffect(() => {
    setBreadcrumbs([{ label: "Memory" }]);
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

  const setFilters = useCallback(
    (next: MemoryGraphFilters) =>
      updateParams({ q: next.q, agent: next.agentId, scope: next.scopeId, status: next.status }),
    [updateParams],
  );

  useEffect(() => {
    const trimmed = searchText.trim();
    if (trimmed === (filters.q ?? "")) return;
    const timer = window.setTimeout(() => updateParams({ q: trimmed || undefined }), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchText, filters.q, updateParams]);

  const graph = useQuery({
    queryKey: queryKeys.memoryGraph.graph(selectedCompanyId ?? "", { ...filters }),
    queryFn: () => memoryGraphApi.graph(selectedCompanyId!, filters),
    enabled: !!selectedCompanyId,
    placeholderData: (previous) => previous,
    retry: (count, error) => !(error instanceof ApiError && (error.status === 403 || isMemoryDisabled(error))) && count < 2,
  });

  const agents = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? ""),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const nodes = useMemo(() => graph.data?.nodes ?? [], [graph.data]);
  const edges = useMemo(() => graph.data?.edges ?? [], [graph.data]);
  const nodesById = useMemo(() => new Map<string, MemoryGraphNode>(nodes.map((node) => [node.id, node])), [nodes]);
  const selectedNode = selectedNodeId ? nodesById.get(selectedNodeId) : undefined;
  const selectedEdge = selectedEdgeId ? edges.find((edge) => edge.id === selectedEdgeId) : undefined;
  const graph3d = useMemo(() => buildMemoryGraph3D(nodes, edges, { groupBy }), [nodes, edges, groupBy]);

  const selectNode = useCallback((id: string) => updateParams({ node: id, edge: undefined }), [updateParams]);
  const selectEdge = useCallback((id: string) => updateParams({ edge: id, node: undefined }), [updateParams]);
  const clearSelection = useCallback(() => updateParams({ node: undefined, edge: undefined }), [updateParams]);
  const clearFilters = useCallback(() => {
    setSearchText("");
    updateParams({ q: undefined, agent: undefined, scope: undefined, status: undefined });
  }, [updateParams]);

  if (!selectedCompanyId) {
    return <p className="text-sm text-muted-foreground">Select an organization first.</p>;
  }

  const header = <MemoryPageHeader tab="connections" />;

  if (graph.error instanceof ApiError && graph.error.status === 403) {
    return (
      <div className="space-y-4">
        {header}
        <EmptyState
          icon={Lock}
          message="You do not have access to memory in this organization."
          description="Ask a board admin if you need to see it."
        />
      </div>
    );
  }

  if (isMemoryDisabled(graph.error)) {
    return (
      <div className="space-y-4">
        {header}
        <EmptyState
          icon={PowerOff}
          message="Memory is turned off for this organization."
          description="A board admin can turn it on in organization settings."
        />
      </div>
    );
  }

  const listSection = (
    <section className="overflow-hidden rounded-lg border border-border bg-card" aria-label="Memory list">
      <div className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
        {nodes.length} {nodes.length === 1 ? "entry" : "entries"}, {edges.length} {edges.length === 1 ? "connection" : "connections"}
        {graph.data?.truncated ? <span className="block">Showing the first {nodes.length}. Narrow the filters to see the rest.</span> : null}
      </div>
      <MemoryRecordList nodes={nodes} edges={edges} selectedNodeId={selectedNode?.id ?? null} onSelectNode={selectNode} />
    </section>
  );

  const entryWord = (count: number) => (count === 1 ? "entry" : "entries");

  return (
    <div className="space-y-4">
      {header}
      <MemoryFilterBar
        filters={filters}
        statuses={MEMORY_GRAPH_STATUSES}
        searchText={searchText}
        onSearchTextChange={setSearchText}
        onChange={setFilters}
        agents={(agents.data ?? []).map((agent) => ({ id: agent.id, name: agent.name }))}
        scopes={graph.data?.scopes ?? []}
      />

      {graph.isLoading ? (
        <PageSkeleton variant="list" />
      ) : graph.error && !graph.data ? (
        <ErrorState error={graph.error} onRetry={() => void graph.refetch()} />
      ) : nodes.length === 0 ? (
        hasFilters(filters) ? (
          <EmptyState
            icon={SearchX}
            message="No memory matches these filters."
            action="Clear filters"
            onAction={clearFilters}
            hideActionIcon
          />
        ) : (
          <EmptyState
            icon={Brain}
            message="No memory yet."
            description="Records appear here when agents or people contribute to memory."
          />
        )
      ) : (
        <div className="grid gap-4 lg:grid-cols-(--gtc-memory-layout)">
          <div className="min-w-0 space-y-4">
            {graph.data?.note ? <p className="text-xs text-muted-foreground">{graph.data.note}</p> : null}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              {webgl ? (
                <div role="group" aria-label="Memory view" className="inline-flex items-center gap-1">
                  <ToggleButton pressed={view === "graph"} onClick={() => updateParams({ view: undefined })}>
                    <Box aria-hidden="true" />
                    Graph
                  </ToggleButton>
                  <ToggleButton pressed={view === "list"} onClick={() => updateParams({ view: "list" })}>
                    <List aria-hidden="true" />
                    List
                  </ToggleButton>
                </div>
              ) : null}
              {view === "graph" ? (
                <div role="group" aria-label="Group entries by" className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <span className="pr-1">Group by</span>
                  <ToggleButton pressed={groupBy === "contributor"} onClick={() => updateParams({ group: undefined })}>
                    Contributor
                  </ToggleButton>
                  <ToggleButton pressed={groupBy === "scope"} onClick={() => updateParams({ group: "scope" })}>
                    Scope
                  </ToggleButton>
                </div>
              ) : null}
            </div>
            {view === "graph" ? (
              <figure className="space-y-2 rounded-lg border border-border bg-card p-2">
                {graph.data?.truncated || graph3d.omittedCount > 0 ? (
                  <p className="px-1 text-xs text-muted-foreground">
                    {graph3d.omittedCount > 0
                      ? `The graph draws the first ${graph3d.memoryCount} of ${nodes.length} entries to stay smooth. `
                      : null}
                    {graph.data?.truncated ? "More entries match than the server sent. Narrow the filters to see the rest." : null}
                  </p>
                ) : null}
                <div
                  role="img"
                  aria-label={`3D memory graph: ${graph3d.memoryCount} ${entryWord(graph3d.memoryCount)} grouped by ${groupBy}, ${edges.length} ${edges.length === 1 ? "connection" : "connections"}. The list beside it has the same entries.`}
                >
                  <Suspense fallback={<div className="h-(--sz-memory-graph-height-phone) w-full animate-pulse rounded-md bg-muted md:h-(--sz-memory-graph-height)" />}>
                    <MemoryGraph3D
                      data={graph3d}
                      selectedNodeId={selectedNode?.id ?? null}
                      selectedEdgeId={selectedEdge?.id ?? null}
                      onSelectNode={selectNode}
                      onSelectEdge={selectEdge}
                      className="h-(--sz-memory-graph-height-phone) w-full overflow-hidden rounded-md md:h-(--sz-memory-graph-height)"
                    />
                  </Suspense>
                </div>
                <MemoryGraphLegend groupBy={groupBy} />
              </figure>
            ) : (
              <>
                {!webgl ? (
                  <p className="text-xs text-muted-foreground">
                    The 3D graph needs WebGL, which is not available in this browser, so memory is shown as a list.
                  </p>
                ) : null}
                {listSection}
              </>
            )}
          </div>
          <div className="min-w-0 space-y-4 self-start lg:sticky lg:top-0 lg:max-h-(--sz-memory-list-max) lg:overflow-y-auto">
            {selectedNodeId ? (
              <MemoryNodeDetail
                key={selectedNodeId}
                companyId={selectedCompanyId}
                nodeId={selectedNodeId}
                initialNode={selectedNode}
                onSelectNode={selectNode}
                onSelectEdge={selectEdge}
                onClose={clearSelection}
              />
            ) : selectedEdgeId ? (
              <MemoryEdgeDetail
                key={selectedEdgeId}
                companyId={selectedCompanyId}
                edgeId={selectedEdgeId}
                initialEdge={selectedEdge}
                onSelectNode={selectNode}
                onClose={clearSelection}
              />
            ) : null}
            {view === "graph" ? listSection : null}
          </div>
        </div>
      )}
    </div>
  );
}
