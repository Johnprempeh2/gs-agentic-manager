import { useEffect, useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Agent, AttentionItem, IssueRelationIssueSummary } from "@greatstone/shared";
import { Link } from "@/lib/router";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { attentionApi } from "../api/attention";
import { authApi } from "../api/auth";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { attentionBadgeCount } from "../lib/attention";
import { issueUrl } from "../lib/utils";
import {
  MY_TASKS_OPEN_STATUSES,
  MY_TASKS_STATUS_LABELS,
  selectMyTasks,
  type MyTasksBlockingEntry,
} from "../lib/myTasks";
import { IssueRow } from "../components/IssueRow";
import { IssueGroupHeader } from "../components/IssueGroupHeader";
import { StatusIcon } from "../components/StatusIcon";
import { PageSkeleton } from "../components/PageSkeleton";

const DECISION_PREVIEW_LIMIT = 5;

export function MyTasks() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "My tasks" }]);
  }, [setBreadcrumbs]);

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;

  const {
    data: issues,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["issues", selectedCompanyId, "my-tasks"],
    queryFn: () =>
      issuesApi.list(selectedCompanyId!, {
        assigneeUserId: "me",
        status: MY_TASKS_OPEN_STATUSES.join(","),
        includeBlocks: true,
      }),
    enabled: !!selectedCompanyId,
    refetchOnWindowFocus: true,
  });

  // Same query as the sidebar Decisions badge, so the two share one cache entry.
  const { data: attentionFeed } = useQuery({
    queryKey: queryKeys.attention(selectedCompanyId!),
    queryFn: () => attentionApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const agent of agents ?? []) map.set(agent.id, agent);
    return map;
  }, [agents]);

  const selection = useMemo(() => selectMyTasks(issues ?? [], currentUserId), [issues, currentUserId]);

  if (!selectedCompanyId) {
    return <p className="text-sm text-muted-foreground">Select an organization first.</p>;
  }
  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const decisionCount = attentionBadgeCount(attentionFeed);
  const decisionItems = (attentionFeed?.items ?? []).slice(0, DECISION_PREVIEW_LIMIT);
  const assignedCount = selection.assigned.reduce((sum, group) => sum + group.issues.length, 0);

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-xl font-bold">My tasks</h1>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}

      <MyTasksSection title="You are blocking" count={selection.blocking.length}>
        {selection.blocking.length === 0 ? (
          <SectionEmpty>Nothing is waiting on you.</SectionEmpty>
        ) : (
          <div className="space-y-3">
            {selection.blocking.map((entry) => (
              <BlockingEntry key={entry.issue.id} entry={entry} agentMap={agentMap} />
            ))}
          </div>
        )}
      </MyTasksSection>

      <MyTasksSection
        title="Waiting on your decision"
        count={decisionCount}
        trailing={
          <Link to="/decisions" className="text-xs text-muted-foreground hover:text-foreground hover:underline">
            Open decisions
          </Link>
        }
      >
        {decisionItems.length === 0 ? (
          <SectionEmpty>No decisions waiting on you.</SectionEmpty>
        ) : (
          <ul className="space-y-1">
            {decisionItems.map((item) => (
              <DecisionPreviewRow key={item.id} item={item} />
            ))}
            {decisionCount > decisionItems.length && (
              <li className="pl-1 text-xs text-muted-foreground">
                <Link to="/decisions" className="hover:underline">
                  {decisionCount - decisionItems.length} more in Decisions
                </Link>
              </li>
            )}
          </ul>
        )}
      </MyTasksSection>

      <MyTasksSection title="Assigned to you" count={assignedCount}>
        {selection.assigned.length === 0 ? (
          <SectionEmpty>No other open tasks assigned to you.</SectionEmpty>
        ) : (
          <div className="space-y-3">
            {selection.assigned.map((group) => (
              <div key={group.status}>
                <IssueGroupHeader
                  label={MY_TASKS_STATUS_LABELS[group.status]}
                  trailing={<span className="text-xs tabular-nums text-muted-foreground">{group.issues.length}</span>}
                />
                {group.issues.map((issue) => (
                  <IssueRow key={issue.id} issue={issue} showDivider />
                ))}
              </div>
            ))}
          </div>
        )}
      </MyTasksSection>
    </div>
  );
}

function MyTasksSection({
  title,
  count,
  trailing,
  children,
}: {
  title: string;
  count: number;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2" aria-label={title}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">
          {title} <span className="tabular-nums text-muted-foreground">{count}</span>
        </h2>
        {trailing}
      </div>
      {children}
    </section>
  );
}

function SectionEmpty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}

function BlockingEntry({ entry, agentMap }: { entry: MyTasksBlockingEntry; agentMap: Map<string, Agent> }) {
  return (
    <div className="rounded-md border border-border">
      <IssueRow
        issue={entry.issue}
        titleSuffix={
          entry.waitingOnReview ? (
            <span className="ml-2 text-xs text-muted-foreground">Review waiting on you</span>
          ) : undefined
        }
      />
      {entry.blockedIssues.length > 0 && (
        <ul className="space-y-0.5 border-t border-border px-3 py-2">
          {entry.blockedIssues.map((blocked) => (
            <BlockedIssueLine key={blocked.id} blocked={blocked} agentMap={agentMap} />
          ))}
        </ul>
      )}
    </div>
  );
}

function BlockedIssueLine({
  blocked,
  agentMap,
}: {
  blocked: IssueRelationIssueSummary;
  agentMap: Map<string, Agent>;
}) {
  const assignee = blocked.assigneeAgentId
    ? (agentMap.get(blocked.assigneeAgentId)?.name ?? "Agent")
    : blocked.assigneeUserId
      ? "A person"
      : "Unassigned";
  return (
    <li className="flex min-w-0 items-center gap-2 text-xs">
      <span className="text-muted-foreground">Blocks</span>
      <StatusIcon status={blocked.status} />
      <Link to={issueUrl(blocked)} className="min-w-0 truncate hover:underline">
        {blocked.identifier && <span className="mr-1 font-mono text-muted-foreground">{blocked.identifier}</span>}
        {blocked.title}
      </Link>
      <span className="ml-auto shrink-0 text-muted-foreground">{assignee}</span>
    </li>
  );
}

function DecisionPreviewRow({ item }: { item: AttentionItem }) {
  const label = item.subject.title ?? item.subject.identifier ?? item.whyNow;
  return (
    <li className="flex min-w-0 items-center gap-2 rounded-md px-1 py-1 text-sm">
      {item.subject.href ? (
        <Link to={item.subject.href} className="min-w-0 truncate hover:underline">
          {label}
        </Link>
      ) : (
        <span className="min-w-0 truncate">{label}</span>
      )}
      <span className="ml-auto shrink-0 truncate text-xs text-muted-foreground">{item.whyNow}</span>
    </li>
  );
}
