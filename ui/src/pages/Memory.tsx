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
import { supportsWebGL } from "../lib/webgl";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { PageSkeleton } from "../components/PageSkeleton";
import { MemoryFilterBar } from "../components/memory/MemoryFilterBar";
import { MemoryRecordList } from "../components/memory/MemoryRecordList";
import { MemoryEdgeDetail, MemoryNodeDetail } from "../components/memory/MemoryDetailPanel";
import { MemoryContributorPanel } from "../components/memory/MemoryContributorPanel";
import { MemoryGraphFigure, MemoryViewToolbar, useMemoryExplorer, type MemoryView } from "../components/memory/MemoryExplorer";
import { formatAgentFocus, parseAgentFocus, type MemoryAgentInfo } from "../components/memory/memoryContributors";
import type { MemoryGraphFocusMode, MemoryGraphGroupBy } from "../components/memory/memoryGraph3dData";
import { MemoryPageHeader } from "../components/memory/MemoryPageHeader";

const SEARCH_DEBOUNCE_MS = 250;

/**
 * Server filters live in the URL so other screens can link to a place in the graph.
 * `?agent=` is not one of them: it focuses contributors on the client (their entries
 * and direct connections), so the server still sends the whole permitted graph.
 */
export function readMemoryFilters(params: URLSearchParams): MemoryGraphFilters {
  const status = params.get("status");
  return {
    q: params.get("q") || undefined,
    scopeId: params.get("scope") || undefined,
    status: MEMORY_GRAPH_STATUSES.includes(status as MemoryGraphStatus) ? (status as MemoryGraphStatus) : undefined,
  };
}

/** The gateway answers 404 "Memory is not enabled…" when memory is off; other 404s are real errors. */
export function isMemoryDisabled(error: unknown) {
  return error instanceof ApiError && error.status === 404 && /not enabled/i.test(error.message);
}

function hasFilters(filters: MemoryGraphFilters) {
  return Boolean(filters.q || filters.scopeId || filters.status);
}

const entryWord = (count: number) => (count === 1 ? "entry" : "entries");

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
  const showSuggested = params.get("suggested") === "1";
  const focusMode: MemoryGraphFocusMode = params.get("others") === "dim" ? "dim" : "hide";
  const agentParam = params.get("agent");
  const focusKeys = useMemo(() => parseAgentFocus(agentParam), [agentParam]);

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
    (next: MemoryGraphFilters) => updateParams({ q: next.q, scope: next.scopeId, status: next.status }),
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
  const agentInfo = useMemo<MemoryAgentInfo[]>(
    () => (agents.data ?? []).map((agent) => ({ id: agent.id, name: agent.name, role: agent.role, appearance: agent.appearance ?? null })),
    [agents.data],
  );

  const nodes = useMemo(() => graph.data?.nodes ?? [], [graph.data]);
  const edges = useMemo(() => graph.data?.edges ?? [], [graph.data]);
  const nodesById = useMemo(() => new Map<string, MemoryGraphNode>(nodes.map((node) => [node.id, node])), [nodes]);
  const selectedNode = selectedNodeId ? nodesById.get(selectedNodeId) : undefined;
  const selectedEdge = selectedEdgeId ? edges.find((edge) => edge.id === selectedEdgeId) : undefined;
  const explorer = useMemoryExplorer({ nodes, edges, agents: agentInfo, groupBy, showSuggested, focusKeys });

  const selectNode = useCallback((id: string) => updateParams({ node: id, edge: undefined }), [updateParams]);
  const selectEdge = useCallback((id: string) => updateParams({ edge: id, node: undefined }), [updateParams]);
  const clearSelection = useCallback(() => updateParams({ node: undefined, edge: undefined }), [updateParams]);
  const clearFilters = useCallback(() => {
    setSearchText("");
    updateParams({ q: undefined, scope: undefined, status: undefined });
  }, [updateParams]);
  const toggleFocus = useCallback(
    (key: string, additive: boolean) => {
      let next: string[];
      if (additive) next = focusKeys.includes(key) ? focusKeys.filter((existing) => existing !== key) : [...focusKeys, key];
      else next = focusKeys.length === 1 && focusKeys[0] === key ? [] : [key];
      updateParams({ agent: formatAgentFocus(next) });
    },
    [focusKeys, updateParams],
  );

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

  const focusNames = explorer.contributors.filter((contributor) => explorer.focusIds && focusKeys.includes(contributor.key)).map((contributor) => contributor.name);
  const listSection = (
    <section className="overflow-hidden rounded-lg border border-border bg-card" aria-label="Memory list">
      <div className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
        {explorer.focusIds
          ? `${explorer.listNodes.length} of ${nodes.length} ${entryWord(nodes.length)}: ${focusNames.join(", ")} and their direct connections`
          : `${nodes.length} ${entryWord(nodes.length)}, ${edges.length} ${edges.length === 1 ? "connection" : "connections"}`}
        {graph.data?.truncated ? <span className="block">Showing the first {nodes.length}. Narrow the filters to see the rest.</span> : null}
      </div>
      <MemoryRecordList nodes={explorer.listNodes} edges={explorer.listEdges} selectedNodeId={selectedNode?.id ?? null} onSelectNode={selectNode} />
    </section>
  );

  return (
    <div className="space-y-4">
      {header}
      <MemoryFilterBar
        filters={filters}
        statuses={MEMORY_GRAPH_STATUSES}
        searchText={searchText}
        onSearchTextChange={setSearchText}
        onChange={setFilters}
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
          <div className="min-w-0 space-y-3">
            {graph.data?.note ? <p className="text-xs text-muted-foreground">{graph.data.note}</p> : null}
            <MemoryViewToolbar
              view={view}
              webgl={webgl}
              groupBy={groupBy}
              showSuggested={showSuggested}
              suggestedCount={explorer.graph3d.suggestedCount}
              onViewChange={(next) => updateParams({ view: next === "list" ? "list" : undefined })}
              onGroupByChange={(next) => updateParams({ group: next === "scope" ? "scope" : undefined })}
              onShowSuggestedChange={(show) => updateParams({ suggested: show ? "1" : undefined })}
            />
            <div className="grid gap-4 md:grid-cols-(--gtc-memory-explorer)">
              <MemoryContributorPanel
                contributors={explorer.contributors}
                total={nodes.length}
                selected={explorer.focusIds ? focusKeys : []}
                onToggle={toggleFocus}
                onReset={() => updateParams({ agent: undefined })}
                focusMode={focusMode}
                onFocusModeChange={(mode) => updateParams({ others: mode === "dim" ? "dim" : undefined })}
                showFocusMode={view === "graph"}
                className="max-h-(--sz-memory-contributors-phone) md:max-h-(--sz-memory-graph-height) md:self-start"
              />
              {view === "graph" ? (
                <MemoryGraphFigure
                  explorer={explorer}
                  groupBy={groupBy}
                  focusMode={focusMode}
                  total={nodes.length}
                  truncated={graph.data?.truncated ?? false}
                  selectedNodeId={selectedNode?.id ?? null}
                  selectedEdgeId={selectedEdge?.id ?? null}
                  onSelectNode={selectNode}
                  onSelectEdge={selectEdge}
                />
              ) : (
                <div className="min-w-0 space-y-3">
                  {!webgl ? (
                    <p className="text-xs text-muted-foreground">
                      The 3D graph needs WebGL, which is not available in this browser, so memory is shown as a list.
                    </p>
                  ) : null}
                  {listSection}
                </div>
              )}
            </div>
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
