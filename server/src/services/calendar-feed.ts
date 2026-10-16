// A private iCalendar feed of a company's deadlines (task due dates and goal
// target dates) that Google Calendar, Outlook or Apple Calendar subscribe to by
// URL. Read-only and one-way: it needs no Google or Microsoft keys, and nothing
// is written to anyone's calendar. Off until a person turns it on.
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { calendarFeeds, companies } from "@greatstone/db";
import type { CalendarItem } from "@greatstone/shared";
import { calendarService } from "./calendar.js";

export const CALENDAR_FEED_PATH_PREFIX = "/api/calendar-feeds/";
/** Days before today and after today the feed covers. */
const DAYS_BACK = 30;
const DAYS_AHEAD = 365;

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return isoDate(value);
}

/** Escape text for an iCalendar TEXT value (RFC 5545, 3.3.11). */
export function icsText(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Fold a content line to 75 octets (RFC 5545, 3.1). */
export function foldIcsLine(line: string) {
  if (Buffer.byteLength(line) <= 75) return line;
  const parts: string[] = [];
  let current = "";
  for (const char of line) {
    const limit = parts.length === 0 ? 75 : 74;
    if (Buffer.byteLength(current + char) > limit) {
      parts.push(current);
      current = "";
    }
    current += char;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

export function deadlinesToIcs(
  items: readonly CalendarItem[],
  options: { calendarName: string; itemUrl: (item: CalendarItem) => string; now: Date },
) {
  const stamp = options.now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Greatstone//GS Agentic Manager//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsText(options.calendarName)}`,
    // Ask calendar apps to check for changes every hour.
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];
  for (const item of items) {
    if (item.closed) continue;
    const url = options.itemUrl(item);
    const title = item.kind === "task"
      ? `Due: ${item.identifier ? `${item.identifier} ` : ""}${item.title}`
      : `Goal date: ${item.title}`;
    const details = [item.agentName ? `Owner: ${item.agentName}` : null, item.goalTitle ? `Goal: ${item.goalTitle}` : null, url]
      .filter(Boolean)
      .join("\n");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${item.kind}-${item.id}@gs-agentic-manager`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${item.date.replace(/-/g, "")}`,
      `DTEND;VALUE=DATE:${addDays(item.date, 1).replace(/-/g, "")}`,
      `SUMMARY:${icsText(title)}`,
      `DESCRIPTION:${icsText(details)}`,
      `URL:${url}`,
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(foldIcsLine).join("\r\n")}\r\n`;
}

export interface CalendarFeedStatus {
  enabled: boolean;
  lastFetchedAt: string | null;
}

export function calendarFeedService(db: Db, deps: { now?: () => Date } = {}) {
  const now = deps.now ?? (() => new Date());
  const calendar = calendarService(db);

  async function row(companyId: string) {
    return db.select().from(calendarFeeds).where(eq(calendarFeeds.companyId, companyId)).then((rows) => rows[0] ?? null);
  }

  return {
    async status(companyId: string): Promise<CalendarFeedStatus> {
      const feed = await row(companyId);
      return { enabled: Boolean(feed), lastFetchedAt: feed?.lastFetchedAt?.toISOString() ?? null };
    },

    /** Turns the feed on with a new secret URL, replacing any earlier one. The token is returned this once. */
    async enable(companyId: string, userId: string | null) {
      const token = `gsam_cal_${randomBytes(24).toString("hex")}`;
      await db
        .insert(calendarFeeds)
        .values({ companyId, tokenHash: hashToken(token), createdByUserId: userId })
        .onConflictDoUpdate({
          target: calendarFeeds.companyId,
          set: { tokenHash: hashToken(token), createdByUserId: userId, lastFetchedAt: null, updatedAt: now() },
        });
      return { path: `${CALENDAR_FEED_PATH_PREFIX}${token}.ics`, token };
    },

    async disable(companyId: string) {
      await db.delete(calendarFeeds).where(eq(calendarFeeds.companyId, companyId));
    },

    /** The feed for a token, or null when no feed has that token. */
    async render(token: string, origin: string) {
      const feed = await db
        .select({ id: calendarFeeds.id, companyId: calendarFeeds.companyId, name: companies.name, prefix: companies.issuePrefix })
        .from(calendarFeeds)
        .innerJoin(companies, eq(companies.id, calendarFeeds.companyId))
        .where(eq(calendarFeeds.tokenHash, hashToken(token)))
        .then((rows) => rows[0] ?? null);
      if (!feed) return null;
      const today = isoDate(now());
      const items = await calendar.deadlines(feed.companyId, addDays(today, -DAYS_BACK), addDays(today, DAYS_AHEAD));
      await db.update(calendarFeeds).set({ lastFetchedAt: now() }).where(eq(calendarFeeds.id, feed.id));
      return deadlinesToIcs(items, {
        calendarName: `${feed.name} deadlines`,
        now: now(),
        itemUrl: (item) =>
          item.kind === "task"
            ? `${origin}/${feed.prefix}/issues/${item.identifier ?? item.id}`
            : `${origin}/${feed.prefix}/goals/${item.id}`,
      });
    },
  };
}
