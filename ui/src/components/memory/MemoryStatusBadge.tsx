import { cn } from "@/lib/utils";
import { statusBadge, statusBadgeDefault } from "@/lib/status-colors";
import type { MemoryGraphEdgeKind, MemoryRecordStatus } from "@greatstone/shared";
import { EDGE_KIND_LABEL, memoryStatusMeta } from "./memoryLabels";

export function MemoryStatusBadge({ status, className }: { status: MemoryRecordStatus; className?: string }) {
  const meta = memoryStatusMeta[status];
  const Icon = meta.icon;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium",
        statusBadge[status] ?? statusBadgeDefault,
        className,
      )}
      title={meta.hint}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {meta.label}
    </span>
  );
}

/** Solid rule for a stated link, dashed for an engine association; matches the graph strokes. */
export function MemoryEdgeKindTag({ kind }: { kind: MemoryGraphEdgeKind }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
      <span
        aria-hidden="true"
        className={cn("inline-block w-4 border-t-2 border-foreground", kind === "inferred" && "border-dashed border-muted-foreground")}
      />
      {EDGE_KIND_LABEL[kind]}
    </span>
  );
}
