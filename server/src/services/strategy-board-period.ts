import type { StrategyBoardPeriod } from "@greatstone/shared";

/**
 * Board period dates (GRE-3472). All dates are "YYYY-MM-DD" in UTC and both
 * ends are inclusive.
 */

export interface StoredBoardPeriod {
  periodStart: string | null;
  periodEnd: string | null;
  periodMonths: number | null;
}

export function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The same day `months` later, clamped to the month's end ("2026-01-31" + 1 gives "2026-02-28"). */
export function addMonths(isoDate: string, months: number): string {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  const lastDay = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + months, Math.min(d, lastDay))).toISOString().slice(0, 10);
}

/** The calendar month holding `today`: the chair alert's period when the board sets none. */
export function calendarMonthPeriod(today: string): { start: string; end: string } {
  const start = `${today.slice(0, 7)}-01`;
  return { start, end: addDays(addMonths(start, 1), -1) };
}

/**
 * The next period after `periodEnd` that holds `today`: from the day after
 * the old end, `months` long, skipping whole periods the sweep missed. Null
 * when the period has not ended or there is no automatic rollover.
 */
export function nextBoardPeriod(stored: StoredBoardPeriod, today: string): { start: string; end: string } | null {
  if (!stored.periodEnd || !stored.periodMonths || today <= stored.periodEnd) return null;
  let start = addDays(stored.periodEnd, 1);
  let end = addDays(addMonths(start, stored.periodMonths), -1);
  while (end < today) {
    start = addDays(end, 1);
    end = addDays(addMonths(start, stored.periodMonths), -1);
  }
  return { start, end };
}

/** The board period as the board sees it; null when none is set. */
export function boardPeriodView(stored: StoredBoardPeriod, today: string): StrategyBoardPeriod | null {
  if (!stored.periodStart || !stored.periodEnd) return null;
  return { start: stored.periodStart, end: stored.periodEnd, ended: today > stored.periodEnd };
}

/**
 * The period a new red KPI belongs to for the chair's task: the board period
 * (an ended one stays current until the next is set), else the calendar month.
 */
export function chairAlertPeriod(stored: StoredBoardPeriod, today: string): { start: string; end: string } {
  if (stored.periodStart && stored.periodEnd && today >= stored.periodStart) return { start: stored.periodStart, end: stored.periodEnd };
  return calendarMonthPeriod(today);
}

/** "1 Oct to 31 Oct 2026", for task titles. */
export function periodLabel(period: { start: string; end: string }): string {
  const fmt = (iso: string, withYear: boolean) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      ...(withYear ? { year: "numeric" } : {}),
      timeZone: "UTC",
    });
  const sameYear = period.start.slice(0, 4) === period.end.slice(0, 4);
  return `${fmt(period.start, !sameYear)} to ${fmt(period.end, true)}`;
}
