// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { isSaved, loadSavedSearches, removeSavedSearch, saveSearchItem, viewLabel } from "./saved-searches";

describe("saved searches", () => {
  beforeEach(() => window.localStorage.clear());

  it("saves searches and pinned pages per company and person, newest first, without duplicates", () => {
    saveSearchItem("c1", "u1", { kind: "search", label: "indago", query: "indago" });
    saveSearchItem("c1", "u1", { kind: "view", label: "Tasks", path: "/issues?status=blocked" });
    saveSearchItem("c1", "u1", { kind: "search", label: "Indago", query: "Indago " });
    const items = loadSavedSearches("c1", "u1");
    expect(items.map((item) => item.label)).toEqual(["Indago", "Tasks"]);
    expect(loadSavedSearches("c1", "u2")).toEqual([]);
    expect(isSaved(items, { kind: "view", label: "x", path: "/issues?status=blocked" })).toBe(true);
    expect(removeSavedSearch("c1", "u1", items[0]!.id).map((item) => item.label)).toEqual(["Tasks"]);
  });

  it("ignores broken storage", () => {
    window.localStorage.setItem("gsam:saved-searches:c1:u1", "{not json");
    expect(loadSavedSearches("c1", "u1")).toEqual([]);
  });

  it("names a pinned page from its breadcrumbs", () => {
    expect(viewLabel([{ label: "Tasks" }, { label: "Stuck" }], "/issues")).toBe("Tasks / Stuck");
    expect(viewLabel([], "/since-last-visit?x=1")).toBe("Since last visit");
  });
});
