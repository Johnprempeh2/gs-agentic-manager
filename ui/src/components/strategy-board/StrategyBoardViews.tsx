import type { CSSProperties } from "react";
import type { KpiRagStatus, StrategyBoardAction, StrategyBoardArea, StrategyBoardKpi, StrategyBoardWhyItem } from "@greatstone/shared";
import { GOAL_KIND_LABELS, KPI_STATUS_WORDS, isOnCourseOnWeakEvidence } from "@greatstone/shared";
import { ArrowRight, CalendarClock, CircleHelp, ShieldAlert, ShieldCheck, Shield } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { KpiSourceBadge, KpiSparkline, KpiStatusPill, formatKpiValue, rollupSummary } from "@/components/goals/KpiReadings";
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

function statusWord(status: KpiRagStatus): string {
  return KPI_STATUS_WORDS[status].toLowerCase();
}

/** "Was watch, now off course" or "New since the last pack". */
export function changeText(kpi: StrategyBoardKpi): string | null {
  if (!kpi.changedSinceSnapshot) return null;
  if (kpi.previousStatus == null) return kpi.status ? `New since the last pack, now ${statusWord(kpi.status)}` : "New since the last pack";
  return `Was ${statusWord(kpi.previousStatus)}, now ${kpi.status ? statusWord(kpi.status) : "no status"}`;
}

/** "Was 120 k, now 150 k": the number, not only the colour. */
export function valueChangeText(kpi: Pick<StrategyBoardKpi, "previousValue" | "latestValue" | "unit">): string | null {
  if (kpi.latestValue == null) return null;
  const now = formatKpiValue(kpi.latestValue, kpi.unit);
  return kpi.previousValue == null ? `Now ${now}` : `Was ${formatKpiValue(kpi.previousValue, kpi.unit)}, now ${now}`;
}

function slipText(kpi: StrategyBoardKpi): string {
  if (!kpi.status) return `Not measured: ${kpi.notMeasuredReason ?? "no status"}`;
  const latest = kpi.latestValue != null ? formatKpiValue(kpi.latestValue, kpi.unit) : "n/a";
  if (kpi.reason === "deadline_missed") {
    return `Deadline passed: ${latest} against a target of ${kpi.targetValue != null ? formatKpiValue(kpi.targetValue, kpi.unit) : "n/a"}`;
  }
  const plan = kpi.plannedValue != null ? formatKpiValue(Math.round(kpi.plannedValue * 100) / 100, kpi.unit) : "n/a";
  return `${kpi.gapPercent ?? 0}% behind plan: ${latest} against ${plan}`;
}

function AttentionRows({
  kpis,
  label,
  canAskWhy,
  onAskWhy,
}: {
  kpis: readonly StrategyBoardKpi[];
  label: string;
  canAskWhy: boolean;
  onAskWhy: (kpi: StrategyBoardKpi) => void;
}) {
  return (
    <ol className="divide-y divide-border overflow-hidden rounded-lg border border-border" aria-label={label}>
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
                <div className="flex items-center gap-2">
                  <p className="min-w-0 text-sm">{slipText(kpi)}{change ? <span className="text-muted-foreground"> · {change}</span> : null}</p>
                  <KpiSparkline points={kpi.trend} unit={kpi.unit} />
                </div>
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

/**
 * The board attention queue: slippages and unmeasured KPIs first, then, as
 * their own group, KPIs that are on course but rest on stale or weak evidence.
 */
export function AttentionQueue({
  kpis,
  canAskWhy,
  onAskWhy,
}: {
  kpis: readonly StrategyBoardKpi[];
  canAskWhy: boolean;
  onAskWhy: (kpi: StrategyBoardKpi) => void;
}) {
  const weak = kpis.filter(isOnCourseOnWeakEvidence);
  const main = kpis.filter((kpi) => !isOnCourseOnWeakEvidence(kpi));
  return (
    <div className="space-y-3">
      {main.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          Every KPI is measured, and none is off course or on watch. No board action is needed.
        </p>
      ) : (
        <AttentionRows kpis={main} label="Needs board attention" canAskWhy={canAskWhy} onAskWhy={onAskWhy} />
      )}
      {weak.length > 0 ? (
        <div className="space-y-2" data-testid="attention-weak-evidence">
          <h3 className="text-sm font-medium">On course, but on weak evidence</h3>
          <AttentionRows kpis={weak} label="On course, but on weak evidence" canAskWhy={canAskWhy} onAskWhy={onAskWhy} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * "Why?" requests between meetings: what owners answered since the last
 * board pack, and what is still waiting, with its age.
 */
export function WhyAnswersSinceMeeting({
  answered,
  open,
  hasSnapshot,
}: {
  answered: readonly StrategyBoardWhyItem[];
  open: readonly StrategyBoardWhyItem[];
  hasSnapshot: boolean;
}) {
  if (answered.length === 0 && open.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {hasSnapshot ? "No \"Why?\" request answered or waiting since the last board pack." : "No \"Why?\" requests yet."}
      </p>
    );
  }
  return (
    <div className="space-y-3">
      {answered.length > 0 ? (
        <ul className="divide-y divide-border rounded-lg border border-border" aria-label="Answered">
          {answered.map((item) => (
            <li key={item.id} className="space-y-1 px-4 py-3 text-sm" data-testid="why-answered-row">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <Link to={`/goals/${item.goalId}`} className="font-semibold hover:underline">{item.kpiTitle}</Link>
                <span className="text-xs text-muted-foreground">{item.ownerName ?? "The owner"}</span>
              </div>
              <p className="line-clamp-2 whitespace-pre-line">{item.answer}</p>
            </li>
          ))}
        </ul>
      ) : null}
      {open.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Still waiting for an answer</p>
          <ul className="space-y-1">
            {open.map((item) => (
              <li key={item.id} className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm" data-testid="why-open-row">
                <Link to={`/goals/${item.goalId}`} className="min-w-0 break-words hover:underline">{item.kpiTitle}</Link>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {item.ownerName ?? "The owner"} · asked {item.ageDays === 0 ? "today" : item.ageDays === 1 ? "1 day ago" : `${item.ageDays} days ago`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** "1 day overdue" or "5 days overdue". */
export function overdueText(days: number): string {
  return days === 1 ? "1 day overdue" : `${days} days overdue`;
}

/** Overdue plan actions (GRE-1188), grouped by objective; the server sends them in objective then owner order. */
export function OverdueActions({ actions }: { actions: readonly StrategyBoardAction[] }) {
  if (actions.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
        No plan action is past its due date.
      </p>
    );
  }
  const groups: Array<{ objectiveId: string; objectiveTitle: string; areaTitle: string | null; actions: StrategyBoardAction[] }> = [];
  for (const action of actions) {
    const last = groups[groups.length - 1];
    if (last && last.objectiveId === action.objectiveId) last.actions.push(action);
    else groups.push({ objectiveId: action.objectiveId, objectiveTitle: action.objectiveTitle, areaTitle: action.areaTitle, actions: [action] });
  }
  return (
    <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
      {groups.map((group) => (
        <section key={group.objectiveId} className="space-y-2 px-4 py-3" aria-label={group.objectiveTitle} data-testid="overdue-group">
          <div className="min-w-0">
            {group.areaTitle ? <p className="text-xs text-muted-foreground">{group.areaTitle}</p> : null}
            <Link to={`/goals/${group.objectiveId}`} className="text-sm font-semibold hover:underline">{group.objectiveTitle}</Link>
          </div>
          <ul className="space-y-1.5">
            {group.actions.map((action) => (
              <li key={action.issueId} className="flex flex-col gap-0.5 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-3" data-testid="overdue-row">
                <Link to={`/issues/${action.identifier ?? action.issueId}`} className="min-w-0 break-words hover:underline">
                  {action.identifier ? <span className="mr-1.5 font-mono text-xs text-muted-foreground">{action.identifier}</span> : null}
                  {action.title}
                </Link>
                <span className="flex shrink-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  <span>{boardOwnerName(action.owner)}</span>
                  <span aria-hidden>·</span>
                  <span>Due {action.dueDate}</span>
                  <span
                    className={CHIP}
                    style={{ "--sc": "var(--status-danger)" } as CSSProperties}
                  >
                    <CalendarClock className="size-3" aria-hidden />
                    {overdueText(action.daysOverdue)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
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
  if (kpis.length === 0) return <p className="text-sm text-muted-foreground">No KPI changed status since the last board pack.</p>;
  return (
    <ul className="space-y-1.5">
      {kpis.map((kpi) => (
        <li key={kpi.goalId} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm" data-testid="change-row">
          <span className="min-w-0 flex-(--flex-kpi-title)">
            <Link to={`/goals/${kpi.goalId}`} className="font-medium break-words hover:underline">{kpi.title}</Link>
            {valueChangeText(kpi) ? (
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                {valueChangeText(kpi)}
                <KpiSparkline points={kpi.trend} unit={kpi.unit} />
              </span>
            ) : null}
          </span>
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
