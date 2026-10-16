import { describe, expect, it } from "vitest";
import { DEFAULT_NOTIFICATION_PREFERENCES, updateNotificationPreferencesSchema } from "@greatstone/shared";
import { isHeld, isPaused, isQuietHour, localClock, mayNotify } from "../services/notification-preferences.js";

describe("notification preference clock", () => {
  it("reads the local hour and date in the person's time zone", () => {
    expect(localClock("Europe/London", new Date("2026-10-16T23:30:00Z"))).toEqual({ hour: 0, date: "2026-10-17" });
    expect(localClock("America/New_York", new Date("2026-10-16T03:00:00Z"))).toEqual({ hour: 23, date: "2026-10-15" });
    // A bad zone falls back to London rather than throwing.
    expect(localClock("Not/AZone", new Date("2026-01-10T09:00:00Z"))).toEqual({ hour: 9, date: "2026-01-10" });
  });

  it("handles quiet hours that cross midnight", () => {
    const prefs = { quietHoursStart: 22, quietHoursEnd: 7, timeZone: "UTC" };
    expect(isQuietHour(prefs, new Date("2026-10-16T22:00:00Z"))).toBe(true);
    expect(isQuietHour(prefs, new Date("2026-10-16T06:59:00Z"))).toBe(true);
    expect(isQuietHour(prefs, new Date("2026-10-16T07:00:00Z"))).toBe(false);
    expect(isQuietHour({ ...prefs, quietHoursStart: null, quietHoursEnd: null }, new Date("2026-10-16T23:00:00Z"))).toBe(false);
  });

  it("needs the topic on and no quiet hours", () => {
    const now = new Date("2026-10-16T12:00:00Z");
    expect(mayNotify(DEFAULT_NOTIFICATION_PREFERENCES, "teamChat", now)).toBe(true);
    expect(mayNotify({ ...DEFAULT_NOTIFICATION_PREFERENCES, teamChat: false }, "teamChat", now)).toBe(false);
  });
});

describe("pausing notifications", () => {
  const now = new Date("2026-10-16T12:00:00Z");

  it("holds everything until the pause ends, then lets it through", () => {
    const paused = { ...DEFAULT_NOTIFICATION_PREFERENCES, pausedUntil: "2026-10-16T13:00:00.000Z" };
    expect(isPaused(paused, now)).toBe(true);
    expect(isHeld(paused, now)).toBe(true);
    expect(mayNotify(paused, "decisions", now)).toBe(false);
    expect(mayNotify(paused, "decisions", new Date("2026-10-16T13:00:00Z"))).toBe(true);
    expect(isPaused(DEFAULT_NOTIFICATION_PREFERENCES, now)).toBe(false);
  });

  it("accepts a pause of up to a week, and null to resume", () => {
    const soon = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const tooLong = new Date(Date.now() + 9 * 24 * 60 * 60 * 1000).toISOString();
    expect(updateNotificationPreferencesSchema.safeParse({ pausedUntil: soon }).success).toBe(true);
    expect(updateNotificationPreferencesSchema.safeParse({ pausedUntil: null }).success).toBe(true);
    expect(updateNotificationPreferencesSchema.safeParse({ pausedUntil: tooLong }).success).toBe(false);
    expect(updateNotificationPreferencesSchema.safeParse({ pausedUntil: "in an hour" }).success).toBe(false);
  });
});

describe("notification preference updates", () => {
  it("accepts a partial change and a real time zone", () => {
    expect(updateNotificationPreferencesSchema.safeParse({ teamChat: false, timeZone: "Europe/London" }).success).toBe(true);
  });

  it("rejects half-set quiet hours, equal ends and unknown zones", () => {
    expect(updateNotificationPreferencesSchema.safeParse({ quietHoursStart: 22 }).success).toBe(false);
    expect(updateNotificationPreferencesSchema.safeParse({ quietHoursStart: 8, quietHoursEnd: 8 }).success).toBe(false);
    expect(updateNotificationPreferencesSchema.safeParse({ timeZone: "Mars/Olympus" }).success).toBe(false);
    expect(updateNotificationPreferencesSchema.safeParse({ quietHoursStart: null, quietHoursEnd: null }).success).toBe(true);
  });
});
