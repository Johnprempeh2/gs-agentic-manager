/** What one person wants to hear about in one company, and when (all hours are local). */
export interface NotificationPreferences {
  /** Decisions that need you (approvals, reviews, questions). */
  decisions: boolean;
  /** Tasks someone gives to you. */
  assignedTasks: boolean;
  /** New messages in team chats you are in. */
  teamChat: boolean;
  /** A task you asked for was finished by an agent or a teammate. */
  finishedWork: boolean;
  /** One message each morning: what needs you, what got done, what is stuck. */
  morningSummary: boolean;
  /** Local hour (0 to 23) the morning summary goes out. */
  morningSummaryHour: number;
  /** "This week at ..." on Monday mornings, at the morning summary hour. */
  weeklyReport: boolean;
  /** Quiet hours, start inclusive and end exclusive. Both null means none. */
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
  /** IANA time zone the hours are read in. */
  timeZone: string;
  /**
   * Nothing goes to the phone before this time (ISO); null means not paused.
   * What arrives meanwhile is held and goes out once the pause ends.
   */
  pausedUntil: string | null;
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  decisions: true,
  assignedTasks: true,
  teamChat: true,
  finishedWork: true,
  morningSummary: true,
  morningSummaryHour: 8,
  weeklyReport: false,
  quietHoursStart: null,
  quietHoursEnd: null,
  timeZone: "Europe/London",
  pausedUntil: null,
};

/** One task line in the morning summary. */
export interface MorningSummaryTask {
  id: string;
  identifier: string | null;
  title: string;
  /** Set on "due today" lines: the date it is due (YYYY-MM-DD), earlier than today when late. */
  dueDate?: string | null;
}

/** What needs you, what the agents finished and what is stuck, for one person in one company. */
export interface MorningSummary {
  companyId: string;
  generatedAt: string;
  /** Start of the "finished" window: 24 hours before `generatedAt`. */
  since: string;
  needsYou: { count: number; items: MorningSummaryTask[] };
  /** Open tasks due today in the person's time zone, and any that are late. */
  dueToday: { count: number; items: MorningSummaryTask[] };
  finished: { count: number; items: MorningSummaryTask[] };
  stuck: { count: number; items: MorningSummaryTask[] };
  /** Tasks an agent is working on right now. Optional: older servers do not send it. */
  workingNow?: { count: number; items: MorningSummaryTask[] };
}
