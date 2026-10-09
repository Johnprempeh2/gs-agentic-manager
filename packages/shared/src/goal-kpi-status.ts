import {
  DEFAULT_KPI_AMBER_THRESHOLD_PCT,
  DEFAULT_KPI_RED_THRESHOLD_PCT,
  type KpiDirection,
  type KpiRagStatus,
} from "./constants.js";

/**
 * KPI status (GRE-1133): green / amber / red from the latest reading against
 * the planned path to target.
 *
 * - The planned path is a straight line from the baseline (value and date) to
 *   the target (value and deadline). The plan value is read at the date of the
 *   latest reading, so an old reading is judged against the plan at its own date.
 * - The gap is how far the reading is behind that plan value, as a percent of
 *   the whole planned change (target minus baseline). Being ahead is a gap of 0.
 *   When target equals baseline (a "hold" KPI) the gap is a percent of the target.
 * - Gap at or above the red line is red, at or above the amber line is amber,
 *   otherwise green. Defaults: amber 10%, red 20%.
 * - Past the deadline the plan is the target: met is green, not met is red.
 * - No baseline: the first reading is the baseline. No target or no deadline:
 *   there is no path, so no status. No reading: no status.
 */

export type KpiStatusReason =
  | "on_track"
  | "behind_plan"
  | "target_met"
  | "deadline_missed"
  | "no_reading"
  | "no_plan";

export interface KpiStatus {
  /** null when there is nothing to judge (no reading or no plan). */
  status: KpiRagStatus | null;
  reason: KpiStatusReason;
  /** Plan value at the latest reading's date. */
  plannedValue: number | null;
  /** Percent behind the plan (0 when on or ahead of plan), one decimal. */
  gapPercent: number | null;
  latestValue: number | null;
  /** "YYYY-MM-DD" */
  latestDate: string | null;
}

export interface KpiPlan {
  baselineValue: number | null;
  /** "YYYY-MM-DD"; null means the KPI's creation date. */
  baselineDate: string | null;
  targetValue: number | null;
  /** The deadline, "YYYY-MM-DD". */
  targetDate: string | null;
  kpiDirection: KpiDirection | null;
  amberThresholdPct: number | null;
  redThresholdPct: number | null;
  createdAt: Date | string;
}

export interface KpiReadingPoint {
  value: number;
  /** "YYYY-MM-DD" */
  readingDate: string;
}

const DAY_MS = 86_400_000;

function dayNumber(date: string): number {
  return Math.floor(Date.parse(`${date.slice(0, 10)}T00:00:00Z`) / DAY_MS);
}

function isoDay(value: Date | string): string {
  return (typeof value === "string" ? new Date(value) : value).toISOString().slice(0, 10);
}

function meetsTarget(value: number, target: number, direction: KpiDirection): boolean {
  return direction === "down" ? value <= target : value >= target;
}

/** Plan value on `date`: linear from baseline to target, flat outside the window. */
export function plannedKpiValue(
  baseline: KpiReadingPoint,
  target: KpiReadingPoint,
  date: string,
): number {
  const start = dayNumber(baseline.readingDate);
  const end = dayNumber(target.readingDate);
  if (end <= start) return target.value;
  const fraction = Math.min(1, Math.max(0, (dayNumber(date) - start) / (end - start)));
  return baseline.value + (target.value - baseline.value) * fraction;
}

/**
 * @param latest the newest reading (by reading date), or null
 * @param first the oldest reading, used as the baseline when none is set
 * @param today "YYYY-MM-DD"
 */
export function computeKpiStatus(
  plan: KpiPlan,
  latest: KpiReadingPoint | null,
  first: KpiReadingPoint | null,
  today: string,
): KpiStatus {
  const empty = { plannedValue: null, gapPercent: null, latestValue: latest?.value ?? null, latestDate: latest?.readingDate ?? null };
  if (plan.targetValue == null || !plan.targetDate) return { status: null, reason: "no_plan", ...empty };
  if (!latest) return { status: null, reason: "no_reading", ...empty };

  const direction = plan.kpiDirection ?? "up";
  const target: KpiReadingPoint = { value: plan.targetValue, readingDate: plan.targetDate };
  const baseline: KpiReadingPoint = plan.baselineValue != null
    ? { value: plan.baselineValue, readingDate: plan.baselineDate ?? isoDay(plan.createdAt) }
    : { value: (first ?? latest).value, readingDate: plan.baselineDate ?? (first ?? latest).readingDate };

  const met = meetsTarget(latest.value, target.value, direction);
  const pastDeadline = dayNumber(today) > dayNumber(target.readingDate);
  if (met || pastDeadline) {
    return {
      status: met ? "green" : "red",
      reason: met ? "target_met" : "deadline_missed",
      plannedValue: target.value,
      gapPercent: met ? 0 : gapPercent(latest.value, target.value, baseline.value, target.value, direction),
      latestValue: latest.value,
      latestDate: latest.readingDate,
    };
  }

  const planned = plannedKpiValue(baseline, target, latest.readingDate);
  const gap = gapPercent(latest.value, planned, baseline.value, target.value, direction);
  const amber = plan.amberThresholdPct ?? DEFAULT_KPI_AMBER_THRESHOLD_PCT;
  const red = Math.max(plan.redThresholdPct ?? DEFAULT_KPI_RED_THRESHOLD_PCT, amber);
  const status: KpiRagStatus = gap >= red ? "red" : gap >= amber ? "amber" : "green";
  return {
    status,
    reason: status === "green" ? "on_track" : "behind_plan",
    plannedValue: planned,
    gapPercent: gap,
    latestValue: latest.value,
    latestDate: latest.readingDate,
  };
}

function gapPercent(
  value: number,
  planned: number,
  baseline: number,
  target: number,
  direction: KpiDirection,
): number {
  const shortfall = direction === "down" ? value - planned : planned - value;
  if (shortfall <= 0) return 0;
  const span = Math.abs(target - baseline) || Math.abs(target) || 1;
  return Math.round((shortfall / span) * 1000) / 10;
}

/** Status of a goal from the KPIs under it. */
export interface GoalRagRollup {
  /** Worst KPI status in the branch; null when no KPI in it has a status. */
  status: KpiRagStatus | null;
  red: number;
  amber: number;
  green: number;
  /** KPIs in the branch with no status (no reading or no plan). */
  noStatus: number;
}

export interface RollupGoal {
  id: string;
  parentId: string | null;
  kind: string | null;
  status: string;
}

const EMPTY_ROLLUP: GoalRagRollup = { status: null, red: 0, amber: 0, green: 0, noStatus: 0 };

/**
 * Rolls KPI status up the goal tree (KPI → objective → pillar / CSF → vision):
 * worst child wins, so one red KPI makes its objective and pillar red. Counts
 * say how many KPIs sit under each goal in each colour. A KPI with no status
 * does not hide a red or amber; a branch with only unread KPIs has no status.
 * Cancelled goals and their branches are left out, as in the progress roll-up.
 */
export function rollUpKpiStatus(
  goals: readonly RollupGoal[],
  kpiStatusById: ReadonlyMap<string, KpiRagStatus | null>,
): Map<string, GoalRagRollup> {
  const children = new Map<string, RollupGoal[]>();
  for (const goal of goals) {
    if (!goal.parentId || goal.status === "cancelled") continue;
    const list = children.get(goal.parentId) ?? [];
    list.push(goal);
    children.set(goal.parentId, list);
  }

  const out = new Map<string, GoalRagRollup>();
  const visiting = new Set<string>();
  const visit = (goal: RollupGoal): GoalRagRollup => {
    const done = out.get(goal.id);
    if (done) return done;
    // A parent cycle in old data: stop here rather than loop.
    if (visiting.has(goal.id)) return EMPTY_ROLLUP;
    visiting.add(goal.id);
    const counts = { red: 0, amber: 0, green: 0, noStatus: 0 };
    if (goal.kind === "kpi") {
      const own = kpiStatusById.get(goal.id) ?? null;
      if (own) counts[own] += 1;
      else counts.noStatus += 1;
    }
    for (const child of children.get(goal.id) ?? []) {
      const sub = visit(child);
      counts.red += sub.red;
      counts.amber += sub.amber;
      counts.green += sub.green;
      counts.noStatus += sub.noStatus;
    }
    visiting.delete(goal.id);
    const status: KpiRagStatus | null =
      counts.red > 0 ? "red" : counts.amber > 0 ? "amber" : counts.green > 0 ? "green" : null;
    const result = { status, ...counts };
    out.set(goal.id, result);
    return result;
  };
  for (const goal of goals) visit(goal);
  return out;
}
