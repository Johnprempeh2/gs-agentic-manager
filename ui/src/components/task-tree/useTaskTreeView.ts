import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ancestorIds,
  traceBlockedPaths,
  visibleTaskTree,
  type RootBlocker,
  type TaskTreeIndex,
} from "@/lib/task-tree";

/**
 * What a tree page shows: folded branches, finished work on or off, the
 * blocked paths, and a way to bring a blocker into view. Shared by the task
 * tree and the project tree.
 */
export function useTaskTreeView(
  index: TaskTreeIndex | null,
  options: {
    viewerUserId: string | null;
    isPhone: boolean;
    showFinished: boolean;
    initialCollapsed?: () => ReadonlySet<string>;
  },
) {
  const { viewerUserId, isPhone, showFinished } = options;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => options.initialCollapsed?.() ?? new Set());
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

  return { collapsed, setCollapsed, toggleCollapsed, visibleRoot, trace, waitingOnById, focusRequest, selectBlocker };
}
