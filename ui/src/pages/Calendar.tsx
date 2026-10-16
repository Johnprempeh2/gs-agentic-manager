import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CalendarItem, CalendarItemKind } from "@greatstone/shared";
import { CalendarDays, CalendarPlus, ChevronLeft, ChevronRight, CircleCheck, Repeat, Target } from "lucide-react";
import { calendarApi } from "../api/calendar";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { PageSkeleton } from "../components/PageSkeleton";
import { queryKeys } from "../lib/queryKeys";
import {
  CALENDAR_KIND_LABELS,
  WEEKDAY_LABELS,
  calendarItemHref,
  dayOfMonth,
  dayTitle,
  groupByDate,
  isIsoDate,
  isMonthKey,
  isOverdue,
  localToday,
  monthGrid,
  monthKey,
  monthTitle,
  routineTimesLabel,
  shiftMonth,
} from "../lib/calendar";
import { calendarIcsFileName, calendarToIcs } from "../lib/calendar-ics";
import { downloadTextFile } from "../lib/issues-csv";
import { Link, useSearchParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const KIND_ICONS: Record<CalendarItemKind, typeof CircleCheck> = {
  task: CircleCheck,
  routine: Repeat,
  goal: Target,
};

const KIND_CHIP_CLASSES: Record<CalendarItemKind, string> = {
  task: "bg-status-info-soft text-status-info-foreground",
  routine: "bg-status-neutral-soft text-status-neutral-foreground",
  goal: "bg-status-review-soft text-status-review-foreground",
};

const ALL_KINDS: CalendarItemKind[] = ["task", "routine", "goal"];
const FILTER_LABELS: Record<CalendarItemKind, string> = { task: "Tasks", routine: "Routines", goal: "Goals" };
/** Items a month cell shows before "+N more". */
const CELL_LIMIT = 3;

function viewerTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

function chipClasses(item: CalendarItem, today: string) {
  if (isOverdue(item, today)) return "bg-status-danger-soft text-status-danger-foreground";
  return KIND_CHIP_CLASSES[item.kind];
}

function itemSubtitle(item: CalendarItem, today: string, timeZone: string | undefined): string {
  const parts: string[] = [];
  if (item.kind === "routine") parts.push(routineTimesLabel(item, timeZone));
  else if (isOverdue(item, today)) parts.push(item.kind === "task" ? "Overdue" : "Date passed");
  else if (item.closed) parts.push(item.kind === "task" ? "Done" : "Closed");
  else parts.push(CALENDAR_KIND_LABELS[item.kind]);
  if (item.agentName) parts.push(item.agentName);
  if (item.goalTitle) parts.push(`For: ${item.goalTitle}`);
  return parts.join(" · ");
}

function CalendarChip({ item, today }: { item: CalendarItem; today: string }) {
  const Icon = KIND_ICONS[item.kind];
  return (
    <Link
      to={calendarItemHref(item)}
      title={item.title}
      className={cn(
        "flex min-w-0 items-center gap-1 rounded-sm px-1 py-0.5 text-xs hover:opacity-80",
        chipClasses(item, today),
        item.closed && "line-through opacity-60",
      )}
    >
      <Icon className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{item.title}</span>
    </Link>
  );
}

function DayList({ date, items, today }: { date: string; items: CalendarItem[]; today: string }) {
  const timeZone = viewerTimeZone();
  return (
    <section aria-labelledby={`day-${date}`} className="space-y-2">
      <h2 id={`day-${date}`} className="text-sm font-semibold">
        {dayTitle(date)}
        {date === today ? <span className="ml-2 text-xs font-normal text-muted-foreground">Today</span> : null}
      </h2>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing on this day.</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border bg-card">
          {items.map((item) => {
            const Icon = KIND_ICONS[item.kind];
            return (
              <li key={`${item.kind}:${item.id}:${item.date}`}>
                <Link to={calendarItemHref(item)} className="flex items-start gap-3 px-3 py-2 hover:bg-accent">
                  <span className={cn("mt-0.5 rounded-sm p-1", chipClasses(item, today))}>
                    <Icon className="size-3.5" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={cn("block truncate text-sm font-medium", item.closed && "line-through text-muted-foreground")}>
                      {item.identifier ? <span className="mr-1.5 text-muted-foreground">{item.identifier}</span> : null}
                      {item.title}
                    </span>
                    <span className={cn("block truncate text-xs", isOverdue(item, today) ? "text-status-danger" : "text-muted-foreground")}>
                      {itemSubtitle(item, today, timeZone)}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * Calendar: what is coming up, on one page. Task due dates, scheduled routine
 * runs and goal target dates for a month, with the chosen day listed below.
 */
export function Calendar() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [searchParams, setSearchParams] = useSearchParams();
  const [showEarlierDays, setShowEarlierDays] = useState(false);
  const today = localToday();

  useEffect(() => {
    setBreadcrumbs([{ label: "Calendar" }]);
  }, [setBreadcrumbs]);

  const monthParam = searchParams.get("month");
  const month = isMonthKey(monthParam) ? monthParam : monthKey(today);
  const dayParam = searchParams.get("day");
  const selectedDay = isIsoDate(dayParam) ? dayParam : monthKey(today) === month ? today : `${month}-01`;
  const hiddenKinds = new Set((searchParams.get("hide") ?? "").split(",").filter(Boolean));

  const weeks = useMemo(() => monthGrid(month), [month]);
  const from = weeks[0]![0]!;
  const to = weeks.at(-1)![6]!;

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.calendar(selectedCompanyId ?? "", from, to),
    queryFn: () => calendarApi.get(selectedCompanyId!, from, to),
    enabled: !!selectedCompanyId,
  });

  const visibleItems = useMemo(
    () => (data?.items ?? []).filter((item) => !hiddenKinds.has(item.kind)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, searchParams.get("hide")],
  );
  const byDate = useMemo(() => groupByDate(visibleItems), [visibleItems]);
  const overdueCount = visibleItems.filter((item) => isOverdue(item, today)).length;
  const monthItemCount = visibleItems.filter((item) => monthKey(item.date) === month).length;
  const monthDays = [...byDate.entries()].filter(([date]) => monthKey(date) === month);
  // Earlier days fold away on phones, except those still holding overdue work.
  const earlierDays = monthDays.filter(([date, items]) => date < today && !items.some((item) => isOverdue(item, today)));
  const phoneDays = showEarlierDays ? monthDays : monthDays.filter((day) => !earlierDays.includes(day));

  function update(next: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(next)) {
      if (value === null) params.delete(key);
      else params.set(key, value);
    }
    setSearchParams(params, { replace: true });
  }

  function addToMyCalendar() {
    const prefix = selectedCompany?.issuePrefix ?? "";
    const monthItems = visibleItems.filter((item) => monthKey(item.date) === month);
    const ics = calendarToIcs(monthItems, {
      calendarName: selectedCompany?.name ? `${selectedCompany.name} calendar` : "Calendar",
      itemUrl: (item) => `${window.location.origin}/${prefix}${calendarItemHref(item)}`,
    });
    downloadTextFile(calendarIcsFileName(prefix, month), ics, "text/calendar;charset=utf-8");
  }

  function toggleKind(kind: CalendarItemKind) {
    const next = new Set(hiddenKinds);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    update({ hide: next.size ? [...next].join(",") : null });
  }

  if (!selectedCompanyId) {
    return <EmptyState icon={CalendarDays} message="Select an organisation to see its calendar." />;
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">Calendar</h1>
          <p className="text-sm text-muted-foreground">
            Task deadlines, routine runs and goal dates in one place. Pick a day to see everything on it.
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            disabled={!data}
            title="Download this month as a calendar file for Outlook, Google Calendar or Apple Calendar"
            onClick={addToMyCalendar}
          >
            <CalendarPlus className="size-4" />
            <span className="hidden sm:inline">Add to my calendar</span>
          </Button>
          <Button size="sm" variant="outline" onClick={() => update({ month: null, day: null })}>
            Today
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Previous month"
            onClick={() => update({ month: shiftMonth(month, -1), day: null })}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Next month"
            onClick={() => update({ month: shiftMonth(month, 1), day: null })}
          >
            <ChevronRight className="size-4" />
          </Button>
          <h2 className="ml-1 min-w-32 text-base font-semibold" aria-live="polite">
            {monthTitle(month)}
          </h2>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Show on the calendar">
        {ALL_KINDS.map((kind) => {
          const Icon = KIND_ICONS[kind];
          const shown = !hiddenKinds.has(kind);
          return (
            <button
              key={kind}
              type="button"
              aria-pressed={shown}
              onClick={() => toggleKind(kind)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                shown ? cn("border-transparent", KIND_CHIP_CLASSES[kind]) : "border-border text-muted-foreground hover:bg-accent",
              )}
            >
              <Icon className="size-3.5" aria-hidden />
              {FILTER_LABELS[kind]}
            </button>
          );
        })}
        {data ? (
          <span className="text-xs text-muted-foreground">
            {monthItemCount === 0 ? "Nothing this month" : `${monthItemCount} this month`}
            {overdueCount > 0 ? (
              <span className="text-status-danger">{` · ${overdueCount} overdue`}</span>
            ) : null}
          </span>
        ) : null}
      </div>

      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : error && !data ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        <>
          <div className="hidden overflow-hidden rounded-md border border-border bg-card md:block">
            <div className="grid grid-cols-7 border-b border-border bg-muted/40">
              {WEEKDAY_LABELS.map((label) => (
                <div key={label} className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                  {label}
                </div>
              ))}
            </div>
            {weeks.map((week) => (
              <div key={week[0]} className="grid grid-cols-7 border-b border-border last:border-b-0">
                {week.map((date) => {
                  const items = byDate.get(date) ?? [];
                  const inMonth = monthKey(date) === month;
                  const selected = date === selectedDay;
                  const extra = items.length - CELL_LIMIT;
                  return (
                    <div
                      key={date}
                      className={cn(
                        "min-h-24 min-w-0 border-r border-border p-1 last:border-r-0",
                        !inMonth && "bg-muted/30",
                        selected && "bg-accent",
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => update({ day: date, month: monthKey(date) === month ? month : monthKey(date) })}
                        aria-label={`${dayTitle(date)}, ${items.length === 0 ? "nothing" : `${items.length} ${items.length === 1 ? "item" : "items"}`}`}
                        aria-pressed={selected}
                        className={cn(
                          "mb-1 flex size-6 items-center justify-center rounded-full text-xs tabular-nums hover:bg-accent-foreground/10",
                          !inMonth && "text-muted-foreground",
                          date === today && "bg-primary font-semibold text-primary-foreground hover:bg-primary",
                        )}
                      >
                        {dayOfMonth(date)}
                      </button>
                      <div className="space-y-0.5">
                        {items.slice(0, CELL_LIMIT).map((item) => (
                          <CalendarChip key={`${item.kind}:${item.id}`} item={item} today={today} />
                        ))}
                        {extra > 0 ? (
                          <button
                            type="button"
                            onClick={() => update({ day: date })}
                            className="px-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
                          >
                            +{extra} more
                          </button>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          {/* Phones: the month as a list of the days that have something on, from today unless asked. */}
          <div className="space-y-5 md:hidden">
            {earlierDays.length > 0 && !showEarlierDays ? (
              <Button size="sm" variant="ghost" className="w-full" onClick={() => setShowEarlierDays(true)}>
                Show {earlierDays.length} earlier {earlierDays.length === 1 ? "day" : "days"}
              </Button>
            ) : null}
            {phoneDays.map(([date, items]) => (
              <DayList key={date} date={date} items={items} today={today} />
            ))}
            {monthItemCount === 0 ? (
              <EmptyState icon={CalendarDays} message={`Nothing is scheduled for ${monthTitle(month)}.`} />
            ) : null}
          </div>

          <div className="hidden md:block">
            <DayList date={selectedDay} items={byDate.get(selectedDay) ?? []} today={today} />
          </div>

          <p className="text-xs text-muted-foreground">
            Give a task a due date and it appears here. Routines show on the days their schedule runs, and goals on
            their target date.
          </p>
        </>
      )}
    </div>
  );
}
