import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { NotificationPreferences } from "@greatstone/shared";
import { BellOff } from "lucide-react";
import { notificationPreferencesApi } from "../api/notificationPreferences";
import { queryKeys } from "../lib/queryKeys";
import { formatClockTime, formatWeekdayShortDate } from "../lib/utils";
import { Button } from "@/components/ui/button";

/** The pauses on offer, worked out from the person's own clock. */
export function pauseChoices(now: Date, morningHour = 8): Array<{ label: string; until: Date }> {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(morningHour, 0, 0, 0);
  return [
    { label: "1 hour", until: new Date(now.getTime() + 60 * 60 * 1000) },
    { label: "3 hours", until: new Date(now.getTime() + 3 * 60 * 60 * 1000) },
    { label: "Until tomorrow morning", until: tomorrow },
  ];
}

/** "18:05" today, otherwise "Sat 17 Oct at 08:00". */
export function pausedUntilLabel(until: Date, now: Date): string {
  return until.toDateString() === now.toDateString()
    ? formatClockTime(until)
    : `${formatWeekdayShortDate(until)} at ${formatClockTime(until)}`;
}

/** The time a pause ends, or null when notifications are not paused. */
export function activePause(prefs: Pick<NotificationPreferences, "pausedUntil"> | undefined, now: Date): Date | null {
  if (!prefs?.pausedUntil) return null;
  const until = new Date(prefs.pausedUntil);
  return until.getTime() > now.getTime() ? until : null;
}

/** Re-render once a minute so a pause that ends shows as ended. */
function useMinuteClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/**
 * Pause phone notifications for a while (a meeting, a meal) without touching
 * any setting. What arrives meanwhile is held and goes out when the pause
 * ends. `compact` shows only a line while paused, for Today.
 */
export function PauseNotifications({ companyId, compact = false }: { companyId: string; compact?: boolean }) {
  const queryClient = useQueryClient();
  const key = queryKeys.notificationPreferences(companyId);
  const now = useMinuteClock();
  const { data: prefs } = useQuery({
    queryKey: key,
    queryFn: () => notificationPreferencesApi.get(companyId),
  });
  const save = useMutation({
    mutationFn: (pausedUntil: string | null) => notificationPreferencesApi.update(companyId, { pausedUntil }),
    onSuccess: (saved) => queryClient.setQueryData(key, saved),
  });

  if (!prefs) return null;
  const until = activePause(prefs, now);
  const failed = save.error ? (
    <p className="text-sm text-destructive" role="alert">Could not save that. Please try again.</p>
  ) : null;

  if (until) {
    return (
      <div className="space-y-1 rounded-lg border border-border bg-card p-4" data-testid="notifications-paused">
        <div className="flex flex-wrap items-center gap-2">
          <BellOff className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="text-sm">Notifications paused until {pausedUntilLabel(until, now)}.</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="ml-auto"
            disabled={save.isPending}
            onClick={() => save.mutate(null)}
          >
            Resume now
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">Anything that comes in meanwhile reaches your phone when the pause ends.</p>
        {failed}
      </div>
    );
  }

  if (compact) return null;

  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="space-y-0.5">
        <h2 className="text-base font-semibold">Pause notifications</h2>
        <p className="text-sm text-muted-foreground">
          In a meeting or off for the evening? Nothing reaches your phone until the pause ends, then you hear what came in.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {pauseChoices(now, prefs.morningSummaryHour).map((choice) => (
          <Button
            key={choice.label}
            type="button"
            size="sm"
            variant="outline"
            disabled={save.isPending}
            onClick={() => save.mutate(choice.until.toISOString())}
          >
            {choice.label}
          </Button>
        ))}
      </div>
      {failed}
    </section>
  );
}
