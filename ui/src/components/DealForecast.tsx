import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { formatDealTotals, type ForecastBucket } from "@/lib/client-case";
import { cn } from "@/lib/utils";

/**
 * Pipedrive's forecast for a DevTools board: open deal value by the month
 * each deal is expected to close, with the weighted value under it.
 */
export function DealForecast({ buckets }: { buckets: ForecastBucket[] }) {
  const [open, setOpen] = useState(true);
  if (!buckets.some((bucket) => bucket.count > 0)) return null;
  return (
    <section aria-label="Forecast by close month" className="space-y-2">
      <button
        type="button"
        className="inline-flex min-h-9 items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        Forecast by close month
      </button>
      {open ? (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {buckets.map((bucket) => (
            <li
              key={bucket.key}
              data-testid={`forecast-${bucket.key}`}
              className={cn(
                "space-y-0.5 rounded-lg border border-border bg-card p-3",
                bucket.key === "overdue" && bucket.count > 0 && "border-status-danger",
              )}
            >
              <p className={cn("text-xs font-medium text-muted-foreground", bucket.key === "overdue" && bucket.count > 0 && "text-status-danger")}>
                {bucket.label}
              </p>
              <p className="text-base font-semibold tabular-nums">{formatDealTotals(bucket.totals) || "0"}</p>
              <p className="text-xs text-muted-foreground">
                {bucket.count} {bucket.count === 1 ? "deal" : "deals"}
                {bucket.weighted.length > 0 ? ` · ${formatDealTotals(bucket.weighted)} weighted` : ""}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
