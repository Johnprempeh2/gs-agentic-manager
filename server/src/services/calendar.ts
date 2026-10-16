import { and, asc, eq, gte, isNotNull, isNull, lte } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { agents, goals, issues, routines, routineTriggers } from "@greatstone/db";
import type { CalendarItem, CompanyCalendar } from "@greatstone/shared";
import { parseCron } from "./cron.js";

/** Longest window one request may ask for, in days (a six-week month grid fits). */
export const CALENDAR_MAX_DAYS = 62;

/** Run times listed per routine per day; the rest are counted in runCount. */
const MAX_TIMES_PER_DAY = 24;

const CLOSED_TASK_STATUSES = new Set(["done", "cancelled"]);
const CLOSED_GOAL_STATUSES = new Set(["achieved", "cancelled"]);

function parseIsoDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function formatIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Every calendar date from `from` to `to`, inclusive. */
export function datesInWindow(from: string, to: string): string[] {
  const out: string[] = [];
  const cursor = parseIsoDate(from);
  const end = parseIsoDate(to).getTime();
  while (cursor.getTime() <= end) {
    out.push(formatIsoDate(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

/**
 * The days a schedule runs in the window, with its run times that day. Dates
 * and times are in the routine's own time zone, matching how the scheduler
 * reads the expression (month, day of month and weekday must all match).
 * Returns an empty list for an expression the scheduler would reject.
 */
export function scheduleOccurrences(cronExpression: string, from: string, to: string): Array<{ date: string; times: string[] }> {
  let cron: ReturnType<typeof parseCron>;
  try {
    cron = parseCron(cronExpression);
  } catch {
    return [];
  }
  const times: string[] = [];
  for (const hour of cron.hours) {
    for (const minute of cron.minutes) times.push(`${pad(hour)}:${pad(minute)}`);
  }
  const out: Array<{ date: string; times: string[] }> = [];
  for (const date of datesInWindow(from, to)) {
    const day = parseIsoDate(date);
    if (!cron.months.includes(day.getUTCMonth() + 1)) continue;
    if (!cron.daysOfMonth.includes(day.getUTCDate())) continue;
    if (!cron.daysOfWeek.includes(day.getUTCDay())) continue;
    out.push({ date, times });
  }
  return out;
}

export function calendarService(db: Db) {
  async function taskItems(companyId: string, from: string, to: string): Promise<CalendarItem[]> {
    const rows = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        dueDate: issues.dueDate,
        agentName: agents.name,
        goalTitle: goals.title,
      })
      .from(issues)
      .leftJoin(agents, eq(agents.id, issues.assigneeAgentId))
      .leftJoin(goals, eq(goals.id, issues.goalId))
      .where(
        and(
          eq(issues.companyId, companyId),
          isNotNull(issues.dueDate),
          gte(issues.dueDate, from),
          lte(issues.dueDate, to),
          isNull(issues.hiddenAt),
        ),
      )
      .orderBy(asc(issues.dueDate), asc(issues.createdAt));
    return rows.map((row) => ({
      kind: "task",
      id: row.id,
      date: row.dueDate!,
      title: row.title,
      identifier: row.identifier ?? null,
      status: row.status,
      closed: CLOSED_TASK_STATUSES.has(row.status),
      agentName: row.agentName ?? null,
      goalTitle: row.goalTitle ?? null,
      times: [],
      runCount: 0,
      timeZone: null,
    }));
  }

  async function goalItems(companyId: string, from: string, to: string): Promise<CalendarItem[]> {
    const rows = await db
      .select({ id: goals.id, title: goals.title, status: goals.status, targetDate: goals.targetDate })
      .from(goals)
      .where(
        and(
          eq(goals.companyId, companyId),
          isNotNull(goals.targetDate),
          gte(goals.targetDate, from),
          lte(goals.targetDate, to),
        ),
      )
      .orderBy(asc(goals.targetDate));
    return rows.map((row) => ({
      kind: "goal",
      id: row.id,
      date: row.targetDate!,
      title: row.title,
      identifier: null,
      status: row.status,
      closed: CLOSED_GOAL_STATUSES.has(row.status),
      agentName: null,
      goalTitle: null,
      times: [],
      runCount: 0,
      timeZone: null,
    }));
  }

  async function routineItems(companyId: string, from: string, to: string): Promise<CalendarItem[]> {
    const rows = await db
      .select({
        routineId: routines.id,
        title: routines.title,
        status: routines.status,
        cronExpression: routineTriggers.cronExpression,
        timezone: routineTriggers.timezone,
        agentName: agents.name,
      })
      .from(routineTriggers)
      .innerJoin(routines, eq(routines.id, routineTriggers.routineId))
      .leftJoin(agents, eq(agents.id, routines.assigneeAgentId))
      .where(
        and(
          eq(routineTriggers.companyId, companyId),
          eq(routineTriggers.kind, "schedule"),
          eq(routineTriggers.enabled, true),
          eq(routineTriggers.archived, false),
          isNotNull(routineTriggers.cronExpression),
          eq(routines.status, "active"),
        ),
      );
    // One routine may have several schedules; merge them into one entry per day.
    const byRoutineDay = new Map<string, { allTimes: string[]; item: CalendarItem }>();
    for (const row of rows) {
      const timeZone = row.timezone || "UTC";
      for (const occurrence of scheduleOccurrences(row.cronExpression!, from, to)) {
        const key = `${row.routineId}:${occurrence.date}:${timeZone}`;
        const existing = byRoutineDay.get(key);
        if (existing) {
          const merged = [...new Set([...existing.allTimes, ...occurrence.times])].sort();
          existing.allTimes = merged;
          existing.item.times = merged.slice(0, MAX_TIMES_PER_DAY);
          existing.item.runCount = merged.length;
          continue;
        }
        byRoutineDay.set(key, { allTimes: occurrence.times, item: {
          kind: "routine",
          id: row.routineId,
          date: occurrence.date,
          title: row.title,
          identifier: null,
          status: row.status,
          closed: false,
          agentName: row.agentName ?? null,
          goalTitle: null,
          times: occurrence.times.slice(0, MAX_TIMES_PER_DAY),
          runCount: occurrence.times.length,
          timeZone,
        } });
      }
    }
    return [...byRoutineDay.values()].map((entry) => entry.item);
  }

  return {
    /** Task due dates and goal target dates in a window of any length, for the subscribed calendar feed. */
    async deadlines(companyId: string, from: string, to: string): Promise<CalendarItem[]> {
      const [tasks, goalRows] = await Promise.all([taskItems(companyId, from, to), goalItems(companyId, from, to)]);
      return [...goalRows, ...tasks].sort((a, b) => a.date.localeCompare(b.date));
    },

    async build(companyId: string, from: string, to: string): Promise<CompanyCalendar> {
      const [tasks, goalRows, routineRows] = await Promise.all([
        taskItems(companyId, from, to),
        goalItems(companyId, from, to),
        routineItems(companyId, from, to),
      ]);
      const order: Record<CalendarItem["kind"], number> = { goal: 0, task: 1, routine: 2 };
      const items = [...goalRows, ...tasks, ...routineRows].sort(
        (a, b) => a.date.localeCompare(b.date) || order[a.kind] - order[b.kind] || (a.times[0] ?? "").localeCompare(b.times[0] ?? ""),
      );
      return { from, to, items };
    },
  };
}
