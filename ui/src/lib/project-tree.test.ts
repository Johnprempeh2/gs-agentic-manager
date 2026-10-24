import { describe, expect, it } from "vitest";
import type { IssueTreeNode, ProjectTree } from "@greatstone/shared";
import { initiallyCollapsed, projectRootId, projectTreeAsTaskTree, unsortedId } from "./project-tree";
import { indexTaskTree, traceBlockedPaths, visibleTaskTree } from "./task-tree";

function node(id: string, parentId: string | null, values: Partial<IssueTreeNode> = {}): IssueTreeNode {
  return {
    id,
    identifier: `GRE-${id}`,
    title: `Task ${id}`,
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    parentId,
    depth: 0,
    blockedByIds: [],
    childCount: 0,
    doneChildCount: 0,
    terminalBlockerId: null,
    unblockAction: null,
    updatedAt: new Date(0),
    ...values,
  };
}

const tree: ProjectTree = {
  project: { id: "p", name: "Platform", status: "in_progress", lead: { agentId: "lead", covering: false } },
  keyTaskIds: ["k1", "k2"],
  unsortedIds: ["u1"],
  nodes: [
    node("k1", null, { status: "in_progress", isKeyTask: true, childCount: 2, doneChildCount: 1 }),
    node("c1", "k1"),
    node("k2", null, { status: "done", isKeyTask: true }),
    node("u1", null),
  ],
  externalBlockers: [],
  hiddenDoneByParent: { k1: 4, k2: 2 },
  keyTaskProgress: { k1: { done: 4, total: 5 }, k2: { done: 2, total: 2 } },
  counts: { done: 7, active: 1, blocked: 0, waiting: 2 },
  openTidyTaskId: null,
  truncated: false,
  limits: { maxNodes: 300, maxDepth: 12 },
};

describe("project tree as a task tree", () => {
  it("hangs key tasks under the project and unsorted work under one card", () => {
    const { tree: shaped, hiddenDone } = projectTreeAsTaskTree(tree);
    const byId = new Map(shaped.nodes.map((entry) => [entry.id, entry]));
    expect(shaped.rootId).toBe(projectRootId("p"));
    expect(byId.get(projectRootId("p"))).toMatchObject({ title: "Platform", assigneeAgentId: "lead", childCount: 10, doneChildCount: 7 });
    expect(byId.get("k1")).toMatchObject({ parentId: projectRootId("p"), childCount: 5, doneChildCount: 4 });
    expect(byId.get("c1")?.parentId).toBe("k1");
    expect(byId.get("u1")?.parentId).toBe(unsortedId("p"));
    expect(byId.get(unsortedId("p"))?.parentId).toBe(projectRootId("p"));
    expect(hiddenDone.get("k1")).toBe(4);
  });

  it("folds counted finished work into the done pills", () => {
    const { tree: shaped, hiddenDone } = projectTreeAsTaskTree(tree);
    const index = indexTaskTree(shaped, hiddenDone)!;
    const visible = visibleTaskTree(index, { showFinished: false, collapsed: new Set() });
    const k1 = visible.children.find((item) => item.id === "k1");
    expect(k1?.kind === "task" && k1.children.map((item) => item.id)).toEqual(["c1", "k1:done"]);
    expect(k1?.kind === "task" && k1.children[1]).toMatchObject({ count: 4 });
    // The finished key task folds into the project's pill with its hidden work.
    expect(visible.children.find((item) => item.kind === "done")).toMatchObject({ count: 3 });
    // A branch with only counted work can still be folded.
    expect(k1?.kind === "task" && k1.descendants).toBe(5);
  });

  it("starts finished key tasks folded", () => {
    expect([...initiallyCollapsed(tree)]).toEqual(["k2"]);
  });

  it("never makes the project its own blocker when all its open work is blocked (GRE-2290)", () => {
    const stuck: ProjectTree = {
      ...tree,
      nodes: [...tree.nodes.filter((entry) => entry.id !== "k1"), node("k1", null, { status: "blocked", isKeyTask: true, unblockAction: "Sign the contract" })],
      counts: { done: 7, active: 0, blocked: 1, waiting: 2 },
    };
    const { tree: shaped, hiddenDone } = projectTreeAsTaskTree(stuck);
    expect(shaped.nodes.find((entry) => entry.id === projectRootId("p"))?.status).not.toBe("blocked");
    const trace = traceBlockedPaths(indexTaskTree(shaped, hiddenDone)!);
    expect(trace.rootBlockers.map((blocker) => blocker.id)).toEqual(["k1"]);
  });

  it("leaves out the Unsorted card when everything is placed", () => {
    const { tree: shaped } = projectTreeAsTaskTree({ ...tree, unsortedIds: [], nodes: tree.nodes.filter((entry) => entry.id !== "u1") });
    expect(shaped.nodes.some((entry) => entry.id === unsortedId("p"))).toBe(false);
  });
});
