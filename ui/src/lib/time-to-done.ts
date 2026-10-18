const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "45 min", "5 h", "2 days 4 h", "3 weeks": short enough for a property row. */
export function shortDuration(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < HOUR) return `${Math.max(1, Math.round(safe / MINUTE))} min`;
  if (safe < DAY) return `${Math.round(safe / HOUR)} h`;
  if (safe < 14 * DAY) {
    const days = Math.floor(safe / DAY);
    const hours = Math.round((safe - days * DAY) / HOUR);
    const dayText = days === 1 ? "1 day" : `${days} days`;
    return hours > 0 && hours < 24 ? `${dayText} ${hours} h` : dayText;
  }
  const weeks = Math.round(safe / (7 * DAY));
  return weeks === 1 ? "1 week" : `${weeks} weeks`;
}

function toTime(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

export interface TaskTimeSource {
  status: string;
  createdAt: Date | string;
  startedAt?: Date | string | null;
  completedAt?: Date | string | null;
}

/**
 * How long a task took (done) or has been open (not done yet). Counts from
 * when work started when known, else from when the task was made. Cancelled
 * tasks get nothing.
 */
export function taskTimeLine(task: TaskTimeSource, now: Date = new Date()): { label: string; value: string } | null {
  if (task.status === "cancelled") return null;
  const created = toTime(task.createdAt);
  if (created === null) return null;
  if (task.status === "done") {
    const completed = toTime(task.completedAt);
    if (completed === null) return null;
    const started = toTime(task.startedAt) ?? created;
    return { label: "Took", value: shortDuration(completed - started) };
  }
  return { label: "Open for", value: shortDuration(now.getTime() - created) };
}
