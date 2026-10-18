import { useEffect, useId, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { NotificationPreferences, UpdateNotificationPreferences } from "@greatstone/shared";
import { Bell, BellOff, Loader2 } from "lucide-react";
import { notificationPreferencesApi } from "../api/notificationPreferences";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { usePushNotifications } from "../hooks/usePushNotifications";
import { useIsPhone } from "../hooks/useIsPhone";
import { EmptyState } from "../components/EmptyState";
import { PauseNotifications } from "../components/PauseNotifications";
import { RecentNotifications } from "../components/RecentNotifications";
import { ErrorState } from "../components/ErrorState";
import { PageSkeleton } from "../components/PageSkeleton";
import { queryKeys } from "../lib/queryKeys";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { ToggleSwitch } from "@/components/ui/toggle-switch";

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

/** 8 reads as "08:00". */
export function hourLabel(hour: number) {
  return `${String(hour).padStart(2, "0")}:00`;
}

function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="space-y-0.5">
        <h2 className="text-base font-semibold">{title}</h2>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

function ChoiceRow({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium">{label}</label>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <ToggleSwitch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} aria-label={label} />
    </div>
  );
}

function HourPicker({ label, value, disabled, onChange }: { label: string; value: number; disabled?: boolean; onChange: (hour: number) => void }) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">{label}</label>
      <NativeSelect id={id} value={value} disabled={disabled} onChange={(event) => onChange(Number(event.target.value))}>
        {HOURS.map((hour) => (
          <option key={hour} value={hour}>{hourLabel(hour)}</option>
        ))}
      </NativeSelect>
    </div>
  );
}

/** This device: phone or browser notifications on or off. */
function ThisDevice({ companyId }: { companyId: string }) {
  const { state, error, enable, disable, sendTest } = usePushNotifications(companyId);
  const isPhone = useIsPhone();
  const device = isPhone ? "this phone" : "this computer";

  let body: ReactNode;
  if (state === "unsupported") {
    body = <p className="text-sm text-muted-foreground">This browser cannot show notifications. You will still see everything in GSAM.</p>;
  } else if (state === "needs-home-screen") {
    body = (
      <p className="text-sm text-muted-foreground">
        On iPhone, notifications only work in the Home Screen app. In Safari, tap Share, then Add to Home Screen, and open GSAM from there.
      </p>
    );
  } else if (state === "denied") {
    body = (
      <p className="flex items-start gap-2 text-sm text-muted-foreground">
        <BellOff className="mt-0.5 size-4 shrink-0" aria-hidden />
        {isPhone
          ? "Notifications are blocked. Turn them on in your phone's Settings, under Notifications."
          : "Notifications are blocked. Allow them for this site in your browser's site settings."}
      </p>
    );
  } else if (state === "on") {
    body = (
      <div className="flex flex-wrap items-center gap-2">
        <Bell className="size-4 text-primary" aria-hidden />
        <span className="text-sm">Notifications are on for {device}.</span>
        <div className="flex gap-2 sm:ml-auto">
          <Button type="button" size="sm" variant="outline" onClick={() => void sendTest()}>Send a test</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => void disable()}>Turn off</Button>
        </div>
      </div>
    );
  } else {
    body = (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">Notifications are off for {device}.</span>
        <Button type="button" size="sm" className="sm:ml-auto" onClick={() => void enable()} disabled={state === "working"}>
          {state === "working" ? <Loader2 className="animate-spin" /> : null}
          Turn on
        </Button>
      </div>
    );
  }

  return (
    <Section title="On this device" description="Turn this on for each phone or computer you want to hear on.">
      {body}
      {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
    </Section>
  );
}

/**
 * Notifications: what each person hears about and when, in plain words.
 * Everything still shows in GSAM (Decisions, Inbox); this only decides what
 * reaches the phone.
 */
export function NotificationSettings() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([{ label: "Notifications" }]);
  }, [setBreadcrumbs]);

  const key = queryKeys.notificationPreferences(selectedCompanyId ?? "");
  const { data: prefs, isLoading, error, refetch } = useQuery({
    queryKey: key,
    queryFn: () => notificationPreferencesApi.get(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const save = useMutation({
    mutationFn: (patch: UpdateNotificationPreferences) => notificationPreferencesApi.update(selectedCompanyId!, patch),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<NotificationPreferences>(key);
      if (previous) queryClient.setQueryData<NotificationPreferences>(key, { ...previous, ...patch });
      return { previous };
    },
    onError: (_error, _patch, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
    },
    onSuccess: (saved) => queryClient.setQueryData(key, saved),
  });

  // Hours are read in the person's own time zone: keep it in step with this browser.
  const zone = browserTimeZone();
  const change = (patch: UpdateNotificationPreferences) =>
    save.mutate(zone && prefs && zone !== prefs.timeZone ? { ...patch, timeZone: zone } : patch);
  // The morning summary goes by the saved time zone, so fix a stale one on arrival.
  const staleZone = Boolean(zone && prefs && zone !== prefs.timeZone);
  useEffect(() => {
    if (staleZone && zone && !save.isPending) save.mutate({ timeZone: zone });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staleZone, zone]);

  if (!selectedCompanyId) return <EmptyState icon={Bell} message="Select an organisation to choose your notifications." />;
  if (isLoading) return <PageSkeleton variant="detail" />;
  if (error || !prefs) return <ErrorState error={error} title="Could not load your notification choices" onRetry={() => void refetch()} />;

  const quiet = prefs.quietHoursStart != null && prefs.quietHoursEnd != null;

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Notifications</h1>
        <p className="text-sm text-muted-foreground">
          Choose what GSAM tells you about. Everything still shows in Decisions and your Inbox; this only decides what reaches your phone.
        </p>
      </header>

      <ThisDevice companyId={selectedCompanyId} />

      <PauseNotifications companyId={selectedCompanyId} />

      <Section title="Tell me when">
        <div className="divide-y divide-border">
          <ChoiceRow
            label="A decision needs me"
            description="An approval, a review or a question only you can answer."
            checked={prefs.decisions}
            onChange={(decisions) => change({ decisions })}
          />
          <ChoiceRow
            label="A task is given to me"
            description="Someone or an agent hands a task to you."
            checked={prefs.assignedTasks}
            onChange={(assignedTasks) => change({ assignedTasks })}
          />
          <ChoiceRow
            label="A task I asked for is done"
            description="An agent or a teammate finishes a task you created. It opens that task."
            checked={prefs.finishedWork}
            onChange={(finishedWork) => change({ finishedWork })}
          />
          <ChoiceRow
            label="A deal is won or lost, or a client accepts"
            description="Someone else moves a client deal to won or lost, or a client accepts the engagement on their acceptance page. It opens that deal."
            checked={prefs.dealsClosed}
            onChange={(dealsClosed) => change({ dealsClosed })}
          />
          <ChoiceRow
            label="Someone messages a team chat I am in"
            description="New messages from people and agents in your team chats."
            checked={prefs.teamChat}
            onChange={(teamChat) => change({ teamChat })}
          />
        </div>
      </Section>

      <Section title="Morning summary" description="One message a day: what needs you, what got done since yesterday, and what is stuck.">
        <ChoiceRow
          label="Send me a morning summary"
          description={prefs.morningSummary ? `Every day at ${hourLabel(prefs.morningSummaryHour)}, your time.` : "Off."}
          checked={prefs.morningSummary}
          onChange={(morningSummary) => change({ morningSummary })}
        />
        {prefs.morningSummary ? (
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-32">
              <HourPicker label="At" value={prefs.morningSummaryHour} onChange={(morningSummaryHour) => change({ morningSummaryHour })} />
            </div>
            <Link to="/morning" className="inline-flex min-h-9 items-center text-sm font-medium text-primary hover:underline">See today's summary</Link>
          </div>
        ) : null}
      </Section>

      <Section title="Evening wrap-up" description="One message at the end of the day: what got done today and what still needs you.">
        <ChoiceRow
          label="Send me an evening wrap-up"
          description={prefs.eveningSummary ? `Every day at ${hourLabel(prefs.eveningSummaryHour)}, your time.` : "Off."}
          checked={prefs.eveningSummary}
          onChange={(eveningSummary) => change({ eveningSummary })}
        />
        {prefs.eveningSummary ? (
          <div className="w-32">
            <HourPicker label="Evening at" value={prefs.eveningSummaryHour} onChange={(eveningSummaryHour) => change({ eveningSummaryHour })} />
          </div>
        ) : null}
      </Section>

      <Section title="Weekly report" description="This week at a glance: what the agents finished, what is stuck, how the client pipeline moved and what needs you.">
        <ChoiceRow
          label="Send me the weekly report on Monday mornings"
          description={prefs.weeklyReport ? `Every Monday at ${hourLabel(prefs.morningSummaryHour)}, your time. Tap it to open the full report and its PDF.` : "Off."}
          checked={prefs.weeklyReport}
          onChange={(weeklyReport) => change({ weeklyReport })}
        />
        <Link to="/weekly-report" className="inline-flex min-h-9 items-center text-sm font-medium text-primary hover:underline">See this week's report</Link>
      </Section>

      <Section title="Quiet hours" description="Nothing is sent in these hours. Anything that came in goes out once they end.">
        <ChoiceRow
          label="Use quiet hours"
          description={quiet ? `From ${hourLabel(prefs.quietHoursStart!)} to ${hourLabel(prefs.quietHoursEnd!)}, your time.` : "Off. Notifications can arrive at any hour."}
          checked={quiet}
          onChange={(on) => change(on ? { quietHoursStart: 22, quietHoursEnd: 7 } : { quietHoursStart: null, quietHoursEnd: null })}
        />
        {quiet ? (
          <div className="flex gap-3">
            <HourPicker
              label="From"
              value={prefs.quietHoursStart!}
              onChange={(hour) => hour !== prefs.quietHoursEnd && change({ quietHoursStart: hour, quietHoursEnd: prefs.quietHoursEnd })}
            />
            <HourPicker
              label="Until"
              value={prefs.quietHoursEnd!}
              onChange={(hour) => hour !== prefs.quietHoursStart && change({ quietHoursStart: prefs.quietHoursStart, quietHoursEnd: hour })}
            />
          </div>
        ) : null}
        <ChoiceRow
          label="Keep weekends quiet"
          description={prefs.quietWeekends ? "Nothing is sent on Saturday or Sunday, including the morning summary. What came in goes out on Monday." : "Off. Notifications can arrive at weekends."}
          checked={prefs.quietWeekends}
          onChange={(quietWeekends) => change({ quietWeekends })}
        />
      </Section>

      <RecentNotifications companyId={selectedCompanyId} />

      {save.error ? <p className="text-sm text-destructive" role="alert">Could not save that change. Please try again.</p> : null}
      <p className="text-xs text-muted-foreground">Times are in your time zone ({prefs.timeZone}).</p>
    </div>
  );
}
