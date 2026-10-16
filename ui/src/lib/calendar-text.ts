import type { CalendarItem } from "@greatstone/shared";
import { addDays, dayTitle, groupByDate, routineTimesLabel } from "./calendar";
import { eventTitle } from "./calendar-ics";

function itemLine(item: CalendarItem, timeZone: string | undefined): string {
  const who = item.agentName ? ` (${item.agentName})` : "";
  if (item.kind === "routine") return `• ${item.title}: ${routineTimesLabel(item, timeZone).toLowerCase()}${who}`;
  return `• ${eventTitle(item)}${who}`;
}

/**
 * "Copy the week ahead" on the Calendar: open work for the next `days` days as
 * plain text, one heading per day, ready to paste into an email or a chat.
 */
export function weekAheadText(
  items: readonly CalendarItem[],
  options: { from: string; days?: number; timeZone?: string },
): string {
  const days = options.days ?? 7;
  const to = addDays(options.from, days - 1);
  const open = items.filter((item) => !item.closed && item.date >= options.from && item.date <= to);
  const header = `The week ahead, ${dayTitle(options.from)} to ${dayTitle(to)}`;
  if (open.length === 0) return `${header}\n\nNothing is scheduled.`;
  const sections = [...groupByDate(open).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, dayItems]) => [dayTitle(date), ...dayItems.map((item) => itemLine(item, options.timeZone))].join("\n"));
  return [header, ...sections].join("\n\n");
}
