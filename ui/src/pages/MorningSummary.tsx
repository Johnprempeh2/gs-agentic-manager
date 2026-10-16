import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import type { MorningSummaryTask } from "@greatstone/shared";
import { AlertTriangle, CalendarClock, CircleCheck, Sun, UserCheck, type LucideIcon } from "lucide-react";
import { morningSummaryApi } from "../api/notificationPreferences";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { PageSkeleton } from "../components/PageSkeleton";
import { queryKeys } from "../lib/queryKeys";
import { Link } from "@/lib/router";
import { cn, formatCalendarDay } from "@/lib/utils";

/** "Good morning", "Good afternoon" or "Good evening" by the person's own clock. */
export function greeting(now: Date) {
  const hour = now.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/** "Late, due 14 Oct" for a line due before today; nothing for one due today. */
export function lateLabel(dueDate: string | null | undefined, today: string) {
  return dueDate && dueDate < today ? `Late, due ${formatCalendarDay(dueDate)}` : null;
}

/** Today's date on this device as YYYY-MM-DD. */
function localToday(now: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function Section({
  icon: Icon,
  title,
  count,
  empty,
  items,
  more,
  tone,
  today,
}: {
  icon: LucideIcon;
  title: string;
  count: number;
  empty: string;
  items: MorningSummaryTask[];
  more: { label: string; to: string };
  tone?: "attention" | "danger" | "success";
  today?: string;
}) {
  return (
    <section className="space-y-2 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <Icon
          className={cn(
            "size-4 shrink-0 text-muted-foreground",
            tone === "attention" && count > 0 && "text-primary",
            tone === "danger" && count > 0 && "text-status-danger",
            tone === "success" && count > 0 && "text-status-success",
          )}
          aria-hidden
        />
        <h2 className="text-base font-semibold">{title}</h2>
        <span className="ml-auto text-2xl font-semibold tabular-nums">{count}</span>
      </div>
      {count === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((item) => (
            <li key={item.id}>
              <Link to={`/issues/${item.identifier ?? item.id}`} className="flex min-h-11 items-center gap-2 py-2 text-sm hover:underline">
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                {today && lateLabel(item.dueDate, today) ? (
                  <span className="shrink-0 text-xs font-medium text-status-danger">{lateLabel(item.dueDate, today)}</span>
                ) : null}
                {item.identifier ? <span className="shrink-0 text-xs text-muted-foreground">{item.identifier}</span> : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {count > 0 ? (
        <Link to={more.to} className="inline-flex min-h-11 items-center text-sm font-medium text-primary hover:underline">
          {count > items.length ? `See all ${count}` : more.label}
        </Link>
      ) : null}
    </section>
  );
}

/**
 * Today (also the morning summary): what needs you, what is due today, what
 * the agents finished since yesterday, and what is stuck. It is the landing
 * page on a phone and the morning notification opens here, so it reads well
 * on a phone first.
 */
export function MorningSummary() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Today" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.morningSummary(selectedCompanyId ?? ""),
    queryFn: () => morningSummaryApi.get(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) return <EmptyState icon={Sun} message="Select an organisation to see your morning summary." />;
  if (isLoading) return <PageSkeleton variant="detail" />;
  if (error || !data) return <ErrorState error={error} title="Could not load your morning summary" onRetry={() => void refetch()} />;

  const now = new Date();
  // Older servers do not send this section yet.
  const dueToday = data.dueToday ?? { count: 0, items: [] };

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">{greeting(now)}</h1>
        <p className="text-sm text-muted-foreground">
          {data.needsYou.count === 0
            ? "Nothing needs you right now. Here is what the team did since yesterday."
            : "Start with what needs you. Then see what the team did since yesterday."}
        </p>
      </header>

      <Section
        icon={UserCheck}
        title="Needs you"
        count={data.needsYou.count}
        empty="Nothing is waiting on you."
        items={data.needsYou.items}
        more={{ label: "Open Decisions", to: "/decisions" }}
        tone="attention"
      />
      <Section
        icon={CalendarClock}
        title="Due today"
        count={dueToday.count}
        empty="Nothing is due today."
        items={dueToday.items}
        more={{ label: "Open the calendar", to: "/calendar" }}
        tone="danger"
        today={localToday(now)}
      />
      <Section
        icon={CircleCheck}
        title="Finished since yesterday"
        count={data.finished.count}
        empty="No tasks finished in the last 24 hours."
        items={data.finished.items}
        more={{ label: "See the scorecard", to: "/scorecard" }}
        tone="success"
      />
      <Section
        icon={AlertTriangle}
        title="Stuck"
        count={data.stuck.count}
        empty="Nothing is stuck."
        items={data.stuck.items}
        more={{ label: "See what is blocked", to: "/inbox/blocked" }}
        tone="danger"
      />

      <p className="text-xs text-muted-foreground">
        You get this on your phone each morning. <Link to="/notifications" className="underline underline-offset-2">Change the time or turn it off</Link>.
      </p>
    </div>
  );
}
