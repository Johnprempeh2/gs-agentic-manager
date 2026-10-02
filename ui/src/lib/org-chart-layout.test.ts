import { describe, expect, it } from "vitest";
import type { OrgNode } from "../api/agents";
import type { AgentTeam } from "@greatstone/shared";
import { groupAgentsByTeam } from "./agent-teams";
import {
  CARD_H,
  CARD_W,
  collectEdges,
  flattenLayout,
  layoutForest,
  layoutTeamGroups,
  TEAM_ROW_MAX_WIDTH,
  PADDING,
} from "./org-chart-layout";

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

function team(id: string, memberAgentIds: string[]): AgentTeam {
  return {
    id,
    companyId: "c",
    name: id,
    color: "#2563eb",
    description: null,
    leadAgentId: null,
    memberAgentIds,
    createdAt: "2026-10-02T00:00:00Z",
    updatedAt: "2026-10-02T00:00:00Z",
  };
}

describe("group by team layout", () => {
  const people = ["a", "b", "c", "d", "e"].map((id) => agent(id));

  it("puts every member's card inside its team box, with no overlaps", () => {
    const groups = groupAgentsByTeam(people, [team("t1", ["a", "b", "c", "d"]), team("t2", ["b", "e"])]);
    const { nodes, boxes } = layoutTeamGroups(groups);

    expect(boxes.map((b) => b.key)).toEqual(["t1", "t2"]);
    for (const node of nodes) {
      const box = boxes.find((b) => node.key.startsWith(`${b.key}:`))!;
      expect(node.x).toBeGreaterThanOrEqual(box.x);
      expect(node.y).toBeGreaterThanOrEqual(box.y);
      expect(node.x + CARD_W).toBeLessThanOrEqual(box.x + box.width);
      expect(node.y + CARD_H).toBeLessThanOrEqual(box.y + box.height);
    }
    expectNoOverlap(nodes.map((n) => ({ ...n, id: n.key })));
  });

  it("gives an agent in two teams a card in each box, with unique keys", () => {
    const { nodes } = layoutTeamGroups(groupAgentsByTeam(people, [team("t1", ["a", "b"]), team("t2", ["b"])]));
    const bCards = nodes.filter((n) => n.id === "b");
    expect(bCards.map((n) => n.key)).toEqual(["t1:b", "t2:b"]);
    expect(new Set(nodes.map((n) => n.key)).size).toBe(nodes.length);
  });

  it("adds a No team box for agents in no team and draws no reporting lines", () => {
    const { nodes, boxes } = layoutTeamGroups(groupAgentsByTeam([agent("lead", [agent("x")]), agent("x")], [team("t1", ["lead"])]));
    expect(boxes.map((b) => b.key)).toEqual(["t1", "none"]);
    expect(boxes[1]!.team).toBeNull();
    expect(collectEdges(nodes)).toHaveLength(0);
  });

  it("wraps team boxes into rows instead of one very wide line", () => {
    const many = Array.from({ length: 8 }, (_, i) => agent(`p${i}`));
    const teams = many.map((p) => team(`t-${p.id}`, [p.id]));
    const { boxes } = layoutTeamGroups(groupAgentsByTeam(many, teams));
    expect(new Set(boxes.map((b) => b.y)).size).toBeGreaterThan(1);
    for (const box of boxes) expect(box.x + box.width).toBeLessThanOrEqual(PADDING + TEAM_ROW_MAX_WIDTH);
  });
});
