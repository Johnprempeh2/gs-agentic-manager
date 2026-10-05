import { describe, expect, it } from "vitest";
import { layoutMemoryGraph } from "./memory-graph-layout";

describe("layoutMemoryGraph", () => {
  const ids = ["c", "a", "b", "d"];
  const links = [
    { fromId: "a", toId: "b" },
    { fromId: "b", toId: "c" },
  ];

  it("gives the same picture for the same input, whatever the order", () => {
    const first = layoutMemoryGraph(ids, links);
    const second = layoutMemoryGraph([...ids].reverse(), links);
    for (const id of ids) {
      expect(second.positions.get(id)).toEqual(first.positions.get(id));
    }
  });

  it("keeps every node inside the returned bounds and apart from the others", () => {
    const { positions, width, height } = layoutMemoryGraph(ids, links);
    const points = [...positions.values()];
    for (const point of points) {
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(width);
      expect(point.y).toBeLessThanOrEqual(height);
    }
    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        expect(Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y)).toBeGreaterThan(30);
      }
    }
  });

  it("ignores links to nodes that are not in the graph", () => {
    const { positions } = layoutMemoryGraph(["a"], [{ fromId: "a", toId: "hidden" }]);
    expect([...positions.keys()]).toEqual(["a"]);
  });

  it("handles an empty graph", () => {
    expect(layoutMemoryGraph([], []).positions.size).toBe(0);
  });
});
