import { useCallback, useEffect, useMemo } from "react";
import { useMutation, useQueries, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { AttentionItem, Issue } from "@greatstone/shared";
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
  MY_TASKS_OPEN_STATUSES,
  MY_TASKS_REASONS,
  MY_TASKS_REASON_GROUP_LABELS,
  MY_TASKS_REASON_LABELS,
  decisionIssueId,
  mergeMyTasks,
} from "../lib/myTasks";
import { IssuesList, type IssuesCustomGrouping } from "../components/IssuesList";
import { IssueGroupHeader } from "../components/IssueGroupHeader";
import { EntityRow } from "../components/EntityRow";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { resolveIssuesPresentation } from "./Issues";
import { useStreamlinedUiEnabled } from "../hooks/useStreamlinedUiEnabled";

/** Tasks behind decisions are fetched one by one; the Decisions page holds the rest. */
const DECISION_ISSUE_FETCH_LIMIT = 50;

export function MyTasks() {
  const { enabled: streamlinedUiEnabled } = useStreamlinedUiEnabled();
  const issuesPresentation = resolveIssuesPresentation(streamlinedUiEnabled);
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const location = useLocation();
  const queryClient = useQueryClient();

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

  const issueTagsById = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const [id, reasons] of merged.reasonsById) {
      map.set(id, reasons.map((reason) => MY_TASKS_REASON_LABELS[reason]));
    }
    return map;
  }, [merged.reasonsById]);

  const reasonGrouping = useMemo<IssuesCustomGrouping>(
    () => ({
      label: "Reason",
      groups: MY_TASKS_REASONS.map((reason) => ({ key: reason, label: MY_TASKS_REASON_GROUP_LABELS[reason] })),
      groupKeyForIssue: (issue) => merged.reasonsById.get(issue.id)?.[0] ?? "assigned",
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

  const updateIssue = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) => issuesApi.update(id, data),
    onSuccess: (_issue, { id }) => {
      queryClient.invalidateQueries({ queryKey: ["issues", selectedCompanyId, "my-tasks"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(id) });
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={CircleDot} message="Select an organization to view your tasks." />;
  }
  if (isLoading || attentionLoading) {
    return <PageSkeleton variant="list" />;
  }

  const nothingNeedsYou = merged.issues.length === 0 && merged.decisionsWithoutIssue.length === 0;

  return (
    <div className="space-y-6">
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}

      {nothingNeedsYou ? (
        <EmptyState icon={CheckCircle2} message="Nothing needs you right now." />
      ) : (
        <>
          {merged.issues.length > 0 && (
            <IssuesList
              issues={merged.issues}
              agents={agents}
              projects={projects}
              viewStateKey="paperclip:my-tasks-view"
              rowPresentation={issuesPresentation.rowPresentation}
              toolbarPresentation={issuesPresentation.toolbarPresentation}
              issueLinkState={issueLinkState}
              searchWithinLoadedIssues
              customGrouping={reasonGrouping}
              issueTagsById={issueTagsById}
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
