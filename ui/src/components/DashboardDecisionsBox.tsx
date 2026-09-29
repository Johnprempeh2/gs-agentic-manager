import { useQuery } from "@tanstack/react-query";
import type { AttentionFeed, AttentionItem } from "@greatstone/shared";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { attentionApi } from "../api/attention";
import { attentionStatus, sourceMeta } from "../lib/attention";
import { queryKeys } from "../lib/queryKeys";
import { StatusGlyph } from "./StatusGlyph";

export const DASHBOARD_DECISION_PREVIEW_LIMIT = 3;

/**
 * The decisions waiting on the board, top-ranked first. Dismissed and snoozed
 * rows never reach this feed (it is the same query the sidebar badge uses).
 */
export function selectDashboardDecisions(feed: AttentionFeed | null | undefined): {
  count: number;
  preview: AttentionItem[];
} {
  // Lower rank = higher priority (see `sortAttentionItems`).
  const items = [...(feed?.items ?? [])].sort((a, b) => a.rank - b.rank);
  return {
    count: Math.max(feed?.totalCount ?? 0, items.length),
    preview: items.slice(0, DASHBOARD_DECISION_PREVIEW_LIMIT),
  };
}

/** Decision rows deep-link to their card; other kinds open the queue. */
function decisionHref(item: AttentionItem): string {
  return item.sourceKind === "decision"
    ? `/decisions?decisionId=${encodeURIComponent(item.subject.id)}`
    : "/decisions";
}

export function DashboardDecisionsBoxView({
  feed,
  loading = false,
  error = null,
}: {
  feed: AttentionFeed | null | undefined;
  loading?: boolean;
  error?: Error | null;
}) {
  const { count, preview } = selectDashboardDecisions(feed);

  return (
    <Card className="block p-4" aria-label="Decisions" data-testid="dashboard-decisions" role="region">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="text-sm font-semibold">Decisions</h3>
          {feed ? (
            <span
              className="gs-count-pill text-xs tabular-nums text-muted-foreground"
              data-testid="dashboard-decisions-count"
            >
              {count}
            </span>
          ) : null}
        </div>
        <Button asChild size="sm" variant={count > 0 ? "default" : "outline"}>
          <Link to="/decisions">
            Open decisions
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </Button>
      </div>

      {loading && !feed ? (
        <div className="mt-3 space-y-2" aria-busy="true" aria-label="Loading decisions">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-2/3" />
        </div>
      ) : error && !feed ? (
        <p className="mt-2 text-sm text-destructive">Could not load decisions: {error.message}</p>
      ) : count === 0 ? (
        <p className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
          <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
          Nothing is waiting for you.
        </p>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {preview.map((item) => {
            const label = sourceMeta(item.sourceKind).label;
            return (
              <li key={item.id}>
                <Link
                  to={decisionHref(item)}
                  className="flex min-w-0 items-center gap-2 rounded-sm text-sm text-inherit no-underline hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  title={item.subject.title ?? label}
                >
                  <StatusGlyph status={attentionStatus(item)} size="md" />
                  <span className="min-w-0 truncate">{item.subject.title ?? label}</span>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">{label}</span>
                </Link>
              </li>
            );
          })}
          {count > preview.length ? (
            <li className="text-xs text-muted-foreground">
              and {count - preview.length} more
            </li>
          ) : null}
        </ul>
      )}
    </Card>
  );
}

export function DashboardDecisionsBox({ companyId }: { companyId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.attention(companyId),
    queryFn: () => attentionApi.list(companyId),
    enabled: !!companyId,
    refetchInterval: 60_000,
  });
  return <DashboardDecisionsBoxView feed={data} loading={isLoading} error={error} />;
}
