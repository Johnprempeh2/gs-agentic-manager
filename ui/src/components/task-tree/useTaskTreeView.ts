import { useCallback, useEffect, useMemo, useState } from "react";
import { readDiagramPrefs, writeDiagramPrefs } from "@/components/diagram/useDiagramViewport";
import type { DiagramFindItem } from "@/components/diagram/DiagramFrame";
import {
  ancestorIds,
  flattenVisible,
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
    /** Remembers folded branches for this tree; `restored` says a remembered fold was used. */
    storageKey?: string;
  },
) {
  const { viewerUserId, isPhone, showFinished, storageKey } = options;
  const [restored] = useState(() => Array.isArray(readDiagramPrefs(storageKey).collapsed));
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => {
    const stored = readDiagramPrefs(storageKey).collapsed;
    if (Array.isArray(stored)) return new Set(stored.filter((id): id is string => typeof id === "string"));
    return options.initialCollapsed?.() ?? new Set();
  });
  // Remember a fold once it changes, not the empty one a first visit starts with.
  const [initial] = useState(collapsed);
  useEffect(() => {
    if (collapsed !== initial) writeDiagramPrefs(storageKey, { collapsed: [...collapsed] });
  }, [collapsed, initial, storageKey]);
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

  /** Unfold every branch on the way to a task and bring it on screen. */
  const reveal = useCallback(
    (id: string) => {
      if (!index) return;
      const path = ancestorIds(index, id);
      setCollapsed((current) => {
        if (!path.some((ancestor) => current.has(ancestor))) return current;
        const next = new Set(current);
        for (const ancestor of path) next.delete(ancestor);
        return next;
      });
      setFocusRequest({ id, nonce: Date.now() });
    },
    [index],
  );
  const selectBlocker = useCallback((blocker: RootBlocker) => reveal(blocker.anchorId), [reveal]);

  /** Fold every branch below the top, so the main branches show. */
  const collapseAll = useCallback(() => {
    if (!index) return;
    setCollapsed(new Set([...index.children.keys()].filter((id) => id !== index.root.id)));
  }, [index]);
  const expandAll = useCallback(() => setCollapsed(new Set()), []);

  // What "Find" can jump to: every task the tree shows when nothing is folded.
  const findItems = useMemo<DiagramFindItem[]>(() => {
    if (!index) return [];
    return flattenVisible(visibleTaskTree(index, { showFinished, collapsed: new Set() }))
      .flatMap((item) => (item.kind === "task" ? [{ id: item.id, label: item.node.title, detail: item.node.identifier ?? undefined }] : []));
  }, [index, showFinished]);

  useEffect(() => {
    if (!isPhone || !focusRequest) return;
    document
      .querySelector(`[data-outline-node="${focusRequest.id}"]`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [isPhone, focusRequest]);

  return {
    collapsed,
    setCollapsed,
    restored,
    toggleCollapsed,
    collapseAll,
    expandAll,
    reveal,
    findItems,
    visibleRoot,
    trace,
    waitingOnById,
    focusRequest,
    selectBlocker,
  };
}
