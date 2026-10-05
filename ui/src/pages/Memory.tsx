import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Brain, Lock, PowerOff, SearchX } from "lucide-react";
import { useSearchParams } from "@/lib/router";
import { ApiError } from "../api/client";
import { agentsApi } from "../api/agents";
import { MEMORY_GRAPH_STATUSES, type MemoryGraphNode, type MemoryGraphStatus } from "@greatstone/shared";
import { memoryGraphApi, type MemoryGraphFilters } from "../api/memoryGraph";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { PageSkeleton } from "../components/PageSkeleton";
import { MemoryFilterBar } from "../components/memory/MemoryFilterBar";
import { MemoryRecordList } from "../components/memory/MemoryRecordList";
import { MemoryEdgeDetail, MemoryNodeDetail } from "../components/memory/MemoryDetailPanel";
import { MemoryGraphCanvas } from "../components/memory/MemoryGraphCanvas";
import { MemoryPageHeader } from "../components/memory/MemoryPageHeader";

const SEARCH_DEBOUNCE_MS = 250;

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

export function Memory() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => readMemoryFilters(params), [params]);
  const selectedNodeId = params.get("node");
  const selectedEdgeId = params.get("edge");
  const [searchText, setSearchText] = useState(filters.q ?? "");

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
            <MemoryGraphCanvas
              nodes={nodes}
              edges={edges}
              selectedNodeId={selectedNode?.id ?? null}
              selectedEdgeId={selectedEdge?.id ?? null}
              onSelectNode={selectNode}
              onSelectEdge={selectEdge}
            />
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
            <section className="overflow-hidden rounded-lg border border-border bg-card" aria-label="Memory list">
              <div className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
                {nodes.length} {nodes.length === 1 ? "entry" : "entries"}, {edges.length} {edges.length === 1 ? "connection" : "connections"}
                {graph.data?.truncated ? <span className="block">Showing the first {nodes.length}. Narrow the filters to see the rest.</span> : null}
              </div>
              <MemoryRecordList
                nodes={nodes}
                edges={edges}
                selectedNodeId={selectedNode?.id ?? null}
                onSelectNode={selectNode}
              />
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
