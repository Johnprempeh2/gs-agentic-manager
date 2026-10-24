import { useEffect, useMemo, useState } from "react";
import { TaskRunStatesContext, useTaskRunStates } from "../hooks/useTaskRunStates";
import { useQuery } from "@tanstack/react-query";
import type { IssueTreeNode } from "@greatstone/shared";
import { FileText, Maximize2, Network } from "lucide-react";
import { Link, useLocation, useNavigate, useParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { issuesApi } from "../api/issues";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { useIsPhone } from "../hooks/useIsPhone";
import { useTaskTreePeople } from "../hooks/useTaskTreePeople";
import { indexTaskTree, type VisibleTaskItem } from "../lib/task-tree";
import { TASK_PAGE_QUERY } from "./TaskDefaultView";
import { PageSkeleton } from "../components/PageSkeleton";
import { ErrorState } from "../components/ErrorState";
import { TaskTreeCanvas } from "../components/task-tree/TaskTreeCanvas";
import { TaskTreeHeader, countTreeStatuses } from "../components/task-tree/TaskTreeHeader";
import { TaskTreeOutline } from "../components/task-tree/TaskTreeOutline";
import { useTaskTreeView } from "../components/task-tree/useTaskTreeView";

/** The tree refreshes on its own so statuses stay current. */
const TREE_REFETCH_MS = 60_000;

/** From the tree, a task opens its full page: the reader already sees its branch. */
export function taskHref(node: Pick<IssueTreeNode, "id" | "identifier">) {
  return `/issues/${node.identifier ?? node.id}${TASK_PAGE_QUERY}`;
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
  const location = useLocation();
  const isPhone = useIsPhone();
  // Working, queued or stuck per node (GRE-2246).
  const taskRunStates = useTaskRunStates(selectedCompanyId);
  const people = useTaskTreePeople(selectedCompanyId);

  const treeQuery = useQuery({
    queryKey: queryKeys.issueTree(issueId),
    queryFn: () => issuesApi.getTree(issueId),
    enabled: !!issueId,
    refetchInterval: TREE_REFETCH_MS,
  });

  const index = useMemo(() => (treeQuery.data ? indexTaskTree(treeQuery.data) : null), [treeQuery.data]);
  const [showFinished, setShowFinished] = useState(false);
  const storageKey = issueId ? `task-tree.${issueId}` : undefined;
  const view = useTaskTreeView(index, {
    viewerUserId: people.viewerUserId ?? null,
    isPhone,
    showFinished,
    storageKey,
    people,
  });
  const { toggleCollapsed, visibleRoot, trace, waitingOnById, blockReasonById, focusRequest, selectBlocker } = view;
  const [diagramOpen, setDiagramOpen] = useState(false);

  const root = index?.root;
  const project = treeQuery.data?.project ?? null;
  useEffect(() => {
    setBreadcrumbs([
      ...(project
        ? [
            { label: "Projects", href: "/projects" },
            { label: project.name, href: `/projects/${project.id}/tree` },
          ]
        : [{ label: "Tasks", href: "/issues" }]),
      { label: root?.identifier ?? root?.title ?? "Task", href: `/issues/${issueId}${TASK_PAGE_QUERY}` },
      { label: "Tree" },
    ]);
  }, [setBreadcrumbs, issueId, root?.identifier, root?.title, project]);

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
      {project ? (
        <Button asChild variant="outline" size="sm">
          <Link to={`/projects/${project.id}/tree`}>
            <Network />
            Project tree
          </Link>
        </Button>
      ) : null}
      <Button asChild variant="outline" size="sm">
        <Link to={`/issues/${issueId}${TASK_PAGE_QUERY}`} state={location.state}>
          <FileText />
          Open task page
        </Link>
      </Button>
    </>
  );

  return (
    // The task route drops the shell's top padding for the thread; the tree puts it back so its header sits where every other page's does.
    <TaskRunStatesContext.Provider value={taskRunStates}>
      <div className="flex h-full min-h-0 w-full flex-col gap-6 md:pt-6" data-task-tree-page="">
        <TaskTreeHeader
          root={root}
          counts={countTreeStatuses(index.byId.values(), root.id)}
          rootBlockers={trace.rootBlockers}
          people={people}
          onSelectBlocker={selectBlocker}
          truncatedNote={truncatedNote}
          actions={actions}
        />
        {isPhone && !diagramOpen ? (
          <div className="flex">
            <Button type="button" variant="outline" size="sm" onClick={() => setDiagramOpen(true)} data-open-diagram="">
              <Maximize2 />
              Open the diagram full screen
            </Button>
          </div>
        ) : null}
        {isPhone && !diagramOpen ? (
          <TaskTreeOutline
            visibleRoot={visibleRoot}
            trace={trace}
            people={people}
            hrefFor={(item: VisibleTaskItem) => taskHref(item.node)}
            waitingOnById={waitingOnById}
            blockReasonById={blockReasonById}
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
            blockReasonById={blockReasonById}
            onOpen={(node) => navigate(taskHref(node))}
            onToggleCollapsed={toggleCollapsed}
            onShowFinished={() => setShowFinished(true)}
            focusRequest={focusRequest}
            storageKey={storageKey}
            findItems={view.findItems}
            onFind={view.reveal}
            onCollapseAll={view.collapseAll}
            onExpandAll={view.expandAll}
            startFullscreen={isPhone}
            onExitFullscreen={() => setDiagramOpen(false)}
          />
        )}
      </div>
    </TaskRunStatesContext.Provider>
  );
}
