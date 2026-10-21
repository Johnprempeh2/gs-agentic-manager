import { describe, expect, it } from "vitest";
import type { IssueTree, IssueTreeNode } from "@greatstone/shared";
import {
  connectorPath,
  doneItemId,
  edgeKey,
  flattenVisible,
  indexTaskTree,
  layoutTidyTree,
  traceBlockedPaths,
  treeProgress,
  visibleTaskTree,
  type LayoutBox,
  type TaskTreeIndex,
  type VisibleItem,
} from "./task-tree";

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
    updatedAt: new Date("2026-10-20T09:00:00Z"),
    ...values,
  };
}

function tree(nodes: IssueTreeNode[], extra: Partial<IssueTree> = {}): TaskTreeIndex {
  return indexTaskTree({
    rootId: nodes[0]!.id,
    nodes,
    externalBlockers: [],
    truncated: false,
    limits: { maxNodes: 300, maxDepth: 12 },
    ...extra,
  })!;
}

const sizes = { task: { width: 240, height: 120 }, done: { width: 96, height: 32 } };
const options = {
  sizeOf: (item: VisibleItem) => sizes[item.kind],
  siblingGap: 24,
  levelGap: 56,
  padding: 32,
};

function overlaps(a: LayoutBox, b: LayoutBox) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function assertNoOverlap(boxes: LayoutBox[]) {
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      expect(overlaps(boxes[i]!, boxes[j]!), `${boxes[i]!.id} overlaps ${boxes[j]!.id}`).toBe(false);
    }
  }
}

const centre = (box: LayoutBox) => box.x + box.width / 2;

describe("tidy tree layout", () => {
  // An uneven tree: a deep left branch, a bushy right branch, a lone middle leaf.
  const uneven = tree([
    node("1", null),
    node("2", "1"),
    node("3", "1"),
    node("4", "1"),
    node("5", "2"),
    node("6", "5"),
    node("7", "5"),
    node("8", "4"),
    node("9", "4"),
    node("10", "4"),
    node("11", "4"),
    node("12", "9"),
  ]);

  it("never overlaps two cards", () => {
    const layout = layoutTidyTree(visibleTaskTree(uneven, { showFinished: true, collapsed: new Set() }), options);
    expect(layout.boxes).toHaveLength(12);
    assertNoOverlap(layout.boxes);
  });

  it("centres every parent over its children and puts children a row below", () => {
    const layout = layoutTidyTree(visibleTaskTree(uneven, { showFinished: true, collapsed: new Set() }), options);
    for (const box of layout.boxes) {
      const kids = layout.boxes.filter((other) => other.parentId === box.id);
      if (kids.length === 0) continue;
      const first = kids.reduce((a, b) => (a.x < b.x ? a : b));
      const last = kids.reduce((a, b) => (a.x > b.x ? a : b));
      expect(centre(box)).toBeCloseTo((centre(first) + centre(last)) / 2);
      for (const kid of kids) expect(kid.y).toBe(box.y + 120 + 56);
    }
    // Siblings keep their order, left to right.
    const row = layout.boxes.filter((box) => box.parentId === "1").sort((a, b) => a.x - b.x);
    expect(row.map((box) => box.id)).toEqual(["2", "3", "4"]);
  });

  it("fits the whole tree inside its padded size", () => {
    const layout = layoutTidyTree(visibleTaskTree(uneven, { showFinished: true, collapsed: new Set() }), options);
    expect(Math.min(...layout.boxes.map((box) => box.x))).toBe(32);
    expect(Math.max(...layout.boxes.map((box) => box.x + box.width))).toBe(layout.width - 32);
    expect(layout.height).toBe(32 + 4 * 120 + 3 * 56 + 32);
  });

  it("collapses a branch, and its cards and edges go with it", () => {
    const layout = layoutTidyTree(visibleTaskTree(uneven, { showFinished: true, collapsed: new Set(["4"]) }), options);
    expect(layout.byId.has("8")).toBe(false);
    expect(layout.byId.has("12")).toBe(false);
    expect(layout.edges.some((edge) => edge.from === "4")).toBe(false);
    assertNoOverlap(layout.boxes);
  });

  it("draws a smooth connector from the bottom of a parent to the top of a child", () => {
    expect(connectorPath({ x: 0, y: 0, width: 100, height: 50 }, { x: 200, y: 150, width: 100 })).toBe(
      "M 50 50 C 50 100, 250 100, 250 150",
    );
  });
});

describe("visible tree", () => {
  const index = tree([
    node("1", null),
    node("2", "1", { status: "done" }),
    node("3", "2", { status: "done" }),
    node("4", "1", { status: "cancelled" }),
    node("5", "1", { status: "done" }),
    node("6", "5", { status: "todo" }),
    node("7", "1", { status: "in_progress" }),
  ]);

  it("folds finished branches into one +N done pill", () => {
    const root = visibleTaskTree(index, { showFinished: false, collapsed: new Set() });
    const ids = root.children.map((item) => item.id);
    // 5 is done but still has open work under it, so it stays.
    expect(ids).toEqual(["5", "7", doneItemId("1")]);
    const pill = root.children.find((item) => item.kind === "done");
    expect(pill).toMatchObject({ kind: "done", count: 3 });
  });

  it("shows finished work when asked", () => {
    const root = visibleTaskTree(index, { showFinished: true, collapsed: new Set() });
    expect(flattenVisible(root).map((item) => item.id)).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
  });

  it("collapses a node but remembers what is under it", () => {
    const root = visibleTaskTree(index, { showFinished: true, collapsed: new Set(["2"]) });
    const two = root.children.find((item) => item.id === "2");
    expect(two).toMatchObject({ kind: "task", collapsed: true, descendants: 1, children: [] });
  });

  it("counts progress across the subtree, leaving out the root and cancelled work", () => {
    expect(treeProgress(index)).toEqual({ done: 3, total: 5 });
  });
});

describe("blocked path", () => {
  it("traces from the root to the root blocker down a blocking chain", () => {
    // 1 > 2 (blocked by 5) ; 1 > 3 > 4 (blocked by 6) ; 1 > 3 > 5 (blocked by 4) ; 6 is the one to act on.
    const index = tree([
      node("1", null, { status: "in_progress" }),
      node("2", "1", { status: "blocked", blockedByIds: ["5"] }),
      node("3", "1", { status: "in_progress" }),
      node("4", "3", { status: "blocked", blockedByIds: ["6"] }),
      node("5", "3", { status: "blocked", blockedByIds: ["4"] }),
      node("6", "3", { status: "in_review", assigneeUserId: "ben" }),
      node("7", "1", { status: "todo" }),
    ]);
    const trace = traceBlockedPaths(index, "ben");
    expect(trace.rootBlockers.map((blocker) => blocker.id)).toEqual(["6"]);
    expect(trace.rootBlockers[0]).toMatchObject({
      inTree: true,
      anchorId: "6",
      need: "Needs a review",
      waitingOnViewer: true,
    });
    expect(new Set(trace.rootBlockers[0]!.holdsUp)).toEqual(new Set(["2", "4", "5"]));
    expect([...trace.pathEdges].sort()).toEqual([edgeKey("1", "3"), edgeKey("3", "6")]);
    expect(trace.pathNodeIds.has("7")).toBe(false);
    expect(trace.blockLinks).toEqual(
      expect.arrayContaining([
        { from: "5", to: "2" },
        { from: "4", to: "5" },
        { from: "6", to: "4" },
      ]),
    );
  });

  it("treats a blocked task with nothing open blocking it as the root blocker", () => {
    const index = tree([
      node("1", null),
      node("2", "1", { status: "blocked", unblockAction: "Sign the contract", blockedByIds: ["9"] }),
      node("9", "1", { status: "done" }),
    ]);
    const trace = traceBlockedPaths(index);
    expect(trace.rootBlockers).toEqual([
      expect.objectContaining({ id: "2", anchorId: "2", need: "Sign the contract", holdsUp: [] }),
    ]);
    expect([...trace.pathEdges]).toEqual([edgeKey("1", "2")]);
  });

  it("names a blocker outside the tree on the task it holds up, and survives a loop", () => {
    const index = tree(
      [
        node("1", null),
        node("2", "1", { status: "blocked", blockedByIds: ["3", "x"] }),
        node("3", "1", { status: "blocked", blockedByIds: ["2"] }),
      ],
      {
        externalBlockers: [
          { id: "x", identifier: "OPS-4", title: "Vendor", status: "todo", assigneeAgentId: null, assigneeUserId: "naa" },
        ],
      },
    );
    const trace = traceBlockedPaths(index, "ben");
    expect(trace.rootBlockers).toEqual([
      expect.objectContaining({ id: "x", inTree: false, anchorId: "2", need: "Not started yet", waitingOnViewer: false }),
    ]);
  });

  it("puts what is waiting on the viewer first", () => {
    const index = tree([
      node("1", null),
      node("2", "1", { status: "blocked" }),
      node("3", "1", { status: "blocked", assigneeUserId: "ben" }),
    ]);
    expect(traceBlockedPaths(index, "ben").rootBlockers.map((blocker) => blocker.id)).toEqual(["3", "2"]);
  });

  it("finds nothing when nothing is blocked", () => {
    const trace = traceBlockedPaths(tree([node("1", null), node("2", "1")]));
    expect(trace.rootBlockers).toEqual([]);
    expect(trace.pathEdges.size).toBe(0);
  });
});
