import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  Ban,
  CheckCircle2,
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
import { ErrorState } from "@/components/ErrorState";
import { DecisionFeedCard } from "@/components/decisions-feed/DecisionFeedCard";
import { PageSkeleton } from "@/components/PageSkeleton";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useDecisionsFeed, useNeedsMe } from "@/hooks/useDecisionsFeed";
import {
  buildNeededFromYou,
  neededSummary,
  waitedFor,
  type NeededGroup,
  type NeededGroupId,
} from "@/lib/needed-from-you";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";

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

  const groups = useMemo(
    () => buildNeededFromYou({
      cards: feed.data?.cards ?? [],
      needsMe: needsMe.data,
      clients: pipelinesOn ? clients.data : null,
    }),
    [feed.data, needsMe.data, clients.data, pipelinesOn],
  );

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
        <p className="text-sm text-muted-foreground" data-testid="needed-summary">{neededSummary(groups)}</p>
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
          {groups.map((group) => <NeededGroupCard key={group.id} group={group} decide={decide} />)}
        </div>
      )}
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

function NeededGroupCard({ group, decide }: { group: NeededGroup; decide: DecideContext | null }) {
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
            <li key={item.id} className="flex flex-col gap-2 sm:flex-row sm:items-center">
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
