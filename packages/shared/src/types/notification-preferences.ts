/** What one person wants to hear about in one company, and when (all hours are local). */
export interface NotificationPreferences {
  /** Decisions that need you (approvals, reviews, questions). */
  decisions: boolean;
  /** Tasks someone gives to you. */
  assignedTasks: boolean;
  /** New messages in team chats you are in. */
  teamChat: boolean;
  /** One message each morning: what needs you, what got done, what is stuck. */
  morningSummary: boolean;
  /** Local hour (0 to 23) the morning summary goes out. */
  morningSummaryHour: number;
  /** Quiet hours, start inclusive and end exclusive. Both null means none. */
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
  /** IANA time zone the hours are read in. */
  timeZone: string;
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  decisions: true,
  assignedTasks: true,
  teamChat: true,
  morningSummary: true,
  morningSummaryHour: 8,
  quietHoursStart: null,
  quietHoursEnd: null,
  timeZone: "Europe/London",
};
