import { describe, expect, it } from "vitest";
import {
  addNode,
  ancestorIds,
  boardLayout,
  copyBranch,
  defaultFolded,
  flatten,
  indent,
  menuItems,
  moveSibling,
  moveTo,
  outdent,
  outlineRows,
  placeInMenu,
  removeNode,
  type Tree,
} from "./model";

const tree: Tree = {
  nodes: [
    { id: "home", title: "Home", path: "/", parentId: null, order: 0, menu: "none", menuOrder: null },
    { id: "c", title: "Consultancy", path: "/consultancy", parentId: "home", order: 0, menu: "header", menuOrder: 1 },
    { id: "t", title: "Tools", path: "/tools", parentId: "home", order: 1, menu: "header", menuOrder: 2 },
    { id: "d", title: "Deep Dive", path: "/consultancy/deep-dive", parentId: "c", order: 0, menu: "none", menuOrder: null },
  ],
  journeys: [{ id: "j1", name: "Leader", steps: ["home", "c", "d"] }],
};

const order = (t: Tree) => flatten(t).map(({ node, depth }) => `${depth}:${node.id}`);

describe("sitemap model", () => {
  it("moves siblings, indents and outdents like the keyboard buttons", () => {
    expect(order(moveSibling(tree, "t", -1))).toEqual(["0:home", "1:t", "1:c", "2:d"]);
    expect(order(indent(tree, "t"))).toEqual(["0:home", "1:c", "2:d", "2:t"]);
    expect(order(outdent(tree, "d"))).toEqual(["0:home", "1:c", "1:d", "1:t"]);
    expect(moveSibling(tree, "c", -1)).toBe(tree);
  });

  it("refuses to put a page under its own sub-page", () => {
    expect(moveTo(tree, "c", "d")).toBe(tree);
    expect(order(moveTo(tree, "d", "home", 0))).toEqual(["0:home", "1:d", "1:c", "1:t"]);
  });

  it("adds with a free path and removes by moving sub-pages up and out of journeys", () => {
    const added = addNode(tree, "c");
    expect(added.tree.nodes.find((node) => node.id === added.id)!.path).toBe("/consultancy/new-page");
    const removed = removeNode(tree, "c");
    expect(order(removed)).toEqual(["0:home", "1:t", "1:d"]);
    expect(removed.journeys[0]!.steps).toEqual(["home", "d"]);
  });

  it("copies a branch with new ids and free paths", () => {
    const copied = copyBranch(tree, "c", tree, "home");
    expect(copied.nodes).toHaveLength(6);
    const paths = copied.nodes.map((node) => node.path);
    expect(paths).toContain("/consultancy-2");
    expect(paths).toContain("/consultancy/deep-dive-2");
    expect(new Set(copied.nodes.map((node) => node.id)).size).toBe(6);
  });

  it("places pages in menus and renumbers both menus", () => {
    const moved = placeInMenu(tree, "c", "footer");
    expect(menuItems(moved, "header").map((node) => [node.id, node.menuOrder])).toEqual([["t", 1]]);
    expect(menuItems(moved, "footer").map((node) => [node.id, node.menuOrder])).toEqual([["c", 1]]);
    expect(placeInMenu(tree, "t", "header", 0).nodes.find((node) => node.id === "t")!.menuOrder).toBe(1);
  });

  it("lays the board out left to right and keeps stored positions", () => {
    const layout = boardLayout({ ...tree, nodes: tree.nodes.map((node) => (node.id === "t" ? { ...node, x: 900, y: 40 } : node)) });
    expect(layout.get("home")!.x).toBe(0);
    expect(layout.get("c")!.x).toBeGreaterThan(0);
    expect(layout.get("t")).toEqual({ x: 900, y: 40 });
  });

  it("reads the vertical tree top to bottom with a rail for each ancestor that has more below (GRE-2509)", () => {
    const wider: Tree = { ...tree, nodes: [...tree.nodes, { id: "e", title: "Executive", path: "/consultancy/executive", parentId: "c", order: 1, menu: "none", menuOrder: null }] };
    const rows = outlineRows(wider, new Set());
    expect(rows.map((row) => [row.node.id, row.depth, row.rails, row.last, row.childCount])).toEqual([
      ["home", 0, [], true, 2],
      ["c", 1, [], false, 2],
      ["d", 2, [true], false, 0],
      ["e", 2, [true], true, 0],
      ["t", 1, [], true, 0],
    ]);
    const folded = outlineRows(wider, new Set(["c"]));
    expect(folded.map((row) => row.node.id)).toEqual(["home", "c", "t"]);
    expect(folded[1]).toMatchObject({ folded: true, childCount: 2 });
    expect(ancestorIds(wider, "e")).toEqual(["c", "home"]);
  });

  it("opens Home and its sections, and folds a deeper page with more than 12 sub-pages", () => {
    const many = (parentId: string, count: number, prefix: string) =>
      Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}`, title: `${prefix}${i}`, path: `/${prefix}/${i}`, parentId, order: i, menu: "none" as const, menuOrder: null }));
    const big: Tree = { ...tree, nodes: [...tree.nodes, ...many("home", 14, "s"), ...many("c", 13, "p"), ...many("t", 12, "q")] };
    expect([...defaultFolded({ ...big, nodes: [...big.nodes, ...many("d", 13, "r")] })]).toEqual(["d"]);
    expect(defaultFolded(big).size).toBe(0);
  });
});
