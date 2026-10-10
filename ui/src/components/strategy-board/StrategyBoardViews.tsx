import type { CSSProperties } from "react";
import type { KpiRagStatus, StrategyBoardArea, StrategyBoardKpi } from "@greatstone/shared";
import { GOAL_KIND_LABELS } from "@greatstone/shared";
import { ArrowRight, CircleHelp, ShieldAlert, ShieldCheck, Shield } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { KpiSourceBadge, KpiStatusPill, formatKpiValue, rollupSummary } from "@/components/goals/KpiReadings";
import { ASSURANCE_LABEL, boardAssurance, boardOwnerName, readingAgeText, type BoardAssurance } from "@/lib/strategy-board";

const CHIP = "status-chip inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium";

const ASSURANCE_STYLE: Record<BoardAssurance, { color: string; icon: typeof Shield }> = {
  strong: { color: "var(--status-success)", icon: ShieldCheck },
  moderate: { color: "var(--status-info)", icon: Shield },
  weak: { color: "var(--status-warning)", icon: ShieldAlert },
};

/** Evidence strength, apart from performance: a colour never implies the number is checked. */
export function AssuranceBadge({ kpi }: { kpi: Pick<StrategyBoardKpi, "latestReadingSource" | "readingAgeDays"> }) {
  const level = boardAssurance(kpi);
  const { color, icon: Icon } = ASSURANCE_STYLE[level];
  return (
    <span className={CHIP} style={{ "--sc": color } as CSSProperties} data-assurance={level}>
      <Icon className="size-3" aria-hidden />
      {ASSURANCE_LABEL[level]}
    </span>
  );
}

const DOT: Record<KpiRagStatus, string> = { red: "bg-status-danger", amber: "bg-status-warning", green: "bg-status-success" };

const STATUS_WORD: Record<KpiRagStatus, string> = { red: "red", amber: "amber", green: "green" };

/** "Was amber, now red" or "New since the last pack". */
export function changeText(kpi: StrategyBoardKpi): string | null {
  if (!kpi.changedSinceSnapshot) return null;
  if (kpi.previousStatus == null) return kpi.status ? `New since the last pack, now ${STATUS_WORD[kpi.status]}` : "New since the last pack";
  return `Was ${STATUS_WORD[kpi.previousStatus]}, now ${kpi.status ? STATUS_WORD[kpi.status] : "no status"}`;
}

function slipText(kpi: StrategyBoardKpi): string {
  const latest = kpi.latestValue != null ? formatKpiValue(kpi.latestValue, kpi.unit) : "–";
  if (kpi.reason === "deadline_missed") {
    return `Deadline passed: ${latest} against a target of ${kpi.targetValue != null ? formatKpiValue(kpi.targetValue, kpi.unit) : "–"}`;
  }
  const plan = kpi.plannedValue != null ? formatKpiValue(Math.round(kpi.plannedValue * 100) / 100, kpi.unit) : "–";
  return `${kpi.gapPercent ?? 0}% behind plan: ${latest} against ${plan}`;
}

export function AttentionQueue({
  kpis,
  canAskWhy,
  onAskWhy,
}: {
  kpis: readonly StrategyBoardKpi[];
  canAskWhy: boolean;
  onAskWhy: (kpi: StrategyBoardKpi) => void;
}) {
  if (kpis.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
        No KPI is red or amber. No board action is needed.
      </p>
    );
  }
  return (
    <ol className="divide-y divide-border overflow-hidden rounded-lg border border-border" aria-label="Needs board attention">
      {kpis.map((kpi, index) => {
        const change = changeText(kpi);
        return (
          <li key={kpi.goalId} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:justify-between" data-testid="attention-row">
            <div className="flex min-w-0 gap-3">
              <span className="w-5 shrink-0 pt-0.5 text-right text-xs font-mono text-muted-foreground">{index + 1}</span>
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Link to={`/goals/${kpi.goalId}`} className="text-sm font-semibold hover:underline">{kpi.title}</Link>
                  <KpiStatusPill status={kpi.status} />
                </div>
                {kpi.areaTitle || kpi.objectiveTitle ? (
                  <p className="text-xs text-muted-foreground">{[kpi.areaTitle, kpi.objectiveTitle].filter(Boolean).join(" · ")}</p>
                ) : null}
                <p className="text-sm">{slipText(kpi)}{change ? <span className="text-muted-foreground"> · {change}</span> : null}</p>
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  <AssuranceBadge kpi={kpi} />
                  {kpi.latestReadingSource ? <KpiSourceBadge source={kpi.latestReadingSource} /> : null}
                  <span>{readingAgeText(kpi.readingAgeDays)}</span>
                  <span aria-hidden>·</span>
                  <span>Owner: {boardOwnerName(kpi.owner)}</span>
                  {kpi.openWhyRequests > 0 ? (
                    <>
                      <span aria-hidden>·</span>
                      <span>{kpi.openWhyRequests === 1 ? "1 question waiting" : `${kpi.openWhyRequests} questions waiting`}</span>
                    </>
                  ) : null}
                </div>
              </div>
            </div>
            {canAskWhy ? (
              <div className="flex shrink-0 gap-2 pl-8 sm:pl-0">
                <Button size="sm" variant="outline" onClick={() => onAskWhy(kpi)} disabled={!kpi.owner} title={kpi.owner ? undefined : "This KPI has no owner to ask"}>
                  <CircleHelp className="size-3.5" />
                  Ask why
                </Button>
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

export function StrategyAtAGlance({ areas }: { areas: readonly StrategyBoardArea[] }) {
  if (areas.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
        The plan has no pillars or critical success factors yet. <Link to="/goals" className="underline">Open Goals</Link> to add them.
      </p>
    );
  }
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {areas.map((area) => (
        <section key={area.goalId} className="space-y-2 rounded-lg border border-border bg-card p-3" aria-label={area.title}>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">{GOAL_KIND_LABELS[area.kind]}</p>
              <Link to={`/goals/${area.goalId}`} className="text-sm font-semibold hover:underline">{area.title}</Link>
            </div>
            <KpiStatusPill status={area.rollup.status} />
          </div>
          {rollupSummary(area.rollup) ? <p className="text-xs text-muted-foreground">{rollupSummary(area.rollup)}</p> : null}
          {area.objectives.length > 0 ? (
            <ul className="space-y-1 border-t border-border pt-2">
              {area.objectives.map((objective) => (
                <li key={objective.goalId} className="flex items-center justify-between gap-2 text-sm">
                  <Link to={`/goals/${objective.goalId}`} className="min-w-0 truncate hover:underline">{objective.title}</Link>
                  <span
                    className={cn("size-2 shrink-0 rounded-full", objective.rollup.status ? DOT[objective.rollup.status] : "bg-muted")}
                    aria-label={objective.rollup.status ?? "no status"}
                    role="img"
                  />
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ))}
    </div>
  );
}

export function ChangesSinceSnapshot({ kpis, hasSnapshot }: { kpis: readonly StrategyBoardKpi[]; hasSnapshot: boolean }) {
  if (!hasSnapshot) {
    return <p className="text-sm text-muted-foreground">Make the first board pack to start tracking what changes between board meetings.</p>;
  }
  if (kpis.length === 0) return <p className="text-sm text-muted-foreground">No KPI changed colour since the last board pack.</p>;
  return (
    <ul className="space-y-1.5">
      {kpis.map((kpi) => (
        <li key={kpi.goalId} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm" data-testid="change-row">
          <Link to={`/goals/${kpi.goalId}`} className="min-w-0 flex-[1_1_10rem] font-medium break-words hover:underline">{kpi.title}</Link>
          {/* Old and new status move as one unit: beside the title when it fits, else on the next line. */}
          <span className="flex shrink-0 items-center gap-1.5">
            {kpi.previousStatus ? <KpiStatusPill status={kpi.previousStatus} /> : <span className="text-xs text-muted-foreground">new</span>}
            <ArrowRight className="size-3.5 text-muted-foreground" aria-label="now" />
            <KpiStatusPill status={kpi.status} />
          </span>
        </li>
      ))}
    </ul>
  );
}
