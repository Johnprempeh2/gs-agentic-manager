import type { MorningSummary, MorningSummaryTask } from "@greatstone/shared";
import { formatCalendarDay } from "./utils";

/**
 * "Copy as an update" on Today: the four sections as plain text, so the day
 * can be pasted into a message to a partner or an assistant.
 *
 *   Today, 16 Oct
 *
 *   Needs me (2)
 *   • GRE-12 Approve the hire
 */
export function morningSummaryText(
  summary: Pick<MorningSummary, "needsYou" | "finished" | "stuck"> & { dueToday?: MorningSummary["dueToday"] },
  today: string,
): string {
  const lines = [`Today, ${formatCalendarDay(today)}`];
  const section = (title: string, part: { count: number; items: MorningSummaryTask[] } | undefined, empty: string) => {
    const count = part?.count ?? 0;
    lines.push("", count > 0 ? `${title} (${count})` : `${title}: ${empty}`);
    for (const item of part?.items ?? []) {
      const late = item.dueDate && item.dueDate < today ? `, late, due ${formatCalendarDay(item.dueDate)}` : "";
      lines.push(`• ${item.identifier ? `${item.identifier} ` : ""}${item.title}${late}`);
    }
    if (part && count > part.items.length) lines.push(`• and ${count - part.items.length} more`);
  };
  section("Needs me", summary.needsYou, "nothing");
  section("Due today", summary.dueToday, "nothing");
  section("Finished since yesterday", summary.finished, "nothing yet");
  section("Stuck", summary.stuck, "nothing");
  return lines.join("\n");
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Approve the brief, Pick a date and 3 more." */
function spokenList(part: { count: number; items: MorningSummaryTask[] }, today?: string): string {
  const titles = part.items.map((item) => (today && item.dueDate && item.dueDate < today ? `${item.title}, which is late` : item.title));
  const rest = part.count - part.items.length;
  if (rest > 0) titles.push(`${rest} more`);
  if (titles.length <= 1) return `${titles[0] ?? ""}.`;
  return `${titles.slice(0, -1).join(", ")} and ${titles[titles.length - 1]}.`;
}

/**
 * "Listen" on Today: the day as sentences to read aloud, one part per
 * section, in the order the page shows them. Task numbers are left out
 * because they sound like noise.
 */
export function morningSummarySpeech(summary: MorningSummary, today: string, greeting: string): string[] {
  const needs = summary.needsYou.count;
  const parts = [`${greeting}. ${needs === 0 ? "Nothing needs you right now." : `${count(needs, "thing needs", "things need")} you.`}`];
  if (needs > 0) parts.push(`Needs you: ${spokenList(summary.needsYou)}`);
  if (summary.dueToday?.count) parts.push(`Due today: ${spokenList(summary.dueToday, today)}`);
  if (summary.dealNextSteps?.count) parts.push(`Deal next steps due: ${spokenList(summary.dealNextSteps, today)}`);
  if (summary.workingNow?.count) parts.push(`Working now: ${spokenList(summary.workingNow)}`);
  parts.push(
    summary.finished.count === 0
      ? "No tasks finished since yesterday."
      : `${count(summary.finished.count, "task", "tasks")} finished since yesterday: ${spokenList(summary.finished)}`,
  );
  const deals = summary.deals;
  if (deals && deals.won + deals.lost > 0) {
    const won = deals.items.filter((deal) => deal.outcome === "won").map((deal) => deal.title);
    const tally = [deals.won > 0 ? count(deals.won, "deal", "deals") + " won" : "", deals.lost > 0 ? count(deals.lost, "deal", "deals") + " lost" : ""]
      .filter(Boolean)
      .join(" and ");
    parts.push(`${tally} since yesterday.${won.length > 0 ? ` Won: ${won.join(", ")}.` : ""}`);
  }
  parts.push(summary.stuck.count === 0 ? "Nothing is stuck." : `Stuck: ${spokenList(summary.stuck)}`);
  return parts;
}
