import type { TeamScorecard, TeamScorecardAgent } from "@greatstone/shared";
import { csvCell } from "./issues-csv";

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

/** The comment "Ask for an update" posts on a stuck task. It wakes the agent. */
export const STUCK_TASK_UPDATE_REQUEST =
  "Quick check-in from the Scorecard: this task shows as stuck. Please reply here in plain words: what is blocking it, and what do you need from me to move it forward?";

export const SCORECARD_CSV_HEADERS = [
  "Agent",
  "Role",
  "Finished",
  "Under way",
  "Waiting for review",
  "Stuck",
  "Past due date",
  "Work value (USD)",
] as const;

/**
 * "Download as spreadsheet" on the Scorecard: one row per agent, with the
 * work value in whole dollars when it is known.
 */
export function scorecardToCsv(scorecard: TeamScorecard, workCents: (agentId: string) => number | null | undefined): string {
  const rows = scorecard.agents.map((agent) => {
    const cents = workCents(agent.agentId);
    return [
      agent.name,
      agent.title ?? "",
      String(agent.finished),
      String(agent.underWay),
      String(agent.inReview),
      String(agent.stuck),
      String(agent.overdue),
      cents != null && cents > 0 ? String(Math.round(cents / 100)) : "",
    ];
  });
  // The byte order mark makes Excel read the file as UTF-8, so names keep their accents.
  return `﻿${[SCORECARD_CSV_HEADERS as readonly string[], ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

/** "gre-scorecard-7-days-2026-10-16.csv" */
export function scorecardCsvFileName(prefix: string | null | undefined, days: number, today: string): string {
  const slug = (prefix ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${slug ? `${slug}-` : ""}scorecard-${days}-days-${today}.csv`;
}
