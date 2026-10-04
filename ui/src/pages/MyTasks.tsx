import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { buildAgentMentionHref, type Agent, type AttentionItem, type Issue, type IssueStatus } from "@greatstone/shared";
import { CheckCircle2, CircleDot } from "lucide-react";
import { Link, useLocation } from "@/lib/router";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { attentionApi } from "../api/attention";
import { authApi } from "../api/auth";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { createIssueDetailLocationState } from "../lib/issueDetailBreadcrumb";
import {
  MY_TASKS_GROUPS,
  MY_TASKS_GROUP_LABELS,
  MY_TASKS_OPEN_STATUSES,
  MY_TASKS_REASON_LABELS,
  askTargetAgentId,
  decisionIssueId,
  handOffAgentChoices,
  mergeMyTasks,
  myTasksAskState,
  myTasksGroupOf,
  selectDoneToday,
  selectHandedOffTasks,
} from "../lib/myTasks";
import { IssuesList, type IssuesCustomGrouping } from "../components/IssuesList";
import { IssueGroupHeader } from "../components/IssueGroupHeader";
import { EntityRow } from "../components/EntityRow";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { resolveIssuesPresentation } from "./Issues";
import { useStreamlinedUiEnabled } from "../hooks/useStreamlinedUiEnabled";
import { ErrorState } from "../components/ErrorState";
import { useDialogActions } from "../context/DialogContext";
import { useToastActions } from "../context/ToastContext";
import { resolveLeadAgent } from "../components/MobileEverestButton";
import {
  MyTasksAskBox,
  MyTasksAskButton,
  MyTasksAskStateBadge,
  MyTasksDiscussButton,
  MyTasksHandOff,
  MyTasksTickBox,
} from "../components/MyTasksRowControls";
import { MyTasksDiscussPanel, useMyTasksDiscussOverlay } from "../components/MyTasksDiscussPanel";

/** Tasks behind decisions are fetched one by one; the Decisions page holds the rest. */
const DECISION_ISSUE_FETCH_LIMIT = 50;
/** Done today and handed-off tasks are read from the most recently active. */
const DONE_TODAY_FETCH_LIMIT = 50;
const HANDED_OFF_FETCH_LIMIT = 200;
/** How long the Undo on a ticked task stays up. */
const UNDO_TOAST_MS = 5000;

const askBoxId = (issueId: string) => `my-tasks-ask-${issueId}`;
const DISCUSS_PANEL_ID = "my-tasks-discuss-panel";

/** The visible copy of a row control: phone and laptop layouts each render one. */
function visibleElement(selector: string): HTMLElement | null {
  const matches = [...document.querySelectorAll<HTMLElement>(selector)];
  return matches.find((element) => element.getClientRects().length > 0) ?? matches[0] ?? null;
}

function focusSoon(selector: string) {
  requestAnimationFrame(() => visibleElement(selector)?.focus());
}

/** Tick boxes after this one, in screen order, so focus can move on after a tick. */
function nextTickTarget(issueId: string): string | null {
  const ticks = [...document.querySelectorAll<HTMLElement>("[data-my-tasks-tick]")].filter(
    (element) => element.getClientRects().length > 0 || element.dataset.myTasksTick === issueId,
  );
  const index = ticks.findIndex((element) => element.dataset.myTasksTick === issueId);
  if (index < 0) return null;
  const next = ticks.slice(index + 1).find((element) => element.dataset.myTasksTick !== issueId)
    ?? ticks.slice(0, index).reverse().find((element) => element.dataset.myTasksTick !== issueId);
  return next?.dataset.myTasksTick ?? null;
}

export function MyTasks() {
  const { openNewIssue } = useDialogActions();
  const { enabled: streamlinedUiEnabled } = useStreamlinedUiEnabled();
  const issuesPresentation = resolveIssuesPresentation(streamlinedUiEnabled);
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [askOpenId, setAskOpenId] = useState<string | null>(null);
  const [discussId, setDiscussId] = useState<string | null>(null);
  const discussOverlay = useMyTasksDiscussOverlay();

  useEffect(() => {
    setBreadcrumbs([{ label: "My tasks" }]);
  }, [setBreadcrumbs]);

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;

  const myTasksKey = useMemo(() => ["issues", selectedCompanyId, "my-tasks"] as const, [selectedCompanyId]);
  const doneTodayKey = useMemo(() => [...myTasksKey, "done-today"] as const, [myTasksKey]);
  const handedOffKey = useMemo(() => [...myTasksKey, "handed-off"] as const, [myTasksKey]);

  // touchedByUserId=me adds the comment times the Ask state is read from.
  const {
    data: issues,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: myTasksKey,
    queryFn: () =>
      issuesApi.list(selectedCompanyId!, {
        assigneeUserId: "me",
        touchedByUserId: "me",
        status: MY_TASKS_OPEN_STATUSES.join(","),
        includeBlocks: true,
      }),
    enabled: !!selectedCompanyId,
    refetchOnWindowFocus: true,
  });

  const { data: doneIssues } = useQuery({
    queryKey: doneTodayKey,
    queryFn: () =>
      issuesApi.list(selectedCompanyId!, {
        assigneeUserId: "me",
        touchedByUserId: "me",
        status: "done",
        sortField: "updated",
        sortDir: "desc",
        limit: DONE_TODAY_FETCH_LIMIT,
      }),
    enabled: !!selectedCompanyId,
    refetchOnWindowFocus: true,
  });

  // Tasks handed to an agent leave the list above; this finds them again.
  const { data: touchedIssues } = useQuery({
    queryKey: handedOffKey,
    queryFn: () =>
      issuesApi.list(selectedCompanyId!, {
        touchedByUserId: "me",
        status: MY_TASKS_OPEN_STATUSES.join(","),
        sortField: "updated",
        sortDir: "desc",
        limit: HANDED_OFF_FETCH_LIMIT,
      }),
    enabled: !!selectedCompanyId,
    refetchOnWindowFocus: true,
  });

  // Same query as the sidebar Decisions badge, so the two share one cache entry.
  const { data: attentionFeed, isLoading: attentionLoading } = useQuery({
    queryKey: queryKeys.attention(selectedCompanyId!),
    queryFn: () => attentionApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const decisions = useMemo(() => attentionFeed?.items ?? [], [attentionFeed]);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!, { includeArchived: true }),
    queryFn: () => projectsApi.list(selectedCompanyId!, { includeArchived: true }),
    enabled: !!selectedCompanyId,
  });

  // Decision tasks are usually assigned to an agent, so they are not in the list above.
  const decisionIssueIds = useMemo(() => {
    const assignedIds = new Set((issues ?? []).map((issue) => issue.id));
    const ids = new Set<string>();
    for (const item of decisions) {
      const id = decisionIssueId(item);
      if (id && !assignedIds.has(id)) ids.add(id);
    }
    return [...ids].slice(0, DECISION_ISSUE_FETCH_LIMIT);
  }, [decisions, issues]);
  const combineDecisionIssues = useCallback(
    (results: UseQueryResult<Issue>[]) => {
      const map = new Map<string, Issue | null>();
      results.forEach((result, index) => {
        const id = decisionIssueIds[index];
        if (!id) return;
        if (result.data) map.set(id, result.data);
        else if (result.isError) map.set(id, null);
      });
      return map;
    },
    [decisionIssueIds],
  );
  const decisionIssues = useQueries({
    queries: decisionIssueIds.map((id) => ({
      queryKey: queryKeys.issues.detail(id),
      queryFn: () => issuesApi.get(id),
      enabled: !!selectedCompanyId && !isLoading,
      retry: false,
    })),
    combine: combineDecisionIssues,
  });

  const merged = useMemo(
    () => mergeMyTasks({ issues: issues ?? [], decisions, decisionIssues, currentUserId }),
    [issues, decisions, decisionIssues, currentUserId],
  );

  const listedIssues = useMemo(() => {
    const byId = new Map(merged.issues.map((issue) => [issue.id, issue]));
    for (const issue of selectHandedOffTasks(touchedIssues ?? [], currentUserId)) {
      if (!byId.has(issue.id)) byId.set(issue.id, issue);
    }
    for (const issue of selectDoneToday(doneIssues ?? [])) {
      if (!byId.has(issue.id)) byId.set(issue.id, issue);
    }
    return [...byId.values()];
  }, [merged.issues, touchedIssues, doneIssues, currentUserId]);

  const leadAgent = useMemo(() => resolveLeadAgent(agents ?? []), [agents]);
  const leadAgentId = leadAgent?.id ?? null;
  const handOffAgents = useMemo(() => handOffAgentChoices(agents ?? [], leadAgentId), [agents, leadAgentId]);
  const agentById = useMemo(() => new Map((agents ?? []).map((agent) => [agent.id, agent])), [agents]);

  // "Assigned" is every row's reason here, so only the telling ones show.
  const issueTagsById = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const [id, reasons] of merged.reasonsById) {
      map.set(id, reasons.filter((reason) => reason !== "assigned").map((reason) => MY_TASKS_REASON_LABELS[reason]));
    }
    return map;
  }, [merged.reasonsById]);

  const groupGrouping = useMemo<IssuesCustomGrouping>(
    () => ({
      label: "Who acts",
      groups: MY_TASKS_GROUPS.map((group) => ({ key: group, label: MY_TASKS_GROUP_LABELS[group] })),
      groupKeyForIssue: (issue) => myTasksGroupOf(issue, merged.reasonsById.get(issue.id) ?? []),
    }),
    [merged.reasonsById],
  );

  const issueLinkState = useMemo(
    () =>
      createIssueDetailLocationState(
        "My tasks",
        `${location.pathname}${location.search}${location.hash}`,
        "issues",
      ),
    [location.pathname, location.search, location.hash],
  );

  const refreshMyTasks = useCallback(
    (id: string) => {
      void queryClient.invalidateQueries({ queryKey: myTasksKey });
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(id) });
    },
    [queryClient, myTasksKey],
  );

  /** Moves a row at once; the refetch after the request brings the server's copy. */
  const patchIssueLocally = useCallback(
    (issue: Issue, patch: Partial<Issue>) => {
      const next = { ...issue, ...patch } as Issue;
      const replace = (list: Issue[] | undefined) => list?.map((item) => (item.id === issue.id ? { ...item, ...patch } : item));
      const closed = next.status === "done" || next.status === "cancelled";
      queryClient.setQueryData<Issue[]>(myTasksKey, (list) => {
        if (!list) return list;
        if (closed) return list.filter((item) => item.id !== issue.id);
        if (next.assigneeUserId !== currentUserId) return list.filter((item) => item.id !== issue.id);
        return list.some((item) => item.id === issue.id) ? replace(list) : [next, ...list];
      });
      queryClient.setQueryData<Issue[]>(doneTodayKey, (list) => {
        if (!list) return list;
        const rest = list.filter((item) => item.id !== issue.id);
        return next.status === "done" ? [next, ...rest] : rest;
      });
      queryClient.setQueryData<Issue[]>(handedOffKey, (list) => {
        if (!list) return list;
        return list.some((item) => item.id === issue.id) ? replace(list) : [next, ...list];
      });
      queryClient.setQueryData<Issue>(queryKeys.issues.detail(issue.id), (current) =>
        current ? { ...current, ...patch } : current,
      );
    },
    [queryClient, myTasksKey, doneTodayKey, handedOffKey, currentUserId],
  );

  const updateIssue = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) => issuesApi.update(id, data),
    onSuccess: (_issue, { id }) => refreshMyTasks(id),
  });

  const setStatus = useMutation({
    mutationFn: ({ issue, status }: { issue: Issue; status: IssueStatus; previous: Issue }) =>
      issuesApi.update(issue.id, { status }),
    onMutate: ({ issue, status }) => {
      patchIssueLocally(issue, { status, completedAt: status === "done" ? new Date() : null });
    },
    onError: (err, { previous }) => {
      patchIssueLocally(previous, previous);
      pushToast({
        title: "Could not update the task",
        body: err instanceof Error ? err.message : undefined,
        tone: "error",
      });
    },
    onSettled: (_data, _err, { issue }) => refreshMyTasks(issue.id),
  });

  // Normal close path: the server unblocks and wakes dependents as on any close.
  const tick = (issue: Issue, done: boolean) => {
    const previousStatus = issue.status;
    if (done) {
      const nextFocus = nextTickTarget(issue.id);
      setStatus.mutate({ issue, status: "done", previous: issue });
      if (nextFocus) focusSoon(`[data-my-tasks-tick="${nextFocus}"]`);
      pushToast({
        id: `my-tasks-done-${issue.id}`,
        title: `Done: ${issue.identifier ?? issue.title}`,
        tone: "success",
        ttlMs: UNDO_TOAST_MS,
        action: {
          label: "Undo",
          onClick: () => {
            const current = { ...issue, status: "done" as const };
            setStatus.mutate({ issue: current, status: previousStatus, previous: current });
            focusSoon(`[data-my-tasks-tick="${issue.id}"]`);
          },
        },
      });
    } else {
      // Unticking later has no record of the old status; the task goes back to Todo.
      setStatus.mutate({ issue, status: "todo", previous: issue });
      focusSoon(`[data-my-tasks-tick="${issue.id}"]`);
    }
  };

  const handOff = useMutation({
    mutationFn: ({ issue, agent, instruction }: { issue: Issue; agent: Agent; instruction: string }) =>
      issuesApi.update(issue.id, {
        assigneeAgentId: agent.id,
        assigneeUserId: null,
        // A backlog task does not wake its assignee; Todo does.
        ...(issue.status === "backlog" ? { status: "todo" } : {}),
        // Always a comment: the agent reads it, and it marks the task as waiting on them.
        comment: instruction || `Handed to ${agent.name} from My tasks.`,
      }),
    onMutate: ({ issue, agent }) => {
      patchIssueLocally(issue, {
        assigneeAgentId: agent.id,
        assigneeUserId: null,
        myLastCommentAt: new Date(),
        ...(issue.status === "backlog" ? { status: "todo" as const } : {}),
      });
    },
    onSuccess: (_issue, { agent }) => {
      pushToast({ title: `Handed to ${agent.name}`, body: `${agent.name} has been woken to start.`, tone: "success" });
    },
    onError: (err, { issue }) => {
      patchIssueLocally(issue, issue);
      pushToast({
        title: "Could not hand off the task",
        body: err instanceof Error ? err.message : undefined,
        tone: "error",
      });
    },
    onSettled: (_data, _err, { issue }) => refreshMyTasks(issue.id),
  });

  // The assignee agent wakes on any comment; anyone else is woken by an @mention.
  const ask = useMutation({
    mutationFn: ({ issue, agent, question }: { issue: Issue; agent: Agent; question: string }) => {
      const body = issue.assigneeAgentId === agent.id
        ? question
        : `[@${agent.name}](${buildAgentMentionHref(agent.id, agent.icon)}) ${question}`;
      return issuesApi.addComment(issue.id, body, undefined, undefined, undefined, crypto.randomUUID());
    },
    onMutate: ({ issue }) => {
      patchIssueLocally(issue, { myLastCommentAt: new Date() });
      setAskOpenId(null);
      focusSoon(`[data-my-tasks-ask="${issue.id}"]`);
    },
    onSuccess: (_comment, { agent }) => {
      pushToast({ title: `Asked ${agent.name}`, body: "The row shows Answer ready when they reply.", tone: "success" });
    },
    onError: (err, { issue, question }) => {
      patchIssueLocally(issue, issue);
      pushToast({
        title: "Could not send the question",
        body: err instanceof Error ? `${err.message} Your question: ${question}` : `Your question: ${question}`,
        tone: "error",
      });
    },
    onSettled: (_data, _err, { issue }) => refreshMyTasks(issue.id),
  });

  const closeAsk = (issueId: string) => {
    setAskOpenId(null);
    focusSoon(`[data-my-tasks-ask="${issueId}"]`);
  };

  // Opening the thread reads it, so an "Answer ready" row settles.
  const markRead = useMutation({
    mutationFn: (issue: Issue) => issuesApi.markRead(issue.id),
    onMutate: (issue) => patchIssueLocally(issue, { myLastReadAt: new Date() }),
    onSettled: (_data, _err, issue) => refreshMyTasks(issue.id),
  });

  // A plain comment: the server wakes the assignee agent as on the task page.
  const reply = useMutation({
    mutationFn: ({ issue, body, clientRequestId }: { issue: Issue; body: string; clientRequestId?: string }) =>
      issuesApi.addComment(issue.id, body, undefined, undefined, undefined, clientRequestId ?? crypto.randomUUID()),
    onMutate: ({ issue }) => {
      patchIssueLocally(issue, { myLastCommentAt: new Date() });
    },
    onError: (err, { issue }) => {
      patchIssueLocally(issue, issue);
      pushToast({
        title: "Could not send the reply",
        body: err instanceof Error ? err.message : undefined,
        tone: "error",
      });
    },
    onSettled: (_data, _err, { issue }) => {
      refreshMyTasks(issue.id);
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(issue.id) });
    },
  });

  const openDiscuss = (issue: Issue) => {
    setDiscussId(issue.id);
    const answerReady = myTasksAskState(issue) === "answered";
    if (answerReady) markRead.mutate(issue);
  };

  const closeDiscuss = () => {
    const issueId = discussId;
    setDiscussId(null);
    if (issueId) focusSoon(`[data-my-tasks-discuss="${issueId}"]`);
  };

  const askTargetOf = (issue: Issue) => {
    const id = askTargetAgentId(issue, leadAgentId);
    return id ? agentById.get(id) ?? null : null;
  };

  const renderRowLeading = (issue: Issue) => (
    <MyTasksTickBox issue={issue} onCheckedChange={(done) => tick(issue, done)} />
  );

  const renderDiscuss = (issue: Issue) => (
    <MyTasksDiscussButton
      issue={issue}
      open={discussId === issue.id}
      controlsId={DISCUSS_PANEL_ID}
      onToggle={() => (discussId === issue.id ? closeDiscuss() : openDiscuss(issue))}
    />
  );

  const renderRowActions = (issue: Issue) => {
    if (issue.status === "done") return renderDiscuss(issue);
    const askState = myTasksAskState(issue);
    return (
      <>
        {askState ? <MyTasksAskStateBadge state={askState} /> : null}
        <MyTasksHandOff
          issue={issue}
          agents={handOffAgents}
          leadAgentId={leadAgentId}
          onHandOff={(agent, instruction) => handOff.mutate({ issue, agent, instruction })}
        />
        <MyTasksAskButton
          issue={issue}
          expanded={askOpenId === issue.id}
          controlsId={askBoxId(issue.id)}
          onToggle={() => (askOpenId === issue.id ? closeAsk(issue.id) : setAskOpenId(issue.id))}
        />
        {renderDiscuss(issue)}
      </>
    );
  };

  const renderRowFooter = (issue: Issue) => {
    if (askOpenId !== issue.id) return null;
    const target = askTargetOf(issue);
    return (
      <MyTasksAskBox
        id={askBoxId(issue.id)}
        targetName={target?.name ?? null}
        pending={ask.isPending}
        onCancel={() => closeAsk(issue.id)}
        onSubmit={(question) => {
          if (target) ask.mutate({ issue, agent: target, question });
        }}
      />
    );
  };

  if (!selectedCompanyId) {
    return <EmptyState icon={CircleDot} message="Select an organization to view your tasks." />;
  }
  if (isLoading || attentionLoading) {
    return <PageSkeleton variant="list" />;
  }

  if (error && !issues) {
    return <ErrorState error={error} onRetry={() => void refetch()} />;
  }

  const nothingNeedsYou = listedIssues.length === 0 && merged.decisionsWithoutIssue.length === 0;
  const discussIssue = discussId ? listedIssues.find((issue) => issue.id === discussId) ?? null : null;
  const discussPanel = discussIssue ? (
    <MyTasksDiscussPanel
      id={DISCUSS_PANEL_ID}
      issue={discussIssue}
      agents={agents}
      currentUserId={currentUserId}
      issueLinkState={issueLinkState}
      onReply={async (body, clientRequestId) => {
        await reply.mutateAsync({ issue: discussIssue, body, clientRequestId });
      }}
      onClose={closeDiscuss}
    />
  ) : null;

  const page = (
    <div className="min-w-0 flex-1 space-y-6">
      {error && <ErrorState error={error} onRetry={() => void refetch()} compact />}

      {nothingNeedsYou ? (
        <EmptyState
          icon={CheckCircle2}
          message="Nothing needs you right now."
          action="Create task"
          onAction={() => openNewIssue()}
        />
      ) : (
        <>
          {listedIssues.length > 0 && (
            <IssuesList
              issues={listedIssues}
              agents={agents}
              projects={projects}
              viewStateKey="paperclip:my-tasks-view"
              rowPresentation={issuesPresentation.rowPresentation}
              toolbarPresentation={issuesPresentation.toolbarPresentation}
              issueLinkState={issueLinkState}
              searchWithinLoadedIssues
              customGrouping={groupGrouping}
              issueTagsById={issueTagsById}
              renderRowLeading={renderRowLeading}
              renderRowActions={renderRowActions}
              renderRowFooter={renderRowFooter}
              onUpdateIssue={(id, data) => updateIssue.mutate({ id, data })}
            />
          )}
          {merged.decisionsWithoutIssue.length > 0 && (
            <DecisionsWithoutIssue items={merged.decisionsWithoutIssue} />
          )}
        </>
      )}
    </div>
  );

  // One wrapper either way, so opening the panel does not remount the list.
  // Docked: the list keeps the space beside the panel. Overlay: the panel covers it.
  return (
    <div className={discussPanel && !discussOverlay ? "flex items-start gap-4" : undefined}>
      {page}
      {discussPanel}
    </div>
  );
}

function DecisionsWithoutIssue({ items }: { items: AttentionItem[] }) {
  return (
    <section aria-label="Decisions not tied to a task">
      <IssueGroupHeader
        label="Decisions not tied to a task"
        trailing={
          <Link to="/decisions" className="text-xs text-muted-foreground hover:text-foreground hover:underline">
            Open decisions
          </Link>
        }
      />
      {items.map((item) => (
        <EntityRow
          key={item.id}
          to="/decisions"
          title={item.subject.title ?? item.subject.identifier ?? item.whyNow}
          trailing={<span className="max-w-64 truncate text-xs text-muted-foreground">{item.whyNow}</span>}
        />
      ))}
    </section>
  );
}
