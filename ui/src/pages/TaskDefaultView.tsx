import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { IssueTree } from "@greatstone/shared";
import { Navigate, useLocation, useParams } from "@/lib/router";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { PageSkeleton } from "../components/PageSkeleton";

/** Add to a task link to open the full task page instead of its tree. */
export const TASK_PAGE_QUERY = "?view=task";

/** A task with a sub-task or a blocker has a tree worth opening on. */
export function treeIsWorthOpening(tree: IssueTree): boolean {
  return tree.nodes.length > 1 || (tree.nodes[0]?.blockedByIds.length ?? 0) > 0;
}

/**
 * The one place a task link decides its view (/issues/:issueId). A task with
 * sub-tasks or blockers opens on its tree; a lone task opens the task page.
 * Any query or hash (`?view=task`, a comment or document anchor, a run link)
 * means "the task page", so the tree's way back can never bounce.
 */
export function TaskDefaultView({
  task,
  loadTask,
  taskLoaded,
}: {
  task: ReactNode;
  /**
   * Loads the task page's code. Until `taskLoaded` says it is in, this view
   * keeps its own skeleton, so the page never suspends after the tree answer
   * (a suspend there shows the route fallback and React holds the page 300 ms).
   */
  loadTask?: () => Promise<unknown>;
  taskLoaded?: () => boolean;
}) {
  const { issueId = "" } = useParams<{ issueId: string }>();
  const location = useLocation();
  // Once a task page is showing, it stays: adding a sub-task, or the page
  // swapping a UUID for the task's key, must not throw the reader into the tree.
  const shownAsTask = useRef(new Set<string>());
  const plainLink = !location.search && !location.hash && !shownAsTask.current.has(issueId);

  const treeQuery = useQuery({
    queryKey: queryKeys.issueTree(issueId),
    queryFn: () => issuesApi.getTree(issueId),
    enabled: plainLink && !!issueId,
    staleTime: 30_000,
    retry: false,
  });

  const [taskLoadFailed, setTaskLoadFailed] = useState(false);
  const [, setTaskArrived] = useState(false);
  const waitingForTask = Boolean(loadTask && taskLoaded && !taskLoaded() && !taskLoadFailed);
  useEffect(() => {
    if (!waitingForTask || !loadTask) return;
    let live = true;
    loadTask().then(
      () => live && setTaskArrived(true),
      // The route's own loader reports the failure (and reloads a stale bundle).
      () => live && setTaskLoadFailed(true),
    );
    return () => {
      live = false;
    };
  }, [waitingForTask, loadTask]);

  if (plainLink && treeQuery.isLoading) return <PageSkeleton variant="detail" />;
  if (plainLink && treeQuery.data && treeIsWorthOpening(treeQuery.data)) {
    // Replace, so Back from the tree returns to wherever the link was.
    return <Navigate to={`/issues/${issueId}/tree`} replace state={location.state} />;
  }

  if (waitingForTask) return <PageSkeleton variant="detail" />;

  shownAsTask.current.add(issueId);
  const root = treeQuery.data?.nodes[0];
  if (root) {
    shownAsTask.current.add(root.id);
    if (root.identifier) shownAsTask.current.add(root.identifier);
  }
  return <>{task}</>;
}
