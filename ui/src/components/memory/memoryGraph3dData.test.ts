import { describe, expect, it } from "vitest";
import type { MemoryGraphEdge, MemoryGraphNode } from "@greatstone/shared";
import { kestrelAgents, kestrelEdges, kestrelNodes } from "../../fixtures/memoryKestrel";
import {
  buildMemoryGraph3D,
  focusNodeIds,
  HUB_NODE_VAL,
  HUB_PREFIX,
  hubNodeVal,
  MEMORY_NODE_VAL,
  memoryInfluence,
  memoryNodeVal,
  neighbourhood,
} from "./memoryGraph3dData";
import type { MemoryAgentInfo } from "./memoryContributors";

const memoryIds = new Set(kestrelNodes.map((node) => node.id));

function isMemoryToMemory(link: { source: string; target: string }) {
  return memoryIds.has(link.source) && memoryIds.has(link.target);
}

const kestrelAgentList: MemoryAgentInfo[] = [
  { id: "ag-mason-syn", name: "Mason", role: "engineer" },
  { id: "ag-scribe-syn", name: "Scribe", role: "general" },
  { id: "ag-everest-syn", name: "Everest", role: "ceo" },
];

describe("buildMemoryGraph3D", () => {
  it("makes one node per memory and one hub per contributor", () => {
    const graph = buildMemoryGraph3D(kestrelNodes, kestrelEdges);

    const memory = graph.nodes.filter((node) => node.kind === "memory");
    const hubs = graph.nodes.filter((node) => node.kind === "hub");
    expect(memory.map((node) => node.id)).toEqual(kestrelNodes.map((node) => node.id));
    expect(hubs.map((hub) => hub.label).sort()).toEqual(["Everest (synthetic)", "Mason (synthetic)", "Scribe (synthetic)"]);
    expect(hubs.every((hub) => hub.id.startsWith(HUB_PREFIX) && !memoryIds.has(hub.id))).toBe(true);
    expect(hubs.find((hub) => hub.label === "Mason (synthetic)")?.degree).toBe(2);
    expect(graph.memoryCount).toBe(kestrelNodes.length);
    expect(graph.omittedCount).toBe(0);
  });

  it("hides check found links by default and still counts them", () => {
    const graph = buildMemoryGraph3D(kestrelNodes, kestrelEdges);

    expect(graph.showSuggested).toBe(false);
    expect(graph.links.some((link) => link.style === "inferred")).toBe(false);
    expect(graph.statedCount).toBe(3);
    expect(graph.suggestedCount).toBe(1);
    expect(graph.links.filter(isMemoryToMemory).every((link) => link.style === "stated")).toBe(true);
    // Supersedes is a stated link, so it stays.
    expect(graph.links.some((link) => link.edgeType === "supersedes")).toBe(true);
  });

  it("creates memory to memory links only from stated or engine edges, keeping their direction and kind", () => {
    const graph = buildMemoryGraph3D(kestrelNodes, kestrelEdges, { showSuggested: true });

    const between = graph.links.filter(isMemoryToMemory);
    expect(between).toHaveLength(kestrelEdges.length);
    for (const link of between) {
      const edge = kestrelEdges.find((candidate) => candidate.id === link.edgeId);
      expect(edge).toBeDefined();
      expect(link.source).toBe(edge!.from);
      expect(link.target).toBe(edge!.to);
      expect(link.style).toBe(edge!.kind === "explicit" ? "stated" : "inferred");
      expect(link.edgeType).toBe(edge!.type);
    }
  });

  it("adds no memory to memory link when there are no edges, however many memories share a contributor", () => {
    const many: MemoryGraphNode[] = Array.from({ length: 170 }, (_, index) => ({
      ...kestrelNodes[2],
      id: `rec-${index}`,
      contributor: kestrelAgents[["mason", "scribe", "everest"][index % 3]],
    }));
    const graph = buildMemoryGraph3D(many, []);

    const ids = new Set(many.map((node) => node.id));
    expect(graph.links.some((link) => ids.has(link.source) && ids.has(link.target))).toBe(false);
    const provenance = graph.links.filter((link) => link.style === "provenance");
    expect(provenance).toHaveLength(170);
    expect(provenance.every((link) => link.edgeId === null && link.source.startsWith("rec-") && link.target.startsWith(HUB_PREFIX))).toBe(true);
    expect(graph.links.every((link) => link.style === "provenance" || link.style === "orbit")).toBe(true);
  });

  it("flags provenance links as display only: one per memory, to its hub, with no edge id", () => {
    const graph = buildMemoryGraph3D(kestrelNodes, kestrelEdges);

    const provenance = graph.links.filter((link) => link.style === "provenance");
    expect(provenance).toHaveLength(kestrelNodes.length);
    for (const link of provenance) {
      expect(link.edgeId).toBeNull();
      expect(link.edgeType).toBeNull();
      expect(memoryIds.has(link.source)).toBe(true);
      expect(link.target.startsWith(HUB_PREFIX)).toBe(true);
    }
  });

  it("groups by scope on request, with no main agent hub", () => {
    const graph = buildMemoryGraph3D(kestrelNodes, kestrelEdges, { groupBy: "scope", agents: kestrelAgentList });

    const hubs = graph.nodes.filter((node) => node.kind === "hub");
    expect(hubs.map((hub) => hub.label).sort()).toEqual(["Alder Bakery", "Alder website rebuild"]);
    expect(graph.links.filter((link) => link.style === "provenance")).toHaveLength(kestrelNodes.length);
    expect(graph.ceoHubId).toBeNull();
    expect(graph.links.some((link) => link.style === "orbit")).toBe(false);
  });

  it("keeps people apart from agents and from each other, and system checks in their own hub", () => {
    const nodes: MemoryGraphNode[] = [
      { ...kestrelNodes[0], id: "a", contributor: kestrelAgents.john },
      { ...kestrelNodes[0], id: "b", contributor: { ...kestrelAgents.john, userId: "hu-other-syn" } },
      { ...kestrelNodes[0], id: "c", contributor: kestrelAgents.check },
    ];
    const hubs = buildMemoryGraph3D(nodes, []).nodes.filter((node) => node.kind === "hub");
    expect(hubs).toHaveLength(3);
  });

  it("caps the drawing, drops edges to records left out, and reports how many were left out", () => {
    const graph = buildMemoryGraph3D(kestrelNodes, kestrelEdges, { maxNodes: 2, showSuggested: true });

    expect(graph.memoryCount).toBe(2);
    expect(graph.omittedCount).toBe(kestrelNodes.length - 2);
    const drawn = new Set(kestrelNodes.slice(0, 2).map((node) => node.id));
    for (const link of graph.links) {
      if (link.style === "orbit") continue;
      expect(drawn.has(link.source)).toBe(true);
      if (link.style !== "provenance") expect(drawn.has(link.target)).toBe(true);
    }
  });

  it("drops edges whose ends the server did not send", () => {
    const graph = buildMemoryGraph3D([kestrelNodes[0]], kestrelEdges, { showSuggested: true });
    expect(graph.links.filter((link) => link.style === "stated" || link.style === "inferred")).toHaveLength(0);
  });

  it("sizes entries by their influence and finds a node's neighbours", () => {
    const graph = buildMemoryGraph3D(kestrelNodes, kestrelEdges);

    const hours = graph.nodes.find((node) => node.id === "rec-hours")!;
    const weekend = graph.nodes.find((node) => node.id === "rec-weekend")!;
    const delivery = graph.nodes.find((node) => node.id === "rec-delivery")!;
    expect(hours.degree).toBe(4);
    expect(weekend.degree).toBe(1);
    // Hours: 3 stated, 1 suggested, approved. Weekend: 1 stated, approved. Delivery: 1 suggested.
    expect(hours.influence).toBe(3 * 2 + 0.5 + 1.5);
    expect(weekend.influence).toBe(2 + 1.5);
    expect(delivery.influence).toBe(0.5);
    expect(hours.val).toBeGreaterThan(weekend.val);
    expect(weekend.val).toBeGreaterThan(delivery.val);

    const around = neighbourhood(graph.adjacency, ["rec-weekend"]);
    expect([...around].sort()).toEqual(["hub:agent:ag-scribe-syn", "rec-hours", "rec-weekend"]);
    expect(neighbourhood(graph.adjacency, [null]).size).toBe(0);
  });
});

describe("memory influence and node size", () => {
  it("weighs stated links above suggested ones and adds a little for approval", () => {
    expect(memoryInfluence({ stated: 0, suggested: 0, approved: false })).toBe(0);
    expect(memoryInfluence({ stated: 1, suggested: 0, approved: false })).toBe(2);
    expect(memoryInfluence({ stated: 0, suggested: 1, approved: false })).toBe(0.5);
    expect(memoryInfluence({ stated: 0, suggested: 0, approved: true })).toBe(1.5);
    expect(memoryInfluence({ stated: 2, suggested: 4, approved: true })).toBe(7.5);
    expect(memoryInfluence({ stated: 1, suggested: 0, approved: false })).toBeGreaterThan(memoryInfluence({ stated: 0, suggested: 3, approved: false }));
  });

  it("ignores negative and fractional counts", () => {
    expect(memoryInfluence({ stated: -3, suggested: -1, approved: false })).toBe(0);
    expect(memoryInfluence({ stated: 1.9, suggested: 0, approved: false })).toBe(2);
  });

  it("starts small, grows with influence and is clamped", () => {
    expect(memoryNodeVal(0)).toBe(MEMORY_NODE_VAL.min);
    expect(memoryNodeVal(-5)).toBe(MEMORY_NODE_VAL.min);
    expect(memoryNodeVal(2)).toBeGreaterThan(memoryNodeVal(1));
    expect(memoryNodeVal(1000)).toBe(MEMORY_NODE_VAL.max);
  });

  it("keeps every entry below every hub, and the main agent above all", () => {
    expect(MEMORY_NODE_VAL.max).toBeLessThan(hubNodeVal(1));
    expect(hubNodeVal(4)).toBeGreaterThan(hubNodeVal(1));
    expect(hubNodeVal(100000)).toBe(HUB_NODE_VAL.max);
    expect(hubNodeVal(1, true)).toBe(HUB_NODE_VAL.ceo);
    expect(HUB_NODE_VAL.ceo).toBeGreaterThan(HUB_NODE_VAL.max);
  });
});

describe("main agent hub", () => {
  it("is found by role, pinned as the largest hub, with display only orbit links from the other hubs", () => {
    const graph = buildMemoryGraph3D(kestrelNodes, kestrelEdges, { agents: kestrelAgentList });

    expect(graph.ceoHubId).toBe("hub:agent:ag-everest-syn");
    const ceo = graph.nodes.find((node) => node.id === graph.ceoHubId)!;
    expect(ceo.ceo).toBe(true);
    expect(ceo.label).toBe("Everest");
    const others = graph.nodes.filter((node) => node.id !== ceo.id);
    expect(others.every((node) => node.val < ceo.val && !node.ceo)).toBe(true);

    const orbit = graph.links.filter((link) => link.style === "orbit");
    expect(orbit.map((link) => link.source).sort()).toEqual(["hub:agent:ag-mason-syn", "hub:agent:ag-scribe-syn"]);
    for (const link of orbit) {
      expect(link.target).toBe(ceo.id);
      expect(link.edgeId).toBeNull();
      expect(memoryIds.has(link.source) || memoryIds.has(link.target)).toBe(false);
    }
    // Orbit links are layout only; they do not make hubs neighbours.
    expect(graph.adjacency.get(ceo.id)?.has("hub:agent:ag-mason-syn") ?? false).toBe(false);
  });

  it("follows the role, not the name", () => {
    const agents = kestrelAgentList.map((agent) => ({ ...agent, role: agent.id === "ag-mason-syn" ? "ceo" : "general" }));
    const graph = buildMemoryGraph3D(kestrelNodes, kestrelEdges, { agents });
    expect(graph.ceoHubId).toBe("hub:agent:ag-mason-syn");
  });

  it("has none when roles are known and nobody is the CEO", () => {
    const agents = kestrelAgentList.map((agent) => ({ ...agent, role: "general" }));
    const graph = buildMemoryGraph3D(kestrelNodes, kestrelEdges, { agents });
    expect(graph.ceoHubId).toBeNull();
    expect(graph.links.some((link) => link.style === "orbit")).toBe(false);
  });
});

describe("focusNodeIds", () => {
  const extra: MemoryGraphEdge = { ...kestrelEdges[1], id: "rel:extra", from: "rec-delivery", to: "rec-weekend", type: "supports" };

  it("returns null when no contributor is focused", () => {
    const graph = buildMemoryGraph3D(kestrelNodes, kestrelEdges);
    expect(focusNodeIds(graph, [])).toBeNull();
  });

  it("keeps only that agent's entries, their direct neighbours and the hubs of those", () => {
    const graph = buildMemoryGraph3D(kestrelNodes, [...kestrelEdges, extra], { agents: kestrelAgentList });
    const ids = focusNodeIds(graph, ["ag-everest-syn"])!;

    // Everest wrote rec-site-launch, which depends on rec-hours (Scribe).
    expect([...ids].sort()).toEqual(["hub:agent:ag-everest-syn", "hub:agent:ag-scribe-syn", "rec-hours", "rec-site-launch"]);
    // Not two steps away: rec-hours links on to rec-weekend and rec-hours-old.
    expect(ids.has("rec-weekend")).toBe(false);
    expect(ids.has("rec-hours-old")).toBe(false);
  });

  it("follows suggested links only when they are shown", () => {
    const hidden = buildMemoryGraph3D(kestrelNodes, kestrelEdges);
    expect(focusNodeIds(hidden, ["ag-mason-syn"])!.has("rec-hours")).toBe(true); // through the stated supersedes link
    const masonOnlyByCheck = buildMemoryGraph3D(kestrelNodes, kestrelEdges.filter((edge) => edge.type !== "supersedes"));
    expect(focusNodeIds(masonOnlyByCheck, ["ag-mason-syn"])!.has("rec-hours")).toBe(false);
    const shown = buildMemoryGraph3D(kestrelNodes, kestrelEdges.filter((edge) => edge.type !== "supersedes"), { showSuggested: true });
    expect(focusNodeIds(shown, ["ag-mason-syn"])!.has("rec-hours")).toBe(true); // through the conflict check finding
  });

  it("joins several focused contributors", () => {
    const graph = buildMemoryGraph3D(kestrelNodes, kestrelEdges);
    const ids = focusNodeIds(graph, ["ag-everest-syn", "user:hu-john-syn"])!;
    expect(ids.has("rec-site-launch")).toBe(true);
    expect(ids.has("rec-delivery")).toBe(false);
  });
});
