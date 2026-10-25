import type { IssueTree, IssueTreeExternalBlocker, IssueTreeNode } from "@greatstone/shared";
import { describe, expect, it } from "vitest";
import { matchFindItems } from "@/components/diagram/DiagramFrame";
import { flattenVisible, indexTaskTree, outsideGroupId, traceBlockedPaths, visibleStandIn, visibleTaskTree } from "./task-tree";
import { blockedAndWhyIds, blockerChain, buildLinkGraph, loopThrough, routeBlockLinks, treeLinksFrom } from "./task-tree-links";

// GRE-2290: the tree shows every blocking link, however long the chain.

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
    depth: parentId ? 1 : 0,
    blockedByIds: [],
    childCount: 0,
    doneChildCount: 0,
    terminalBlockerId: null,
    unblockAction: null,
    updatedAt: new Date("2026-10-24T09:00:00Z"),
    ...values,
  };
}

function outside(id: string, values: Partial<IssueTreeExternalBlocker> = {}): IssueTreeExternalBlocker {
  return {
    id,
    identifier: `GRE-${id}`,
    title: `Outside ${id}`,
    status: "blocked",
    assigneeAgentId: null,
    assigneeUserId: null,
    projectId: "p-web",
    projectName: "Website",
    ...values,
  };
}

const links = (pairs: Array<[string, string]>) => pairs.map(([blockerId, blockedId]) => ({ blockerId, blockedId }));

function tree(values: Partial<IssueTree>): IssueTree {
  return { rootId: "1", nodes: [node("1", null)], externalBlockers: [], truncated: false, limits: { maxNodes: 2000, maxDepth: 12 }, ...values };
}

describe("tree links", () => {
  it("follows a long chain to its end, every hop", () => {
    const hops = Array.from({ length: 40 }, (_, index) => `${100 + index}`);
    const index = indexTaskTree(
      tree({
        nodes: [node("1", null), node("2", "1", { status: "blocked" })],
        externalBlockers: hops.map((id, at) => outside(id, { status: at === hops.length - 1 ? "todo" : "blocked" })),
        blockLinks: links(hops.map((id, at) => [id, at === 0 ? "2" : hops[at - 1]!])),
      }),
    )!;
    expect(blockerChain(index.graph, "100")).toEqual(hops);
    // The header's root blocker is the far end, not the first hop.
    const trace = traceBlockedPaths(index);
    expect(trace.rootBlockers.map((blocker) => blocker.id)).toEqual(["139"]);
    expect(trace.rootBlockers[0]!.anchorId).toBe("2");
  });

  it("keeps every blocker of a task and every task a blocker holds up", () => {
    const heldUp = Array.from({ length: 20 }, (_, index) => `${200 + index}`);
    const graph = buildLinkGraph(
      treeLinksFrom(
        links([["a", "t"], ["b", "t"], ...heldUp.map((id): [string, string] => ["a", id])]),
        [],
        () => true,
      ),
    );
    expect(graph.blockersOf.get("t")).toEqual(["a", "b"]);
    expect(graph.blocksOf.get("a")).toHaveLength(21);
  });

  it("marks a loop, finds its path and never hangs", () => {
    const graph = buildLinkGraph(
      treeLinksFrom(links([["a", "b"], ["b", "a"], ["c", "a"], ["b", "d"]]), [], () => true),
    );
    expect([...graph.loopNodeIds].sort()).toEqual(["a", "b"]);
    expect([...graph.loopLinks].sort()).toEqual(["a>b", "b>a"]);
    expect(loopThrough(graph, "a")).toEqual(["a", "b", "a"]);
    expect(loopThrough(graph, "c")).toBeNull();
    // A chain into a loop stops where it comes back round.
    expect(blockerChain(graph, "b")).toEqual(["b", "a", "c"]);
  });

  it("finds a loop thousands of tasks long without running out of stack", () => {
    const ids = Array.from({ length: 5000 }, (_, index) => `n${index}`);
    const graph = buildLinkGraph(ids.map((id, at) => ({ from: id, to: ids[(at + 1) % ids.length]! })));
    expect(graph.loopNodeIds.size).toBe(5000);
    expect(graph.loopLinks.size).toBe(5000);
  });

  it("reads links off open blockers when an older server sends none", () => {
    const index = indexTaskTree(
      tree({
        nodes: [node("1", null), node("2", "1", { status: "blocked", blockedByIds: ["3", "4"] }), node("3", "1", { status: "done" }), node("4", "1")],
      }),
    )!;
    expect(index.graph.links).toEqual([{ from: "4", to: "2" }]);
  });
});

describe("tasks outside the tree", () => {
  const data = () =>
    tree({
      nodes: [node("1", null), node("2", "1", { status: "blocked" })],
      externalBlockers: [outside("9"), outside("8", { projectName: null, projectId: null, status: "todo" })],
      blockLinks: links([["9", "2"], ["8", "9"]]),
    });

  it("shows them open, on one card under the root, with their project", () => {
    const index = indexTaskTree(data())!;
    const root = visibleTaskTree(index, { showFinished: false, collapsed: new Set() });
    const group = root.children.find((item) => item.kind === "task" && item.group);
    expect(group?.id).toBe(outsideGroupId("1"));
    expect(group?.kind === "task" && group.collapsed).toBe(false);
    const cards = group?.kind === "task" ? group.children : [];
    expect(cards.map((item) => item.kind === "task" && [item.id, item.outside?.projectName])).toEqual([
      ["8", null],
      ["9", "Website"],
    ]);
  });

  it("lands a link on the outside card when the reader folds it", () => {
    const index = indexTaskTree(data())!;
    const folded = visibleTaskTree(index, { showFinished: false, collapsed: new Set([outsideGroupId("1")]) });
    const shown = new Set(flattenVisible(folded).map((item) => item.id));
    expect(visibleStandIn(index, shown, "9")).toBe(outsideGroupId("1"));
    expect(visibleStandIn(index, shown, "2")).toBe("2");
  });
});

describe("only what's blocked and why", () => {
  it("keeps blocked tasks, everything up their chains, and the way down to them", () => {
    const index = indexTaskTree(
      tree({
        nodes: [
          node("1", null, { status: "in_progress" }),
          node("2", "1"),
          { ...node("3", "2", { status: "blocked" }), depth: 2 },
          node("4", "1", { status: "in_progress" }),
          node("5", "1"),
        ],
        externalBlockers: [outside("9"), outside("7", { status: "todo" })],
        blockLinks: links([["4", "3"], ["9", "4"], ["7", "9"], ["5", "6"]]),
      }),
    )!;
    const only = blockedAndWhyIds(index.graph, [...index.byId.values(), ...index.external.values()]);
    expect([...only].sort()).toEqual(["3", "4", "7", "9"]);
    const root = visibleTaskTree(index, { showFinished: false, collapsed: new Set(), only });
    const ids = flattenVisible(root).map((item) => item.id);
    // 2 stays as the way down to 3; 5 blocks nothing blocked, so it goes.
    expect(ids).toEqual(["1", "2", "3", "4", outsideGroupId("1"), "7", "9"]);
  });

  it("is empty when nothing is blocked", () => {
    const index = indexTaskTree(tree({ nodes: [node("1", null), node("2", "1")] }))!;
    expect(blockedAndWhyIds(index.graph, index.byId.values()).size).toBe(0);
  });
});

describe("find", () => {
  const items = [
    { id: "1", label: "Landing page", detail: "GRE-1935 · Website" },
    { id: "2", label: "Staging upload", detail: "GRE-1989" },
    { id: "3", label: "Copy review", detail: undefined },
  ];

  it("matches by title, key or project, ignoring case", () => {
    expect(matchFindItems(items, "landing").map((item) => item.id)).toEqual(["1"]);
    expect(matchFindItems(items, "gre-1989").map((item) => item.id)).toEqual(["2"]);
    expect(matchFindItems(items, "website").map((item) => item.id)).toEqual(["1"]);
    expect(matchFindItems(items, "  ")).toEqual([]);
  });

  it("finds a task outside the tree and opens the way to it", () => {
    const index = indexTaskTree(
      tree({ nodes: [node("1", null), node("2", "1", { status: "blocked" })], externalBlockers: [outside("9")], blockLinks: links([["9", "2"]]) }),
    )!;
    const all = flattenVisible(visibleTaskTree(index, { showFinished: false, collapsed: new Set() }));
    expect(all.some((item) => item.id === "9")).toBe(true);
  });
});

// GRE-2384: one line per pair of tasks.
describe("routing blocking onto tree lines", () => {
  // 1 has children 2 and 5; 2 has child 3; 3 has child 4.
  const edges = [
    { from: "1", to: "2" },
    { from: "2", to: "3" },
    { from: "3", to: "4" },
    { from: "1", to: "5" },
  ];
  const link = (from: string, to: string) => ({ from, to });

  it("puts a parent and child link on the line that joins them, either way round", () => {
    const routed = routeBlockLinks([link("2", "3"), link("4", "3")], edges);
    expect(routed.lines).toEqual([]);
    expect(routed.onEdges.get("2>3")?.links).toEqual([link("2", "3")]);
    expect(routed.onEdges.get("3>4")?.links).toEqual([link("4", "3")]);
  });

  it("draws its own line only across branches", () => {
    const routed = routeBlockLinks([link("5", "3"), link("2", "3")], edges);
    expect(routed.lines).toEqual([link("5", "3")]);
    expect([...routed.onEdges.keys()]).toEqual(["2>3"]);
  });

  it("adds no shortcut where a chain already runs along tree lines, and names it on each hop", () => {
    const routed = routeBlockLinks([link("1", "2"), link("2", "3"), link("3", "4"), link("1", "4")], edges);
    expect(routed.lines).toEqual([]);
    for (const key of ["1>2", "2>3", "3>4"]) {
      expect(routed.onEdges.get(key)?.via).toEqual([{ link: link("1", "4"), through: ["2", "3"] }]);
    }
  });

  it("keeps the shortcut when the chain is broken or runs the other way", () => {
    expect(routeBlockLinks([link("1", "2"), link("1", "3")], edges).lines).toEqual([link("1", "3")]);
    expect(routeBlockLinks([link("2", "1"), link("3", "2"), link("1", "3")], edges).lines).toEqual([link("1", "3")]);
  });
});
