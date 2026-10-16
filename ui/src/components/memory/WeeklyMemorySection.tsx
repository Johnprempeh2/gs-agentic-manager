import { useQuery } from "@tanstack/react-query";
import type { MemoryActivityCounts, MemoryActivityItem } from "@greatstone/shared";
import { Brain } from "lucide-react";
import { memoryGraphApi } from "../../api/memoryGraph";
import { queryKeys } from "../../lib/queryKeys";
import { Link } from "@/lib/router";

const SHOWN = 6;

/** Totals for the week across every contributor the reader may see. */
export function weeklyMemoryTotals(counts: MemoryActivityCounts | undefined): { added: number; confirmed: number; waiting: number } {
  let added = 0;
  let confirmed = 0;
  let waiting = 0;
  for (const row of counts?.contributors ?? []) {
    added += row.contributionCount;
    confirmed += row.contributionCountByStatus.approved ?? 0;
    waiting += row.contributionCountByStatus.unreviewed ?? 0;
  }
  return { added, confirmed, waiting };
}

/** One line for an entry: its title, else the start of its text. */
export function weeklyMemoryLine(item: MemoryActivityItem): string {
  const text = (item.record.title?.trim() || item.record.content?.trim() || "").replace(/\s+/g, " ");
  return text.length > 140 ? `${text.slice(0, 139)}...` : text;
}

/**
 * "What GSAM learned": memory entries added this week that the reader may see.
 * Hidden when memory is off or the reader cannot read it, so the report never
 * shows an error for a feature the company does not use.
 */
export function WeeklyMemorySection({ companyId, since }: { companyId: string; since: string }) {
  const filters = { from: since };
  const counts = useQuery({
    queryKey: queryKeys.memoryGraph.activityCounts(companyId, filters),
    queryFn: () => memoryGraphApi.activityCounts(companyId, filters),
    retry: false,
  });
  const confirmedFilters = { from: since, status: "approved" as const };
  const feed = useQuery({
    queryKey: queryKeys.memoryGraph.activity(companyId, confirmedFilters),
    queryFn: () => memoryGraphApi.activity(companyId, confirmedFilters),
    retry: false,
  });

  if (counts.error || feed.error || !counts.data) return null;
  const totals = weeklyMemoryTotals(counts.data);
  const items = (feed.data?.items ?? []).filter((item) => !item.record.deletedAt && weeklyMemoryLine(item));

  return (
    <section className="space-y-2 rounded-lg border border-border bg-card p-4" data-testid="weekly-report-memory">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <Brain className="size-4 text-muted-foreground" aria-hidden />
        What GSAM learned
      </h2>
      {totals.added === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing new went into memory this week.</p>
      ) : (
        <>
          <p className="text-sm">
            {totals.added} new {totals.added === 1 ? "entry" : "entries"} this week. {totals.confirmed} confirmed
            {totals.waiting > 0 ? `, ${totals.waiting} waiting for review` : ""}.
          </p>
          {items.length > 0 ? (
            <ul className="space-y-1 text-sm">
              {items.slice(0, SHOWN).map((item) => (
                <li key={item.record.id} className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                  <Link to={`/memory?node=${item.record.id}`} className="min-w-0 truncate hover:underline">
                    {weeklyMemoryLine(item)}
                  </Link>
                  <span className="shrink-0 text-xs text-muted-foreground">{item.scopeName}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
      <div className="flex flex-wrap gap-x-4 text-sm text-muted-foreground">
        {totals.waiting > 0 ? (
          <Link to="/memory/review" className="hover:text-foreground hover:underline">
            Review {totals.waiting} waiting
          </Link>
        ) : null}
        <Link to="/memory" className="hover:text-foreground hover:underline">
          See all in Memory
        </Link>
      </div>
    </section>
  );
}
