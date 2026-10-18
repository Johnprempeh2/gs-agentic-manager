import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  Ban,
  Check,
  CheckCircle2,
  ClipboardList,
  Clock,
  Handshake,
  MessageCircleQuestion,
  PlugZap,
  ShieldCheck,
  UserCheck,
  type LucideIcon,
} from "lucide-react";
import type { Agent, DecisionCard, DecisionCardAgentRef } from "@greatstone/shared";
import { agentsApi } from "@/api/agents";
import { authApi } from "@/api/auth";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { pipelinesApi } from "@/api/pipelines";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { BrandCaughtUpMark } from "@/components/BrandPageTitle";
import { DashboardDigestCard } from "@/components/AgentWorkDigest";
import { ErrorState } from "@/components/ErrorState";
import { DecisionFeedCard } from "@/components/decisions-feed/DecisionFeedCard";
import { PageSkeleton } from "@/components/PageSkeleton";
import { SwipeToArchive } from "@/components/SwipeToArchive";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useToastActions } from "@/context/ToastContext";
import { useDecisionsFeed, useNeedsMe } from "@/hooks/useDecisionsFeed";
import { useInboxDismissals } from "@/hooks/useInboxBadge";
import { inboxSnoozeUntilNextWeek, inboxSnoozeUntilTomorrow } from "@/lib/inbox";
import {
  buildNeededFromYou,
  neededLaterKey,
  neededListText,
  neededSummary,
  waitedFor,
  withoutPutAway,
  type NeededGroup,
  type NeededGroupId,
  type NeededItem,
} from "@/lib/needed-from-you";
import { queryKeys } from "@/lib/queryKeys";
import { Link, useActiveCompanyPrefix } from "@/lib/router";
import { applyCompanyPrefix } from "@/lib/company-routes";
import { useCopyAction } from "@/lib/use-copy-action";

/** Rows shown per group before "and N more". */
export const NEEDED_ROWS_PER_GROUP = 3;

const GROUP_ICON: Record<NeededGroupId, LucideIcon> = {
  answer: MessageCircleQuestion,
  "sign-off": ShieldCheck,
  unblock: Ban,
  fix: PlugZap,
  overdue: Clock,
  tasks: UserCheck,
  clients: Handshake,
};

/**
 * "What we need from you": the executive's one page. Everything GSAM and the
 * agents are waiting on the signed-in person for, grouped by what they have to
 * do, in plain words, with the oldest wait up front.
 */
export function NeededFromYou() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Needed from you" }]);
  }, [setBreadcrumbs]);

  const feed = useDecisionsFeed(selectedCompanyId);
  const needsMe = useNeedsMe(selectedCompanyId);
  const { data: settings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  const pipelinesOn = settings?.enablePipelines === true;
  const clients = useQuery({
    queryKey: selectedCompanyId ? queryKeys.pipelines.attention(selectedCompanyId) : ["pipelines", "attention", "none"],
    queryFn: () => pipelinesApi.listAttention(selectedCompanyId!),
    enabled: !!selectedCompanyId && pipelinesOn,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const decide: DecideContext | null = useMemo(() => {
    if (!selectedCompanyId) return null;
    return {
      companyId: selectedCompanyId,
      cards: new Map((feed.data?.cards ?? []).map((card) => [card.id, card])),
      assignableAgents: feed.data?.assignableAgents ?? [],
      agentMap: new Map((agents ?? []).map((agent) => [agent.id, agent])),
      currentUserId: session?.user?.id ?? session?.session?.userId ?? null,
    };
  }, [selectedCompanyId, feed.data, agents, session]);

  const { dismissals, snooze, restore } = useInboxDismissals(selectedCompanyId);
  const { pushToast } = useToastActions();
  // Rows swiped away this visit, hidden at once while the snooze saves.
  const [laterIds, setLaterIds] = useState<ReadonlySet<string>>(new Set());

  const groups = useMemo(() => {
    const all = buildNeededFromYou({
      cards: feed.data?.cards ?? [],
      needsMe: needsMe.data,
      clients: pipelinesOn ? clients.data : null,
    });
    return withoutPutAway(all, dismissals)
      .map((group) => ({ ...group, items: group.items.filter((item) => !laterIds.has(item.id)) }))
      .filter((group) => group.items.length > 0);
  }, [feed.data, needsMe.data, clients.data, pipelinesOn, dismissals, laterIds]);

  const putAwayForLater = useCallback(
    (item: NeededItem) => {
      const itemKey = neededLaterKey(item.id);
      setLaterIds((prev) => new Set(prev).add(item.id));
      snooze(itemKey, inboxSnoozeUntilTomorrow().toISOString());
      pushToast({
        id: `needed-later-${item.id}`,
        title: "Back tomorrow at 08:00",
        body: item.title,
        tone: "info",
        secondaryAction: {
          label: "Next week",
          onClick: () => {
            snooze(itemKey, inboxSnoozeUntilNextWeek().toISOString());
            pushToast({
              id: `needed-later-week-${item.id}`,
              title: "Back Monday at 08:00",
              body: item.title,
              tone: "info",
              action: {
                label: "Undo",
                onClick: () => {
                  setLaterIds((prev) => {
                    const next = new Set(prev);
                    next.delete(item.id);
                    return next;
                  });
                  restore(itemKey);
                },
              },
            });
          },
        },
        action: {
          label: "Undo",
          onClick: () => {
            setLaterIds((prev) => {
              const next = new Set(prev);
              next.delete(item.id);
              return next;
            });
            restore(itemKey);
          },
        },
      });
    },
    [pushToast, restore, snooze],
  );

  const listCopy = useCopyAction();
  const companyPrefix = useActiveCompanyPrefix();

  if (!selectedCompanyId) {
    return <p className="text-sm text-muted-foreground">Select an organisation first.</p>;
  }
  if (feed.isLoading || needsMe.isLoading) return <PageSkeleton variant="approvals" />;

  const error = feed.error ?? needsMe.error;
  return (
    <div className="mx-auto w-full max-w-3xl space-y-5">
      <header className="space-y-1" data-tour="needed-summary">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Needed from you</p>
        <h1 className="text-xl font-bold">What we need from you</h1>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="text-sm text-muted-foreground" data-testid="needed-summary">{neededSummary(groups)}</p>
          {groups.length > 0 ? (
            <Button
              variant="outline"
              size="sm"
              title="Copy everything here as a list with links, ready to paste"
              onClick={() => void listCopy.copy(neededListText(groups, (href) => `${window.location.origin}${applyCompanyPrefix(href, companyPrefix)}`))}
            >
              {listCopy.copied ? <Check className="size-3.5" /> : <ClipboardList className="size-3.5" />}
              {listCopy.copied ? "Copied" : listCopy.failed ? "Could not copy" : "Copy as a list"}
            </Button>
          ) : null}
        </div>
        {groups.length > 1 ? (
          <nav aria-label="Jump to" className="flex flex-wrap gap-2 pt-2" data-tour="needed-groups">
            {groups.map((group) => {
              const Icon = GROUP_ICON[group.id];
              return (
                <a
                  key={group.id}
                  href={`#needed-${group.id}-card`}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-foreground no-underline hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Icon className="size-3.5" aria-hidden="true" />
                  {group.title}
                  <span className="tabular-nums text-muted-foreground">{group.items.length}</span>
                </a>
              );
            })}
          </nav>
        ) : null}
      </header>

      {error ? (
        <ErrorState
          error={error}
          onRetry={() => { void feed.refetch(); void needsMe.refetch(); }}
          compact
        />
      ) : null}
      {clients.error ? (
        <p className="text-sm text-destructive">Could not load client cases waiting on you. The rest of this page is up to date.</p>
      ) : null}

      {groups.length === 0 && !error ? <AllClear /> : (
        <div className="space-y-4">
          {groups.map((group) => <NeededGroupCard key={group.id} group={group} decide={decide} onLater={putAwayForLater} />)}
        </div>
      )}

      <section aria-label="Meanwhile" className="space-y-2" data-testid="needed-meanwhile" data-tour="needed-meanwhile">
        <h2 className="text-sm font-semibold text-muted-foreground">Meanwhile, the team got on with</h2>
        <DashboardDigestCard companyId={selectedCompanyId} />
      </section>
    </div>
  );
}

/** What a row needs to open its Decisions card in place. */
interface DecideContext {
  companyId: string;
  cards: Map<string, DecisionCard>;
  assignableAgents: DecisionCardAgentRef[];
  agentMap: Map<string, Agent>;
  currentUserId: string | null;
}

function NeededGroupCard({
  group,
  decide,
  onLater,
}: {
  group: NeededGroup;
  decide: DecideContext | null;
  onLater: (item: NeededItem) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const Icon = GROUP_ICON[group.id];
  const shown = group.items.slice(0, NEEDED_ROWS_PER_GROUP);
  const more = group.items.length - shown.length;
  const titleId = `needed-${group.id}`;
  return (
    <Card className="scroll-mt-4 gap-3 px-4 py-4" id={`${titleId}-card`} role="region" aria-labelledby={titleId} data-testid={`needed-group-${group.id}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 gap-3">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-foreground">
            <Icon className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 space-y-0.5">
            <h2 id={titleId} className="flex items-center gap-2 text-base font-semibold">
              {group.title}
              <span className="gs-count-pill text-xs tabular-nums text-muted-foreground">{group.items.length}</span>
            </h2>
            <p className="text-sm text-muted-foreground">{group.explain}</p>
          </div>
        </div>
        <Button asChild size="sm" variant="outline" className="shrink-0 self-start">
          <Link to={group.allHref}>
            {group.allLabel}
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </Link>
        </Button>
      </div>
      <ul className="divide-y divide-border rounded-md border border-border">
        {shown.map((item) => {
          const card = item.cardId ? decide?.cards.get(item.cardId) : undefined;
          if (card && decide && openId === item.id) {
            return (
              <li key={item.id} className="space-y-2 p-2" data-testid={`needed-decide-${item.id}`}>
                <DecisionFeedCard
                  card={card}
                  companyId={decide.companyId}
                  assignableAgents={decide.assignableAgents}
                  agentMap={decide.agentMap}
                  currentUserId={decide.currentUserId}
                />
                <Button type="button" size="sm" variant="ghost" onClick={() => setOpenId(null)}>
                  Close
                </Button>
              </li>
            );
          }
          return (
            <li key={item.id}>
              <SwipeToArchive onSnooze={() => onLater(item)} surfaceClassName="bg-card">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <Link
                    to={item.href}
                    className="flex min-w-0 flex-1 flex-col gap-0.5 px-3 py-2.5 text-inherit no-underline hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="line-clamp-2 text-sm font-medium text-foreground">{item.title}</span>
                    {item.reason ? <span className="line-clamp-2 text-sm text-muted-foreground">{item.reason}</span> : null}
                    {item.since ? (
                      <span className="text-xs text-muted-foreground">
                        {item.waiting ? `${item.waiting} has waited` : "Waiting"} {waitedFor(Date.now() - new Date(item.since).getTime())}
                      </span>
                    ) : null}
                  </Link>
                  {card ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="mx-3 mb-2.5 shrink-0 self-start sm:mb-0 sm:self-center"
                      onClick={() => setOpenId(item.id)}
                      aria-label={`Act on ${item.title} here`}
                    >
                      Act here
                    </Button>
                  ) : null}
                </div>
              </SwipeToArchive>
            </li>
          );
        })}
      </ul>
      {more > 0 ? (
        <p className="text-xs text-muted-foreground">
          and {more} more. <Link to={group.allHref} className="underline underline-offset-2">{group.allLabel}</Link>
        </p>
      ) : null}
    </Card>
  );
}

function AllClear() {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-16 text-center">
      <BrandCaughtUpMark />
      <p className="flex items-center gap-2 text-lg font-semibold text-foreground">
        <CheckCircle2 className="size-5" aria-hidden="true" />
        You are all caught up
      </p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        When an agent needs a question answered, a sign-off or a login fixed, it shows up here first.
      </p>
    </div>
  );
}
