import type { AgentDailyDigestAgent, WeeklyReport, WeeklyReportDay, WeeklyReportPipelineMove, WeeklyReportTask } from "@greatstone/shared";
import { buildPdf, type PdfLine } from "./simple-pdf";
import { formatCents, formatShortDate } from "./utils";

const DAY_MS = 24 * 60 * 60 * 1000;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** "13 Oct to 19 Oct". */
export function weekRangeLabel(report: Pick<WeeklyReport, "since" | "generatedAt">): string {
  return `${formatShortDate(report.since)} to ${formatShortDate(report.generatedAt)}`;
}

/** Whole days since `since`, never below zero. */
export function daysSince(since: string, now: Date | string): number {
  return Math.max(0, Math.floor((new Date(now).getTime() - new Date(since).getTime()) / DAY_MS));
}

/** "stuck for 4 days", "stuck since today". */
export function stuckForLabel(stuckSince: string, now: Date | string): string {
  const days = daysSince(stuckSince, now);
  return days === 0 ? "stuck since today" : `stuck for ${plural(days, "day", "days")}`;
}

export function taskLabel(task: WeeklyReportTask): string {
  return task.identifier ? `${task.identifier} ${task.title}` : task.title;
}

/** "Acme: Proposal to Won (Client journey)". */
export function moveLabel(move: WeeklyReportPipelineMove): string {
  const stages = move.fromStage ? `${move.fromStage} to ${move.toStage}` : `now ${move.toStage}`;
  return `${move.title}: ${stages} (${move.pipelineName})`;
}

/** One line on the pipeline: "2 new, 3 moves, 1 won." */
export function pipelineSummary(pipeline: WeeklyReport["pipeline"]): string {
  if (pipeline.added === 0 && pipeline.moved === 0) return "No changes in the client pipeline this week.";
  const parts = [`${pipeline.added} new`, plural(pipeline.moved, "move", "moves")];
  if (pipeline.won > 0) parts.push(`${pipeline.won} won`);
  if (pipeline.lost > 0) parts.push(`${pipeline.lost} lost`);
  return `${parts.join(", ")}.`;
}

/** The week in a few plain sentences, for the top of the page and the PDF. */
export function weeklyHeadline(report: WeeklyReport): string {
  const sentences: string[] = [];
  sentences.push(
    report.finished.count === 0
      ? "No tasks were finished this week."
      : `The agents finished ${plural(report.finished.count, "task", "tasks")}.`,
  );
  const longest = report.stuck.items[0];
  sentences.push(
    report.stuck.count === 0
      ? "Nothing is stuck."
      : `${plural(report.stuck.count, "task is", "tasks are")} stuck${
          longest ? `, the longest for ${plural(daysSince(longest.stuckSince, report.generatedAt), "day", "days")}` : ""
        }.`,
  );
  if (report.pipeline.added > 0 || report.pipeline.moved > 0) {
    sentences.push(`Client pipeline: ${pipelineSummary(report.pipeline)}`);
  }
  sentences.push(
    report.needsYou.count === 0
      ? "Nothing needs you."
      : `${plural(report.needsYou.count, "thing needs", "things need")} you.`,
  );
  if (report.costs.totalCents > 0) sentences.push(`Recorded spend was ${formatCents(report.costs.totalCents)}.`);
  return sentences.join(" ");
}

/** "15 Oct: 4 finished, 2 moved, 7 comments, 12 runs (1 failed), $3.20. Busiest: Ada." */
export function dailyDigestLine(day: WeeklyReportDay): string {
  const runs = day.failures > 0
    ? `${plural(day.runs, "run", "runs")} (${day.failures} failed)`
    : plural(day.runs, "run", "runs");
  const busiest = day.busiestAgent ? ` Busiest: ${day.busiestAgent}.` : "";
  return `${formatShortDate(`${day.date}T12:00:00Z`)}: ${day.tasksCompleted} finished, ${day.tasksMoved} moved, ${plural(day.comments, "comment", "comments")}, ${runs}, ${formatCents(day.spendCents)}.${busiest}`;
}

/** "Ada: 2 finished, 1 moved, 3 comments, 5 runs (1 failed), $2.50." */
export function dailyDigestAgentLine(agent: AgentDailyDigestAgent): string {
  const { counts } = agent;
  const runs = counts.failures > 0
    ? `${plural(counts.runs, "run", "runs")} (${counts.failures} failed)`
    : plural(counts.runs, "run", "runs");
  return `${agent.name}: ${counts.tasksCompleted} finished, ${counts.tasksMoved} moved, ${plural(counts.comments, "comment", "comments")}, ${runs}, ${formatCents(counts.spendCents)}.`;
}

export interface WeeklyReportSection {
  title: string;
  lines: string[];
}

/** The report as titled sections of plain lines: the PDF and the copied text use this. */
export function weeklyReportSections(report: WeeklyReport): WeeklyReportSection[] {
  const more = (shown: number, total: number) => (total > shown ? [`and ${total - shown} more`] : []);
  const days: WeeklyReportSection[] = (report.daily ?? []).length > 0
    ? [{ title: "Day by day", lines: report.daily.map(dailyDigestLine) }]
    : [];
  return [
    {
      title: "Needs you",
      lines: report.needsYou.count === 0
        ? ["Nothing needs you right now."]
        : [...report.needsYou.items.map(taskLabel), ...more(report.needsYou.items.length, report.needsYou.count)],
    },
    {
      title: "What the agents finished",
      lines: report.finished.agents.length === 0
        ? ["No tasks were finished this week."]
        : report.finished.agents.flatMap((agent) => [
            `${agent.name}: ${plural(agent.finished, "task", "tasks")}`,
            ...agent.items.map((task) => `  ${taskLabel(task)}`),
          ]),
    },
    {
      title: "What is stuck",
      lines: report.stuck.count === 0
        ? ["Nothing is stuck."]
        : [
            ...report.stuck.items.map(
              (task) => `${taskLabel(task)}, ${stuckForLabel(task.stuckSince, report.generatedAt)}${task.agentName ? ` (${task.agentName})` : ""}`,
            ),
            ...more(report.stuck.items.length, report.stuck.count),
          ],
    },
    {
      title: "Client pipeline",
      lines: [pipelineSummary(report.pipeline), ...report.pipeline.moves.map(moveLabel)],
    },
    {
      title: "Cost by agent",
      lines: report.costs.agents.length === 0
        ? ["No spend was recorded this week."]
        : [
            ...report.costs.agents.map((agent) => `${agent.name}: ${formatCents(agent.cents)}`),
            `Total: ${formatCents(report.costs.totalCents)}`,
          ],
    },
    ...days,
  ];
}

/** "this-week-at-greatstone-2026-10-19.pdf". */
export function weeklyReportFileName(report: Pick<WeeklyReport, "companyName" | "generatedAt">): string {
  const slug = (report.companyName || "company").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "company";
  return `this-week-at-${slug}-${report.generatedAt.slice(0, 10)}.pdf`;
}

/** The report as a one-page PDF (a second page only when the week was very busy). */
export function weeklyReportPdf(report: WeeklyReport): string {
  const title = `This week at ${report.companyName || "the company"}`;
  const lines: PdfLine[] = [
    { text: title, size: 20, bold: true },
    { text: weekRangeLabel(report), size: 10, muted: true, gapBefore: 2 },
    { text: weeklyHeadline(report), size: 11.5, gapBefore: 12 },
  ];
  for (const section of weeklyReportSections(report)) {
    lines.push({ text: section.title, size: 13, bold: true, gapBefore: 14 });
    section.lines.forEach((line, index) => {
      const nested = line.startsWith("  ");
      lines.push({ text: nested ? line.trim() : line, size: 10.5, indent: nested ? 14 : 0, muted: nested, gapBefore: index === 0 ? 3 : 0 });
    });
  }
  lines.push({ text: `Made by GS Agentic Manager on ${formatShortDate(report.generatedAt)}.`, size: 8.5, muted: true, gapBefore: 18 });
  return buildPdf(lines, title);
}

/** "A, B and 2 more." from titles, for reading aloud. */
function spokenTitles(titles: string[], total: number): string {
  const parts = [...titles];
  if (total > titles.length) parts.push(`${total - titles.length} more`);
  return parts.length <= 1 ? `${parts[0] ?? ""}.` : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}.`;
}

/**
 * "Listen" on This week: the report as a few spoken parts. The headline
 * carries the numbers; then what needs you, who finished what and what is
 * stuck, by name. Task numbers are left out because they sound like noise.
 */
export function weeklyReportSpeech(report: WeeklyReport): string[] {
  const parts = [`This week at ${report.companyName || "the company"}.`, weeklyHeadline(report)];
  if (report.needsYou.count > 0) {
    parts.push(`Needs you: ${spokenTitles(report.needsYou.items.map((task) => task.title), report.needsYou.count)}`);
  }
  if (report.finished.agents.length > 0) {
    const top = report.finished.agents.slice(0, 3).map((agent) => `${agent.name} finished ${plural(agent.finished, "task", "tasks")}`);
    const rest = report.finished.agents.length - top.length;
    parts.push(`${top.join(", ")}${rest > 0 ? `, and ${plural(rest, "other agent", "other agents")} finished work too` : ""}.`);
  }
  if (report.stuck.count > 0) {
    parts.push(`Stuck: ${spokenTitles(report.stuck.items.slice(0, 3).map((task) => task.title), report.stuck.count)}`);
  }
  return parts;
}
