import { describe, expect, it } from "vitest";
import type { OrgNode } from "../api/agents";
import { CARD_H, CARD_W, collectEdges, flattenLayout, layoutForest } from "./org-chart-layout";

function agent(id: string, reports: OrgNode[] = []): OrgNode {
  return { id, name: id, role: "engineer", status: "active", reports } as OrgNode;
}

function overlaps(a: { x: number; y: number }, b: { x: number; y: number }) {
  return a.x < b.x + CARD_W && b.x < a.x + CARD_W && a.y < b.y + CARD_H && b.y < a.y + CARD_H;
}

function expectNoOverlap(nodes: Array<{ id: string; x: number; y: number }>) {
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      expect(overlaps(nodes[i]!, nodes[j]!), `${nodes[i]!.id} overlaps ${nodes[j]!.id}`).toBe(false);
    }
  }
}

describe("org chart layout", () => {
  it("lays up to four reports out in one row", () => {
    const [root] = layoutForest([agent("lead", ["a", "b", "c", "d"].map((id) => agent(id)))]);
    expect(root!.childLayout).toBe("row");
    expect(new Set(root!.children.map((c) => c.y)).size).toBe(1);
  });

  it("stacks more than four reports in compact columns", () => {
    const reports = Array.from({ length: 9 }, (_, i) => agent(`r${i}`));
    const [root] = layoutForest([agent("lead", reports)]);
    const xs = new Set(root!.children.map((c) => c.x));

    expect(root!.childLayout).toBe("compact");
    expect(xs.size).toBe(2);
    // Nine reports in a row would be ~2,500px wide; the columns stay narrow.
    const right = Math.max(...root!.children.map((c) => c.x + CARD_W));
    const left = Math.min(...root!.children.map((c) => c.x));
    expect(right - left).toBeLessThan(CARD_W * 2 + 120);
    expectNoOverlap(flattenLayout([root!]));
  });

  it("keeps cards apart when compact reports have their own teams", () => {
    const reports = Array.from({ length: 6 }, (_, i) =>
      agent(`r${i}`, i % 2 === 0 ? [agent(`r${i}-a`), agent(`r${i}-b`)] : []),
    );
    const roots = layoutForest([agent("lead", reports), agent("other", [agent("o1")])]);
    expectNoOverlap(flattenLayout(roots));
  });

  it("hides the reports of a collapsed manager but remembers how many there are", () => {
    const [root] = layoutForest([agent("lead", [agent("a"), agent("b")])], new Set(["lead"]));
    expect(root!.children).toHaveLength(0);
    expect(root!.collapsed).toBe(true);
    expect(root!.reportCount).toBe(2);
    expect(collectEdges([root!])).toHaveLength(0);
  });

  it("draws compact edges along a spine to each card's left edge", () => {
    const reports = Array.from({ length: 5 }, (_, i) => agent(`r${i}`));
    const [root] = layoutForest([agent("lead", reports)]);
    for (const edge of collectEdges([root!])) {
      expect(edge.path.endsWith(`H ${edge.child.x}`)).toBe(true);
    }
  });
});
