import { lazy, Suspense, useMemo, type ReactNode } from "react";
import { Box, Link2, List } from "lucide-react";
import type { MemoryGraphEdge, MemoryGraphNode, MemoryRecordStatus } from "@greatstone/shared";
import { Button } from "../ui/button";
import { MemoryGraphLegend } from "./MemoryGraphLegend";
import { listContributors, type MemoryAgentInfo, type MemoryContributor } from "./memoryContributors";
import {
  buildMemoryGraph3D,
  focusNodeIds,
  type MemoryGraph3DData,
  type MemoryGraphFocusMode,
  type MemoryGraphGroupBy,
} from "./memoryGraph3dData";

/** three.js lives in its own chunk, fetched only when the graph is shown. */
const MemoryGraph3D = lazy(() => import("./MemoryGraph3D"));

export type MemoryView = "graph" | "list";

export interface MemoryExplorerData {
  graph3d: MemoryGraph3DData;
  contributors: MemoryContributor[];
  /** Node ids in front while contributors are focused; null when showing everyone. */
  focusIds: Set<string> | null;
  /** The entries for the list: the focused ones, or all. */
  listNodes: MemoryGraphNode[];
  /** Edges between listed entries, for the list's link counts. */
  listEdges: MemoryGraphEdge[];
}

/** Everything the Memory page derives from the permitted data and the view settings. Pure. */
export function deriveMemoryExplorer(input: {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  agents: MemoryAgentInfo[];
  groupBy: MemoryGraphGroupBy;
  showSuggested: boolean;
  focusKeys: string[];
}): MemoryExplorerData {
  const graph3d = buildMemoryGraph3D(input.nodes, input.edges, {
    groupBy: input.groupBy,
    showSuggested: input.showSuggested,
    agents: input.agents,
  });
  const contributors = listContributors(input.nodes, input.agents);
  const known = new Set(contributors.map((contributor) => contributor.key));
  const focusKeys = input.focusKeys.filter((key) => known.has(key));
  const focusIds = focusNodeIds(graph3d, focusKeys);
  const listNodes = focusIds ? input.nodes.filter((node) => focusIds.has(node.id)) : input.nodes;
  const listed = new Set(listNodes.map((node) => node.id));
  const listEdges = focusIds ? input.edges.filter((edge) => listed.has(edge.from) && listed.has(edge.to)) : input.edges;
  return { graph3d, contributors, focusIds, listNodes, listEdges };
}

export function useMemoryExplorer(input: Parameters<typeof deriveMemoryExplorer>[0]): MemoryExplorerData {
  const { nodes, edges, agents, groupBy, showSuggested, focusKeys } = input;
  const focusKey = focusKeys.join(",");
  return useMemo(
    () => deriveMemoryExplorer({ nodes, edges, agents, groupBy, showSuggested, focusKeys: focusKey ? focusKey.split(",") : [] }),
    [nodes, edges, agents, groupBy, showSuggested, focusKey],
  );
}

function ToggleButton({ pressed, onClick, children, label }: { pressed: boolean; onClick: () => void; children: ReactNode; label?: string }) {
  return (
    <Button type="button" size="xs" variant={pressed ? "secondary" : "ghost"} aria-pressed={pressed} aria-label={label} onClick={onClick}>
      {children}
    </Button>
  );
}

interface MemoryViewToolbarProps {
  view: MemoryView;
  webgl: boolean;
  groupBy: MemoryGraphGroupBy;
  showSuggested: boolean;
  suggestedCount: number;
  onViewChange: (view: MemoryView) => void;
  onGroupByChange: (groupBy: MemoryGraphGroupBy) => void;
  onShowSuggestedChange: (show: boolean) => void;
}

/** View controls under the search row: Graph or List, Group by, and suggested links. */
export function MemoryViewToolbar({
  view,
  webgl,
  groupBy,
  showSuggested,
  suggestedCount,
  onViewChange,
  onGroupByChange,
  onShowSuggestedChange,
}: MemoryViewToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2" role="toolbar" aria-label="Memory view options">
      {webgl ? (
        <div role="group" aria-label="Memory view" className="inline-flex items-center gap-1">
          <ToggleButton pressed={view === "graph"} onClick={() => onViewChange("graph")}>
            <Box aria-hidden="true" />
            Graph
          </ToggleButton>
          <ToggleButton pressed={view === "list"} onClick={() => onViewChange("list")}>
            <List aria-hidden="true" />
            List
          </ToggleButton>
        </div>
      ) : null}
      {view === "graph" ? (
        <div role="group" aria-label="Group entries by" className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <span className="pr-1">Group by</span>
          <ToggleButton pressed={groupBy === "contributor"} onClick={() => onGroupByChange("contributor")}>
            Contributor
          </ToggleButton>
          <ToggleButton pressed={groupBy === "scope"} onClick={() => onGroupByChange("scope")}>
            Scope
          </ToggleButton>
        </div>
      ) : null}
      {suggestedCount > 0 ? (
        <ToggleButton pressed={showSuggested} onClick={() => onShowSuggestedChange(!showSuggested)}>
          <Link2 aria-hidden="true" />
          Show suggested links ({suggestedCount})
        </ToggleButton>
      ) : null}
    </div>
  );
}

interface MemoryGraphFigureProps {
  explorer: MemoryExplorerData;
  groupBy: MemoryGraphGroupBy;
  focusMode: MemoryGraphFocusMode;
  /** Entries the server sent, before the render cap. */
  total: number;
  truncated: boolean;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  onSelectNode: (id: string) => void;
  onSelectEdge: (id: string) => void;
}

const entryWord = (count: number) => (count === 1 ? "entry" : "entries");
const linkWord = (count: number) => (count === 1 ? "link" : "links");

/** The 3D graph in its card, with notes above and a legend of what is drawn below. */
export function MemoryGraphFigure({
  explorer,
  groupBy,
  focusMode,
  total,
  truncated,
  selectedNodeId,
  selectedEdgeId,
  onSelectNode,
  onSelectEdge,
}: MemoryGraphFigureProps) {
  const { graph3d, focusIds } = explorer;
  const statuses = useMemo(() => {
    const present = new Set<MemoryRecordStatus>();
    for (const node of graph3d.nodes) {
      if (node.kind === "memory" && node.status && (!focusIds || focusMode === "dim" || focusIds.has(node.id))) present.add(node.status);
    }
    return [...present];
  }, [graph3d, focusIds, focusMode]);
  const drawnLinks = graph3d.statedCount + (graph3d.showSuggested ? graph3d.suggestedCount : 0);

  return (
    <figure className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card p-2">
      {truncated || graph3d.omittedCount > 0 ? (
        <p className="px-1 text-xs text-muted-foreground">
          {graph3d.omittedCount > 0 ? `The graph draws the first ${graph3d.memoryCount} of ${total} entries to stay smooth. ` : null}
          {truncated ? "More entries match than the server sent. Narrow the filters to see the rest." : null}
        </p>
      ) : null}
      <div
        role="img"
        aria-label={`3D memory graph: ${graph3d.memoryCount} ${entryWord(graph3d.memoryCount)} grouped by ${groupBy}, ${drawnLinks} ${linkWord(drawnLinks)} drawn. The list has the same entries.`}
      >
        <Suspense
          fallback={
            <div className="flex h-(--sz-memory-graph-height-phone) w-full animate-pulse items-center justify-center rounded-md bg-muted text-xs text-muted-foreground md:h-(--sz-memory-graph-height)">
              Loading the graph
            </div>
          }
        >
          <MemoryGraph3D
            data={graph3d}
            selectedNodeId={selectedNodeId}
            selectedEdgeId={selectedEdgeId}
            focusIds={focusIds}
            focusMode={focusMode}
            onSelectNode={onSelectNode}
            onSelectEdge={onSelectEdge}
            className="h-(--sz-memory-graph-height-phone) w-full overflow-hidden rounded-md md:h-(--sz-memory-graph-height)"
          />
        </Suspense>
      </div>
      <MemoryGraphLegend
        groupBy={groupBy}
        hasCeo={graph3d.ceoHubId !== null}
        statuses={statuses}
        hasStated={graph3d.statedCount > 0}
        showSuggested={graph3d.showSuggested && graph3d.suggestedCount > 0}
      />
    </figure>
  );
}
