/**
 * Client support clock (GRE-665). Working hours are Mon to Fri 09:00 to
 * 17:30 Europe/London, so one working day is 510 minutes. First-response
 * targets are the proposed D8 terms: P1 4 working hours, P2 1 working day,
 * P3 2 working days. The warning fires when 75% of the window has passed.
 *
 * Pure functions only: the sweep in support-queue.ts calls these with the
 * current time, so the clock is the same in tests and in the server.
 */

export const SUPPORT_TIME_ZONE = "Europe/London";
export const SUPPORT_DAY_START_MINUTE = 9 * 60;
export const SUPPORT_DAY_END_MINUTE = 17 * 60 + 30;
export const SUPPORT_WORKING_DAY_MINUTES = SUPPORT_DAY_END_MINUTE - SUPPORT_DAY_START_MINUTE;

export const SUPPORT_PRIORITIES = ["P1", "P2", "P3"] as const;
export type SupportPriority = (typeof SUPPORT_PRIORITIES)[number];

export const SUPPORT_FIRST_RESPONSE_MINUTES: Record<SupportPriority, number> = {
  P1: 4 * 60,
  P2: SUPPORT_WORKING_DAY_MINUTES,
  P3: 2 * SUPPORT_WORKING_DAY_MINUTES,
};

export const SUPPORT_WARN_FRACTION = 0.75;

const MINUTE_MS = 60_000;

const londonParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: SUPPORT_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  weekday: "short",
  hourCycle: "h23",
});

type LondonWallTime = {
  year: number;
  month: number;
  day: number;
  minuteOfDay: number;
  weekday: string;
  /** ISO date, used to match bank holidays. */
  date: string;
};

function wallTime(at: Date): LondonWallTime {
  const parts = Object.fromEntries(londonParts.formatToParts(at).map((p) => [p.type, p.value]));
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  return {
    year,
    month,
    day,
    minuteOfDay: Number(parts.hour) * 60 + Number(parts.minute) + Number(parts.second) / 60,
    weekday: parts.weekday!,
    date: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/** The UTC instant of a London wall-clock time (DST-aware). */
function londonInstant(year: number, month: number, day: number, minuteOfDay: number): Date {
  const guess = Date.UTC(year, month - 1, day, 0, minuteOfDay);
  const offsetAt = (ms: number) => {
    const w = wallTime(new Date(ms));
    const asUtc = Date.UTC(w.year, w.month - 1, w.day, 0, Math.round(w.minuteOfDay));
    return asUtc - ms;
  };
  const first = guess - offsetAt(guess);
  return new Date(guess - offsetAt(first));
}

function isWorkingDay(w: LondonWallTime, holidays: ReadonlySet<string>) {
  return w.weekday !== "Sat" && w.weekday !== "Sun" && !holidays.has(w.date);
}

/** Start of the next London calendar day (midnight wall time). */
function nextDay(w: LondonWallTime): Date {
  const noonNext = new Date(Date.UTC(w.year, w.month - 1, w.day, 12) + 24 * 60 * MINUTE_MS);
  return londonInstant(noonNext.getUTCFullYear(), noonNext.getUTCMonth() + 1, noonNext.getUTCDate(), 0);
}

/**
 * Add working minutes to a start time. Time outside working hours does not
 * count, so a ticket that arrives on Saturday starts its clock Monday 09:00.
 */
export function addWorkingMinutes(start: Date, minutes: number, holidays: Iterable<string> = []): Date {
  const off = new Set(holidays);
  let cursor = new Date(start.getTime());
  let remaining = minutes;
  // Bounded: two calendar years of days is far beyond any support target.
  for (let guard = 0; guard < 800; guard += 1) {
    const w = wallTime(cursor);
    if (!isWorkingDay(w, off) || w.minuteOfDay >= SUPPORT_DAY_END_MINUTE) {
      cursor = nextDay(w);
      continue;
    }
    if (w.minuteOfDay < SUPPORT_DAY_START_MINUTE) {
      cursor = londonInstant(w.year, w.month, w.day, SUPPORT_DAY_START_MINUTE);
      continue;
    }
    const left = SUPPORT_DAY_END_MINUTE - w.minuteOfDay;
    if (remaining <= left) return new Date(cursor.getTime() + remaining * MINUTE_MS);
    remaining -= left;
    cursor = nextDay(w);
  }
  throw new Error("Support clock could not find enough working time");
}

/** Working minutes between two instants (0 when `to` is not after `from`). */
export function workingMinutesBetween(from: Date, to: Date, holidays: Iterable<string> = []): number {
  const off = new Set(holidays);
  if (to.getTime() <= from.getTime()) return 0;
  let cursor = new Date(from.getTime());
  let total = 0;
  for (let guard = 0; guard < 800 && cursor.getTime() < to.getTime(); guard += 1) {
    const w = wallTime(cursor);
    if (!isWorkingDay(w, off) || w.minuteOfDay >= SUPPORT_DAY_END_MINUTE) {
      cursor = nextDay(w);
      continue;
    }
    if (w.minuteOfDay < SUPPORT_DAY_START_MINUTE) {
      cursor = londonInstant(w.year, w.month, w.day, SUPPORT_DAY_START_MINUTE);
      continue;
    }
    const dayEnd = londonInstant(w.year, w.month, w.day, SUPPORT_DAY_END_MINUTE);
    const until = Math.min(dayEnd.getTime(), to.getTime());
    total += (until - cursor.getTime()) / MINUTE_MS;
    cursor = dayEnd;
  }
  return Math.round(total);
}

export type SupportClock = {
  priority: SupportPriority;
  receivedAt: Date;
  warnAt: Date;
  dueAt: Date;
};

export function supportClock(priority: SupportPriority, receivedAt: Date, holidays: Iterable<string> = []): SupportClock {
  const target = SUPPORT_FIRST_RESPONSE_MINUTES[priority];
  const list = [...holidays];
  return {
    priority,
    receivedAt,
    warnAt: addWorkingMinutes(receivedAt, Math.round(target * SUPPORT_WARN_FRACTION), list),
    dueAt: addWorkingMinutes(receivedAt, target, list),
  };
}

export function formatLondon(at: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: SUPPORT_TIME_ZONE,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);
}
