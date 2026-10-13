import { describe, expect, it } from "vitest";
import { groupDeliverableDocuments, normaliseDeliverableTitle } from "./deliverable-versions.js";

describe("normaliseDeliverableTitle", () => {
  it.each([
    ["Ghana Airport Taxi discovery prep brief", "ghana airport taxi discovery prep brief"],
    ["Ghana Airport Taxi Discovery Prep Brief v2", "ghana airport taxi discovery prep brief"],
    ["Ghana airport taxi: discovery prep brief (draft)", "ghana airport taxi discovery prep brief"],
    ["The Greatstone Method Toolkit v5.3", "the greatstone method toolkit"],
    ["The Greatstone Method Toolkit, version 3", "the greatstone method toolkit"],
    ["The Greatstone Method Toolkit rev 2 (final)", "the greatstone method toolkit"],
    ["Indago North Star kick-off pack 13 Oct 2026", "indago north star kick off pack"],
    ["Indago North Star kick-off pack 2026-10-13", "indago north star kick off pack"],
    ["Indago North Star kick-off pack, October 13, 2026", "indago north star kick off pack"],
    ["Omni executive discovery meeting deck [v4] - updated", "omni executive discovery meeting deck"],
  ])("%s", (title, expected) => {
    expect(normaliseDeliverableTitle(title)).toBe(expected);
  });

  it("keeps words that only look like a suffix in the middle", () => {
    expect(normaliseDeliverableTitle("Final report on the v2 rollout plan")).toBe("final report on the v2 rollout plan");
    expect(normaliseDeliverableTitle("Strategy 2026")).toBe("strategy 2026");
  });

  it("returns nothing for a title that is only a suffix", () => {
    expect(normaliseDeliverableTitle("v2 (draft)")).toBe("");
  });
});

function item(id: string, title: string, createdAt: string, projectId: string | null = "indago", version = 1) {
  return { id, title, createdAt, version, project: projectId ? { id: projectId } : null };
}

describe("groupDeliverableDocuments", () => {
  it("folds versions of one document in one project, newest leading, in list order", () => {
    const groups = groupDeliverableDocuments([
      item("c", "Kick-off pack v3", "2026-10-13T10:00:00Z"),
      item("x", "Discovery deck", "2026-10-12T10:00:00Z"),
      item("a", "Kick-off pack", "2026-10-01T10:00:00Z"),
      item("b", "kick-off pack (draft)", "2026-10-05T10:00:00Z"),
    ]);
    expect(groups.map((group) => group.latest.id)).toEqual(["c", "x"]);
    expect(groups[0]!.older.map((entry) => entry.id)).toEqual(["b", "a"]);
    expect(groups[1]!.older).toEqual([]);
  });

  it("picks the newest entry even when the list is sorted another way", () => {
    const [group] = groupDeliverableDocuments([
      item("old", "Toolkit v1", "2026-09-01T00:00:00Z"),
      item("new", "Toolkit v2", "2026-10-01T00:00:00Z"),
    ]);
    expect(group!.latest.id).toBe("new");
    expect(group!.older.map((entry) => entry.id)).toEqual(["old"]);
  });

  it("never merges across projects, and no-project entries only with each other", () => {
    const groups = groupDeliverableDocuments([
      item("a", "Brief", "2026-10-01T00:00:00Z", "indago"),
      item("b", "Brief", "2026-10-02T00:00:00Z", "omni"),
      item("c", "Brief", "2026-10-03T00:00:00Z", null),
      item("d", "Brief v2", "2026-10-04T00:00:00Z", null),
    ]);
    expect(groups.map((group) => [group.latest.id, group.older.map((entry) => entry.id)])).toEqual([
      ["a", []],
      ["b", []],
      ["d", ["c"]],
    ]);
  });

  it("is deterministic on ties and never merges suffix-only titles", () => {
    const tie = groupDeliverableDocuments([
      item("b", "Plan", "2026-10-01T00:00:00Z", "p", 1),
      item("a", "Plan", "2026-10-01T00:00:00Z", "p", 1),
    ]);
    expect(tie[0]!.latest.id).toBe("a");
    expect(groupDeliverableDocuments([
      item("a", "v2", "2026-10-01T00:00:00Z"),
      item("b", "v3", "2026-10-02T00:00:00Z"),
    ])).toHaveLength(2);
  });
});
