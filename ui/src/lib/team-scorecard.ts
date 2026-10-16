import type { TeamScorecard, TeamScorecardAgent } from "@greatstone/shared";

function count(value: number, one: string, many: string) {
  return `${value} ${value === 1 ? one : many}`;
}

/**
 * One plain sentence about an agent's period:
 * "Finished 5 tasks. 2 under way, 1 waiting for your review. 1 stuck."
 */
export function scorecardSentence(agent: TeamScorecardAgent, days: number): string {
  const period = days === 7 ? "this week" : `in the last ${days} days`;
  const parts: string[] = [];
  parts.push(agent.finished === 0 ? `Finished nothing ${period}.` : `Finished ${count(agent.finished, "task", "tasks")} ${period}.`);
  const now: string[] = [];
  if (agent.underWay) now.push(`${agent.underWay} under way`);
  if (agent.inReview) now.push(`${agent.inReview} waiting for review`);
  if (now.length) parts.push(`${now.join(", ")}.`);
  if (agent.stuck) parts.push(`${count(agent.stuck, "task is", "tasks are")} stuck.`);
  if (agent.overdue) parts.push(`${count(agent.overdue, "task is", "tasks are")} past the due date.`);
  if (!agent.underWay && !agent.inReview && !agent.stuck && agent.finished === 0) parts.push("Nothing assigned right now.");
  return parts.join(" ");
}

/** Whole dollars, as the Agents page shows work value. */
export function workValueLabel(cents: number): string {
  return `$${Math.round(cents / 100)}`;
}

function taskLine(task: TeamScorecard["agents"][number]["recentlyFinished"][number]): string {
  return task.identifier ? `${task.identifier} ${task.title}` : task.title;
}

/**
 * The scorecard as a short plain-text update to paste into an email or chat:
 * totals first, then one line per agent with what it finished and what is stuck.
 */
export function scorecardUpdateText(scorecard: TeamScorecard, organisationName?: string | null): string {
  const period = scorecard.days === 7 ? "the last 7 days" : `the last ${scorecard.days} days`;
  const { totals } = scorecard;
  const lines = [`${organisationName ? `${organisationName} team` : "Team"} update for ${period}`, ""];
  const summary = [`Finished ${count(totals.finished, "task", "tasks")}.`];
  const now: string[] = [];
  if (totals.underWay) now.push(`${totals.underWay} under way`);
  if (totals.inReview) now.push(`${totals.inReview} waiting for review`);
  if (totals.stuck) now.push(`${totals.stuck} stuck`);
  if (totals.overdue) now.push(`${totals.overdue} past the due date`);
  if (now.length) summary.push(`${now.join(", ")}.`);
  lines.push(summary.join(" "));
  for (const agent of scorecard.agents) {
    lines.push("", `${agent.name}${agent.title ? ` (${agent.title})` : ""}: ${scorecardSentence(agent, scorecard.days)}`);
    for (const task of agent.recentlyFinished) lines.push(`  - Finished: ${taskLine(task)}`);
    for (const task of agent.stuckTasks) lines.push(`  - Stuck: ${taskLine(task)}`);
  }
  return lines.join("\n");
}
