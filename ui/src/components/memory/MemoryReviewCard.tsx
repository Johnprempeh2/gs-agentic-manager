import type { ReactNode } from "react";
import type { MemoryActorLabel, MemoryRecord, MemoryReviewQueueItem } from "@greatstone/shared";
import { AlertTriangle, Clock } from "lucide-react";
import { cn, formatDate } from "@/lib/utils";
import { ageFlagMeta, ageText, cardTitle, personWithApp } from "../../lib/memory-review";
import { MemoryStatusBadge } from "./MemoryStatusBadge";
import { scopeKindLabel } from "./memoryLabels";

/** Person as the main label, app as a small label (deck v7 slide 15). */
export function MemoryPersonLabel({ actor, className }: { actor: MemoryActorLabel | null; className?: string }) {
  if (!actor) return <span className={className}>Unknown</span>;
  return (
    <span className={cn("inline-flex min-w-0 flex-wrap items-baseline gap-x-1", className)} title={personWithApp(actor)}>
      <span className="truncate font-medium text-foreground">{actor.name}</span>
      {actor.app ? <span className="text-xs text-muted-foreground">· via {actor.app}</span> : null}
    </span>
  );
}

export function MemoryAgeBadge({ item }: { item: Pick<MemoryReviewQueueItem, "ageDays" | "ageFlag"> }) {
  const meta = ageFlagMeta[item.ageFlag];
  if (!meta.label) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-xs text-muted-foreground" title={meta.hint}>
        <Clock className="h-3 w-3" aria-hidden="true" />
        {ageText(item.ageDays)}
      </span>
    );
  }
  return (
    <span
      className={cn("inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium", meta.tone)}
      title={meta.hint}
    >
      <Clock className="h-3 w-3" aria-hidden="true" />
      {meta.label} · {ageText(item.ageDays)}
    </span>
  );
}

export function MemoryConflictTag() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-status-alert-soft px-2 py-0.5 text-xs font-medium text-status-alert-foreground">
      <AlertTriangle className="h-3 w-3" aria-hidden="true" />
      Conflict
    </span>
  );
}

/** One row in the queue. */
export function MemoryReviewRow({
  item,
  selected,
  onSelect,
}: {
  item: MemoryReviewQueueItem;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "w-full space-y-1.5 px-3 py-3 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          selected && "bg-accent text-accent-foreground",
          item.ageFlag === "expired" && !selected && "text-muted-foreground",
        )}
      >
        <p className="text-sm font-medium line-clamp-2 break-words">{cardTitle(item.proposal)}</p>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <MemoryPersonLabel actor={item.proposer} className="text-xs" />
          <span className="text-muted-foreground">· {item.scope.name}</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <MemoryAgeBadge item={item} />
          {item.conflictIds.length > 0 ? <MemoryConflictTag /> : null}
          {item.current ? <span className="text-xs text-muted-foreground">Changes a confirmed card</span> : null}
        </div>
      </button>
    </li>
  );
}

/** One side of the comparison: the confirmed card now, or the proposal. */
export function MemoryCardPane({
  heading,
  record,
  emptyText,
  footer,
  tone,
}: {
  heading: string;
  record: MemoryRecord | null;
  emptyText?: string;
  footer?: ReactNode;
  tone: "current" | "proposed";
}) {
  return (
    <section
      aria-label={heading}
      className={cn(
        "flex min-w-0 flex-col rounded-lg border bg-card",
        tone === "proposed" ? "border-primary/40" : "border-border",
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{heading}</h3>
        {record ? <MemoryStatusBadge status={record.status} /> : null}
      </div>
      {record ? (
        <div className="flex-1 space-y-2 px-3 py-3">
          {record.title ? <p className="text-sm font-semibold break-words">{record.title}</p> : null}
          <p className="whitespace-pre-wrap text-sm break-words">{record.content ?? "No text."}</p>
          <p className="text-xs text-muted-foreground">
            v{record.version} · {scopeKindLabel[record.scopeKind]} · {record.decisionClass.replace(/_/g, " ")} · {formatDate(record.createdAt)}
          </p>
          {footer}
        </div>
      ) : (
        <p className="flex-1 px-3 py-3 text-sm text-muted-foreground">{emptyText}</p>
      )}
    </section>
  );
}
