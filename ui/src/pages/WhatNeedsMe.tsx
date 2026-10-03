import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { activityApi } from "../api/activity";
import { DecisionLog, DECISION_LOG_ACTIONS } from "../components/decisions-feed/DecisionLog";
import { BrandCaughtUpMark, BrandPageTitle } from "../components/BrandPageTitle";
import type { Agent, AttentionItem, AttentionSubject } from "@greatstone/shared";
import { attentionApi } from "../api/attention";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { decisionsApi } from "../api/decisions";
import { useCompany } from "../context/CompanyContext";
import { DecisionNotificationsCard } from "../components/decisions-feed/DecisionNotificationsCard";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useInboxDismissals } from "../hooks/useInboxBadge";
import { useDecisionsFeed, useNeedsMe } from "../hooks/useDecisionsFeed";
import { NeedsMeList } from "../components/NeedsMeList";
import { queryKeys } from "../lib/queryKeys";
import { PageSkeleton } from "../components/PageSkeleton";
import { AttentionQueueRow } from "../components/AttentionQueueRow";
import { Curtain } from "../components/DecisionShelf";
import { DecisionQueueRail } from "../components/DecisionQueueRail";
import { DecisionResolver } from "../components/DecisionResolver";
import { DecisionsFocusView } from "../components/decisions-focus/DecisionsFocusView";
import { DecisionFeedCard } from "../components/decisions-feed/DecisionFeedCard";
import { TabledList, useTabledIssues } from "../components/decisions-feed/TabledList";
import { ToggleSwitch } from "../components/ui/toggle-switch";
import {
  loadDecisionsView,
  loadFocusPrefs,
  saveDecisionsView,
  saveFocusPrefs,
  type DecisionsView,
  type FocusPrefs,
} from "../lib/focus-prefs";
import { cn } from "../lib/utils";
import { ErrorState } from "../components/ErrorState";
import { AtDeskGroup, splitAtDeskCards } from "../components/decisions-feed/AtDeskGroup";
import { useIsPhone } from "../hooks/useIsPhone";

/** Curtain rows never expand; module-level so memoized rows see one identity. */
const noopToggleExpand = () => {};

const DECISION_HISTORY_VISIBLE_LIMIT = 50;
const DECISION_HISTORY_QUERY_LIMIT = DECISION_HISTORY_VISIBLE_LIMIT + 1;

export function decisionHistoryQueryEnabled(companyId: string | null | undefined, open: boolean) {
  return Boolean(companyId && open);
}

export function decisionHistoryCount(count: number | undefined) {
  if (count == null) return undefined;
  return count > DECISION_HISTORY_VISIBLE_LIMIT ? `${DECISION_HISTORY_VISIBLE_LIMIT}+` : count;
}

export function WhatNeedsMe() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [dismissedOpen, setDismissedOpen] = useState(false);
  const [tabledOpen, setTabledOpen] = useState(false);
  const [decidedOpen, setDecidedOpen] = useState(false);
  const [expiredOpen, setExpiredOpen] = useState(false);
  // List | Focus (GRE-55). Both saved in the browser.
  const [view, setView] = useState<DecisionsView>(() => loadDecisionsView());
  const [focusPrefs, setFocusPrefs] = useState<FocusPrefs>(() => loadFocusPrefs());
  // Optimistic restore of dismissed rows. Reset whenever a fresh feed lands.
  const [pendingRestore, setPendingRestore] = useState<Set<string>>(() => new Set());

  const { restore } = useInboxDismissals(selectedCompanyId);

  useEffect(() => {
    setBreadcrumbs([{ label: "Decisions" }]);
  }, [setBreadcrumbs]);

  // One feed (GRE-263): one card per task, every kind, one count. List, Focus
  // and the sidebar badge all read the same build.
  const { data: feed, isLoading, error, refetch } = useDecisionsFeed(selectedCompanyId);
  // The header counts what Inbox Mine and the badge count (GRE-358): the
  // cards plus tasks assigned to John, which show under "Assigned to you".
  const { data: needsMe } = useNeedsMe(selectedCompanyId);

  // Dismissed rows are not in the feed; the curtain still lets John restore them.
  const { data: attentionFeed } = useQuery({
    queryKey: [...queryKeys.attention(selectedCompanyId!), "with-dismissed"],
    queryFn: () => attentionApi.list(selectedCompanyId!, { includeDismissed: true, all: true }),
    enabled: !!selectedCompanyId,
  });

  const { data: tabledIssues } = useTabledIssues(selectedCompanyId);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // Decision history — decided / expired decisions leave the open feed, so we
  // fetch them directly for the curtains.
  const { data: decidedDecisions, isLoading: decidedDecisionsLoading } = useQuery({
    queryKey: queryKeys.decisions.list(selectedCompanyId!, "decided"),
    queryFn: () => decisionsApi.list(selectedCompanyId!, { status: "decided", limit: DECISION_HISTORY_QUERY_LIMIT }),
    enabled: decisionHistoryQueryEnabled(selectedCompanyId, decidedOpen),
  });
  // John's answers to questions, plans and confirmations: most of what he
  // decides, and not in the decisions table.
  const { data: decisionLogEvents } = useQuery({
    queryKey: [...queryKeys.activity(selectedCompanyId!), "decision-log"],
    queryFn: () => activityApi.list(selectedCompanyId!, { action: DECISION_LOG_ACTIONS, limit: 50 }),
    enabled: decisionHistoryQueryEnabled(selectedCompanyId, decidedOpen),
  });
  const boardAnswers = useMemo(
    () => (decisionLogEvents ?? []).filter((event) => event.actorType === "user"),
    [decisionLogEvents],
  );
  const { data: expiredDecisions, isLoading: expiredDecisionsLoading } = useQuery({
    queryKey: queryKeys.decisions.list(selectedCompanyId!, "expired"),
    queryFn: () => decisionsApi.list(selectedCompanyId!, { status: "expired", limit: DECISION_HISTORY_QUERY_LIMIT }),
    enabled: decisionHistoryQueryEnabled(selectedCompanyId, expiredOpen),
  });

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const agent of agents ?? []) map.set(agent.id, agent);
    return map;
  }, [agents]);

  useEffect(() => {
    setPendingRestore(new Set());
  }, [attentionFeed?.generatedAt]);

  const cards = useMemo(() => feed?.cards ?? [], [feed]);
  const assignableAgents = useMemo(() => feed?.assignableAgents ?? [], [feed]);
  // At your desk (GRE-450): first on a laptop, folded last on a phone.
  const isPhone = useIsPhone();
  const { phone: phoneCards, desk: deskCards } = useMemo(() => splitAtDeskCards(cards), [cards]);
  const count = needsMe?.count ?? feed?.count ?? 0;
  const assignedList = needsMe ? <NeedsMeList needsMe={needsMe} /> : null;
  const hasAssigned = (needsMe?.assignedTasks.length ?? 0) > 0;

  const dismissedItems = useMemo(
    () =>
      (attentionFeed?.items ?? []).filter(
        (item) =>
          item.dismissal?.kind === "dismiss" && item.dismissal.isActive && !pendingRestore.has(item.id),
      ),
    [attentionFeed, pendingRestore],
  );

  const handleRestore = useCallback(
    (item: AttentionItem) => {
      setPendingRestore((prev) => new Set(prev).add(item.id));
      restore(item.dismissalKey);
    },
    [restore],
  );

  const updateView = (next: DecisionsView) => {
    setView(next);
    saveDecisionsView(next);
  };
  const updateFocusPrefs = useCallback((next: FocusPrefs) => {
    setFocusPrefs(next);
    saveFocusPrefs(next);
  }, []);

  if (!selectedCompanyId) {
    return <p className="text-sm text-muted-foreground">Select an organization first.</p>;
  }

  if (isLoading) {
    return <PageSkeleton variant="approvals" />;
  }

  const viewSwitch = <DecisionsViewSwitch view={view} onChange={updateView} />;
  const deskGroup = (
    <AtDeskGroup
      cards={deskCards}
      defaultOpen={!isPhone}
      companyId={selectedCompanyId}
      assignableAgents={assignableAgents}
      agentMap={agentMap}
      currentUserId={currentUserId}
    />
  );
  const header = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <BrandPageTitle
        trailing={
          <span className="text-base font-semibold tabular-nums text-muted-foreground" aria-label={`${count} waiting`}>
            {count}
          </span>
        }
      >
        Decisions
      </BrandPageTitle>
      <div className="flex flex-wrap items-center gap-4">
        {view === "focus" ? (
          <label className="flex items-center gap-2 text-sm font-medium">
            <ToggleSwitch
              checked={focusPrefs.autoRead}
              onCheckedChange={(autoRead) => updateFocusPrefs({ ...focusPrefs, autoRead })}
              aria-label="Read each question aloud"
            />
            Read each question aloud
          </label>
        ) : null}
        {viewSwitch}
      </div>
    </div>
  );

  if (error && !feed) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        {header}
        <ErrorState error={error} onRetry={() => void refetch()} />
      </div>
    );
  }

  if (view === "focus") {
    return (
      <div className="mx-auto max-w-5xl space-y-4">
        {header}
        {error && <ErrorState error={error} onRetry={() => void refetch()} compact />}
        {/* Assigned tasks are counted in the header but are not focus cards. */}
        {assignedList}
        {isPhone ? null : deskGroup}
        <DecisionsFocusView
          cards={phoneCards}
          assignableAgents={assignableAgents}
          companyId={selectedCompanyId}
          agentMap={agentMap}
          currentUserId={currentUserId}
          prefs={focusPrefs}
          onPrefsChange={updateFocusPrefs}
          onShowList={() => updateView("list")}
        />
        {isPhone ? deskGroup : null}
      </div>
    );
  }

  const tabledCount = tabledIssues?.length ?? 0;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      {header}

      {/* Queue quicklinks. The rail self-hides when the company has no queues. */}
      <DecisionQueueRail companyId={selectedCompanyId} activeQueueKey={null} />

      <DecisionNotificationsCard companyId={selectedCompanyId} />

      {error && <ErrorState error={error} onRetry={() => void refetch()} compact />}

      {assignedList}

      {isPhone ? null : deskGroup}

      {phoneCards.length === 0 ? (
        hasAssigned || (!isPhone && deskCards.length > 0) ? null : <ZeroState />
      ) : (
        <div className="space-y-4">
          {phoneCards.map((card) => (
            <DecisionFeedCard
              key={card.id}
              card={card}
              companyId={selectedCompanyId}
              assignableAgents={assignableAgents}
              agentMap={agentMap}
              currentUserId={currentUserId}
            />
          ))}
        </div>
      )}

      {isPhone ? deskGroup : null}

      <div className="space-y-4">
        {tabledCount > 0 && (
          <Curtain label="Tabled" count={tabledCount} open={tabledOpen} onToggle={() => setTabledOpen((prev) => !prev)}>
            <p className="text-xs text-muted-foreground">
              Set aside with Not now. No agent works on these until they come back.
            </p>
            <TabledList companyId={selectedCompanyId} issues={tabledIssues ?? []} />
          </Curtain>
        )}

        {dismissedItems.length > 0 && (
          <Curtain
            label="Dismissed"
            count={dismissedItems.length}
            open={dismissedOpen}
            onToggle={() => setDismissedOpen((prev) => !prev)}
          >
            {dismissedItems.map((item) => (
              <AttentionQueueRow
                key={item.id}
                item={item}
                companyId={selectedCompanyId}
                variant="hidden"
                expanded={false}
                onToggleExpand={noopToggleExpand}
                onDismiss={noopToggleExpand}
                onRestore={handleRestore}
                agentMap={agentMap}
                currentUserId={currentUserId}
              />
            ))}
          </Curtain>
        )}

        <Curtain
          label="Decided"
          count={decisionHistoryCount(
            decidedDecisions === undefined && decisionLogEvents === undefined
              ? undefined
              : (decidedDecisions?.length ?? 0) + boardAnswers.length,
          )}
          open={decidedOpen}
          onToggle={() => setDecidedOpen((prev) => !prev)}
        >
          <DecisionLog events={boardAnswers} />
          {decidedDecisionsLoading ? (
            <p className="text-xs text-muted-foreground">Loading decided decisions…</p>
          ) : (decidedDecisions?.length ?? 0) > 0 ? (
            decidedDecisions!.slice(0, DECISION_HISTORY_VISIBLE_LIMIT).map((decision) => (
              <DecisionResolver
                key={decision.id}
                companyId={selectedCompanyId}
                decisionId={decision.id}
                agentMap={agentMap}
                initialDecision={{ ...decision, executions: decision.executions ?? [] }}
              />
            ))
          ) : (
            boardAnswers.length === 0 && <p className="text-xs text-muted-foreground">Nothing decided yet.</p>
          )}
        </Curtain>

        <Curtain
          label="Expired"
          count={decisionHistoryCount(expiredDecisions?.length)}
          open={expiredOpen}
          onToggle={() => setExpiredOpen((prev) => !prev)}
        >
          {expiredDecisionsLoading ? (
            <p className="text-xs text-muted-foreground">Loading expired decisions…</p>
          ) : (expiredDecisions?.length ?? 0) > 0 ? (
            expiredDecisions!.slice(0, DECISION_HISTORY_VISIBLE_LIMIT).map((decision) => (
              <DecisionResolver
                key={decision.id}
                companyId={selectedCompanyId}
                decisionId={decision.id}
                agentMap={agentMap}
                initialDecision={{ ...decision, executions: decision.executions ?? [] }}
              />
            ))
          ) : (
            <p className="text-xs text-muted-foreground">No expired decisions.</p>
          )}
        </Curtain>
      </div>
    </div>
  );
}

/** List | Focus switch at the top of the Decisions page (GRE-55). */
export function DecisionsViewSwitch({
  view,
  onChange,
}: {
  view: DecisionsView;
  onChange: (view: DecisionsView) => void;
}) {
  return (
    <div className="inline-flex shrink-0 rounded-md border border-border p-0.5" role="group" aria-label="Decisions view">
      {(["list", "focus"] as const).map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={view === option}
          onClick={() => onChange(option)}
          className={cn(
            "gs-press rounded-sm px-3 py-1 text-sm font-medium outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
            view === option
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          {option === "list" ? "List" : "Focus"}
        </button>
      ))}
    </div>
  );
}

/**
 * Violet left-rule strip over a run of decisions that share a bundle, e.g.
 * "Planner proposed 6 decisions · from PAP-123 · routing review · 6 pending".
 * Grouping is a surface only — each decision is still decided independently.
 */
export function DecisionBundleHeader({
  agentName,
  title,
  originIssue,
  count,
}: {
  agentName: string | null;
  title: string | null;
  originIssue: AttentionSubject | null;
  count: number;
}) {
  const noun = count === 1 ? "decision" : "decisions";
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-sm border-l-2 border-violet-500/60 bg-violet-500/5 px-3 py-1.5 text-xs">
      <span className="font-semibold text-violet-800 dark:text-violet-200">
        {agentName ?? "An agent"} proposed {count} {noun}
      </span>
      {originIssue && (originIssue.identifier || originIssue.title) && (
        <span className="text-muted-foreground">
          {"· from "}
          {originIssue.href ? (
            <a href={originIssue.href} className="hover:underline">
              {originIssue.identifier ?? originIssue.title}
            </a>
          ) : (
            originIssue.identifier ?? originIssue.title
          )}
        </span>
      )}
      {title && <span className="text-muted-foreground">· {title}</span>}
      <span className="text-muted-foreground">· {count} pending</span>
    </div>
  );
}

function ZeroState() {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-20 text-center">
      <BrandCaughtUpMark />
      <p className="text-lg font-semibold text-foreground">You're all caught up</p>
      <p className="mt-1 text-sm text-muted-foreground">Nothing needs a decision from you right now.</p>
    </div>
  );
}
