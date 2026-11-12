import type { DeepDiveRecordSummary } from "@greatstone/shared";
import { Link } from "@/lib/router";
import { cn, formatDate } from "@/lib/utils";
import { StatusBadge } from "./StatusBadge";

/** "1 draft to review" / "2 drafts to review". */
function count(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * One client's Deep Dive as a tile (GRE-4430). The whole tile opens the
 * client's portal. Shows what waits for a person first.
 */
export function DeepDiveTile({
  record,
  to,
  className,
}: {
  record: Pick<DeepDiveRecordSummary, "clientName" | "identifier" | "status" | "workstreams" | "draftsWaiting" | "findingsToValidate" | "createdAt">;
  to: string;
  className?: string;
}) {
  const waiting = [
    record.draftsWaiting > 0 ? count(record.draftsWaiting, "draft to review", "drafts to review") : null,
    record.findingsToValidate > 0 ? count(record.findingsToValidate, "finding to validate", "findings to validate") : null,
  ].filter(Boolean);
  return (
    <Link
      to={to}
      className={cn(
        "flex min-h-32 flex-col gap-2 rounded-lg border border-border bg-card p-4 text-card-foreground shadow-xs transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-(length:--rad-3) focus-visible:ring-ring/50",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 break-words text-sm font-semibold">{record.clientName}</p>
        <StatusBadge status={record.status === "active" ? "active" : "archived"} label={record.status === "active" ? "Active" : "Finished"} />
      </div>
      <p className="text-xs text-muted-foreground">
        {record.identifier ? <span className="font-mono">{record.identifier}</span> : null}
        {record.identifier ? " · " : null}
        Started {formatDate(record.createdAt)}
      </p>
      <p className="text-xs text-muted-foreground">
        {record.workstreams.length > 0 ? count(record.workstreams.length, "workstream", "workstreams") : "No workstreams yet"}
      </p>
      <p className={cn("mt-auto text-sm", waiting.length > 0 ? "font-medium text-foreground" : "text-muted-foreground")}>
        {waiting.length > 0 ? waiting.join(" · ") : "Nothing waiting for a person"}
      </p>
    </Link>
  );
}
