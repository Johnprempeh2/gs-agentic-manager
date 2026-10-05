import { useId, useMemo, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import { layoutMemoryGraph } from "@/lib/memory-graph-layout";
import type { MemoryGraphEdge, MemoryGraphNode, MemoryRecordStatus } from "@greatstone/shared";
import { EDGE_KIND_LABEL, edgeLabel, memoryStatusMeta } from "./memoryLabels";
import { nodeHeading } from "./MemoryRecordList";

const NODE_RADIUS = 11;
const LABEL_MAX = 26;

/** Shape and fill carry the state, not hue alone: dashed = unreviewed, hollow grey = superseded. */
const nodeStyle: Record<MemoryRecordStatus, string> = {
  approved: "fill-status-success stroke-status-success",
  unreviewed: "fill-card stroke-status-pending [stroke-dasharray:3_2]",
  disputed: "fill-status-alert-soft stroke-status-alert",
  superseded: "fill-muted stroke-muted-foreground [stroke-dasharray:1_2]",
  deleted: "fill-muted stroke-muted-foreground [stroke-dasharray:1_2]",
};

const LEGEND_STATUSES: MemoryRecordStatus[] = ["unreviewed", "approved", "disputed", "superseded"];

function shortLabel(node: MemoryGraphNode) {
  const text = nodeHeading(node);
  return text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text;
}

function activateOnKey(event: KeyboardEvent, action: () => void) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    action();
  }
}

interface MemoryGraphCanvasProps {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  onSelectNode: (id: string) => void;
  onSelectEdge: (id: string) => void;
}

export function MemoryGraphCanvas({ nodes, edges, selectedNodeId, selectedEdgeId, onSelectNode, onSelectEdge }: MemoryGraphCanvasProps) {
  const markerId = `memory-arrow-${useId().replace(/:/g, "")}`;
  const layout = useMemo(() => layoutMemoryGraph(nodes.map((node) => node.id), edges.map((edge) => ({ fromId: edge.from, toId: edge.to }))), [nodes, edges]);
  const nodesById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const neighbours = useMemo(() => {
    const ids = new Set<string>();
    for (const edge of edges) {
      if (edge.from === selectedNodeId) ids.add(edge.to);
      if (edge.to === selectedNodeId) ids.add(edge.from);
      if (edge.id === selectedEdgeId) {
        ids.add(edge.from);
        ids.add(edge.to);
      }
    }
    return ids;
  }, [edges, selectedNodeId, selectedEdgeId]);
  const showAllLabels = nodes.length <= 40;
  const width = Math.max(layout.width, 320);
  const height = Math.max(layout.height, 240);

  return (
    <figure className="space-y-2 rounded-lg border border-border bg-card p-2">
      <svg
        role="group"
        aria-label="Memory graph. Use Tab to move between records and connections; Enter selects."
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        className="h-(--sz-memory-graph-height) w-full"
      >
        <defs>
          <marker id={markerId} viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" className="fill-muted-foreground" />
          </marker>
        </defs>

        <g>
          {edges.map((edge) => {
            const from = layout.positions.get(edge.from);
            const to = layout.positions.get(edge.to);
            if (!from || !to) return null;
            const dx = to.x - from.x;
            const dy = to.y - from.y;
            const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
            const end = { x: to.x - (dx / dist) * (NODE_RADIUS + 2), y: to.y - (dy / dist) * (NODE_RADIUS + 2) };
            const selected = edge.id === selectedEdgeId;
            const touchesSelection = selectedNodeId !== null && (edge.from === selectedNodeId || edge.to === selectedNodeId);
            const fromName = nodesById.get(edge.from);
            const toName = nodesById.get(edge.to);
            const label = `${fromName ? nodeHeading(fromName) : "Record"}, ${edgeLabel(edge).toLowerCase()}, ${toName ? nodeHeading(toName) : "record"}. ${EDGE_KIND_LABEL[edge.kind]}.`;
            return (
              <g
                key={edge.id}
                role="button"
                tabIndex={0}
                aria-label={label}
                aria-pressed={selected}
                data-edge-kind={edge.kind}
                onClick={() => onSelectEdge(edge.id)}
                onKeyDown={(event) => activateOnKey(event, () => onSelectEdge(edge.id))}
                className="cursor-pointer outline-none [&:focus-visible>line:last-child]:stroke-ring"
              >
                <title>{label}</title>
                <line x1={from.x} y1={from.y} x2={end.x} y2={end.y} className="stroke-transparent" strokeWidth={12} />
                <line
                  x1={from.x}
                  y1={from.y}
                  x2={end.x}
                  y2={end.y}
                  strokeWidth={selected ? 3 : touchesSelection ? 2 : 1.5}
                  strokeDasharray={edge.kind === "inferred" ? "5 4" : undefined}
                  markerEnd={edge.kind === "explicit" ? `url(#${markerId})` : undefined}
                  className={cn(
                    edge.kind === "explicit" ? "stroke-foreground" : "stroke-muted-foreground",
                    selected && "stroke-primary",
                  )}
                />
              </g>
            );
          })}
        </g>

        <g>
          {nodes.map((node) => {
            const point = layout.positions.get(node.id);
            if (!point) return null;
            const selected = node.id === selectedNodeId;
            const showLabel = showAllLabels || selected || neighbours.has(node.id);
            return (
              <g
                key={node.id}
                role="button"
                tabIndex={0}
                aria-label={`${nodeHeading(node)}. ${memoryStatusMeta[node.status].label}.`}
                aria-pressed={selected}
                data-node-status={node.status}
                onClick={() => onSelectNode(node.id)}
                onKeyDown={(event) => activateOnKey(event, () => onSelectNode(node.id))}
                transform={`translate(${point.x} ${point.y})`}
                className="cursor-pointer outline-none [&:focus-visible>circle:first-of-type]:stroke-ring"
              >
                <title>{`${nodeHeading(node)} (${memoryStatusMeta[node.status].label})`}</title>
                {selected ? <circle r={NODE_RADIUS + 5} className="fill-none stroke-primary" strokeWidth={2} /> : null}
                <circle r={NODE_RADIUS} strokeWidth={2} className={nodeStyle[node.status]} />
                {node.status === "disputed" ? (
                  <text textAnchor="middle" dominantBaseline="central" className="fill-status-alert-foreground text-xs font-bold" aria-hidden="true">
                    !
                  </text>
                ) : null}
                {showLabel ? (
                  <text y={NODE_RADIUS + 14} textAnchor="middle" className="fill-foreground text-xs" aria-hidden="true">
                    {shortLabel(node)}
                  </text>
                ) : null}
              </g>
            );
          })}
        </g>
      </svg>
      <MemoryGraphLegend />
    </figure>
  );
}

export function MemoryGraphLegend() {
  return (
    <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs text-muted-foreground">
      {LEGEND_STATUSES.map((status) => (
        <span key={status} className="inline-flex items-center gap-1.5">
          <svg viewBox="-8 -8 16 16" className="h-3.5 w-3.5" aria-hidden="true">
            <circle r={6} strokeWidth={2} className={nodeStyle[status]} />
          </svg>
          {memoryStatusMeta[status].label}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden="true" className="inline-block w-5 border-t-2 border-foreground" />
        {EDGE_KIND_LABEL.explicit} (arrow shows direction)
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden="true" className="inline-block w-5 border-t-2 border-dashed border-muted-foreground" />
        {EDGE_KIND_LABEL.inferred} (a lead, not proof)
      </span>
    </figcaption>
  );
}
