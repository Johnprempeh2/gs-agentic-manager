/**
 * Company calendar: what is coming up, on one page. Task due dates,
 * scheduled routine runs and goal target dates for a date window.
 */
export type CalendarItemKind = "task" | "routine" | "goal";

export interface CalendarItem {
  kind: CalendarItemKind;
  /** Task, routine or goal id. */
  id: string;
  /** Calendar date, YYYY-MM-DD. For a routine, the date in the routine's time zone. */
  date: string;
  title: string;
  /** Task key such as GRE-12, when the item is a task. */
  identifier: string | null;
  /** Task, goal or routine status. */
  status: string;
  /** True when the task is done or cancelled, or the goal is achieved or cancelled. */
  closed: boolean;
  /** Agent that owns the work, when there is one. */
  agentName: string | null;
  /** Strategy goal the task serves, when there is one. */
  goalTitle: string | null;
  /** Routine run times that day, as HH:MM in `timeZone`, at most 24. Empty for tasks and goals. */
  times: string[];
  /** How many times the routine runs that day. 0 for tasks and goals. */
  runCount: number;
  /** Time zone of `times`. Null for tasks and goals. */
  timeZone: string | null;
}

export interface CompanyCalendar {
  from: string;
  to: string;
  items: CalendarItem[];
}
