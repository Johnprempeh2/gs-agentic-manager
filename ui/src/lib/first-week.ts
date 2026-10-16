/**
 * The "first week" checklist on Home: four small steps that show a new
 * executive how GSAM works. Two steps are read from the server (calendar
 * feed on, a decision answered); the other two are remembered in this
 * browser when they happen (a quick start picked, This week opened).
 */

export type FirstWeekStepId = "calendar-feed" | "quick-start" | "decision" | "weekly-report";

export interface FirstWeekStep {
  id: FirstWeekStepId;
  label: string;
  hint: string;
  done: boolean;
}

export interface FirstWeekSignals {
  calendarFeedOn: boolean;
  quickStartPicked: boolean;
  decisionAnswered: boolean;
  weeklyReportRead: boolean;
}

export function firstWeekSteps(signals: FirstWeekSignals): FirstWeekStep[] {
  return [
    {
      id: "calendar-feed",
      label: "Connect the calendar feed",
      hint: "See task deadlines in your own calendar.",
      done: signals.calendarFeedOn,
    },
    {
      id: "quick-start",
      label: "Start a task from a quick start",
      hint: "Pick a ready-made brief and fill in the blanks.",
      done: signals.quickStartPicked,
    },
    {
      id: "decision",
      label: "Answer a decision",
      hint: "Agents ask you before anything important happens.",
      done: signals.decisionAnswered,
    },
    {
      id: "weekly-report",
      label: "Read This week",
      hint: "A one-page summary of what the agents did.",
      done: signals.weeklyReportRead,
    },
  ];
}

type LocalMark = "quick-start" | "weekly-report" | "hidden";

function storageKey(companyId: string, mark: LocalMark): string {
  return `gsam.first-week.${companyId}.${mark}`;
}

const CHANGE_EVENT = "gsam:first-week-change";

export function readFirstWeekMark(companyId: string, mark: LocalMark): boolean {
  try {
    return window.localStorage.getItem(storageKey(companyId, mark)) === "1";
  } catch {
    return false;
  }
}

export function setFirstWeekMark(companyId: string, mark: LocalMark, value = true): void {
  try {
    if (value) window.localStorage.setItem(storageKey(companyId, mark), "1");
    else window.localStorage.removeItem(storageKey(companyId, mark));
  } catch {
    // Storage can be blocked; the checklist simply stays as it was.
  }
  try {
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    // No window in some test environments.
  }
}

export function subscribeFirstWeekMarks(listener: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}
