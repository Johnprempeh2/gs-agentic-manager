import type { GoalWithProgress } from "@greatstone/shared";
import { GOAL_HEALTH_LABEL, formatTargetDate, type GoalHealth, type ScoreboardEntry } from "./goal-journey";
import { csvCell } from "./issues-csv";
import { formatCalendarDay } from "./utils";

export interface GoalsTextLookups {
  agentName: (id: string) => string | null | undefined;
  userName: (id: string) => string | null | undefined;
}

function ownerName(goal: GoalWithProgress, lookups: GoalsTextLookups): string | null {
  if (goal.ownerAgentId) return lookups.agentName(goal.ownerAgentId) ?? null;
  if (goal.ownerUserId) return lookups.userName(goal.ownerUserId) ?? null;
  return null;
}

function goalLine(goal: GoalWithProgress, health: GoalHealth, lookups: GoalsTextLookups): string {
  const { progress } = goal;
  const owner = ownerName(goal, lookups);
  const details = [
    GOAL_HEALTH_LABEL[health],
    progress.percent != null ? `${Math.round(progress.percent)}%` : null,
    progress.total > 0 ? `${progress.done} of ${progress.total} tasks done` : null,
    progress.blocked > 0 ? `${progress.blocked} blocked` : null,
    goal.targetDate && formatTargetDate(goal.targetDate) ? `due ${formatTargetDate(goal.targetDate)}` : null,
    owner || null,
  ].filter(Boolean);
  return `${goal.title}: ${details.join(", ")}`;
}

/**
 * "Copy as an update" on Goals: every goal on the scoreboard as plain lines,
 * worst first, ready to paste into an email or a board pack.
 *
 *   Goals update, 16 Oct
 *
 *   • Win three new clients: At risk, 40%, 4 of 10 tasks done, 1 blocked, due 31 Dec, Ridge
 *     ◦ Send the proposals: On track, 60%, 3 of 5 tasks done
 */
export function goalsUpdateText(
  entries: readonly ScoreboardEntry[],
  lookups: GoalsTextLookups,
  today: string,
): string {
  const header = `Goals update, ${formatCalendarDay(today)}`;
  if (entries.length === 0) return `${header}\n\nNo goals are open.`;
  const lines = entries.flatMap((entry) => [
    `• ${goalLine(entry.goal, entry.health, lookups)}`,
    ...entry.subGoals.map((sub) => `  ◦ ${goalLine(sub.goal, sub.health, lookups)}`),
  ]);
  return [header, "", ...lines].join("\n");
}

export const GOALS_CSV_HEADERS = [
  "Goal",
  "Part of",
  "Health",
  "Progress (%)",
  "Tasks done",
  "Tasks in total",
  "Blocked",
  "Due date",
  "Owner",
] as const;

function goalRow(goal: GoalWithProgress, health: GoalHealth, parentTitle: string, lookups: GoalsTextLookups): string[] {
  const { progress } = goal;
  return [
    goal.title,
    parentTitle,
    GOAL_HEALTH_LABEL[health],
    progress.percent != null ? String(Math.round(progress.percent)) : "",
    String(progress.done),
    String(progress.total),
    String(progress.blocked),
    goal.targetDate ? String(goal.targetDate).slice(0, 10) : "",
    ownerName(goal, lookups) ?? "",
  ];
}

/**
 * "Download as spreadsheet" on Goals: one row per goal in scoreboard order,
 * each sub-goal right under its goal with the goal's title in "Part of".
 */
export function goalsToCsv(entries: readonly ScoreboardEntry[], lookups: GoalsTextLookups): string {
  const rows = entries.flatMap((entry) => [
    goalRow(entry.goal, entry.health, "", lookups),
    ...entry.subGoals.map((sub) => goalRow(sub.goal, sub.health, entry.goal.title, lookups)),
  ]);
  // The byte order mark makes Excel read the file as UTF-8, so names keep their accents.
  return `\uFEFF${[GOALS_CSV_HEADERS as readonly string[], ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

/** "gre-goals-2026-10-16.csv" */
export function goalsCsvFileName(prefix: string | null | undefined, today: string): string {
  const slug = (prefix ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${slug ? `${slug}-` : ""}goals-${today}.csv`;
}
