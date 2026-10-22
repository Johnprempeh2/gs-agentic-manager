import type { DecisionCard, DecisionsFeed } from "@greatstone/shared";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useDecisionsFeed, useNeedsMe } from "../hooks/useDecisionsFeed";

export const DASHBOARD_DECISION_PREVIEW_LIMIT = 1;

/**
 * The decisions waiting on the board. `count` is the one "needs you" number
 * (NeedsMe.decisionCount), the same as the sidebar badge, the phone tab and
 * the Desk's Decisions section; without it, the feed's cards. The preview is
 * the feed's most urgent card that can be acted on from anywhere.
 */
export function selectDashboardDecisions(
  feed: DecisionsFeed | null | undefined,
  oneCount?: number,
): {
  count: number;
  preview: DecisionCard[];
} {
  // "At your desk" cards are outside the count (GRE-450).
  const cards = (feed?.cards ?? []).filter((card) => !card.atDesk);
  return {
    count: oneCount ?? cards.length,
    preview: cards.slice(0, DASHBOARD_DECISION_PREVIEW_LIMIT),
  };
}

export function DashboardDecisionsBoxView({
  feed,
  count: oneCount,
  loading = false,
  error = null,
}: {
  feed: DecisionsFeed | null | undefined;
  /** The one "needs you" number; falls back to the feed's cards. */
  count?: number;
  loading?: boolean;
  error?: Error | null;
}) {
  const { count, preview } = selectDashboardDecisions(feed, oneCount);
  const top = preview[0];

  // Stacks on a phone (count and button on top, the top decision under it)
  // so a long title never runs under the button; one row from `sm` up.
  return (
    <Card
      className="flex min-w-0 flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-3 sm:py-2.5"
      aria-label="Decisions"
      data-testid="dashboard-decisions"
      data-tour="dashboard-decisions"
      role="region"
    >
      <div className="flex min-w-0 items-center justify-between gap-3 sm:contents">
        <div className="flex shrink-0 items-center gap-2 sm:order-1">
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
        <Button asChild size="sm" variant={count > 0 ? "default" : "outline"} className="shrink-0 sm:order-3">
          <Link to="/decisions">
            Open decisions
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </Button>
      </div>

      <div className="flex min-w-0 flex-1 items-center gap-2 text-sm sm:order-2">
        {loading && !feed ? (
          <Skeleton className="h-5 w-full max-w-xs" aria-busy="true" aria-label="Loading decisions" />
        ) : error && !feed ? (
          <p className="truncate text-destructive">Could not load decisions: {error.message}</p>
        ) : !top ? (
          <p className="flex items-center gap-2 text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
            Nothing is waiting for you.
          </p>
        ) : (
          <>
            <Link
              to="/decisions"
              className="min-w-0 truncate rounded-sm text-inherit no-underline hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              title={top.title}
            >
              {top.title}
            </Link>
            {count > 1 ? (
              <span className="shrink-0 text-xs text-muted-foreground">and {count - 1} more</span>
            ) : null}
          </>
        )}
      </div>
    </Card>
  );
}

export function DashboardDecisionsBox({ companyId }: { companyId: string }) {
  const { data, isLoading, error } = useDecisionsFeed(companyId);
  const { data: needsMe } = useNeedsMe(companyId);
  return <DashboardDecisionsBoxView feed={data} count={needsMe?.decisionCount} loading={isLoading} error={error} />;
}
