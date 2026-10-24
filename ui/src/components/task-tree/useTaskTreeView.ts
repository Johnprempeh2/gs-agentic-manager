import { useCallback, useEffect, useMemo, useState } from "react";
import { readDiagramPrefs, writeDiagramPrefs } from "@/components/diagram/useDiagramViewport";
import type { DiagramFindItem } from "@/components/diagram/DiagramFrame";
import { describeTreeBlocks, type TreeNamePeople } from "@/lib/task-tree-block-reason";
import {
  ancestorIds,
  flattenVisible,
  traceBlockedPaths,
  visibleStandIn,
  visibleTaskTree,
  type RootBlocker,
  type TaskTreeIndex,
} from "@/lib/task-tree";
import { blockedAndWhyIds, linkKey } from "@/lib/task-tree-links";

/** A "blocks" line the canvas draws, between the cards that stand for its two ends. */
export interface VisibleBlockLink {
  from: string;
  to: string;
  /** The link closes a blocking loop. */
  loop: boolean;
  /** One end sits in a folded branch; the line ends on the card that holds it. */
  folded: boolean;
}

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
    /** Names the people a blocked task waits on. */
    people?: TreeNamePeople;
  },
) {
  const { viewerUserId, isPhone, showFinished, storageKey, people } = options;
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
  // "Only what's blocked and why": the reader's choice, off to start (GRE-2290).
  const [blockedOnly, setBlockedOnly] = useState(false);
  const only = useMemo(
    () => (index && blockedOnly ? blockedAndWhyIds(index.graph, [...index.byId.values(), ...index.external.values()]) : null),
    [index, blockedOnly],
  );

  const visibleRoot = useMemo(
    () => (index ? visibleTaskTree(index, { showFinished, collapsed, only }) : null),
    [index, showFinished, collapsed, only],
  );

  // Every link, drawn between the cards that show its ends: a folded end
  // lands on the card it is folded into, so no link ever drops out of sight.
  const visibleBlockLinks = useMemo<VisibleBlockLink[]>(() => {
    if (!index || !visibleRoot) return [];
    const shown = new Set(flattenVisible(visibleRoot).map((item) => item.id));
    const out = new Map<string, VisibleBlockLink>();
    for (const link of index.graph.links) {
      if (only && !(only.has(link.from) && only.has(link.to))) continue;
      const from = visibleStandIn(index, shown, link.from);
      const to = visibleStandIn(index, shown, link.to);
      if (!from || !to || from === to) continue;
      const key = linkKey(from, to);
      const loop = index.graph.loopLinks.has(linkKey(link.from, link.to));
      const folded = from !== link.from || to !== link.to;
      const existing = out.get(key);
      out.set(key, {
        from,
        to,
        loop: loop || (existing?.loop ?? false),
        folded: folded && (existing?.folded ?? true),
      });
    }
    return [...out.values()];
  }, [index, visibleRoot, only]);
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

  // Why each blocked task is blocked, in one line (GRE-2277).
  const blockReasonById = useMemo(
    () => (index ? describeTreeBlocks(index, people ?? { agents: new Map(), users: new Map(), viewerUserId }) : new Map()),
    [index, people, viewerUserId],
  );

  // Every task's links by name, for the hover card and the phone outline.
  const linkNamesById = useMemo(() => {
    const map = new Map<string, { blockedBy: string[]; blocks: string[] }>();
    if (!index) return map;
    const nameOf = (id: string) => {
      const task = index.byId.get(id) ?? index.external.get(id);
      return task ? task.identifier ?? task.title : null;
    };
    const names = (ids: string[] | undefined) => (ids ?? []).map(nameOf).filter((name): name is string => !!name);
    const ids = new Set([...index.graph.blockersOf.keys(), ...index.graph.blocksOf.keys()]);
    for (const id of ids) {
      map.set(id, { blockedBy: names(index.graph.blockersOf.get(id)), blocks: names(index.graph.blocksOf.get(id)) });
    }
    return map;
  }, [index]);

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

  // What "Find" can jump to: every task the tree shows when nothing is
  // folded, outside tasks included, by title, key or project.
  const findItems = useMemo<DiagramFindItem[]>(() => {
    if (!index) return [];
    return flattenVisible(visibleTaskTree(index, { showFinished, collapsed: new Set(), only })).flatMap((item) =>
      item.kind === "task" && !item.group
        ? [
            {
              id: item.id,
              label: item.node.title,
              detail: [item.node.identifier, item.outside?.projectName].filter(Boolean).join(" · ") || undefined,
            },
          ]
        : [],
    );
  }, [index, showFinished, only]);

  // With the filter on, the view is about the blocked cards and what blocks
  // them directly, so the canvas opens fitted to those (GRE-2290).
  const blockedFocusIds = useMemo(() => {
    if (!only || !visibleRoot) return null;
    const ids = new Set<string>();
    for (const link of visibleBlockLinks) {
      ids.add(link.from);
      ids.add(link.to);
    }
    for (const item of flattenVisible(visibleRoot)) {
      if (item.kind === "task" && !item.group && item.node.status === "blocked") ids.add(item.id);
    }
    ids.delete(visibleRoot.id);
    return ids;
  }, [only, visibleRoot, visibleBlockLinks]);

  // The filter changes the tree's shape: the canvas goes back to its home
  // view, and the phone list scrolls back to the top.
  const [homeRequest, setHomeRequest] = useState(0);
  const [filterSeen, setFilterSeen] = useState(blockedOnly);
  useEffect(() => {
    if (!index || filterSeen === blockedOnly) return;
    setFilterSeen(blockedOnly);
    setHomeRequest((count) => count + 1);
    if (isPhone) document.querySelector(`[data-outline-node="${index.root.id}"]`)?.scrollIntoView({ block: "start" });
  }, [index, blockedOnly, filterSeen, isPhone]);

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
    visibleBlockLinks,
    linkNamesById,
    loopIds: index?.graph.loopNodeIds,
    blockedOnly,
    setBlockedOnly,
    /** Tasks the filter keeps; null when it is off. */
    blockedOnlyIds: only,
    /** Cards the canvas fits to with the filter on; null when it is off. */
    blockedFocusIds,
    /** Bumps when the canvas should go back to its home view. */
    homeRequest,
    trace,
    waitingOnById,
    blockReasonById,
    focusRequest,
    selectBlocker,
  };
}
