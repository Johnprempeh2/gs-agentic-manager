import type { IssueStatus, IssueTree, IssueTreeNode, ProjectTree } from "@greatstone/shared";

/**
 * The project tree drawn with the task tree: the project becomes the root
 * card, each key task a branch under it, and the open work under no key task
 * hangs under one "Unsorted" card. Pure functions, no React.
 */

export function projectRootId(projectId: string) {
  return `project:${projectId}`;
}

export function unsortedId(projectId: string) {
  return `project:${projectId}:unsorted`;
}

export function isSyntheticNode(id: string) {
  return id.startsWith("project:");
}

function rootStatus(counts: ProjectTree["counts"]): IssueStatus {
  const total = counts.done + counts.active + counts.blocked + counts.waiting;
  if (total > 0 && counts.done === total) return "done";
  if (counts.blocked > 0 && counts.active === 0) return "blocked";
  if (counts.active > 0 || counts.done > 0) return "in_progress";
  return "todo";
}

function syntheticNode(values: Partial<IssueTreeNode> & Pick<IssueTreeNode, "id" | "title" | "status">): IssueTreeNode {
  return {
    identifier: null,
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    parentId: null,
    depth: 0,
    blockedByIds: [],
    childCount: 0,
    doneChildCount: 0,
    terminalBlockerId: null,
    unblockAction: null,
    isKeyTask: false,
    updatedAt: new Date(0),
    ...values,
  };
}

/** The project tree as a task tree, plus the finished work the server only counted. */
export function projectTreeAsTaskTree(tree: ProjectTree): { tree: IssueTree; hiddenDone: Map<string, number> } {
  const rootId = projectRootId(tree.project.id);
  const sortId = unsortedId(tree.project.id);
  const total = tree.counts.done + tree.counts.active + tree.counts.blocked + tree.counts.waiting;
  const root = syntheticNode({
    id: rootId,
    title: tree.project.name,
    status: rootStatus(tree.counts),
    assigneeAgentId: tree.project.lead.agentId,
    childCount: total,
    doneChildCount: tree.counts.done,
  });
  const keyIds = new Set(tree.keyTaskIds);
  const unsorted = new Set(tree.unsortedIds);
  const nodes: IssueTreeNode[] = [root];
  if (unsorted.size > 0) {
    nodes.push(
      syntheticNode({
        id: sortId,
        parentId: rootId,
        depth: 1,
        title: `Unsorted: ${unsorted.size} open ${unsorted.size === 1 ? "task" : "tasks"} under no key task`,
        status: "todo",
      }),
    );
  }
  for (const node of tree.nodes) {
    if (keyIds.has(node.id)) {
      // A key task's ring shows its whole branch, not just its direct sub-tasks.
      const progress = tree.keyTaskProgress[node.id];
      nodes.push({
        ...node,
        parentId: rootId,
        isKeyTask: true,
        childCount: progress?.total ?? node.childCount,
        doneChildCount: progress?.done ?? node.doneChildCount,
      });
    } else if (unsorted.has(node.id)) {
      nodes.push({ ...node, parentId: sortId });
    } else {
      nodes.push(node);
    }
  }
  return {
    tree: {
      rootId,
      nodes,
      externalBlockers: tree.externalBlockers,
      truncated: tree.truncated,
      limits: tree.limits,
    },
    hiddenDone: new Map(Object.entries(tree.hiddenDoneByParent)),
  };
}

/** Key tasks whose whole branch is finished start folded. */
export function initiallyCollapsed(tree: ProjectTree): Set<string> {
  const byId = new Map(tree.nodes.map((node) => [node.id, node]));
  return new Set(
    tree.keyTaskIds.filter((id) => {
      const node = byId.get(id);
      const progress = tree.keyTaskProgress[id];
      return node?.status === "done" && (!progress || progress.done === progress.total);
    }),
  );
}
