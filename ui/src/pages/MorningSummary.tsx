import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import type { MorningSummary as MorningSummaryData, MorningSummaryHandoff, MorningSummaryTask } from "@greatstone/shared";
import { Activity, AlertTriangle, Bookmark, Briefcase, CalendarClock, Check, CircleCheck, ClipboardList, Handshake, Sun, UserCheck, type LucideIcon } from "lucide-react";
import { morningSummaryApi } from "../api/notificationPreferences";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useNeedsMe } from "../hooks/useDecisionsFeed";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { PageSkeleton } from "../components/PageSkeleton";
import { PauseNotifications } from "../components/PauseNotifications";
import { queryKeys } from "../lib/queryKeys";
import { Link, useSearchParams } from "@/lib/router";
import { cn, formatCalendarDay, relativeTime } from "@/lib/utils";
import { morningSummarySpeech, morningSummaryText } from "@/lib/morning-summary-text";
import { needsYouAsks, type NeedsYouAsk } from "@/lib/needs-you-rows";
import { ListenButton } from "../components/ListenButton";
import { ShareTextButton } from "../components/ShareTextButton";
import { useCopyAction } from "@/lib/use-copy-action";
import { Button } from "@/components/ui/button";

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

/**
 * Where you left off (GRE-2668): your live handoff, the one Claude Code,
 * ChatGPT and GSAM share. Shown only when you have one. It is private, so it
 * stays out of "Copy as an update".
 */
function HandoffSection({ handoff, since }: { handoff: MorningSummaryHandoff; since: string }) {
  return (
    <section className="space-y-2 rounded-lg border border-border bg-card p-4" data-tour="morning-where-you-left-off">
      <div className="flex items-center gap-2">
        <Bookmark className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h2 className="text-base font-semibold">Where you left off</h2>
        {handoff.changesSince > 0 ? (
          <span className="ml-auto text-xs text-muted-foreground">{handoff.changesSince} {handoff.changesSince === 1 ? "change" : "changes"} {since}</span>
        ) : null}
      </div>
      {handoff.focus ? (
        <p className="text-sm">
          <span className="font-medium">Focus: </span>
          {handoff.focus.text}
        </p>
      ) : null}
      {handoff.threads.length > 0 ? (
        <ul className="divide-y divide-border">
          {handoff.threads.map((thread) => (
            <li key={thread.key} className="space-y-0.5 py-2 text-sm">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate">{thread.title || thread.refs.join(", ")}</span>
                {thread.refs[0] ? (
                  <Link to={`/issues/${thread.refs[0]}`} className="shrink-0 text-xs text-muted-foreground hover:underline">{thread.refs.join(", ")}</Link>
                ) : null}
              </div>
              {thread.state || thread.next ? (
                <p className="text-xs text-muted-foreground">
                  {[thread.state, thread.next ? `next: ${thread.next}` : ""].filter(Boolean).join(" · ")}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {handoff.threadCount > handoff.threads.length ? (
        <p className="text-xs text-muted-foreground">and {handoff.threadCount - handoff.threads.length} more threads</p>
      ) : null}
      {handoff.lastTool ? (
        <p className="text-xs text-muted-foreground">
          Last: {handoff.lastTool.by}, {relativeTime(handoff.lastTool.at)}: {handoff.lastTool.doing}
        </p>
      ) : null}
    </section>
  );
}

/** Client deals won or lost in the window. Shown only when there were some. */
function DealsSection({ deals, since }: { deals: NonNullable<MorningSummaryData["deals"]>; since: string }) {
  const total = deals.won + deals.lost;
  if (total === 0) return null;
  const counts = [deals.won > 0 ? `${deals.won} won` : null, deals.lost > 0 ? `${deals.lost} lost` : null].filter(Boolean).join(", ");
  return (
    <section className="space-y-2 rounded-lg border border-border bg-card p-4" data-tour="morning-deals" data-testid="morning-deals">
      <div className="flex items-center gap-2">
        <Handshake className={cn("size-4 shrink-0 text-muted-foreground", deals.won > 0 && "text-status-success")} aria-hidden />
        <h2 className="text-base font-semibold">Deals {since}</h2>
        <span className="ml-auto text-sm font-medium text-muted-foreground">{counts}</span>
      </div>
      <ul className="divide-y divide-border">
        {deals.items.map((deal) => (
          <li key={deal.id}>
            <Link to={`/pipelines/${deal.pipelineId}/cases/${deal.id}`} className="flex min-h-11 items-center gap-2 py-2 text-sm hover:underline">
              <span className="min-w-0 flex-1 truncate">{deal.title}</span>
              <span className={cn("shrink-0 text-xs font-medium", deal.outcome === "won" ? "text-status-success" : "text-muted-foreground")}>
                {deal.outcome === "won" ? "Won" : "Lost"}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Today's date on this device as YYYY-MM-DD. */
function localToday(now: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * A Needs you line: what kind of ask it is and the ask itself first, then the
 * task on up to two lines, so a review, a question and a confirmation read
 * differently at a glance. It opens the request itself where there is one.
 */
function NeedsYouLine({ item, ask }: { item: MorningSummaryTask; ask: NeedsYouAsk | undefined }) {
  const prompt = ask?.prompt && ask.prompt !== item.title ? ask.prompt : null;
  return (
    <Link
      to={ask?.href ?? item.href ?? `/issues/${item.identifier ?? item.id}`}
      className="flex min-h-11 flex-col gap-1 py-2 text-sm hover:underline"
      data-needs-you-line
    >
      {ask || item.identifier ? (
        <span className="flex items-center gap-2">
          {ask ? (
            <span className="rounded-full border border-border bg-accent px-2 py-0.5 text-xs font-medium text-foreground" data-needs-you-action>
              {ask.action}
            </span>
          ) : null}
          {item.identifier ? <span className="ml-auto shrink-0 text-xs text-muted-foreground">{item.identifier}</span> : null}
        </span>
      ) : null}
      {prompt ? <span className="line-clamp-2 font-medium leading-snug">{prompt}</span> : null}
      <span className={cn("line-clamp-2 leading-snug", prompt && "text-muted-foreground")}>{item.title}</span>
    </Link>
  );
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
  asks,
}: {
  icon: LucideIcon;
  title: string;
  count: number;
  empty: string;
  items: MorningSummaryTask[];
  more: { label: string; to: string };
  tone?: "attention" | "danger" | "success";
  today?: string;
  /** Set on Needs you: each line then says what it asks of you. */
  asks?: Map<string, NeedsYouAsk>;
}) {
  return (
    <section
      className="space-y-2 rounded-lg border border-border bg-card p-4"
      data-tour={`morning-${title.toLowerCase().replace(/[^a-z]+/g, "-")}`}
    >
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
              {asks ? <NeedsYouLine item={item} ask={asks.get(item.id)} /> : <Link to={item.href ?? `/issues/${item.identifier ?? item.id}`} className="flex min-h-11 items-center gap-2 py-2 text-sm hover:underline">
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                {today && lateLabel(item.dueDate, today) ? (
                  <span className="shrink-0 text-xs font-medium text-status-danger">{lateLabel(item.dueDate, today)}</span>
                ) : null}
                {item.identifier ? <span className="shrink-0 text-xs text-muted-foreground">{item.identifier}</span> : null}
              </Link>}
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
 * the agents are working on now, what they finished since yesterday, and what
 * is stuck. It is the landing page on a phone and the morning notification opens here, so it reads well
 * on a phone first.
 */
export function MorningSummary() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const dayCopy = useCopyAction();
  // The evening wrap-up opens "Today so far" (?window=day): counted from the
  // start of the person's day instead of the last 24 hours.
  const [searchParams] = useSearchParams();
  const hours = searchParams.get("window") === "day" ? "day" : "24h";
  const since = hours === "day" ? "today" : "since yesterday";

  useEffect(() => {
    setBreadcrumbs([{ label: "Today" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.morningSummary(selectedCompanyId ?? "", hours),
    queryFn: () => morningSummaryApi.get(selectedCompanyId!, hours),
    enabled: !!selectedCompanyId,
  });
  // The same data Desk shows; the layout already loads it, so this is no extra call.
  const needsMe = useNeedsMe(selectedCompanyId);

  if (!selectedCompanyId) return <EmptyState icon={Sun} message="Select an organisation to see your morning summary." />;
  if (isLoading) return <PageSkeleton variant="detail" />;
  if (error || !data) return <ErrorState error={error} title="Could not load your morning summary" onRetry={() => void refetch()} />;

  const now = new Date();
  // Older servers do not send this section yet.
  const dueToday = data.dueToday ?? { count: 0, items: [] };

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4">
      <header className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-xl font-semibold">{greeting(now)}</h1>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <ListenButton getParts={() => morningSummarySpeech(data, localToday(now), greeting(now), since)} />
            <Button
              variant="outline"
              size="sm"
              title="Copy today as text, ready to paste into a message"
              onClick={() => void dayCopy.copy(morningSummaryText(data, localToday(now), since))}
            >
              {dayCopy.copied ? <Check className="size-3.5" /> : <ClipboardList className="size-3.5" />}
              {dayCopy.copied ? "Copied" : dayCopy.failed ? "Could not copy" : "Copy as an update"}
            </Button>
            <ShareTextButton title={`Today, ${formatCalendarDay(localToday(now))}`} getText={() => morningSummaryText(data, localToday(now), since)} />
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          {data.needsYou.count === 0
            ? `Nothing needs you right now. Here is what the team did ${since}.`
            : `Start with what needs you. Then see what the team did ${since}.`}
        </p>
        <nav className="flex gap-2 text-sm" aria-label="Which hours to show">
          {hours === "day" ? (
            <>
              <span className="font-medium" aria-current="page">Today so far</span>
              <Link to="/morning" className="text-muted-foreground underline underline-offset-2">Since yesterday</Link>
            </>
          ) : (
            <>
              <span className="font-medium" aria-current="page">Since yesterday</span>
              <Link to="/morning?window=day" className="text-muted-foreground underline underline-offset-2">Today so far</Link>
            </>
          )}
        </nav>
      </header>

      <PauseNotifications companyId={selectedCompanyId} compact />

      {data.handoff ? <HandoffSection handoff={data.handoff} since={since} /> : null}

      <Section
        icon={UserCheck}
        title="Needs you"
        count={data.needsYou.count}
        empty="Nothing is waiting on you."
        items={data.needsYou.items}
        more={{ label: "Open Decisions", to: "/decisions" }}
        tone="attention"
        asks={needsYouAsks(needsMe.data)}
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
      {data.dueTomorrow ? (
        <Section
          icon={CalendarClock}
          title="Due tomorrow"
          count={data.dueTomorrow.count}
          empty="Nothing is due tomorrow."
          items={data.dueTomorrow.items}
          more={{ label: "Open the calendar", to: "/calendar" }}
          tone="attention"
        />
      ) : null}
      {data.dealNextSteps && data.dealNextSteps.count > 0 ? (
        <Section
          icon={Briefcase}
          title="Deal next steps due"
          count={data.dealNextSteps.count}
          empty="No deal has a next step due."
          items={data.dealNextSteps.items}
          more={{ label: "Open pipelines", to: "/pipelines" }}
          tone="danger"
          today={localToday(now)}
        />
      ) : null}
      {data.workingNow ? (
        <Section
          icon={Activity}
          title="Working now"
          count={data.workingNow.count}
          empty="No agent is working on a task right now."
          items={data.workingNow.items}
          more={{ label: "See all tasks", to: "/issues" }}
          tone="success"
        />
      ) : null}
      <Section
        icon={CircleCheck}
        title={`Finished ${since}`}
        count={data.finished.count}
        empty={hours === "day" ? "No tasks finished today yet." : "No tasks finished in the last 24 hours."}
        items={data.finished.items}
        more={{ label: "See the scorecard", to: "/scorecard" }}
        tone="success"
      />
      {data.deals ? <DealsSection deals={data.deals} since={since} /> : null}
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
