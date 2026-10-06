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
  contributor: "Contributor (agent or person)",
  scope: "Scope (project, client or organization)",
};

export function MemoryGraphLegend({ groupBy = "contributor" }: { groupBy?: MemoryGraphGroupBy }) {
  return (
    <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden="true" className="inline-block size-3.5 rounded-full bg-primary" />
        {HUB_LEGEND_LABEL[groupBy]}
      </span>
      {LEGEND_STATUSES.map((status) => (
        <span key={status} className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className={cn("inline-block size-2.5 rounded-full", STATUS_DOT[status])} />
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
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden="true" className="inline-block w-5 border-t border-muted-foreground opacity-40" />
        {groupBy === "scope" ? "In scope" : "Contributed by"} (grouping only, not a connection)
      </span>
      <span className="basis-full">Hubs are the large labelled nodes; an entry grows with its connections. {APPROVED_MEANING}</span>
    </figcaption>
  );
}
