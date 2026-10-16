import { and, eq } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { notificationPreferences } from "@greatstone/db";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  type NotificationPreferences,
  type UpdateNotificationPreferences,
} from "@greatstone/shared";

/** The kinds of notification a person can switch off. */
export type NotificationTopic = "decisions" | "assignedTasks" | "teamChat" | "morningSummary";

/** Local hour (0 to 23) and date (YYYY-MM-DD) in a time zone. Falls back to London on a bad zone. */
export function localClock(timeZone: string, now: Date): { hour: number; date: string } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
  } catch {
    return localClock(DEFAULT_NOTIFICATION_PREFERENCES.timeZone, now);
  }
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return { hour: Number(get("hour")) % 24, date: `${get("year")}-${get("month")}-${get("day")}` };
}

/** True inside quiet hours. A window can cross midnight (22 to 7). */
export function isQuietHour(prefs: Pick<NotificationPreferences, "quietHoursStart" | "quietHoursEnd" | "timeZone">, now: Date): boolean {
  const { quietHoursStart: start, quietHoursEnd: end } = prefs;
  if (start == null || end == null || start === end) return false;
  const { hour } = localClock(prefs.timeZone, now);
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** Whether a notification on this topic may go out now. */
export function mayNotify(prefs: NotificationPreferences, topic: NotificationTopic, now: Date): boolean {
  return prefs[topic] && !isQuietHour(prefs, now);
}

type Row = typeof notificationPreferences.$inferSelect;

function fromRow(row: Row | undefined): NotificationPreferences {
  if (!row) return { ...DEFAULT_NOTIFICATION_PREFERENCES };
  return {
    decisions: row.decisions,
    assignedTasks: row.assignedTasks,
    teamChat: row.teamChat,
    morningSummary: row.morningSummary,
    morningSummaryHour: row.morningSummaryHour,
    quietHoursStart: row.quietHoursStart,
    quietHoursEnd: row.quietHoursEnd,
    timeZone: row.timeZone,
  };
}

/** One person's notification choices in one company. A missing row reads as the defaults. */
export function notificationPreferencesService(db: Db) {
  async function row(companyId: string, userId: string) {
    const [found] = await db
      .select()
      .from(notificationPreferences)
      .where(and(eq(notificationPreferences.companyId, companyId), eq(notificationPreferences.userId, userId)));
    return found;
  }

  return {
    get: async (companyId: string, userId: string) => fromRow(await row(companyId, userId)),

    async update(companyId: string, userId: string, patch: UpdateNotificationPreferences): Promise<NotificationPreferences> {
      const now = new Date();
      const [saved] = await db
        .insert(notificationPreferences)
        .values({ companyId, userId, ...patch })
        .onConflictDoUpdate({
          target: [notificationPreferences.companyId, notificationPreferences.userId],
          set: { ...patch, updatedAt: now },
        })
        .returning();
      return fromRow(saved);
    },

    /** The local date of the last morning summary sent, or null. */
    lastMorningSummaryOn: async (companyId: string, userId: string) => (await row(companyId, userId))?.lastMorningSummaryOn ?? null,

    async markMorningSummarySent(companyId: string, userId: string, localDate: string) {
      await db
        .insert(notificationPreferences)
        .values({ companyId, userId, lastMorningSummaryOn: localDate })
        .onConflictDoUpdate({
          target: [notificationPreferences.companyId, notificationPreferences.userId],
          set: { lastMorningSummaryOn: localDate, updatedAt: new Date() },
        });
    },
  };
}
