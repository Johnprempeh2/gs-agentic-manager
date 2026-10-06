import type { MemoryRecordStatus } from "@greatstone/shared";
import { cn } from "@/lib/utils";
import { APPROVED_MEANING, EDGE_KIND_LABEL, memoryStatusMeta } from "./memoryLabels";
import type { MemoryGraphGroupBy } from "./memoryGraph3dData";

/** Same token per status as the 3D scene (memoryGraphPalette STATUS_TOKEN). */
const STATUS_DOT: Record<MemoryRecordStatus, string> = {
  unreviewed: "bg-status-pending",
  approved: "bg-status-success",
  disputed: "bg-status-alert",
  superseded: "bg-muted-foreground opacity-70",
  deleted: "bg-muted-foreground",
};

const LEGEND_STATUSES: MemoryRecordStatus[] = ["unreviewed", "approved", "disputed", "superseded"];

export const HUB_LEGEND_LABEL: Record<MemoryGraphGroupBy, string> = {
  contributor: "Agent or person",
  scope: "Scope (project, client or organization)",
};

export interface MemoryGraphLegendProps {
  groupBy?: MemoryGraphGroupBy;
  /** The main agent's hub is drawn. */
  hasCeo?: boolean;
  /** Statuses present in the drawing; only these get a key. Omitted: all four. */
  statuses?: MemoryRecordStatus[];
  /** Any stated link is drawn. */
  hasStated?: boolean;
  /** Suggested links are drawn. */
  showSuggested?: boolean;
}

/** A key to what is on screen, and nothing else. */
export function MemoryGraphLegend({ groupBy = "contributor", hasCeo = false, statuses, hasStated = true, showSuggested = false }: MemoryGraphLegendProps) {
  const shown = LEGEND_STATUSES.filter((status) => !statuses || statuses.includes(status));
  return (
    <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs text-muted-foreground">
      {hasCeo ? (
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block size-3.5 rounded-full bg-primary ring-2 ring-primary/40" />
          Main agent
        </span>
      ) : null}
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden="true" className="inline-block size-3 rounded-full bg-primary" />
        {HUB_LEGEND_LABEL[groupBy]}
      </span>
      {shown.map((status) => (
        <span key={status} className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className={cn("inline-block size-2 rounded-full", STATUS_DOT[status])} />
          {memoryStatusMeta[status].label}
        </span>
      ))}
      {hasStated ? (
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block w-5 border-t-2 border-foreground" />
          {EDGE_KIND_LABEL.explicit}
        </span>
      ) : null}
      {showSuggested ? (
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block w-5 border-t-2 border-dashed border-muted-foreground" />
          {EDGE_KIND_LABEL.inferred} (a suggestion, not proof)
        </span>
      ) : null}
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden="true" className="inline-block w-5 border-t border-muted-foreground opacity-40" />
        {groupBy === "scope" ? "In scope" : "Contributed by"}
      </span>
      <span className="basis-full">Bigger entries have more links or are approved. {APPROVED_MEANING}</span>
    </figcaption>
  );
}
