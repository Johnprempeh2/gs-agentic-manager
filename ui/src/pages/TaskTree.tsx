import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { IssueTreeNode } from "@greatstone/shared";
import { ArrowLeft } from "lucide-react";
import { Link, useNavigate, useParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { accessApi } from "../api/access";
import { authApi } from "../api/auth";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { buildCompanyUserProfileMap } from "../lib/company-members";
import { useIsPhone } from "../hooks/useIsPhone";
import {
  ancestorIds,
  indexTaskTree,
  traceBlockedPaths,
  visibleTaskTree,
  type RootBlocker,
  type VisibleTaskItem,
} from "../lib/task-tree";
import { PageSkeleton } from "../components/PageSkeleton";
import { ErrorState } from "../components/ErrorState";
import { TaskTreeCanvas } from "../components/task-tree/TaskTreeCanvas";
import { TaskTreeHeader, countTreeStatuses } from "../components/task-tree/TaskTreeHeader";
import { TaskTreeOutline } from "../components/task-tree/TaskTreeOutline";
import type { TaskTreePeople } from "../components/task-tree/TaskTreeOwner";

/** The tree refreshes on its own so statuses stay current. */
const TREE_REFETCH_MS = 60_000;

export function taskHref(node: Pick<IssueTreeNode, "id" | "identifier">) {
  return `/issues/${node.identifier ?? node.id}`;
}

/**
 * The Tree view (/:prefix/issues/:key/tree): a big piece of work at a glance.
 * The main task at the top, everything under it as branches, and what is
 * blocking what. A canvas on larger screens, an outline on a phone.
 */
export function TaskTree() {
  const { issueId = "" } = useParams<{ issueId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const isPhone = useIsPhone();

  const treeQuery = useQuery({
    queryKey: queryKeys.issueTree(issueId),
    queryFn: () => issuesApi.getTree(issueId),
    enabled: !!issueId,
    refetchInterval: TREE_REFETCH_MS,
  });
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: members } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId!),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const viewerUserId = session?.user?.id ?? session?.session?.userId ?? null;

  const people = useMemo<TaskTreePeople>(
    () => ({
      agents: new Map((agents ?? []).map((agent) => [agent.id, agent])),
      users: buildCompanyUserProfileMap(members?.users),
      viewerUserId,
    }),
    [agents, members?.users, viewerUserId],
  );

  const index = useMemo(() => (treeQuery.data ? indexTaskTree(treeQuery.data) : null), [treeQuery.data]);
  const [showFinished, setShowFinished] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [focusRequest, setFocusRequest] = useState<{ id: string; nonce: number } | null>(null);

  const visibleRoot = useMemo(
    () => (index ? visibleTaskTree(index, { showFinished, collapsed }) : null),
    [index, showFinished, collapsed],
  );
  const trace = useMemo(() => (index ? traceBlockedPaths(index, viewerUserId) : null), [index, viewerUserId]);
  const waitingOnById = useMemo(() => {
    const map = new Map<string, string>();
    // A blocked task names what it waits on: the next task down its chain...
    for (const link of trace?.blockLinks ?? []) {
      const blocker = index?.byId.get(link.from);
      if (blocker && !map.has(link.to)) map.set(link.to, blocker.identifier ?? blocker.title);
    }
    // ...or a task outside the tree.
    for (const blocker of trace?.rootBlockers ?? []) {
      if (!blocker.inTree && !map.has(blocker.anchorId)) map.set(blocker.anchorId, blocker.identifier ?? blocker.title);
    }
    return map;
  }, [trace, index]);

  const root = index?.root;
  useEffect(() => {
    setBreadcrumbs([
      { label: "Tasks", href: "/issues" },
      { label: root?.identifier ?? root?.title ?? "Task", href: `/issues/${issueId}` },
      { label: "Tree" },
    ]);
  }, [setBreadcrumbs, issueId, root?.identifier, root?.title]);

  const toggleCollapsed = useCallback((id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectBlocker = useCallback(
    (blocker: RootBlocker) => {
      if (!index) return;
      // Unfold every branch on the way, so the task is on screen.
      const path = ancestorIds(index, blocker.anchorId);
      setCollapsed((current) => {
        if (!path.some((id) => current.has(id))) return current;
        const next = new Set(current);
        for (const id of path) next.delete(id);
        return next;
      });
      setFocusRequest({ id: blocker.anchorId, nonce: Date.now() });
    },
    [index],
  );

  useEffect(() => {
    if (!isPhone || !focusRequest) return;
    document
      .querySelector(`[data-outline-node="${focusRequest.id}"]`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [isPhone, focusRequest]);

  if (treeQuery.isLoading) return <PageSkeleton variant="detail" />;
  if (treeQuery.error || !index || !visibleRoot || !trace || !root) {
    return (
      <ErrorState
        error={treeQuery.error ?? new Error("This task could not be found.")}
        title="The task tree did not load"
        onRetry={() => void treeQuery.refetch()}
        retrying={treeQuery.isFetching}
      />
    );
  }

  const truncatedNote = index.truncated
    ? `Showing the first ${index.limits.maxNodes} tasks, up to ${index.limits.maxDepth} levels down. Open a sub-task's own tree to see the rest.`
    : null;

  const actions = (
    <>
      <label className="inline-flex items-center gap-2 text-sm">
        <ToggleSwitch checked={showFinished} onCheckedChange={setShowFinished} aria-label="Show finished work" />
        <span>Show finished work</span>
      </label>
      <Button asChild variant="outline" size="sm">
        <Link to={`/issues/${issueId}`}>
          <ArrowLeft />
          Back to task
        </Link>
      </Button>
    </>
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-4" data-task-tree-page="">
      <TaskTreeHeader
        root={root}
        counts={countTreeStatuses(index.byId.values(), root.id)}
        rootBlockers={trace.rootBlockers}
        people={people}
        onSelectBlocker={selectBlocker}
        truncatedNote={truncatedNote}
        actions={actions}
      />
      {isPhone ? (
        <TaskTreeOutline
          visibleRoot={visibleRoot}
          trace={trace}
          people={people}
          hrefFor={(item: VisibleTaskItem) => taskHref(item.node)}
          waitingOnById={waitingOnById}
          onToggleCollapsed={toggleCollapsed}
          onShowFinished={() => setShowFinished(true)}
          highlightId={focusRequest?.id ?? null}
        />
      ) : (
        <TaskTreeCanvas
          className="min-h-96 flex-1"
          visibleRoot={visibleRoot}
          trace={trace}
          people={people}
          waitingOnById={waitingOnById}
          onOpen={(node) => navigate(taskHref(node))}
          onToggleCollapsed={toggleCollapsed}
          onShowFinished={() => setShowFinished(true)}
          focusRequest={focusRequest}
        />
      )}
    </div>
  );
}
