import type { GoalWithProgress } from "@greatstone/shared";
import { GOAL_HEALTH_LABEL, formatTargetDate, type GoalHealth, type ScoreboardEntry } from "./goal-journey";
import { formatCalendarDay } from "./utils";

export interface GoalsTextLookups {
  agentName: (id: string) => string | null | undefined;
  userName: (id: string) => string | null | undefined;
}

function goalLine(goal: GoalWithProgress, health: GoalHealth, lookups: GoalsTextLookups): string {
  const { progress } = goal;
  const owner = goal.ownerAgentId
    ? lookups.agentName(goal.ownerAgentId)
    : goal.ownerUserId
      ? lookups.userName(goal.ownerUserId)
      : null;
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
