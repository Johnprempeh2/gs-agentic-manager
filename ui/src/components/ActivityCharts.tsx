import type { DashboardRunActivityDay, HeartbeatRun } from "@greatstone/shared";
import { cn, formatShortDate } from "../lib/utils";

/* ---- Utilities ---- */

export function getLast14Days(): string[] {
  return Array.from({ length: 14 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (13 - i));
    return d.toISOString().slice(0, 10);
  });
}

export function formatDayLabel(dateStr: string): string {
  return formatShortDate(new Date(dateStr + "T12:00:00"));
}

const WINDOW_LABEL = "Last 14 days";

/** When the company (or agent) began; days before it are not quiet days. */
export type ChartStart = Date | string | null | undefined;

function startDay(start: ChartStart): string | null {
  if (!start) return null;
  const date = new Date(start);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

// A young company should see its real history, not ten empty days. Only days
// before it existed go: a quiet week for an older company stays on the chart.
function sinceStart(days: string[], start: ChartStart): string[] {
  const first = startDay(start);
  const kept = first ? days.filter((day) => day >= first) : days;
  return kept.length > 0 ? kept : days;
}

/** ChartCard subtitle: names the window the chart really shows. */
export function chartWindowLabel(start: ChartStart): string {
  const days = getLast14Days();
  return sinceStart(days, start).length < days.length ? `Since ${formatShortDate(start as Date | string)}` : WINDOW_LABEL;
}

function sumCounts(counts: Record<string, number>): number {
  return Object.values(counts).reduce((a, b) => a + b, 0);
}

function emptyRunDay(date: string): DashboardRunActivityDay {
  return { date, succeeded: 0, failed: 0, recovered: 0, other: 0, total: 0, failedByErrorCode: {} };
}

// Greatstone run palette: emerald for success (paler when it took a retry),
// the destructive red for failures, a quiet grey for everything else.
const runSegmentColors = {
  succeeded: "var(--brand-emerald)",
  recovered: "var(--brand-emerald-soft)",
  failed: "var(--destructive)",
  other: "var(--subtle-foreground)",
} as const;

// Compact per-day tooltip that also attributes failures to their error class.
function runDayTooltip(entry: DashboardRunActivityDay): string {
  const lines = [`${entry.date}: ${entry.total} run${entry.total === 1 ? "" : "s"}`];
  if (entry.succeeded > 0) lines.push(`  succeeded: ${entry.succeeded}`);
  if (entry.recovered > 0) lines.push(`  recovered: ${entry.recovered} (retry succeeded)`);
  if (entry.failed > 0) {
    lines.push(`  failed: ${entry.failed}`);
    const codes = Object.entries(entry.failedByErrorCode ?? {}).sort((a, b) => b[1] - a[1]);
    for (const [code, count] of codes) lines.push(`    ${code}: ${count}`);
  }
  if (entry.other > 0) lines.push(`  other: ${entry.other}`);
  return lines.join("\n");
}

/* ---- Sub-components ---- */

// First, middle and last day (every day when there are only a few). Today
// reads "Today" in the accent: lime on the void, emerald on paper.
function DateLabels({ days }: { days: string[] }) {
  const today = new Date().toISOString().slice(0, 10);
  const middle = Math.floor((days.length - 1) / 2);
  return (
    <div className="flex gap-(--sz-3px) mt-1.5">
      {days.map((day, i) => (
        <div key={day} className="flex-1 text-center">
          {(days.length <= 4 || i === 0 || i === middle || i === days.length - 1) ? (
            <span className={cn("whitespace-nowrap text-xs tabular-nums", day === today ? "font-medium text-primary" : "text-muted-foreground")}>
              {day === today ? "Today" : formatDayLabel(day)}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function ChartLegend({ items }: { items: { color: string; label: string }[] }) {
  return (
    <div className="flex flex-wrap gap-x-2.5 gap-y-0.5 mt-2">
      {items.map(item => (
        <span key={item.label} className="flex items-center gap-1 text-xs text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ backgroundColor: item.color }} />
          {item.label}
        </span>
      ))}
    </div>
  );
}

export function ChartCard({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="gs-glass-card border rounded-xl p-4 space-y-3">
      <div>
        <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
        {subtitle && <span className="text-xs text-subtle-foreground">{subtitle}</span>}
      </div>
      {children}
    </div>
  );
}

/* ---- Chart Components ---- */

type RunChartProps = { start?: ChartStart } & (
  | { activity?: DashboardRunActivityDay[] | null; runs?: never }
  | { runs?: HeartbeatRun[] | null; activity?: never }
);

function aggregateRuns(runs: readonly HeartbeatRun[] = []): DashboardRunActivityDay[] {
  const days = getLast14Days();
  const grouped = new Map<string, DashboardRunActivityDay>();
  for (const day of days) grouped.set(day, emptyRunDay(day));
  for (const run of runs) {
    const day = new Date(run.createdAt).toISOString().slice(0, 10);
    const entry = grouped.get(day);
    if (!entry) continue;
    if (run.status === "succeeded") {
      entry.succeeded++;
    } else if (run.status === "failed" || run.status === "timed_out") {
      // A flat run list has no retry-chain linkage, so recovery can't be derived
      // here (the company dashboard computes it server-side). Attribute the
      // failure to its error class so the breakdown still renders.
      entry.failed++;
      const code = run.errorCode && run.errorCode.length > 0 ? run.errorCode : "unknown";
      entry.failedByErrorCode[code] = (entry.failedByErrorCode[code] ?? 0) + 1;
    } else {
      entry.other++;
    }
    entry.total++;
  }
  return Array.from(grouped.values());
}

function resolveRunActivity(props: RunChartProps): DashboardRunActivityDay[] {
  if (Array.isArray(props.activity)) return props.activity;
  if (Array.isArray(props.runs)) return aggregateRuns(props.runs);
  return [];
}

function runActivitySince(props: RunChartProps): DashboardRunActivityDay[] {
  const activity = resolveRunActivity(props);
  const kept = new Set(sinceStart(activity.map((day) => day.date), props.start));
  return activity.filter((day) => kept.has(day.date));
}

export function RunActivityChart(props: RunChartProps) {
  const activity = runActivitySince(props);
  const days = activity.map((day) => day.date);
  const grouped = new Map(activity.map((day) => [day.date, day]));

  const maxValue = Math.max(...activity.map(v => v.total), 1);
  const hasData = activity.some(v => v.total > 0);
  const hasRecovered = activity.some(v => v.recovered > 0);

  if (!hasData) return <p className="text-xs text-muted-foreground">No runs yet</p>;

  const legendItems = [
    { color: runSegmentColors.succeeded, label: "Succeeded" },
    ...(hasRecovered ? [{ color: runSegmentColors.recovered, label: "Recovered" }] : []),
    { color: runSegmentColors.failed, label: "Failed" },
    { color: runSegmentColors.other, label: "Other" },
  ];

  return (
    <div>
      <div className="gs-bars flex items-end gap-(--sz-3px) h-20">
        {days.map(day => {
          const entry = grouped.get(day) ?? emptyRunDay(day);
          const total = entry.total;
          const heightPct = (total / maxValue) * 100;
          return (
            <div key={day} className="flex-1 h-full flex flex-col justify-end" title={runDayTooltip(entry)}>
              {total > 0 ? (
                <div className="gs-bar flex flex-col-reverse gap-px overflow-hidden rounded-t-sm" style={{ height: `${heightPct}%`, minHeight: 2 }}>
                  {entry.succeeded > 0 && <div style={{ flex: entry.succeeded, backgroundColor: runSegmentColors.succeeded }} />}
                  {entry.recovered > 0 && <div style={{ flex: entry.recovered, backgroundColor: runSegmentColors.recovered }} />}
                  {entry.failed > 0 && <div style={{ flex: entry.failed, backgroundColor: runSegmentColors.failed }} />}
                  {entry.other > 0 && <div style={{ flex: entry.other, backgroundColor: runSegmentColors.other }} />}
                </div>
              ) : (
                <div className="bg-muted/30 rounded-sm" style={{ height: 2 }} />
              )}
            </div>
          );
        })}
      </div>
      <DateLabels days={days} />
      <ChartLegend items={legendItems} />
    </div>
  );
}

const priorityColors: Record<string, string> = {
  critical: "var(--status-task-icon-blocked)",
  high: "var(--hex-f97316)",
  medium: "var(--hex-eab308)",
  low: "var(--hex-6b7280)",
};

const priorityOrder = ["critical", "high", "medium", "low"] as const;

export function PriorityChart({ issues, start }: { issues: { priority: string; createdAt: Date }[]; start?: ChartStart }) {
  const days = getLast14Days();
  const grouped = new Map<string, Record<string, number>>();
  for (const day of days) grouped.set(day, { critical: 0, high: 0, medium: 0, low: 0 });
  for (const issue of issues) {
    const day = new Date(issue.createdAt).toISOString().slice(0, 10);
    const entry = grouped.get(day);
    if (!entry) continue;
    if (issue.priority in entry) entry[issue.priority]++;
  }

  const maxValue = Math.max(...Array.from(grouped.values()).map(sumCounts), 1);
  const hasData = Array.from(grouped.values()).some(v => sumCounts(v) > 0);

  if (!hasData) return <p className="text-xs text-muted-foreground">No tasks</p>;
  const shownDays = sinceStart(days, start);

  return (
    <div>
      <div className="gs-bars flex items-end gap-(--sz-3px) h-20">
        {shownDays.map(day => {
          const entry = grouped.get(day)!;
          const total = sumCounts(entry);
          const heightPct = (total / maxValue) * 100;
          return (
            <div key={day} className="flex-1 h-full flex flex-col justify-end" title={`${day}: ${total} issues`}>
              {total > 0 ? (
                <div className="gs-bar flex flex-col-reverse gap-px overflow-hidden rounded-t-sm" style={{ height: `${heightPct}%`, minHeight: 2 }}>
                  {priorityOrder.map(p => entry[p] > 0 ? (
                    <div key={p} style={{ flex: entry[p], backgroundColor: priorityColors[p] }} />
                  ) : null)}
                </div>
              ) : (
                <div className="bg-muted/30 rounded-sm" style={{ height: 2 }} />
              )}
            </div>
          );
        })}
      </div>
      <DateLabels days={shownDays} />
      <ChartLegend items={priorityOrder.map(p => ({ color: priorityColors[p], label: p.charAt(0).toUpperCase() + p.slice(1) }))} />
    </div>
  );
}

// DECISION-SHEET.md B5: chart status colors re-pointed at the canonical
// --status-task-* system (DESIGN.md principle 5 — an operator learns one
// status vocabulary; badge, row, chart, and log agree). Previously an
// independent palette (todo blue, in_progress violet, etc.). `backlog`
// deliberately keeps --project-none (pre-B5, per user ruling); the
// non-red priority series retain their own hues.
// Progress, done, and blocked use the icon hues so bars and legends match
// the task icons in each theme.
const statusColors: Record<string, string> = {
  todo: "var(--status-task-todo)",
  in_progress: "var(--status-task-icon-in_progress)",
  in_review: "var(--status-task-in_review)",
  done: "var(--status-task-icon-done)",
  blocked: "var(--status-task-icon-blocked)",
  cancelled: "var(--status-task-cancelled)",
  backlog: "var(--project-none)",
};

const statusLabels: Record<string, string> = {
  todo: "To Do",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  blocked: "Blocked",
  cancelled: "Cancelled",
  backlog: "Backlog",
};

export function IssueStatusChart({ issues, start }: { issues: { status: string; createdAt: Date }[]; start?: ChartStart }) {
  const days = getLast14Days();
  const allStatuses = new Set<string>();
  const grouped = new Map<string, Record<string, number>>();
  for (const day of days) grouped.set(day, {});
  for (const issue of issues) {
    const day = new Date(issue.createdAt).toISOString().slice(0, 10);
    const entry = grouped.get(day);
    if (!entry) continue;
    entry[issue.status] = (entry[issue.status] ?? 0) + 1;
    allStatuses.add(issue.status);
  }

  const statusOrder = ["todo", "in_progress", "in_review", "done", "blocked", "cancelled", "backlog"].filter(s => allStatuses.has(s));
  const maxValue = Math.max(...Array.from(grouped.values()).map(sumCounts), 1);
  const hasData = allStatuses.size > 0;

  if (!hasData) return <p className="text-xs text-muted-foreground">No tasks</p>;
  const shownDays = sinceStart(days, start);

  return (
    <div>
      <div className="gs-bars flex items-end gap-(--sz-3px) h-20">
        {shownDays.map(day => {
          const entry = grouped.get(day)!;
          const total = sumCounts(entry);
          const heightPct = (total / maxValue) * 100;
          return (
            <div key={day} className="flex-1 h-full flex flex-col justify-end" title={`${day}: ${total} issues`}>
              {total > 0 ? (
                <div className="gs-bar flex flex-col-reverse gap-px overflow-hidden rounded-t-sm" style={{ height: `${heightPct}%`, minHeight: 2 }}>
                  {statusOrder.map(s => (entry[s] ?? 0) > 0 ? (
                    <div key={s} style={{ flex: entry[s], backgroundColor: statusColors[s] ?? "var(--hex-6b7280)" }} />
                  ) : null)}
                </div>
              ) : (
                <div className="bg-muted/30 rounded-sm" style={{ height: 2 }} />
              )}
            </div>
          );
        })}
      </div>
      <DateLabels days={shownDays} />
      <ChartLegend items={statusOrder.map(s => ({ color: statusColors[s] ?? "var(--hex-6b7280)", label: statusLabels[s] ?? s }))} />
    </div>
  );
}

export function SuccessRateChart(props: RunChartProps) {
  const activity = runActivitySince(props);
  const days = activity.map((day) => day.date);
  const grouped = new Map(activity.map((day) => [day.date, day]));

  const hasData = activity.some(v => v.total > 0);
  if (!hasData) return <p className="text-xs text-muted-foreground">No runs yet</p>;

  return (
    <div>
      <div className="gs-bars flex items-end gap-(--sz-3px) h-20">
        {days.map(day => {
          const entry = grouped.get(day) ?? emptyRunDay(day);
          // Recovered runs ultimately succeeded, so they count toward the rate
          // rather than dragging it down as failures.
          const effectiveSucceeded = entry.succeeded + entry.recovered;
          const rate = entry.total > 0 ? effectiveSucceeded / entry.total : 0;
          // Emerald unless failures carried the day.
          const color = rate >= 0.5 ? runSegmentColors.succeeded : runSegmentColors.failed;
          return (
            <div key={day} className="flex-1 h-full flex flex-col justify-end" title={`${day}: ${entry.total > 0 ? Math.round(rate * 100) : 0}% (${effectiveSucceeded}/${entry.total})`}>
              {entry.total > 0 ? (
                <div className="gs-bar rounded-t-sm" style={{ height: `${rate * 100}%`, minHeight: 2, backgroundColor: color }} />
              ) : (
                <div className="bg-muted/30 rounded-sm" style={{ height: 2 }} />
              )}
            </div>
          );
        })}
      </div>
      <DateLabels days={days} />
    </div>
  );
}
