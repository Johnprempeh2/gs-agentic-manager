import { pgTable, uuid, text, timestamp, boolean, integer, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// What one board user wants to hear about in one company, and when. A missing
// row means the defaults (everything on, morning summary at 08:00, no quiet
// hours). No auth foreign key: local_trusted uses the synthetic local-board
// principal, like push_subscriptions.
export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    decisions: boolean("decisions").notNull().default(true),
    assignedTasks: boolean("assigned_tasks").notNull().default(true),
    teamChat: boolean("team_chat").notNull().default(true),
    /** A task this person asked for was finished by an agent or a teammate. */
    finishedWork: boolean("finished_work").notNull().default(true),
    morningSummary: boolean("morning_summary").notNull().default(true),
    /** Local hour (0 to 23) the morning summary goes out. */
    morningSummaryHour: integer("morning_summary_hour").notNull().default(8),
    /** The weekly report on Monday mornings, at the morning summary hour. Off until chosen. */
    weeklyReport: boolean("weekly_report").notNull().default(false),
    /** Local quiet hours, start inclusive and end exclusive; both null means none. */
    quietHoursStart: integer("quiet_hours_start"),
    quietHoursEnd: integer("quiet_hours_end"),
    /** IANA time zone the hours above are read in, taken from the person's browser. */
    timeZone: text("time_zone").notNull().default("Europe/London"),
    /** Nothing goes to the phone before this time ("Pause for an hour"); null means not paused. */
    pausedUntil: timestamp("paused_until", { withTimezone: true }),
    /** Local date (YYYY-MM-DD) of the last morning summary sent, so it goes once a day. */
    lastMorningSummaryOn: text("last_morning_summary_on"),
    /** Local date (YYYY-MM-DD) of the last weekly report sent, so it goes once a week. */
    lastWeeklyReportOn: text("last_weekly_report_on"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUserUq: uniqueIndex("notification_preferences_company_user_uq").on(table.companyId, table.userId),
  }),
);
