import { describe, expect, it } from "vitest";
import type { MemoryGraphNode } from "@greatstone/shared";
import { kestrelAgents, kestrelEdges, kestrelNodes } from "../../fixtures/memoryKestrel";
import { buildMemoryGraph3D, HUB_PREFIX, neighbourhood } from "./memoryGraph3dData";

const memoryIds = new Set(kestrelNodes.map((node) => node.id));

function isMemoryToMemory(link: { source: string; target: string }) {
  return memoryIds.has(link.source) && memoryIds.has(link.target);
}

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

  it("creates memory to memory links only from stated or engine edges, keeping their direction and kind", () => {
    const graph = buildMemoryGraph3D(kestrelNodes, kestrelEdges);

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
    expect(graph.links).toHaveLength(170);
    expect(graph.links.every((link) => link.style === "provenance" && link.edgeId === null && link.source.startsWith("rec-") && link.target.startsWith(HUB_PREFIX))).toBe(true);
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

  it("groups by scope on request", () => {
    const graph = buildMemoryGraph3D(kestrelNodes, kestrelEdges, { groupBy: "scope" });

    const hubs = graph.nodes.filter((node) => node.kind === "hub");
    expect(hubs.map((hub) => hub.label).sort()).toEqual(["Alder Bakery", "Alder website rebuild"]);
    expect(graph.links.filter((link) => link.style === "provenance")).toHaveLength(kestrelNodes.length);
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
    const graph = buildMemoryGraph3D(kestrelNodes, kestrelEdges, { maxNodes: 2 });

    expect(graph.memoryCount).toBe(2);
    expect(graph.omittedCount).toBe(kestrelNodes.length - 2);
    const drawn = new Set(kestrelNodes.slice(0, 2).map((node) => node.id));
    for (const link of graph.links) {
      expect(drawn.has(link.source)).toBe(true);
      if (link.style !== "provenance") expect(drawn.has(link.target)).toBe(true);
    }
  });

  it("drops edges whose ends the server did not send", () => {
    const graph = buildMemoryGraph3D([kestrelNodes[0]], kestrelEdges);
    expect(graph.links.filter((link) => link.style !== "provenance")).toHaveLength(0);
  });

  it("sizes entries by their links and finds a node's neighbours", () => {
    const graph = buildMemoryGraph3D(kestrelNodes, kestrelEdges);

    const hours = graph.nodes.find((node) => node.id === "rec-hours")!;
    const weekend = graph.nodes.find((node) => node.id === "rec-weekend")!;
    expect(hours.degree).toBe(4);
    expect(weekend.degree).toBe(1);
    expect(hours.val).toBeGreaterThan(weekend.val);

    const around = neighbourhood(graph.adjacency, ["rec-weekend"]);
    expect([...around].sort()).toEqual(["hub:agent:ag-scribe-syn", "rec-hours", "rec-weekend"]);
    expect(neighbourhood(graph.adjacency, [null]).size).toBe(0);
  });
});
