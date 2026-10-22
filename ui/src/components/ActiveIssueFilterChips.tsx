import { X } from "lucide-react";
import type { ActiveIssueFilter, IssueFilterState } from "../lib/issue-filters";
import { defaultIssueFilterState } from "../lib/issue-filters";
import { cn } from "../lib/utils";

/**
 * One removable chip per active filter, so a phone shows which filter is on
 * in words (GRE-1924). The whole chip is the tap target: drawn 28px tall, it
 * grows to 44px on touch screens (`[data-filter-chip]` in index.css).
 */
export function ActiveIssueFilterChips({
  filters,
  onChange,
  className,
}: {
  filters: ActiveIssueFilter[];
  onChange: (patch: Partial<IssueFilterState>) => void;
  className?: string;
}) {
  if (filters.length === 0) return null;
  return (
    <div role="group" aria-label="Filters on" className={cn("flex flex-wrap items-center gap-x-1.5 gap-y-4", className)}>
      {filters.map((filter) => (
        <button
          key={filter.key}
          type="button"
          data-filter-chip
          onClick={() => onChange(filter.clear)}
          aria-label={`Remove filter ${filter.name}: ${filter.value}`}
          className="gs-press inline-flex h-7 max-w-full min-w-0 items-center gap-1 rounded-full border border-border bg-background px-2.5 text-xs transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="shrink-0 text-muted-foreground">{filter.name}:</span>
          <span className="min-w-0 truncate font-medium text-foreground">{filter.value}</span>
          <X className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      ))}
      {filters.length > 1 ? (
        <button
          type="button"
          data-filter-chip
          onClick={() => onChange(defaultIssueFilterState)}
          className="h-7 rounded-full px-2 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Clear all
        </button>
      ) : null}
    </div>
  );
}
