import { formatDateTime, relativeTime } from "./utils";

/**
 * Plain words for when a routine last ran and when it runs next, for the
 * Routines list: "Last run 2h ago" and "Next run today at 09:00".
 */

export interface ScheduleTriggerSummary {
  kind: string;
  enabled: boolean;
  nextRunAt: Date | string | null;
}

/** The soonest upcoming run across the routine's enabled schedules. */
export function nextScheduledRun(triggers: readonly ScheduleTriggerSummary[] | null | undefined): Date | null {
  let soonest: Date | null = null;
  for (const trigger of triggers ?? []) {
    if (trigger.kind !== "schedule" || !trigger.enabled || !trigger.nextRunAt) continue;
    const at = new Date(trigger.nextRunAt);
    if (Number.isNaN(at.getTime())) continue;
    if (!soonest || at < soonest) soonest = at;
  }
  return soonest;
}

function clock(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** "Next run in 20 minutes", "Next run today at 17:00", "Next run tomorrow at 09:00", or a date further out. */
export function nextRunLabel(at: Date, now: Date = new Date()): string {
  const minutes = Math.round((at.getTime() - now.getTime()) / 60_000);
  if (minutes <= 1) return "Next run any moment";
  if (minutes < 60) return `Next run in ${minutes} minutes`;
  const days = Math.round((startOfDay(at) - startOfDay(now)) / 86_400_000);
  if (days === 0) return `Next run today at ${clock(at)}`;
  if (days === 1) return `Next run tomorrow at ${clock(at)}`;
  return `Next run ${formatDateTime(at)}`;
}

/** "Last run 2h ago" or "Never run yet". */
export function lastRunLabel(value: Date | string | null | undefined): string {
  if (!value) return "Never run yet";
  return `Last run ${relativeTime(value)}`;
}
