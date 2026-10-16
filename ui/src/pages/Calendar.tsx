import { useEffect, useMemo, useState, type DragEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CompanyCalendar, CalendarItem, CalendarItemKind } from "@greatstone/shared";
import { CalendarClock, CalendarDays, CalendarPlus, Check, ChevronLeft, ChevronRight, CircleCheck, ClipboardList, Repeat, Target } from "lucide-react";
import { calendarApi } from "../api/calendar";
import { issuesApi } from "../api/issues";
import { useToastActions } from "../context/ToastContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { PageSkeleton } from "../components/PageSkeleton";
import { queryKeys } from "../lib/queryKeys";
import {
  CALENDAR_KIND_LABELS,
  addDays,
  WEEKDAY_LABELS,
  calendarItemHref,
  canReschedule,
  rescheduleOptions,
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
  weekOf,
  weekTitle,
} from "../lib/calendar";
import { calendarIcsFileName, calendarToIcs } from "../lib/calendar-ics";
import { weekAheadText } from "../lib/calendar-text";
import { useCopyAction } from "../lib/use-copy-action";
import { downloadTextFile } from "../lib/issues-csv";
import { Link, useSearchParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
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

/** Drag data type for a task chip moved to another day. */
const TASK_DRAG_TYPE = "application/x-gsam-calendar-task";

function CalendarChip({ item, today }: { item: CalendarItem; today: string }) {
  const Icon = KIND_ICONS[item.kind];
  const movable = canReschedule(item);
  return (
    <Link
      to={calendarItemHref(item)}
      title={movable ? `${item.title}. Drag to another day to change the due date.` : item.title}
      draggable={movable}
      onDragStart={
        movable
          ? (event) => {
              event.dataTransfer.setData(TASK_DRAG_TYPE, JSON.stringify({ id: item.id, date: item.date }));
              event.dataTransfer.effectAllowed = "move";
            }
          : undefined
      }
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

function MoveTaskMenu({ item, today, onMove }: { item: CalendarItem; today: string; onMove: (id: string, date: string) => void }) {
  const options = rescheduleOptions(item.date, today);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="mr-2 mt-1.5 shrink-0" aria-label={`Change the due date of ${item.title}`} title="Change the due date">
          <CalendarClock className="size-4" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Move the due date to</DropdownMenuLabel>
        {options.map((option) => (
          <DropdownMenuItem key={option.date} onSelect={() => onMove(item.id, option.date)}>
            {option.label}
            <span className="ml-auto pl-3 text-xs text-muted-foreground">{dayTitle(option.date)}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DayList({
  date,
  items,
  today,
  onMove,
}: {
  date: string;
  items: CalendarItem[];
  today: string;
  onMove: (id: string, date: string) => void;
}) {
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
              <li key={`${item.kind}:${item.id}:${item.date}`} className="flex items-start">
                <Link to={calendarItemHref(item)} className="flex min-w-0 flex-1 items-start gap-3 px-3 py-2 hover:bg-accent">
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
                {canReschedule(item) ? <MoveTaskMenu item={item} today={today} onMove={onMove} /> : null}
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
  const [dropDate, setDropDate] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const today = localToday();

  useEffect(() => {
    setBreadcrumbs([{ label: "Calendar" }]);
  }, [setBreadcrumbs]);

  const monthParam = searchParams.get("month");
  const month = isMonthKey(monthParam) ? monthParam : monthKey(today);
  const dayParam = searchParams.get("day");
  const selectedDay = isIsoDate(dayParam) ? dayParam : monthKey(today) === month ? today : `${month}-01`;
  const hiddenKinds = new Set((searchParams.get("hide") ?? "").split(",").filter(Boolean));

  // Week view shows one row with every item; phones keep the month list.
  const view = searchParams.get("view") === "week" ? "week" : "month";
  const weeks = useMemo(() => monthGrid(month), [month]);
  const selectedWeek = useMemo(() => weekOf(selectedDay), [selectedDay]);
  const gridWeeks = view === "week" ? [selectedWeek] : weeks;
  const from = weeks[0]![0]!;
  const to = weeks.at(-1)![6]!;

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.calendar(selectedCompanyId ?? "", from, to),
    queryFn: () => calendarApi.get(selectedCompanyId!, from, to),
    enabled: !!selectedCompanyId,
  });

  const calendarKey = queryKeys.calendar(selectedCompanyId ?? "", from, to);
  const reschedule = useMutation({
    mutationFn: ({ id, date }: { id: string; date: string }) => issuesApi.update(id, { dueDate: date }),
    onMutate: async ({ id, date }) => {
      await queryClient.cancelQueries({ queryKey: calendarKey });
      const previous = queryClient.getQueryData<CompanyCalendar>(calendarKey);
      if (previous) {
        queryClient.setQueryData<CompanyCalendar>(calendarKey, {
          ...previous,
          items: previous.items.map((item) => (item.kind === "task" && item.id === id ? { ...item, date } : item)),
        });
      }
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(calendarKey, context.previous);
      pushToast({ title: "Could not change the due date", body: err instanceof Error ? err.message : undefined, tone: "error" });
    },
    onSuccess: (_issue, { date }) => {
      pushToast({ title: `Due date moved to ${dayTitle(date)}`, tone: "success" });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["calendar", selectedCompanyId ?? ""] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId ?? "") });
    },
  });

  // Several due dates at once: "Move to today" for overdue tasks, and its undo.
  const moveMany = useMutation({
    mutationFn: async (moves: ReadonlyArray<{ id: string; date: string }>) => {
      const results = await Promise.allSettled(moves.map(({ id, date }) => issuesApi.update(id, { dueDate: date })));
      return results.filter((result) => result.status === "fulfilled").length;
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["calendar", selectedCompanyId ?? ""] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId ?? "") });
    },
  });

  function moveTask(id: string, date: string) {
    reschedule.mutate({ id, date });
  }

  function dropTask(event: DragEvent, date: string) {
    setDropDate(null);
    const raw = event.dataTransfer.getData(TASK_DRAG_TYPE);
    if (!raw) return;
    event.preventDefault();
    try {
      const dragged = JSON.parse(raw) as { id: string; date: string };
      if (dragged.date !== date) reschedule.mutate({ id: dragged.id, date });
    } catch {
      // Not one of our chips.
    }
  }

  const visibleItems = useMemo(
    () => (data?.items ?? []).filter((item) => !hiddenKinds.has(item.kind)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, searchParams.get("hide")],
  );
  const byDate = useMemo(() => groupByDate(visibleItems), [visibleItems]);
  const overdueCount = visibleItems.filter((item) => isOverdue(item, today)).length;
  const overdueTasks = visibleItems.filter((item) => canReschedule(item) && isOverdue(item, today));

  function moveOverdueToToday() {
    const originals = overdueTasks.map((item) => ({ id: item.id, date: item.date }));
    const total = originals.length;
    moveMany.mutate(
      originals.map(({ id }) => ({ id, date: today })),
      {
        onSuccess: (moved) => {
          if (moved === 0) {
            pushToast({ title: "Could not change the due dates", body: "Try again in a moment.", tone: "error" });
            return;
          }
          pushToast({
            title:
              moved === total
                ? `${moved === 1 ? "1 overdue task" : `${moved} overdue tasks`} now due today`
                : `${moved} of ${total} overdue tasks now due today`,
            body: moved === total ? undefined : "The others could not be changed. Try them one by one.",
            tone: moved === total ? "success" : "warn",
            ttlMs: 10_000,
            action: {
              label: "Undo",
              onClick: () =>
                moveMany.mutate(originals, {
                  onSuccess: () => pushToast({ title: "Due dates put back", tone: "success" }),
                }),
            },
          });
        },
        onError: (err) =>
          pushToast({ title: "Could not change the due dates", body: err instanceof Error ? err.message : undefined, tone: "error" }),
      },
    );
  }
  const monthItemCount = visibleItems.filter((item) => monthKey(item.date) === month).length;
  const weekItemCount = visibleItems.filter((item) => selectedWeek.includes(item.date)).length;
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

  const weekCopy = useCopyAction();
  async function copyWeekAhead() {
    const weekEnd = addDays(today, 6);
    // Use the loaded month when it covers the week, so the copy stays inside the click.
    const items =
      data && from <= today && weekEnd <= to
        ? data.items
        : (
            await queryClient.fetchQuery({
              queryKey: queryKeys.calendar(selectedCompanyId!, today, weekEnd),
              queryFn: () => calendarApi.get(selectedCompanyId!, today, weekEnd),
            })
          ).items;
    await weekCopy.copy(
      weekAheadText(
        items.filter((item) => !hiddenKinds.has(item.kind)),
        { from: today, timeZone: viewerTimeZone() },
      ),
    );
  }

  function moveWeek(days: number) {
    const day = addDays(selectedDay, days);
    update({ day, month: monthKey(day) });
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
            data-tour="calendar-add"
            onClick={addToMyCalendar}
          >
            <CalendarPlus className="size-4" />
            <span className="hidden sm:inline">Add to my calendar</span>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!selectedCompanyId}
            title="Copy the next 7 days as text to paste into an email or chat"
            data-tour="calendar-copy-week"
            aria-label={weekCopy.copied ? "Copied" : "Copy the week ahead"}
            onClick={() =>
              void copyWeekAhead().catch((err) =>
                pushToast({ title: "Could not load the week ahead", body: err instanceof Error ? err.message : undefined, tone: "error" }),
              )
            }
          >
            {weekCopy.copied ? <Check className="size-4" /> : <ClipboardList className="size-4" />}
            <span className="hidden sm:inline">
              {weekCopy.copied ? "Copied" : weekCopy.failed ? "Could not copy" : "Copy the week ahead"}
            </span>
          </Button>
          <Button size="sm" variant="outline" onClick={() => update({ month: null, day: null })}>
            Today
          </Button>
          <div className="hidden rounded-md border border-border bg-card p-0.5 md:inline-flex" role="group" aria-label="View" data-tour="calendar-view">
            {(["month", "week"] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={view === option}
                onClick={() => update({ view: option === "month" ? null : option })}
                className={cn(
                  "rounded-sm px-2.5 py-1 text-xs font-medium transition-colors",
                  view === option ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {option === "month" ? "Month" : "Week"}
              </button>
            ))}
          </div>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={view === "week" ? "Previous week" : "Previous month"}
            onClick={() => (view === "week" ? moveWeek(-7) : update({ month: shiftMonth(month, -1), day: null }))}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={view === "week" ? "Next week" : "Next month"}
            onClick={() => (view === "week" ? moveWeek(7) : update({ month: shiftMonth(month, 1), day: null }))}
          >
            <ChevronRight className="size-4" />
          </Button>
          <h2 className="ml-1 min-w-32 text-base font-semibold" aria-live="polite">
            <span className={cn(view === "week" && "md:hidden")}>{monthTitle(month)}</span>
            {view === "week" ? <span className="hidden md:inline">{weekTitle(selectedWeek)}</span> : null}
          </h2>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Show on the calendar" data-tour="calendar-filters">
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
            <span className={cn(view === "week" && "md:hidden")}>
              {monthItemCount === 0 ? "Nothing this month" : `${monthItemCount} this month`}
            </span>
            {view === "week" ? (
              <span className="hidden md:inline">
                {weekItemCount === 0 ? "Nothing this week" : `${weekItemCount} this week`}
              </span>
            ) : null}
            {overdueCount > 0 ? (
              <span className="text-status-danger">{` · ${overdueCount} overdue`}</span>
            ) : null}
          </span>
        ) : null}
        {data && overdueTasks.length > 0 ? (
          <Button
            size="sm"
            variant="outline"
            disabled={moveMany.isPending}
            title="Give every overdue task in view a due date of today. You can undo this."
            onClick={moveOverdueToToday}
          >
            <CalendarClock className="size-3.5" aria-hidden />
            {moveMany.isPending
              ? "Moving…"
              : overdueTasks.length === 1
                ? "Move the overdue task to today"
                : `Move ${overdueTasks.length} overdue tasks to today`}
          </Button>
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
            {gridWeeks.map((week) => (
              <div key={week[0]} className="grid grid-cols-7 border-b border-border last:border-b-0">
                {week.map((date) => {
                  const items = byDate.get(date) ?? [];
                  const inMonth = monthKey(date) === month;
                  const selected = date === selectedDay;
                  const limit = view === "week" ? items.length : CELL_LIMIT;
                  const extra = items.length - limit;
                  return (
                    <div
                      key={date}
                      onDragOver={(event) => {
                        if (!event.dataTransfer.types.includes(TASK_DRAG_TYPE)) return;
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "move";
                        if (dropDate !== date) setDropDate(date);
                      }}
                      onDragLeave={() => setDropDate((current) => (current === date ? null : current))}
                      onDrop={(event) => dropTask(event, date)}
                      className={cn(
                        "min-w-0 border-r border-border p-1 last:border-r-0",
                        view === "week" ? "min-h-48" : "min-h-24",
                        view === "month" && !inMonth && "bg-muted/30",
                        selected && "bg-accent",
                        dropDate === date && "bg-accent ring-2 ring-inset ring-primary",
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
                        {items.slice(0, limit).map((item) => (
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
              <DayList key={date} date={date} items={items} today={today} onMove={moveTask} />
            ))}
            {monthItemCount === 0 ? (
              <EmptyState icon={CalendarDays} message={`Nothing is scheduled for ${monthTitle(month)}.`} />
            ) : null}
          </div>

          <div className="hidden md:block">
            <DayList date={selectedDay} items={byDate.get(selectedDay) ?? []} today={today} onMove={moveTask} />
          </div>

          <p className="text-xs text-muted-foreground">
            Give a task a due date and it appears here. Drag a task to another day to change its due date. Routines show on the days their schedule runs, and goals on
            their target date.
          </p>
        </>
      )}
    </div>
  );
}
