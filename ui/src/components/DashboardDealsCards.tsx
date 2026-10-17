import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { BellRing, Briefcase, Trophy } from "lucide-react";
import { pipelinesApi, type PipelineCaseChildRow } from "../api/pipelines";
import { queryKeys } from "../lib/queryKeys";
import { getDealNextStepFlag } from "../lib/client-card-flags";
import { dealsClosedThisMonth, formatDealTotals, isDevtoolsCaseType, sumDealValues, weightedDealValues } from "../lib/client-case";
import { MetricCard } from "./MetricCard";

const LEADS_PIPELINE_KEY = "pipedrive-leads";

/** Open value, weighted value, deals needing a next step and won this month, across the DevTools deal pipelines. */
export function summariseDevtoolsDeals(rows: readonly PipelineCaseChildRow[], now: Date = new Date()) {
  const open = rows.filter((row) => row.stage.kind !== "done" && row.stage.kind !== "cancelled").map((row) => row.case);
  return {
    openCount: open.length,
    openValue: formatDealTotals(sumDealValues(open)),
    weightedValue: formatDealTotals(weightedDealValues(open)),
    needingNextStep: open.filter((item) => getDealNextStepFlag(item, now) !== null).length,
    wonThisMonth: dealsClosedThisMonth(rows.map((row) => row.case), "won", now),
  };
}

/**
 * The sales numbers from the Pipedrive deals on the dashboard, so the day
 * starts with the pipeline as well as the agents. Shows nothing when the
 * company has no DevTools deal pipeline.
 */
export function DashboardDealsCards({ companyId }: { companyId: string }) {
  const { data: pipelines } = useQuery({
    queryKey: queryKeys.pipelines.list(companyId),
    queryFn: () => pipelinesApi.list(companyId),
  });
  const dealPipelines = useMemo(
    () => (pipelines ?? []).filter((pipeline) => !pipeline.archivedAt && isDevtoolsCaseType(pipeline.key) && pipeline.key !== LEADS_PIPELINE_KEY),
    [pipelines],
  );
  const caseQueries = useQueries({
    queries: dealPipelines.map((pipeline) => ({
      queryKey: queryKeys.pipelines.cases(pipeline.id),
      queryFn: () => pipelinesApi.listCases(pipeline.id),
    })),
  });
  const loaded = caseQueries.length > 0 && caseQueries.every((query) => query.data);
  const summary = loaded ? summariseDevtoolsDeals(caseQueries.flatMap((query) => query.data ?? [])) : null;

  if (!summary) return null;
  const to = dealPipelines.length === 1 ? `/pipelines/${dealPipelines[0]!.id}` : "/pipelines";
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-3 xl:grid-cols-4" aria-label="Pipedrive deals">
      <MetricCard
        icon={Briefcase}
        value={summary.openValue || "0"}
        label={`In ${summary.openCount} open ${summary.openCount === 1 ? "deal" : "deals"}`}
        to={to}
        description={summary.weightedValue ? `${summary.weightedValue} weighted by probability` : undefined}
      />
      <MetricCard
        icon={BellRing}
        value={summary.needingNextStep}
        label={summary.needingNextStep === 1 ? "Deal needs a next step" : "Deals need a next step"}
        to={to}
        description="No next step booked, or the next step is late."
      />
      <MetricCard
        icon={Trophy}
        value={summary.wonThisMonth.count}
        label="Deals won this month"
        to={to}
        description={formatDealTotals(summary.wonThisMonth.totals) || undefined}
      />
    </div>
  );
}
