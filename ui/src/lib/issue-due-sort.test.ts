import { describe, expect, it } from "vitest";
import { compareIssueDueDates } from "./issue-due-sort";

const tasks = [
  { id: "none", dueDate: null },
  { id: "late", dueDate: "2026-10-30" },
  { id: "soon", dueDate: "2026-10-17T00:00:00.000Z" },
  { id: "mid", dueDate: "2026-10-20" },
];

function order(dir: 1 | -1) {
  return [...tasks].sort((a, b) => compareIssueDueDates(a, b, dir)).map((task) => task.id);
}

describe("compareIssueDueDates", () => {
  it("puts the soonest first and undated tasks last", () => {
    expect(order(1)).toEqual(["soon", "mid", "late", "none"]);
  });

  it("keeps undated tasks last when reversed", () => {
    expect(order(-1)).toEqual(["late", "mid", "soon", "none"]);
  });
});
