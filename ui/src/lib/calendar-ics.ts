import type { CalendarItem } from "@greatstone/shared";
import { CALENDAR_KIND_LABELS, addDays, routineTimesLabel } from "./calendar";

/**
 * An iCalendar (.ics) file of calendar items, for Outlook, Google Calendar and
 * Apple Calendar. Every item is an all-day event on its date; routine run
 * times go in the description. Closed tasks and goals are left out.
 */

/** Escape text for an iCalendar TEXT value (RFC 5545, section 3.3.11). */
export function icsText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Fold a content line to 75 octets, continuing with a leading space (RFC 5545, section 3.1). */
export function foldIcsLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  let size = 0;
  for (const char of line) {
    const charSize = encoder.encode(char).length;
    const limit = parts.length === 0 ? 75 : 74;
    if (size + charSize > limit) {
      parts.push(current);
      current = "";
      size = 0;
    }
    current += char;
    size += charSize;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

function icsDate(date: string): string {
  return date.replace(/-/g, "");
}

function icsStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export function eventTitle(item: CalendarItem): string {
  if (item.kind === "task") return `Due: ${item.identifier ? `${item.identifier} ` : ""}${item.title}`;
  if (item.kind === "goal") return `Goal date: ${item.title}`;
  return `Routine: ${item.title}`;
}

function eventDescription(item: CalendarItem): string {
  const lines = [item.kind === "routine" ? routineTimesLabel(item) : CALENDAR_KIND_LABELS[item.kind]];
  if (item.agentName) lines.push(`Owner: ${item.agentName}`);
  if (item.goalTitle) lines.push(`Goal: ${item.goalTitle}`);
  return lines.join("\n");
}

export interface CalendarIcsOptions {
  /** Organisation name for the calendar title. */
  calendarName: string;
  /** Absolute link that opens the item in the app. */
  itemUrl: (item: CalendarItem) => string;
  now?: Date;
}

export function calendarToIcs(items: readonly CalendarItem[], options: CalendarIcsOptions): string {
  const stamp = icsStamp(options.now ?? new Date());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Greatstone//GS Agentic Manager//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsText(options.calendarName)}`,
  ];
  for (const item of items) {
    if (item.closed) continue;
    const url = options.itemUrl(item);
    lines.push(
      "BEGIN:VEVENT",
      `UID:${item.kind}-${item.id}-${icsDate(item.date)}@gs-agentic-manager`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${icsDate(item.date)}`,
      `DTEND;VALUE=DATE:${icsDate(addDays(item.date, 1))}`,
      `SUMMARY:${icsText(eventTitle(item))}`,
      `DESCRIPTION:${icsText(`${eventDescription(item)}\n${url}`)}`,
      `URL:${url}`,
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(foldIcsLine).join("\r\n")}\r\n`;
}

export function calendarIcsFileName(prefix: string | null | undefined, month: string): string {
  const slug = (prefix ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${slug ? `${slug}-` : ""}calendar-${month}.ics`;
}
