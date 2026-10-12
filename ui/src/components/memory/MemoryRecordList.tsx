import type { KeyboardEvent } from "react";
import type { MemoryGraphEdge, MemoryGraphNode } from "@greatstone/shared";
import { cn, formatShortDate } from "@/lib/utils";
import { MemoryStatusBadge } from "./MemoryStatusBadge";
import { actorLabel, sourceRef } from "./memoryLabels";

interface MemoryRecordListProps {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}

export function nodeHeading(node: Pick<MemoryGraphNode, "title" | "excerpt">): string {
  return node.title?.trim() || node.excerpt?.trim() || "Untitled entry";
}

function linkCounts(nodeId: string, edges: MemoryGraphEdge[]) {
  let stated = 0;
  let checked = 0;
  for (const edge of edges) {
    if (edge.from !== nodeId && edge.to !== nodeId) continue;
    if (edge.kind === "explicit") stated += 1;
    else checked += 1;
  }
  return { stated, checked };
}

/**
 * The list view beside the graph: same nodes, same filters, usable on its own.
 * Each row is a button; Up and Down move between rows.
 */
export function MemoryRecordList({ nodes, edges, selectedNodeId, onSelectNode }: MemoryRecordListProps) {
  function onKeyDown(event: KeyboardEvent<HTMLUListElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-memory-row]"));
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const next = buttons[event.key === "ArrowDown" ? Math.min(index + 1, buttons.length - 1) : Math.max(index - 1, 0)];
    next?.focus();
  }

  return (
    <ul className="divide-y divide-border" aria-label="Memory entries" onKeyDown={onKeyDown}>
      {nodes.map((node) => {
        const selected = node.id === selectedNodeId;
        const { stated, checked } = linkCounts(node.id, edges);
        const source = sourceRef(node.source);
        return (
          <li key={node.id}>
            <button
              type="button"
              data-memory-row
              aria-pressed={selected}
              onClick={() => onSelectNode(node.id)}
              className={cn(
                "flex w-full flex-col gap-1.5 px-3 py-2.5 text-left hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                selected && "bg-accent text-accent-foreground",
              )}
            >
              <span className="flex items-start justify-between gap-2">
                <span className="min-w-0 text-sm font-medium line-clamp-2 break-words">{nodeHeading(node)}</span>
                <MemoryStatusBadge status={node.status} />
              </span>
              <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                <span>{node.scopeName}</span>
                <span aria-hidden="true">·</span>
                <span>Contributed by {actorLabel(node.contributor)}</span>
                <span aria-hidden="true">·</span>
                <span>{formatShortDate(node.createdAt)}</span>
                {source ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>{source.label}</span>
                  </>
                ) : null}
              </span>
              {stated + checked > 0 ? (
                <span className="text-xs text-muted-foreground">
                  {stated > 0 ? `${stated} stated ${stated === 1 ? "link" : "links"}` : null}
                  {stated > 0 && checked > 0 ? ", " : null}
                  {checked > 0 ? `${checked} found by a check` : null}
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
