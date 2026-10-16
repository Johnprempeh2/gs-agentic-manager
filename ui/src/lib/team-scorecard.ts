import type { TeamScorecardAgent } from "@greatstone/shared";

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
