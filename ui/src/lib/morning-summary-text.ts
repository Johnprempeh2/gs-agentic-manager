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
