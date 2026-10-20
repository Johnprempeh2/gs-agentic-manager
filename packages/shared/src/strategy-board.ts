import { GOAL_KIND_LABELS, KPI_READING_SOURCE_LABELS, type GoalKind, type KpiRagStatus, type KpiReadingSource } from "./constants.js";
import type { GoalRagRollup, KpiStatus } from "./goal-kpi-status.js";
import type {
  StrategyBoardAction,
  StrategyBoardArea,
  StrategyBoardBrief,
  StrategyBoardKpi,
  StrategyBoardOwner,
  StrategyBoardPackSnapshot,
  StrategyBoardTrendPoint,
  StrategyBoardWhyItem,
} from "./types/strategy-board.js";

/**
 * Board control panel logic (GRE-1135), kept pure so the server, the UI and
 * the tests share one answer to "what does the board see".
 */

export interface StrategyBoardGoal {
  id: string;
  parentId: string | null;
  kind: string | null;
  status: string;
  title: string;
  unit: string | null;
  targetValue: number | null;
  targetDate: string | null;
  ownerUserId: string | null;
  ownerAgentId: string | null;
}

export interface StrategyBoardKpiInput {
  goals: readonly StrategyBoardGoal[];
  statusById: ReadonlyMap<string, KpiStatus>;
  latestReadingById: ReadonlyMap<string, { readingDate: string; source: KpiReadingSource }>;
  /** KPI status and value in the last board pack; null when there is no pack. */
  snapshotById: ReadonlyMap<string, { status: KpiRagStatus | null; latestValue: number | null }> | null;
  openWhyById: ReadonlyMap<string, number>;
  /** Recent readings by KPI, oldest first, for the trend; optional. */
  trendById?: ReadonlyMap<string, StrategyBoardTrendPoint[]>;
  ownerNames: { users: ReadonlyMap<string, string | null>; agents: ReadonlyMap<string, string | null> };
  /** "YYYY-MM-DD" */
  today: string;
}

const AREA_KINDS: ReadonlySet<string> = new Set<GoalKind>(["csf", "pillar"]);
const DAY_MS = 86_400_000;

function dayNumber(date: string): number {
  return Math.floor(Date.parse(`${date.slice(0, 10)}T00:00:00Z`) / DAY_MS);
}

export function strategyBoardOwner(
  goal: Pick<StrategyBoardGoal, "ownerUserId" | "ownerAgentId">,
  names: StrategyBoardKpiInput["ownerNames"],
): StrategyBoardOwner | null {
  if (goal.ownerUserId) return { type: "user", id: goal.ownerUserId, name: names.users.get(goal.ownerUserId) ?? null };
  if (goal.ownerAgentId) return { type: "agent", id: goal.ownerAgentId, name: names.agents.get(goal.ownerAgentId) ?? null };
  return null;
}

/** Nearest ancestors of each kind. Stops on a parent cycle in old data. */
function ancestorsOf(goal: StrategyBoardGoal, byId: ReadonlyMap<string, StrategyBoardGoal>) {
  let area: StrategyBoardGoal | null = null;
  let objective: StrategyBoardGoal | null = null;
  const seen = new Set<string>([goal.id]);
  let current = goal.parentId ? byId.get(goal.parentId) ?? null : null;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (!objective && current.kind === "objective") objective = current;
    if (!area && current.kind && AREA_KINDS.has(current.kind)) area = current;
    current = current.parentId ? byId.get(current.parentId) ?? null : null;
  }
  return { area, objective };
}

/**
 * Every live KPI on the plan, as the board sees it. Cancelled KPIs are left
 * out, and so are draft KPIs (GRE-1161): they are not live until a person accepts them.
 */
export function buildStrategyBoardKpis(input: StrategyBoardKpiInput): StrategyBoardKpi[] {
  const byId = new Map(input.goals.map((goal) => [goal.id, goal]));
  const out: StrategyBoardKpi[] = [];
  for (const goal of input.goals) {
    if (goal.kind !== "kpi" || goal.status === "cancelled" || goal.status === "draft") continue;
    const status = input.statusById.get(goal.id) ?? null;
    const latest = input.latestReadingById.get(goal.id) ?? null;
    const previous = input.snapshotById?.get(goal.id) ?? null;
    const { area, objective } = ancestorsOf(goal, byId);
    const rag = status?.status ?? null;
    const kpi: StrategyBoardKpi = {
      goalId: goal.id,
      title: goal.title,
      unit: goal.unit,
      areaId: area?.id ?? null,
      areaTitle: area?.title ?? null,
      objectiveId: objective?.id ?? null,
      objectiveTitle: objective?.title ?? null,
      owner: strategyBoardOwner(goal, input.ownerNames),
      status: rag,
      reason: status?.reason ?? "no_plan",
      gapPercent: status?.gapPercent ?? null,
      latestValue: status?.latestValue ?? null,
      plannedValue: status?.plannedValue ?? null,
      targetValue: goal.targetValue,
      targetDate: goal.targetDate,
      latestReadingDate: latest?.readingDate ?? null,
      latestReadingSource: latest?.source ?? null,
      readingAgeDays: latest ? Math.max(0, dayNumber(input.today) - dayNumber(latest.readingDate)) : null,
      previousStatus: previous?.status ?? null,
      previousValue: previous?.latestValue ?? null,
      changedSinceSnapshot: input.snapshotById != null && (previous == null || previous.status !== rag),
      openWhyRequests: input.openWhyById.get(goal.id) ?? 0,
      trend: input.trendById?.get(goal.id) ?? [],
    };
    kpi.notMeasuredReason = strategyBoardNotMeasuredReason(kpi);
    out.push(kpi);
  }
  return out;
}

/**
 * The plan objective a goal belongs to: the goal itself when it is an
 * objective, else its nearest objective ancestor. Null when the goal is not
 * under a live objective (GRE-1188: only such tasks carry a due date).
 */
export function findPlanObjective(
  goalId: string | null,
  byId: ReadonlyMap<string, StrategyBoardGoal>,
): StrategyBoardGoal | null {
  const goal = goalId ? byId.get(goalId) ?? null : null;
  if (!goal) return null;
  const objective = goal.kind === "objective" ? goal : ancestorsOf(goal, byId).objective;
  if (!objective || objective.status === "cancelled" || objective.status === "draft") return null;
  return objective;
}

/** A task with a due date, as the board reads it. */
export interface StrategyBoardActionTask {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  goalId: string | null;
  dueDate: string | null;
  assigneeUserId: string | null;
  assigneeAgentId: string | null;
}

const CLOSED_TASK_STATUSES: ReadonlySet<string> = new Set(["done", "cancelled"]);

function ownerSortName(owner: StrategyBoardOwner | null): string {
  return owner ? owner.name ?? "\uffff" : "\uffff\uffff";
}

/**
 * Overdue plan actions (GRE-1188): open tasks under a plan objective whose
 * due date is before `today`. Tasks not under the plan are left out. Ordered
 * by objective in plan order, then owner, then most overdue first.
 */
export function buildStrategyBoardOverdueActions(input: {
  goals: readonly StrategyBoardGoal[];
  tasks: readonly StrategyBoardActionTask[];
  ownerNames: StrategyBoardKpiInput["ownerNames"];
  /** "YYYY-MM-DD" */
  today: string;
}): StrategyBoardAction[] {
  const byId = new Map(input.goals.map((goal) => [goal.id, goal]));
  const planOrder = new Map(input.goals.map((goal, index) => [goal.id, index]));
  const todayDay = dayNumber(input.today);
  const out: StrategyBoardAction[] = [];
  for (const task of input.tasks) {
    if (!task.dueDate || CLOSED_TASK_STATUSES.has(task.status)) continue;
    const daysOverdue = todayDay - dayNumber(task.dueDate);
    if (daysOverdue <= 0) continue;
    const objective = findPlanObjective(task.goalId, byId);
    if (!objective) continue;
    const { area } = ancestorsOf(objective, byId);
    out.push({
      issueId: task.id,
      identifier: task.identifier,
      title: task.title,
      status: task.status,
      dueDate: task.dueDate.slice(0, 10),
      daysOverdue,
      objectiveId: objective.id,
      objectiveTitle: objective.title,
      areaId: area?.id ?? null,
      areaTitle: area?.title ?? null,
      owner: task.assigneeUserId
        ? { type: "user", id: task.assigneeUserId, name: input.ownerNames.users.get(task.assigneeUserId) ?? null }
        : task.assigneeAgentId
          ? { type: "agent", id: task.assigneeAgentId, name: input.ownerNames.agents.get(task.assigneeAgentId) ?? null }
          : null,
    });
  }
  return out.sort((a, b) =>
    (planOrder.get(a.objectiveId) ?? 0) - (planOrder.get(b.objectiveId) ?? 0)
    || ownerSortName(a.owner).localeCompare(ownerSortName(b.owner))
    || b.daysOverdue - a.daysOverdue
    || a.title.localeCompare(b.title));
}

/** How many readings a KPI trend shows. */
export const STRATEGY_BOARD_TREND_POINTS = 6;

/**
 * The words the board reads for a status, everywhere: one vocabulary, never
 * colour names.
 */
export const KPI_STATUS_WORDS: Record<KpiRagStatus, string> = {
  green: "On course",
  amber: "Watch",
  red: "Off course",
};

/**
 * How far the board can trust a KPI's number, apart from its colour
 * (GRE-1134): a green KPI may rest on weak evidence.
 * - strong: checked by an agent or taken from a system, and at most 14 days old
 * - weak: reported by the owner only, or older than 30 days, or no reading
 * - moderate: anything in between
 */
export type BoardAssurance = "strong" | "moderate" | "weak";

export const ASSURANCE_FRESH_DAYS = 14;
export const ASSURANCE_STALE_DAYS = 30;

export function boardAssurance(kpi: Pick<StrategyBoardKpi, "latestReadingSource" | "readingAgeDays">): BoardAssurance {
  if (!kpi.latestReadingSource || kpi.readingAgeDays == null) return "weak";
  if (kpi.readingAgeDays > ASSURANCE_STALE_DAYS) return "weak";
  if (kpi.latestReadingSource === "owner_reported") return "weak";
  return kpi.readingAgeDays <= ASSURANCE_FRESH_DAYS ? "strong" : "moderate";
}

/** On course, but the number behind it is stale or only self-reported. */
export function isOnCourseOnWeakEvidence(kpi: StrategyBoardKpi): boolean {
  return kpi.status === "green" && boardAssurance(kpi) === "weak";
}

const STATUS_WEIGHT: Record<KpiRagStatus, number> = { red: 0, amber: 1, green: 2 };

/**
 * Why a KPI has no status, in words the board reads (GRE-1325): no target, no
 * target date, or no reading yet. Null when the KPI has a status. Read from
 * the KPI's own fields, so it works on packs made before GRE-1325 too.
 */
export function strategyBoardNotMeasuredReason(
  kpi: Pick<StrategyBoardKpi, "status" | "reason" | "targetValue" | "targetDate">,
): string | null {
  if (kpi.status) return null;
  if (kpi.targetValue == null && !kpi.targetDate) return "No target or target date";
  if (kpi.targetValue == null) return "No target";
  if (!kpi.targetDate) return "No target date";
  if (kpi.reason === "no_reading") return "No reading yet";
  return "No status";
}

function isSlipping(kpi: StrategyBoardKpi): boolean {
  return kpi.status === "red" || kpi.status === "amber";
}

/**
 * The board attention queue: red before amber, then the biggest slippage,
 * then a KPI that got worse since the last pack, then by title. After them
 * come the KPIs that are not measured (GRE-1325), by title, so a plan with no
 * targets never reads as "all clear". Last come the green KPIs whose
 * evidence is weak (stale or owner-reported only), by title. Other green
 * KPIs are not in it.
 */
export function rankStrategyBoardAttention(kpis: readonly StrategyBoardKpi[]): StrategyBoardKpi[] {
  const slipping = kpis
    .filter(isSlipping)
    .sort((a, b) =>
      STATUS_WEIGHT[a.status!] - STATUS_WEIGHT[b.status!]
      || (b.gapPercent ?? 0) - (a.gapPercent ?? 0)
      || Number(b.changedSinceSnapshot) - Number(a.changedSinceSnapshot)
      || a.title.localeCompare(b.title));
  const notMeasured = kpis
    .filter((kpi) => kpi.status == null)
    .map((kpi) => ({ ...kpi, notMeasuredReason: strategyBoardNotMeasuredReason(kpi) }))
    .sort((a, b) => a.title.localeCompare(b.title));
  const weakGreen = kpis.filter(isOnCourseOnWeakEvidence).sort((a, b) => a.title.localeCompare(b.title));
  return [...slipping, ...notMeasured, ...weakGreen];
}

/**
 * The "Why?" requests the board reads between meetings: those answered since
 * `since` (the last accepted pack; null = every answer), newest first, and
 * those still open, oldest first. Requests on KPIs no longer on the board are
 * left out.
 */
export function buildStrategyBoardWhyDigest(input: {
  requests: ReadonlyArray<{
    id: string;
    goalId: string;
    question: string;
    status: string;
    answer: string | null;
    ownerUserId: string | null;
    ownerAgentId: string | null;
    createdAt: Date;
    answeredAt: Date | null;
  }>;
  kpis: readonly Pick<StrategyBoardKpi, "goalId" | "title" | "owner">[];
  ownerNames: StrategyBoardKpiInput["ownerNames"];
  since: Date | null;
  now: Date;
}): { answered: StrategyBoardWhyItem[]; open: StrategyBoardWhyItem[] } {
  const kpis = new Map(input.kpis.map((kpi) => [kpi.goalId, kpi]));
  const answered: StrategyBoardWhyItem[] = [];
  const open: StrategyBoardWhyItem[] = [];
  for (const row of input.requests) {
    const kpi = kpis.get(row.goalId);
    if (!kpi) continue;
    const ownerName =
      (row.ownerUserId ? input.ownerNames.users.get(row.ownerUserId) : null)
      ?? (row.ownerAgentId ? input.ownerNames.agents.get(row.ownerAgentId) : null)
      ?? kpi.owner?.name
      ?? null;
    const item: StrategyBoardWhyItem = {
      id: row.id,
      goalId: row.goalId,
      kpiTitle: kpi.title,
      ownerName,
      question: row.question,
      answer: row.answer,
      askedAt: row.createdAt.toISOString(),
      answeredAt: row.answeredAt?.toISOString() ?? null,
      ageDays: Math.max(0, Math.floor((input.now.getTime() - row.createdAt.getTime()) / DAY_MS)),
    };
    if (row.status === "open") open.push(item);
    else if (row.answeredAt && (!input.since || row.answeredAt >= input.since)) answered.push(item);
  }
  answered.sort((a, b) => b.answeredAt!.localeCompare(a.answeredAt!));
  open.sort((a, b) => a.askedAt.localeCompare(b.askedAt));
  return { answered, open };
}

/** Pillars and CSFs with their objectives, in plan order (as created). */
export function buildStrategyBoardAreas(
  goals: readonly (StrategyBoardGoal & { createdAt?: Date | string })[],
  rollup: ReadonlyMap<string, GoalRagRollup>,
  ownerNames: StrategyBoardKpiInput["ownerNames"],
): StrategyBoardArea[] {
  const none: GoalRagRollup = { status: null, red: 0, amber: 0, green: 0, noStatus: 0 };
  const live = goals.filter((goal) => goal.status !== "cancelled");
  return live
    .filter((goal) => goal.kind && AREA_KINDS.has(goal.kind))
    .map((area) => ({
      goalId: area.id,
      title: area.title,
      kind: area.kind as GoalKind,
      rollup: rollup.get(area.id) ?? none,
      objectives: live
        .filter((goal) => goal.kind === "objective" && goal.parentId === area.id)
        .map((objective) => ({
          goalId: objective.id,
          title: objective.title,
          rollup: rollup.get(objective.id) ?? none,
          owner: strategyBoardOwner(objective, ownerNames),
        })),
    }));
}

export function countStrategyBoardKpis(kpis: readonly StrategyBoardKpi[]) {
  const counts = { red: 0, amber: 0, green: 0, noStatus: 0 };
  for (const kpi of kpis) {
    if (kpi.status) counts[kpi.status] += 1;
    else counts.noStatus += 1;
  }
  return counts;
}

/**
 * Slippage alert rule: a KPI that is red with no open red spell opens one
 * (and alerts the chair once). A KPI that is no longer red closes its open
 * spell. Anything else does nothing, so the same red state never alerts twice.
 */
export function kpiAlertAction(status: KpiRagStatus | null, hasOpenAlert: boolean): "open" | "clear" | "none" {
  if (status === "red") return hasOpenAlert ? "none" : "open";
  return hasOpenAlert ? "clear" : "none";
}

function ragWord(status: KpiRagStatus | null): string {
  return status ? KPI_STATUS_WORDS[status] : "No status";
}

function countWords(r: { red: number; amber: number; green: number }): string {
  return `${r.red} off course, ${r.amber} watch, ${r.green} on course`;
}

function num(value: number | null, unit: string | null): string {
  if (value == null) return "n/a";
  const rounded = Math.round(value * 100) / 100;
  return unit ? `${rounded} ${unit}` : String(rounded);
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function ownerName(owner: StrategyBoardOwner | null): string {
  if (!owner) return "No owner";
  return owner.name ?? (owner.type === "agent" ? "An agent" : "A person");
}

function sourceLabel(source: KpiReadingSource | null): string {
  return source ? KPI_READING_SOURCE_LABELS[source] : "No reading";
}

/**
 * The board pack as a Markdown document: status by area, slippages, owner
 * explanations, and the readings with their source, so the board can tell a
 * checked number from a self-reported one.
 */
export function renderStrategyBoardPackMarkdown(pack: StrategyBoardPackSnapshot): string {
  const lines: string[] = [];
  const { counts } = pack;
  lines.push(`# ${pack.title}`, "");
  lines.push(`${pack.companyName} · ${pack.periodStart} to ${pack.periodEnd} · status as of ${pack.asOf}`, "");
  lines.push(
    `**KPIs:** ${countWords(counts)}, ${counts.noStatus} with no status.`,
    "",
  );

  lines.push("## Status by area", "");
  if (pack.areas.length === 0) {
    lines.push("No pillars or critical success factors on the plan.", "");
  } else {
    lines.push("| Area | Status | KPIs |", "| --- | --- | --- |");
    for (const area of pack.areas) {
      const r = area.rollup;
      lines.push(`| ${cell(`${area.title} (${GOAL_KIND_LABELS[area.kind]})`)} | ${ragWord(r.status)} | ${countWords(r)} |`);
      for (const objective of area.objectives) {
        lines.push(`| ${cell(`↳ ${objective.title}`)} | ${ragWord(objective.rollup.status)} | ${cell(ownerName(objective.owner))} |`);
      }
    }
    lines.push("");
  }

  const attention = rankStrategyBoardAttention(pack.kpis);
  const slippages = attention.filter(isSlipping);
  const notMeasured = attention.filter((kpi) => kpi.status == null);
  lines.push("## Slippages", "");
  if (slippages.length === 0) {
    lines.push("No KPI is off course or on watch.", "");
  } else {
    lines.push("| KPI | Status | Behind plan | Latest | Plan | Source | Owner |", "| --- | --- | --- | --- | --- | --- | --- |");
    for (const kpi of slippages) {
      const age = kpi.readingAgeDays != null ? ` (${kpi.readingAgeDays} days old)` : "";
      lines.push(
        `| ${cell(kpi.title)} | ${ragWord(kpi.status)} | ${kpi.gapPercent ?? 0}% | ${num(kpi.latestValue, kpi.unit)} | ${num(kpi.plannedValue, kpi.unit)} | ${sourceLabel(kpi.latestReadingSource)}${age} | ${cell(ownerName(kpi.owner))} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Not measured", "");
  if (notMeasured.length === 0) {
    lines.push("Every KPI has a target, a target date and a reading.", "");
  } else {
    lines.push(
      `${notMeasured.length} of ${pack.kpis.length} KPIs cannot be judged on course or off course.`,
      "",
      "| KPI | Reason | Owner |",
      "| --- | --- | --- |",
    );
    for (const kpi of notMeasured) {
      lines.push(`| ${cell(kpi.title)} | ${kpi.notMeasuredReason ?? "No status"} | ${cell(ownerName(kpi.owner))} |`);
    }
    lines.push("");
  }

  // Packs made before GRE-1188 have no overdue actions recorded.
  if (pack.overdueActions) {
    lines.push("## Overdue actions", "");
    if (pack.overdueActions.length === 0) {
      lines.push("No plan action is past its due date.", "");
    } else {
      lines.push("| Objective | Owner | Action | Due | Days overdue |", "| --- | --- | --- | --- | --- |");
      for (const action of pack.overdueActions) {
        const label = action.identifier ? `${action.identifier} ${action.title}` : action.title;
        lines.push(
          `| ${cell(action.objectiveTitle)} | ${cell(ownerName(action.owner))} | ${cell(label)} | ${action.dueDate} | ${action.daysOverdue} |`,
        );
      }
      lines.push("");
    }
  }

  lines.push("## Owner explanations", "");
  if (pack.whyRequests.length === 0) {
    lines.push("No \"Why?\" requests in this period.", "");
  } else {
    const titles = new Map(pack.kpis.map((kpi) => [kpi.goalId, kpi.title]));
    for (const request of pack.whyRequests) {
      lines.push(`**${titles.get(request.goalId) ?? "KPI"}** (asked ${request.askedAt.slice(0, 10)}): ${request.question}`, "");
      if (request.answer) {
        lines.push(`> ${request.answer.replace(/\r?\n/g, "\n> ")}`, "");
        lines.push(`Answered by ${request.ownerName ?? "the owner"}, ${request.answeredAt?.slice(0, 10) ?? ""}`, "");
      } else {
        lines.push(`_No answer yet from ${request.ownerName ?? "the owner"}._`, "");
      }
    }
  }

  lines.push("## Readings in the period", "");
  if (pack.readings.length === 0) {
    lines.push("No readings dated in this period.", "");
  } else {
    const verified = pack.readings.filter((r) => r.source !== "owner_reported").length;
    lines.push(
      `${pack.readings.length} readings: ${verified} checked by an agent or taken from a system, ${pack.readings.length - verified} reported by the owner.`,
      "",
    );
    const byId = new Map(pack.kpis.map((kpi) => [kpi.goalId, kpi]));
    lines.push("| KPI | Date | Value | Source | Note |", "| --- | --- | --- | --- | --- |");
    for (const reading of pack.readings) {
      const kpi = byId.get(reading.goalId);
      lines.push(
        `| ${cell(kpi?.title ?? "KPI")} | ${reading.readingDate} | ${num(reading.value, kpi?.unit ?? null)} | ${sourceLabel(reading.source)} | ${cell(reading.note ?? "")} |`,
      );
    }
    lines.push("");
  }

  lines.push("---", "", "This pack is a frozen record of what the board saw. Later corrections are new readings; they do not change this pack.", "");
  return lines.join("\n");
}

/**
 * How far the board can trust a number, in the words the board agent uses
 * (GRE-1186): a reading the owner typed in is weaker than one an agent
 * checked or one taken from a system.
 */
export function boardEvidenceTrust(source: KpiReadingSource | null): "owner-reported" | "agent-checked" | "system" | "no reading" {
  if (source === "owner_reported") return "owner-reported";
  if (source === "agent_verified") return "agent-checked";
  if (source === "system") return "system";
  return "no reading";
}

function ageWords(days: number | null): string {
  if (days == null) return "no reading";
  if (days === 0) return "taken today";
  return days === 1 ? "1 day old" : `${days} days old`;
}

function oneLine(text: string, max = 400): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The plan as the board agent sees it (GRE-1186). Every KPI line carries its
 * reading source, date and age, so each answer can say where a number comes
 * from and how far to trust it. Plain text: it goes into the agent's prompt.
 */
export function renderStrategyBoardBrief(brief: StrategyBoardBrief): string {
  const lines: string[] = [];
  lines.push(`Plan of ${brief.companyName}, status as of ${brief.asOf}.`, "");
  const titles = new Map(brief.kpis.map((kpi) => [kpi.goalId, kpi.title]));
  lines.push("KPIs:");
  if (brief.kpis.length === 0) lines.push("- None on the plan.");
  for (const kpi of brief.kpis) {
    const where = [kpi.areaTitle, kpi.objectiveTitle].filter(Boolean).join(" > ");
    const reading = kpi.latestReadingDate
      ? `latest ${num(kpi.latestValue, kpi.unit)} on ${kpi.latestReadingDate} (source: ${boardEvidenceTrust(kpi.latestReadingSource)}; age: ${ageWords(kpi.readingAgeDays)})`
      : "no reading yet (source: no reading; age: no reading)";
    lines.push(
      `- KPI "${kpi.title}" [id ${kpi.goalId}]${where ? ` under ${where}` : ""}: ${ragWord(kpi.status)}` +
        `${kpi.gapPercent ? `, ${kpi.gapPercent}% behind plan` : ""}; ${reading}; plan today ${num(kpi.plannedValue, kpi.unit)}; ` +
        `target ${num(kpi.targetValue, kpi.unit)}${kpi.targetDate ? ` due ${kpi.targetDate}` : ""}; owner ${ownerName(kpi.owner)}` +
        `${kpi.openWhyRequests ? `; ${kpi.openWhyRequests} open "Why?" request${kpi.openWhyRequests === 1 ? "" : "s"}` : ""}.`,
    );
  }
  lines.push("", "Open actions (tasks under plan goals):");
  if (brief.actions.length === 0) lines.push("- None.");
  for (const action of brief.actions) {
    const goal = titles.get(action.goalId);
    lines.push(
      `- Task ${action.identifier ?? "(no id)"} "${oneLine(action.title, 200)}": ${action.status}; assignee ${action.assigneeName ?? "nobody"}${goal ? `; for KPI "${goal}"` : ""}.`,
    );
  }
  lines.push("", "Latest check-ins:");
  if (brief.checkIns.length === 0) lines.push("- None.");
  for (const checkIn of brief.checkIns) {
    const goal = titles.get(checkIn.goalId);
    lines.push(
      `- ${checkIn.date} by ${checkIn.authorName ?? "someone"}${goal ? ` on KPI "${goal}"` : ""}${checkIn.progressPercent != null ? ` (${checkIn.progressPercent}% done)` : ""}: ${oneLine(checkIn.body)}`,
    );
  }
  lines.push("", "\"Why?\" requests and answers:");
  if (brief.whyRequests.length === 0) lines.push("- None.");
  for (const request of brief.whyRequests) {
    lines.push(
      `- On KPI "${titles.get(request.goalId) ?? "a KPI"}", asked ${request.askedAt}: ${oneLine(request.question, 200)} → ` +
        (request.answer ? `answer: ${oneLine(request.answer)}` : `no answer yet (${request.status})`),
    );
  }
  return lines.join("\n");
}
