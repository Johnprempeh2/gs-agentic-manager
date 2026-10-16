import type { CalendarItem } from "@greatstone/shared";

/** Calendar maths on plain YYYY-MM-DD strings, so no time zone can shift a day. */

export const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function toUtc(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function fromUtc(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** Today as YYYY-MM-DD in the viewer's own time zone. */
export function localToday(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function addDays(date: string, days: number): string {
  const d = toUtc(date);
  d.setUTCDate(d.getUTCDate() + days);
  return fromUtc(d);
}

/** "2026-10" for any date in October 2026. */
export function monthKey(date: string): string {
  return date.slice(0, 7);
}

export function isMonthKey(value: string | null | undefined): value is string {
  return !!value && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

export function isIsoDate(value: string | null | undefined): value is string {
  return !!value && /^\d{4}-\d{2}-\d{2}$/.test(value) && fromUtc(toUtc(value)) === value;
}

export function shiftMonth(month: string, delta: number): string {
  const [year, m] = month.split("-").map(Number) as [number, number];
  const index = year * 12 + (m - 1) + delta;
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}`;
}

/** "October 2026" */
export function monthTitle(month: string): string {
  const [year, m] = month.split("-").map(Number) as [number, number];
  return `${MONTH_NAMES[m - 1]} ${year}`;
}

/** "Tuesday 20 October" */
export function dayTitle(date: string): string {
  const d = toUtc(date);
  return `${WEEKDAY_NAMES[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]}`;
}

export function dayOfMonth(date: string): number {
  return toUtc(date).getUTCDate();
}

/**
 * The weeks shown for a month, Monday first: whole weeks from the Monday on or
 * before the 1st to the Sunday on or after the last day.
 */
export function monthGrid(month: string): string[][] {
  const first = `${month}-01`;
  const mondayOffset = (toUtc(first).getUTCDay() + 6) % 7;
  const start = addDays(first, -mondayOffset);
  const lastOfMonth = addDays(`${shiftMonth(month, 1)}-01`, -1);
  const weeks: string[][] = [];
  let cursor = start;
  while (cursor <= lastOfMonth) {
    const week: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      week.push(cursor);
      cursor = addDays(cursor, 1);
    }
    weeks.push(week);
  }
  return weeks;
}

export function groupByDate(items: readonly CalendarItem[]): Map<string, CalendarItem[]> {
  const out = new Map<string, CalendarItem[]>();
  for (const item of items) {
    const list = out.get(item.date);
    if (list) list.push(item);
    else out.set(item.date, [item]);
  }
  return out;
}

/** An open task or goal whose date has passed. */
export function isOverdue(item: CalendarItem, today: string): boolean {
  return item.kind !== "routine" && !item.closed && item.date < today;
}

/** Where an item opens. */
export interface RescheduleOption {
  label: string;
  date: string;
}

/**
 * Quick new due dates for a task: today, tomorrow and next Monday, without the
 * day it is already on.
 */
export function rescheduleOptions(current: string, today: string): RescheduleOption[] {
  const weekday = toUtc(today).getUTCDay();
  const daysToMonday = ((8 - weekday) % 7) || 7;
  const options: RescheduleOption[] = [
    { label: "Today", date: today },
    { label: "Tomorrow", date: addDays(today, 1) },
    { label: "Next Monday", date: addDays(today, daysToMonday) },
  ];
  const seen = new Set<string>();
  return options.filter((option) => {
    if (option.date === current || seen.has(option.date)) return false;
    seen.add(option.date);
    return true;
  });
}

/** Only open tasks can move to another day: routines follow their schedule, and goals change on their own page. */
export function canReschedule(item: CalendarItem): boolean {
  return item.kind === "task" && !item.closed;
}

export function calendarItemHref(item: CalendarItem): string {
  if (item.kind === "task") return `/issues/${item.identifier ?? item.id}`;
  if (item.kind === "routine") return `/routines/${item.id}`;
  return `/goals/${item.id}`;
}

/** "Runs at 09:00", "Runs at 09:00 and 17:00", "Runs 24 times" (with the zone when it is not the viewer's). */
export function routineTimesLabel(item: CalendarItem, viewerTimeZone?: string): string {
  const zone = item.timeZone && item.timeZone !== viewerTimeZone ? ` (${item.timeZone})` : "";
  if (item.runCount > 3) return `Runs ${item.runCount} times${zone}`;
  if (item.times.length === 0) return "Runs";
  const times = item.times.length === 1 ? item.times[0] : `${item.times.slice(0, -1).join(", ")} and ${item.times.at(-1)}`;
  return `Runs at ${times}${zone}`;
}

export const CALENDAR_KIND_LABELS: Record<CalendarItem["kind"], string> = {
  task: "Task due",
  routine: "Routine",
  goal: "Goal date",
};
